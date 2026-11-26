/* The sandbox tools' work surface: an application window rather than a page.

     ┌ bar: glyph · title · [toolbar: transport…] ·········· ⓘ ┐
     ├ side: <Section>s ┃ main: <Split> of <Pane>s ─────────────────┤
     │  (settings,     ┃   each pane collapses (click its title),   │
     │   collapsible)  ┃   resizes (drag the divider), scrolls      │
     └─────────────────┸────────────────────────────────────────────┘

   Everything fits the window; long content scrolls inside its own pane. The
   narrative lives in the guided version of each tool (a lesson, reachable from
   the ⓘ of the bar); a section or pane may still carry a short `help`.
   Layout (sizes, folds) is kept per tool while the app is open, not in the
   session file: it is how you arrange your desk, not your work. */

import { Children, createContext, isValidElement, ReactElement, ReactNode, useContext, useRef, useState } from 'react';
import { findLesson, LessonEntry, pick, ToolEntry } from '../catalog';
import { useT, Rich } from '../i18n/react';
import { openDialog } from './dialogs';
import { openItem } from '../shell/nav';

/* --- layout memory --------------------------------------------------------- */

const memory = new Map<string, unknown>();
function useRemembered<T>(key: string, init: T): [T, (v: T | ((old: T) => T)) => void] {
  const [v, setV] = useState<T>(() => (memory.has(key) ? (memory.get(key) as T) : init));
  const set = (n: T | ((old: T) => T)) => setV((old) => {
    const next = typeof n === 'function' ? (n as (o: T) => T)(old) : n;
    memory.set(key, next);
    return next;
  });
  return [v, set];
}

const ToolKey = createContext('tool');
/** Section and pane titles come from the classic pages ("2. Les réglages"): no numbers in an app. */
const bare = (n: ReactNode) => (typeof n === 'string' ? n.replace(/^\s*\d+\.\s*/, '') : n);

/* --- drag helper ----------------------------------------------------------- */

function drag(e: React.PointerEvent, onMove: (dx: number, dy: number) => void, cursor: string) {
  e.preventDefault();
  const x0 = e.clientX, y0 = e.clientY;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  document.body.classList.add('wb-dragging');
  document.body.style.cursor = cursor;
  const move = (ev: PointerEvent) => onMove(ev.clientX - x0, ev.clientY - y0);
  const up = () => {
    target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up);
    document.body.classList.remove('wb-dragging'); document.body.style.cursor = '';
  };
  target.addEventListener('pointermove', move); target.addEventListener('pointerup', up); target.addEventListener('pointercancel', up);
}

/* --- the window ------------------------------------------------------------ */

export function Workbench({ entry, toolbar, side, children, sideWidth = 300 }: {
  entry: ToolEntry | LessonEntry; toolbar?: ReactNode; side?: ReactNode; children: ReactNode; sideWidth?: number;
}) {
  const { t, lang } = useT();
  const key = entry.id;
  const [sideOpen, setSideOpen] = useRemembered(key + ':side', true);
  const [width, setWidth] = useRemembered(key + ':sideW', sideWidth);
  const guided = findLesson(entry.id);

  const about = () => void openDialog<void>({
    title: <><span className="glyph" aria-hidden="true">{entry.glyph}</span> {pick(entry.title, lang)}</>, wide: true,
    render: (close) => (
      <>
        <div className="modal-body prose">
          <p>{pick(entry.subtitle, lang)} — {pick(entry.kind === 'tool' ? entry.short : entry.card, lang)}</p>
          <p className="small muted">{t('wb.tips')}</p>
        </div>
        <div className="modal-foot">
          {guided ? <button type="button" onClick={() => { close(); openItem('lesson', guided.id); }}>{t('wb.guided')} →</button> : null}
          <span className="grow" />
          <button type="button" className="primary" onClick={() => close()}>OK</button>
        </div>
      </>
    ),
  });

  return (
    <ToolKey.Provider value={key}>
      <div className="wb">
        <header className="wb-bar">
          {side ? (
            <button type="button" className={'icon-btn wb-side-btn' + (sideOpen ? ' on' : '')} aria-pressed={sideOpen}
              title={t('wb.side')} aria-label={t('wb.side')} onClick={() => setSideOpen(!sideOpen)}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="none" stroke="currentColor" />
                <rect x="1.5" y="2.5" width="4.5" height="11" rx="1" fill={sideOpen ? 'currentColor' : 'none'} stroke="currentColor" /></svg>
            </button>
          ) : null}
          <span className="wb-glyph" aria-hidden="true">{entry.glyph}</span>
          <h1 className="wb-title">{pick(entry.title, lang)}</h1>
          <div className="wb-tools">{toolbar}</div>
          <button type="button" className="icon-btn" title={t('wb.info')} aria-label={t('wb.info')} onClick={about}>i</button>
        </header>
        <div className="wb-body">
          {side && sideOpen ? (
            <>
              <aside className="wb-side" style={{ width }}>{side}</aside>
              <div className="wb-divider v" role="separator" aria-orientation="vertical" title={t('wb.resize')}
                onDoubleClick={() => setWidth(sideWidth)}
                onPointerDown={(e) => { const w0 = width; drag(e, (dx) => setWidth(Math.max(220, Math.min(560, w0 + dx))), 'col-resize'); }} />
            </>
          ) : null}
          <main className="wb-main">{children}</main>
        </div>
      </div>
    </ToolKey.Provider>
  );
}

/* --- sidebar sections ------------------------------------------------------ */

