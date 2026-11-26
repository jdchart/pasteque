/* Dialogs and toasts in the app's own look — never alert(), confirm() or
   prompt(). Promise-based, callable from anywhere (actions, tools):

     if (await confirmDialog({ title, message })) …
     const name = await promptDialog({ title, label, value });
     toast('Saved', 'ok');

   <DialogHost/> (mounted once in App) renders the stack. */

import { ReactNode, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { tr } from '../i18n/core';

type DialogEntry = {
  id: number;
  render: (close: (v?: unknown) => void) => ReactNode;
  title: ReactNode;
  wide?: boolean; small?: boolean;
  dismissable: boolean;
  resolve: (v: unknown) => void;
  dismissValue: unknown;
};
type ToastEntry = { id: number; msg: string; kind: 'info' | 'ok' | 'bad' };

let dialogs: DialogEntry[] = [];
let toasts: ToastEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

export function openDialog<T>(opts: {
  title: ReactNode; render: (close: (v?: T) => void) => ReactNode;
  wide?: boolean; small?: boolean; dismissable?: boolean; dismissValue?: T;
}): Promise<T> {
  return new Promise<T>((resolve) => {
    const entry: DialogEntry = {
      id: ++seq, title: opts.title, wide: opts.wide, small: opts.small,
      render: opts.render as DialogEntry['render'], dismissable: opts.dismissable !== false,
      resolve: resolve as (v: unknown) => void, dismissValue: opts.dismissValue,
    };
    dialogs = [...dialogs, entry];
    emit();
  });
}

function closeDialog(id: number, value: unknown) {
  const d = dialogs.find((x) => x.id === id);
  if (!d) return;
  dialogs = dialogs.filter((x) => x.id !== id);
  emit();
  d.resolve(value);
}

export const anyDialogOpen = () => dialogs.length > 0;

export function confirmDialog(o: { title: string; message: ReactNode; detail?: ReactNode; ok?: string; cancel?: string; danger?: boolean }): Promise<boolean> {
  return openDialog<boolean>({
    title: o.title, small: true, dismissValue: false,
    render: (close) => (
      <>
        <div className="modal-body"><p className="confirm-msg">{o.message}</p>{o.detail ? <p className="muted small">{o.detail}</p> : null}</div>
        <div className="modal-foot">
          <button type="button" onClick={() => close(false)}>{o.cancel || tr('cancel')}</button>
          <button type="button" className={o.danger ? 'danger' : 'primary'} data-autofocus onClick={() => close(true)}>{o.ok || tr('ok')}</button>
        </div>
      </>
    ),
  });
}

export function alertDialog(o: { title: string; message: ReactNode }): Promise<void> {
  return openDialog<void>({
    title: o.title, small: true,
    render: (close) => (
      <>
        <div className="modal-body"><p className="confirm-msg">{o.message}</p></div>
        <div className="modal-foot"><button type="button" className="primary" data-autofocus onClick={() => close()}>{tr('ok')}</button></div>
      </>
    ),
  });
}

function PromptBody({ label, value, ok, close }: { label: string; value: string; ok?: string; close: (v?: string | null) => void }) {
  const [v, setV] = useState(value);
  return (
    <form onSubmit={(e) => { e.preventDefault(); close(v.trim()); }}>
      <div className="modal-body">
        <label className="field"><span className="s-label">{label}</span>
          <input type="text" value={v} onChange={(e) => setV(e.target.value)} data-autofocus /></label>
      </div>
      <div className="modal-foot">
        <button type="button" onClick={() => close(null)}>{tr('cancel')}</button>
        <button type="submit" className="primary">{ok || tr('ok')}</button>
      </div>
    </form>
  );
}

export function promptDialog(o: { title: string; label: string; value?: string; ok?: string }): Promise<string | null> {
  return openDialog<string | null>({
    title: o.title, small: true, dismissValue: null,
    render: (close) => <PromptBody label={o.label} value={o.value || ''} ok={o.ok} close={close} />,
  });
}

export function toast(msg: string, kind: ToastEntry['kind'] = 'info', ms = 3200) {
  const t = { id: ++seq, msg, kind };
  toasts = [...toasts, t];
  emit();
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); emit(); }, ms);
}

function Modal({ d, top }: { d: DialogEntry; top: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const restore = useRef<Element | null>(null);
  useEffect(() => {
    restore.current = document.activeElement;
    const el = ref.current;
    const target = el?.querySelector<HTMLElement>('[data-autofocus]') || el?.querySelector<HTMLElement>('input,select,textarea,button');
    setTimeout(() => target?.focus(), 20);
    return () => { (restore.current as HTMLElement | null)?.focus?.(); };
  }, []);
  useEffect(() => {
    if (!top) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && d.dismissable) { e.preventDefault(); closeDialog(d.id, d.dismissValue); }
      if (e.key === 'Tab' && ref.current) {           // keep focus inside the dialog
        const f = Array.from(ref.current.querySelectorAll<HTMLElement>('button,input,select,textarea,a[href],[tabindex]:not([tabindex="-1"])')).filter((x) => !x.hasAttribute('disabled'));
        if (!f.length) return;
        const first = f[0], last = f[f.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [top, d]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget && d.dismissable) closeDialog(d.id, d.dismissValue); }}>
      <div ref={ref} className={'modal' + (d.wide ? ' wide' : '') + (d.small ? ' small' : '')} role="dialog" aria-modal="true" aria-labelledby={'dlg-' + d.id}>
        <div className="modal-head">
          <h2 id={'dlg-' + d.id}>{d.title}</h2>
          {d.dismissable ? <button type="button" className="icon-btn" aria-label={tr('close')} onClick={() => closeDialog(d.id, d.dismissValue)}>×</button> : null}
        </div>
        {d.render((v) => closeDialog(d.id, v))}
      </div>
    </div>
  );
}

export function DialogHost() {
  const snap = useSyncExternalStore(subscribe, () => dialogs);
  const ts = useSyncExternalStore(subscribe, () => toasts);
  return (
    <>
      {snap.map((d, i) => <Modal key={d.id} d={d} top={i === snap.length - 1} />)}
      <div className="toasts" aria-live="polite">
        {ts.map((t) => <div key={t.id} className={'toast ' + t.kind}>{t.msg}</div>)}
      </div>
    </>
  );
}
