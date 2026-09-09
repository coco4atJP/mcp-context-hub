import { createHash, randomUUID } from 'node:crypto';
import { mkdir, opendir, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { idSchema, serverSchema, type Config, type ServerConfig } from './config.js';
import { HubError } from './errors.js';
import { SkillStore } from './skills.js';
import { atomicWrite, directory, LocalStore, readText } from './storage.js';
import { validateAgentUrl } from './network.js';
import { assertLocalConfig } from './settings.js';

const MAX_CHANGE = 2 * 1024 * 1024;
const MAX_HISTORY = 2000;
const MAX_HISTORY_BYTES = 64 * 1024 * 1024;
const revisionSchema = z.string().regex(/^[a-f0-9]{64}$/);
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const limitedRecord = <T extends z.ZodType>(schema: T, max: number) => z.record(z.string(), schema).refine(value => Object.keys(value).length <= max);

/** A shared record has no command, environment, headers, policy or enabled field. */
const bundleSchema = z.object({
  connection: z.union([
    z.object({ template: idSchema }).strict(),
    z.object({ url: z.url().max(2000).refine(value => {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
    }) }).strict(),
  ]),
  description: z.string().max(500),
  tags: z.array(z.string().max(80)).max(30),
  allowedTools: z.array(z.string().max(200)).max(200).optional(),
  skills: z.array(idSchema).max(30),
  toolSkills: limitedRecord(z.array(idSchema).max(30), 200),
  packages: z.record(idSchema, limitedRecord(z.string().max(256 * 1024), 128)).refine(value => Object.keys(value).length <= 30),
}).strict();
export const changeSchema = z.object({
  version: z.literal(1), server: idSchema, device: z.uuid(),
  parents: z.array(revisionSchema).max(128), bundle: bundleSchema.nullable(),
}).strict();
type Bundle = z.infer<typeof bundleSchema>;
type Change = z.infer<typeof changeSchema>;
type Snapshot = { changes: Map<string, Change>; observed: Record<string, Observation> };
const observationSchema = z.object({ heads: z.array(revisionSchema).max(128), incomplete: z.boolean() }).strict();
type Observation = z.infer<typeof observationSchema>;
const stateSchema = z.object({
  version: z.literal(1), device: z.uuid(),
  accepted: z.record(idSchema, revisionSchema), observed: z.record(idSchema, observationSchema),
  blocked: z.boolean().default(false),
}).strict();
type State = z.infer<typeof stateSchema>;
export type SyncedServer = { id: string; revision: string; config: ServerConfig; paths: Record<string, string>; privateHttp: boolean; template?: string };

/** Reject traversal, Windows device names/ADS, case collisions and unexpected secret-bearing file types. */
export function portableFile(file: string): boolean {
  const parts = file.split('/');
  if (parts.length > 10 || file.length > 240 || parts.some(part => !/^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(part) ||
    /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
    /(?:^|[_. -])(credentials?|secrets?|tokens?|passwords?|id_rsa|id_ed25519)(?:[_. -]|$)/i.test(part))) return false;
  return file === 'SKILL.md' || (['references', 'scripts', 'assets'].includes(parts[0]!) && parts.length > 1 &&
    /\.(md|txt|json|yaml|yml|js|mjs|cjs|ts|py|sh|ps1|csv)$/i.test(file));
}

function validateChange(raw: unknown): Change {
  const change = changeSchema.parse(raw);
  if (new Set(change.parents).size !== change.parents.length) throw new HubError('Duplicate sync parents.');
  if (change.bundle) {
    const bundle = change.bundle;
    const attached = new Set([...bundle.skills, ...Object.values(bundle.toolSkills).flat()]);
    if (attached.size !== Object.keys(bundle.packages).length || [...attached].some(id => !Object.hasOwn(bundle.packages, id))) {
      throw new HubError('Synced skill bindings must match bundled packages.');
    }
    for (const [id, files] of Object.entries(bundle.packages)) {
      const names = new Set<string>();
      let bytes = 0;
      for (const [name, content] of Object.entries(files)) {
        const lower = name.toLowerCase();
        if (!portableFile(name) || names.has(lower) || content.includes('\0') || Buffer.byteLength(content) > 256 * 1024) throw new HubError('Invalid portable skill file.');
        names.add(lower);
        bytes += Buffer.byteLength(content);
      }
      for (const name of names) {
        const parts = name.split('/');
        while (parts.length > 1) { parts.pop(); if (names.has(parts.join('/'))) throw new HubError('Skill file/directory conflict.'); }
      }
      if (bytes > 1024 * 1024 || !Object.hasOwn(files, 'SKILL.md')) throw new HubError('Skill package must include SKILL.md and fit in 1 MiB.');
      SkillStore.parse(id, files['SKILL.md']!);
    }
  }
  return change;
}

async function packageSkill(path: string): Promise<Record<string, string>> {
  const root = await realpath(path);
  const files: Record<string, string> = {};
  let seen = 0;
  const walk = async (dir: string, prefix: string) => {
    await directory(dir);
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (++seen > 512) throw new HubError('Skill package has too many filesystem entries.');
      const name = prefix + item.name;
      if (!prefix && item.name !== 'SKILL.md' && !['references', 'scripts', 'assets'].includes(item.name)) continue;
      if (item.isSymbolicLink()) throw new HubError('Symlinks cannot be published as skill files.');
      if (item.isDirectory()) {
        if (name.split('/').length >= 9 || item.name.startsWith('.')) continue;
        await walk(join(dir, item.name), name + '/');
      } else if (portableFile(name)) {
        files[name] = await readText(join(dir, item.name), 256 * 1024);
      }
    }
  };
  await walk(root, '');
  return files;
}

