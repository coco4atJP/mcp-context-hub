import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { openGuiBrowser } from './gui.js';

export async function launchGui(configPath: string, port?: number): Promise<string> {
  const child = fork(fileURLToPath(new URL('./cli.js', import.meta.url)), ['gui', '--no-open', '--config', configPath, ...(port ? ['--port', String(port)] : [])], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('GUIの起動がタイムアウトしました。')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', () => { clearTimeout(timer); reject(new Error('GUIを起動できませんでした。gui --no-open で詳細を確認できます。')); });
    child.once('message', data => {
      clearTimeout(timer);
      if (!data || typeof data !== 'object' || !('url' in data) || typeof data.url !== 'string' || !/^http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}$/.test(data.url)) {
        child.kill(); reject(new Error('Invalid GUI startup response.')); return;
      }
      child.disconnect(); child.unref(); resolve(data.url);
    });
  });
  await openGuiBrowser(url).catch(() => {});
  return url;
}
