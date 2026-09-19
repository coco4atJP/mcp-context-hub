import { z } from 'zod';
import { idSchema } from './config.js';
import { globalActionSchema } from './global-agents.js';
import { registrationSchema } from './registry.js';
import { HubError, type Hub } from './hub.js';
import { jsonResult } from './context.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const actionSchema = z.enum(['help', 'status', 'enable', 'disable', 'start', 'stop', 'add', 'update', 'remove', 'focus', 'context', 'result', 'forget', 'sync', 'security', 'agents']);
type Action = z.infer<typeof actionSchema>;
const empty = z.object({}).strict();
const schemas = {
  help: z.object({ action: actionSchema.optional() }).strict(),
  status: empty, enable: empty, disable: empty, start: empty, stop: empty,
  add: registrationSchema, update: registrationSchema, remove: empty,
  focus: z.object({ servers: z.array(idSchema).max(200) }).strict(),
  context: z.object({ preset: z.enum(['compact', 'balanced', 'full']).optional(),
    maxChars: z.number().int().min(1024).max(20000).optional(), listLimit: z.number().int().min(1).max(20).optional(),
    summaryChars: z.number().int().min(40).max(300).optional() }).strict(),
  result: z.object({ resultId: z.uuid(), offset: z.number().int().min(0).optional(), pointer: z.string().max(1000).optional(), native: z.boolean().optional() }).strict(),
  forget: empty,
  security: empty, agents: globalActionSchema,
  sync: z.object({ operation: z.enum(['status', 'pull', 'publish', 'remove', 'inspect', 'approve', 'resolve']).default('status'),
    revision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(20).optional() }).strict(),
};
const purposes: Record<Action, string> = {
  help: 'Get operation schemas and add policy without starting servers.', status: 'Read server state.',
  enable: 'Permit lazy use.', disable: 'Block reads/calls, cancel requests, stop connection and forget cached results.',
  start: 'Connect now.', stop: 'Disconnect; next use may restart.',
  add: 'Register an endpoint, template or permitted local command; help includes current owner grants. Requires server ID. Does not start it.',
  update: 'Replace an agent registration with a complete definition. Same permissions as add; disconnects the previous process.',
  remove: 'Remove agent registration globally, or hide owner-defined server for this session. Requires server ID.',
  focus: 'Enable only the selected server IDs and disable the rest. Empty list disables all.',
  context: 'Inspect/change output budgets for this session. Character counts, not exact tokens. Cannot erase conversation history.',
  result: 'Read cached output pages or a JSON Pointer without repeating the operation. native=true explicitly returns the full original result, bypassing the character budget.',
  forget: 'Drop cached results for server, or all results if server is omitted. Does not erase conversation history.',
  sync: 'Read/pull shared-folder revisions without startup. publish/remove requires server and owner permission to share. inspect/approve/resolve use an exact revision; agent approvals require owner grants. No credentials, paths or ON/OFF state are shared.',
  agents: 'Sync owner-selected ~/.agents skills/settings. status is compact; inspect lists files, then file reads one body. publish/apply/resolve/remove require explicit grants. No process startup.',
  security: 'Read local security switches. Owner changes via GUI/CLI apply on the next request.',
};

export async function control(hub: Hub, action: Action, server: string | undefined, input: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const parsed = schemas[action].safeParse(input);
  if (!parsed.success) throw new HubError(`Invalid ${action} options. Use hub_control help with options.action=${action}.`);
  const data = parsed.data as Record<string, unknown>;
  if (['help', 'focus', 'context', 'result', 'security', 'agents'].includes(action) && server !== undefined) throw new HubError(`${action} does not take server.`);
  if (action === 'help') {
    const requested = data.action as Action | undefined;
    return jsonResult(requested ? { action: requested, purpose: purposes[requested], optionsSchema: z.toJSONSchema(schemas[requested]),
      ...(['add', 'update'].includes(requested) ? { policy: hub.registrationPolicy() } : {}) } : { actions: purposes });
  }
  if (action === 'agents') return jsonResult(await hub.globalControl(data));
  if (action === 'security') return jsonResult(hub.securityPolicy());
  if (action === 'sync') {
    if (['status', 'pull'].includes(data.operation as string) && server) throw new HubError('Sync status/pull does not take server.');
    return jsonResult(await hub.syncControl(data.operation as 'status' | 'pull' | 'publish' | 'remove' | 'inspect' | 'approve' | 'resolve', server, data.offset as number, data.limit as number | undefined, false, data.revision as string | undefined));
  }
  if (action === 'context') {
    const preset = data.preset;
    const presets = { compact: { maxChars: 2400, listLimit: 3, summaryChars: 100 }, balanced: { maxChars: 6000, listLimit: 5, summaryChars: 160 }, full: { maxChars: 12000, listLimit: 10, summaryChars: 240 } };
    if (preset) Object.assign(hub.context, presets[preset as keyof typeof presets]);
    for (const key of ['maxChars', 'listLimit', 'summaryChars'] as const) if (data[key] !== undefined) hub.context[key] = data[key] as number;
    return jsonResult({ ...hub.context, ...hub.results.stats() });
  }
  if (action === 'focus') return jsonResult(await hub.focus(data.servers as string[]));
  if (action === 'forget') { hub.results.forget(server); return jsonResult(hub.results.stats()); }
  if (action === 'result') return hub.results.read(data.resultId as string, data, hub.context.maxChars);
  if (!server) throw new HubError(`${action} requires server.`);
  if (action === 'add' || action === 'update') return jsonResult(await hub.add(server, data, action === 'update'));
  if (action === 'remove') return jsonResult(await hub.remove(server));
  return jsonResult(await hub.control(server, action, signal));
}
