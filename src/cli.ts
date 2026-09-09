#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configPath, initConfig, loadConfig } from './config.js';
import { Hub } from './hub.js';
import { createServer } from './server.js';
import { installHubSkill, SkillStore } from './skills.js';
import { Registry } from './registry.js';
import { DeviceState } from './device.js';
import { SyncManager } from './sync.js';
import { assertLocalConfig } from './settings.js';
import { settingsCommand } from './cli-settings.js';

async function main() {
  const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, 'skills-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    folder: { type: 'string' }, server: { type: 'string' }, revision: { type: 'string' } }, allowPositionals: true });
  if (values.help) {
    console.log('mcp-context-hub [serve|init|check|config-path] [--config /absolute/config.json]\nmcp-context-hub install-skill [--skills-dir /path/to/skills]\nDefault command: serve. Config: MCP_HUB_CONFIG or ~/.config/mcp-context-hub/config.json');
    console.log('mcp-context-hub sync connect --folder EXISTING_ABSOLUTE_PATH\nmcp-context-hub sync disconnect|status\nmcp-context-hub sync publish|inspect|remove --server ID\nmcp-context-hub sync approve|resolve --server ID --revision SHA256\nmcp-context-hub security show|reset\nmcp-context-hub security set KEY on|off\nAll commands accept --config. Sync uses an existing shared folder; it does not mount shares or upload to a cloud service. Security and folder/binding changes require a Hub restart.');
    return;
  }
  const command = positionals[0] ?? 'serve';
  if (!['sync', 'security'].includes(command) && positionals.length > 1) throw new Error('Expected at most one command. Use --help.');
  if (values['skills-dir'] && command !== 'install-skill') throw new Error('--skills-dir is only valid for install-skill.');
  if (command !== 'sync' && (values.folder || values.server || values.revision)) throw new Error('Sync flags require the sync command.');
  if (command === 'install-skill') { console.log(`Installed ${await installHubSkill(values['skills-dir'])}`); return; }
  const path = configPath(values.config);
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
  const hub = new Hub(config, new Registry(path + '.agents.json'), { sync: new SyncManager(config, path), device: new DeviceState(path + '.device.json') });
  await hub.refresh();
  const server = createServer(hub);
  const transport = new StdioServerTransport();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = () => shutdownPromise ??= (async () => {
    await hub.close();
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
