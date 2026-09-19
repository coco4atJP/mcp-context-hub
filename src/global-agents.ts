import { mkdir, readdir, lstat, rename, rm, rmdir, chmod } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.js';
import { SyncManager } from './sync.js';
import { LocalStore, readBytes, directory, atomicWrite } from './storage.js';
import { assertLocalConfig } from './settings.js';
import { HubError } from './errors.js';
import { decodeFile, globalBundleSchema, globalId, globalTarget, hashBytes, portablePath, validateGlobalBundle, type GlobalBundle, type GlobalFile } from './global-format.js';

const hash = z.string().regex(/^[a-f0-9]{64}$/);
const entrySchema = z.object({ target: z.string().refine(globalTarget), revision: hash, files: z.record(z.string(), hash) }).strict();
const stateSchema = z.object({ entries: z.record(z.string(), entrySchema) }).strict();
const revisionSchema = hash.optional();
const issuesSchema = z.object({ issues: z.array(z.object({ target: z.string(), error: z.string() }).strict()).max(600) }).strict();
export const globalActionSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('status'), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) }).strict(),
  z.object({ operation: z.literal('preview') }).strict(),
  z.object({ operation: z.literal('sync') }).strict(),
  z.object({ operation: z.literal('inspect'), target: z.string().refine(globalTarget), revision: revisionSchema, file: z.string().max(240).optional() }).strict(),
  z.object({ operation: z.literal('publish'), target: z.string().refine(globalTarget), revision: revisionSchema }).strict(),
  z.object({ operation: z.literal('apply'), target: z.string().refine(globalTarget), revision: hash, overwrite: z.boolean().default(false) }).strict(),
  z.object({ operation: z.literal('resolve'), target: z.string().refine(globalTarget), revision: hash }).strict(),
  z.object({ operation: z.literal('remove'), target: z.string().refine(globalTarget), revision: hash }).strict(),
]);

