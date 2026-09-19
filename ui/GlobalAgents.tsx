import { useEffect, useState } from 'react';
import type { GuiState } from '../src/gui-types.js';
import type { GlobalAgents } from '../src/global-agents.js';
import { api } from './api.js';
import { Dialog, Field, Switch } from './components.js';
import type { RunAction } from './Servers.js';

type Entry = GuiState['globals']['entries'][number];
type Inspection = Awaited<ReturnType<GlobalAgents['inspect']>>;
const labels: Record<string,string> = { applied:'適用済み', deleted:'削除済み', 'pending-approval':'承認待ち', 'needs-apply':'適用待ち', conflict:'版が競合', incomplete:'転送待ち' };
export function GlobalPanel({state,run,busy,report,refresh}:{state:GuiState;run:RunAction;busy:boolean;report:(e:unknown)=>void;refresh:()=>Promise<void>}) {
  const scope=state.globals;
  const [enabled,setEnabled]=useState(scope.enabled);
  const [all,setAll]=useState(scope.skills==='all');
  const [skills,setSkills]=useState(Array.isArray(scope.skills)?scope.skills.join('\n'):'');
  const [files,setFiles]=useState(scope.files.join('\n'));
  const [preview,setPreview]=useState<Awaited<ReturnType<GlobalAgents['preview']>>|null>(null);
  const [review,setReview]=useState<Entry|null>(null);
  const [working,setWorking]=useState(false);
  useEffect(()=>{setEnabled(scope.enabled);setAll(scope.skills==='all');setSkills(Array.isArray(scope.skills)?scope.skills.join('\n'):'');setFiles(scope.files.join('\n'));},[scope.enabled,JSON.stringify(scope.skills),JSON.stringify(scope.files)]);
  const perform=async(input:Record<string,unknown>)=>{
    setWorking(true);report(null);
    try {const result=await api('/api/agents',input);await refresh();return result;}catch(e){report(e);throw e;}finally{setWorking(false);}
  };
  return <details><summary>グローバルSkills・設定 {scope.enabled?'・同期ON':''}</summary>
    <p className="hint">各端末の ~/.agents に同期します。対象を保存すると自動で共有を始めます。受信版は安全性設定に従い、端末内の編集と衝突した場合は保留します。</p>
    <form onSubmit={event=>{event.preventDefault();void run({action:'globalSettings',revision:state.revision,value:{enabled,root:scope.root,skills:all?'all':skills.split(/\r?\n/).map(s=>s.trim()).filter(Boolean),files:files.split(/\r?\n/).map(s=>s.trim()).filter(Boolean)}},'グローバル同期の対象を保存しました');}}>
      <div className="section-heading"><h3>グローバル設定の同期</h3><Switch label="グローバル設定の同期" checked={enabled} disabled={busy||working} onChange={setEnabled}/></div>
      <Field label="Skills"><select value={all?'all':'selected'} onChange={event=>setAll(event.target.value==='all')}><option value="all">すべてのSkills</option><option value="selected">選択したSkills</option></select></Field>
      {!all&&<Field label="Skillフォルダー名（1行に1つ）"><textarea rows={3} value={skills} onChange={event=>setSkills(event.target.value)}/></Field>}
      <Field label="設定ファイル（~/.agents 内の相対パス、1行に1つ）"><textarea rows={3} value={files} onChange={event=>setFiles(event.target.value)}/></Field>
      <p className="hint">.skill-lock.json、隠しファイル、シンボリックリンクは共有しません。Skillの画像・補助ファイルも対象です。認証情報を含む設定は選択しないでください。</p>
      <div className="button-row"><button className="primary" disabled={busy||working}>対象を保存</button><button className="outline" type="button" disabled={busy||working} onClick={()=>{void perform({operation:'preview'}).then(value=>setPreview(value as Awaited<ReturnType<GlobalAgents['preview']>>)).catch(()=>{});}}>登録済みの対象を確認</button><button className="quiet" type="button" disabled={busy||working||!scope.enabled} onClick={()=>{void perform({operation:'sync'}).catch(()=>{});}}>今すぐ同期</button></div>
    </form>
    {preview&&<><p className="hint">共有可能: {preview.packages.length}件・{preview.packages.reduce((n,p)=>n+p.files,0)}ファイル</p>{preview.issues.map(item=><p className="error" key={item.target}>{item.target}: {item.error}</p>)}</>}
    {scope.issues.map(item=><p className="error" key={item.target+item.error}>{item.target}: {item.error}</p>)}
    <ul className="sync-list">{scope.entries.map(entry=><li key={entry.target}><div className="row-copy"><h3>{entry.target}</h3><small>{labels[entry.status]??entry.status}{!entry.selected?' · 対象外':''}</small></div><button className="outline" disabled={busy||working} onClick={()=>setReview(entry)}>内容を見る</button></li>)}</ul>
    {review&&<GlobalReview item={review} close={()=>setReview(null)} perform={perform} busy={working} report={report}/>}
  </details>;
}
function GlobalReview({item,close,perform,busy,report}:{item:Entry;close:()=>void;perform:(input:Record<string,unknown>)=>Promise<unknown>;busy:boolean;report:(e:unknown)=>void}) {
  const [revision,setRevision]=useState(item.revision??item.heads[0]??'');
  const [file,setFile]=useState('');const [inspection,setInspection]=useState<Inspection|null>(null);const [overwrite,setOverwrite]=useState(false);
  useEffect(()=>{let active=true;setInspection(null);void api<Inspection>('/api/agents',{operation:'inspect',target:item.target,revision,...(file?{file}:{})}).then(value=>{if(active)setInspection(value);}).catch(report);return()=>{active=false;};},[item.target,revision,file]);
  return <Dialog title={item.target} onClose={close}>
    {item.heads.length>1&&<Field label="確認する版"><select value={revision} onChange={event=>{setRevision(event.target.value);setFile('');}}>{item.heads.map(head=><option key={head} value={head}>{head.slice(0,16)}</option>)}</select></Field>}
    <code className="revision">{revision}</code>
    {!inspection?<p className="hint">内容を読み込んでいます…</p>:<>
      <p className="hint">{inspection.deleted?'共有からの削除です。管理対象で変更のないファイルだけを削除します。':`${inspection.files.length}ファイル。確認するファイルを選んでください。`}</p>
      {!!inspection.files.length&&<Field label="ファイル"><select value={file} onChange={event=>setFile(event.target.value)}><option value="">ファイルを選ぶ</option>{inspection.files.map(f=><option value={f.name} key={f.name}>{item.target.startsWith('skills/') ? f.name : item.target} · {f.bytes} bytes</option>)}</select></Field>}
      {'text' in inspection&&<pre className="review-text" tabIndex={0}>{inspection.text}</pre>}
      {'binary' in inspection&&<p className="hint">画像などのバイナリファイルです。実行・表示せずに転送します。</p>}
      {item.selected&&item.status!=='conflict'&&<label className="hint"><input type="checkbox" checked={overwrite} onChange={event=>setOverwrite(event.target.checked)}/> この端末の変更を上書きする（元の内容をバックアップ）</label>}
      <div className="dialog-actions"><button className="quiet" onClick={close}>閉じる</button>{item.selected&&<button className="primary" disabled={busy||item.status==='incomplete'} onClick={()=>{void perform({operation:item.status==='conflict'?'resolve':'apply',target:item.target,revision,...(item.status!=='conflict'?{overwrite}:{})}).then(close).catch(()=>{});}}>{item.status==='conflict'?'この版を採用して共有':'この版を承認して適用'}</button>}</div>
    </>}
  </Dialog>;
}
