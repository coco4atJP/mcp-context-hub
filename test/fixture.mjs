import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export function fixtureServer() {
  const server = new Server({ name: 'fixture', version: '1' }, { capabilities: { tools: {} } });
  const tools = ['echo', 'image', 'failure', 'slow', 'crash'].map(name => ({
    name, description: `Fixture ${name}`, inputSchema: { type: 'object', properties: { message: { type: 'string', description: 'SCHEMA_ONLY_MARKER' }, delay: { type: 'number' } } },
    annotations: { readOnlyHint: name !== 'crash' },
  }));
  server.setRequestHandler(ListToolsRequestSchema, async ({ params }) => {
    const offset = Number(params?.cursor ?? 0);
    return { tools: tools.slice(offset, offset + 2), ...(offset + 2 < tools.length ? { nextCursor: String(offset + 2) } : {}) };
  });
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    if (params.name === 'slow') await new Promise(resolve => setTimeout(resolve, params.arguments?.delay ?? 250));
    if (params.name === 'crash') process.exit(1);
    if (params.name === 'image') return { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }], structuredContent: { preserved: true } };
    if (params.name === 'failure') return { isError: true, content: [{ type: 'text', text: 'business failure' }] };
    return { content: [{ type: 'text', text: JSON.stringify({ message: params.arguments?.message, pid: process.pid, inherited: process.env.HUB_TEST_INHERIT, secret: process.env.HUB_TEST_SECRET }) }] };
  });
  return server;
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.env.HUB_TEST_LOG) appendFileSync(process.env.HUB_TEST_LOG, `${process.pid}\n`);
  const server = fixtureServer();
  process.stdin.once('end', () => { void server.close(); });
  await server.connect(new StdioServerTransport());
}
