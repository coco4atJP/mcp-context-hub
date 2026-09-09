import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, cp, rename, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { configSchema, loadConfig } from '../dist/config.js';
import { Hub } from '../dist/hub.js';
import { Registry } from '../dist/registry.js';
import { DeviceState } from '../dist/device.js';
import { SyncManager, portableFile } from '../dist/sync.js';
import { control } from '../dist/control.js';
import { jsonResult } from '../dist/context.js';
import { assertLocalConfig, setSecurity } from '../dist/settings.js';
import { validateAgentUrl } from '../dist/network.js';

const run = promisify(execFile);
const hash = text => createHash('sha256').update(text).digest('hex');
const fixture = (dir, label) => ({ transport: 'stdio', command: process.execPath, args: [resolve('test/fixture.mjs')],
  env: { HUB_TEST_LOG: join(dir, label + '.log'), HUB_TEST_SECRET: label + '-private' }, allowedTools: ['echo'], description: 'Shared design service' });
async function setup(t) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-sync-'));
  const folder = join(dir, 'share'); await mkdir(folder); await SyncManager.initialize(folder);
  const skills = join(dir, 'design-guide'); await mkdir(skills); await mkdir(join(skills, 'references'));
  await writeFile(join(skills, 'SKILL.md'), '---\nname: design-guide\ndescription: Shared design guidance\n---\nRead references/style.md when designing.');
  await writeFile(join(skills, 'references', 'style.md'), 'Use a deliberate silhouette.');
  await writeFile(join(skills, '.env'), 'NEVER_EXPORT_THIS_SECRET');
  const make = async (name, overrides = {}) => {
    const path = join(dir, name + '.json');
    const config = configSchema.parse({ version: 1, sync: { folder }, templates: { design: fixture(dir, name) }, servers: {}, ...overrides });
    await writeFile(path, JSON.stringify(config));
    const sync = new SyncManager(config, path); const device = new DeviceState(path + '.device.json');
    const hub = new Hub(config, new Registry(path + '.agents.json'), { sync, device });
    t.after(() => hub.close());
    return { path, config, sync, device, hub };
  };
  t.after(() => rm(dir, { recursive: true, force: true }));
  const a = await make('mac', { skills: { guide: skills }, servers: { design: { ...fixture(dir, 'mac'), skills: ['guide'], toolSkills: { echo: ['guide'] } } } });
  const b = await make('windows');
  return { dir, folder, skills, make, a, b };
}

test('shared definitions and skill packages use local launch bindings, approval, and independent persistent switches', async t => {
  const { a, b, folder, dir } = await setup(t);
  await a.hub.refresh();
  const published = await a.hub.syncControl('publish', 'design', 0, 5, true);
  const shared = await readFile(join(folder, 'mcp-context-hub-v1', 'changes', published.revision + '.json'), 'utf8');
  for (const secret of [process.execPath, 'mac-private', 'NEVER_EXPORT_THIS_SECRET', 'inheritEnv', 'enabled', 'security', 'command', 'headers', dir]) assert.equal(shared.includes(secret), false, secret);
  assert.deepEqual(JSON.parse(shared).bundle.connection, { template: 'design' });
  await b.sync.pull(true); await b.hub.refresh();
  assert.equal((await b.sync.status()).servers[0].status, 'pending-approval');
  assert.equal((await b.hub.catalog()).total, 0);
  await assert.rejects(access(join(dir, 'windows.log')), /ENOENT/);
  await b.sync.approve('design', published.revision); await b.hub.refresh();
  assert.equal(b.hub.isEnabled('design'), false);
  await b.hub.control('design', 'enable');
  const catalog = await b.hub.catalog('', 0, 5, 'design');
  const skill = catalog.skills[0].skill;
  assert.match((await b.hub.skill('design', skill, { file: 'references/style.md' })).content, /silhouette/);
  const result = await b.hub.call('design', 'echo', { message: 'local launch' });
  assert.equal(JSON.parse(result.content[0].text).secret, 'windows-private');
  await a.hub.control('design', 'disable');
  assert.equal(b.hub.isEnabled('design'), true);
  const restarted = new Hub(b.config, new Registry(b.path + '.agents.json'), { sync: new SyncManager(b.config, b.path), device: new DeviceState(b.path + '.device.json') });
  t.after(() => restarted.close()); await restarted.refresh();
  assert.equal(restarted.isEnabled('design'), true);
  assert.equal((await restarted.control('design', 'status')).state, 'stopped');
  await b.hub.control('design', 'disable'); await restarted.refresh();
  assert.equal(restarted.isEnabled('design'), false);
});

