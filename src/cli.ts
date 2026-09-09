#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configPath, initConfig, loadConfig } from './config.js';
import { createServer } from './server.js';
import { installHubSkill, SkillStore } from './skills.js';
import { assertLocalConfig } from './settings.js';
import { settingsCommand } from './cli-settings.js';
import { HubRuntime } from './runtime.js';
import { startGui } from './gui.js';
import { launchGui } from './gui-launch.js';

async function main() {
  const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, 'skills-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    folder: { type: 'string' }, server: { type: 'string' }, revision: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' } }, allowPositionals: true });
  if (values.help) {
    console.log('mcp-context-hub [serve|init|check|config-path] [--config /absolute/config.json]\nmcp-context-hub install-skill [--skills-dir /path/to/skills]\nDefault command: serve. Config: MCP_HUB_CONFIG or ~/.config/mcp-context-hub/config.json');
    console.log('mcp-context-hub gui [--no-open] [--port PORT]\nmcp-context-hub sync connect --folder EXISTING_ABSOLUTE_PATH\nmcp-context-hub sync disconnect|status\nmcp-context-hub sync publish|inspect|remove --server ID\nmcp-context-hub sync approve|resolve --server ID --revision SHA256\nmcp-context-hub security show|reset\nmcp-context-hub security set KEY on|off\nAll commands accept --config. Sync uses an existing shared folder. GUI opens locally; --no-open runs in the foreground. Owner config changes apply on the next MCP request.');
    return;
  }
  const command = positionals[0] ?? 'serve';
  if (!['sync', 'security'].includes(command) && positionals.length > 1) throw new Error('Expected at most one command. Use --help.');
  if (values['skills-dir'] && command !== 'install-skill') throw new Error('--skills-dir is only valid for install-skill.');
  if (command !== 'sync' && (values.folder || values.server || values.revision)) throw new Error('Sync flags require the sync command.');
  if (command !== 'gui' && (values.port !== undefined || values['no-open'])) throw new Error('--port and --no-open require gui.');
  if (command === 'install-skill') { console.log(`Installed ${await installHubSkill(values['skills-dir'])}`); return; }
  const path = configPath(values.config);
  if (command === 'gui') {
    const port = values.port === undefined ? 0 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('Port must be 0–65535.');
    if (!values['no-open']) { console.log(`Context Hub GUI: ${await launchGui(path, port)}`); return; }
    const gui = await startGui({ configPath: path, port });
    if (process.send) process.send({ url: gui.url }); else console.log(`Context Hub GUI: ${gui.url}`);
    process.once('SIGINT', () => { void gui.close(); });
    process.once('SIGTERM', () => { void gui.close(); });
    return;
  }
  if (await settingsCommand(path, positionals, values)) return;
  if (command === 'config-path') { console.log(path); return; }
  if (command === 'init') { await initConfig(path); console.log(`Created ${path}`); return; }
  if (!['serve', 'check'].includes(command)) throw new Error('Unknown command. Use --help.');
  const config = await loadConfig(path);
  if (config.sync.folder) assertLocalConfig(path, config.sync.folder);
  if (command === 'check') {
    await new SkillStore(config.skills).validate();
    console.log(`Config valid: ${Object.keys(config.servers).length} servers, ${Object.keys(config.skills).length} skills (none started).`);
    return;
  }
  const runtime = new HubRuntime(path);
  const { hub } = await runtime.get();
  await hub.refresh();
  const server = createServer(hub, async () => (await runtime.get()).hub);
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    await runtime.close();
    await server.close();
  })();
  server.server.onclose = () => { void shutdown(); };
  process.once('SIGINT', () => { void shutdown(); });
  process.once('SIGTERM', () => { void shutdown(); });
  process.stdin.once('end', () => { void shutdown(); });
  await server.connect(transport);
}

main().catch(error => {
  // Schema errors may contain Skill contents or config secrets; keep those off stderr.
  console.error(error instanceof Error && error.name !== 'ZodError' ? error.message : 'Hub operation failed: invalid configuration or shared data.');
  process.exitCode = 1;
});
