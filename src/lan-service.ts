import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { HubError } from './errors.js';
import { atomicWrite, readText } from './storage.js';
import { urlHandlerConfigPath } from './config.js';

const run = promisify(execFile);
const label = 'jp.coco4at.mcp-context-hub';
const cli = fileURLToPath(new URL('./cli.js', import.meta.url));
const xml = (text: string) => text.replace(/[<>&"']/g, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!);
const ps = (text: string) => "'" + text.replace(/'/g, "''") + "'";
const sh = (text: string) => "'" + text.replace(/'/g, "'\\''") + "'";
const apple = (text: string) => '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
export function windowsArg(value: string): string {
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, '$1$1') + '"';
}

/** Generated scripts interpolate only correctly quoted local paths; URLs are validated by handle-url. */
export function servicePlan(platform: string, root: string, node: string, entry: string, config: string) {
  if (platform === 'darwin') {
    const path = join(root, 'Library', 'LaunchAgents', label + '.plist');
    const app = join(root, 'Applications', 'MCP Context Hub.app');
    const args = [node, entry, 'daemon', '--config', config];
    const plist = `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args.map(value => `<string>${xml(value)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>10</integer></dict></plist>\n`;
    const launch = `${sh(node)} ${sh(entry)}`;
    const script = `on run\n do shell script ${apple(launch + ' gui >/dev/null 2>&1 &')}\nend run\non open location incomingURL\n do shell script ${apple(launch + ' handle-url ')} & quoted form of incomingURL & ${apple(' >/dev/null 2>&1 &')}\nend open location\n`;
    return { platform: 'darwin' as const, path, app, plist, script };
  }
  if (platform === 'win32') {
    const task = [entry, 'daemon', '--config', config].map(windowsArg).join(' ');
    const launch = `Start-Process -WindowStyle Hidden -FilePath ${ps(node)} -ArgumentList ${ps(task)}`;
    const encoded = Buffer.from(launch, 'utf16le').toString('base64');
    const autorun = `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${encoded}`;
    const protocol = [node, entry, 'handle-url'].map(windowsArg).join(' ') + ' "%1"';
    const script = `$ErrorActionPreference='Stop'; New-Item -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Force | Out-Null; Set-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'McpContextHub' -Value ${ps(autorun)}; New-Item -Path 'HKCU:\\Software\\Classes\\mcp-context-hub\\shell\\open\\command' -Force | Out-Null; Set-Item -Path 'HKCU:\\Software\\Classes\\mcp-context-hub' -Value 'URL:MCP Context Hub'; Set-ItemProperty -Path 'HKCU:\\Software\\Classes\\mcp-context-hub' -Name 'URL Protocol' -Value ''; Set-Item -Path 'HKCU:\\Software\\Classes\\mcp-context-hub\\shell\\open\\command' -Value ${ps(protocol)}`;
    return { platform: 'win32' as const, script };
  }
  throw new HubError('自動起動とURL登録はmacOS / Windowsに対応しています。ほかのOSでは lan start を使ってください。');
}

export async function serviceStatus(path: string): Promise<boolean> {
  try { const info = JSON.parse(await readText(path + '.service.json', 4096)); return info.platform === process.platform && info.config === path; } catch { return false; }
}

export async function installService(path: string) {
  // A URL has no authority to choose a profile or change flags. One user-level handler owns the default profile.
  if (path !== urlHandlerConfigPath()) throw new HubError('自動起動とURL登録は ~/.config/mcp-context-hub/config.json で実行してください。別プロファイルはURL貼り付けとCLIを使えます。');
  const plan = servicePlan(process.platform, homedir(), process.execPath, cli, path);
  if (plan.platform === 'darwin') {
    const existing = await lstat(plan.app).catch(error => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (existing) {
      const owned = !existing.isSymbolicLink() && await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', join(plan.app, 'Contents', 'Info.plist')])
        .then(value => value.stdout.trim() === label).catch(() => false);
      if (!owned) throw new HubError('同じ名前の別アプリがあります。~/Applications/MCP Context Hub.app を確認してください。');
    }
    await mkdir(dirname(plan.path), { recursive: true }); await mkdir(dirname(plan.app), { recursive: true });
    const source = path + '.url-handler.applescript';
    await writeFile(source, plan.script, { mode: 0o600 });
    try { await run('/usr/bin/osacompile', ['-o', plan.app, source], { timeout: 20000 }); } finally { await rm(source, { force: true }); }
    const info = join(plan.app, 'Contents', 'Info.plist');
    const plistBuddy = '/usr/libexec/PlistBuddy';
    await run(plistBuddy, ['-c', `Set :CFBundleIdentifier ${label}`, info]).catch(() => run(plistBuddy, ['-c', `Add :CFBundleIdentifier string ${label}`, info]));
    await run(plistBuddy, ['-c', 'Delete :CFBundleURLTypes', info]).catch(() => {});
    for (const command of ['Add :CFBundleURLTypes array', 'Add :CFBundleURLTypes:0 dict', `Add :CFBundleURLTypes:0:CFBundleURLName string ${label}`,
      'Add :CFBundleURLTypes:0:CFBundleURLSchemes array', 'Add :CFBundleURLTypes:0:CFBundleURLSchemes:0 string mcp-context-hub']) {
      await run(plistBuddy, ['-c', command, info]);
    }
    await run(plistBuddy, ['-c', 'Set :LSUIElement true', info]).catch(() => run(plistBuddy, ['-c', 'Add :LSUIElement bool true', info]));
    await run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-f', plan.app], { timeout: 15000 });
    const domain = `gui/${process.getuid!()}`;
    await atomicWrite(plan.path, plan.plist);
    const loaded = await run('/bin/launchctl', ['print', domain + '/' + label]).then(() => true).catch(() => false);
    if (!loaded) await run('/bin/launchctl', ['bootstrap', domain, plan.path], { timeout: 10000 });
  } else {
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(plan.script, 'utf16le').toString('base64')], { timeout: 20000 });
  }
  await atomicWrite(path + '.service.json', JSON.stringify({ platform: process.platform, config: path }));
  return { ok: true };
}

export async function uninstallService(path: string) {
  if (path !== urlHandlerConfigPath()) throw new HubError('既定の設定ファイルで実行してください。');
  if (process.platform === 'darwin') {
    const agent = join(homedir(), 'Library', 'LaunchAgents', label + '.plist');
    const app = join(homedir(), 'Applications', 'MCP Context Hub.app');
    // Only remove this application's generated artifacts, never an unrelated app with the same display name.
    const info = join(app, 'Contents', 'Info.plist');
    const owned = await run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', info]).then(value => value.stdout.trim() === label).catch(() => false);
    if (owned) {
      await run('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', ['-u', app]).catch(() => {});
      await rm(app, { recursive: true });
    }
    if ((await readFile(agent, 'utf8').catch(() => '')).includes(`<string>${label}</string>`)) await rm(agent);
    // Bootout can terminate the current process; removing RunAtLoad is enough. CLI lan stop stops the active worker.
  } else if (process.platform === 'win32') {
    const script = "$ErrorActionPreference='Stop'; Remove-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run' -Name 'McpContextHub' -ErrorAction SilentlyContinue; Remove-Item -LiteralPath 'HKCU:\\Software\\Classes\\mcp-context-hub' -Recurse -Force -ErrorAction SilentlyContinue";
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 20000 });
  } else throw new HubError('このOSでは自動起動を登録していません。');
  await rm(path + '.service.json', { force: true }); return { ok: true };
}