test('shared updates require a new revision approval, invalidate results, and never resurrect a remote switch', async t => {
  const { a, b, skills } = await setup(t);
  const first = await a.hub.syncControl('publish', 'design', 0, 5, true);
  await b.sync.approve('design', first.revision); await b.hub.refresh(); await b.hub.control('design', 'enable');
  const cached = JSON.parse(b.hub.results.deliver(jsonResult('x'.repeat(10000)), 2000, 'design').content[0].text).resultId;
  // The CLI/Hub publisher reads editable local originals, not the origin's immutable synced cache.
  await writeFile(join(skills, 'references', 'style.md'), 'Updated composition guidance.');
  const { revision: second } = await a.hub.syncControl('publish', 'design', 0, 5, true);
  await b.sync.pull(true); await b.hub.refresh();
  assert.equal((await b.sync.status()).servers[0].status, 'pending-approval');
  await assert.rejects(b.hub.call('design', 'echo', {}), /Unknown server/);
  assert.throws(() => b.hub.results.read(cached, {}, 2000), /forgotten/);
  await assert.rejects(b.sync.approve('design', first.revision), /Revision changed/);
  await b.sync.approve('design', second); await b.hub.refresh();
  assert.equal(b.hub.isEnabled('design'), true); // this device's explicit switch survived the revision change
  const skill = (await b.hub.catalog('', 0, 5, 'design')).skills[0].skill;
  assert.match((await b.hub.skill('design', skill, { file: 'references/style.md' })).content, /Updated/);
  const deletion = await a.sync.remove('design');
  await b.sync.pull(true); await b.hub.refresh();
  await b.sync.approve('design', deletion); await b.hub.refresh();
  assert.equal((await b.sync.status()).servers[0].status, 'deleted');
  assert.equal((await b.hub.catalog()).total, 0);
});

test('republishing an imported package preserves portable skill IDs and never exports cache paths', async t => {
  const { a, b, folder } = await setup(t);
  const first = await a.hub.syncControl('publish', 'design', 0, 5, true);
  await b.sync.approve('design', first.revision); await b.hub.refresh();
  const second = await b.hub.syncControl('publish', 'design', 0, 5, true);
  const file = JSON.parse(await readFile(join(folder, 'mcp-context-hub-v1', 'changes', second.revision + '.json'), 'utf8'));
  assert.deepEqual(Object.keys(file.bundle.packages), ['guide']);
  assert.deepEqual(file.bundle.skills, ['guide']);
  assert.deepEqual(file.bundle.toolSkills, { echo: ['guide'] });
});

test('concurrent offline edits are conflicts, explicit resolution converges without clock ordering', async t => {
  const { a, dir, folder, make } = await setup(t);
  await a.sync.publish('design', a.config.servers.design, a.config.skills);
  const replica = join(dir, 'replica'); await cp(folder, replica, { recursive: true });
  const b = await make('replica-device', { sync: { folder: replica } });
  await b.sync.pull(true);
  const left = await a.sync.publish('design', { ...a.config.servers.design, description: 'Mac edit' }, a.config.skills);
  await b.sync.publish('design', { ...b.config.templates.design, description: 'Windows edit' }, {});
  await cp(replica, folder, { recursive: true });
  await a.sync.pull(true);
  assert.equal((await a.sync.status()).servers[0].status, 'conflict');
  assert.equal((await a.sync.available()).length, 0);
  await assert.rejects(a.sync.approve('design', left), /conflicts/);
  await assert.rejects(a.sync.publish('design', a.config.servers.design, a.config.skills), /conflict/);
  const resolution = await a.sync.resolve('design', left);
  await cp(folder, replica, { recursive: true }); await b.sync.pull(true);
  assert.equal((await b.sync.status()).servers[0].revision, resolution);
  await b.sync.approve('design', resolution);
  assert.equal((await b.sync.available())[0].config.description, 'Mac edit');
});

