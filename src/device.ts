import { z } from 'zod';
import { idSchema } from './config.js';
import { LocalStore } from './storage.js';

const schema = z.object({ version: z.literal(1), enabled: z.record(idSchema, z.boolean()) }).strict();
export class DeviceState extends LocalStore<z.infer<typeof schema>> {
  constructor(path: string) { super(path, input => schema.parse(input), () => ({ version: 1, enabled: {} })); }
  async set(id: string, enabled: boolean) { await this.mutate(state => { state.enabled[id] = enabled; }); }
}
