import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expandEnv, idSchema, serverSchema, securityPreset, type Config, type ServerConfig } from './config.js';
import { createHash } from 'node:crypto';
import { HubError } from './errors.js';
import { SkillStore } from './skills.js';
import { Registry, registrationSchema, type Registration } from './registry.js';
import { guardedFetch, validateAgentUrl } from './network.js';
import { ResultStore } from './context.js';
import { DeviceState } from './device.js';
import { GlobalAgents } from './global-agents.js';
import { isGlobalId } from './global-format.js';
import { SyncManager } from './sync.js';

export { HubError } from './errors.js';
type Entry = {
  config: ServerConfig;
  enabled: boolean;
  client?: Client;
  transport?: Transport;
  timer?: NodeJS.Timeout;
  tail: Promise<unknown>;
  state: 'stopped' | 'starting' | 'running' | 'stopping';
  source: 'configured' | 'agent' | 'sync';
  template?: string;
  signature?: string;
  privateHttp: boolean;
  revoked: AbortController;
  cleanup?: () => Promise<void>;
  blocked?: string;
};

export class Hub {
  private readonly entries = new Map<string, Entry>();
  private closing = false;
  private readonly shutdown = new AbortController();
  private closePromise?: Promise<void>;
  private readonly skills: SkillStore;
  private readonly skillPaths: Record<string, string>;
  private syncedSkills = new Set<string>();
  private agentSkillIds = new Set<string>();
  private readonly device?: DeviceState;
  private readonly sync?: SyncManager;
  private readonly globals?: GlobalAgents;
  readonly results = new ResultStore();
  readonly context: Config['context'];
  private mutations: Promise<unknown> = Promise.resolve();
  private focusIds?: Set<string>;

  constructor(private readonly config: Config, private readonly registry = new Registry(), options: { device?: DeviceState; sync?: SyncManager; globals?: GlobalAgents } = {}) {
    this.device = options.device;
    this.sync = options.sync; this.globals = options.globals;
    this.sync?.setLocalResolver(async id => { const registration=(await this.registry.read()).servers[id]; return registration ? this.resolveRegistration(registration,id) : undefined; });
    this.skillPaths = { ...config.skills };
    this.skills = new SkillStore(this.skillPaths);
    this.context = { ...config.context };
    for (const [id, server] of Object.entries(config.servers)) {
      this.entries.set(id, this.newEntry(server, 'configured', true));
    }
  }

  private newEntry(config: ServerConfig, source: Entry['source'], privateHttp: boolean, signature?: string): Entry {
    return { config, enabled: config.enabled, tail: Promise.resolve(), state: 'stopped', source, privateHttp, signature, revoked: new AbortController() };
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutations.then(action);
    this.mutations = next.catch(() => {});
    return next;
  }