test('out-of-order cloud delivery stays incomplete until all parents arrive; deletion of history is not a rollback', async t => {
  const { a, dir, folder, make } = await setup(t);
  const first = await a.sync.publish('design', a.config.servers.design, a.config.skills);
  const second = await a.sync.publish('design', { ...a.config.servers.design, description: 'New' }, a.config.skills);
  const replica = join(dir, 'partial'); await mkdir(replica); await SyncManager.initialize(replica);
  const b = await make('partial-device', { sync: { folder: replica }, security: { requireSyncApproval: false } });
  const changes = join('mcp-context-hub-v1', 'changes');
  await cp(join(folder, changes, second + '.json'), join(replica, changes, second + '.json'));
  await b.sync.pull(true); assert.equal((await b.sync.status()).servers[0].status, 'incomplete');
  await cp(join(folder, changes, first + '.json'), join(replica, changes, first + '.json'));
  await b.sync.pull(true); assert.equal((await b.sync.status()).servers[0].status, 'ready');
  await rm(join(replica, changes, second + '.json'));
  await b.sync.pull(true); assert.equal((await b.sync.status()).servers[0].status, 'incomplete');
  assert.equal((await b.sync.available()).length, 0);
});

test('approved cache works offline; malformed shared data blocks synced services even after a restart', async t => {
  const { a, b, folder } = await setup(t);
  const first = await a.sync.publish('design', a.config.servers.design, a.config.skills);
  await b.sync.approve('design', first); await b.hub.refresh();
  await rename(folder, folder + '-offline'); await b.sync.pull(true);
  assert.equal((await b.sync.status()).error, 'offline');
  assert.equal((await b.sync.available()).length, 1);
  await rename(folder + '-offline', folder);
  await writeFile(join(folder, 'mcp-context-hub-v1', 'changes', first + '.json'), '{"tampered":true}');
  await b.sync.pull(true); assert.equal((await b.sync.status()).error, 'invalid');
  assert.equal((await b.sync.available()).length, 0);
  await rename(folder, folder + '-offline');
  const restarted = new SyncManager(b.config, b.path); await restarted.pull(true);
  assert.equal((await restarted.status()).error, 'invalid');
  assert.equal((await restarted.available()).length, 0);
});

test('untrusted sync input cannot smuggle policies, commands, paths, duplicate files or symlinks', async t => {
  const { a, b, folder, dir } = await setup(t);
  const first = await a.sync.publish('design', a.config.servers.design, a.config.skills);
  const changes = join(folder, 'mcp-context-hub-v1', 'changes');
  const original = JSON.parse(await readFile(join(changes, first + '.json'), 'utf8'));
  const attacks = [
    value => { value.bundle.enabled = true; }, value => { value.bundle.security = { requireSyncApproval: false }; },
    value => { value.bundle.connection = { command: 'sh', args: ['-c', 'danger'] }; },
    value => { value.bundle.packages.guide['references/../../escape.md'] = 'escape'; },
    value => { value.bundle.packages.guide['references/style.MD'] = 'duplicate'; },
    value => { value.bundle.packages.guide['references/style.md/child.txt'] = 'file-as-directory'; },
    value => { value.bundle.packages.guide['references/NUL.txt'] = 'reserved'; },
  ];
  for (const mutate of attacks) {
    const value = structuredClone(original); value.parents = [first]; mutate(value);
    const text = JSON.stringify(value); const revision = hash(text); await writeFile(join(changes, revision + '.json'), text);
    await b.sync.pull(true); assert.equal((await b.sync.status()).error, 'invalid');
    await rm(join(changes, revision + '.json'));
  }
  if (process.platform !== 'win32') {
    const target = join(dir, 'outside.json'); await cp(join(changes, first + '.json'), target);
    await rm(join(changes, first + '.json')); await symlink(target, join(changes, first + '.json'));
    await b.sync.pull(true); assert.equal((await b.sync.status()).error, 'invalid');
  }
  for (const name of ['../SKILL.md', 'C:/x.md', 'references/x:ads.md', 'references/CON.md', 'references/x. ', 'references/.env', 'references/token.json']) assert.equal(portableFile(name), false, name);
  assert.throws(() => assertLocalConfig(join(folder, 'config.json'), folder), /outside/);
});

