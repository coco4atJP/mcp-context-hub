import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HubError } from './errors.js';

/** Bounded reads on a regular descriptor. Paths inside an untrusted tree need directory checks too. */
export async function readText(path: string, maxBytes: number): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new HubError('Expected a bounded regular file.');
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > maxBytes) throw new HubError('Expected a bounded regular file.');
    const buffer = Buffer.alloc(opened.size + 1);
    let count = 0;
    while (count < buffer.length) {
      const read = await handle.read(buffer, count, buffer.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    if (count > maxBytes) throw new HubError('File size limit exceeded.');
    if (count === buffer.length) throw new HubError('File changed while reading; retry after the writer finishes.');
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, count));
  } finally { await handle.close(); }
}

export async function directory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new HubError('Expected a directory, not a symlink.');
}

export async function atomicWrite(path: string, text: string): Promise<void> {
  const temporary = path + '.' + randomUUID() + '.tmp';
  const handle = await open(temporary, 'wx', 0o600);
  try {
    try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}

/** Local device files only. Do not use this lock on a cloud-synced directory. */
export class LocalStore<T> {
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string, private readonly parse: (input: unknown) => T,
    private readonly initial: () => T, private readonly maxBytes = 8 * 1024 * 1024) {}

  async read(): Promise<T> {
    try { return this.parse(JSON.parse(await readText(this.path, this.maxBytes))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.initial();
      throw new HubError('Local state is invalid or unreadable.');
    }
  }

  mutate(change: (next: T) => void): Promise<T> {
    const result = this.tail.then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const until = Date.now() + 5000;
      let lock;
      while (!lock) {
        try { lock = await open(this.path + '.lock', 'wx', 0o600); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || Date.now() >= until) throw new HubError('Local state is busy; retry later. Abandoned locks need owner cleanup.');
          await delay(25);
        }
      }
      try {
        const next = await this.read();
        change(next);
        const valid = this.parse(next);
        const text = JSON.stringify(valid, null, 2) + '\n';
        if (Buffer.byteLength(text) > this.maxBytes) throw new HubError('Local state size limit reached.');
        await atomicWrite(this.path, text);
        return valid;
      } finally { await lock.close(); await rm(this.path + '.lock', { force: true }); }
    });
    this.tail = result.catch(() => {});
    return result;
  }
}
