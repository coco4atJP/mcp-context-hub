import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import { configSchema } from '../dist/config.js';
import { SyncManager } from '../dist/sync.js';
import { LanPeer } from '../dist/lan-peer.js';
import { LanController } from '../dist/lan.js';
import { request } from '../dist/lan-wire.js';
import { onLan, parseInvitation, invitationUrl } from '../dist/lan-network.js';
import { servicePlan, windowsArg } from '../dist/lan-service.js';
import { localRequest, runningGui } from '../dist/daemon.js';
import { startGui } from '../dist/gui.js';
import { announcement, advertisedEndpoints } from '../dist/lan-discovery.js';

const run = promisify(execFile);
const options = { allowed: value => value === '127.0.0.1', addresses: () => ['127.0.0.1'], discovery: false };
const hash = text => createHash('sha256').update(text).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'hub-lan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const devices = [];
  t.after(async () => { await Promise.all(devices.map(value => value.peer?.close())); });
  const make = async (name, extra = {}) => {
    const path = join(root, name + '.json');
    const config = configSchema.parse({ version: 1, servers: {}, ...extra, sync: { mode: 'lan', autoPublish: false, pollIntervalMs: 1000, ...extra.sync } });
    await writeFile(path, JSON.stringify(config));
    const sync = new SyncManager(config, path);
    const peer = new LanPeer(path, async () => sync, options); const value = { path, config, sync, peer }; devices.push(value);
    await peer.start(); return value;
  };
  return { root, make };
}
async function pair(a, b) {
  const invitation = a.peer.invite(); await b.peer.join(invitation.url);
  const incoming = a.peer.status().pending[0]; const outgoing = b.peer.status().pending[0];
  assert.equal(incoming.code, outgoing.code); assert.match(incoming.code, /^\d{6}$/);
  await a.peer.confirm(incoming.id); assert.equal(a.peer.status().peers.length, 0);
  await b.peer.confirm(outgoing.id); await b.peer.tick();
  assert.equal(a.peer.status().peers.length, 1); assert.equal(b.peer.status().peers.length, 1);
  return invitation;
}

test('LAN address policy rejects routed private networks, internet, loopback, broadcast and tunnels by default', () => {
  const interfaces = [{ address: '192.168.7.10', netmask: '255.255.255.0' }];
  for (const ip of ['192.168.7.1', '192.168.7.10', '192.168.7.254']) assert.equal(onLan(ip, interfaces), true, ip);
  for (const ip of ['127.0.0.1', '8.8.8.8', '10.0.0.1', '192.168.8.1', '192.168.7.0', '192.168.7.255', '::1', '::ffff:192.168.7.5', 'host.local', '0xC0A80701']) assert.equal(onLan(ip, interfaces), false, ip);
  assert.equal(onLan('10.0.0.2', [{ address: '10.0.0.1', netmask: '0.0.0.0' }]), false);
  assert.equal(onLan('169.254.1.2', [{ address: '169.254.1.1', netmask: '255.255.0.0' }]), true);
});

test('discovery follows changed address/port only for the paired identity and rejects incomplete or oversized advertisements', () => {
  const id = 'a'.repeat(64); const allow = ip => onLan(ip, [{ address: '192.168.2.1', netmask: '255.255.255.0' }]);
  const old = announcement(id, 50100, ['192.168.2.2']); const changed = announcement(id, 50200, ['192.168.2.3']);
  assert.deepEqual(advertisedEndpoints(old, id, allow), [{ address: '192.168.2.2', port: 50100 }]);
  assert.deepEqual(advertisedEndpoints(changed, id, allow), [{ address: '192.168.2.3', port: 50200 }]);
  assert.deepEqual(advertisedEndpoints(changed, 'b'.repeat(64), allow), []);
  assert.deepEqual(advertisedEndpoints(announcement(id, 50, ['8.8.8.8', '10.0.0.2', '127.0.0.1']), id, allow), []);
  assert.deepEqual(advertisedEndpoints({ answers: changed.answers.filter(record => record.type !== 'TXT') }, id, allow), []);
  assert.deepEqual(advertisedEndpoints({ answers: Array(40).fill(changed.answers[0]) }, id, allow), []);
});