/** Immutable causal revisions avoid clock ordering and cross-device file locks. */
export class SyncManager {
  private readonly store: LocalStore<State>;
  private readonly cache: string;
  private state?: State;
  private lastPoll = 0;
  private error?: 'offline' | 'invalid';
  private snapshot?: Snapshot;
  private readyCache = new Map<string, SyncedServer>();
  private readonly storageFolder?: string;

  constructor(private readonly config: Config, configPath: string) {
    if (config.sync.folder) assertLocalConfig(configPath, config.sync.folder);
    this.storageFolder = config.sync.mode === 'lan' ? configPath + '.lan-data' : config.sync.folder;
    const scope = digest(this.storageFolder ?? 'disconnected').slice(0, 16);
    this.store = new LocalStore(configPath + `.sync-${scope}.json`, input => stateSchema.parse(input),
      () => ({ version: 1, device: randomUUID(), accepted: {}, observed: {}, blocked: false }));
    this.cache = configPath + '.sync-cache';
  }

  private folder(): string {
    if (!this.storageFolder) throw new HubError('Sync is not configured. Open the GUI Sync tab or use mcp-context-hub lan start.');
    return join(this.storageFolder, 'mcp-context-hub-v1');
  }

  static async initialize(folder: string): Promise<void> {
    // Require an existing, mounted folder. Never create a missing mount point by accident.
    await directory(folder);
    await mkdir(join(folder, 'mcp-context-hub-v1'), { recursive: true, mode: 0o700 });
    await directory(join(folder, 'mcp-context-hub-v1'));
    await mkdir(join(folder, 'mcp-context-hub-v1', 'changes'), { recursive: true, mode: 0o700 });
    await directory(join(folder, 'mcp-context-hub-v1', 'changes'));
  }

