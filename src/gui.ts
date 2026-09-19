import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, extname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GuiAdmin } from './gui-admin.js';
import { HubError } from './errors.js';
import { LanController } from './lan.js';
import { installService, serviceStatus, uninstallService } from './lan-service.js';
import { z } from 'zod';

const execute = promisify(execFile);

export async function openGuiBrowser(url: string): Promise<void> {
  if (process.platform === 'darwin') await execute('/usr/bin/open', [url]);
  else if (process.platform === 'win32') await execute('rundll32.exe', ['url.dll,FileProtocolHandler', url]);
  else await execute('xdg-open', [url]);
}

async function pickFolder(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') return (await execute('/usr/bin/osascript', ['-e', 'POSIX path of (choose folder with prompt "フォルダーを選択")'], { timeout: 120000 })).stdout.trim();
    if (process.platform === 'win32') {
      const script = 'Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "MCP Context Hub"; if ($picker.ShowDialog() -eq "OK") { [Console]::OutputEncoding = [Text.Encoding]::UTF8; Write-Output $picker.SelectedPath }';
      return (await execute('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { timeout: 120000 })).stdout.trim() || null;
    }
    return (await execute('zenity', ['--file-selection', '--directory', '--title=MCP Context Hub'], { timeout: 120000 })).stdout.trim() || null;
  } catch { return null; }
}

const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
export async function startGui(options: { configPath: string; port?: number; idleTimeoutMs?: number; pickFolder?: () => Promise<string | null>; resident?: boolean; onClose?: () => Promise<void> }) {
  const admin = new GuiAdmin(options.configPath);
  await admin.runtime.get();
  const lan = new LanController(options.configPath);
  const token = randomBytes(32).toString('hex');
  const expectedAuth = Buffer.from('Bearer ' + token);
  let origin = '';
  let lastUse = Date.now();
  let closing: Promise<void> | undefined;
  let pickerActive = false;
  const assets = fileURLToPath(new URL('./gui/', import.meta.url));

  function send(res: ServerResponse, status: number, value: unknown) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value));
  }
  async function body(req: IncomingMessage): Promise<unknown> {
    if (req.headers['content-type'] !== 'application/json') throw new HubError('JSON形式で送信してください。');
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length; if (size > 1024 * 1024) throw new HubError('入力が大きすぎます。');
      chunks.push(Buffer.from(chunk));
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HubError('JSON形式を確認してください。'); }
  }
  const server = createServer({ maxHeaderSize: 8192, requestTimeout: 15000, headersTimeout: 10000 }, (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    void (async () => {
      if (req.headers.host !== new URL(origin).host || (req.headers.origin !== undefined && req.headers.origin !== origin) ||
          (req.headers['sec-fetch-site'] !== undefined && !['same-origin', 'none'].includes(String(req.headers['sec-fetch-site'])))) {
        send(res, 403, { error: 'この管理画面からの操作だけを受け付けます。' }); return;
      }
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) { send(res, 400, { error: 'Invalid path.' }); return; }
      const url = new URL(req.url, origin);
      if (url.pathname.startsWith('/api/')) {
        const auth = Buffer.from(req.headers.authorization ?? '');
        if (auth.length !== expectedAuth.length || !timingSafeEqual(auth, expectedAuth)) { send(res, 401, { error: 'GUIを起動し直してください。認証情報がありません。' }); return; }
        if (closing) { send(res, 503, { error: 'GUIは終了中です。' }); return; }
        lastUse = Date.now();
        if (req.method === 'GET' && url.pathname === '/api/state') send(res, 200, { ...await admin.state(), lan: await lan.status(), serviceInstalled: await serviceStatus(options.configPath) });
        else if (req.method === 'GET' && url.pathname === '/api/health') send(res, 200, { ok: true, configPath: options.configPath });
        else if (req.method === 'GET' && url.pathname === '/api/lan') send(res, 200, await lan.status());
        else if (req.method === 'POST' && url.pathname === '/api/lan') send(res, 200, await lan.action(await body(req)));
        else if (req.method === 'POST' && url.pathname === '/api/service') {
          const value = z.object({ action: z.enum(['install', 'uninstall']) }).strict().parse(await body(req));
          send(res, 200, await (value.action === 'install' ? installService : uninstallService)(options.configPath));
        }
        else if (req.method === 'POST' && url.pathname === '/api/agents') send(res, 200, await (await admin.runtime.get()).globals.control(await body(req), true));
        else if (req.method === 'GET' && url.pathname === '/api/config') send(res, 200, await admin.readConfig());
        else if (req.method === 'GET' && url.pathname === '/api/inspect') send(res, 200, await admin.inspect(url.searchParams.get('server') ?? '', url.searchParams.get('revision') ?? undefined));
        else if (req.method === 'GET' && url.pathname === '/api/skills') send(res, 200, await admin.skills(url.searchParams.get('server') ?? ''));
        else if (req.method === 'POST' && url.pathname === '/api/action') send(res, 200, await admin.action(await body(req)));
        else if (req.method === 'POST' && url.pathname === '/api/folder') {
          await body(req);
          if (pickerActive) throw new HubError('フォルダー選択画面は既に開いています。');
          pickerActive = true;
          try { send(res, 200, { folder: await (options.pickFolder ?? pickFolder)() }); } finally { pickerActive = false; }
        } else if (req.method === 'POST' && url.pathname === '/api/close') {
          await body(req); send(res, 200, { ok: true, background: lan.active || options.resident === true });
          if (!lan.active && !options.resident) setImmediate(() => { void close(); });
        } else if (req.method === 'POST' && url.pathname === '/api/stop') {
          await body(req); send(res, 200, { ok: true }); setImmediate(() => { void close(); });
        } else send(res, 404, { error: 'その操作はありません。' });
        return;
      }
      if (req.method !== 'GET') { send(res, 405, { error: 'Method not allowed.' }); return; }
      // Only explicitly shaped build paths are served; never expose arbitrary local files.
      const path = url.pathname === '/' ? 'index.html' : /^\/assets\/[A-Za-z0-9_-]+\.(js|css|svg)$/.test(url.pathname) ? url.pathname.slice(1) : undefined;
      if (!path) { send(res, 404, { error: 'Not found.' }); return; }
      let content: Buffer;
      try { content = await readFile(join(assets, path)); } catch { send(res, 404, { error: 'GUI assets are missing. Run npm run build.' }); return; }
      res.writeHead(200, { 'Content-Type': mime[extname(path)]! }); res.end(content);
    })().catch(error => {
      if (res.headersSent) { res.end(); return; }
      send(res, 400, { error: error instanceof HubError ? error.message : '操作できませんでした。入力・保存先・設定を確認してください。' });
    });
  });
  server.keepAliveTimeout = 1000;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 0, '127.0.0.1', () => { server.off('error', reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Cannot bind GUI.');
  origin = `http://127.0.0.1:${address.port}`;
  await lan.start();
  const idle = setInterval(() => {
    if (!options.resident && !lan.active && !pickerActive && Date.now() - lastUse > (options.idleTimeoutMs ?? 300000)) void close();
  }, Math.min(options.idleTimeoutMs ?? 300000, 10000));
  idle.unref();
  function close(): Promise<void> {
    return closing ??= (async () => { clearInterval(idle); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await lan.close(); await admin.close(); await options.onClose?.(); })();
  }
  return { origin, token, url: `${origin}/#token=${token}`, close, admin, lan };
}