test('pairing requires two confirmations, matching certificates, one-use invitation and valid expiry', async t => {
  const { make } = await fixture(t); const a = await make('a'); const b = await make('b'); const stranger = await make('stranger');
  const endpoint = { address: '127.0.0.1', port: a.peer.port };
  await assert.rejects(request(b.peer.identity, endpoint, '0'.repeat(64), { op: 'inventory' }, options.allowed), /証明書/);
  await assert.rejects(request(stranger.peer.identity, endpoint, a.peer.id, { op: 'inventory' }, options.allowed), /拒否/);
  const invitation = await pair(a, b);
  await assert.rejects(stranger.peer.join(invitation.url));
  assert.throws(() => parseInvitation(invitationUrl({ ...parseInvitation(invitation.url), e: Date.now() - 1 })), /期限切れ/);
  for (const bad of ['https://example.com', invitation.url + '&config=/tmp/bad', 'mcp-context-hub://pair#' + 'a'.repeat(2000)]) assert.throws(() => parseInvitation(bad));
  const saved = JSON.parse(await readFile(a.path + '.lan-peers.json', 'utf8'));
  assert.ok(saved.peers[b.peer.id]); assert.ok(saved.identity.key.includes('PRIVATE KEY'));
  if (process.platform !== 'win32') assert.equal((await stat(a.path + '.lan-peers.json')).mode & 0o777, 0o600);
  await a.peer.close(); a.peer = new LanPeer(a.path, async () => a.sync, options); await a.peer.start();
  assert.equal(a.peer.id, parseInvitation(invitation.url).k); assert.equal(a.peer.status().peers[0].id, b.peer.id);
});

test('paired replicas exchange skills and causal revisions but never device switches, paths, commands, credentials or policies', async t => {
  const { root, make } = await fixture(t);
  const skill = join(root, 'design-guide'); await mkdir(skill); await mkdir(join(skill, 'references'));
  await writeFile(join(skill, 'SKILL.md'), '---\nname: design-guide\ndescription: Use this design guide for Blender work.\n---\nRead references/style.md.\n');
  await writeFile(join(skill, 'references/style.md'), 'Keep silhouettes readable.');
  const a = await make('mac', { skills: { guide: skill }, servers: { blender: { transport: 'stdio', command: '/local/MAC_ONLY', env: { SECRET: 'DO_NOT_SHARE' }, skills: ['guide'], enabled: true } } });
  const b = await make('win', { templates: { blender: { transport: 'stdio', command: 'WINDOWS_ONLY' } } });
  const first = await a.sync.publish('blender', a.config.servers.blender, a.config.skills);
  await pair(a, b); await b.sync.pull(true);
  assert.deepEqual(await b.sync.inventory(), [first]); assert.equal((await b.sync.status()).servers[0].status, 'pending-approval');
  assert.equal((await b.sync.available()).length, 0);
  const exported = await b.sync.exportRevision(first);
  for (const forbidden of ['DO_NOT_SHARE', 'MAC_ONLY', 'WINDOWS_ONLY', root, 'enabled', 'requireSyncApproval', '"command"', '"env"']) assert.equal(exported.includes(forbidden), false, forbidden);
  await b.sync.approve('blender', first);
  const ready = (await b.sync.available())[0]; assert.equal(ready.config.enabled, false); assert.equal(ready.config.command, 'WINDOWS_ONLY');
  assert.match(await readFile(join(Object.values(ready.paths)[0], 'references', 'style.md'), 'utf8'), /silhouettes/);
  const second = await a.sync.publish('blender', { ...a.config.servers.blender, description: 'Updated on Mac' }, a.config.skills);
  await b.peer.tick(); await b.sync.pull(true); assert.equal((await b.sync.status()).servers[0].revision, second);
  await assert.rejects(b.sync.approve('blender', first), /Revision changed/);
  await b.sync.approve('blender', second);
  const deletion = await a.sync.remove('blender'); await b.peer.tick(); await b.sync.approve('blender', deletion);
  assert.equal((await b.sync.status()).servers[0].status, 'deleted');
});

