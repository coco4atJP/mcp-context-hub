import { randomBytes, timingSafeEqual } from 'node:crypto';
import { hostname } from 'node:os';
import { generate } from 'selfsigned';
import { LanDiscovery } from './lan-discovery.js';
import { z } from 'zod';
import { LocalStore } from './storage.js';
import { HubError } from './errors.js';
import { endpointSchema, fingerprintSchema, invitationUrl, lanInterfaces, onLan, parseInvitation, secretSchema, type Endpoint } from './lan-network.js';
import { certificateId, listen, request, sha256, type Identity } from './lan-wire.js';
import type { SyncManager } from './sync.js';

const nameSchema = z.string().min(1).max(60).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value));
const sessionSchema = z.string().regex(/^[a-f0-9]{32}$/);
const peerSchema = z.object({ name: nameSchema, endpoints: z.array(endpointSchema).max(8), added: z.number() }).strict();
const stateSchema = z.object({ version: z.literal(1), identity: z.object({ key: z.string().max(8000), cert: z.string().max(8000) }).strict().nullable(),
  peers: z.record(fingerprintSchema, peerSchema).refine(value => Object.keys(value).length <= 20) }).strict();
type State = z.infer<typeof stateSchema>;
type Peer = z.infer<typeof peerSchema>;
type Pending = { id: string; peer: string; name: string; code: string; expires: number; local: boolean; remote: boolean; direction: 'incoming' | 'outgoing'; endpoints: Endpoint[] };
const messageSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('join'), token: secretSchema, name: nameSchema, port: endpointSchema.shape.port }).strict(),
  z.object({ op: z.literal('finish'), session: sessionSchema }).strict(),
  z.object({ op: z.literal('inventory') }).strict(),
  z.object({ op: z.literal('get'), revision: fingerprintSchema }).strict(),
  z.object({ op: z.literal('put'), revision: fingerprintSchema, data: z.string().max(2800000).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict(),
]);
const equalSecret = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const displayCode = (token: string, issuer: string, joiner: string) => String(parseInt(sha256(`mcp-context-hub/pair/v1:${token}:${issuer}:${joiner}`).slice(0, 12), 16) % 1000000).padStart(6, '0');

export type PeerOptions = {
  /** Dependency injection for transport tests. Production uses the direct-LAN policy. */
  allowed?: (address: string) => boolean; addresses?: () => string[]; discovery?: boolean;
};

/** Only pairing and immutable-record exchange cross this boundary; no owner or MCP operations. */
export class LanPeer {
  private readonly store: LocalStore<State>;
  private state!: State;
  private listener?: Awaited<ReturnType<typeof listen>>;
  private discovery?: LanDiscovery;
  private discovered = new Map<string, Endpoint[]>();
  private invitation?: { token: string; expires: number };
  private pending = new Map<string, Pending>();
  private completed = new Map<string, { peer: string; expires: number }>();
  private connections = new Map<string, { lastSync?: number; error?: string }>();
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private syncing?: Promise<void>;
  private abort = new AbortController();
  private queued = 0;
  private cursor = 0;
  discoveryError = false;
  readonly name = hostname().replace(/[\p{Cc}\p{Cf}]/gu, '').slice(0, 60) || 'Context Hub';
  readonly allowed: (address: string) => boolean;
  readonly addresses: () => string[];
  get id() { return certificateId(this.state.identity!.cert); }
  get port() { return this.listener!.port; }
  get identity(): Identity { return this.state.identity!; }

