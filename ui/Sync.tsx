import { useEffect, useState } from 'react';
import type { GuiState } from '../src/gui-types.js';
import type { SyncManager } from '../src/sync.js';
import { api } from './api.js';
import { Dialog, Empty, Field, Icon } from './components.js';
import type { RunAction } from './Servers.js';
import { GlobalPanel } from './GlobalAgents.js';
import { LanPanel } from './Lan.js';

type Synced = GuiState['sync']['servers'][number];
type Inspection = Awaited<ReturnType<SyncManager['inspect']>>;
const labels: Record<string, string> = { 'pending-approval': '承認待ち', ready: '取り込み済み', conflict: '変更が競合', incomplete: '転送を待っています', 'needs-local-setup': '起動設定が必要', deleted: '共有から削除済み' };
export function Sync({ state, run, busy, review, report, refresh }: { state: GuiState; run: RunAction; busy: boolean; review: (server: Synced) => void; report: (error: unknown) => void; refresh: () => Promise<void> }) {
  const servers = state.sync.servers.filter(server => server.kind !== 'agents');
  const [folder, setFolder] = useState(state.sync.folder ?? '');
  useEffect(() => setFolder(state.sync.folder ?? ''), [state.sync.folder]);
  return <>
    <h2>環境を共有する</h2><p className="intro">MCP登録とSkillを、端末間で同期します。</p>
    <LanPanel state={state} refresh={refresh} report={report} />
    <details><summary>共有フォルダーを使う</summary>
    <form className="folder-form" onSubmit={event => { event.preventDefault(); void run({ action: 'connect', folder, revision: state.revision }, '共有フォルダーへ接続しました'); }}>
      <Field label="共有フォルダー"><input required placeholder="フォルダーの絶対パス" value={folder} onChange={event => setFolder(event.target.value)} /></Field>
      <div className="button-row"><button className="outline" type="button" disabled={busy} onClick={() => { void api<{ folder: string | null }>('/api/folder', {}).then(result => { if (result.folder) setFolder(result.folder); }).catch(report); }}><Icon name="folder" />選択</button><button className="primary" disabled={busy || !folder || folder === state.sync.folder && state.sync.mode !== 'lan'}>接続する</button>{state.sync.connected && state.sync.mode === 'folder' && <button className="quiet" type="button" disabled={busy} onClick={() => { void run({ action: 'disconnect', revision: state.revision }, '同期先との接続を解除しました'); }}>解除</button>}</div>
    </form>
    <p className="hint">LAN共有・クラウド同期フォルダーを利用できます。ON/OFFと認証情報は端末ごとに保持します。</p>
    </details>
    <GlobalPanel state={state} run={run} busy={busy} report={report} refresh={refresh} />
    {state.sync.error && <p className="error" role="status">{state.sync.error === 'offline' ? '共有先はオフラインです。承認済みのローカルコピーを利用できます。' : '共有データを検証できません。同期したサーバーの利用を保留しています。'}</p>}
    <div className="section-heading"><h3>共有されたサーバー</h3><button className="quiet" disabled={busy || !state.sync.connected} onClick={() => { void run({ action: 'pull' }, '共有先を確認しました'); }}><Icon name="refresh" />確認</button></div>
    {!servers.length ? <Empty title="共有された登録はありません">{state.lan?.enabled && state.lan.autoPublish ? 'この端末のMCP登録と付随Skillは自動で共有されます。' : 'サーバーの詳細にある「共有する」から公開できます。'}</Empty> : <ul className="sync-list">{servers.map(server => <li key={server.server}><div className="row-copy"><h3>{server.server}</h3><p>{server.description}</p><small className={server.status === 'pending-approval' || server.status === 'conflict' ? 'attention' : ''}>{labels[server.status] ?? server.status}</small></div><button className="outline" disabled={busy} onClick={() => review(server)}>内容を見る</button></li>)}</ul>}
  </>;
}

export function ReviewSync({ item, run, busy, close, report }: { item: Synced; run: RunAction; busy: boolean; close: () => void; report: (error: unknown) => void }) {
  const heads = 'heads' in item ? item.heads : undefined;
  const [revision, setRevision] = useState('revision' in item ? item.revision : heads?.[0] ?? '');
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [selected, setSelected] = useState('');
  useEffect(() => {
    let active = true; setInspection(null);
    void api<Inspection>('/api/inspect?' + new URLSearchParams({ server: item.server, revision })).then(value => { if (active) { setInspection(value); setSelected(''); } }).catch(report);
    return () => { active = false; };
  }, [item.server, revision]);
  const bundle = inspection?.change.bundle && !('kind' in inspection.change.bundle) ? inspection.change.bundle : null;
  const files = Object.entries(bundle?.packages ?? {}).flatMap(([skill, files]) => Object.entries(files).map(([name, content]) => ({ name: `${skill}/${name}`, content })));
  const text = files.find(file => file.name === selected)?.content ?? files[0]?.content ?? '';
  return <Dialog title={`${item.server}の共有内容`} onClose={close}>
    {heads && <Field label="確認する版"><select value={revision} onChange={event => setRevision(event.target.value)}>{heads.map(head => <option key={head} value={head}>{head.slice(0, 16)}</option>)}</select></Field>}
    {!inspection ? <p className="hint">内容を読み込んでいます…</p> : <>
      <p className="hint">{labels[item.status] ?? item.status}</p><code className="revision">{inspection.revision}</code>
      {bundle ? <>
        <p>{bundle.description}</p>
        <p className="connection">{'template' in bundle.connection ? `起動テンプレート: ${bundle.connection.template}` : bundle.connection.url}</p>
        {bundle.allowedTools && <p className="hint">許可ツール: {bundle.allowedTools.join(', ') || 'なし'}</p>}
        {files.length > 0 ? <><Field label="Skillファイル"><select value={selected || files[0].name} onChange={event => setSelected(event.target.value)}>{files.map(file => <option key={file.name} value={file.name}>{file.name}</option>)}</select></Field><pre className="review-text" tabIndex={0}>{text}</pre></> : <p className="hint">添付されたSkillはありません。</p>}
        {item.status === 'needs-local-setup' && <p className="hint">この端末の起動テンプレート、HTTPの許可範囲、Skillの保存先を確認してください。「安全性」の詳細設定から編集できます。</p>}
      </> : <p>この変更は、共有登録を削除します。</p>}
      <div className="dialog-actions"><button className="quiet" onClick={close}>閉じる</button>
        {item.status === 'pending-approval' && <button className="primary" disabled={busy} onClick={() => { void run({ action: 'approve', server: item.server, revision: inspection.revision }, 'この版を承認しました').then(ok => { if (ok) close(); }); }}>この版を承認</button>}
        {item.status === 'conflict' && <button className="primary" disabled={busy} onClick={() => { void run({ action: 'resolve', server: item.server, revision: inspection.revision }, '選んだ版を採用して共有しました').then(ok => { if (ok) close(); }); }}>この版を採用して共有</button>}
      </div>
    </>}
  </Dialog>;
}
