import { useEffect, useState } from 'react';
import type { GuiServer, GuiState } from '../src/gui-types.js';
import { api } from './api.js';
import { Dialog, Empty, Field, Icon, Switch } from './components.js';

export type RunAction = (value: Record<string, unknown>, success?: string) => Promise<boolean>;
export const sourceName = (source: string) => source === 'sync' ? '共有' : source === 'agent' ? 'Agent追加' : 'この端末';
export function Servers({ state, busy, run, add, detail }: { state: GuiState; busy: boolean; run: RunAction; add: () => void; detail: (server: GuiServer) => void }) {
  const [query, setQuery] = useState('');
  const rows = state.servers.filter(server => `${server.server} ${server.description}`.toLowerCase().includes(query.toLowerCase()));
  return <>
    <h2>この端末のサーバー</h2><p className="intro">ONのサーバーは必要なときに起動します。</p>
    <div className="toolbar"><label className="search"><Icon name="search" /><input aria-label="サーバーを検索" placeholder="サーバーを検索" value={query} onChange={event => setQuery(event.target.value)} /></label><button className="outline" onClick={add} disabled={busy}><Icon name="plus" />追加</button></div>
    {!rows.length ? <Empty title={state.servers.length ? '一致するサーバーがありません' : 'まだサーバーがありません'}>{state.servers.length ? '検索する言葉を変えてみてください。' : '「追加」から接続先を登録できます。共有済みの環境は「同期」から取り込めます。'}</Empty> :
      <ul className="server-list">{rows.map(server => <li className="server-row" key={server.server}>
        <div className="row-copy"><h3>{server.server.replaceAll('_', ' ')}</h3>{server.description && <p>{server.description}</p>}<small>{server.blocked ? '現在の権限で停止中 · ' : ''}{sourceName(server.source)}{server.skillCount ? ` · ${server.skillCount} ${server.skillCount === 1 ? 'Skill' : 'Skills'}` : ''}</small></div>
        <Switch label={`${server.server}をON/OFF`} checked={server.enabled} disabled={busy || (!server.enabled && server.agentCanEnable === false)} onChange={enabled => { void run({ action: 'toggle', server: server.server, enabled }, enabled ? 'ONにしました' : 'OFFにしました'); }} />
        <button className="icon-button detail-button" aria-label={`${server.server}の詳細`} onClick={() => detail(server)}><Icon name="chevron" /></button>
      </li>)}</ul>}
    {state.servers.length > 0 && <button className="outline all-off" disabled={busy || !state.servers.some(server => server.enabled)} onClick={() => { void run({ action: 'allOff' }, 'この端末のサーバーをすべてOFFにしました'); }}>すべてOFF</button>}
  </>;
}

export function AddServer({ state, run, busy, close }: { state: GuiState; run: RunAction; busy: boolean; close: () => void }) {
  const [revision] = useState(state.revision);
  const [kind, setKind] = useState('http'); const [id, setId] = useState(''); const [description, setDescription] = useState('');
  const [url, setUrl] = useState(''); const [command, setCommand] = useState(''); const [args, setArgs] = useState(''); const [cwd, setCwd] = useState('');
  const [template, setTemplate] = useState(state.templates[0]?.id ?? ''); const [skills, setSkills] = useState<string[]>([]);
  return <Dialog title="サーバーを追加" onClose={close}><form onSubmit={event => {
    event.preventDefault();
    const value = { id, kind, description, skills, ...(kind === 'http' ? { url } : kind === 'template' ? { template } : { command, args: args.split('\n').filter(Boolean), ...(cwd ? { cwd } : {}) }) };
    void run({ action: 'add', revision, value }, 'サーバーを追加しました。初期状態はOFFです').then(ok => { if (ok) close(); });
  }}>
    <Field label="サーバーID" hint="英数字・ハイフン・アンダースコアで指定"><input required autoFocus value={id} maxLength={80} pattern="[a-zA-Z0-9_-]+" onChange={event => setId(event.target.value)} /></Field>
    <Field label="接続方法"><select value={kind} onChange={event => setKind(event.target.value)}><option value="http">HTTP URL</option><option value="stdio">ローカルコマンド</option><option value="template" disabled={!state.templates.length}>起動テンプレート</option></select></Field>
    {kind === 'http' && <Field label="MCPのURL"><input type="url" required placeholder="https://example.com/mcp" value={url} onChange={event => setUrl(event.target.value)} /></Field>}
    {kind === 'template' && <Field label="テンプレート"><select required value={template} onChange={event => setTemplate(event.target.value)}>{state.templates.map(item => <option key={item.id} value={item.id}>{item.id}</option>)}</select></Field>}
    {kind === 'stdio' && <><Field label="起動コマンド"><input required placeholder="node または実行ファイルの絶対パス" value={command} onChange={event => setCommand(event.target.value)} /></Field><Field label="引数" hint="1行に1つ。引用符で囲む必要はありません。"><textarea rows={3} value={args} onChange={event => setArgs(event.target.value)} /></Field><Field label="作業フォルダー（任意）"><input value={cwd} placeholder="絶対パス" onChange={event => setCwd(event.target.value)} /></Field></>}
    <Field label="説明（任意）"><input value={description} maxLength={500} onChange={event => setDescription(event.target.value)} /></Field>
    {state.skills.length > 0 && <details><summary>既存のSkillを添付</summary><div className="checkbox-list">{state.skills.map(skill => <label key={skill.id}><input type="checkbox" checked={skills.includes(skill.id)} onChange={event => setSkills(event.target.checked ? [...skills, skill.id] : skills.filter(id => id !== skill.id))} />{skill.id}</label>)}</div></details>}
    <p className="hint">登録だけでは起動しません。認証情報や細かい設定は「安全性」の詳細設定で編集できます。</p>
    <div className="dialog-actions"><button type="button" className="quiet" onClick={close}>キャンセル</button><button className="primary" disabled={busy}>追加する</button></div>
  </form></Dialog>;
}

