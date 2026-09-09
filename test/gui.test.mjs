import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, access, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startGui } from '../dist/gui.js';
import { HubRuntime } from '../dist/runtime.js';
import { GuiAdmin } from '../dist/gui-admin.js';
import { SyncManager } from '../dist/sync.js';
import { configSchema } from '../dist/config.js';

const execute = promisify(execFile);
async function fixture(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-gui-'));
  const path = join(dir, 'config.json');
  const config = { version: 1, servers: { demo: { transport: 'stdio', command: process.execPath, args: [resolve('test/fixture.mjs')],
    description: '<img src=x onerror=alert(1)>', enabled: false, env: { HUB_TEST_LOG: join(dir, 'started.log'), HUB_TEST_SECRET: 'PRIVATE_GUI_TEST' } } }, ...overrides };
  await writeFile(path, JSON.stringify(config));
  const gui = await startGui({ configPath: path, pickFolder: async () => dir });
  t.after(async () => { await gui.close(); await rm(dir, { recursive: true, force: true }); });
  const request = (route, value, headers = {}) => fetch(gui.origin + route, {
    method: value === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer ' + gui.token, ...(value === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }),
  });
  const api = async (route, value) => { const response = await request(route, value); const data = await response.json(); assert.equal(response.status, 200, JSON.stringify(data)); return data; };
  return { dir, path, config, gui, request, api };
}

