import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Hub } from '../dist/hub.js';
import { configSchema } from '../dist/config.js';
import { SkillStore, installHubSkill } from '../dist/skills.js';

async function setup(t, serverOptions = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-skills-'));
  const skills = {};
  for (const [name, description] of Object.entries({ workflow: 'Operate scenes', design: 'Composition and lighting', render: 'Rendering tools', detached: 'Private unattached procedure' })) {
    const path = join(dir, name);
    await mkdir(join(path, 'references'), { recursive: true });
    await writeFile(join(path, 'SKILL.md'), `---\nname: ${name}\ndescription: >-\n  ${description}\n---\n${name.toUpperCase()}_BODY\n`);
    skills[name] = path;
  }
  const log = join(dir, 'spawn-log');
  const server = { transport: 'stdio', command: process.execPath, args: [resolve('test/fixture.mjs')],
    env: { HUB_TEST_LOG: log }, skills: ['workflow', 'design'], toolSkills: { echo: ['workflow'], image: ['render'] }, ...serverOptions };
  const config = configSchema.parse({ version: 1, skills, servers: { blender: server, other: { ...server, skills: ['workflow'], toolSkills: {} } } });
  const hub = new Hub(config);
  t.after(async () => { await hub.close(); await rm(dir, { recursive: true, force: true }); });
  return { hub, dir, log, config, store: new SkillStore(skills), skills };
}

test('server discovery searches attached skill metadata, but returns only a skill count', async t => {
  const { hub, log } = await setup(t);
  const result = await hub.catalog('lighting');
  assert.equal(result.total, 1);
  assert.equal(result.servers[0].server, 'blender');
  assert.equal(result.servers[0].skillCount, 3);
  assert.ok(!JSON.stringify(result).includes('_BODY'));
  assert.equal(result.servers[0].skills, undefined);
  const details = await hub.catalog('', 0, 1, 'blender');
  assert.equal(details.skills[0].skill, 'workflow');
  assert.equal(details.skills[0].description, 'Operate scenes');
  assert.equal(details.nextOffset, 1);
  assert.equal(details.total, 3);
  assert.deepEqual((await hub.catalog('', 1, 20, 'blender')).skills.map(skill => skill.skill), ['design', 'render']);
  assert.deepEqual((await hub.catalog('', 0, 20, 'blender', 'echo')).skills.map(skill => skill.skill), ['workflow', 'design']);
  assert.equal((await hub.catalog('lighting', 0, 20, 'blender')).skills.length, 1);
  await assert.rejects(access(log), /ENOENT/);
});

test('selected skill reads do not start MCP; shared content supports explicit revision checks', async t => {
  const { hub, log, skills } = await setup(t);
  const body = await hub.skill('blender', 'workflow');
  assert.equal(body.content, 'WORKFLOW_BODY');
  assert.equal(body.basePath, await realpath(skills.workflow));
  assert.ok(!body.content.includes('description:'));
  const shared = await hub.skill('other', 'workflow', { ifRevision: body.revision });
  assert.equal(shared.unchanged, true);
  assert.equal(shared.content, undefined);
  // A normal read always restores the body after context compaction.
  assert.equal((await hub.skill('other', 'workflow')).content, body.content);
  await writeFile(join(skills.workflow, 'SKILL.md'), '---\nname: workflow\ndescription: Changed description\n---\nCHANGED_BODY');
  const changed = await hub.skill('other', 'workflow', { ifRevision: body.revision });
  assert.equal(changed.content, 'CHANGED_BODY');
  assert.notEqual(changed.revision, body.revision);
  assert.equal((await hub.catalog('changed')).total, 2);
  await assert.rejects(access(log), /ENOENT/);
});

test('tool schemas return only applicable deduplicated skill IDs', async t => {
  const { hub } = await setup(t);
  const echo = await hub.tools('blender', { tool: 'echo' });
  assert.deepEqual(echo.skills, ['workflow', 'design']);
  assert.deepEqual((await hub.tools('blender', { tool: 'image' })).skills, ['workflow', 'design', 'render']);
  assert.ok(!JSON.stringify(echo).includes('WORKFLOW_BODY'));
});

test('OFF, unbound skills and tool allowlists block skill content', async t => {
  const { hub, log } = await setup(t, { allowedTools: ['echo'] });
  await assert.rejects(hub.skill('blender', 'render'), /not attached/);
  await assert.rejects(hub.skill('blender', 'detached'), /not attached/);
  await assert.rejects(hub.skill('other', 'design'), /not attached/);
  assert.equal((await hub.catalog('', 0, 20, 'blender')).total, 2);
  await hub.control('blender', 'disable');
  await assert.rejects(hub.skill('blender', 'workflow'), /OFF/);
  await hub.control('blender', 'enable');
  assert.equal((await hub.skill('blender', 'workflow')).content, 'WORKFLOW_BODY');
  await assert.rejects(access(log), /ENOENT/);
});