  private async putCache(revision: string, text: string): Promise<void> {
    await mkdir(this.cache, { recursive: true, mode: 0o700 });
    await directory(this.cache);
    try { if (await readText(join(this.cache, revision + '.json'), MAX_CHANGE) === text) return; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await atomicWrite(join(this.cache, revision + '.json'), text);
  }

  private async cached(revision: string): Promise<Change> {
    const text = await readText(join(this.cache, revision + '.json'), MAX_CHANGE);
    if (digest(text) !== revision) throw new HubError('Local sync cache integrity check failed.');
    return validateChange(JSON.parse(text));
  }

  private async scan(): Promise<Snapshot> {
    const root = this.folder();
    await directory(this.storageFolder!);
    await directory(root);
    await directory(join(root, 'changes'));
    const names: string[] = [];
    for await (const entry of await opendir(join(root, 'changes'))) {
      names.push(entry.name);
      if (names.length > MAX_HISTORY + 100) throw new HubError('Sync history limit reached (2000 revisions).');
    }
    const changes = new Map<string, Change>();
    let bytes = 0;
    for (const name of names.sort()) {
      // Temporary and provider conflict copies are not protocol records. Original hashes remain authoritative.
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const text = await readText(join(root, 'changes', name), MAX_CHANGE);
      bytes += Buffer.byteLength(text);
      if (bytes > MAX_HISTORY_BYTES || changes.size >= MAX_HISTORY) throw new HubError('Sync history size limit reached.');
      const revision = name.slice(0, -5);
      if (digest(text) !== revision) throw new HubError('Shared revision integrity check failed.');
      const change = validateChange(JSON.parse(text));
      changes.set(revision, change);
      // Cache untrusted JSON only; executable-looking files are materialized only after local acceptance.
      await this.putCache(revision, text);
    }
    const observed: Record<string, Observation> = {};
    for (const [revision, change] of changes) {
      observed[change.server] ??= { heads: [], incomplete: false };
      observed[change.server]!.heads.push(revision);
    }
    for (const change of changes.values()) {
      const observation = observed[change.server]!;
      for (const parent of change.parents) {
        const ancestor = changes.get(parent);
        if (!ancestor) observation.incomplete = true;
        else if (ancestor.server !== change.server) throw new HubError('Sync parent belongs to a different server.');
        observation.heads = observation.heads.filter(revision => revision !== parent);
      }
    }
    for (const [id, previous] of Object.entries(this.state?.observed ?? {})) {
      // A deleted file or partially downloaded folder is not a tombstone or a rollback.
      if (previous.heads.some(revision => !changes.has(revision))) {
        observed[id] = { heads: [...new Set([...(observed[id]?.heads ?? []), ...previous.heads])], incomplete: true };
      }
    }
    return { changes, observed };
  }

  async pull(force = false): Promise<void> {
    this.state = await this.store.read();
    if (this.state.blocked) this.error = 'invalid';
    if (!this.storageFolder || (!force && Date.now() - this.lastPoll < this.config.sync.pollIntervalMs)) return;
    this.lastPoll = Date.now();
    try {
      if (this.config.sync.mode === 'lan') {
        await mkdir(this.storageFolder, { recursive: true, mode: 0o700 });
        await SyncManager.initialize(this.storageFolder);
      }
      const snapshot = await this.scan();
      this.snapshot = snapshot;
      this.state = await this.store.mutate(state => {
        // Another Hub on this device may have committed while the shared directory was being scanned.
        for (const [id, previous] of Object.entries(state.observed)) {
          if (previous.heads.some(revision => !snapshot.changes.has(revision))) {
            snapshot.observed[id] = { heads: [...new Set([...(snapshot.observed[id]?.heads ?? []), ...previous.heads])], incomplete: true };
          }
        }
        state.observed = snapshot.observed;
        state.blocked = false;
        if (!this.config.security.requireSyncApproval) {
          for (const [id, observation] of Object.entries(snapshot.observed)) {
            if (!observation.incomplete && observation.heads.length === 1) state.accepted[id] = observation.heads[0]!;
          }
        }
      });
      this.error = undefined;
    } catch (error) {
      // An offline folder retains the last accepted local state; malformed input blocks all synced services.
      this.error = !this.state.blocked && ['ENOENT', 'ENOTCONN', 'ETIMEDOUT', 'EHOSTUNREACH', 'EIO', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '') ? 'offline' : 'invalid';
      if (this.error === 'invalid') this.state = await this.store.mutate(state => { state.blocked = true; });
      this.snapshot = undefined;
    }
  }

  managedIds(): string[] { return Object.keys(this.state?.accepted ?? {}); }

  private async materialize(server: string, revision: string, bundle: Bundle): Promise<{ paths: Record<string, string>; ids: Record<string, string> }> {
    const paths: Record<string, string> = {};
    const ids: Record<string, string> = {};
    const base = join(this.cache, revision);
    await mkdir(base, { recursive: true, mode: 0o700 });
    await directory(this.cache);
    await directory(base);
    for (const [id, files] of Object.entries(bundle.packages)) {
      const local = 'sync_' + digest(server + ':' + id).slice(0, 24);
      ids[id] = local;
      const name = SkillStore.parse(id, files['SKILL.md']!).name;
      const root = join(base, digest(id).slice(0, 16), name);
      let dir = base;
      for (const segment of [digest(id).slice(0, 16), name]) {
        dir = join(dir, segment); await mkdir(dir, { recursive: true, mode: 0o700 }); await directory(dir);
      }
      for (const [file, text] of Object.entries(files)) {
        dir = root;
        for (const part of file.split('/').slice(0, -1)) {
          dir = join(dir, part); await mkdir(dir, { recursive: true, mode: 0o700 }); await directory(dir);
        }
        const target = join(root, ...file.split('/'));
        try {
          if (await readText(target, 256 * 1024) !== text) throw new HubError('Local skill cache was modified.');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          await atomicWrite(target, text);
        }
      }
      paths[local] = root;
    }
    return { paths, ids };
  }

  private async resolveServer(id: string, revision: string, bundle: Bundle): Promise<SyncedServer> {
    const binding = this.config.sync.bindings[id];
    const template = binding ?? ('template' in bundle.connection ? bundle.connection.template : undefined);
    let base: ServerConfig;
    let privateHttp = true;
    if (binding || (!Object.hasOwn(this.config.servers, id) && template)) {
      if (!template || !Object.hasOwn(this.config.templates, template)) throw new HubError('needs-local-template');
      base = this.config.templates[template]!;
    } else if (Object.hasOwn(this.config.servers, id)) {
      // A local connection binding keeps device paths and credentials, while shared metadata can change.
      base = this.config.servers[id]!;
    } else if ('url' in bundle.connection) {
      const url = validateAgentUrl(bundle.connection.url, this.config.agent, this.config.security);
      privateHttp = !this.config.security.blockPrivateHttp || this.config.agent.allowedHttpOrigins.some(origin => new URL(origin).origin === url.origin);
      base = serverSchema.parse({ transport: 'http', url: url.href });
    } else throw new HubError('needs-local-template');
    const { paths, ids } = await this.materialize(id, revision, bundle);
    const allowedTools = this.config.security.enforceToolAllowlist && base.allowedTools
      ? base.allowedTools.filter(tool => !bundle.allowedTools || bundle.allowedTools.includes(tool)) : bundle.allowedTools ?? base.allowedTools;
    const config = serverSchema.parse({ ...base, enabled: false, description: bundle.description, tags: bundle.tags, allowedTools,
      skills: bundle.skills.map(id => ids[id]!), toolSkills: Object.fromEntries(Object.entries(bundle.toolSkills).map(([tool, skills]) => [tool, skills.map(id => ids[id]!)])) });
    return { id, revision, config, paths, privateHttp, template };
  }

  async available(): Promise<SyncedServer[]> {
    if (this.error === 'invalid') return [];
    const servers: SyncedServer[] = [];
    for (const [id, revision] of Object.entries(this.state?.accepted ?? {})) {
      const observation = this.state?.observed[id];
      if (!observation || observation.incomplete || observation.heads.length !== 1 || observation.heads[0] !== revision) continue;
      const change = await this.cached(revision);
      if (!change.bundle) continue;
      try {
        let resolved = this.readyCache.get(revision);
        if (!resolved) { resolved = await this.resolveServer(id, revision, change.bundle); this.readyCache.set(revision, resolved); }
        servers.push(resolved);
      } catch { /* status exposes a setup error without leaking local paths or credentials */ }
    }
    return servers;
  }

  async status(offset = 0, limit = 5) {
    const ready = new Set((await this.available()).map(server => server.id));
    const all = Object.entries(this.state?.observed ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const servers = [];
    for (const [id, observation] of all.slice(offset, offset + limit)) {
      const revision = observation.heads.length === 1 ? observation.heads[0] : undefined;
      const accepted = revision === this.state?.accepted[id];
      const change = revision ? await this.cached(revision).catch(() => undefined) : undefined;
      const status = observation.incomplete ? 'incomplete' : observation.heads.length !== 1 ? 'conflict' : !accepted ? 'pending-approval'
        : !change?.bundle ? 'deleted' : ready.has(id) ? 'ready' : 'needs-local-setup';
      servers.push({ server: id, status, ...(revision ? { revision } : { heads: observation.heads }),
        ...(change?.bundle ? { description: change.bundle.description.slice(0, 160), skills: Object.keys(change.bundle.packages).length } : {}) });
    }
    return { connected: !!this.storageFolder, mode: this.config.sync.mode, ...(this.error ? { error: this.error } : {}),
      requireApproval: this.config.security.requireSyncApproval, agentCanPublish: this.config.security.allowAgentPublish,
      servers, total: all.length, ...(offset + limit < all.length ? { nextOffset: offset + limit } : {}) };
  }

  private requireSnapshot(): Snapshot {
    if (!this.snapshot || this.error) throw new HubError('Sync folder is offline or invalid. Shared data was not changed.');
    return this.snapshot;
  }

  async inspect(id: string, revision?: string) {
    await this.pull(true);
    const snapshot = this.requireSnapshot();
    const observation = snapshot.observed[id];
    revision ??= observation?.heads.length === 1 ? observation.heads[0] : undefined;
    const change = revision ? snapshot.changes.get(revision) : undefined;
    if (!change || change.server !== id) throw new HubError('Specify an existing revision for this server; inspect sync status for conflict heads.');
    return { revision: revision!, change };
  }

  async approve(id: string, revision: string): Promise<void> {
    await this.pull(true);
    const snapshot = this.requireSnapshot();
    const observation = snapshot.observed[id];
    if (!observation || observation.incomplete || observation.heads.length !== 1 || observation.heads[0] !== revision) throw new HubError('Revision changed, is incomplete or conflicts. Inspect and approve the current single revision.');
    this.state = await this.store.mutate(state => { state.accepted[id] = revision; });
  }

  private async commit(id: string, bundle: Bundle | null, parents: string[]): Promise<string> {
    this.state = await this.store.mutate(() => {});
    const change = validateChange({ version: 1, server: id, device: this.state.device, parents: [...parents].sort(), bundle });
    const text = JSON.stringify(change) + '\n';
    if (Buffer.byteLength(text) > MAX_CHANGE) throw new HubError('Shared revision exceeds 2 MiB. Split the attached skills.');
    const revision = digest(text);
    await directory(this.storageFolder!);
    await directory(this.folder());
    await directory(join(this.folder(), 'changes'));
    await atomicWrite(join(this.folder(), 'changes', revision + '.json'), text);
    await this.putCache(revision, text);
    this.state = await this.store.mutate(state => { state.accepted[id] = revision; state.observed[id] = { heads: [revision], incomplete: false }; });
    await this.pull(true);
    return revision;
  }

  async publish(id: string, config: ServerConfig, paths: Record<string, string>, template?: string): Promise<string> {
    await this.pull(true);
    const snapshot = this.requireSnapshot();
    const observation = snapshot.observed[id];
    if (observation && (observation.incomplete || observation.heads.length !== 1)) throw new HubError('Resolve the sync conflict or incomplete history before publishing.');
    return this.commit(id, await this.bundle(id, config, paths, template), observation?.heads ?? []);
  }

  /** Portable source fingerprinting lets the LAN worker publish only actual local edits. */
  async bundle(id: string, config: ServerConfig, paths: Record<string, string>, template?: string): Promise<Bundle> {
    const packages: Bundle['packages'] = {};
    const aliases: Record<string, string> = {};
    const accepted = this.state?.accepted[id];
    if (accepted) {
      const previous = await this.cached(accepted);
      for (const original of Object.keys(previous.bundle?.packages ?? {})) aliases['sync_' + digest(id + ':' + original).slice(0, 24)] = original;
    }
    const originalId = (skill: string) => aliases[skill] ?? skill;
    const bindings = [...new Set([...config.skills, ...Object.values(config.toolSkills).flat()])];
    for (const skill of bindings) {
      if (!Object.hasOwn(paths, skill)) throw new HubError('Attached skill path is unavailable.');
      packages[originalId(skill)] = await packageSkill(paths[skill]!);
    }
    const bundle = bundleSchema.parse({ connection: config.transport === 'http' ? { url: config.url } : { template: template ?? id },
      description: config.description, tags: config.tags, allowedTools: config.allowedTools, skills: config.skills.map(originalId),
      toolSkills: Object.fromEntries(Object.entries(config.toolSkills).map(([tool, skills]) => [tool, skills.map(originalId)])), packages });
    validateChange({ version: 1, server: id, device: randomUUID(), parents: [], bundle });
    if (Buffer.byteLength(JSON.stringify(bundle)) > MAX_CHANGE - 10000) throw new HubError('Shared revision exceeds 2 MiB.');
    return bundle;
  }

  /** LAN is only a transport for the same immutable, strictly validated revisions. */
  async inventory(): Promise<string[]> {
    await this.pull(true);
    return [...this.requireSnapshot().changes.keys()].sort();
  }

  async exportRevision(revision: string): Promise<string> {
    revisionSchema.parse(revision);
    const text = await readText(join(this.folder(), 'changes', revision + '.json'), MAX_CHANGE);
    if (digest(text) !== revision) throw new HubError('Revision integrity check failed.');
    validateChange(JSON.parse(text));
    return text;
  }

  async importRevision(revision: string, text: string): Promise<void> {
    revisionSchema.parse(revision);
    if (Buffer.byteLength(text) > MAX_CHANGE || digest(text) !== revision) throw new HubError('Invalid LAN revision.');
    validateChange(JSON.parse(text));
    // Validate the entire local store before accepting another record; all limits also apply on the wire.
    await this.pull(true);
    const snapshot = this.requireSnapshot();
    if (snapshot.changes.has(revision)) return;
    let bytes = Buffer.byteLength(text);
    for (const key of snapshot.changes.keys()) bytes += Buffer.byteLength(await this.exportRevision(key));
    if (snapshot.changes.size >= MAX_HISTORY || bytes > MAX_HISTORY_BYTES) throw new HubError('Sync history limit reached.');
    await atomicWrite(join(this.folder(), 'changes', revision + '.json'), text);
  }

  async remove(id: string): Promise<string> {
    await this.pull(true);
    const observation = this.requireSnapshot().observed[id];
    if (!observation || observation.incomplete || observation.heads.length !== 1) throw new HubError('Removal requires a complete, unambiguous shared server.');
    return this.commit(id, null, observation.heads);
  }

  async resolve(id: string, revision: string): Promise<string> {
    const { change } = await this.inspect(id, revision);
    const observation = this.requireSnapshot().observed[id]!;
    if (observation.incomplete) throw new HubError('Wait for all parent revisions before resolving.');
    return this.commit(id, change.bundle, observation.heads);
  }
}