test('a paired device cannot smuggle commands or owner actions; revocation blocks further revision transfer', async t => {
  const { make } = await fixture(t); const a = await make('a'); const b = await make('b'); await pair(a, b);
  const endpoint = { address: '127.0.0.1', port: a.peer.port };
  const value = JSON.stringify({ version: 1, server: 'bad', device: '11111111-1111-4111-8111-111111111111', parents: [], bundle: { connection: { command: 'sh' }, packages: {} } });
  await assert.rejects(request(b.peer.identity, endpoint, a.peer.id, { op: 'put', revision: hash(value), data: Buffer.from(value).toString('base64') }, options.allowed), /拒否/);
  for (const op of ['security', 'approve', 'call', 'config']) await assert.rejects(request(b.peer.identity, endpoint, a.peer.id, { op }, options.allowed), /拒否/);
  assert.deepEqual(await a.sync.inventory(), []);
  await a.peer.unpair(b.peer.id);
  await assert.rejects(request(b.peer.identity, endpoint, a.peer.id, { op: 'inventory' }, options.allowed), /拒否/);
  assert.equal(a.peer.status().peers.length, 0);
});

test('automatic local publishing notices source edits without creating revisions for switches or overwriting received changes', async t => {
  const { root } = await fixture(t); const path = join(root, 'auto.json');
  let config = { version: 1, sync: { mode: 'lan' }, servers: { local: { transport: 'stdio', command: 'never-start-me', description: 'Original', enabled: false } } };
  await writeFile(path, JSON.stringify(config)); const controller = new LanController(path, options); t.after(() => controller.close());
  await controller.start(); await controller.tick();
  assert.equal(JSON.parse(await readFile(path + '.device.json', 'utf8')).enabled.local, false);
  const sync = new SyncManager(configSchema.parse(config), path); const first = await sync.inventory(); assert.equal(first.length, 1);
  config.servers.local.enabled = true; await writeFile(path, JSON.stringify(config)); await controller.tick(); assert.deepEqual(await sync.inventory(), first);
  config.servers.local.description = 'Edited locally'; await writeFile(path, JSON.stringify(config)); await controller.tick(); assert.equal((await sync.inventory()).length, 2);
  await sync.publish('local', { ...configSchema.parse(config).servers.local, description: 'Received edit' }, {});
  await controller.tick(); assert.equal((await sync.inventory()).length, 3); assert.equal((await sync.inspect('local')).change.bundle.description, 'Received edit');
  delete config.servers.local; await writeFile(path, JSON.stringify(config)); await controller.tick(); await sync.pull(true); assert.equal((await sync.status()).servers[0].status, 'deleted');
});

test('QR encoding round trips the exact invitation with no external service', () => {
  const value = invitationUrl({ v: 1, a: ['192.168.2.20'], p: 51234, k: 'a'.repeat(64), t: 'b'.repeat(64), e: Date.now() + 60000 });
  const qr = QRCode.create(value, { errorCorrectionLevel: 'M' }); const scale = 5; const width = (qr.modules.size + 8) * scale;
  const data = new Uint8ClampedArray(width * width * 4).fill(255);
  for (let y = 0; y < qr.modules.size; y++) for (let x = 0; x < qr.modules.size; x++) if (qr.modules.get(y, x)) {
    for (let dy = 0; dy < scale; dy++) for (let dx = 0; dx < scale; dx++) {
      const i = (((y + 4) * scale + dy) * width + (x + 4) * scale + dx) * 4; data[i] = 0; data[i + 1] = 0; data[i + 2] = 0;
    }
  }
  assert.equal(jsQR(data, width, width)?.data, value);
});