test('references are read individually, paginated without broken Unicode, and scripts are not executed', async t => {
  const { hub, skills, dir } = await setup(t);
  const source = 'a'.repeat(11999) + '😀' + 'b'.repeat(16000);
  await writeFile(join(skills.workflow, 'references/long.md'), source);
  let offset = 0;
  let combined = '';
  do {
    const page = await hub.skill('blender', 'workflow', { file: 'references/long.md', offset });
    assert.ok(!page.content.includes('\uFFFD'));
    assert.ok(!/[\uD800-\uDBFF]$/.test(page.content));
    assert.ok(page.content.length <= 12000);
    combined += page.content;
    offset = page.nextOffset;
  } while (offset !== undefined);
  assert.equal(combined, source);
  await assert.rejects(hub.skill('blender', 'workflow', { file: 'references/long.md', offset: 100000 }), /offset/);
  const marker = join(dir, 'must-not-run');
  await mkdir(join(skills.workflow, 'scripts'));
  await writeFile(join(skills.workflow, 'scripts/run.js'), `require('fs').writeFileSync(${JSON.stringify(marker)}, 'bad');`);
  assert.match((await hub.skill('blender', 'workflow', { file: 'scripts/run.js' })).content, /writeFileSync/);
  await assert.rejects(access(marker), /ENOENT/);
});

test('skill files are confined to the registered directory and bounded UTF-8 text', async t => {
  const { hub, skills, dir } = await setup(t);
  await writeFile(join(dir, 'outside.txt'), 'OUTSIDE_SECRET');
  await symlink(join(dir, 'outside.txt'), join(skills.workflow, 'references/outside.md'));
  await symlink(dir, join(skills.workflow, 'references/outside-dir'), 'dir');
  for (const file of ['../outside.txt', join(dir, 'outside.txt'), 'references/outside.md', 'references/outside-dir/outside.txt', '..\\outside.txt']) {
    await assert.rejects(hub.skill('blender', 'workflow', { file }), /relative path|outside/);
  }
  await writeFile(join(skills.workflow, 'references/big.md'), 'x'.repeat(256 * 1024 + 1));
  await assert.rejects(hub.skill('blender', 'workflow', { file: 'references/big.md' }), /256 KiB/);
  await writeFile(join(skills.workflow, 'references/binary'), Buffer.from([0, 255]));
  await assert.rejects(hub.skill('blender', 'workflow', { file: 'references/binary' }), /UTF-8|Binary/);
  await assert.rejects(hub.skill('blender', 'workflow', { file: 'references' }), /regular text/);
});

test('invalid metadata is isolated; validation and direct reads report failure without echoing file contents', async t => {
  const { hub, store, skills } = await setup(t);
  await writeFile(join(skills.design, 'SKILL.md'), '---\nname: design\ndescription: bad: PRIVATE_VALUE\n---\nPRIVATE_BODY');
  const catalog = await hub.catalog('', 0, 20, 'blender');
  assert.equal(catalog.skills.find(skill => skill.skill === 'design').available, false);
  assert.ok(!JSON.stringify(catalog).includes('PRIVATE'));
  await assert.rejects(hub.skill('blender', 'design'), error => /invalid/.test(error.message) && !error.message.includes('PRIVATE'));
  await assert.rejects(store.validate(), /invalid/);
  await writeFile(join(skills.design, 'SKILL.md'), '---\nname: design\ndescription: one\ndescription: two\n---\nBody');
  await assert.rejects(hub.skill('blender', 'design'), /invalid/);
  assert.equal((await hub.skill('blender', 'workflow')).content, 'WORKFLOW_BODY');
});

test('config rejects broken bindings and relative roots; packaged skill installs without overwriting', async t => {
  const { config, dir, store } = await setup(t);
  await store.validate();
  assert.throws(() => configSchema.parse({ ...config, skills: {} }), /Unknown skill ID/);
  assert.throws(() => configSchema.parse({ ...config, skills: { ...config.skills, design: './relative' } }), /absolute/);
  const installed = await installHubSkill(join(dir, 'client-skills'));
  const before = await readFile(join(installed, 'SKILL.md'), 'utf8');
  assert.match(before, /name: mcp-context-hub/);
  await assert.rejects(installHubSkill(join(dir, 'client-skills')), /EEXIST/);
  assert.equal(await readFile(join(installed, 'SKILL.md'), 'utf8'), before);
});

test('stdio routing exposes five fixed tools and forwards skill discovery, reads, and errors', async t => {
  const { config, dir, log } = await setup(t);
  const path = join(dir, 'config.json');
  await writeFile(path, JSON.stringify(config));
  const client = new Client({ name: 'skills-integration', version: '1' });
  t.after(async () => { await client.close(); });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [resolve('dist/cli.js'), '--config', path], stderr: 'pipe' }));
  const before = await client.listTools();
  assert.equal(before.tools.length, 5);
  assert.ok(!JSON.stringify(before).includes('WORKFLOW_BODY'));
  const summaries = await client.callTool({ name: 'hub_catalog', arguments: { server: 'blender' } });
  assert.equal(JSON.parse(summaries.content[0].text).skills.length, 3);
  const response = await client.callTool({ name: 'hub_skill', arguments: { server: 'blender', skill: 'workflow' } });
  assert.equal(JSON.parse(response.content[0].text).content, 'WORKFLOW_BODY');
  const invalid = await client.callTool({ name: 'hub_skill', arguments: { server: 'blender', skill: 'detached' } });
  assert.equal(invalid.isError, true);
  const badFilter = await client.callTool({ name: 'hub_catalog', arguments: { tool: 'echo' } });
  assert.equal(badFilter.isError, true);
  assert.deepEqual(await client.listTools(), before);
  await assert.rejects(access(log), /ENOENT/);
});
