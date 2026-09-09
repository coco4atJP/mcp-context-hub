import { z } from 'zod';
import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { configSchema, idSchema, securityDefaults } from './config.js';
import { HubRuntime } from './runtime.js';
import { HubError } from './errors.js';
import { DeviceState } from './device.js';
import { SkillStore } from './skills.js';
import { SyncManager } from './sync.js';
import { assertLocalConfig, editSettings, setSecurity } from './settings.js';
import type { GuiServer, GuiState } from './gui-types.js';

const id = idSchema;
const revision = z.string().regex(/^[a-f0-9]{64}$/);
const simple = { id, description: z.string().max(500).default(''), skills: z.array(id).max(30).default([]) };
const newServer = z.discriminatedUnion('kind', [
  z.object({ ...simple, kind: z.literal('http'), url: z.url() }).strict(),
  z.object({ ...simple, kind: z.literal('stdio'), command: z.string().min(1).max(2000), args: z.array(z.string().max(8000)).max(100).default([]), cwd: z.string().refine(isAbsolute).optional() }).strict(),
  z.object({ ...simple, kind: z.literal('template'), template: id }).strict(),
]);
export const guiActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('toggle'), server: id, enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('allOff') }).strict(),
  z.object({ action: z.literal('add'), revision, value: newServer }).strict(),
  z.object({ action: z.literal('remove'), revision, server: id }).strict(),
  z.object({ action: z.literal('attachSkill'), revision, server: id, skill: id, path: z.string().max(4000).refine(isAbsolute) }).strict(),
  z.object({ action: z.literal('security'), revision, key: z.enum(Object.keys(securityDefaults) as [keyof typeof securityDefaults, ...Array<keyof typeof securityDefaults>]), enabled: z.boolean() }).strict(),
  z.object({ action: z.literal('resetSecurity'), revision }).strict(),
  z.object({ action: z.literal('connect'), revision, folder: z.string().max(4000).refine(isAbsolute) }).strict(),
  z.object({ action: z.literal('disconnect'), revision }).strict(),
  z.object({ action: z.literal('pull') }).strict(),
  z.object({ action: z.literal('approve'), server: id, revision }).strict(),
  z.object({ action: z.literal('resolve'), server: id, revision }).strict(),
  z.object({ action: z.literal('publish'), server: id }).strict(),
  z.object({ action: z.literal('removeShared'), server: id }).strict(),
  z.object({ action: z.literal('config'), revision, value: configSchema }).strict(),
]);

