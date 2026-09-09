import { createHash } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { z } from 'zod';
import { atomicWrite, readText } from './storage.js';
import { startGui } from './gui.js';

const sessionSchema = z.object({ port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type GuiSession = z.infer<typeof sessionSchema>;
export const sessionUrl = (session: GuiSession) => `http://127.0.0.1:${session.port}/#token=${session.token}`;
export const daemonPort = (path: string) => 45000 + createHash('sha256').update(path).digest().readUInt32BE(0) % 15000;

export async function localRequest<T>(session: GuiSession, route: string, body?: unknown): Promise<T> {
  if (!/^\/api\/[a-z]+$/.test(route)) throw new Error('Invalid local route.');
  const result = await fetch(`http://127.0.0.1:${session.port}${route}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${session.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(route === '/api/health' ? 1500 : 40000), redirect: 'error' });
  const value = await result.json() as { error?: string };
  if (!result.ok) throw new Error(value.error ?? 'Local Hub operation failed.');
  return value as T;
}
export async function runningGui(path: string): Promise<GuiSession | undefined> {
  try {
    const session = sessionSchema.parse(JSON.parse(await readText(path + '.gui-session.json', 4096)));
    const health = await localRequest<{ ok: boolean; configPath: string }>(session, '/api/health');
    if (health.ok && health.configPath === path) return session;
  } catch { /* stopped, stale or inaccessible session; never send credentials outside loopback */ }
}

export async function managedGui(path: string, port = daemonPort(path), resident = false) {
  const existing = await runningGui(path);
  if (existing) return { url: sessionUrl(existing), gui: undefined };
  // A deterministic loopback listener is the OS-backed singleton lock, including concurrent launches and crashes.
  let own: GuiSession | undefined;
  const gui = await startGui({ configPath: path, port, resident, onClose: async () => {
    try {
      const current = sessionSchema.parse(JSON.parse(await readText(path + '.gui-session.json', 4096)));
      if (current.token === own?.token) await rm(path + '.gui-session.json', { force: true });
    } catch { /* do not delete a newer or invalid session */ }
  } });
  own = { port: Number(new URL(gui.origin).port), token: gui.token };
  try { await atomicWrite(path + '.gui-session.json', JSON.stringify(own)); }
  catch (error) { await gui.close(); throw error; }
  return { url: gui.url, gui };
}