  constructor(path: string, private readonly syncStore: () => Promise<SyncManager>, private readonly options: PeerOptions = {}) {
    this.store = new LocalStore(path + '.lan-peers.json', value => stateSchema.parse(value), () => ({ version: 1, identity: null, peers: {} }), 256 * 1024);
    this.allowed = options.allowed ?? (address => onLan(address)); this.addresses = options.addresses ?? (() => lanInterfaces().map(value => value.address).slice(0, 8));
  }
  async start(): Promise<void> {
    this.state = await this.store.read();
    if (!this.state.identity) {
      const generated = await generate([{ name: 'commonName', value: 'MCP Context Hub device' }], {
        keyType: 'ec', curve: 'P-256', algorithm: 'sha256', notBeforeDate: new Date(Date.now() - 60000),
        notAfterDate: new Date(Date.now() + 5 * 365 * 86400000), extensions: [
          { name: 'basicConstraints', cA: false }, { name: 'keyUsage', digitalSignature: true },
          { name: 'extKeyUsage', serverAuth: true, clientAuth: true },
        ],
      });
      this.state = await this.store.mutate(state => { state.identity ??= { key: generated.private, cert: generated.cert }; });
    }
    certificateId(this.identity.cert);
    this.listener = await listen(this.identity, this.allowed, id => Object.hasOwn(this.state.peers, id), (id, value, address) => this.serial(() => this.handle(id, value, address)));
    this.discover();
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.queued >= 24) return Promise.reject(new HubError('LAN同期が混み合っています。'));
    this.queued++;
    const result = this.tail.then(() => { if (this.closed) throw new HubError('LAN同期は停止しています。'); return fn(); }).finally(() => { this.queued--; });
    this.tail = result.catch(() => {}); return result;
  }
  private prune() {
    const now = Date.now();
    for (const [id, item] of this.pending) if (item.expires < now) this.pending.delete(id);
    for (const [id, item] of this.completed) if (item.expires < now) this.completed.delete(id);
    if (this.invitation && this.invitation.expires < now) this.invitation = undefined;
  }
  private discover() {
    if (this.options.discovery === false) return;
    if (this.discovery) { this.discovery.update(); return; }
    this.discoveryError = false;
    try {
      this.discovery = new LanDiscovery(this.id, this.port, this.addresses, this.allowed, () => Object.keys(this.state.peers),
        (id, endpoints) => this.discovered.set(id, endpoints), () => { this.discoveryError = true; });
    } catch { this.discoveryError = true; }
  }

  invite() {
    this.prune();
    const addresses = this.addresses().filter(this.allowed).slice(0, 8);
    if (!addresses.length) throw new HubError('接続できるLANがありません。Wi-Fiまたは有線LANを確認してください。');
    if (Object.keys(this.state.peers).length >= 20) throw new HubError('ペアリングできる端末は20台までです。');
    if (this.pending.size) throw new HubError('確認中のペアリングを完了またはキャンセルしてください。');
    const token = randomBytes(32).toString('hex'); const expires = Date.now() + 5 * 60000;
    this.invitation = { token, expires };
    return { url: invitationUrl({ v: 1, a: addresses, p: this.port, k: this.id, t: token, e: expires }), expires };
  }

  async join(url: string) {
    const invitation = parseInvitation(url);
    this.prune();
    if (invitation.k === this.id) throw new HubError('この端末の招待です。もう一方の端末で開いてください。');
    if (this.pending.size || Object.keys(this.state.peers).length >= 20) throw new HubError('確認中の接続、または端末数の上限を確認してください。');
    const endpoints = invitation.a.filter(this.allowed).map(address => ({ address, port: invitation.p }));
    const response = z.object({ session: sessionSchema, name: nameSchema }).strict().parse(await this.contact(invitation.k, endpoints, { op: 'join', token: invitation.t, name: this.name, port: this.port }));
    this.pending.set(response.session, { id: response.session, peer: invitation.k, name: response.name,
      code: displayCode(invitation.t, invitation.k, this.id), expires: invitation.e, local: false, remote: false, direction: 'outgoing', endpoints });
    return { session: response.session };
  }

  async confirm(session: string) {
    return this.serial(async () => {
      this.prune(); const pending = this.pending.get(sessionSchema.parse(session));
      if (!pending) throw new HubError('確認の期限が切れました。招待からやり直してください。');
      pending.local = true;
      if (pending.direction === 'incoming' && pending.remote) await this.accept(pending);
    });
  }
  async cancel() {
    await this.serial(async () => { this.invitation = undefined; this.pending.clear(); });
  }
  async unpair(id: string) {
    await this.serial(async () => {
      fingerprintSchema.parse(id);
      this.state = await this.store.mutate(state => { delete state.peers[id]; });
      for (const [session, item] of this.completed) if (item.peer === id) this.completed.delete(session);
      for (const [session, item] of this.pending) if (item.peer === id) this.pending.delete(session);
      this.discovered.delete(id); this.connections.delete(id); this.discover();
    });
  }
  private async accept(item: Pending) {
    this.state = await this.store.mutate(state => { state.peers[item.peer] = { name: item.name, endpoints: item.endpoints, added: Date.now() }; });
    this.completed.set(item.id, { peer: item.peer, expires: item.expires }); this.pending.delete(item.id); this.discover();
  }
  private async handle(id: string, raw: unknown, address: string): Promise<unknown> {
    await this.syncStore(); // Recheck local mode/policy on every network request.
    this.prune(); const message = messageSchema.parse(raw);
    if (message.op === 'join') {
      if (id === this.id || this.pending.size || Object.keys(this.state.peers).length >= 20 || !this.invitation ||
        !equalSecret(message.token, this.invitation.token)) throw new HubError('Invalid invitation.');
      const session = randomBytes(16).toString('hex');
      this.pending.set(session, { id: session, peer: id, name: message.name, code: displayCode(message.token, this.id, id),
        expires: this.invitation.expires, local: false, remote: false, direction: 'incoming', endpoints: [{ address, port: message.port }] });
      this.invitation = undefined; return { session, name: this.name };
    }
    if (message.op === 'finish') {
      const done = this.completed.get(message.session);
      if (done?.peer === id && Object.hasOwn(this.state.peers, id)) return { ready: true };
      const pending = this.pending.get(message.session);
      if (!pending || pending.peer !== id || pending.direction !== 'incoming') throw new HubError('Invalid pairing session.');
      pending.remote = true;
      if (pending.local) await this.accept(pending);
      return { ready: pending.local };
    }
    if (!Object.hasOwn(this.state.peers, id)) throw new HubError('Unpaired device.');
    const sync = await this.syncStore();
    if (message.op === 'inventory') return { revisions: await sync.inventory() };
    if (message.op === 'get') return { data: Buffer.from(await sync.exportRevision(message.revision)).toString('base64') };
    await sync.importRevision(message.revision, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(message.data, 'base64')));
    return { ok: true };
  }

  private async contact(id: string, endpoints: Endpoint[], message: unknown): Promise<unknown> {
    for (const endpoint of endpoints.filter(value => this.allowed(value.address)).slice(0, 8)) {
      if (this.closed) break;
      try { return await request(this.identity, endpoint, id, message, this.allowed, this.abort.signal); } catch { /* try another verified LAN address */ }
    }
    throw new HubError('相手に接続できません。同じLAN・相手の起動状態・ファイアウォールを確認してください。');
  }
  private endpoints(id: string, peer: Peer) {
    return [...(this.discovered.get(id) ?? []), ...peer.endpoints].filter((value, i, all) => all.findIndex(item => item.address === value.address && item.port === value.port) === i).slice(0, 8);
  }

  tick(): Promise<void> {
    return this.syncing ??= this.cycle().finally(() => { this.syncing = undefined; });
  }
  private async cycle() {
    this.prune(); this.discover();
    for (const item of this.pending.values()) {
      if (item.direction !== 'outgoing' || !item.local) continue;
      try {
        const result = z.object({ ready: z.boolean() }).strict().parse(await this.contact(item.peer, item.endpoints, { op: 'finish', session: item.id }));
        if (result.ready) await this.serial(async () => { if (this.pending.get(item.id) === item && item.expires >= Date.now()) await this.accept(item); });
      } catch { /* short-lived pending status remains visible */ }
    }
    // One peer at a time, bounded work per cycle; an offline device cannot create an unbounded task queue.
    const all = Object.entries(this.state.peers); const started = Date.now();
    for (let visited = 0; visited < all.length && Date.now() - started < 20000; visited++) {
      const [id, peer] = all[this.cursor++ % all.length]!;
      if (!Object.hasOwn(this.state.peers, id)) continue;
      if (this.closed) return;
      try {
        const endpoints = this.endpoints(id, peer);
        const response = z.object({ revisions: z.array(fingerprintSchema).max(2000) }).strict().parse(await this.contact(id, endpoints, { op: 'inventory' }));
        const sync = await this.syncStore(); const local = await sync.inventory();
        const ours = new Set(local); const theirs = new Set(response.revisions);
        for (const revision of response.revisions.filter(value => !ours.has(value)).slice(0, 32)) {
          if (!Object.hasOwn(this.state.peers, id) || this.closed) break;
          const result = z.object({ data: z.string().max(2800000).regex(/^[A-Za-z0-9+/]*={0,2}$/) }).strict().parse(await this.contact(id, endpoints, { op: 'get', revision }));
          if (!Object.hasOwn(this.state.peers, id) || this.closed) break;
          await (await this.syncStore()).importRevision(revision, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(result.data, 'base64')));
        }
        for (const revision of local.filter(value => !theirs.has(value)).slice(0, 32)) {
          if (!Object.hasOwn(this.state.peers, id) || this.closed) break;
          const data = Buffer.from(await (await this.syncStore()).exportRevision(revision)).toString('base64');
          z.object({ ok: z.literal(true) }).strict().parse(await this.contact(id, endpoints, { op: 'put', revision, data }));
        }
        if (Object.hasOwn(this.state.peers, id)) {
          this.connections.set(id, { lastSync: Date.now() });
          const found = this.discovered.get(id);
          if (found && JSON.stringify(found) !== JSON.stringify(peer.endpoints)) this.state = await this.store.mutate(state => { if (state.peers[id]) state.peers[id]!.endpoints = found; });
        }
      } catch { if (Object.hasOwn(this.state.peers, id)) this.connections.set(id, { lastSync: this.connections.get(id)?.lastSync, error: '接続待ち' }); }
    }
  }
  status() {
    this.prune();
    return { name: this.name, id: this.id, port: this.port, addresses: this.addresses(), discoveryError: this.discoveryError,
      peers: Object.entries(this.state.peers).map(([id, peer]) => ({ id, name: peer.name, ...this.connections.get(id) })),
      pending: [...this.pending.values()].map(({ endpoints: _endpoints, peer, ...item }) => ({ ...item, peer })),
      invitationExpires: this.invitation?.expires };
  }
  async close() {
    this.closed = true; this.abort.abort(); this.invitation = undefined; this.pending.clear();
    await this.discovery?.close(); this.discovery = undefined;
    await this.listener?.close(); await this.tail; await this.syncing;
  }
}