  private resolveRegistration(registration: Registration, serverId = 'new'): { config: ServerConfig; privateHttp: boolean } {
    let base: ServerConfig;
    let privateHttp = true;
    if ('template' in registration) {
      if (!Object.hasOwn(this.config.templates, registration.template)) throw new HubError('Unknown owner-defined template. Use control help for add.');
      base = this.config.templates[registration.template]!;
      if (registration.enabled && !base.enabled && !base.allowAgentEnable) throw new HubError('Template policy forbids enabling this server.');
      if (this.config.security.enforceToolAllowlist && base.allowedTools && registration.allowedTools?.some(tool => !base.allowedTools!.includes(tool))) throw new HubError('Cannot widen a template tool allowlist.');
    } else if ('command' in registration) {
      if (!this.config.security.allowAgentStdio) throw new HubError('Owner policy disables agent-defined local commands (allowAgentStdio).');
      if ((Object.keys(registration.env).length || registration.inheritEnv.length) && !this.config.security.allowAgentCredentials) throw new HubError('Owner policy disables agent environment/credential configuration.');
      base = serverSchema.parse({ transport: 'stdio', command: registration.command, args: registration.args, cwd: registration.cwd, env: registration.env, inheritEnv: registration.inheritEnv });
    } else {
      if (registration.headers && Object.keys(registration.headers).length && !this.config.security.allowAgentCredentials) throw new HubError('Owner policy disables agent credential configuration.');
      const url = validateAgentUrl(registration.url, this.config.agent, this.config.security);
      privateHttp = !this.config.security.blockPrivateHttp || this.config.agent.allowedHttpOrigins.some(origin => new URL(origin).origin === url.origin);
      base = serverSchema.parse({ transport: 'http', url: url.href, headers: registration.headers });
    }
    const { enabled, description, tags, allowedTools } = registration;
    const paths = registration.skillPaths ?? {};
    if (Object.keys(paths).length && !this.config.security.allowAgentSkills) throw new HubError('Owner policy disables agent skill paths (allowAgentSkills).');
    const skills = registration.skills ?? (Object.keys(paths).length ? Object.keys(paths) : undefined);
    const config = serverSchema.parse({ ...base, enabled,
      ...(description !== undefined ? { description } : {}), ...(tags !== undefined ? { tags } : {}),
      ...(allowedTools !== undefined ? { allowedTools } : {}), ...(skills !== undefined ? { skills } : {}) });
    if (config.skills.some(id => !Object.hasOwn(this.config.skills, id) && !Object.hasOwn(paths, id))) throw new HubError('Only owner-registered skills can be attached.');
    for (const id of Object.keys(paths)) {
      const alias = 'agent_' + createHash('sha256').update(serverId + ':' + id).digest('hex').slice(0, 24);
      config.skills = config.skills.map(skill => skill === id ? alias : skill);
    }
    return { config, privateHttp };
  }

  private revoke(id: string, entry: Entry) {
    entry.enabled = false;
    entry.revoked.abort();
    this.results.forget(id);
  }

  private async syncRegistry() {
    const document = await this.registry.read();
    for (const id of this.agentSkillIds) delete this.skillPaths[id];
    this.agentSkillIds.clear();
    const managed = new Set(this.sync?.managedIds() ?? []);
    // Revalidate persisted, agent-written definitions against current owner policy before using them.
    const resolved = new Map(Object.entries(document.servers).filter(([id]) => !managed.has(id)).map(([id, registration]) => {
      if (Object.hasOwn(this.config.servers, id)) throw new HubError('Agent registry conflicts with an owner-defined server.');
      let value: {config:ServerConfig;privateHttp:boolean;blocked?:string};
      try { value = this.resolveRegistration(registration,id); }
      catch (error) { value = {config:serverSchema.parse({transport:'stdio',command:'blocked-by-policy',enabled:false,allowAgentEnable:false,description:registration.description ?? ''}),privateHttp:false,blocked:error instanceof HubError?error.message:'Registration blocked by current policy.'}; }
      return [id, { ...value, signature: JSON.stringify(registration)+ (value.blocked ?? ''), template: 'template' in registration ? registration.template : undefined }];
    }));
    if (resolved.size > this.config.agent.maxServers) throw new HubError('Agent registry exceeds owner server limit.');
    for (const [id, entry] of this.entries) {
      if (entry.source !== 'agent' || managed.has(id) || resolved.get(id)?.signature === entry.signature) continue;
      this.revoke(id, entry);
      await this.queue(entry, () => this.disconnect(entry));
      this.entries.delete(id);
    }
    for (const [id, value] of resolved) {
      for (const [skill, path] of Object.entries(value.blocked ? {} : document.servers[id]!.skillPaths ?? {})) {
        const alias = 'agent_' + createHash('sha256').update(id + ':' + skill).digest('hex').slice(0, 24);
        this.skillPaths[alias] = path; this.agentSkillIds.add(alias);
      }
      if (this.entries.has(id)) continue;
      const entry = this.newEntry(value.config, 'agent', value.privateHttp, value.signature);
      entry.template = value.template; entry.blocked = value.blocked;
      if (this.focusIds && !this.focusIds.has(id)) entry.enabled = false;
      this.entries.set(id, entry);
    }
  }

