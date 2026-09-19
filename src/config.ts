import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { globalTarget } from './global-format.js';

export const idSchema = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/).refine(value => !['__proto__', 'prototype', 'constructor'].includes(value), 'Reserved ID');
const id = idSchema;
const common = {
  description: z.string().max(500).default(''),
  tags: z.array(z.string().max(80)).max(30).default([]),
  enabled: z.boolean().default(true),
  allowAgentEnable: z.boolean().default(true),
  allowAgentRemove: z.boolean().default(true),
  idleTimeoutMs: z.number().int().min(0).max(86_400_000).optional(),
  timeoutMs: z.number().int().min(100).max(600_000).optional(),
  allowedTools: z.array(z.string()).optional(),
  skills: z.array(id).default([]),
  toolSkills: z.record(z.string(), z.array(id)).default({}),
};
const absolutePath = z.string().refine(isAbsolute, 'Must be an absolute path');
export const securitySchema = z.object({
  allowStdio: z.boolean().default(true),
  allowHttp: z.boolean().default(true),
  allowAgentRegistration: z.boolean().default(true),
  allowAgentStdio: z.boolean().default(false),
  allowAgentCredentials: z.boolean().default(false),
  allowAgentSkills: z.boolean().default(false),
  allowAgentSyncApproval: z.boolean().default(false),
  allowAgentGlobalFiles: z.boolean().default(false),
  allowAgentPublish: z.boolean().default(false),
  requireSyncApproval: z.boolean().default(true),
  requireHttps: z.boolean().default(true),
  blockPrivateHttp: z.boolean().default(true),
  enforceToolAllowlist: z.boolean().default(true),
  inheritProcessEnv: z.boolean().default(false),
}).strict();
export const securityDefaults = securitySchema.parse({});
export const fullAccessSecurity = securitySchema.parse(Object.fromEntries(Object.keys(securityDefaults).map(key => [key, !['requireSyncApproval', 'requireHttps', 'blockPrivateHttp', 'enforceToolAllowlist'].includes(key)])));
export const securityPreset = (security: z.infer<typeof securitySchema>) =>
  Object.keys(securityDefaults).every(key => security[key as keyof typeof security] === fullAccessSecurity[key as keyof typeof security]) ? 'full'
  : Object.keys(securityDefaults).every(key => security[key as keyof typeof security] === securityDefaults[key as keyof typeof security]) ? 'standard' : 'custom';
const stdio = z.object({
  ...common,
  transport: z.literal('stdio'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: absolutePath.optional(),
  env: z.record(z.string(), z.string()).default({}),
  inheritEnv: z.array(z.string()).default([]),
}).strict();
const http = z.object({
  ...common,
  transport: z.literal('http'),
  url: z.url().refine(value => {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Use HTTP(S) without URL credentials'),
  headers: z.record(z.string(), z.string()).default({}),
}).strict();
export const serverSchema = z.discriminatedUnion('transport', [stdio, http]);
export const contextSchema = z.object({
  maxChars: z.number().int().min(1024).max(20000).default(6000),
  listLimit: z.number().int().min(1).max(20).default(5),
  summaryChars: z.number().int().min(40).max(300).default(160),
}).strict();
export const configSchema = z.object({
  version: z.literal(1),
  idleTimeoutMs: z.number().int().min(0).max(86_400_000).default(300_000),
  timeoutMs: z.number().int().min(100).max(600_000).default(60_000),
  skills: z.record(id, absolutePath).default({}),
  context: contextSchema.default({ maxChars: 6000, listLimit: 5, summaryChars: 160 }),
  security: securitySchema.default(securityDefaults),
  sync: z.object({
    mode: z.enum(['folder', 'lan']).default('folder'),
    autoPublish: z.boolean().default(true),
    folder: absolutePath.optional(),
    pollIntervalMs: z.number().int().min(1000).max(3_600_000).default(10000),
    bindings: z.record(id, id).default({}),
  }).strict().default({ mode: 'folder', autoPublish: true, pollIntervalMs: 10000, bindings: {} }),
  globalAgents: z.object({
    enabled: z.boolean().default(false),
    root: absolutePath.optional(),
    skills: z.union([z.literal('all'), z.array(idSchema).max(500)]).default('all'),
    files: z.array(z.string().refine(value => globalTarget(value) && !value.startsWith('skills/'))).max(100).default(['AGENTS.md']),
  }).strict().default({ enabled: false, skills: 'all', files: ['AGENTS.md'] }),
  agent: z.object({
    allowPublicHttp: z.boolean().default(true),
    allowedHttpOrigins: z.array(z.url()).default([]),
    maxServers: z.number().int().min(0).max(100).default(30),
  }).strict().default({ allowPublicHttp: true, allowedHttpOrigins: [], maxServers: 30 }),
  templates: z.record(id, serverSchema).default({}),
  servers: z.record(id, serverSchema),
}).strict().superRefine((config, ctx) => {
  if (new Set(config.globalAgents.files.map(file=>file.toLowerCase())).size !== config.globalAgents.files.length) ctx.addIssue({code:'custom',path:['globalAgents','files'],message:'Global file selections must be unique, ignoring case'});
  for (const server of [...Object.keys(config.servers), ...Object.keys(config.templates)]) {
    if (server.startsWith('agents-global-')) ctx.addIssue({ code: 'custom', path: ['servers', server], message: 'Reserved global sync namespace' });
  }
  for (const [server, value] of [...Object.entries(config.servers), ...Object.entries(config.templates)]) {
    const bindings = [value.skills, ...Object.values(value.toolSkills)].flat();
    for (const skill of new Set(bindings)) {
      if (!Object.hasOwn(config.skills, skill)) {
        ctx.addIssue({ code: 'custom', path: ['servers', server, 'skills'], message: `Unknown skill ID: ${skill}` });
      }
    }
  }
});
export type Config = z.infer<typeof configSchema>;
export type ServerConfig = Config['servers'][string];

export function configPath(explicit?: string): string {
  return resolve(explicit ?? process.env.MCP_HUB_CONFIG ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'mcp-context-hub', 'config.json'));
}

/** OS URL handlers always open this fixed per-user profile, independent of inherited environment. */
export function urlHandlerConfigPath(): string { return join(homedir(), '.config', 'mcp-context-hub', 'config.json'); }

export async function loadConfig(path: string): Promise<Config> {
  let raw: string;
  try { raw = await readFile(path, 'utf8'); }
  catch { throw new Error(`Cannot read config: ${path}. Run mcp-context-hub init first.`); }
  let data: unknown;
  try { data = JSON.parse(raw); }
  catch { throw new Error('Config is not valid JSON.'); }
  const result = configSchema.safeParse(data);
  if (!result.success) {
    throw new Error('Invalid config: ' + result.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '));
  }
  return result.data;
}

export async function initConfig(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(path, JSON.stringify({ version: 1, idleTimeoutMs: 300_000, servers: {} }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
}

/** Only explicit environment references are expanded; never evaluate shell expressions. */
export function expandEnv(value: string): string {
  return value.replace(/\$\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (_match, key: string) => {
    const result = process.env[key];
    if (result === undefined) throw new Error(`Required environment variable is missing: ${key}`);
    return result;
  });
}
