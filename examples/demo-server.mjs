// Offline example: node examples/demo-server.mjs
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'hub-demo', version: '1.0.0' });
server.registerTool('echo', {
  description: 'Return the supplied message. No external side effects.',
  inputSchema: { message: z.string() },
  annotations: { readOnlyHint: true, openWorldHint: false },
}, async ({ message }) => ({ content: [{ type: 'text', text: message }] }));
process.stdin.once('end', () => { void server.close(); });
await server.connect(new StdioServerTransport());
