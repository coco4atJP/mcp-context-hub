import { createHash } from 'node:crypto';
import { z } from 'zod';
import { SkillStore } from './skills.js';
import { HubError } from './errors.js';

export const globalPrefix = 'agents-global-';
export const globalId = (target: string) => globalPrefix + createHash('sha256').update(target).digest('hex').slice(0, 32);
export const isGlobalId = (id: string) => id.startsWith(globalPrefix);
export const hashBytes = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const secret = /(?:^|[_. -])(credentials?|secrets?|tokens?|passwords?)(?:\.[^.]+)?$|^id_(?:rsa|ed25519)(?:\.pub)?$|\.(?:pem|key|p12|pfx)$/i;
export function portablePath(path: string): boolean {
  return path.length <= 240 && path.split('/').length <= 10 && path.split('/').every(part =>
    /^[a-zA-Z0-9_][a-zA-Z0-9_. -]*$/.test(part) && !/[. ]$/.test(part) &&
    !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) && !secret.test(part) && part !== 'node_modules');
}
export function globalTarget(target: string): boolean {
  if (!portablePath(target)) return false;
  return target.startsWith('skills/') ? /^skills\/[a-z0-9]+(?:-[a-z0-9]+)*$/.test(target) && target.slice(7).length <= 64
    : /\.(md|txt|json|toml|yaml|yml)$/i.test(target);
}
export const globalFileSchema = z.object({ encoding: z.enum(['utf8', 'base64']), content: z.string().max(360000) }).strict();
export const globalBundleSchema = z.object({ kind: z.literal('agents'), target: z.string().refine(globalTarget),
  files: z.record(z.string(), globalFileSchema).refine(files => Object.keys(files).length > 0 && Object.keys(files).length <= 256),
}).strict();
export type GlobalBundle = z.infer<typeof globalBundleSchema>;
export type GlobalFile = z.infer<typeof globalFileSchema>;
export function decodeFile(file: GlobalFile): Buffer {
  if (file.encoding === 'utf8') return Buffer.from(file.content, 'utf8');
  const bytes = Buffer.from(file.content, 'base64');
  if (bytes.toString('base64') !== file.content) throw new HubError('Invalid base64 global file.');
  return bytes;
}
export function validateGlobalBundle(bundle: GlobalBundle) {
  const names = new Set<string>(); let bytes = 0;
  for (const [file, content] of Object.entries(bundle.files)) {
    if (!portablePath(file) || names.has(file.toLowerCase())) throw new HubError('Invalid or colliding global file path.');
    names.add(file.toLowerCase());
    const decoded = decodeFile(content); bytes += decoded.length;
    if (decoded.length > 256 * 1024 || bytes > 1400 * 1024) throw new HubError('Global package size limit exceeded.');
    if (content.encoding === 'utf8' && content.content.includes('\0')) throw new HubError('Invalid text file.');
  }
  for (const name of names) {
    const parts = name.split('/');
    while (parts.length > 1) { parts.pop(); if (names.has(parts.join('/'))) throw new HubError('Global file/directory conflict.'); }
  }
  if (bundle.target.startsWith('skills/')) {
    const skill = bundle.files['SKILL.md'];
    if (!skill || skill.encoding !== 'utf8' || SkillStore.parse(bundle.target, skill.content).name !== bundle.target.slice(7)) throw new HubError('Skill name must match its global directory.');
  } else if (Object.keys(bundle.files).length !== 1 || !bundle.files['content'] || bundle.files['content'].encoding !== 'utf8') throw new HubError('Global settings require one UTF-8 content file.');
}