test('GUI authenticates every owner API, rejects foreign sites and Host headers, and serves only its build assets', async t => {
  const { gui, request, api } = await fixture(t);
  assert.match(gui.origin, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(gui.url, /\/#token=[a-f0-9]{64}$/);
  for (const route of ['/api/state', '/api/config', '/api/skills?server=demo', '/api/inspect?server=demo']) {
    assert.equal((await fetch(gui.origin + route)).status, 401, route);
    assert.equal((await request(route, undefined, { Authorization: 'Bearer ' + '0'.repeat(64) })).status, 401, route);
  }
  for (const route of ['/api/action', '/api/folder', '/api/close']) assert.equal((await request(route, {}, { Authorization: '' })).status, 401, route);
  for (const headers of [{ Origin: 'https://attacker.example' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }]) {
    assert.equal((await request('/api/action', { action: 'toggle', server: 'demo', enabled: true }, headers)).status, 403, JSON.stringify(headers));
  }
  // Fetch normalizes Host; use the HTTP client to exercise a real rebinding header.
  const wrongHost = await new Promise((resolve, reject) => {
    const req = httpRequest(gui.origin + '/api/state', { headers: { Host: 'attacker.example', Authorization: 'Bearer ' + gui.token } }, res => { res.resume(); resolve(res.statusCode); });
    req.once('error', reject); req.end();
  });
  assert.equal(wrongHost, 403);
  assert.equal((await fetch(gui.origin + '/api/action', { method: 'OPTIONS', headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await api('/api/state')).servers[0].enabled, false);
  assert.equal((await request('/api/state', undefined, { Origin: gui.origin, 'Sec-Fetch-Site': 'same-origin' })).status, 200);
  assert.equal((await request('/api/action', { action: 'allOff' }, { 'Content-Type': 'text/plain' })).status, 400);
  const home = await fetch(gui.origin + '/'); const html = await home.text();
  assert.match(html, /<title>Context Hub<\/title>/);
  for (const secret of ['PRIVATE_GUI_TEST', gui.token, 'config.json']) assert.equal(html.includes(secret), false);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.equal(home.headers.get('x-frame-options'), 'DENY');
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(home.headers.get('access-control-allow-origin'), null);
  for (const asset of html.matchAll(/(?:src|href)="(\/assets\/[^\"]+)"/g)) assert.equal((await fetch(gui.origin + asset[1])).status, 200);
  for (const route of ['/config.json', '/assets/../../config.json', '/assets/%2e%2e%2fconfig.json', '/src/gui.ts']) assert.equal((await fetch(gui.origin + route)).status, 404);
});

test('GUI owner mutations persist, never start an MCP on listing or enable, and guard stale and invalid edits', async t => {
  const { api, request, dir, path } = await fixture(t);
  const initial = await api('/api/state');
  assert.equal(JSON.stringify(initial).includes('PRIVATE_GUI_TEST'), false);
  assert.equal(initial.servers[0].description, '<img src=x onerror=alert(1)>');
  assert.equal((await api('/api/config')).value.servers.demo.env.HUB_TEST_SECRET, 'PRIVATE_GUI_TEST');
  assert.equal((await api('/api/folder', {})).folder, dir);
  await api('/api/action', { action: 'toggle', server: 'demo', enabled: true });
  assert.equal((await api('/api/state')).servers[0].enabled, true);
  assert.equal(JSON.parse(await readFile(path + '.device.json', 'utf8')).enabled.demo, true);
  await assert.rejects(access(join(dir, 'started.log')), /ENOENT/);
  await api('/api/action', { action: 'add', revision: initial.revision, value: { id: 'extra', kind: 'http', url: 'https://example.com/mcp' } });
  const added = await api('/api/state');
  assert.equal(added.servers.find(server => server.server === 'extra').enabled, false);
  const stale = await request('/api/action', { action: 'security', revision: initial.revision, key: 'allowStdio', enabled: false });
  assert.equal(stale.status, 400); assert.match((await stale.json()).error, /再読み込み/);
  const before = await readFile(path, 'utf8');
  for (const value of [
    { action: 'add', revision: added.revision, value: { id: '__proto__', kind: 'stdio', command: 'no' } },
    { action: 'add', revision: added.revision, value: { id: 'bad', kind: 'http', url: 'file:///tmp/private' } },
    { action: 'config', revision: added.revision, value: { version: 1, servers: {}, security: { unknown: true } } },
    { action: 'toggle', server: 'extra', enabled: true, unexpected: true },
  ]) assert.equal((await request('/api/action', value)).status, 400);
  assert.equal(await readFile(path, 'utf8'), before);
  await api('/api/action', { action: 'allOff' });
  assert.ok((await api('/api/state')).servers.every(server => !server.enabled));
  await api('/api/action', { action: 'remove', revision: added.revision, server: 'extra' });
  assert.deepEqual((await api('/api/state')).servers.map(server => server.server), ['demo']);
});

test('GUI attaches a validated Skill without starting its MCP and refuses unreadable attachments', async t => {
  const { api, request, dir, path } = await fixture(t);
  const skill = join(dir, 'guide'); await mkdir(skill);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: guide\ndescription: Design guidance\n---\nA deliberate silhouette.');
  const { revision } = await api('/api/state');
  assert.equal((await request('/api/action', { action: 'attachSkill', revision, server: 'demo', skill: 'missing', path: join(dir, 'missing') })).status, 400);
  await api('/api/action', { action: 'attachSkill', revision, server: 'demo', skill: 'guide', path: skill });
  assert.equal((await api('/api/state')).servers[0].skillCount, 1);
  assert.equal((await api('/api/skills?server=demo'))[0].description, 'Design guidance');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).servers.demo.skills, ['guide']);
  await assert.rejects(access(join(dir, 'started.log')), /ENOENT/);
});

test('a live MCP session observes GUI/CLI settings, cancels stale calls and keeps the same five tools', async t => {
  const { api, dir, path } = await fixture(t);
  const client = new Client({ name: 'gui-e2e', version: '1' });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), 'serve', '--config', path], stderr: 'pipe' }));
  t.after(() => client.close());
  const tools = await client.listTools(); assert.equal(tools.tools.length, 5);
  const call = (name, args) => client.callTool({ name, arguments: args });
  await api('/api/action', { action: 'toggle', server: 'demo', enabled: true });
  assert.equal(JSON.parse((await call('hub_catalog', {})).content[0].text).servers[0].enabled, true);
  const result = await call('hub_call', { server: 'demo', tool: 'echo', arguments: { message: 'live GUI' } });
  assert.equal(JSON.parse(result.content[0].text).message, 'live GUI');
  const pending = call('hub_call', { server: 'demo', tool: 'slow', arguments: { delay: 1500 } });
  await delay(100);
  await api('/api/action', { action: 'security', revision: (await api('/api/state')).revision, key: 'allowStdio', enabled: false });
  await call('hub_catalog', {}); // the next request replaces the profile and aborts its in-flight connection
  assert.equal((await pending).isError, true);
  const denied = await call('hub_call', { server: 'demo', tool: 'echo', arguments: {} });
  assert.equal(denied.isError, true); assert.match(denied.content[0].text, /Stdio transport is disabled/);
  await execute(process.execPath, ['dist/cli.js', 'security', 'set', 'allowStdio', 'on', '--config', path]);
  assert.equal((await api('/api/state')).security.allowStdio, true);
  assert.equal((await call('hub_call', { server: 'demo', tool: 'echo', arguments: {} })).isError, undefined);
  assert.equal((await readFile(join(dir, 'started.log'), 'utf8')).trim().split(/\r?\n/).length, 2);
  await api('/api/action', { action: 'toggle', server: 'demo', enabled: false });
  assert.equal((await call('hub_call', { server: 'demo', tool: 'echo', arguments: {} })).isError, true);
  assert.deepEqual(await client.listTools(), tools);
});

