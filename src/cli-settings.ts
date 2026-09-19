import { isAbsolute } from 'node:path';
import { realpath } from 'node:fs/promises';
import { loadConfig, securityDefaults } from './config.js';
import { Hub } from './hub.js';
import { Registry } from './registry.js';
import { DeviceState } from './device.js';
import { SyncManager } from './sync.js';
import { assertLocalConfig, editSettings, setSecurity, setSecurityPreset } from './settings.js';

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
export async function settingsCommand(path: string, args: string[], flags: { folder?: string; server?: string; revision?: string }): Promise<boolean> {
  const [command, operation = command === 'security' ? 'show' : 'status'] = args;
  if (command === 'security') {
    if (operation === 'show' && args.length <= 2) { print((await loadConfig(path)).security); return true; }
    if (operation === 'preset' && args.length === 3 && ['standard','full'].includes(args[2]!)) await setSecurityPreset(path, args[2] as 'standard' | 'full');
    else if (operation === 'reset' && args.length === 2) await editSettings(path, data => { data.security = { ...securityDefaults }; });
    else if (operation === 'set' && args.length === 4 && ['on', 'off'].includes(args[3]!)) await setSecurity(path, args[2]!, args[3] === 'on');
    else throw new Error('Use security show|reset, security preset standard|full, or security set KEY on|off.');
    print({ security: (await loadConfig(path)).security, appliesOnNextRequest: true });
    return true;
  }
  if (command !== 'sync') return false;
  if (args.length > 2) throw new Error('Unexpected sync arguments. Use --help.');
  const { folder, server, revision } = flags;
  if (operation === 'connect') {
    if (!folder || !isAbsolute(folder) || server || revision) throw new Error('Use sync connect --folder EXISTING_ABSOLUTE_PATH.');
    const actualFolder = await realpath(folder);
    assertLocalConfig(await realpath(path), actualFolder);
    await SyncManager.initialize(actualFolder);
    await editSettings(path, data => { data.sync = { ...(data.sync as object ?? {}), mode: 'folder', folder: actualFolder }; });
    print({ folder: actualFolder, appliesOnNextRequest: true });
    return true;
  }
  if (operation === 'disconnect') {
    if (folder || server || revision) throw new Error('Use sync disconnect without additional flags.');
    await editSettings(path, data => { const sync = { ...(data.sync as Record<string, unknown> ?? {}) }; delete sync.folder; sync.mode = 'folder'; data.sync = sync; });
    print({ connected: false, appliesOnNextRequest: true }); return true;
  }
  if (folder) throw new Error('--folder is only valid for sync connect.');
  if (!['status', 'inspect', 'approve', 'resolve', 'publish', 'remove'].includes(operation)) throw new Error('Unknown sync operation. Use --help.');
  if (operation !== 'status' && !server) throw new Error('Specify --server ID.');
  if (operation === 'status' && (server || revision)) throw new Error('Sync status takes no server or revision.');
  if (['approve', 'resolve'].includes(operation) && !/^[a-f0-9]{64}$/.test(revision ?? '')) throw new Error('Specify --revision SHA256 from sync status/inspect.');
  if (['publish', 'remove'].includes(operation) && revision) throw new Error('This operation does not take --revision.');
  const config = await loadConfig(path);
  if (config.sync.folder) assertLocalConfig(path, config.sync.folder);
  const sync = new SyncManager(config, path);
  const hub = new Hub(config, new Registry(path + '.agents.json'), { sync, device: new DeviceState(path + '.device.json') });
  try {
    if (operation === 'inspect') { print(await sync.inspect(server!, revision)); return true; }
    if (operation === 'approve') { await sync.approve(server!, revision!); print({ server, accepted: revision }); return true; }
    if (operation === 'resolve') { print({ server, revision: await sync.resolve(server!, revision!) }); return true; }
    await sync.pull(true);
    await hub.refresh();
    if (operation === 'status') {
      let offset = 0;
      do { const page = await sync.status(offset, 20); print(page); if (page.nextOffset === undefined) break; offset = page.nextOffset; } while (true);
    } else print(await hub.syncControl(operation as 'publish' | 'remove', server, 0, 5, true));
  } finally { await hub.close(); }
  return true;
}
