import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { idSchema } from './config.js';
import { HubError } from './errors.js';

const shared = {
  description: z.string().max(500).optional(), tags: z.array(z.string().max(80)).max(30).optional(),
  enabled: z.boolean().default(true), allowedTools: z.array(z.string().max(200)).max(200).optional(),
  skills: z.array(idSchema).max(30).optional(),
  skillPaths: z.record(idSchema, z.string().max(4000).refine(isAbsolute)).refine(value => Object.keys(value).length <= 30).optional(),
};
export const registrationSchema = z.union([
  z.object({ ...shared, template: idSchema }).strict(),
  z.object({ ...shared, url: z.url().max(2000), headers: z.record(z.string().max(200), z.string().max(8000)).optional() }).strict(),
  z.object({ ...shared, command: z.string().min(1).max(2000), args: z.array(z.string().max(8000)).max(100).default([]),
    cwd: z.string().max(4000).refine(isAbsolute).optional(), env: z.record(z.string().max(200), z.string().max(8000)).default({}),
    inheritEnv: z.array(z.string().max(200)).max(100).default([]) }).strict(),
]);
export type Registration = z.infer<typeof registrationSchema>;
const documentSchema = z.object({ version: z.literal(1), servers: z.record(idSchema, registrationSchema) }).strict();
type Document = z.infer<typeof documentSchema>;

/** Separate from owner policy. Atomic file replacement + exclusive writer lock across Hub processes. */
export class Registry {
  private memory: Document = { version: 1, servers: {} };
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly path?: string) {}

  async read(): Promise<Document> {
    if (!this.path) return structuredClone(this.memory);
    try {
      const info = await lstat(this.path);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 1_048_576) throw new Error('Invalid registry file');
      return documentSchema.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, servers: {} };
      throw new HubError('Agent registry is invalid or unreadable. Owner config was not modified.');
    }
  }

  mutate(change: (document: Document) => void): Promise<void> {
    const result = this.tail.then(async () => {
      if (!this.path) { const next = await this.read(); change(next); this.memory = documentSchema.parse(next); return; }
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const lockPath = this.path + '.lock';
      let lock;
      const until = Date.now() + 2000;
      while (!lock) {
        try { lock = await open(lockPath, 'wx', 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new HubError('Cannot lock agent registry.');
          if (Date.now() >= until) throw new HubError('Agent registry is busy. Retry later; an abandoned lock needs owner cleanup.');
          await delay(25);
        }
      }
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      try {
        const next = await this.read();
        change(next);
        const data = JSON.stringify(documentSchema.parse(next), null, 2) + '\n';
        if (Buffer.byteLength(data) > 1_048_576) throw new HubError('Agent registry size limit reached.');
        const output = await open(temporary, 'wx', 0o600);
        try { await output.writeFile(data); await output.sync(); } finally { await output.close(); }
        await rename(temporary, this.path);
      } finally {
        await rm(temporary, { force: true });
        await lock.close();
        await rm(lockPath, { force: true });
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
