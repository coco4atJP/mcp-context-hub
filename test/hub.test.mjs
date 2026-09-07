import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer as httpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Hub } from '../dist/hub.js';
import { configSchema, initConfig, loadConfig, expandEnv } from '../dist/config.js';
import { fixtureServer } from './fixture.mjs';

const exec = promisify(execFile);
const fixture = resolve('test/fixture.mjs');
async function setup(t, overrides = {}, top = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'mcp-hub-test-'));
  const log = join(dir, 'starts');
  const config = configSchema.parse({ version: 1, timeoutMs: 3000, ...top, servers: {
    demo: { transport: 'stdio', command: process.execPath, args: [fixture], env: { HUB_TEST_LOG: log }, description: 'Local echo テスト', tags: ['offline'], ...overrides },
  } });
  const hub = new Hub(config);
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  const starts = async () => { try { return (await readFile(log, 'utf8')).trim().split('\n'); } catch { return []; } };
  return { hub, dir, config, starts };
}

test('catalog is lazy; summaries omit schema; exact discovery follows downstream pagination', async t => {
  const { hub, starts } = await setup(t);
  assert.equal((await hub.catalog('offline テスト')).total, 1);
  assert.equal((await hub.catalog('missing')).total, 0);
  assert.equal((await starts()).length, 0);
  const summaries = await hub.tools('demo', { limit: 2 });
  assert.equal(summaries.total, 5);
  assert.equal(summaries.nextOffset, 2);
  assert.ok(!JSON.stringify(summaries).includes('SCHEMA_ONLY_MARKER'));
  const schema = await hub.tools('demo', { tool: 'slow' });
  assert.ok(JSON.stringify(schema).includes('SCHEMA_ONLY_MARKER'));
  assert.equal((await starts()).length, 1);
});

test('OFF blocks discovery and calls; enable is lazy; stop permits restart', async t => {
  const { hub, starts } = await setup(t, { enabled: false });
  await assert.rejects(hub.tools('demo'), /OFF/);
  await assert.rejects(hub.call('demo', 'echo', {}), /OFF/);
  assert.equal((await starts()).length, 0);
  await hub.control('demo', 'enable');
  assert.equal((await starts()).length, 0);
  await hub.call('demo', 'echo', { message: 'first' });
  await hub.control('demo', 'disable');
  assert.equal((await hub.control('demo', 'status')).state, 'stopped');
  await assert.rejects(hub.call('demo', 'echo', {}), /OFF/);
  await hub.control('demo', 'enable');
  await hub.control('demo', 'start');
  await hub.control('demo', 'stop');
  await hub.call('demo', 'echo', {});
  assert.equal((await starts()).length, 3);
});

test('locked OFF and allowlist cannot be bypassed by direct tool calls', async t => {
  const { hub, starts } = await setup(t, { enabled: false, allowAgentEnable: false, allowedTools: ['echo'] });
  await assert.rejects(hub.control('demo', 'enable'), /forbidden/);
  await assert.rejects(hub.call('demo', 'image', {}), /not allowed/);
  assert.equal((await starts()).length, 0);
});

test('allowlist filters discovery and excludes schema access', async t => {
  const { hub } = await setup(t, { allowedTools: ['echo'] });
  assert.equal((await hub.tools('demo')).total, 1);
  await assert.rejects(hub.tools('demo', { tool: 'image' }), /not allowed/);
});

test('concurrent first uses share a single child; preserve native content and errors', async t => {
  const { hub, starts } = await setup(t);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => hub.call('demo', 'echo', { message: String(i) })));
  assert.equal((await starts()).length, 1);
  assert.deepEqual(results.map(result => JSON.parse(result.content[0].text).message), ['0', '1', '2', '3', '4', '5']);
  assert.equal((await hub.call('demo', 'image', {})).content[0].type, 'image');
  assert.deepEqual((await hub.call('demo', 'image', {})).structuredContent, { preserved: true });
  assert.equal((await hub.call('demo', 'failure', {})).isError, true);
});

test('idle timeout waits for in-flight operation, stops child, then lazily restarts', async t => {
  const { hub, starts } = await setup(t, { idleTimeoutMs: 100 });
  await hub.call('demo', 'slow', { delay: 200 });
  assert.equal((await hub.control('demo', 'status')).state, 'running');
  for (let i = 0; i < 60; i++) {
    if ((await hub.control('demo', 'status')).state === 'stopped') break;
    await delay(50);
  }
  assert.equal((await hub.control('demo', 'status')).state, 'stopped');
  const [pid] = await starts();
  assert.throws(() => process.kill(Number(pid), 0), /ESRCH/);
  await hub.call('demo', 'echo', {});
  assert.equal((await starts()).length, 2);
});

test('timeout releases queue without automatically repeating an operation', async t => {
  const { hub, starts } = await setup(t, { timeoutMs: 700 });
  await hub.control('demo', 'start');
  await assert.rejects(hub.call('demo', 'slow', { delay: 1200 }), /timed out.*do not automatically retry/);
  await hub.call('demo', 'echo', {});
  assert.equal((await starts()).length, 1);
});

test('upstream cancellation releases the queue', async t => {
  const { hub } = await setup(t);
  await hub.control('demo', 'start');
  const abort = new AbortController();
  const pending = hub.call('demo', 'slow', { delay: 1000 }, abort.signal);
  setTimeout(() => abort.abort(), 40);
  await assert.rejects(pending, /cancelled/);
  await hub.control('demo', 'disable');
  assert.equal((await hub.control('demo', 'status')).enabled, false);
});