/** The transport stores opaque revisions. Only this local, owner-selected scope can materialize ~/.agents. */
export class GlobalAgents {
  readonly root: string;
  private readonly store: LocalStore<z.infer<typeof stateSchema>>;
  private issues: { target: string; error: string }[] = [];
  private pending?: Promise<void>;
  private closed = false;
  private readonly issueStore: LocalStore<z.infer<typeof issuesSchema>>;
  private lastCycle = 0;
  constructor(readonly config: Config, readonly configPath: string, readonly sync: SyncManager, private readonly guard: () => Promise<void> = async () => {}) {
    this.root = config.globalAgents.root ?? join(homedir(), '.agents');
    assertLocalConfig(configPath, this.root);
    this.issueStore = new LocalStore(configPath + '.global-' + hashBytes(this.root).slice(0, 16) + '.issues.json', value => issuesSchema.parse(value), () => ({ issues: [] }));
    this.store = new LocalStore(configPath + '.global-' + hashBytes(this.root).slice(0, 16) + '.json', value => stateSchema.parse(value), () => ({ entries: {} }));
  }
  private async current() {
    if (this.closed) throw new HubError('Global sync configuration is no longer active.');
    await this.guard();
  }
  async close() { this.closed = true; await this.pending?.catch(() => {}); }
  private selected(target: string): boolean {
    const scope = this.config.globalAgents;
    return scope.enabled && (target.startsWith('skills/') ? scope.skills === 'all' || scope.skills.includes(target.slice(7)) : scope.files.includes(target));
  }
  private requireSelected(target: string) {
    if (!globalTarget(target) || !this.selected(target)) throw new HubError('Global target is outside the owner-selected scope. Enable/select it in the GUI or CLI.');
  }
  private async parents(path: string, create = false) {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    await directory(this.root);
    let dir = this.root;
    for (const part of path.split('/').slice(0, -1)) {
      dir = join(dir, part);
      if (create) { try { await mkdir(dir, { mode: 0o700 }); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; } }
      await directory(dir);
    }
  }
  private async bytes(path: string): Promise<Buffer | undefined> {
    try { await this.parents(path); return await readBytes(join(this.root, path), 256 * 1024); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  }
  private filePaths(bundle: GlobalBundle): Record<string, GlobalFile> {
    return Object.fromEntries(Object.entries(bundle.files).map(([file, value]) => [bundle.target.startsWith('skills/') ? bundle.target + '/' + file : bundle.target, value]));
  }
  private fingerprint(bundle: GlobalBundle) {
    return Object.fromEntries(Object.entries(this.filePaths(bundle)).map(([file, value]) => [file, hashBytes(decodeFile(value))]));
  }
  async pack(target: string): Promise<GlobalBundle> {
    this.requireSelected(target);
    const files: GlobalBundle['files'] = {};
    const add = async (key: string, path: string) => {
      const data = await this.bytes(path); if (!data) throw new HubError('Selected global file is missing.');
      let file: GlobalFile;
      try { const content = new TextDecoder('utf8', { fatal: true }).decode(data); if (content.includes('\0')) throw new Error(); file = { encoding: 'utf8', content }; }
      catch { file = { encoding: 'base64', content: data.toString('base64') }; }
      files[key] = file;
    };
    if (target.startsWith('skills/')) {
      let seen = 0;
      const walk = async (path: string, prefix: string) => {
        await this.parents(path + '/_'); await directory(join(this.root, path));
        const items = await readdir(join(this.root, path), { withFileTypes: true });
        for (const item of items.sort((a,b) => a.name < b.name ? -1 : 1)) {
          if (++seen > 1024) throw new HubError('Global skill has too many filesystem entries.');
          if (item.name.startsWith('.') || item.name === 'node_modules') continue;
          const name = prefix + item.name;
          if (!portablePath(name)) throw new HubError('Global skill includes an unsafe or secret-like filename.');
          if (item.isSymbolicLink()) throw new HubError('Global skill symlinks require local setup; they are not followed.');
          if (item.isDirectory()) await walk(path + '/' + item.name, name + '/');
          else if (item.isFile()) await add(name, path + '/' + item.name);
          else throw new HubError('Global packages must contain regular files.');
        }
      };
      await walk(target, '');
    } else await add('content', target);
    const bundle = globalBundleSchema.parse({ kind: 'agents', target, files }); validateGlobalBundle(bundle); return bundle;
  }
  async preview(): Promise<{enabled:boolean;packages:{target:string;files:number;bytes:number}[];issues:{target:string;error:string}[]}> {
    if (!this.config.globalAgents.enabled) return new GlobalAgents({...this.config,globalAgents:{...this.config.globalAgents,enabled:true}},this.configPath,this.sync).preview();
    const targets = [...this.config.globalAgents.files];
    const issues: {target:string;error:string}[] = [];
    try {
      await directory(this.root); await directory(join(this.root, 'skills'));
      for (const item of await readdir(join(this.root, 'skills'), { withFileTypes: true })) {
        const target = 'skills/' + item.name;
        if (globalTarget(target) && this.selected(target) && !item.name.startsWith('.')) {
          if (item.isDirectory()) { const skill = await lstat(join(this.root,target,'SKILL.md')).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;}); if(skill)targets.push(target); }
          else if(item.isSymbolicLink()) issues.push({target,error:'Symlink skipped; install or copy the skill locally.'});
        }
      }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (targets.length > 600) throw new HubError('Global selection exceeds 600 packages.');
    const packages = [];
    for (const target of [...new Set(targets)].sort()) {
      try {
        await this.parents(target); await lstat(join(this.root, target));
        const bundle = await this.pack(target);
        packages.push({target, files: Object.keys(bundle.files).length, bytes: Object.values(bundle.files).reduce((n,f)=>n+decodeFile(f).length,0)});
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') issues.push({target,error:e instanceof HubError ? e.message : 'Cannot package the selected files.'});
      }
    }
    return { enabled: true, packages, issues };
  }
  async status(offset = 0, limit = 20) {
    const local = await this.store.read();
    const all = await this.sync.globalRecords();
    const entries = all.map(record => ({ target: record.bundle?.target ?? local.entries[record.id]?.target ?? record.id,
      revision: record.revision, heads: record.heads, status: record.incomplete ? 'incomplete' : record.heads.length !== 1 ? 'conflict' : !record.accepted ? 'pending-approval' : local.entries[record.id]?.revision === record.revision ? (record.bundle ? 'applied' : 'deleted') : 'needs-apply',
      selected: this.selected(record.bundle?.target ?? local.entries[record.id]?.target ?? ''),
    }));
    return { ...this.config.globalAgents, root: this.root, entries: entries.slice(offset, offset+limit), total: entries.length,
      ...(offset+limit<entries.length ? {nextOffset:offset+limit} : {}), issues: (await this.issueStore.read()).issues.slice(0,20) };
  }
  async inspect(target: string, revision?: string, file?: string) {
    const value = await this.sync.inspect(globalId(target), revision);
    const bundle = value.change.bundle;
    if (bundle && (!('kind' in bundle) || bundle.target !== target)) throw new HubError('Global target mismatch.');
    const metadata = { target, revision: value.revision, deleted: !bundle,
      files: bundle ? Object.entries(bundle.files).map(([name, f])=>({name,encoding:f.encoding,bytes:decodeFile(f).length})) : [] };
    if (!file) return metadata;
    const data = bundle?.files[file]; if (!data) throw new HubError('Unknown global file. Inspect the file list first.');
    return { ...metadata, file, ...(data.encoding === 'utf8' ? {text:data.content} : {binary:true}) };
  }
  async publish(target: string, expected?: string) {
    this.requireSelected(target);
    const bundle = await this.pack(target); const id = globalId(target);
    const previous = (await this.store.read()).entries[id];
    const remote = (await this.sync.globalRecords()).find(r=>r.id===id);
    if (remote && (remote.incomplete || remote.heads.length !== 1 || remote.revision !== (expected ?? previous?.revision))) throw new HubError('Inspect the current global revision before publishing over it.');
    await this.current();
    const revision = await this.sync.publishGlobal(bundle);
    await this.store.mutate(state=>{state.entries[id]={target,revision,files:this.fingerprint(bundle)};});
    return {target,revision,published:true};
  }
  async apply(target: string, revision: string, overwrite = false) {
    await this.current();
    this.requireSelected(target); const id = globalId(target);
    await this.sync.pull(true);
    const current = (await this.sync.globalRecords()).find(r=>r.id===id);
    if (!current || current.revision !== revision || current.incomplete || current.heads.length !== 1 || !current.accepted) throw new HubError('Apply requires the current, accepted single revision.');
    const desired = current.bundle ? this.filePaths(current.bundle) : {};
    let backup: string | undefined;
    await this.store.mutate(async state=>{
      const previous = state.entries[id];
      if (previous && previous.target !== target) throw new HubError('Global state target mismatch.');
      const paths = [...new Set([...Object.keys(previous?.files ?? {}),...Object.keys(desired)])].sort();
      // Validate the complete plan before touching files. Unrelated local files are never removed.
      const plan = [];
      for (const file of paths) {
        if (!portablePath(file) || !(target.startsWith('skills/') ? file.startsWith(target+'/') : file===target)) throw new HubError('Invalid global local state path.');
        const before = await this.bytes(file); const after = desired[file] ? decodeFile(desired[file]!) : undefined;
        const actual = before === undefined ? undefined : hashBytes(before); const wanted = after === undefined ? undefined : hashBytes(after);
        if (actual === wanted) continue;
        if (!overwrite && actual !== previous?.files[file]) throw new HubError('Local edits conflict with this revision. Review and explicitly choose overwrite; a backup will be saved.');
        plan.push({file,before,after,actual});
      }
      await this.current();
      if (plan.length) {
        const backupRoot = this.configPath + '.global-backups';
        await mkdir(backupRoot,{recursive:true,mode:0o700}); await directory(backupRoot);
        backup = join(backupRoot,randomUUID()); await mkdir(backup,{mode:0o700}); await directory(backup);
        await atomicWrite(join(backup,'backup.json'), JSON.stringify({target,revision,files:plan.map(p=>({file:p.file,before:p.before?.toString('base64') ?? null}))}));
      }
      for (const item of plan) {
        await this.current();
        await this.parents(item.file,true);
        const now = await this.bytes(item.file);
        if ((now === undefined ? undefined : hashBytes(now)) !== item.actual) throw new HubError('Local file changed during apply. Backup retained; review and retry.');
        const path = join(this.root,item.file);
        if (item.after === undefined) await rm(path,{force:true});
        else {
          const mode = await lstat(path).then(s=>s.mode & 0o777).catch(()=>0o600);
          const temporary = path+'.'+randomUUID()+'.tmp';
          try {
            // Atomic replacement preserves the existing device's executable bits, never syncs permissions.
            const {open} = await import('node:fs/promises'); const handle=await open(temporary,'wx',0o600);
            try {await handle.writeFile(item.after);await handle.sync();} finally {await handle.close();}
            await chmod(temporary,mode); await rename(temporary,path);
          } finally {await rm(temporary,{force:true});}
        }
      }
      if (!current.bundle && target.startsWith('skills/')) {
        const dirs = new Set(paths.flatMap(p=>{const d=p.split('/').slice(0,-1);const out=[];while(d.length>=2){out.push(d.join('/'));d.pop();}return out;}));
        for(const dir of [...dirs].sort((a,b)=>b.length-a.length)) {try{await this.parents(dir);await rmdir(join(this.root,dir));}catch(e){if(!['ENOENT','ENOTEMPTY','EEXIST'].includes((e as NodeJS.ErrnoException).code??''))throw e;}}
      }
      state.entries[id]={target,revision,files:current.bundle ? this.fingerprint(current.bundle) : {}};
    });
    return {target,revision,applied:true,...(backup?{backup}: {})};
  }
  cycle(force = false): Promise<void> {
    if (this.closed || !this.config.globalAgents.enabled) return Promise.resolve();
    if (this.pending) return this.pending;
    if (!force && Date.now()-this.lastCycle < this.config.sync.pollIntervalMs) return Promise.resolve();
    this.lastCycle=Date.now();
    return this.pending=this.runCycle().finally(()=>{this.pending=undefined;});
  }
  private async runCycle() {
    await this.current();
    await this.sync.pull(true); const preview=await this.preview(); this.issues=preview.issues;
    const state=await this.store.read(); const remote=await this.sync.globalRecords();
    const records=new Map(remote.map(r=>[r.id,r]));
    for(const item of preview.packages) {
      try {
        const id=globalId(item.target);const old=state.entries[id];const record=records.get(id);
        const bundle=await this.pack(item.target);
        if (old && Object.keys(this.fingerprint(bundle)).length===Object.keys(old.files).length && Object.entries(this.fingerprint(bundle)).every(([file,hash])=>old.files[file]===hash)) continue;
        if (record && record.revision!==old?.revision) continue;
        await this.publish(item.target);
      } catch(e){this.issues.push({target:item.target,error:e instanceof HubError?e.message:'Cannot publish global package.'});}
    }
    for(const [id,old] of Object.entries(state.entries)) {
      if(!this.selected(old.target) || !Object.keys(old.files).length || preview.packages.some(p=>p.target===old.target) || this.issues.some(p=>p.target===old.target))continue;
      try {
        await directory(this.root);
        if ((await lstat(join(this.root,old.target)).catch(e=>{if(e.code==='ENOENT')return undefined;throw e;}))!==undefined)continue;
        const record=records.get(id);
        if(record?.revision===old.revision && record.accepted && !record.incomplete) { await this.current(); await this.sync.remove(id); }
      } catch(e){this.issues.push({target:old.target,error:e instanceof HubError?e.message:'Cannot publish global deletion.'});}
    }
    for(const record of await this.sync.globalRecords()) {
      const target=record.bundle?.target ?? state.entries[record.id]?.target;
      if(!target || !this.selected(target) || !record.accepted || !record.revision || record.incomplete)continue;
      try {if ((await this.store.read()).entries[record.id]?.revision !== record.revision) await this.apply(target,record.revision);}catch(e){this.issues.push({target,error:e instanceof HubError?e.message:'Cannot apply global package.'});}
    }
    await this.current();
    await this.issueStore.mutate(state => { state.issues = this.issues.slice(0,600); });
  }
  async control(raw: unknown, owner = false): Promise<unknown> {
    const parsed=globalActionSchema.safeParse(raw); if(!parsed.success)throw new HubError('Invalid agents options. Read hub_control help for agents.');
    const op=parsed.data;
    if(op.operation==='status')return this.status(op.offset,op.limit);
    if(op.operation==='inspect')return this.inspect(op.target,op.revision,op.file);
    if(!owner && !this.config.security.allowAgentGlobalFiles)throw new HubError('Owner policy disables agent global-file operations.');
    if(op.operation==='preview')return this.preview();
    if(['publish','remove','resolve','sync'].includes(op.operation) && !owner && !this.config.security.allowAgentPublish)throw new HubError('Owner policy disables agent publishing.');
    if(op.operation==='sync'){await this.cycle(true);return this.status();}
    await this.current();
    this.requireSelected(op.target);
    if(op.operation==='publish')return this.publish(op.target,op.revision);
    if(op.operation==='apply' || op.operation==='resolve') {
      if(!owner && !this.config.security.allowAgentSyncApproval)throw new HubError('Owner policy disables agent sync approval.');
      if(op.operation==='resolve')return {target:op.target,revision:await this.sync.resolve(globalId(op.target),op.revision)};
      await this.sync.approve(globalId(op.target),op.revision); return this.apply(op.target,op.revision,op.overwrite);
    }
    const current=(await this.sync.inspect(globalId(op.target))).revision;
    if(current!==op.revision)throw new HubError('Global revision changed. Inspect again before removal.');
    return {target:op.target,revision:await this.sync.remove(globalId(op.target)),deleted:true};
  }
}