  private async syncShared() {
    if (!this.sync) return;
    const ready = new Map((await this.sync.available()).map(server => [server.id, server]));
    for (const id of this.syncedSkills) delete this.skillPaths[id];
    this.syncedSkills.clear();
    for (const id of this.sync.managedIds()) {
      const previous = this.entries.get(id);
      const value = ready.get(id);
      const enabled = previous?.enabled;
      if (previous && (previous.source !== 'sync' || previous.signature !== value?.revision)) {
        this.revoke(id, previous);
        await this.queue(previous, () => this.disconnect(previous));
        this.entries.delete(id);
      }
      if (!value) continue;
      if (!this.entries.has(id)) {
        const entry = this.newEntry(value.config, 'sync', value.privateHttp, value.revision);
        entry.template = value.template;
        entry.enabled = enabled ?? false;
        if (this.focusIds && !this.focusIds.has(id)) entry.enabled = false;
        this.entries.set(id, entry);
      }
      for (const [skill, path] of Object.entries(value.paths)) {
        if (Object.hasOwn(this.config.skills, skill)) throw new HubError('Synced skill ID conflicts with local configuration.');
        this.skillPaths[skill] = path; this.syncedSkills.add(skill);
      }
    }
  }

  refresh() { return this.mutate(async () => {
    await this.sync?.pull();
    await this.syncRegistry();
    await this.syncShared();
    if (this.device) {
      const state = await this.device.read();
      for (const [id, entry] of this.entries) {
        const enabled = state.enabled[id];
        if (enabled === undefined || enabled === entry.enabled) continue;
        if (enabled && !entry.config.allowAgentEnable) continue;
        if (!enabled) { this.revoke(id, entry); await this.queue(entry, () => this.disconnect(entry)); }
        else { entry.enabled = true; entry.revoked = new AbortController(); }
      }
    }
  }); }

  securityPolicy() { return { ...this.config.security, preset: securityPreset(this.config.security), mutableThroughMcp: false }; }

  async syncControl(operation: 'status' | 'pull' | 'publish' | 'remove' | 'inspect' | 'approve' | 'resolve', server?: string, offset = 0, limit = this.context.listLimit, owner = false, requestedRevision?: string) {
    if (server && isGlobalId(server)) throw new HubError('Use the agents operation for global files.');
    if (!this.sync) throw new HubError('Sync is unavailable in this Hub. Use the installed CLI.');
    if (operation === 'status') return this.sync.status(offset, limit);
    if (operation === 'pull') { await this.sync.pull(true); await this.refresh(); return this.sync.status(offset, limit); }
    if (operation === 'inspect') { if (!server) throw new HubError('Specify server.'); return this.sync.inspect(server, requestedRevision); }
    if (operation === 'approve' || operation === 'resolve') {
      if (!owner && !this.config.security.allowAgentSyncApproval) throw new HubError('Owner policy disables agent sync approval.');
      if (!server || !requestedRevision) throw new HubError('Specify server and the inspected revision.');
      if (operation === 'resolve' && !owner && !this.config.security.allowAgentPublish) throw new HubError('Owner policy disables agent publishing.');
      const accepted = operation === 'approve' ? (await this.sync.approve(server, requestedRevision), requestedRevision) : await this.sync.resolve(server, requestedRevision);
      await this.refresh(); return { server, revision: accepted, accepted: true };
    }
    if (!owner && !this.config.security.allowAgentPublish) throw new HubError('Owner policy disables agent publishing. Local CLI sync publish/remove is available.');
    if (!server) throw new HubError('Sync publish/remove requires server.');
    if (operation === 'remove') {
      const entry = this.entries.get(server);
      if (entry && !entry.config.allowAgentRemove) throw new HubError('Owner policy prevents removing this server.');
      const revision = await this.sync.remove(server);
      await this.refresh();
      return { server, revision, shared: true, deleted: true };
    }
    const entry = this.entry(server);
    // Preserve the origin device's switch while promoting its registration to sync management.
    await this.device?.set(server, entry.enabled);
    // Owner-defined sources remain editable originals; synced cache copies are immutable snapshots.
    const original = this.config.servers[server];
    const revision = await this.sync.publish(server, original ?? entry.config, original ? this.config.skills : this.skillPaths, entry.template);
    await this.refresh();
    return { server, revision, shared: true };
  }

