#!/usr/bin/env node
import { readText } from './storage.js';
import { actionSchema, control } from './control.js';
import { editSettings } from './settings.js';
import { parseArgs } from 'node:util';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { configPath, initConfig, loadConfig, urlHandlerConfigPath } from './config.js';
import { createServer } from './server.js';
import { installHubSkill, SkillStore } from './skills.js';
import { assertLocalConfig } from './settings.js';
import { settingsCommand } from './cli-settings.js';
import { HubRuntime } from './runtime.js';
import { launchGui } from './gui-launch.js';
import { managedGui } from './daemon.js';
import { lanCommand } from './cli-lan.js';
import { parseInvitation } from './lan-network.js';

async function main() {
  // Custom URL handlers must never let shell/registry quoting add CLI flags or select another config.
  if (process.argv[2] === 'handle-url') {
    if (process.argv.length !== 4) throw new Error('Invalid pairing URL invocation.');
    parseInvitation(process.argv[3]!);
    await launchGui(urlHandlerConfigPath(), undefined, { invitation: process.argv[3] }); return;
  }
  const { values, positionals } = parseArgs({ options: { config: { type: 'string' }, 'skills-dir': { type: 'string' }, help: { type: 'boolean', short: 'h' },
    input: { type: 'string' }, target: { type: 'string' }, overwrite: { type: 'boolean' }, folder: { type: 'string' }, server: { type: 'string' }, revision: { type: 'string' }, port: { type: 'string' }, 'no-open': { type: 'boolean' }, url: { type: 'string' }, session: { type: 'string' }, peer: { type: 'string' } }, allowPositionals: true });
  if (values.help) {
    console.log('mcp-context-hub [serve|init|check|config-path] [--config /absolute/config.json]\nmcp-context-hub install-skill [--skills-dir /path/to/skills]\nDefault command: serve. Config: MCP_HUB_CONFIG or ~/.config/mcp-context-hub/config.json');
    console.log('mcp-context-hub gui [--no-open] [--port PORT]\nmcp-context-hub sync connect --folder EXISTING_ABSOLUTE_PATH\nmcp-context-hub sync disconnect|status\nmcp-context-hub sync publish|inspect|remove --server ID\nmcp-context-hub sync approve|resolve --server ID --revision SHA256\nmcp-context-hub security show|reset\nmcp-context-hub security set KEY on|off\nAll commands accept --config. Sync uses an existing shared folder. GUI opens locally; --no-open runs in the foreground. Owner config changes apply on the next MCP request.');
    console.log('mcp-context-hub lan start|stop|status|disable|install|uninstall|invite|cancel\nmcp-context-hub lan pair --url INVITATION_URL\nmcp-context-hub lan confirm --session ID\nmcp-context-hub lan unpair --peer FINGERPRINT\nLAN pairing uses a one-time URL and confirmation on both devices. install registers login startup and URL handling on macOS/Windows. daemon runs the worker in the foreground.');
    console.log('mcp-context-hub security preset standard|full\nmcp-context-hub control ACTION [--server ID] [--input OPTIONS_JSON_FILE]\nmcp-context-hub agents enable|disable|status|preview|sync\nmcp-context-hub agents configure --input SETTINGS_JSON_FILE\nmcp-context-hub agents inspect|publish|apply|resolve|remove --target RELATIVE_PATH [--revision SHA256] [--overwrite]\ncontrol uses Agent permissions; security/agents CLI commands are owner operations.');
    return;
  }
  const command = positionals[0] ?? 'serve';
  if (!['sync', 'security', 'lan', 'control', 'agents'].includes(command) && positionals.length > 1) throw new Error('Expected at most one command. Use --help.');
  if (values.input && !['control','agents'].includes(command)) throw new Error('--input requires control or agents.');
  if ((values.target || values.overwrite) && command !== 'agents') throw new Error('--target/--overwrite require agents.');
  if (values['skills-dir'] && command !== 'install-skill') throw new Error('--skills-dir is only valid for install-skill.');
  if (!['sync','control','agents'].includes(command) && (values.folder || values.server || values.revision)) throw new Error('Sync flags require the sync command.');
  if (!['gui', 'daemon'].includes(command) && (values.port !== undefined || values['no-open'])) throw new Error('--port and --no-open require gui.');
  if (command !== 'lan' && (values.url || values.session || values.peer)) throw new Error('--url, --session and --peer require lan.');
  if (command === 'install-skill') { console.log(`Installed ${await installHubSkill(values['skills-dir'])}`); return; }
  const path = configPath(values.config);
  if (command === 'control' || command === 'agents') {
    if (positionals.length > 2) throw new Error('Unexpected arguments.');
    const input = values.input ? JSON.parse(await readText(values.input, 1024 * 1024)) : {};
    if (command === 'agents' && ['enable','disable','configure'].includes(positionals[1] ?? '')) {
      await editSettings(path, data => { data.globalAgents = positionals[1] === 'configure' ? input : {...(data.globalAgents as object ?? {}), enabled:positionals[1]==='enable'}; });
      console.log(JSON.stringify({globalAgents:(await loadConfig(path)).globalAgents}));return;
    }
    const runtime = new HubRuntime(path);
    try {
      const {hub, globals} = await runtime.get(); await hub.refresh();
      const result = command === 'control' ? await control(hub, actionSchema.parse(positionals[1]), values.server, input)
        : await globals.control({ operation:positionals[1] ?? 'status', ...input, ...(values.target ? {target:values.target}:{}), ...(values.revision ? {revision:values.revision}:{}), ...(values.overwrite ? {overwrite:true}:{}) },true);
      console.log(JSON.stringify(result,null,2));
    } finally {await runtime.close();}
    return;
  }
  if (await lanCommand(path, positionals, values)) return;
  if (command === 'gui' || command === 'daemon') {
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('Port must be 0–65535.');
    if (command === 'gui' && !values['no-open']) { console.log(`Context Hub GUI: ${await launchGui(path, port)}`); return; }
    const { gui, url } = await managedGui(path, port, command === 'daemon');
    if (process.send) process.send({ url }); else console.log(`Context Hub GUI: ${url}`);
    if (gui) {
      process.once('SIGINT', () => { void gui.close(); });
      process.once('SIGTERM', () => { void gui.close(); });
    }
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
