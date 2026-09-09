import { createHash, X509Certificate } from 'node:crypto';
import { connect, createServer, type TLSSocket } from 'node:tls';
import type { Socket } from 'node:net';
import { HubError } from './errors.js';
import type { Endpoint } from './lan-network.js';

const MAX_FRAME = 3 * 1024 * 1024;
export type Identity = { key: string; cert: string };
export const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function certificateId(cert: string | Buffer): string {
  const parsed = new X509Certificate(cert);
  if (Date.parse(parsed.validFrom) > Date.now() || Date.parse(parsed.validTo) < Date.now()) throw new HubError('端末証明書の期限を確認してください。');
  return sha256(parsed.raw);
}
function peerId(socket: TLSSocket): string {
  const cert = socket.getPeerCertificate()?.raw;
  if (!cert) throw new HubError('端末証明書がありません。');
  return certificateId(cert);
}

/** A single bounded frame per TLS connection; no streaming commands or remote execution. */
function readFrame(socket: TLSSocket, max = MAX_FRAME): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let received = 0; let length: number | undefined; const chunks: Buffer[] = [];
    const finish = (error?: Error, value?: unknown) => {
      socket.off('data', data); socket.off('error', failed); socket.off('end', ended); socket.off('close', ended);
      error ? reject(error) : resolve(value);
    };
    const failed = () => finish(new HubError('LAN接続が終了しました。'));
    const ended = () => finish(new HubError('LAN応答が途中で終了しました。'));
    const data = (chunk: Buffer) => {
      received += chunk.length;
      if (received > max + 4) { finish(new HubError('LAN message limit exceeded.')); socket.destroy(); return; }
      chunks.push(chunk);
      if (received < 4) return;
      if (length === undefined) {
        const header = Buffer.concat(chunks, received); length = header.readUInt32BE(0);
        if (!length || length > max) { finish(new HubError('LAN message limit exceeded.')); socket.destroy(); return; }
      }
      if (received < length + 4) return;
      try {
        if (received !== length + 4) throw new Error();
        finish(undefined, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks).subarray(4))));
      } catch { finish(new HubError('Invalid LAN message.')); }
    };
    socket.on('data', data); socket.once('error', failed); socket.once('end', ended); socket.once('close', ended);
  });
}
function frame(value: unknown): Buffer {
  const data = Buffer.from(JSON.stringify(value));
  if (!data.length || data.length > MAX_FRAME) throw new HubError('LAN message limit exceeded.');
  const header = Buffer.alloc(4); header.writeUInt32BE(data.length); return Buffer.concat([header, data]);
}

export async function request(identity: Identity, endpoint: Endpoint, expectedId: string, value: unknown, allowed: (address: string) => boolean, signal?: AbortSignal): Promise<unknown> {
  signal?.throwIfAborted();
  if (!allowed(endpoint.address)) throw new HubError('同じLANの接続先だけを利用できます。');
  const socket = connect({ host: endpoint.address, port: endpoint.port, ...identity, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', rejectUnauthorized: false });
  const deadline = setTimeout(() => socket.destroy(new Error('timeout')), 4000);
  const abort = () => { socket.destroy(new Error('stopped')); }; signal?.addEventListener('abort', abort, { once: true });
  socket.on('error', () => {});
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('secureConnect', resolve); socket.once('error', reject); socket.once('close', () => reject(new HubError('LAN接続を確立できません。')));
    });
    // These are self-signed device identities, not web PKI. Pin before sending ANY application data.
    if (peerId(socket) !== expectedId) throw new HubError('接続先の端末証明書が一致しません。');
    socket.disableRenegotiation();
    const result = readFrame(socket); socket.write(frame(value));
    const response = await result;
    if (response && typeof response === 'object' && 'error' in response) throw new HubError('相手が接続を拒否しました。招待・ペアリング状態を確認してください。');
    return response;
  } finally { clearTimeout(deadline); signal?.removeEventListener('abort', abort); socket.destroy(); }
}

export async function listen(identity: Identity, allowed: (address: string) => boolean,
  paired: (id: string) => boolean, handle: (id: string, value: unknown, address: string) => Promise<unknown>) {
  const sockets = new Set<Socket>();
  const server = createServer({ ...identity, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3', requestCert: true,
    rejectUnauthorized: false, handshakeTimeout: 4000 }, socket => {
    socket.disableRenegotiation();
    void (async () => {
      const id = peerId(socket);
      const input = await readFrame(socket, paired(id) ? MAX_FRAME : 4096);
      socket.end(frame(await handle(id, input, socket.remoteAddress!)));
    })().catch(() => { if (!socket.destroyed) socket.end(frame({ error: 'rejected' })); });
  });
  server.maxConnections = 16;
  server.on('connection', socket => {
    if (!allowed(socket.remoteAddress ?? '')) { socket.destroy(); return; }
    sockets.add(socket); socket.on('error', () => {});
    const deadline = setTimeout(() => socket.destroy(), 12000);
    socket.once('close', () => { clearTimeout(deadline); sockets.delete(socket); });
  });
  server.on('tlsClientError', () => {});
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '0.0.0.0', () => { server.off('error', reject); resolve(); }); });
  server.on('error', () => {});
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Cannot bind LAN.');
  return { port: address.port, close: async () => { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
