import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CallToolResultSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { expandEnv, type Config, type ServerConfig } from './config.js';
import { HubError } from './errors.js';
import { SkillStore } from './skills.js';

export { HubError } from './errors.js';
type Entry = {
  config: ServerConfig;
  enabled: boolean;
  client?: Client;
  transport?: Transport;
  timer?: NodeJS.Timeout;
  tail: Promise<unknown>;
  state: 'stopped' | 'starting' | 'running' | 'stopping';
};

export class Hub {
  private readonly entries = new Map<string, Entry>();
  private closing = false;
  private readonly shutdown = new AbortController();
  private closePromise?: Promise<void>;
  private readonly skills: SkillStore;

  constructor(private readonly config: Config) {
    this.skills = new SkillStore(config.skills);
    for (const [id, server] of Object.entries(config.servers)) {
      this.entries.set(id, { config: server, enabled: server.enabled, tail: Promise.resolve(), state: 'stopped' });
    }
  }

  private entry(id: string): Entry {
    const entry = this.entries.get(id);
    if (!entry) throw new HubError(`Unknown server: ${id}. Use hub_catalog.`);
    return entry;
  }

  private summary(id: string, entry: Entry) {
    return {
      server: id, description: entry.config.description, tags: entry.config.tags,
      enabled: entry.enabled, state: entry.state,
      agentCanEnable: entry.config.allowAgentEnable,
      ...(this.skillIds(entry).length ? { skillCount: this.skillIds(entry).length } : {}),
    };
  }

  private skillIds(entry: Entry, tool?: string): string[] {
    const allow = entry.config.allowedTools;
    const specific = Object.entries(entry.config.toolSkills)
      .filter(([name]) => (!tool || tool === name) && (!allow || allow.includes(name)))
      .flatMap(([, skills]) => skills);
    return [...new Set([...entry.config.skills, ...specific])];
  }

  async catalog(query = '', offset = 0, limit = 20, server?: string, tool?: string) {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const includes = (text: string) => terms.every(term => text.toLowerCase().includes(term));
    if (server) {
      const entry = this.entry(server);
      const skills = (await Promise.all(this.skillIds(entry, tool).map(id => this.skills.summary(id))))
        .filter(skill => includes(`${skill.skill} ${skill.description}`));
      return { ...this.summary(server, entry), skills: skills.slice(offset, offset + limit), total: skills.length,
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
    finally { entry.state = 'stopped'; }
  }

  private transport(config: ServerConfig): Transport {
    if (config.transport === 'http') {
      return new StreamableHTTPClientTransport(new URL(config.url), {
        requestInit: { headers: Object.fromEntries(Object.entries(config.headers).map(([key, value]) => [key, expandEnv(value)])) },
        fetch: (url, init) => {
          // Session cleanup must not stall process shutdown if the endpoint is unavailable.
          if (init?.method !== 'DELETE') return fetch(url, init);
          const signal = AbortSignal.any([AbortSignal.timeout(1000), ...(init.signal ? [init.signal] : [])]);
          return fetch(url, { ...init, signal });
        },
      });
    }
    const env: Record<string, string> = {};
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
    const client = new Client({ name: 'mcp-context-hub', version: '0.1.0' }, { capabilities: {} });
    let transport: Transport | undefined;
    try {
      transport = this.transport(entry.config);
      await client.connect(transport, { signal, timeout: entry.config.timeoutMs ?? this.config.timeoutMs });
      entry.client = client;
      entry.transport = transport;
      entry.state = 'running';
      client.onclose = () => {
        if (entry.client === client) { entry.client = undefined; entry.transport = undefined; entry.state = 'stopped'; }
      };
      return client;
    } catch (error) {
      await transport?.close().catch(() => {});
      entry.state = 'stopped';
      throw error;
    }
  }

  private withClient<T>(id: string, signal: AbortSignal | undefined, action: (client: Client, signal: AbortSignal) => Promise<T>) {
    const entry = this.entry(id);
    return this.queue(entry, async () => {
      if (this.closing) throw new HubError('Hub is shutting down.');
      if (!entry.enabled) throw new HubError(`Server ${id} is OFF. Use hub_control enable if permitted.`);
      const deadline = AbortSignal.timeout(entry.config.timeoutMs ?? this.config.timeoutMs);
      const combined = AbortSignal.any([this.shutdown.signal, deadline, ...(signal ? [signal] : [])]);
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

  async tools(id: string, options: { tool?: string; query?: string; offset?: number; limit?: number } = {}, signal?: AbortSignal) {
    return this.withClient(id, signal, async (client, requestSignal) => {
      const allow = this.entry(id).config.allowedTools;
      let tools = (await this.allTools(client, requestSignal)).filter(tool => !allow || allow.includes(tool.name));
      if (options.tool) {
        const tool = tools.find(tool => tool.name === options.tool);
        if (!tool) throw new HubError('Tool not found or not allowed. Use hub_tools to list available names.');
        const skills = this.skillIds(this.entry(id), options.tool);
        return { server: id, tool, ...(skills.length ? { skills } : {}) };
      }
      const query = (options.query ?? '').toLowerCase();
      tools = tools.filter(tool => `${tool.name} ${tool.description ?? ''}`.toLowerCase().includes(query));
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 20;
      return { server: id, tools: tools.slice(offset, offset + limit).map(tool => ({ name: tool.name, description: tool.description?.slice(0, 300) })),
        total: tools.length, nextOffset: offset + limit < tools.length ? offset + limit : undefined };
    });
  }

  async call(id: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal) {
    // Check local allowlist before starting a process or making a network connection.
    const allow = this.entry(id).config.allowedTools;
    if (allow && !allow.includes(tool)) throw new HubError('Tool is not allowed by the server configuration.');
    return this.withClient(id, signal, async (client, requestSignal) => {
      return CallToolResultSchema.parse(await client.callTool({ name: tool, arguments: args }, CallToolResultSchema, { signal: requestSignal }));
    });
  }

  async control(id: string, action: 'status' | 'enable' | 'disable' | 'start' | 'stop', signal?: AbortSignal) {
    const entry = this.entry(id);
    if (action === 'status') return this.summary(id, entry);
    if (action === 'start') return this.withClient(id, signal, async () => this.summary(id, entry));
    return this.queue(entry, async () => {
      if (this.closing) throw new HubError('Hub is shutting down.');
      if (action === 'enable') {
        if (!entry.enabled && !entry.config.allowAgentEnable) throw new HubError('Agent enable is forbidden by configuration. Ask the user to change the global config.');
        entry.enabled = true;
      } else {
        if (action === 'disable') entry.enabled = false;
        await this.disconnect(entry);
      }
      return this.summary(id, entry);
    });
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closing = true;
    this.shutdown.abort();
    this.closePromise = Promise.allSettled([...this.entries.values()].map(entry => {
      clearTimeout(entry.timer);
      return this.queue(entry, () => this.disconnect(entry));
    })).then(() => {});
    return this.closePromise;
  }
}