export function ServerDetail({ server, state, run, busy, close, confirm, report }: { server: GuiServer; state: GuiState; run: RunAction; busy: boolean; close: () => void; confirm: (title: string, text: string, action: Record<string, unknown>) => void; report: (error: unknown) => void }) {
  const [skills, setSkills] = useState<{ skill: string; description: string; available: boolean }[] | null>(null);
  const [skillId, setSkillId] = useState(''); const [path, setPath] = useState('');
  useEffect(() => { let active = true; void api<typeof skills>('/api/skills?server=' + encodeURIComponent(server.server)).then(value => { if (active) setSkills(value); }).catch(report); return () => { active = false; }; }, [server.server]);
  return <Dialog title={server.server} onClose={close}>
    <p>{server.description || '説明はありません。'}</p><p className="hint">{sourceName(server.source)} · {server.enabled ? '利用可能（ON）' : '利用停止（OFF）'}</p>
    {server.agentCanEnable === false && <p className="hint">起動の切り替えは設定でロックされています。解除する場合は「安全性」の詳細設定でallowAgentEnableを変更してください。</p>}
    <h3 className="section-title">紐づくSkill</h3>
    {skills === null ? <p className="hint">読み込み中…</p> : !skills.length ? <p className="hint">Skillはまだありません。</p> : <ul className="skill-list">{skills.map(skill => <li key={skill.skill}><strong>{skill.skill}</strong><p>{skill.available ? skill.description : 'ファイルを読み込めません。登録パスを確認してください。'}</p></li>)}</ul>}
    {server.locallyDefined && <details><summary>Skillを添付</summary><form onSubmit={event => { event.preventDefault(); void run({ action: 'attachSkill', server: server.server, revision: state.revision, skill: skillId, path }, server.source === 'sync' ? 'Skillを原本に添付しました。「共有する」で反映できます' : 'Skillを添付しました').then(ok => { if (ok) close(); }); }}>
      <Field label="Skill ID"><input required pattern="[a-zA-Z0-9_-]+" value={skillId} onChange={event => setSkillId(event.target.value)} /></Field>
      <Field label="Skillフォルダー"><input required placeholder="SKILL.mdが入ったフォルダーの絶対パス" value={path} onChange={event => setPath(event.target.value)} /></Field>
      <div className="dialog-actions"><button type="button" className="outline" onClick={() => { void api<{ folder: string | null }>('/api/folder', {}).then(result => { if (result.folder) setPath(result.folder); }).catch(report); }}><Icon name="folder" />選択</button><button className="primary" disabled={busy}>添付する</button></div>
    </form></details>}
    <div className="detail-actions"><button className="outline" disabled={busy || !state.sync.connected} onClick={() => confirm('共有フォルダーへ公開', 'このMCPの登録情報とSkillファイルを、接続済みの共有先へ公開します。', { action: 'publish', server: server.server })}>共有する</button>
    <button className="danger-text" disabled={busy} onClick={() => confirm(server.source === 'sync' ? '共有から削除' : 'サーバーを削除', server.source === 'sync' ? 'この削除は他の端末にも同期されます。この端末だけ止める場合はOFFを使ってください。' : 'この端末の登録を削除します。MCP本体やSkillファイルは削除しません。', { action: server.source === 'sync' ? 'removeShared' : 'remove', server: server.server, ...(server.source === 'sync' ? {} : { revision: state.revision }) })}>{server.source === 'sync' ? '共有から削除' : '削除する'}</button></div>
  </Dialog>;
}
