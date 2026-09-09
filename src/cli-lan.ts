import { editSettings } from './settings.js';
import { launchGui } from './gui-launch.js';
import { localRequest, runningGui } from './daemon.js';
import { installService, uninstallService } from './lan-service.js';
import { parseInvitation } from './lan-network.js';

export async function lanCommand(path: string, args: string[], flags: { url?: string; session?: string; peer?: string }) {
  if (args[0] !== 'lan') return false;
  const op = args[1] ?? 'status';
  if (args.length > 2 || !['start', 'stop', 'disable', 'status', 'install', 'uninstall', 'invite', 'pair', 'confirm', 'unpair', 'cancel'].includes(op)) throw new Error('Unknown LAN operation. Use --help.');
  if (flags.url && op !== 'pair' || flags.session && op !== 'confirm' || flags.peer && op !== 'unpair') throw new Error('Unexpected LAN flags. Use --help.');
  if (op === 'pair') parseInvitation(flags.url ?? '');
  if (op === 'start' || op === 'pair' || op === 'invite' || op === 'install') {
    await editSettings(path, data => { data.sync = { ...(data.sync as object ?? {}), mode: 'lan' }; });
    await launchGui(path, undefined, { open: false, resident: true });
  }
  if (op === 'install') { console.log(JSON.stringify(await installService(path))); return true; }
  if (op === 'uninstall') { console.log(JSON.stringify(await uninstallService(path))); return true; }
  if (op === 'disable') await editSettings(path, data => { data.sync = { ...(data.sync as object ?? {}), mode: 'folder' }; });
  const session = await runningGui(path);
  if (!session) {
    if (['status', 'stop', 'disable'].includes(op)) { console.log(JSON.stringify({ running: false })); return true; }
    throw new Error('Run mcp-context-hub lan start first.');
  }
  let result: unknown;
  if (op === 'stop') result = await localRequest(session, '/api/stop', {});
  else if (['status', 'start', 'disable'].includes(op)) result = await localRequest(session, '/api/lan');
  else result = await localRequest(session, '/api/lan', { action: op === 'pair' ? 'join' : op, ...(flags.url ? { url: flags.url } : {}), ...(flags.session ? { session: flags.session } : {}), ...(flags.peer ? { peer: flags.peer } : {}) });
  console.log(JSON.stringify(result, null, 2)); return true;
}
