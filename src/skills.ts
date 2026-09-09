import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, realpath, stat, writeFile, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parseDocument } from 'yaml';
import { HubError } from './errors.js';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FRONTMATTER_CHARS = 16 * 1024;
export type SkillSummary = { skill: string; description: string; available: boolean };

/** User-registered local packages; metadata and content never become top-level MCP tools. */
export class SkillStore {
  constructor(private readonly paths: Record<string, string>) {}

  private async file(id: string, file: string) {
    const configured = Object.hasOwn(this.paths, id) ? this.paths[id] : undefined;
    if (!configured) throw new HubError(`Unknown skill: ${id}.`);
    if (!file || isAbsolute(file) || /[\\\0]/.test(file) || file.split('/').includes('..')) {
      throw new HubError('Skill file must be a relative path inside its registered directory.');
    }
    try {
      const root = await realpath(configured);
      const path = await realpath(resolve(root, file));
      const child = relative(root, path);
      if (child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) {
        throw new HubError('Skill file resolves outside its registered directory.');
      }
      // Reject special files before opening, then use a bounded read on the opened descriptor.
      if (!(await stat(path)).isFile()) throw new HubError('Skill resource must be a regular text file.');
      const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const info = await handle.stat();
        if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new HubError('Skill file must be a text file of at most 256 KiB.');
        const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
        let count = 0;
        while (count < bytes.length) {
          const result = await handle.read(bytes, count, bytes.length - count, count);
          if (!result.bytesRead) break;
          count += result.bytesRead;
        }
        if (count > MAX_FILE_BYTES) throw new HubError('Skill file exceeds 256 KiB. Split it into referenced files.');
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, count));
        if (text.includes('\0')) throw new HubError('Binary skill resources cannot be returned as instructions.');
        return { root, text };
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof HubError) throw error;
      throw new HubError(`Cannot read skill ${id}. Check its configured path and UTF-8 files.`);
    }
  }

  static parse(id: string, text: string) {
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
    if (!match || match[1]!.length > MAX_FRONTMATTER_CHARS) throw new HubError(`Skill ${id} needs YAML frontmatter (name and description, at most 16 KiB).`);
    try {
      const document = parseDocument(match[1]!, { uniqueKeys: true });
      if (document.errors.length || document.warnings.length) throw new Error('Invalid YAML');
      const data: unknown = document.toJS({ maxAliasCount: 0 });
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Expected mapping');
      const { name, description } = data as Record<string, unknown>;
      if (typeof name !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || name.length > 64 ||
          typeof description !== 'string' || !description.trim() || description.length > 1024) throw new Error('Invalid metadata');
      return { name, description: description.trim(), body: text.slice(match[0].length).trim() };
    } catch {
      throw new HubError(`Skill ${id} has invalid name/description or YAML frontmatter.`);
    }
  }

  async summary(id: string): Promise<SkillSummary> {
    try {
      const { text } = await this.file(id, 'SKILL.md');
      const { description } = SkillStore.parse(id, text);
      return { skill: id, description, available: true };
    } catch {
      // A broken optional skill must not hide an otherwise usable MCP server.
      return { skill: id, description: '', available: false };
    }
  }

  async read(id: string, options: { file?: string; offset?: number; ifRevision?: string } = {}) {
    const file = options.file ?? 'SKILL.md';
    const { root, text } = await this.file(id, file);
    const content = file === 'SKILL.md' ? SkillStore.parse(id, text).body : text;
    const revision = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const pointer = { skill: id, file, revision };
    if (options.ifRevision === revision) return { ...pointer, unchanged: true };
    let offset = options.offset ?? 0;
    if (!Number.isInteger(offset) || offset < 0 || offset > content.length) throw new HubError('Skill offset is outside this file.');
    // Keep UTF-16 pagination from separating an emoji's surrogate pair.
    if (offset > 0 && /[\uDC00-\uDFFF]/.test(content.charAt(offset))) offset--;
    let end = Math.min(content.length, offset + 12_000);
    if (/[\uD800-\uDBFF]/.test(content.charAt(end - 1))) end--;
    return { ...pointer, basePath: root, content: content.slice(offset, end), offset,
      ...(end < content.length ? { nextOffset: end } : {}) };
  }

  async validate(): Promise<void> {
    for (const id of Object.keys(this.paths)) {
      const { root, text } = await this.file(id, 'SKILL.md');
      const { name } = SkillStore.parse(id, text);
      if (name !== basename(root)) throw new HubError(`Skill ${id}: frontmatter name must match its directory name.`);
    }
  }
}

export async function installHubSkill(directory?: string): Promise<string> {
  const root = resolve(directory ?? join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'skills'));
  const target = join(root, 'mcp-context-hub');
  const source = await readFile(new URL('../skills/mcp-context-hub/SKILL.md', import.meta.url), 'utf8');
  await mkdir(target, { recursive: true });
  await writeFile(join(target, 'SKILL.md'), source, { flag: 'wx' });
  return target;
}
