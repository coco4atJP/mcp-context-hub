import { useCallback, useEffect, useState } from 'react';
import type { GuiServer, GuiState } from '../src/gui-types.js';
import { api, forgetToken, openSmallWindow } from './api.js';
import { Dialog, Empty, FeedbackContext, Icon } from './components.js';
import { AddServer, ServerDetail, Servers, type RunAction } from './Servers.js';
import { ReviewSync, Sync } from './Sync.js';
import { ConfigEditor, Security } from './Security.js';

type Modal = { kind: 'add' } | { kind: 'server'; server: GuiServer } | { kind: 'sync'; server: GuiState['sync']['servers'][number] } | { kind: 'config' } | { kind: 'confirm'; title: string; text: string; action: Record<string, unknown> };
export function App() {
  const [state, setState] = useState<GuiState | null>(null); const [tab, setTab] = useState('servers');
  const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [notice, setNotice] = useState('');
  const [closed, setClosed] = useState(false); const [modal, setModal] = useState<Modal | null>(null);
  const report = useCallback((error: unknown) => setError(error instanceof Error ? error.message : '操作できませんでした。'), []);
  const refresh = useCallback(async () => setState(await api<GuiState>('/api/state')), []);
  useEffect(() => {
    if (closed) return;
    void refresh().catch(report);
    const interval = setInterval(() => { if (!document.hidden) void refresh().catch(report); }, 5000);
    return () => clearInterval(interval);
  }, [closed, refresh, report]);
  useEffect(() => { if (!notice) return; const timer = setTimeout(() => setNotice(''), 3500); return () => clearTimeout(timer); }, [notice]);
  const run: RunAction = async (value, success = '保存しました') => {
    setBusy(true); setError(''); setNotice('');
    try { await api('/api/action', value); await refresh(); setNotice(success); return true; }
    catch (error) { report(error); void refresh().catch(() => {}); return false; }
    finally { setBusy(false); }
  };
  const show = (value: Modal) => { setError(''); setModal(value); };
  const close = () => { setError(''); setModal(null); };
  const confirm = (title: string, text: string, action: Record<string, unknown>) => show({ kind: 'confirm', title, text, action });
  const shutdown = async () => {
    setBusy(true);
    try { await api('/api/close', {}); forgetToken(); setClosed(true); setError(''); if (window.opener) window.close(); }
    catch (error) { report(error); } finally { setBusy(false); }
  };
  return <FeedbackContext.Provider value={error}><div className="shell">
    <header className="app-header"><div className="brand"><Icon name="hub" /><h1>Context Hub</h1></div><div className="header-actions"><button className="icon-button" aria-label="再読み込み" disabled={closed || busy} onClick={() => { setError(''); void refresh().catch(report); }}><Icon name="refresh" /></button><button className="icon-button" aria-label="小窓で開く" disabled={closed} onClick={() => { if (!openSmallWindow()) setNotice('小窓を開けませんでした。通常のブラウザでポップアップを許可してください。'); }}><Icon name="window" /></button></div></header>
    <nav className="tabs" aria-label="管理画面">{[['servers', 'サーバー'], ['sync', '同期'], ['security', '安全性']].map(([value, label]) => <button key={value} aria-current={tab === value ? 'page' : undefined} className={tab === value ? 'active' : ''} disabled={closed} onClick={() => { setTab(value); setError(''); }}>{label}</button>)}</nav>
    <main>
      {error && !modal && <p className="error" role="alert">{error}</p>}
      {closed ? <Empty title="GUIを終了しました">この画面を閉じて構いません。CLIとMCPの利用は続けられます。</Empty> : !state ? <p className="hint">設定を読み込んでいます…</p> : tab === 'servers' ? <Servers state={state} busy={busy} run={run} add={() => show({ kind: 'add' })} detail={server => show({ kind: 'server', server })} /> : tab === 'sync' ? <Sync state={state} busy={busy} run={run} review={server => show({ kind: 'sync', server })} report={report} /> : <Security state={state} busy={busy} run={run} confirm={confirm} edit={() => show({ kind: 'config' })} />}
    </main>
    <footer><span>ON/OFFはこの端末に保存</span><button className="quiet" disabled={busy || closed} onClick={() => { void shutdown(); }}>終了</button></footer>
    {notice && !modal && <div className="toast" role="status">{notice}</div>}
    {state && modal?.kind === 'add' && <AddServer state={state} run={run} busy={busy} close={close} />}
    {state && modal?.kind === 'server' && <ServerDetail server={modal.server} state={state} run={run} busy={busy} close={close} confirm={confirm} report={report} />}
    {modal?.kind === 'sync' && <ReviewSync item={modal.server} run={run} busy={busy} close={close} report={report} />}
    {modal?.kind === 'config' && <ConfigEditor run={run} busy={busy} close={close} report={report} />}
    {modal?.kind === 'confirm' && <Dialog title={modal.title} onClose={close}><p>{modal.text}</p><div className="dialog-actions"><button className="quiet" onClick={close}>キャンセル</button><button className="primary" disabled={busy} onClick={() => { void run(modal.action).then(ok => { if (ok) close(); }); }}>適用する</button></div></Dialog>}
  </div></FeedbackContext.Provider>;
}
