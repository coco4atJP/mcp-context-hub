import { resolve, relative, isAbsolute, sep } from 'node:path';
import { configSchema, securityDefaults, securitySchema } from './config.js';
import { HubError } from './errors.js';
import { LocalStore } from './storage.js';
import { createHash } from 'node:crypto';

export const settingsRevision = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');

export function assertLocalConfig(configPath: string, folder: string): void {
  const inside = relative(resolve(folder), resolve(configPath));
  if (!inside || (inside !== '..' && !inside.startsWith('..' + sep) && !isAbsolute(inside))) {
    throw new HubError('Owner config, device state and sync cache must be outside the shared folder.');
  }
}

export async function editSettings(path: string, change: (data: Record<string, unknown>) => void, expectedRevision?: string): Promise<void> {
  const store = new LocalStore<Record<string, unknown>>(path, input => {
    configSchema.parse(input);
    return input as Record<string, unknown>;
  }, () => { throw new HubError('Initialize the owner config first.'); });
  await store.mutate(data => {
    if (expectedRevision && settingsRevision(data) !== expectedRevision) throw new HubError('設定が別の画面またはCLIで更新されました。再読み込みしてから操作してください。');
    change(data);
  });
}

export async function setSecurity(path: string, key: string, value: boolean, expectedRevision?: string): Promise<void> {
  if (!Object.hasOwn(securityDefaults, key)) throw new HubError('Unknown security switch. Use security show.');
  await editSettings(path, data => {
    data.security = securitySchema.parse({ ...(data.security as Record<string, unknown> | undefined), [key]: value });
  }, expectedRevision);
}