/** Owner interface. These operations are deliberately not registered as MCP tools. */
export class GuiAdmin {
  readonly runtime: HubRuntime;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) { this.runtime = new HubRuntime(path); }

  async state(): Promise<GuiState> {
    const current = await this.runtime.get();
    await current.hub.refresh();
    const servers: GuiServer[] = [];
    let offset = 0;
    do {
      const page = await current.hub.catalog('', offset, 20);
      if (!page.servers) throw new HubError('Cannot list servers.');
      servers.push(...page.servers);
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
      if (offset >= 2000) throw new HubError('GUIの一覧上限は2,000件です。');
    } while (true);
    const order = new Map(Object.keys(current.config.servers).map((id, index) => [id, index]));
    servers.sort((a, b) => (order.get(a.server) ?? Infinity) - (order.get(b.server) ?? Infinity) || a.server.localeCompare(b.server));
    for (const server of servers) server.locallyDefined = order.has(server.server);
    const sync = await current.sync.status(0, 20);
    let next = sync.nextOffset;
    while (next !== undefined && next < 2000) {
      const page = await current.sync.status(next, 20); sync.servers.push(...page.servers); next = page.nextOffset;
    }
    delete sync.nextOffset;
    const store = new SkillStore(current.config.skills);
    return {
      revision: current.revision, configPath: this.path, platform: process.platform, servers,
      templates: Object.entries(current.config.templates).map(([id, item]) => ({ id, description: item.description, transport: item.transport })),
      skills: await Promise.all(Object.keys(current.config.skills).map(async id => ({ id, description: (await store.summary(id)).description }))),
      security: current.config.security, sync: { ...sync, folder: current.config.sync.folder },
    };
  }

  async readConfig() { const value = await this.runtime.get(); return { revision: value.revision, value: value.raw }; }

  async inspect(server: string, requestedRevision?: string) {
    id.parse(server); if (requestedRevision) revision.parse(requestedRevision);
    return (await this.runtime.get()).sync.inspect(server, requestedRevision);
  }

  async skills(server: string) {
    id.parse(server); const { hub } = await this.runtime.get(); await hub.refresh();
    const summaries = [];
    let offset = 0;
    do {
      const page = await hub.catalog('', offset, 20, server);
      if (!('skills' in page)) throw new HubError('Cannot list skills.');
      summaries.push(...page.skills);
      if (page.nextOffset === undefined) break;
      offset = page.nextOffset;
    } while (offset < 2000);
    return summaries;
  }

  action(input: unknown): Promise<{ ok: true }> {
    const parsed = guiActionSchema.safeParse(input);
    if (!parsed.success) throw new HubError('入力を確認してください。必須項目やパス、設定形式が正しくありません。');
    const operation = parsed.data;
    const next = this.tail.then(async () => {
      const current = await this.runtime.get(); await current.hub.refresh();
      const { config, hub, sync } = current;
      if (operation.action === 'toggle') await hub.control(operation.server, operation.enabled ? 'enable' : 'disable');
      else if (operation.action === 'allOff') await hub.focus([]);
      else if (operation.action === 'add') {
        const { id: server, kind, skills, description } = operation.value;
        const existing = (await this.state()).servers.some(item => item.server === server);
        if (existing || sync.managedIds().includes(server)) throw new HubError('そのサーバーIDは既に登録されています。');
        let definition: Record<string, unknown>;
        if (kind === 'template') {
          const template = config.templates[operation.value.template];
          if (!template) throw new HubError('起動テンプレートが見つかりません。');
          definition = { ...template, description: description || template.description, skills: [...new Set([...template.skills, ...skills])], enabled: false };
        } else {
          const { kind, id: _id, ...fields } = operation.value;
          definition = { ...fields, transport: kind, enabled: false };
        }
        await editSettings(this.path, data => {
          const servers = data.servers as Record<string, unknown>;
          if (Object.hasOwn(servers, server)) throw new HubError('そのサーバーIDは既に登録されています。');
          servers[server] = definition;
        }, operation.revision);
        await new DeviceState(this.path + '.device.json').set(server, false);
      } else if (operation.action === 'remove') {
        const item = (await this.state()).servers.find(item => item.server === operation.server);
        if (!item) throw new HubError('サーバーが見つかりません。');
        if (item.source === 'sync') throw new HubError('共有サーバーは「共有から削除」を使ってください。');
        if (item.source === 'agent') await hub.remove(operation.server);
        else await editSettings(this.path, data => { delete (data.servers as Record<string, unknown>)[operation.server]; }, operation.revision);
        await new DeviceState(this.path + '.device.json').set(operation.server, false);
      } else if (operation.action === 'attachSkill') {
        if (!Object.hasOwn(config.servers, operation.server)) throw new HubError('Skill原本の添付は、この端末で定義したサーバーに行います。詳細設定でも編集できます。');
        const path = await realpath(operation.path);
        await new SkillStore({ [operation.skill]: path }).validate();
        await editSettings(this.path, data => {
          const skills = { ...(data.skills as Record<string, string> ?? {}) };
          if (skills[operation.skill] && skills[operation.skill] !== path) throw new HubError('そのSkill IDは別のパスで使用されています。');
          skills[operation.skill] = path; data.skills = skills;
          const target = (data.servers as Record<string, { skills?: string[] }>)[operation.server]!;
          target.skills = [...new Set([...(target.skills ?? []), operation.skill])];
        }, operation.revision);
      } else if (operation.action === 'security') await setSecurity(this.path, operation.key, operation.enabled, operation.revision);
      else if (operation.action === 'resetSecurity') await editSettings(this.path, data => { data.security = { ...securityDefaults }; }, operation.revision);
      else if (operation.action === 'connect') {
        const folder = await realpath(operation.folder);
        assertLocalConfig(await realpath(this.path), folder);
        await SyncManager.initialize(folder);
        await editSettings(this.path, data => { data.sync = { ...(data.sync as object ?? {}), folder }; }, operation.revision);
      } else if (operation.action === 'disconnect') {
        await editSettings(this.path, data => { const value = { ...(data.sync as Record<string, unknown> ?? {}) }; delete value.folder; data.sync = value; }, operation.revision);
      } else if (operation.action === 'pull') await sync.pull(true);
      else if (operation.action === 'approve') await sync.approve(operation.server, operation.revision);
      else if (operation.action === 'resolve') await sync.resolve(operation.server, operation.revision);
      else if (operation.action === 'publish') await hub.syncControl('publish', operation.server, 0, 5, true);
      else if (operation.action === 'removeShared') await hub.syncControl('remove', operation.server, 0, 5, true);
      else if (operation.action === 'config') {
        if (operation.value.sync.folder) assertLocalConfig(this.path, operation.value.sync.folder);
        await editSettings(this.path, data => { for (const key of Object.keys(data)) delete data[key]; Object.assign(data, operation.value); }, operation.revision);
      }
      return { ok: true as const };
    });
    this.tail = next.catch(() => {});
    return next;
  }

  async close() { await this.tail; await this.runtime.close(); }
}
