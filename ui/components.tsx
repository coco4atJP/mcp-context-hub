import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

export const FeedbackContext = createContext('');

export function Icon({ name }: { name: 'hub' | 'refresh' | 'window' | 'search' | 'plus' | 'chevron' | 'close' | 'folder' }) {
  const shapes = {
    hub: <><path d="m7 16 8-10m2 3 2 10M9 19l7 1" /><circle cx="5" cy="19" r="3" /><circle cx="16" cy="5" r="3" /><circle cx="20" cy="21" r="3" /></>,
    refresh: <><path d="M20 4v6h-6M4 20v-6h6" /><path d="M5.1 8a8 8 0 0 1 13-3L20 10M4 14l1.9 5a8 8 0 0 0 13-3" /></>,
    window: <><path d="M14 3h7v7m0-7-11 11M10 4H4v16h16v-6" /></>,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    plus: <path d="M12 4v16M4 12h16" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    folder: <path d="M3 7h7l2 2h9v11H3Zm0 0V4h7l2 3" />,
  };
  return <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">{shapes[name]}</svg>;
}

export function Switch({ label, checked, disabled, onChange }: { label: string; checked: boolean; disabled?: boolean; onChange: (checked: boolean) => void }) {
  return <button type="button" className={`switch ${checked ? 'on' : ''}`} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span /></button>;
}

export function Dialog({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const error = useContext(FeedbackContext);
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => dialog.close(); }, []);
  return <dialog ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}>
    <header className="dialog-header"><h2>{title}</h2><button type="button" className="icon-button" aria-label="閉じる" onClick={onClose}><Icon name="close" /></button></header>
    <div className="dialog-content">{error && <p className="error" role="alert">{error}</p>}{children}</div>
  </dialog>;
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) {
  return <label className="field"><span>{label}</span>{children}{hint && <small>{hint}</small>}</label>;
}

export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty"><h3>{title}</h3><p>{children}</p></div>;
}
