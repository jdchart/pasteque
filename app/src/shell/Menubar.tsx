/* An application menubar: click a title to open, hover to move between open
   menus, arrows / Enter / Escape on the keyboard. Items are data, so the
   App decides what each menu holds. */

import { ReactNode, useEffect, useRef, useState } from 'react';

export type MenuItem =
  | { kind?: 'item'; label: ReactNode; onSelect: () => void; shortcut?: string; checked?: boolean; disabled?: boolean; glyph?: string; hint?: string }
  | { kind: 'sep' }
  | { kind: 'head'; label: ReactNode };
export type Menu = { id: string; label: ReactNode; items: MenuItem[] };

const selectable = (it: MenuItem) => (it.kind === undefined || it.kind === 'item') && !(it as { disabled?: boolean }).disabled;

export function Menubar({ menus, openSignal }: { menus: Menu[]; openSignal?: number }) {
  const [open, setOpen] = useState<string | null>(null);
  const [focus, setFocus] = useState(-1);
  const bar = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (bar.current && !bar.current.contains(e.target as Node)) setOpen(null); };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  // F10 (or the App's own key) opens the first menu
  useEffect(() => { if (openSignal) { setOpen(menus[0].id); setFocus(firstIndex(menus[0])); } }, [openSignal]); // eslint-disable-line react-hooks/exhaustive-deps

  const firstIndex = (m: Menu) => m.items.findIndex(selectable);
  const move = (m: Menu, from: number, dir: 1 | -1) => {
    const n = m.items.length;
    for (let k = 1; k <= n; k++) { const i = (from + dir * k + n * 2) % n; if (selectable(m.items[i])) return i; }
    return from;
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (!open) return;
    const mi = menus.findIndex((m) => m.id === open), m = menus[mi];
    if (e.key === 'Escape') { e.preventDefault(); setOpen(null); (bar.current?.querySelector(`[data-menu="${m.id}"]`) as HTMLElement | null)?.focus(); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); setFocus(move(m, focus, 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setFocus(move(m, focus < 0 ? 0 : focus, -1)); }
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const nm = menus[(mi + (e.key === 'ArrowRight' ? 1 : -1) + menus.length) % menus.length];
      setOpen(nm.id); setFocus(firstIndex(nm));
    } else if (e.key === 'Enter' || e.key === ' ') {
      const it = m.items[focus];
      if (it && selectable(it)) { e.preventDefault(); setOpen(null); (it as { onSelect: () => void }).onSelect(); }
    }
  };

  useEffect(() => {
    if (!open || focus < 0) return;
    (bar.current?.querySelector(`.menu-pop [data-i="${focus}"]`) as HTMLElement | null)?.focus();
  }, [open, focus]);

  return (
    <div className="menubar" ref={bar} role="menubar" onKeyDown={onKey}>
      {menus.map((m) => (
        <div className="menu" key={m.id}>
          <button type="button" role="menuitem" aria-haspopup="true" aria-expanded={open === m.id} data-menu={m.id}
            className={'menu-title' + (open === m.id ? ' on' : '')}
            onMouseDown={(e) => { e.preventDefault(); setOpen(open === m.id ? null : m.id); setFocus(-1); }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); setOpen(m.id); setFocus(firstIndex(m)); } }}
            onMouseEnter={() => { if (open && open !== m.id) { setOpen(m.id); setFocus(-1); } }}>
            {m.label}
          </button>
          {open === m.id ? (
            <div className="menu-pop" role="menu">
              {m.items.map((it, i) => {
                if (it.kind === 'sep') return <div key={i} className="menu-sep" role="separator" />;
                if (it.kind === 'head') return <div key={i} className="menu-head s-label">{it.label}</div>;
                return (
                  <button key={i} type="button" role="menuitem" data-i={i} tabIndex={-1} disabled={it.disabled}
                    className={'menu-item' + (it.checked ? ' checked' : '') + (focus === i ? ' focus' : '')}
                    onMouseEnter={() => setFocus(i)}
                    onClick={() => { setOpen(null); it.onSelect(); }}>
                    <span className="mi-glyph" aria-hidden="true">{it.checked ? '●' : it.glyph || ''}</span>
                    <span className="mi-label">{it.label}{it.hint ? <small>{it.hint}</small> : null}</span>
                    {it.shortcut ? <kbd>{it.shortcut}</kbd> : null}
                  </button>
                );
              })}
            </div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
