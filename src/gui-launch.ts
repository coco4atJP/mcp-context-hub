import { fork, type ForkOptions, type SpawnOptions } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openGuiBrowser } from './gui.js';
import { runningGui, sessionUrl } from './daemon.js';

export async function launchGui(configPath: string, port?: number, options: { open?: boolean; resident?: boolean; invitation?: string } = {}): Promise<string> {
  const existing = await runningGui(configPath);
  let url = existing ? sessionUrl(existing) : undefined;
  if (!url) {
  const args = options.resident ? ['daemon'] : ['gui', '--no-open'];
  // Node forwards this spawn option through fork; ForkOptions currently omits it from its declaration.
  const workerOptions: ForkOptions & Pick<SpawnOptions, 'windowsHide'> = {
    detached: true, windowsHide: true, execArgv: [], stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  };
  const child = fork(fileURLToPath(new URL('./cli.js', import.meta.url)), [...args, '--config', configPath, ...(port ? ['--port', String(port)] : [])], workerOptions);
  url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('GUIの起動がタイムアウトしました。')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => {
      clearTimeout(timer);
      void (async () => {
        // A simultaneous launch may have acquired the listener but not yet written its session file.
        for (let attempt = 0; attempt < 10; attempt++) {
          const existing = await runningGui(configPath);
          if (existing) { resolve(sessionUrl(existing)); return; }
          await new Promise(done => setTimeout(done, 75));
        }
        reject(new Error('GUIを起動できませんでした。gui --no-open で詳細を確認できます。'));
      })();
    });
    child.once('message', data => {
      clearTimeout(timer);
      if (!data || typeof data !== 'object' || !('url' in data) || typeof data.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/.test(data.url)) {
        child.kill(); reject(new Error('Invalid GUI startup response.')); return;
      }
      child.disconnect(); child.unref(); resolve(data.url);
    });
  });
  }
  if (options.invitation) url += '&pair=' + encodeURIComponent(options.invitation);
  if (options.open !== false) await openGuiBrowser(url).catch(() => {});
  return url;
}
