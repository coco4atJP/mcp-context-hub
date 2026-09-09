import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import jsQR from 'jsqr';
import type { GuiState } from '../src/gui-types.js';
import { api, incomingInvitation } from './api.js';
import { Dialog, Field, Switch } from './components.js';

function QR({ url }: { url: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => { if (canvas.current) void QRCode.toCanvas(canvas.current, url, { width: 264, margin: 3, errorCorrectionLevel: 'M' }); }, [url]);
  return <canvas ref={canvas} className="pair-qr" role="img" aria-label="ペアリング用QRコード。下の招待URLと同じ内容です。" />;
}
function ReadQR({ found, report }: { found: (value: string) => void; report: (error: unknown) => void }) {
  const video = useRef<HTMLVideoElement>(null); const [camera, setCamera] = useState(false);
  const foundRef = useRef(found); foundRef.current = found;
  const decode = (source: CanvasImageSource, width: number, height: number) => {
    const scale = Math.min(1, 900 / Math.max(width, height)); const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale)); canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true }); if (!context) return;
    context.drawImage(source, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
    const code = jsQR(pixels.data, pixels.width, pixels.height);
    if (code) {
      if (!/^mcp-context-hub:\/\/pair#[A-Za-z0-9_-]{1,1800}$/.test(code.data)) throw new Error('Context Hubの招待QRを読み込んでください。');
      foundRef.current(code.data); setCamera(false); return true;
    }
    return false;
  };
  useEffect(() => {
    if (!camera) return;
    let active = true; let stream: MediaStream | undefined; let timer: ReturnType<typeof setInterval> | undefined;
    void navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: 900, height: 900 }, audio: false }).then(async media => {
      if (!active) { media.getTracks().forEach(track => track.stop()); return; }
      stream = media;
      if (video.current) { video.current.srcObject = stream; await video.current.play(); }
      timer = setInterval(() => {
        const element = video.current; if (!element?.videoWidth || !active) return;
        try { decode(element, element.videoWidth, element.videoHeight); } catch (error) { report(error); setCamera(false); }
      }, 350);
    }).catch(() => { if (active) { report(new Error('カメラを使えません。招待URLかQR画像を利用してください。')); setCamera(false); } });
    return () => { active = false; clearInterval(timer); stream?.getTracks().forEach(track => track.stop()); };
  }, [camera]);
  const file = async (value?: File) => {
    if (!value) return;
    try {
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(value.type) || value.size > 5 * 1024 * 1024) throw new Error('5MB以下のPNG・JPEG・WebPを選んでください。');
      const bitmap = await createImageBitmap(value, { resizeWidth: 1000, resizeQuality: 'high' });
      try { if (!decode(bitmap, bitmap.width, bitmap.height)) throw new Error('招待QRを読み取れませんでした。'); } finally { bitmap.close(); }
    } catch (error) { report(error); }
  };
  return <><div className="button-row"><button type="button" className="outline" onClick={() => setCamera(!camera)}>{camera ? 'カメラを停止' : 'カメラでQRを読む'}</button><label className="outline qr-file">QR画像を選択<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { void file(event.target.files?.[0]); event.target.value = ''; }} /></label></div>{camera && <video className="pair-camera" ref={video} muted playsInline aria-label="QR読み取りカメラ" />}</>;
}