  async globalControl(input: unknown) {
    if (!this.globals) throw new HubError('Global sync requires the installed Hub runtime.');
    return this.globals.control(input);
  }

  registrationPolicy() {
    return { allowed: this.config.security.allowAgentRegistration, localCommands: this.config.security.allowAgentStdio, credentials: this.config.security.allowAgentCredentials, skillPaths: this.config.security.allowAgentSkills, preset: securityPreset(this.config.security), requireHttps: this.config.security.requireHttps, blockPrivateHttp: this.config.security.blockPrivateHttp, publicHttps: this.config.agent.allowPublicHttp, maxServers: this.config.agent.maxServers,
      templates: Object.entries(this.config.templates).map(([template, value]) => ({ template, description: value.description, transport: value.transport })) };
  }

  add(id: string, input: unknown, replace = false) {
    return this.mutate(async () => {
      if (!this.config.security.allowAgentRegistration) throw new HubError('Owner policy disables agent registration.');
      idSchema.parse(id);
      if (id.startsWith('agents-global-')) throw new HubError('Reserved global sync namespace.');
      const parsed = registrationSchema.safeParse(input);
      if (!parsed.success) throw new HubError('Invalid registration. Use hub_control help with action add for its schema. Only fields in the discovered schema and granted permissions are accepted.');
      const registration = parsed.data;
      this.resolveRegistration(registration, id);
      if (registration.skillPaths) await new SkillStore(registration.skillPaths).validate();
      if (Object.hasOwn(this.config.servers, id)) throw new HubError('Cannot replace an owner-defined server.');
      const shared = this.sync?.managedIds().includes(id);
      if (shared && (!replace || !this.config.security.allowAgentPublish || !Object.hasOwn((await this.registry.read()).servers,id))) throw new HubError('Shared updates require an agent-owned registration and publishing permission.');
      await this.registry.mutate(document => {
        if (Object.hasOwn(document.servers, id) !== replace) throw new HubError(replace ? 'No agent registration to update.' : 'Server ID already exists. Use update with a complete replacement definition.');
        if (!replace && Object.keys(document.servers).length >= this.config.agent.maxServers) throw new HubError('Agent server limit reached.');
        document.servers[id] = registration;
      });
      if (shared && this.sync) {
        const resolved=this.resolveRegistration(registration,id);
        const paths={...this.config.skills};
        for(const [skill,path] of Object.entries(registration.skillPaths??{})) paths['agent_'+createHash('sha256').update(id+':'+skill).digest('hex').slice(0,24)]=path;
        await this.sync.publish(id,resolved.config,paths,'template' in registration?registration.template:undefined);
        await this.syncShared();
      }
      await this.syncRegistry();
      const entry = this.entry(id);
      const enabled = registration.enabled && (!this.focusIds || this.focusIds.has(id));
      if (!enabled && entry.enabled) { this.revoke(id, entry); await this.queue(entry, () => this.disconnect(entry)); }
      else if (enabled && !entry.enabled) { entry.enabled = true; entry.revoked = new AbortController(); }
      await this.device?.set(id, entry.enabled);
      return { ...this.summary(id, entry), scope: this.registry.path ? 'shared' : 'session' };
    });
  }

  remove(id: string) {
    return this.mutate(async () => {
      await this.syncRegistry();
      const entry = this.entry(id,true);
      if (entry.source === 'sync') throw new HubError('Use hub_control sync with operation remove to publish a shared deletion, or disable for this device only.');
      if (!entry.config.allowAgentRemove) throw new HubError('Owner policy prevents removing this server.');
      if (entry.source === 'agent') await this.registry.mutate(document => { delete document.servers[id]; });
      this.revoke(id, entry);
      await this.queue(entry, () => this.disconnect(entry));
      this.entries.delete(id);
      return { server: id, removed: true, scope: entry.source === 'agent' && this.registry.path ? 'shared' : 'session' };
    });
  }

