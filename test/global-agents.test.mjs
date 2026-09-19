import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,rm,readdir,symlink,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {configSchema,fullAccessSecurity,securityDefaults} from '../dist/config.js';
import {GlobalAgents} from '../dist/global-agents.js';
import {globalId,globalTarget,validateGlobalBundle} from '../dist/global-format.js';
import {SyncManager} from '../dist/sync.js';
import {HubRuntime} from '../dist/runtime.js';
import {control} from '../dist/control.js';
import {setSecurityPreset,editSettings} from '../dist/settings.js';
import {validateAgentUrl} from '../dist/network.js';
const skillText=body=>'---\nname: design-guide\ndescription: Shared guidance\n---\n'+body;
async function setup(t) {
 const dir=await mkdtemp(join(tmpdir(),'hub-global-'));const folder=join(dir,'shared');await mkdir(folder);await SyncManager.initialize(folder);
 const make=async(name,security={})=>{
  const path=join(dir,name+'.json');const root=join(dir,name+'-agents');await mkdir(root);await mkdir(join(root,'skills'));
  const config=configSchema.parse({version:1,servers:{},sync:{folder},security,globalAgents:{enabled:true,root,skills:'all',files:['AGENTS.md']}});
  await writeFile(path,JSON.stringify(config));const runtime=new HubRuntime(path);t.after(()=>runtime.close());const snap=await runtime.get();return{path,root,runtime,...snap};
 };
 t.after(()=>rm(dir,{recursive:true,force:true}));const a=await make('a');const b=await make('b');
 const target='skills/design-guide';await mkdir(join(a.root,target));await mkdir(join(a.root,target,'assets'));
 await writeFile(join(a.root,target,'SKILL.md'),skillText('version one'));
 await writeFile(join(a.root,target,'assets','image.png'),Buffer.from([0x89,0x50,0x4e,0x47,0,255]));
 await writeFile(join(a.root,target,'.env'),'DO_NOT_SHARE');await writeFile(join(a.root,'.skill-lock.json'),'LOCAL_LOCK');
 await writeFile(join(a.root,'AGENTS.md'),'User instructions');return{dir,folder,a,b,target,make};
}
test('local registration, credentials and Skill paths require independent grants; full access supports update and lazy calls',async t=>{
 const {a,dir}=await setup(t);const log=join(dir,'started');
 const input={command:process.execPath,args:[resolve('test/fixture.mjs')],env:{HUB_TEST_LOG:log,HUB_TEST_SECRET:'local-only'},skillPaths:{guide:join(a.root,'skills/design-guide')}};
 await assert.rejects(a.hub.add('local',input),/allowAgentStdio/);await assert.rejects(access(log),/ENOENT/);
 await setSecurityPreset(a.path,'full');const full=await a.runtime.get();await full.hub.refresh();
 assert.equal(full.hub.securityPolicy().preset,'full');assert.equal(full.hub.registrationPolicy().localCommands,true);
 await control(full.hub,'add','local',input);await assert.rejects(access(log),/ENOENT/);
 const summary=await full.hub.catalog('',0,5,'local');assert.equal(summary.skills.length,1);
 assert.match((await full.hub.skill('local',summary.skills[0].skill)).content,/version one/);
 const first=JSON.parse((await full.hub.call('local','echo',{message:'first'})).content[0].text);assert.equal(first.secret,'local-only');
 await control(full.hub,'update','local',{...input,env:{HUB_TEST_LOG:log,HUB_TEST_SECRET:'updated'}});
 const next=JSON.parse((await full.hub.call('local','echo',{})).content[0].text);assert.equal(next.secret,'updated');assert.notEqual(first.pid,next.pid);
 await assert.rejects(control(full.hub,'security',undefined,{preset:'full'}),/Invalid security/);
 await assert.rejects(full.hub.add('policy',{...input,security:{requireSyncApproval:false}}),/Invalid registration/);
 await setSecurityPreset(a.path,'standard');const restricted=await a.runtime.get();await restricted.hub.refresh();
 assert.match((await restricted.hub.catalog()).servers[0].blocked,/allowAgentStdio/);
 await assert.rejects(restricted.hub.call('local','echo',{}),/allowAgentStdio/);await restricted.hub.remove('local');assert.equal((await restricted.hub.catalog()).total,0);
});
test('raw local commands retain their device binding after publish and shared update, without exporting command or credentials',async t=>{
 const {a,folder}=await setup(t);await setSecurityPreset(a.path,'full');const {hub,sync}=await a.runtime.get();await hub.refresh();
 const input={command:process.execPath,args:[resolve('test/fixture.mjs')],env:{HUB_TEST_SECRET:'DEVICE_SECRET'},description:'original'};
 await hub.add('local',input);const published=await hub.syncControl('publish','local');
 const serialized=await readFile(join(folder,'mcp-context-hub-v1','changes',published.revision+'.json'),'utf8');
 assert.equal(serialized.includes('DEVICE_SECRET'),false);assert.equal(serialized.includes(process.execPath),false);
 assert.equal(JSON.parse((await hub.call('local','echo',{})).content[0].text).secret,'DEVICE_SECRET');
 await hub.add('local',{...input,description:'changed'},true);assert.equal((await hub.catalog()).servers[0].description,'changed');
 assert.equal(JSON.parse((await hub.call('local','echo',{})).content[0].text).secret,'DEVICE_SECRET');
 assert.equal((await sync.status()).servers[0].status,'ready');
 await hub.add('local',{...input,enabled:false},true);assert.equal((await hub.catalog()).servers[0].enabled,false);
 await assert.rejects(hub.call('local','echo',{}),/is OFF/);
 await hub.focus([]);await hub.add('focused-out',{...input});await hub.refresh();
 assert.equal((await hub.catalog('',0,5,'focused-out')).enabled,false);
});
test('full access is a local preset, permits localhost, and has no MCP policy mutation route',async t=>{
 const {a}=await setup(t);await assert.rejects(a.globals.control({operation:'publish',target:'AGENTS.md'}),/global-file/);
 assert.throws(()=>validateAgentUrl('http://localhost:1234/mcp',a.config.agent,securityDefaults));
 assert.equal(validateAgentUrl('http://localhost:1234/mcp',a.config.agent,fullAccessSecurity).hostname,'localhost');
 await setSecurityPreset(a.path,'full');const full=(await a.runtime.get());
 assert.deepEqual(full.config.globalAgents,a.config.globalAgents);assert.equal(full.hub.securityPolicy().mutableThroughMcp,false);
 await assert.rejects(full.hub.syncControl('approve',globalId('AGENTS.md'),0,5,false,'a'.repeat(64)),/agents operation/);
 await assert.rejects(control(full.hub,'agents',undefined,{operation:'status',root:'/tmp/escape'}),/Invalid agents/);
});
test('global packages include binary assets, exclude local management data and stay out of MCP catalog',async t=>{
 const {a,b,folder,target}=await setup(t);const preview=await a.globals.preview();assert.equal(preview.packages.length,2);assert.equal(preview.issues.length,0);
 await a.globals.cycle(true);await b.hub.refresh();assert.equal((await b.hub.catalog()).total,0);
 const records=await b.sync.globalRecords();assert.equal(records.length,2);assert.equal(records.every(r=>!r.accepted),true);
 await assert.rejects(access(join(b.root,target,'SKILL.md')),/ENOENT/);
 for(const item of records)await b.globals.control({operation:'apply',target:item.bundle.target,revision:item.revision},true);
 assert.equal(await readFile(join(b.root,'AGENTS.md'),'utf8'),'User instructions');
 assert.deepEqual(await readFile(join(b.root,target,'assets','image.png')),await readFile(join(a.root,target,'assets','image.png')));
 await assert.rejects(access(join(b.root,target,'.env')),/ENOENT/);await assert.rejects(access(join(b.root,'.skill-lock.json')),/ENOENT/);
 for(const file of await readdir(join(folder,'mcp-context-hub-v1','changes'))){const text=await readFile(join(folder,'mcp-context-hub-v1','changes',file),'utf8');assert.equal(text.includes(a.root),false);assert.equal(text.includes('DO_NOT_SHARE'),false);}
 await b.hub.refresh();assert.equal((await b.hub.catalog()).total,0);assert.deepEqual(b.sync.managedIds(),[]);
 const snapshot=await b.globals.inspect(target);assert.equal('text' in snapshot,false);assert.equal(snapshot.files.length,2);
 assert.equal((await b.globals.inspect(target,snapshot.revision,'assets/image.png')).binary,true);
 assert.match((await b.globals.inspect(target,snapshot.revision,'SKILL.md')).text,/version one/);
});
test('global updates stop at local conflicts and explicit overwrite saves the previous contents',async t=>{
 const {a,b,target}=await setup(t);await a.globals.cycle(true);for(const item of await b.sync.globalRecords())await b.globals.control({operation:'apply',target:item.bundle.target,revision:item.revision},true);
 await writeFile(join(b.root,target,'SKILL.md'),skillText('LOCAL EDIT'));
 await writeFile(join(a.root,target,'SKILL.md'),skillText('REMOTE UPDATE'));await a.globals.cycle(true);
 const current=await b.globals.inspect(target);
 await assert.rejects(b.globals.control({operation:'apply',target,revision:current.revision},true),/Local edits conflict/);
 assert.match(await readFile(join(b.root,target,'SKILL.md'),'utf8'),/LOCAL EDIT/);
 const applied=await b.globals.control({operation:'apply',target,revision:current.revision,overwrite:true},true);
 const backup=JSON.parse(await readFile(join(applied.backup,'backup.json'),'utf8'));assert.match(Buffer.from(backup.files.find(f=>f.file.endsWith('SKILL.md')).before,'base64').toString(),/LOCAL EDIT/);
 assert.match(await readFile(join(b.root,target,'SKILL.md'),'utf8'),/REMOTE UPDATE/);
 await b.globals.cycle(true);assert.equal((await b.globals.inspect(target)).revision,current.revision);
});
test('full-access agents can apply selected global files; automatic transfers respect target selection and tombstones',async t=>{
 const {a,b,target}=await setup(t);await a.globals.cycle(true);
 await setSecurityPreset(b.path,'full');const full=await b.runtime.get();await full.globals.cycle(true);
 assert.match(await readFile(join(b.root,target,'SKILL.md'),'utf8'),/version one/);
 await writeFile(join(b.root,target,'.local-note'),'KEEP');
 await rm(join(a.root,target),{recursive:true});await a.globals.cycle(true);await full.globals.cycle(true);
 await assert.rejects(access(join(b.root,target,'SKILL.md')),/ENOENT/);assert.equal(await readFile(join(b.root,target,'.local-note'),'utf8'),'KEEP');
 const statuses=await full.globals.status();assert.equal(statuses.entries.find(e=>e.target===target).status,'deleted');
 await editSettings(b.path,data=>{data.globalAgents.files=[];});const selected=await b.runtime.get();
 await assert.rejects(selected.globals.control({operation:'apply',target:'AGENTS.md',revision:(await selected.globals.inspect('AGENTS.md')).revision}),/outside the owner-selected/);
});
test('global schema and file writes reject traversal, symlinks, device names and case collisions',async t=>{
 const {a,b,dir,target}=await setup(t);
 for(const path of ['../settings.json','skills/../../outside','C:/escape.json','settings:stream.json','.skill-lock.json','credentials.json','settings.secret.json','private.key'])assert.equal(globalTarget(path),false,path);
 assert.throws(()=>configSchema.parse({...a.config,globalAgents:{...a.config.globalAgents,files:['AGENTS.md','agents.md']}}));
 await mkdir(join(a.root,target,'references'));await writeFile(join(a.root,target,'references','token_usage.md'),'Token usage documentation');
 const bundle=await a.globals.pack(target);assert.ok(bundle.files['references/token_usage.md']);const bad={...bundle,files:{...bundle.files,'ASSETS/image.PNG':bundle.files['assets/image.png']}};assert.throws(()=>validateGlobalBundle(bad),/colliding/);
 const published=await a.globals.publish(target);const outside=join(dir,'outside');await mkdir(outside);await writeFile(join(outside,'keep'),'UNCHANGED');
 if(process.platform==='win32')await symlink(outside,join(b.root,target),'junction');else await symlink(outside,join(b.root,target));
 await assert.rejects(b.globals.control({operation:'apply',target,revision:published.revision,overwrite:true},true),/directory|symlink/);
 assert.equal(await readFile(join(outside,'keep'),'utf8'),'UNCHANGED');assert.deepEqual(await readdir(outside),['keep']);
});
test('LAN revision import validates global bundles and preserves approval boundary',async t=>{
 const {a,make,target}=await setup(t);const isolated=await make('isolated');const published=await a.globals.publish(target);
 // Independent transport store, like a different LAN device.
 const config=configSchema.parse({...isolated.config,sync:{mode:'lan'}});const sync=new SyncManager(config,isolated.path);const globals=new GlobalAgents(config,isolated.path,sync);
 await sync.importRevision(published.revision,await a.sync.exportRevision(published.revision));await globals.cycle(true);
 await assert.rejects(access(join(isolated.root,target,'SKILL.md')),/ENOENT/);assert.equal((await globals.status()).entries[0].status,'pending-approval');
 await globals.control({operation:'apply',target,revision:published.revision},true);assert.match(await readFile(join(isolated.root,target,'SKILL.md'),'utf8'),/version one/);
});
test('settings revoked during packaging stop publication and stale snapshots cannot apply files',async t=>{
 const {a,b,target}=await setup(t);const original=a.globals.pack.bind(a.globals);let release;let entered;
 const ready=new Promise(resolve=>{entered=resolve;});const paused=new Promise(resolve=>{release=resolve;});
 a.globals.pack=async value=>{const bundle=await original(value);entered();await paused;return bundle;};
 const publishing=a.globals.publish(target);await ready;
 await editSettings(a.path,data=>{data.globalAgents.enabled=false;});release();
 await assert.rejects(publishing,/settings changed/);assert.equal((await a.sync.globalRecords()).length,0);
 a.globals.pack=original;await editSettings(a.path,data=>{data.globalAgents.enabled=true;});
 const current=await a.runtime.get();const published=await current.globals.publish(target);
 await b.sync.approve(globalId(target),published.revision);
 await editSettings(b.path,data=>{data.globalAgents.enabled=false;});
 await assert.rejects(b.globals.apply(target,published.revision),/settings changed/);
 await assert.rejects(access(join(b.root,target,'SKILL.md')),/ENOENT/);
});
test('background conflicts are visible to another runtime and legacy inventories omit global revisions',async t=>{
 const {a,b,target}=await setup(t);await a.globals.cycle(true);
 for(const item of await b.sync.globalRecords())await b.globals.control({operation:'apply',target:item.bundle.target,revision:item.revision},true);
 await writeFile(join(b.root,target,'SKILL.md'),skillText('LOCAL'));
 await writeFile(join(a.root,target,'SKILL.md'),skillText('REMOTE'));const published=await a.globals.publish(target);
 await b.sync.approve(globalId(target),published.revision);await b.globals.cycle(true);
 const reader=new HubRuntime(b.path);t.after(()=>reader.close());
 assert.match((await (await reader.get()).globals.status()).issues.find(item=>item.target===target).error,/Local edits conflict/);
 assert.equal((await a.sync.inventory(false)).length,0);assert.equal((await a.sync.inventory()).length,3);
});