test('platform installers quote paths and URL handlers reject injected flags before reading any configuration', async () => {
  const mac = servicePlan('darwin', '/Users/A B', '/path/"x&/node', '/path/$literal/cli.js', '/private/x/config.json');
  assert.ok(mac.plist.includes('&quot;x&amp;')); assert.ok(mac.script.includes('quoted form of incomingURL')); assert.ok(mac.plist.includes('<key>RunAtLoad</key>'));
  const win = servicePlan('win32', 'C:\\Users\\A B', 'C:\\Program Files\\node.exe', "C:\\O'Brien\\cli.js", 'C:\\a&b\\config.json');
  assert.ok(win.script.includes('HKCU:')); assert.ok(win.script.includes('EncodedCommand')); assert.ok(win.script.includes("O''Brien")); assert.equal(win.script.includes('HKLM:'), false);
  assert.equal(windowsArg('C:\\x\\'), '"C:\\x\\\\"');
  await assert.rejects(run(process.execPath, ['dist/cli.js', 'handle-url', 'mcp-context-hub://pair#bad', '--config', '/tmp/should-not-be-read']), error => /Invalid pairing URL invocation/.test(error.stderr));
});

test('LAN owner APIs require loopback authentication and never appear on the peer transport', async t => {
  const { root } = await fixture(t); const path = join(root, 'gui.json'); await writeFile(path, '{"version":1,"servers":{}}');
  const gui = await startGui({ configPath: path }); t.after(() => gui.close());
  const result = await fetch(gui.origin + '/api/lan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"invite"}' }); assert.equal(result.status, 401);
  const state = await localRequest({ port: Number(new URL(gui.origin).port), token: gui.token }, '/api/state'); assert.equal(state.lan.enabled, false);
  assert.equal(state.lan.peers.length, 0); assert.equal(state.sync.mode, 'folder');
});

test('CLI worker launches once, reuses its authenticated GUI and stops without touching unrelated processes', async t => {
  const { root } = await fixture(t); const path = join(root, 'worker.json'); await writeFile(path, '{"version":1,"servers":{}}');
  const cli = async (...args) => run(process.execPath, [resolve('dist/cli.js'), ...args, '--config', path], { timeout: 30000 });
  t.after(async () => { const session = await runningGui(path); if (session) await localRequest(session, '/api/stop', {}); });
  const launch = () => run(process.execPath, ['--input-type=module', '-e', 'import {launchGui} from "./dist/gui-launch.js"; await launchGui(process.argv[1], undefined, {open:false});', path], { timeout: 30000 });
  await Promise.all([launch(), launch()]); const first = await runningGui(path); assert.ok(first);
  await launch(); assert.deepEqual(await runningGui(path), first);
  await cli('lan', 'stop');
  for (let i = 0; i < 30 && await runningGui(path); i++) await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(await runningGui(path), undefined);
});
test('paired LAN peers transfer global files with modern inventory and negotiate older peers without sending globals',async t=>{
 const {make}=await fixture(t);const a=await make('new-a');const b=await make('new-b');await pair(a,b);
 const first=await a.sync.publishGlobal({kind:'agents',target:'AGENTS.md',files:{content:{encoding:'utf8',content:'Shared instructions'}}});
 await a.peer.tick();assert.ok((await b.sync.inventory()).includes(first));
 assert.deepEqual((await request(b.peer.identity,{address:'127.0.0.1',port:a.peer.port},a.peer.id,{op:'inventory'},options.allowed)).revisions,[]);
 const legacyHost=await make('legacy-host');const c=await make('legacy');await pair(legacyHost,c);

 // Emulate v0.5's unknown-operation rejection; the transport, certificates and stores stay real.
 const handle=c.peer.handle.bind(c.peer);let probes=0;
 c.peer.handle=async(id,message,address)=>{if(message.op==='inventory2'){probes++;throw new Error('Unknown operation');}return handle(id,message,address);};
 const second=await legacyHost.sync.publishGlobal({kind:'agents',target:'AGENTS.md',files:{content:{encoding:'utf8',content:'Modern update'}}});
 const server=await legacyHost.sync.publish('docs',configSchema.parse({version:1,servers:{docs:{transport:'http',url:'https://example.com/mcp',description:'docs'}}}).servers.docs,{});
 await legacyHost.peer.tick();assert.equal((await c.sync.inventory()).includes(second),false);assert.ok((await c.sync.inventory()).includes(server));
 await legacyHost.peer.tick();assert.equal(probes,1);
 const cached=legacyHost.peer.capabilities.get(c.peer.id);cached.checked=Date.now()-61000;c.peer.handle=handle;
 await legacyHost.peer.tick();assert.ok((await c.sync.inventory()).includes(second));
});