function HelpToggle({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  const { t } = useT();
  return <button type="button" className={'wb-q' + (on ? ' on' : '')} aria-pressed={on} title={t('wb.help')} aria-label={t('wb.help')}
    onClick={(e) => { e.stopPropagation(); set(!on); }}>?</button>;
}

export function Section({ id, title, help, children, actions, defaultOpen = true }: {
  id: string; title: ReactNode; help?: string; children: ReactNode; actions?: ReactNode; defaultOpen?: boolean;
}) {
  const { t } = useT();
  const tool = useContext(ToolKey);
  const [open, setOpen] = useRemembered(tool + ':sec:' + id, defaultOpen);
  const [helpOn, setHelp] = useRemembered(tool + ':help:' + id, false);
  return (
    <section className={'wb-sec' + (open ? ' open' : '')}>
      <header className="wb-sec-head">
        <button type="button" className="wb-fold" aria-expanded={open} title={t(open ? 'wb.collapse' : 'wb.expand')} onClick={() => setOpen(!open)}>
          <span className="chev" aria-hidden="true">▸</span>{bare(title)}
        </button>
        {actions}
        {help ? <HelpToggle on={helpOn} set={setHelp} /> : null}
      </header>
      {help && helpOn ? <Rich as="p" className="wb-help" html={help} /> : null}
      <div className="wb-sec-body" hidden={!open}>{children}</div>
    </section>
  );
}

/* --- panes ----------------------------------------------------------------- */

type PaneProps = {
  id: string; title: ReactNode; help?: string; actions?: ReactNode; children?: ReactNode;
  weight?: number;     // share of the free space (default 1)
  min?: number;        // px
  flush?: boolean;     // no padding: content (a table, a canvas) goes edge to edge
};
/** A pane of a Split. Its chrome is drawn by the Split. */
export function Pane(_: PaneProps): ReactElement | null { return null; }

export function Split({ id, dir = 'col', children }: { id: string; dir?: 'col' | 'row'; children: ReactNode }) {
  const { t } = useT();
  const tool = useContext(ToolKey);
  const panes = Children.toArray(children).filter((c): c is ReactElement<PaneProps> => isValidElement(c) && c.type === Pane);
  const [weights, setWeights] = useRemembered<Record<string, number>>(tool + ':split:' + id, {});
  const [folded, setFolded] = useRemembered<Record<string, boolean>>(tool + ':fold:' + id, {});
  const [helps, setHelps] = useRemembered<Record<string, boolean>>(tool + ':phelp:' + id, {});
  const refs = useRef<Record<string, HTMLElement | null>>({});
  const horiz = dir === 'row';

  const startResize = (e: React.PointerEvent, a: string, b: string) => {
    const size = (pid: string) => { const el = refs.current[pid]; return el ? (horiz ? el.offsetWidth : el.offsetHeight) : 0; };
    // freeze every open pane at its current size, then move the a|b boundary
    const base: Record<string, number> = {};
    panes.forEach((p) => { if (!folded[p.props.id]) base[p.props.id] = size(p.props.id); });
    const pa = panes.find((p) => p.props.id === a)!, pb = panes.find((p) => p.props.id === b)!;
    const minA = pa.props.min ?? 80, minB = pb.props.min ?? 80, sum = base[a] + base[b];
    drag(e, (dx, dy) => {
      const d = horiz ? dx : dy;
      const na = Math.max(minA, Math.min(sum - minB, base[a] + d));
      setWeights({ ...base, [a]: na, [b]: sum - na });
    }, horiz ? 'col-resize' : 'row-resize');
  };

  return (
    <div className={'wb-split ' + dir}>
      {panes.map((p, i) => {
        const { id: pid, title, help, actions, children: body, weight = 1, min = 80, flush } = p.props;
        const isFolded = !!folded[pid];
        const w = weights[pid] ?? weight;
        const next = panes[i + 1];
        return [
          <section key={pid} ref={(el) => { refs.current[pid] = el; }}
            className={'wb-pane' + (isFolded ? ' folded' : '') + (flush ? ' flush' : '')}
            style={isFolded ? { flex: '0 0 auto' } : { flex: `${w} 1 0px`, [horiz ? 'minWidth' : 'minHeight']: min }}>
            <header className="wb-pane-head">
              <button type="button" className="wb-fold" aria-expanded={!isFolded} title={t(isFolded ? 'wb.expand' : 'wb.collapse')}
                onClick={() => setFolded((f) => ({ ...f, [pid]: !f[pid] }))}>
                <span className="chev" aria-hidden="true">▸</span>{bare(title)}
              </button>
              {!isFolded ? <div className="wb-pane-actions">{actions}</div> : null}
              {help ? <HelpToggle on={!!helps[pid]} set={(v) => setHelps((h) => ({ ...h, [pid]: v }))} /> : null}
            </header>
            {help && helps[pid] && !isFolded ? <Rich as="p" className="wb-help" html={help} /> : null}
            <div className="wb-pane-body" hidden={isFolded}>{body}</div>
          </section>,
          next ? (
            <div key={pid + '|'} className={'wb-divider ' + (horiz ? 'v' : 'h') + (isFolded || folded[next.props.id] ? ' idle' : '')}
              role="separator" aria-orientation={horiz ? 'vertical' : 'horizontal'} title={t('wb.resize')}
              onDoubleClick={() => setWeights({})}
              onPointerDown={(e) => { if (!isFolded && !folded[next.props.id]) startResize(e, pid, next.props.id); }} />
          ) : null,
        ];
      })}
    </div>
  );
}

/** Shown in a pane that has nothing yet. */
export function Empty({ children }: { children?: ReactNode }) {
  const { t } = useT();
  return <p className="wb-empty">{children ?? t('wb.empty')}</p>;
}