  focus(ids: string[]) {
    return this.mutate(async () => {
      ids = [...new Set(ids)];
      for (const id of ids) {
        const entry = this.entry(id);
        if (!entry.enabled && !entry.config.allowAgentEnable) throw new HubError(`Owner policy prevents enabling ${id}.`);
      }
      this.focusIds = new Set(ids);
      await Promise.all([...this.entries].map(([id]) => this.control(id, this.focusIds!.has(id) ? 'enable' : 'disable')));
      return { enabled: [...this.focusIds], disabled: this.entries.size - this.focusIds.size };
    });
  }

  private entry(id: string, allowBlocked = false): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new HubError(`Unknown server: ${id}. Use hub_catalog.`);
    if (entry.blocked && !allowBlocked) throw new HubError(entry.blocked);
    return entry;
  }

  isEnabled(id: string): boolean { return !this.closing && (this.entries.get(id)?.enabled ?? false); }

  private summary(id: string, entry: Entry) {
    return {
      server: id, description: entry.config.description.slice(0, this.context.summaryChars),
      enabled: entry.enabled, state: entry.state,
      ...(!entry.config.allowAgentEnable ? { agentCanEnable: false } : {}),
      source: entry.source,
      ...(entry.blocked ? {blocked:entry.blocked} : {}),
      ...(this.skillIds(entry).length ? { skillCount: this.skillIds(entry).length } : {}),
    };
  }

  private skillIds(entry: Entry, tool?: string): string[] {
    const allow = this.config.security.enforceToolAllowlist ? entry.config.allowedTools : undefined;
    const specific = Object.entries(entry.config.toolSkills)
      .filter(([name]) => (!tool || tool === name) && (!allow || allow.includes(name)))
      .flatMap(([, skills]) => skills);
    return [...new Set([...entry.config.skills, ...specific])];
  }

  async catalog(query = '', offset = 0, limit = this.context.listLimit, server?: string, tool?: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const includes = (text: string) => terms.every(term => text.toLowerCase().includes(term));
    if (server) {
      const entry = this.entry(server,true);
      if(entry.blocked)return {...this.summary(server,entry),skills:[],total:0};
      const skills = (await Promise.all(this.skillIds(entry, tool).map(id => this.skills.summary(id))))
        .filter(skill => includes(`${skill.skill} ${skill.description}`));
      return { ...this.summary(server, entry), skills: skills.slice(offset, offset + limit).map(skill => ({ ...skill, description: skill.description.slice(0, this.context.summaryChars) })), total: skills.length,
        ...(offset + limit < skills.length ? { nextOffset: offset + limit } : {}) };
    }
    // Read each shared skill's metadata once per search, only when a query needs it.
    const metadata = new Map<string, string>();
    if (terms.length) {
      const ids = [...new Set([...this.entries.values()].flatMap(entry => this.skillIds(entry)))];
      await Promise.all(ids.map(async id => {
        const summary = await this.skills.summary(id);
        metadata.set(id, `${id} ${summary.description}`);
      }));
    }
    const matches = [...this.entries].filter(([id, entry]) => {
      const text = `${id} ${entry.config.description} ${entry.config.tags.join(' ')} ${this.skillIds(entry).map(id => metadata.get(id) ?? id).join(' ')}`;
      return includes(text);
    });
    return { servers: matches.slice(offset, offset + limit).map(([id, entry]) => this.summary(id, entry)), total: matches.length,
      nextOffset: offset + limit < matches.length ? offset + limit : undefined };
  }

  async skill(id: string, skill: string, options: { file?: string; offset?: number; ifRevision?: string } = {}) {
    const entry = this.entry(id);
    if (!entry.enabled) throw new HubError(`Server ${id} is OFF. Use hub_control enable if permitted.`);
    if (!this.skillIds(entry).includes(skill)) throw new HubError('Skill is not attached to this server or its allowed tools. Use hub_catalog with server.');
    // No connection or idle timer change: learning a procedure must not start its MCP process.
    return this.skills.read(skill, options);
  }

  /** Serialize a server's lifecycle and requests; different servers stay independent. */
  private queue<T>(entry: Entry, action: () => Promise<T>): Promise<T> {
    const work = entry.tail.then(async () => {
      clearTimeout(entry.timer);
      try { return await action(); }
      finally { this.scheduleIdle(entry); }
    });
    entry.tail = work.catch(() => {});
    return work;
  }

  private scheduleIdle(entry: Entry) {
    const timeout = entry.config.idleTimeoutMs ?? this.config.idleTimeoutMs;
    if (this.closing || !entry.client || !timeout) return;
    entry.timer = setTimeout(() => {
      void this.queue(entry, () => this.disconnect(entry)).catch(() => {});
    }, timeout);
    entry.timer.unref();
  }

  private async disconnect(entry: Entry) {
    const client = entry.client;
    const transport = entry.transport;
    entry.client = undefined;
    entry.transport = undefined;
    entry.state = 'stopping';
    try {
      if (transport instanceof StreamableHTTPClientTransport) await transport.terminateSession().catch(() => {});
      await client?.close();
    }
    finally { await entry.cleanup?.(); entry.cleanup = undefined; entry.state = 'stopped'; }
  }

  private transport(config: ServerConfig, entry: Entry): Transport {
    if (config.transport === 'http') {
      if (!this.config.security.allowHttp) throw new HubError('HTTP transport is disabled by local security policy.');
      const network = guardedFetch(config.url, entry.privateHttp);
      entry.cleanup = network.close;
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, expandEnv(value)])) },
        fetch: network.fetch,
      });
    }
    if (!this.config.security.allowStdio) throw new HubError('Stdio transport is disabled by local security policy.');
    const env: Record<string, string> = {};
    if (this.config.security.inheritProcessEnv) for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
    for (const key of config.inheritEnv) {
      if (process.env[key] !== undefined) env[key] = process.env[key]!;
    }
    for (const [key, value] of Object.entries(config.env)) env[key] = expandEnv(value);
    return new StdioClientTransport({
      command: config.command, args: config.args.map(expandEnv), cwd: config.cwd, env,
      // Some servers print credentials to stderr; never mix it with MCP or expose it to agents.
      stderr: 'ignore',
    });
  }

  private async connect(entry: Entry, signal: AbortSignal): Promise<Client> {
    if (entry.client) return entry.client;
    entry.state = 'starting';
    const client = new Client({ name: 'mcp-context-hub', version: '0.6.0' }, { capabilities: {} });
    let transport: Transport | undefined;
    try {
      transport = this.transport(entry.config, entry);
      await client.connect(transport, { signal, timeout: entry.config.timeoutMs ?? this.config.timeoutMs });
      entry.client = client;
      entry.transport = transport;
      entry.state = 'running';
      client.onclose = () => {
        if (entry.client === client) { entry.client = undefined; entry.transport = undefined; entry.state = 'stopped'; void entry.cleanup?.(); entry.cleanup = undefined; }
      };
      return client;
    } catch (error) {
      await transport?.close().catch(() => {});
      await entry.cleanup?.(); entry.cleanup = undefined;
      entry.state = 'stopped';
      throw error;
    }
  }

  private withClient<T>(id: string, signal: AbortSignal | undefined, action: (client: Client, signal: AbortSignal) => Promise<T>) {
    const entry = this.entry(id);
    return this.queue(entry, async () => {
      if (this.closing) throw new HubError('Hub is shutting down.');
      if (this.entries.get(id) !== entry) throw new HubError('Server was removed or replaced.');
      if (!entry.enabled) throw new HubError(`Server ${id} is OFF. Use hub_control enable if permitted.`);
      const deadline = AbortSignal.timeout(entry.config.timeoutMs ?? this.config.timeoutMs);
      const combined = AbortSignal.any([this.shutdown.signal, entry.revoked.signal, deadline, ...(signal ? [signal] : [])]);
      combined.throwIfAborted();
      try { return await action(await this.connect(entry, combined), combined); }
      catch (error) {
        if (error instanceof HubError) throw error;
        if (combined.aborted) {
          throw new HubError(`Server ${id}: operation cancelled or timed out. Execution may already have occurred; do not automatically retry writes.`);
        }
        // Downstream exception text may contain expanded secrets or authorization headers.
        throw new HubError(`Server ${id}: connection or request failed. Check its command, environment, credentials and protocol compatibility.`);
      }
    });
  }

  private async allTools(client: Client, signal: AbortSignal): Promise<Tool[]> {
    const tools: Tool[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await client.listTools(cursor === undefined ? {} : { cursor }, { signal });
      tools.push(...result.tools);
      cursor = result.nextCursor;
      if (tools.length > 10_000 || seen.size >= 100 || (cursor !== undefined && seen.has(cursor))) {
        throw new HubError('Downstream tool pagination exceeded limits or repeated a cursor.');
      }
      if (cursor !== undefined) seen.add(cursor);
    } while (cursor !== undefined);
    return tools;
  }

  async tools(id: string, options: { tool?: string; query?: string; offset?: number; limit?: number; ifRevision?: string } = {}, signal?: AbortSignal) {
    return this.withClient(id, signal, async (client, requestSignal) => {
      const allow = this.config.security.enforceToolAllowlist ? this.entry(id).config.allowedTools : undefined;
      let tools = (await this.allTools(client, requestSignal)).filter(tool => !allow || allow.includes(tool.name));
      if (options.tool) {
        const tool = tools.find(tool => tool.name === options.tool);
        if (!tool) throw new HubError('Tool not found or not allowed. Use hub_tools to list available names.');
        const skills = this.skillIds(this.entry(id), options.tool);
        const revision = createHash('sha256').update(JSON.stringify({ tool, skills })).digest('hex').slice(0, 16);
        if (options.ifRevision === revision) return { server: id, tool: options.tool, revision, unchanged: true };
        return { server: id, tool, revision, ...(skills.length ? { skills } : {}) };
      }
      const query = (options.query ?? '').toLowerCase();
      tools = tools.filter(tool => `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query));
      const offset = options.offset ?? 0;
      const limit = options.limit ?? this.context.listLimit;
      return { server: id, tools: tools.slice(offset, offset + limit).map(tool => ({ name: tool.name, description: tool.description?.slice(0, this.context.summaryChars) })),
        total: tools.length, nextOffset: offset + limit < tools.length ? offset + limit : undefined };
    });
  }

  async call(id: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
    // Check local allowlist before starting a process or making a network connection.
    const allow = this.config.security.enforceToolAllowlist ? this.entry(id).config.allowedTools : undefined;
    if (allow && !allow.includes(tool)) throw new HubError('Tool is not allowed by the server configuration.');
    return this.withClient(id, signal, async (client, requestSignal) => {
      return CallToolResultSchema.parse(await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, { signal: requestSignal }));
    });
  }

  async control(id: string, action: 'status' | 'enable' | 'disable' | 'start' | 'stop', signal?: AbortSignal) {
    const entry = this.entry(id);
    if (action === 'status') return this.summary(id, entry);
    if (action === 'start') return this.withClient(id, signal, async () => this.summary(id, entry));
    if (action === 'disable') this.revoke(id, entry);
    return this.queue(entry, async () => {
      if (this.closing) throw new HubError('Hub is shutting down.');
      if (action === 'enable') {
        if (!entry.enabled && !entry.config.allowAgentEnable) throw new HubError('Agent enable is forbidden by configuration. Ask the user to change the global config.');
        entry.enabled = true;
        if (entry.revoked.signal.aborted) entry.revoked = new AbortController();
      } else {
        if (action === 'disable') entry.enabled = false;
        await this.disconnect(entry);
      }
      if (action === 'enable' || action === 'disable') await this.device?.set(id, entry.enabled);
      return this.summary(id, entry);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.results.forget();
    this.shutdown.abort();
    this.closePromise = Promise.allSettled([...this.entries.values()].map(entry => {
      clearTimeout(entry.timer);
      return this.queue(entry, () => this.disconnect(entry));
    })).then(() => {});
    return this.closePromise;
  }
}
