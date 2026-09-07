import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { HubError } from './errors.js';

export const jsonResult = (value: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
type Saved = { result: CallToolResult; text: string; bytes: number; owner?: string; expires: number };

/** Session-only bounded storage. All snapshots are data, never an instruction channel. */
export class ResultStore {
  private entries = new Map<string, Saved>();
  private bytes = 0;
  constructor(private readonly now: () => number = Date.now) {}
  private delete(id: string) { const entry = this.entries.get(id); if (entry) this.bytes -= entry.bytes; this.entries.delete(id); }
  private prune() { for (const [id, entry] of this.entries) if (entry.expires <= this.now()) this.delete(id); }
  forget(owner?: string) { for (const [id, entry] of this.entries) if (!owner || entry.owner === owner) this.delete(id); }
  stats() { this.prune(); return { savedResults: this.entries.size, savedBytes: this.bytes }; }

  deliver(result: CallToolResult, maxChars: number, owner?: string): CallToolResult {
    const text = JSON.stringify(result);
    if (text.length <= maxChars) return result;
    this.prune();
    const bytes = Buffer.byteLength(text);
    if (bytes > 16 * 1024 * 1024) return { isError: true, content: [{ type: 'text', text: 'Response exceeded the 16 MiB result cache limit. The operation may have completed; do not retry writes automatically.' }] };
    while (this.entries.size >= 32 || this.bytes + bytes > 16 * 1024 * 1024) this.delete(this.entries.keys().next().value!);
    const resultId = randomUUID();
    this.entries.set(resultId, { result: structuredClone(result), text, bytes, owner, expires: this.now() + 600_000 });
    this.bytes += bytes;
    const first = result.content.find(block => block.type === 'text');
    const preview = first?.type === 'text' ? first.text.slice(0, Math.min(400, Math.floor(maxChars / 8))) : '[media/structured result]';
    return { ...jsonResult({ resultId, chars: text.length, preview, truncated: true,
      read: { action: 'result', options: { resultId } } }), ...(result.isError ? { isError: true } : {}) };
  }

  read(id: string, options: { offset?: number; pointer?: string; native?: boolean }, maxChars: number): CallToolResult {
    this.prune();
    const entry = this.entries.get(id);
    if (!entry) throw new HubError('Result expired, was forgotten, or belongs to another session. Do not repeat writes to recover it.');
    if (options.native) return structuredClone(entry.result);
    let value: unknown = entry.result;
    if (options.pointer !== undefined) {
      if (options.pointer !== '' && !options.pointer.startsWith('/')) throw new HubError('pointer must be a JSON Pointer, e.g. /content/0/text.');
      for (const part of options.pointer === '' ? [] : options.pointer.slice(1).split('/')) {
        const key = part.replace(/~1/g, '/').replace(/~0/g, '~');
        if (!value || typeof value !== 'object' || !Object.hasOwn(value, key)) throw new HubError('JSON Pointer not found in this result.');
        value = (value as Record<string, unknown>)[key];
      }
    }
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    let offset = options.offset ?? 0;
    if (offset > text.length) throw new HubError('Result offset is outside this content.');
    if (offset > 0 && /[\uDC00-\uDFFF]/.test(text.charAt(offset))) offset--;
    let end = Math.min(text.length, offset + maxChars - 400);
    while (true) {
      if (/[\uD800-\uDBFF]/.test(text.charAt(end - 1))) end--;
      const page = jsonResult({ resultId: id, pointer: options.pointer, offset, content: text.slice(offset, end),
        ...(end < text.length ? { nextOffset: end } : {}) });
      if (JSON.stringify(page).length <= maxChars) return page;
      if (end <= offset + 1) throw new HubError('Selection metadata exceeds this context budget. Use a shorter pointer or larger budget.');
      end = offset + Math.max(1, Math.floor((end - offset) * 0.7));
    }
  }
}
