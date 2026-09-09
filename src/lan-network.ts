import { networkInterfaces } from 'node:os';
import ipaddr from 'ipaddr.js';
import { z } from 'zod';
import { HubError } from './errors.js';

export const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const secretSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const endpointSchema = z.object({ address: z.ipv4(), port: z.number().int().min(1).max(65535) }).strict();
export type Endpoint = z.infer<typeof endpointSchema>;
export type LanInterface = { address: string; netmask: string };

function privateV4(address: string): boolean {
  if (!z.ipv4().safeParse(address).success) return false;
  return ['private', 'linkLocal'].includes(ipaddr.IPv4.parse(address).range());
}

export function lanInterfaces(): LanInterface[] {
  return Object.entries(networkInterfaces()).flatMap(([name, values]) =>
    /^(utun|tun|tap|wg|tailscale|docker|veth|br-)/i.test(name) ? [] : (values ?? [])
      .filter(value => value.family === 'IPv4' && !value.internal && privateV4(value.address))
      .map(({ address, netmask }) => ({ address, netmask })));
}

/** No DNS resolution, routed RFC1918 ranges, loopback, public internet or IPv6 fallback. */
export function onLan(address: string, interfaces = lanInterfaces()): boolean {
  if (!privateV4(address)) return false;
  const bytes = ipaddr.IPv4.parse(address).toByteArray();
  return interfaces.some(local => {
    if (!privateV4(local.address) || !ipaddr.IPv4.isValid(local.netmask)) return false;
    const own = ipaddr.IPv4.parse(local.address).toByteArray();
    const mask = ipaddr.IPv4.parse(local.netmask).toByteArray();
    const bits = mask.map(byte => byte.toString(2).padStart(8, '0')).join('');
    if (!/^1{8,30}0+$/.test(bits)) return false;
    if (bytes.every((byte, i) => (byte & ~mask[i]!) === 0) || bytes.every((byte, i) => (byte | mask[i]!) === 255)) return false;
    return bytes.every((byte, i) => (byte & mask[i]!) === (own[i]! & mask[i]!));
  });
}

export const invitationSchema = z.object({
  v: z.literal(1), a: z.array(z.ipv4()).min(1).max(8), p: z.number().int().min(1).max(65535),
  k: fingerprintSchema, t: secretSchema, e: z.number().int().positive(),
}).strict();
export type Invitation = z.infer<typeof invitationSchema>;
export function invitationUrl(value: Invitation): string {
  return 'mcp-context-hub://pair#' + Buffer.from(JSON.stringify(invitationSchema.parse(value))).toString('base64url');
}
export function parseInvitation(value: string): Invitation {
  try {
    if (!/^mcp-context-hub:\/\/pair#[A-Za-z0-9_-]{1,1800}$/.test(value)) throw new Error();
    const parsed = invitationSchema.parse(JSON.parse(Buffer.from(value.split('#')[1]!, 'base64url').toString('utf8')));
    if (parsed.e < Date.now() || parsed.e > Date.now() + 6 * 60000) throw new Error();
    return parsed;
  } catch { throw new HubError('招待URLが無効か期限切れです。相手の端末で作り直してください。'); }
}