export function LanPanel({ state, refresh, report }: { state: GuiState; refresh: () => Promise<void>; report: (error: unknown) => void }) {
  const lan = state.lan;
  const [busy, setBusy] = useState(false); const [modal, setModal] = useState<'invite' | 'join' | 'unpair' | null>(incomingInvitation ? 'join' : null);
  const [url, setUrl] = useState(incomingInvitation); const [invite, setInvite] = useState<{ url: string; expires: number }>();
  const [remove, setRemove] = useState<{ id: string; name: string }>(); const [copied, setCopied] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (modal === 'invite' && lan?.pending.length) { setModal(null); setInvite(undefined); } }, [lan?.pending.length, modal]);
  if (!lan) return null;
  const act = async <T,>(value: unknown, route = '/api/lan'): Promise<T | undefined> => {
    setBusy(true); report(null);
    try { const result = await api<T>(route, value); await refresh(); return result; }
    catch (error) { report(error); return undefined; } finally { setBusy(false); }
  };
  const createInvite = async () => {
    if (!lan.enabled && !await act({ action: 'enable', enabled: true, revision: state.revision })) return;
    const value = await act<{ url: string; expires: number }>({ action: 'invite' });
    if (value) { setNow(Date.now()); setInvite(value); setCopied(false); setModal('invite'); }
  };
  const join = async () => {
    if (!lan.enabled && !await act({ action: 'enable', enabled: true, revision: state.revision })) return;
    if (await act({ action: 'join', url: url.trim() })) { setModal(null); setUrl(''); }
  };
  return <section className="lan-panel" aria-label="LANペアリング">
    <div className="lan-heading"><div><h3>近くの端末とつなぐ</h3><p className="hint">{lan.enabled ? '同じLANにいる間、自動で同期します。' : 'URL・QRでペアリング。共有フォルダーは不要です。'}</p></div><Switch label="LAN同期" checked={lan.enabled} disabled={busy} onChange={enabled => { void act({ action: 'enable', enabled, revision: state.revision }); }} /></div>
    <div className="button-row"><button className="primary" disabled={busy || !!lan.pending.length} onClick={() => { void createInvite(); }}>端末を追加</button><button className="outline" disabled={busy || !!lan.pending.length} onClick={() => setModal('join')}>招待を受け取る</button></div>
    <p className="hint">この端末のMCP登録と付随Skillを共有します。ON/OFF・認証情報・起動パスは端末ごとに保持します。</p>
    {lan.error && <p className="error" role="status">{lan.error}</p>}
    {lan.enabled && lan.addresses?.length === 0 && <p className="hint">LANへの接続を待っています。</p>}
    {lan.enabled && lan.discoveryError && <p className="hint">端末の自動検出が使えません。ネットワークのマルチキャスト設定を確認してください。</p>}
    {lan.pending.map(pending => <div className="pair-check" key={pending.id}><h3>{pending.name}</h3><p>両方の画面で番号が同じことを確認してください。</p><strong className="pair-code">{pending.code.slice(0, 3)} {pending.code.slice(3)}</strong><p className="hint">{pending.local ? '相手の確認を待っています…' : '確認後、登録済み端末との同期が始まります。'} · あと{Math.max(0, Math.ceil((pending.expires - now) / 1000))}秒</p><div className="button-row"><button className="primary" disabled={busy || pending.local || pending.expires < now} onClick={() => { void act({ action: 'confirm', session: pending.id }); }}>番号が同じ・ペアリング</button><button className="quiet" disabled={busy} onClick={() => { void act({ action: 'cancel' }); }}>キャンセル</button></div></div>)}
    {!!lan.peers.length && <ul className="peer-list">{lan.peers.map(peer => <li key={peer.id}><div className="row-copy"><h3>{peer.name}</h3><small><span className={'status-dot ' + (!peer.error && peer.lastSync ? 'online' : '')} />{peer.error ?? (peer.lastSync ? '同期中 · ' + new Date(peer.lastSync).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '接続を確認中')}</small></div><button className="quiet" disabled={busy} onClick={() => { setRemove(peer); setModal('unpair'); }}>解除</button></li>)}</ul>}
    {!!lan.publishErrors.length && <p className="hint">自動共有を保留: {lan.publishErrors.join(', ')}。共有版の承認・競合、URLのクエリ、Skillの内容と容量を確認してください。</p>}
    <details><summary>同期と自動起動の設定</summary><div className="lan-heading"><div className="row-copy"><h3>この端末の登録を自動共有</h3><p>原本のMCP登録・付随Skillの編集と削除を反映します。</p></div><Switch label="登録を自動共有" checked={lan.autoPublish} disabled={busy} onChange={enabled => { void act({ action: 'autoPublish', enabled, revision: state.revision }); }} /></div><p className="hint">受信した版は{state.security.requireSyncApproval ? '内容を確認してから適用します。' : '自動で適用します。'}「安全性」から変更できます。Agentによる共有は別の許可設定に従います。</p>
      <p className="hint">{state.serviceInstalled ? 'ログイン時の自動起動・招待URLを開く機能は登録済みです。' : '最初の1回、両端末で登録すると、ログイン後も同期でき、招待URLを直接開けます。'}</p><button className="outline" disabled={busy} onClick={() => { void act({ action: state.serviceInstalled ? 'uninstall' : 'install' }, '/api/service'); }}>{state.serviceInstalled ? '自動起動とURL登録を解除' : '自動起動とURLを登録'}</button><p className="hint">画面を閉じてもLAN同期は続きます。停止は上のLAN同期スイッチ、プロセス終了はCLIの lan stop を使えます。</p>
    </details>
    {modal === 'invite' && invite && <Dialog title="もう一方の端末で開く" onClose={() => setModal(null)}>{invite.expires > now ? <><QR url={invite.url} /><p className="hint">招待の有効期限はあと{Math.max(0, Math.ceil((invite.expires - now) / 1000))}秒です。もう一方のHubでQRを読むか、URLを開いてください。</p><Field label="招待URL"><textarea className="invite-url" readOnly value={invite.url} onFocus={event => event.target.select()} /></Field><div className="button-row"><button className="primary" onClick={() => { void navigator.clipboard.writeText(invite.url).then(() => setCopied(true)).catch(report); }}>{copied ? 'コピーしました' : 'URLをコピー'}</button><button className="quiet" onClick={() => { void act({ action: 'cancel' }).then(() => { setInvite(undefined); setModal(null); }); }}>招待を取り消す</button></div></> : <><p>招待の期限が切れました。</p><button className="primary" onClick={() => { void createInvite(); }}>作り直す</button></>}<p className="hint">URLから起動するには、両端末で「自動起動とURLを登録」を1回実行します。スマートフォンで読んだ場合は、URLを接続したいPCへ渡してください。</p></Dialog>}
    {modal === 'join' && <Dialog title="招待を受け取る" onClose={() => setModal(null)}><p>同じLANで動いている、もう一方のHubの招待を読み込みます。</p><form onSubmit={event => { event.preventDefault(); void join(); }}><Field label="招待URL"><textarea required maxLength={1900} placeholder="mcp-context-hub://pair#…" value={url} onChange={event => setUrl(event.target.value)} autoFocus /></Field><ReadQR found={setUrl} report={report} /><p className="hint">接続後、両方の画面で番号を確認します。MCP登録と付随Skillを共有し、各端末の安全性設定で適用します。</p><div className="dialog-actions"><button className="quiet" type="button" onClick={() => setModal(null)}>キャンセル</button><button className="primary" disabled={busy || !url.trim()}>接続して番号を確認</button></div></form></Dialog>}
    {modal === 'unpair' && remove && <Dialog title="ペアリングを解除" onClose={() => setModal(null)}><p>{remove.name}との今後の通信を拒否します。既に同期した登録やSkillは両端末に残ります。</p><div className="dialog-actions"><button className="quiet" onClick={() => setModal(null)}>キャンセル</button><button className="primary" disabled={busy} onClick={() => { void act({ action: 'unpair', peer: remove.id }).then(result => { if (result) setModal(null); }); }}>解除する</button></div></Dialog>}
  </section>;
}