test('MCP exposes sync and security progressively and cannot approve revisions or relax owner switches', async t => {
  const { a, b } = await setup(t);
  await assert.rejects(a.hub.syncControl('publish', 'design'), /disables agent publishing/);
  for (const operation of ['approve', 'resolve', 'connect']) await assert.rejects(control(a.hub, 'sync', undefined, { operation }), /Invalid sync/);
  await assert.rejects(control(a.hub, 'security', undefined, { requireSyncApproval: false }), /Invalid security/);
  const response = JSON.parse((await control(b.hub, 'security', undefined, {})).content[0].text);
  assert.equal(response.requireSyncApproval, true); assert.equal(response.mutableThroughMcp, false);
  const help = JSON.parse((await control(b.hub, 'help', undefined, { action: 'sync' })).content[0].text);
  assert.ok(help.optionsSchema.properties.operation);
});

test('local security switches actually gate registration, transport, allowlists and network validation', async t => {
  const { make, dir } = await setup(t);
  const locked = await make('locked', { security: { allowAgentRegistration: false, allowStdio: false }, servers: { design: fixture(dir, 'locked') } });
  await assert.rejects(locked.hub.add('extra', { template: 'design' }), /disables agent registration/);
  await assert.rejects(locked.hub.call('design', 'echo', {}), /Stdio transport is disabled/);
  const permissive = await make('permissive', { security: { enforceToolAllowlist: false }, servers: { design: { ...fixture(dir, 'permissive'), allowedTools: [] } } });
  await permissive.hub.call('design', 'echo', {});
  const defaults = configSchema.parse({ version: 1, servers: {} });
  assert.throws(() => validateAgentUrl('http://127.0.0.1:1234/mcp', defaults.agent, defaults.security));
  assert.equal(validateAgentUrl('http://127.0.0.1:1234/mcp', defaults.agent, { ...defaults.security, requireHttps: false, blockPrivateHttp: false }).hostname, '127.0.0.1');
  await setSecurity(locked.path, 'allowStdio', true);
  assert.equal((await loadConfig(locked.path)).security.allowStdio, true);
  await assert.rejects(setSecurity(locked.path, '__proto__', true), /Unknown security/);
});

test('CLI connects an existing folder, reviews and accepts a pinned revision, and changes only local safety settings', async t => {
  const { a, b, folder, dir } = await setup(t);
  const cli = async (...args) => JSON.parse((await run(process.execPath, ['dist/cli.js', ...args], { cwd: resolve('.'), maxBuffer: 4 * 1024 * 1024 })).stdout);
  const blank = join(dir, 'blank.json'); await writeFile(blank, '{"version":1,"servers":{}}');
  assert.equal((await cli('sync', 'connect', '--folder', folder, '--config', blank)).restartRequired, true);
  const first = await cli('sync', 'publish', '--server', 'design', '--config', a.path);
  const inspect = await cli('sync', 'inspect', '--server', 'design', '--config', b.path);
  assert.equal(inspect.revision, first.revision);
  await cli('sync', 'approve', '--server', 'design', '--revision', first.revision, '--config', b.path);
  assert.equal((await cli('sync', 'status', '--config', b.path)).servers[0].status, 'ready');
  assert.equal((await cli('security', 'set', 'requireSyncApproval', 'off', '--config', b.path)).security.requireSyncApproval, false);
  assert.equal((await loadConfig(a.path)).security.requireSyncApproval, true);
  await cli('sync', 'disconnect', '--config', blank);
  assert.equal((await loadConfig(blank)).sync.folder, undefined);
});

test('live MCP gateway discovers an approved shared service without restart and keeps five tools', async t => {
  const { a, b } = await setup(t);
  const first = await a.hub.syncControl('publish', 'design', 0, 5, true);
  const client = new Client({ name: 'sync-e2e', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), '--config', b.path], stderr: 'pipe' }));
  const tools = await client.listTools(); assert.equal(tools.tools.length, 5);
  const call = (name, args) => client.callTool({ name, arguments: args });
  const pending = await call('hub_control', { action: 'sync', options: { operation: 'status' } });
  assert.equal(JSON.parse(pending.content[0].text).servers[0].status, 'pending-approval');
  await b.sync.approve('design', first.revision);
  assert.equal(JSON.parse((await call('hub_catalog', {})).content[0].text).servers[0].enabled, false);
  await call('hub_control', { action: 'enable', server: 'design' });
  assert.equal(JSON.parse((await call('hub_call', { server: 'design', tool: 'echo', arguments: { message: 'synced over MCP' } })).content[0].text).message, 'synced over MCP');
  assert.deepEqual(await client.listTools(), tools);
});
