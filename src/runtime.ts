import { configSchema, type Config } from './config.js';
import { Hub, HubError } from './hub.js';
import { Registry } from './registry.js';
import { DeviceState } from './device.js';
import { SyncManager } from './sync.js';
import { readText } from './storage.js';
import { assertLocalConfig, settingsRevision } from './settings.js';

export type RuntimeSnapshot = { config: Config; raw: Record<string, unknown>; revision: string; hub: Hub; sync: SyncManager };

/** Each request observes owner settings. Replacing a profile cancels the old connections before use. */
export class HubRuntime {
  private snapshot?: RuntimeSnapshot;
  private tail: Promise<unknown> = Promise.resolve();
  private closed = false;
  constructor(readonly path: string) {}

  get(): Promise<RuntimeSnapshot> {
    const next = this.tail.then(async () => {
      if (this.closed) throw new HubError('Hub is shutting down.');
      let config: Config;
      let raw: Record<string, unknown>;
      try {
        raw = JSON.parse(await readText(this.path, 8 * 1024 * 1024));
        config = configSchema.parse(raw);
        if (config.sync.folder) assertLocalConfig(this.path, config.sync.folder);
      } catch {
        await this.snapshot?.hub.close(); this.snapshot = undefined;
        throw new HubError('設定ファイルを読み込めません。設定内容と保存先を確認してください。');
      }
      const revision = settingsRevision(raw);
      if (this.snapshot?.revision === revision) return this.snapshot;
      await this.snapshot?.hub.close();
      const sync = new SyncManager(config, this.path);
      const hub = new Hub(config, new Registry(this.path + '.agents.json'), { sync, device: new DeviceState(this.path + '.device.json') });
      this.snapshot = { config, raw, revision, hub, sync };
      return this.snapshot;
    });
    this.tail = next.catch(() => {});
    return next;
  }

  async close(): Promise<void> { this.closed = true; await this.tail; await this.snapshot?.hub.close(); }
}