test('invalid owner settings close the old runtime and a corrected file can recover without restart', async t => {
  const { path, config } = await fixture(t);
  const runtime = new HubRuntime(path); t.after(() => runtime.close());
  const old = await runtime.get();
  await old.hub.control('demo', 'enable');
  await writeFile(path, '{"secret": "DO_NOT_ECHO_BROKEN_CONFIG"');
  await assert.rejects(runtime.get(), error => !error.message.includes('DO_NOT_ECHO') && /設定ファイル/.test(error.message));
  assert.equal(old.hub.isEnabled('demo'), false);
  await assert.rejects(old.hub.call('demo', 'echo', {}), /shutting down/);
  await writeFile(path, JSON.stringify(config));
  const recovered = await runtime.get();
  assert.notEqual(recovered.hub, old.hub); await recovered.hub.refresh();
  assert.equal(recovered.hub.isEnabled('demo'), true);
});

test('GUI connects shared folders and approves exactly the Skill revision reviewed on the receiving device', async t => {
  const { api, request, dir, path } = await fixture(t, { servers: {} });
  const folder = join(dir, 'share'); await mkdir(folder); await SyncManager.initialize(folder);
  const skill = join(dir, 'shared-guide'); await mkdir(skill);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: guide\ndescription: Shared guide\n---\nRead this revision.');
  const sourcePath = join(dir, 'source.json');
  const config = configSchema.parse({ version: 1, sync: { folder }, servers: { docs: { transport: 'http', url: 'https://example.com/mcp', skills: ['guide'] } }, skills: { guide: skill } });
  await writeFile(sourcePath, JSON.stringify(config));
  const source = new GuiAdmin(sourcePath); t.after(() => source.close());
  await source.action({ action: 'publish', server: 'docs' });
  await api('/api/action', { action: 'connect', revision: (await api('/api/state')).revision, folder });
  let state = await api('/api/state');
  assert.equal(state.sync.servers[0].status, 'pending-approval'); assert.equal(state.servers.length, 0);
  const first = await api('/api/inspect?server=docs');
  assert.match(first.change.bundle.packages.guide['SKILL.md'], /Read this revision/);
  await writeFile(join(skill, 'SKILL.md'), '---\nname: guide\ndescription: Shared guide\n---\nA newer revision.');
  await source.action({ action: 'publish', server: 'docs' });
  assert.equal((await request('/api/action', { action: 'approve', server: 'docs', revision: first.revision })).status, 400);
  const second = await api('/api/inspect?server=docs');
  assert.notEqual(first.revision, second.revision);
  await api('/api/action', { action: 'approve', server: 'docs', revision: second.revision });
  state = await api('/api/state'); assert.equal(state.servers[0].enabled, false); assert.equal(state.servers[0].skillCount, 1);
  await api('/api/action', { action: 'toggle', server: 'docs', enabled: true });
  assert.equal((await source.state()).servers[0].enabled, true);
  await api('/api/action', { action: 'disconnect', revision: state.revision });
  assert.equal((await api('/api/state')).sync.connected, false);
  assert.equal(JSON.parse(await readFile(path, 'utf8')).sync.folder, undefined);
});

test('GUI closes on idle, and the foreground CLI exits after authenticated shutdown', async t => {
  const { path, gui } = await fixture(t);
  const idle = await startGui({ configPath: path, idleTimeoutMs: 35 }); t.after(() => idle.close());
  await delay(150);
  await assert.rejects(fetch(idle.origin + '/api/state', { headers: { Authorization: 'Bearer ' + idle.token } }));
  const child = spawn(process.execPath, [resolve('dist/cli.js'), 'gui', '--no-open', '--config', path], { stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill(); });
  const exited = new Promise(resolve => child.once('exit', resolve));
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('GUI CLI startup timed out')); }, 10000);
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; const match = output.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/); if (match) { clearTimeout(timer); resolve(new URL(match[0])); } });
    child.once('error', error => { clearTimeout(timer); reject(error); });
  });
  const token = new URLSearchParams(url.hash.slice(1)).get('token');
  const response = await fetch(url.origin + '/api/close', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
  assert.equal(response.status, 200); assert.equal(await exited, 0);
  // Closing the GUI process does not close another independently running Hub/GUI.
  assert.equal((await fetch(gui.origin + '/api/state', { headers: { Authorization: 'Bearer ' + gui.token } })).status, 200);
});
