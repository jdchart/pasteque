/* Small building blocks shared by every tool and lesson. */

import { ReactNode, useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useApp } from '../session/store';
import { Transport } from '../lib/transport';
import { fmtTime } from '../lib/fmt';
import { log } from '../lib/log';
import { useT, Rich } from '../i18n/react';

/* --- layout -------------------------------------------------------------- */

export function Panel({ title, hint, hintHtml, children, id, className, actions }: {
  title?: ReactNode; hint?: string; hintHtml?: string; children?: ReactNode; id?: string; className?: string; actions?: ReactNode;
}) {
  return (
    <section className={'panel s-card' + (className ? ' ' + className : '')} id={id}>
      {title || actions ? <div className="panel-head">{title ? <h2>{title}</h2> : null}<span className="grow" />{actions}</div> : null}
      {hintHtml ? <Rich as="p" className="hint" html={hintHtml} /> : hint ? <p className="hint">{hint}</p> : null}
      {children}
    </section>
  );
}

export function Field({ label, children, className }: { label: ReactNode; children: ReactNode; className?: string }) {
  return <label className={'field' + (className ? ' ' + className : '')}><span className="s-label">{label}</span>{children}</label>;
}

export function Controls({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={'controls' + (className ? ' ' + className : '')}>{children}</div>;
}

export function Seg<V extends string | number>({ value, options, onChange, label }: {
  value: V; options: { value: V; label: ReactNode; title?: string }[]; onChange: (v: V) => void; label?: string;
}) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button type="button" key={String(o.value)} className={o.value === value ? 'on' : ''} aria-pressed={o.value === value}
          title={o.title} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

export function Check({ checked, onChange, children, code }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; code?: string }) {
  return (
    <label className="check">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{children}</span>{code ? <code>{code}</code> : null}
    </label>
  );
}

export function Progress({ value }: { value: number | null }) {
  if (value === null) return null;
  return <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={1} aria-valuenow={value}><span style={{ width: (value * 100).toFixed(1) + '%' }} /></div>;
}

export type StatusMsg = { msg: string; kind?: '' | 'ok' | 'bad' } | null;

/** A status line; a failure also goes to the journal. */
export function Status({ s }: { s: StatusMsg }) {
  useEffect(() => { if (s && s.kind === 'bad' && s.msg) log.error(s.msg); }, [s]);
  if (!s || !s.msg) return <p className="status" role="status" aria-live="polite" />;
  return <p className={'status ' + (s.kind || '')} role="status" aria-live="polite">{s.msg}</p>;
}

export function Readout({ html }: { html: string }) { return <Rich as="p" className="readout" html={html} />; }

/* --- files --------------------------------------------------------------- */

export function DropZone({ onFiles, multiple, accept = 'audio/*', main, formats, compact }: {
  onFiles: (files: File[]) => void; multiple?: boolean; accept?: string; main?: string; formats?: string; compact?: boolean;
}) {
  const { t } = useT();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div className={'drop' + (over ? ' over' : '') + (compact ? ' compact' : '')} role="button" tabIndex={0}
      aria-label={main || t(multiple ? 'drop.multi' : 'drop.main')}
      onClick={() => input.current?.click()}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.current?.click(); } }}
      onDragEnter={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
      onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(true); }}
      onDragLeave={(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); }}
      onDrop={(e) => {
        e.preventDefault(); e.stopPropagation(); setOver(false);
        const fs = Array.from(e.dataTransfer.files || []);
        if (fs.length) onFiles(multiple ? fs : fs.slice(0, 1));
      }}>
      <span>{main || t(multiple ? 'drop.multi' : 'drop.main')}</span>
      <small>{formats || t('drop.formats')}</small>
      <input ref={input} type="file" accept={accept} multiple={multiple} hidden
        onChange={(e) => { const fs = Array.from(e.target.files || []); e.target.value = ''; if (fs.length) onFiles(fs); }} />
    </div>
  );
}

/* --- canvas -------------------------------------------------------------- */

/** A canvas that redraws itself when its inputs change, when it is resized
    (including when its tab is shown again), and on theme or language change.
    With a transport, it carries a playhead and click/drag-to-seek. */
