import { z } from 'zod';
import { idSchema } from './config.js';
import { HubRuntime } from './runtime.js';
import { LocalStore } from './storage.js';
import { editSettings } from './settings.js';
import { HubError } from './errors.js';
import { LanPeer, type PeerOptions } from './lan-peer.js';
import { fingerprintSchema } from './lan-network.js';
import { sha256 } from './lan-wire.js';
import { DeviceState } from './device.js';

const sourcesSchema = z.object({ sources: z.record(idSchema, z.string().regex(/^[a-f0-9]{64}$/)) }).strict();
export const lanActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), enabled: z.boolean(), revision: fingerprintSchema }).strict(),
  z.object({ action: z.literal('autoPublish'), enabled: z.boolean(), revision: fingerprintSchema }).strict(),
  z.object({ action: z.literal('invite') }).strict(),
  z.object({ action: z.literal('join'), url: z.string().max(1900) }).strict(),
  z.object({ action: z.literal('confirm'), session: z.string().regex(/^[a-f0-9]{32}$/) }).strict(),
  z.object({ action: z.literal('cancel') }).strict(),
  z.object({ action: z.literal('unpair'), peer: fingerprintSchema }).strict(),
]);

export class LanController {
  private runtime: HubRuntime;
  private peer?: LanPeer;
  private sources: LocalStore<z.infer<typeof sourcesSchema>>;
  private timer?: NodeJS.Timeout;
  private updating?: Promise<void>;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  private enabled = false;
  private globalEnabled = false;
  private error?: string;
  private publishErrors: string[] = [];
  constructor(readonly path: string, private readonly options: PeerOptions = {}) {
    this.runtime = new HubRuntime(path);
    this.sources = new LocalStore(path + '.lan-sources.json', value => sourcesSchema.parse(value), () => ({ sources: {} }));
  }
  get active() { return this.enabled || this.globalEnabled; }
  async start() {
    await this.ensure();
    this.timer = setInterval(() => { void this.tick(); }, 5000); this.timer.unref();
    void this.tick();
  }
  private ensure(): Promise<void> {
    const next = this.tail.then(async () => {
      if (this.closed) return;
      try {
        const { config } = await this.runtime.get(); this.enabled = config.sync.mode === 'lan'; this.globalEnabled = config.globalAgents.enabled && (!!config.sync.folder || this.enabled);
        if (!this.enabled) { await this.peer?.close(); this.peer = undefined; return; }
        if (!this.peer) {
          const peer = new LanPeer(this.path, async () => {
            const { sync, config } = await this.runtime.get();
            if (this.closed || config.sync.mode !== 'lan') throw new HubError('LAN同期は停止しています。');
            return sync;
          }, this.options);
          try { await peer.start(); this.peer = peer; } catch (error) { await peer.close(); throw error; }
        }
        this.error = undefined;
      } catch {
        await this.peer?.close(); this.peer = undefined;
        this.error = 'LAN同期を開始できません。設定、端末証明書、ネットワーク権限を確認してください。';
      }
    });
    this.tail = next.catch(() => {}); return next;
  }

  tick(): Promise<void> {
    return this.updating ??= this.cycle().catch(() => { this.error = '同期データを処理できません。設定と共有内容を確認してください。'; }).finally(() => { this.updating = undefined; });
  }
  private async cycle() {
    await this.ensure(); if (this.closed) return;
    const { globals } = await this.runtime.get();
    if (this.globalEnabled) await globals.cycle();
    if (!this.peer) return;
    const { config, sync, revision: sourceRevision } = await this.runtime.get();
    this.publishErrors = [];
    if (config.sync.autoPublish) {
      const tracking = await this.sources.read(); await sync.pull(true);
      const statuses = new Map((await sync.status(0, 2000)).servers.map(item => [item.server, item]));
      // Only owner-defined originals are automatic. Agent-origin publishing remains controlled by allowAgentPublish.
      for (const [id, server] of Object.entries(config.servers).slice(0, 2000)) {
        if (this.closed || !this.peer) return;
        try {
          const signature = sha256(JSON.stringify(await sync.bundle(id, server, config.skills)));
          const previous = tracking.sources[id]; const current = statuses.get(id);
          if (signature === previous) continue;
          // A fresh device cannot overwrite an existing shared definition just by joining.
          if (!previous && current) {
            await this.sources.mutate(state => { state.sources[id] = signature; }); continue;
          }
          if (current && !['ready', 'needs-local-setup', 'deleted'].includes(current.status)) throw new Error('review first');
          if ((await this.runtime.get()).revision !== sourceRevision || this.closed || !this.peer) return;
          await new DeviceState(this.path + '.device.json').mutate(state => { state.enabled[id] ??= server.enabled; });
          await sync.publish(id, server, config.skills);
          await this.sources.mutate(state => { state.sources[id] = signature; });
        } catch { this.publishErrors.push(id); }
      }
      for (const id of Object.keys(tracking.sources)) {
        if (Object.hasOwn(config.servers, id)) continue;
        try {
          const current = statuses.get(id);
          if (current && current.status !== 'deleted') {
            if (!['ready', 'needs-local-setup'].includes(current.status)) throw new Error('review first');
            if ((await this.runtime.get()).revision !== sourceRevision || this.closed || !this.peer) return;
            await sync.remove(id);
          }
          await this.sources.mutate(state => { delete state.sources[id]; });
        } catch { this.publishErrors.push(id); }
      }
    }
    await this.peer?.tick();
  }
  async status() {
    await this.ensure();
    const current = await this.runtime.get();
    return { enabled: this.enabled, autoPublish: current.config.sync.autoPublish, error: this.error,
      publishErrors: this.publishErrors.slice(0, 10), ...(this.peer ? this.peer.status() : { peers: [], pending: [], addresses: [], discoveryError: false }) };
  }
  async action(raw: unknown): Promise<unknown> {
    const parsed = lanActionSchema.safeParse(raw);
    if (!parsed.success) throw new HubError('LAN同期の入力を確認してください。');
    const input = parsed.data;
    if (input.action === 'enable' || input.action === 'autoPublish') {
      await editSettings(this.path, data => {
        const sync = { ...(data.sync as Record<string, unknown> ?? {}) };
        if (input.action === 'enable') sync.mode = input.enabled ? 'lan' : 'folder'; else sync.autoPublish = input.enabled;
        data.sync = sync;
      }, input.revision);
      await this.ensure(); return { ok: true };
    }
    await this.ensure();
    if (!this.peer) throw new HubError('先にLAN同期をONにしてください。');
    if (input.action === 'invite') return this.peer.invite();
    if (input.action === 'join') return this.peer.join(input.url);
    if (input.action === 'confirm') { await this.peer.confirm(input.session); void this.tick(); }
    if (input.action === 'cancel') await this.peer.cancel();
    if (input.action === 'unpair') await this.peer.unpair(input.peer);
    return { ok: true };
  }
  async close() {
    this.closed = true; clearInterval(this.timer);
    await this.tail; await this.peer?.close(); this.peer = undefined;
    await this.updating; await this.runtime.close();
  }
}
export type LanStatus = Awaited<ReturnType<LanController['status']>>;
