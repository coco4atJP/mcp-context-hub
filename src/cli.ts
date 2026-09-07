#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configPath, initConfig, loadConfig } from './config.js';
import { Hub } from './hub.js';
import { createServer } from './server.js';
import { installHubSkill, SkillStore } from './skills.js';
import { Registry } from './registry.js';

async function main() {
  const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, 'skills-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' } }, allowPositionals: true });
  if (values.help) {
    console.log('mcp-context-hub [serve|init|check|config-path] [--config /absolute/config.json]\nmcp-context-hub install-skill [--skills-dir /path/to/skills]\nDefault command: serve. Config: MCP_HUB_CONFIG or ~/.config/mcp-context-hub/config.json');
    return;
  }
  const command = positionals[0] ?? 'serve';
  if (positionals.length > 1) throw new Error('Expected at most one command. Use --help.');
  if (values['skills-dir'] && command !== 'install-skill') throw new Error('--skills-dir is only valid for install-skill.');
  if (command === 'install-skill') { console.log(`Installed ${await installHubSkill(values['skills-dir'])}`); return; }
  const path = configPath(values.config);
  if (command === 'config-path') { console.log(path); return; }
  if (command === 'init') { await initConfig(path); console.log(`Created ${path}`); return; }
  if (!['serve', 'check'].includes(command)) throw new Error('Unknown command. Use --help.');
  const config = await loadConfig(path);
  if (command === 'check') {
    await new SkillStore(config.skills).validate();
    console.log(`Config valid: ${Object.keys(config.servers).length} servers, ${Object.keys(config.skills).length} skills (none started).`);
    return;
  }
  const hub = new Hub(config, new Registry(path + '.agents.json'));
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

main().catch(error => { console.error(error instanceof Error ? error.message : 'Hub startup failed.'); process.exitCode = 1; });
