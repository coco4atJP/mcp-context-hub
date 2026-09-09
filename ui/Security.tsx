import { useEffect, useState } from 'react';
import { securityLabels, type GuiState } from '../src/gui-types.js';
import { Dialog, Switch } from './components.js';
import { api } from './api.js';
import type { RunAction } from './Servers.js';

const relaxed: Record<string, boolean> = { allowAgentPublish: true, requireSyncApproval: false, requireHttps: false, blockPrivateHttp: false, enforceToolAllowlist: false, inheritProcessEnv: true };
const changes: Record<string, string> = {
  allowAgentPublish: 'AgentがMCP登録とSkillを共有先へ公開・削除できるようになります。',
  requireSyncApproval: '競合のない受信版を確認なしで取り込みます。共有フォルダーに書き込める相手が接続情報とSkillを更新できます。',
  requireHttps: 'Agentが平文HTTPのURLを登録できるようになります。その通信は暗号化されません。',
  blockPrivateHttp: 'Agentが追加したURLから、LANやループバックのアドレスへ接続できるようになります。',
  enforceToolAllowlist: 'サーバー別の許可リストを適用せず、そのMCPが提供する全ツールを利用できます。',
  inheritProcessEnv: 'このHubの環境変数をMCPの子プロセスへ渡します。認証トークンなどが含まれる場合もあります。',
};
export function Security({ state, run, busy, confirm, edit }: { state: GuiState; run: RunAction; busy: boolean; confirm: (title: string, text: string, action: Record<string, unknown>) => void; edit: () => void }) {
  return <>
    <h2>この端末の安全性</h2><p className="intro">設定は他の端末へ同期しません。</p>
    <ul className="security-list">{(Object.keys(securityLabels) as Array<keyof typeof securityLabels>).map(key => <li key={key}><div className="row-copy"><h3>{securityLabels[key][0]}</h3><p>{securityLabels[key][1]}</p></div><Switch label={securityLabels[key][0]} checked={state.security[key]} disabled={busy} onChange={enabled => {
      const action = { action: 'security', revision: state.revision, key, enabled };
      if (relaxed[key] === enabled) confirm(`「${securityLabels[key][0]}」を${enabled ? 'ON' : 'OFF'}にする`, changes[key] + ' この端末に適用します。', action);
      else void run(action);
    }} /></li>)}</ul>
    <p className="hint">変更は次のMCP要求から反映されます。既に行われた外部操作を取り消すものではありません。</p>
    <div className="button-row"><button className="outline" disabled={busy} onClick={() => confirm('安全性を初期値に戻す', '9項目を推奨の初期値に戻します。その他の設定は保持します。', { action: 'resetSecurity', revision: state.revision })}>初期値に戻す</button><button className="quiet" disabled={busy} onClick={edit}>詳細設定（JSON）</button></div>
    <p className="config-path">{state.configPath}</p>
  </>;
}

export function ConfigEditor({ run, busy, close, report }: { run: RunAction; busy: boolean; close: () => void; report: (error: unknown) => void }) {
  const [value, setValue] = useState(''); const [revision, setRevision] = useState('');
  useEffect(() => { let active = true; void api<{ revision: string; value: unknown }>('/api/config').then(data => { if (active) { setValue(JSON.stringify(data.value, null, 2)); setRevision(data.revision); } }).catch(report); return () => { active = false; }; }, []);
  return <Dialog title="詳細設定" onClose={close}><form onSubmit={event => {
    event.preventDefault(); let data: unknown;
    try { data = JSON.parse(value); } catch { report(new Error('JSONの構文を確認してください。')); return; }
    void run({ action: 'config', revision, value: data }).then(ok => { if (ok) close(); });
  }}><p className="hint">端末内のconfig.jsonを編集します。起動コマンド、認証、Skillの紐づけも設定できます。保存前に形式を検証します。</p>
    <textarea className="config-editor" aria-label="設定JSON" spellCheck={false} value={value} onChange={event => setValue(event.target.value)} />
    <div className="dialog-actions"><button type="button" className="quiet" onClick={close}>キャンセル</button><button className="primary" disabled={busy || !revision}>保存する</button></div>
  </form></Dialog>;
}