test('environment secrets are opt-in; missing references fail only when needed', async t => {
  process.env.HUB_TEST_SECRET = 'not-inherited';
  process.env.HUB_TEST_INHERIT = 'explicit';
  t.after(() => { delete process.env.HUB_TEST_SECRET; delete process.env.HUB_TEST_INHERIT; });
  const { hub } = await setup(t, { inheritEnv: ['HUB_TEST_INHERIT'] });
  const value = JSON.parse((await hub.call('demo', 'echo', {})).content[0].text);
  assert.equal(value.secret, undefined);
  assert.equal(value.inherited, 'explicit');
  assert.equal(expandEnv('${HUB_TEST_SECRET}'), 'not-inherited');
  const missing = await setup(t, { env: { TOKEN: '${HUB_TEST_NOT_DEFINED}' } });
  assert.equal((await missing.hub.catalog()).total, 1);
  await assert.rejects(missing.hub.tools('demo'), /connection or request failed/);
  assert.equal((await missing.hub.control('demo', 'status')).state, 'stopped');
});

test('failed start and crashed child leave lifecycle recoverable', async t => {
  const broken = await setup(t, { command: '/definitely-missing-hub-test-executable' });
  await assert.rejects(broken.hub.tools('demo'), /connection or request failed/);
  assert.equal((await broken.hub.control('demo', 'status')).state, 'stopped');
  const { hub, starts } = await setup(t);
  await assert.rejects(hub.call('demo', 'crash', {}), /connection or request failed/);
  await hub.call('demo', 'echo', {});
  assert.equal((await starts()).length, 2);
});

test('global config validation, init refuses overwrite, check never starts servers', async t => {
  const { dir, config, starts } = await setup(t);
  const path = join(dir, 'config.json');
  await initConfig(path);
  await assert.rejects(initConfig(path), /EEXIST/);
  assert.deepEqual((await loadConfig(path)).servers, {});
  await writeFile(path, JSON.stringify(config));
  const check = await exec(process.execPath, ['dist/cli.js', 'check', '--config', path]);
  assert.match(check.stdout, /1 servers/);
  assert.equal((await starts()).length, 0);
  assert.throws(() => configSchema.parse({ ...config, servers: { bad: { transport: 'stdio', command: 'node', cwd: './relative' } } }));
  assert.throws(() => configSchema.parse({ ...config, typo: true }));
});

test('full stdio gateway advertises exactly five tools before and after downstream use', async t => {
  const { dir, config, starts } = await setup(t);
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config));
  const client = new Client({ name: 'integration-test', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), '--config', path], stderr: 'pipe' });
  t.after(async () => { await client.close(); });
  await client.connect(transport);
  const before = await client.listTools();
  assert.deepEqual(before.tools.map(tool => tool.name), ['hub_catalog', 'hub_skill', 'hub_tools', 'hub_call', 'hub_control']);
  assert.equal((await starts()).length, 0);
  const result = await client.callTool({ name: 'hub_tools', arguments: { server: 'demo', tool: 'echo' } });
  assert.match(result.content[0].text, /SCHEMA_ONLY_MARKER/);
  assert.deepEqual(await client.listTools(), before);
  const echo = await client.callTool({ name: 'hub_call', arguments: { server: 'demo', tool: 'echo', arguments: { message: 'through hub' } } });
  assert.equal(JSON.parse(echo.content[0].text).message, 'through hub');
  const unknown = await client.callTool({ name: 'hub_call', arguments: { server: 'absent', tool: 'echo' } });
  assert.equal(unknown.isError, true);
  await client.close();
  for (let i = 0; i < 40; i++) {
    try { process.kill(Number((await starts())[0]), 0); } catch { return; }
    await delay(50);
  }
  assert.fail('downstream process survived gateway shutdown');
});

test('Streamable HTTP uses configured auth, connects lazily, and does not stop remote service', async t => {
  let requests = 0;
  let deletes = 0;
  const server = fixtureServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID });
  await server.connect(transport);
  const http = httpServer(async (req, res) => {
    requests++;
    if (req.method === 'DELETE') deletes++;
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401).end(); return; }
    await transport.handleRequest(req, res);
  });
  await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  const config = configSchema.parse({ version: 1, servers: { remote: {
    transport: 'http', url: `http://127.0.0.1:${http.address().port}/mcp`, headers: { Authorization: 'Bearer fixture-token' },
  } } });
  const hub = new Hub(config);
  t.after(async () => { await hub.close(); await server.close(); http.closeAllConnections(); await new Promise(resolve => http.close(resolve)); });
  assert.equal((await hub.catalog()).total, 1);
  assert.equal(requests, 0);
  assert.equal((await hub.tools('remote')).total, 5);
  assert.equal(JSON.parse((await hub.call('remote', 'echo', { message: 'http' })).content[0].text).message, 'http');
  await hub.control('remote', 'stop');
  assert.equal(http.listening, true);
  assert.equal(deletes, 1);
});

test('shutdown cancels in-flight work and reaps the child without waiting for request timeout', async t => {
  const { hub, starts } = await setup(t, { timeoutMs: 60_000 });
  await hub.control('demo', 'start');
  const pending = hub.call('demo', 'slow', { delay: 30_000 });
  const rejected = assert.rejects(pending, /cancelled/);
  await delay(30);
  const start = Date.now();
  await hub.close();
  await rejected;
  assert.ok(Date.now() - start < 5000);
  const [pid] = await starts();
  for (let i = 0; i < 30; i++) {
    try { process.kill(Number(pid), 0); } catch { return; }
    await delay(20);
  }
  assert.fail('child survived shutdown');
});
