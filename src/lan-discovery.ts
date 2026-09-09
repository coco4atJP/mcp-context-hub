import mdns from 'multicast-dns';
import type { Packet, Answer } from 'dns-packet';
import { endpointSchema, type Endpoint } from './lan-network.js';

const serviceType = '_mcpctx._tcp.local';
const host = (id: string) => `hub-${id.slice(0, 40)}.local`;
const instance = (id: string) => `hub-${id.slice(0, 40)}.${serviceType}`;

export function announcement(id: string, port: number, addresses: string[]): { answers: Answer[] } {
  return { answers: [
    { type: 'PTR', name: serviceType, ttl: 120, data: instance(id) },
    { type: 'SRV', name: instance(id), ttl: 120, data: { port, target: host(id), priority: 0, weight: 0 } },
    { type: 'TXT', name: instance(id), ttl: 120, data: [Buffer.from('v=1'), Buffer.from('id=' + id)] },
    ...addresses.slice(0, 8).map(address => ({ type: 'A' as const, name: host(id), ttl: 120, data: address })),
  ] };
}

/** Parse only complete advertisements for already-paired identities; no cache of arbitrary LAN services. */
export function advertisedEndpoints(packet: Packet, id: string, allowed: (address: string) => boolean): Endpoint[] {
  const all = [...(packet.answers ?? []), ...(packet.additionals ?? [])];
  if (all.length > 32) return [];
  const records = all.filter(record => 'ttl' in record && (record.ttl ?? 0) > 0);
  const sameName = (record: Answer, name: string) => record.name?.toLowerCase() === name;
  const txt = records.find(record => record.type === 'TXT' && sameName(record, instance(id)));
  if (!txt || txt.type !== 'TXT' || !Array.isArray(txt.data) || txt.data.length > 8) return [];
  const values = txt.data.map(value => Buffer.isBuffer(value) && value.length <= 255 ? value.toString('utf8') : '');
  if (!values.includes('v=1') || !values.includes('id=' + id)) return [];
  const srv = records.find(record => record.type === 'SRV' && sameName(record, instance(id)));
  if (!srv || srv.type !== 'SRV' || srv.data.target?.toLowerCase() !== host(id)) return [];
  return records.flatMap(record => {
    if (record.type !== 'A' || !sameName(record, host(id)) || !allowed(record.data)) return [];
    const parsed = endpointSchema.safeParse({ address: record.data, port: srv.data.port });
    return parsed.success ? [parsed.data] : [];
  }).slice(0, 8);
}

export class LanDiscovery {
  private readonly socket: mdns.MulticastDNS;
  private lastReply = 0;
  private closed = false;
  constructor(private readonly id: string, private readonly port: number, private readonly addresses: () => string[],
    private readonly allowed: (address: string) => boolean, private readonly peers: () => string[],
    private readonly found: (id: string, endpoints: Endpoint[]) => void, error: () => void) {
    this.socket = mdns({ reuseAddr: true, loopback: true });
    this.socket.on('error', error); this.socket.on('warning', () => {});
    this.socket.on('query', (packet, source) => {
      if (this.closed || source.size > 4096 || !this.allowed(source.address) || (packet.questions?.length ?? 0) > 25 || Date.now() - this.lastReply < 1000) return;
      if (packet.questions?.some(question => [serviceType, instance(this.id), host(this.id)].includes(question.name?.toLowerCase()))) {
        this.lastReply = Date.now(); this.socket.respond(announcement(this.id, this.port, this.addresses()), err => { if (err && !this.closed) error(); });
      }
    });
    this.socket.on('response', (packet, source) => {
      if (this.closed || source.size > 4096 || !this.allowed(source.address)) return;
      try {
        for (const id of this.peers().slice(0, 20)) {
          const endpoints = advertisedEndpoints(packet, id, this.allowed);
          if (endpoints.length) this.found(id, endpoints);
        }
      } catch { /* Malformed discovery data never becomes an authenticated connection. */ }
    });
    this.socket.on('ready', () => this.update());
  }
  update() {
    if (this.closed) return;
    const questions = this.peers().slice(0, 20).map(id => ({ name: instance(id), type: 'SRV' as const }));
    if (questions.length) this.socket.query({ questions });
  }
  async close() {
    this.closed = true;
    await new Promise<void>(resolve => this.socket.destroy(() => resolve()));
  }
}