export function Plot({ draw, deps, transport, className, tabIndex, onKeyDown, ariaLabel, canvasRef, onPointerMove, onPointerLeave, onClick, onPointerDown, onPointerUp, children, minHeight, fill }: {
  draw: (c: HTMLCanvasElement) => void; deps: unknown[]; transport?: Transport | null; className?: string;
  tabIndex?: number; onKeyDown?: (e: React.KeyboardEvent<HTMLCanvasElement>) => void; ariaLabel?: string;
  canvasRef?: React.MutableRefObject<HTMLCanvasElement | null>;
  onPointerMove?: (e: React.PointerEvent<HTMLCanvasElement>) => void; onPointerLeave?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onPointerDown?: (e: React.PointerEvent<HTMLCanvasElement>) => void; onPointerUp?: (e: React.PointerEvent<HTMLCanvasElement>) => void;
  onClick?: (e: React.MouseEvent<HTMLCanvasElement>) => void; children?: ReactNode; minHeight?: number;
  /** take all the height the container gives (inside a workbench pane) */
  fill?: boolean;
}) {
  const ref = useRef<HTMLCanvasElement | null>(null);
  const head = useRef<HTMLDivElement>(null);
  const epoch = useApp((s) => s.epoch);
  const lang = useApp((s) => s.lang);
  const drawRef = useRef(draw);
  drawRef.current = draw;
  const lastW = useRef(0), lastH = useRef(0);
  const redraw = useCallback(() => {
    const c = ref.current;
    if (!c || !c.clientWidth) return;
    lastW.current = c.clientWidth; lastH.current = c.clientHeight;
    drawRef.current(c);
    transport?.refresh();
  }, [transport]);

  useLayoutEffect(() => { redraw(); }, [...deps, epoch, lang, redraw]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const c = ref.current; if (!c) return;
    let raf = 0;
    const ro = new ResizeObserver(() => {
      if (!c.clientWidth) return;
      if (c.clientWidth === lastW.current && (!fill || c.clientHeight === lastH.current)) return;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(redraw);
    });
    ro.observe(c);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [redraw, fill]);

  useEffect(() => {
    if (!transport || !ref.current || !head.current) return;
    return transport.attach(ref.current, head.current);
  }, [transport]);

  return (
    <div className={'plot' + (fill ? ' fill' : '') + (className ? ' ' + className : '')} style={minHeight ? { minHeight } : undefined}>
      <canvas ref={(el) => { ref.current = el; if (canvasRef) canvasRef.current = el; }} role="img" aria-label={ariaLabel} data-fill={fill ? '1' : undefined}
        tabIndex={tabIndex} onKeyDown={onKeyDown} onPointerMove={onPointerMove} onPointerLeave={onPointerLeave}
        onPointerDown={onPointerDown} onPointerUp={onPointerUp} onClick={onClick} />
      <div ref={head} className="playhead" aria-hidden="true" />
      {children}
    </div>
  );
}

/* --- transport ----------------------------------------------------------- */

export function useTransport(): Transport {
  const [tp] = useState(() => new Transport());
  useEffect(() => () => { tp.stop(); }, [tp]);
  return tp;
}

/** Re-render on play/pause/buffer changes of a transport. */
export function useTransportState(tp: Transport) {
  return useSyncExternalStore((f) => tp.subscribe(f), () => (tp.playing() ? 1 : 0) + (tp.buffer ? 2 : 0));
}

export function TransportBar({ tp }: { tp: Transport }) {
  const { t } = useT();
  useTransportState(tp);
  const slider = useRef<HTMLInputElement>(null);
  const time = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const paint = (now: number) => {
      if (time.current) time.current.textContent = tp.buffer ? fmtTime(now) + ' / ' + fmtTime(tp.hi()) : '';
      if (slider.current && document.activeElement !== slider.current) slider.current.value = String(Math.round((now - tp.lo()) / tp.span() * 10000));
    };
    paint(tp.time());
    const a = tp.onFrame(paint), b = tp.subscribe(() => paint(tp.time()));
    return () => { a(); b(); };
  }, [tp]);
  const dis = !tp.buffer;
  return (
    <div className="transport">
      <button type="button" className="primary" disabled={dis} onClick={() => tp.toggle()}>{tp.playing() ? t('tp.pause') : t('tp.play')}</button>
      <button type="button" disabled={dis} onClick={() => tp.stop()}>{t('tp.stop')}</button>
      <input ref={slider} type="range" min={0} max={10000} step={1} defaultValue={0} disabled={dis} aria-label={t('tp.scrub')}
        onInput={(e) => tp.seek(tp.lo() + (Number((e.target as HTMLInputElement).value) / 10000) * tp.span())}
        onKeyDown={(e) => { if (e.key === ' ') { e.preventDefault(); tp.toggle(); } }} />
      <span ref={time} className="time" />
    </div>
  );
}

/* --- tables -------------------------------------------------------------- */

export type SortState = { col: string | null; dir: 1 | -1 };

export function SortHeader({ label, col, sort, onSort, className, title }: {
  label: string; col: string; sort: SortState; onSort: (s: SortState) => void; className?: string; title?: string;
}) {
  const on = sort.col === col;
  return (
    <th scope="col" className={className} aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
      <button type="button" title={title} onClick={() => onSort({ col, dir: on ? (-sort.dir as 1 | -1) : 1 })}>
        {label}{on ? (sort.dir > 0 ? ' ▲' : ' ▼') : ''}
      </button>
    </th>
  );
}
