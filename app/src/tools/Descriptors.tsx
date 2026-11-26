/* Descripteurs audio — port of general-descripteurs-audio.html.
   Predict (sketch the curve you expect), compute, compare: descriptor curves
   with the sketch overlaid, MFCC as a heat map or curves, a sortable table,
   CSV and PNG export. The sketches are part of the session: a prediction made
   in class can be reopened and argued about later. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Empty, Pane, Section, Split, Workbench } from '../ui/Workbench';
import { useToolState } from '../session/store';
import { useT } from '../i18n/react';
import { Check, Controls, Field, Panel, Plot, Progress, SortHeader, SortState, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { SoundSource, useLoadedSound } from '../ui/SoundSource';
import * as draw from '../lib/draw';
import { css, padLeft } from '../lib/draw';
import { describe, Description } from '../lib/dsp';
import { csvRows, png } from '../lib/io';
import { fmt } from '../lib/fmt';
import { log } from '../lib/log';
import { S } from './Descriptors.strings';

const FEATURES = [
  { id: 'rms', unit: '', on: true }, { id: 'pitch', unit: 'u.hz', on: true },
  { id: 'spectralCentroid', unit: 'u.hz', on: true }, { id: 'spectralFlatness', unit: 'u.norm', on: true },
  { id: 'zcr', unit: 'u.perframe', on: false }, { id: 'spectralRolloff', unit: 'u.hz', on: false },
  { id: 'spectralSpread', unit: '', on: false }, { id: 'perceptualSharpness', unit: '', on: false },
  { id: 'loudness', unit: '', on: false }, { id: 'mfcc', unit: '', on: false },
];
const PREDICTABLE = ['rms', 'spectralCentroid', 'pitch', 'spectralFlatness'];
const SKETCH_N = 400;          // a sketch is 400 values in 0..1 (null where nothing was drawn)
const MAX_ROWS = 500;

type Sketch = (number | null)[];
type State = { soundId: string | null; size: number; overlap: number; feats: string[]; predictFor: string; sketches: Record<string, Sketch>; mfccView: 'heat' | 'curves'; ran: boolean };
const DEFAULTS: State = { soundId: null, size: 1024, overlap: 0.5, feats: FEATURES.filter((f) => f.on).map((f) => f.id), predictFor: 'rms', sketches: {}, mfccView: 'heat', ran: false };

/** The sketch drawn as a dashed line over a computed curve: shape only. */
function overlaySketch(cv: HTMLCanvasElement, a: Sketch | undefined) {
  if (!a) return;
  const ctx = cv.getContext('2d')!, w = cv.clientWidth, h = cv.clientHeight;
  const pL = padLeft(), padB = 18, padT = 10, plotW = Math.max(10, w - pL - 8), plotH = Math.max(10, h - padT - padB);
  ctx.strokeStyle = css('--warn'); ctx.lineWidth = 2.2; ctx.setLineDash([5, 3]);
  ctx.beginPath(); let started = false;
  for (let x = 0; x < a.length; x++) {
    const v = a[x];
    if (v === null) { started = false; continue; }
    const px = pL + x / a.length * plotW, py = padT + (1 - v) * plotH;
    if (!started) { ctx.moveTo(px, py); started = true; } else ctx.lineTo(px, py);
  }
  ctx.stroke(); ctx.setLineDash([]);
}

export default function Descriptors({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('descriptors') : findTool('descriptors'))!;
  const { t, rich, lang } = useT(S);
  const [st, set] = useToolState<State>(lesson ? 'lesson:descriptors' : 'descriptors', DEFAULTS);
  const sound = useLoadedSound(st.soundId);
  const tp = useTransport();
  const [result, setResult] = useState<Description | null>(null);
  const [prog, setProg] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<StatusMsg>(null);
  const [sort, setSort] = useState<SortState>({ col: 'time', dir: 1 });
  const runId = useRef(0);
  const curvesRef = useRef<HTMLDivElement>(null);
  const signal = sound?.signal;
  const unitFor = (id: string) => { const f = FEATURES.find((x) => x.id === id); return f && f.unit ? t(f.unit) : ''; };

  useEffect(() => {
    runId.current++;
    tp.setBuffer(sound?.buffer || null);
    setResult(null); setProg(null);
  }, [sound?.buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- prediction sketch ------------------------------------------------- */
  const live = useRef<Sketch | null>(null);          // the sketch being drawn, committed on release
  const lastX = useRef(-1);
  const sketchCv = useRef<HTMLCanvasElement | null>(null);
  const current = (): Sketch => live.current || st.sketches[st.predictFor] || new Array(SKETCH_N).fill(null);

  const drawSketch = (cv: HTMLCanvasElement) => {
    const { ctx, w, h } = draw.fit(cv, 130);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, h / 2 + 0.5); ctx.lineTo(w, h / 2 + 0.5); ctx.stroke();
    ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
    ctx.textAlign = 'left'; ctx.fillText('0 s', 4, h - 4);
    ctx.textAlign = 'right'; ctx.fillText(sound ? sound.buffer.duration.toFixed(1) + ' s' : '', w - 4, h - 4);
    ctx.fillText(t('f.' + st.predictFor), w - 4, 14);
    const a = current();
    ctx.strokeStyle = css('--warn'); ctx.lineWidth = 2.5;
    ctx.beginPath(); let started = false;
    for (let i = 0; i < a.length; i++) {
      const v = a[i];
      if (v === null) { started = false; continue; }
      const x = i / (a.length - 1) * w, y = (1 - v) * (h - 8) + 4;
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  };

  const sketchPoint = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget, r = cv.getBoundingClientRect();
    const x = Math.round((e.clientX - r.left) / Math.max(1, r.width) * (SKETCH_N - 1));
    const v = 1 - Math.max(0, Math.min(1, (e.clientY - r.top - 4) / (cv.clientHeight - 8)));
    if (x < 0 || x >= SKETCH_N) return;
    const a = live.current || (live.current = current().slice());
    const lx = lastX.current;
    if (lx >= 0 && Math.abs(x - lx) > 1) {        // fill the gap between events
      const v0 = a[lx], from = Math.min(lx, x), to = Math.max(lx, x);
      for (let i = from; i <= to; i++) a[i] = v0 === null ? v : v0 + (v - v0) * (i - lx) / (x - lx);
    } else a[x] = v;
    lastX.current = x;
    drawSketch(cv);
  };
  const endSketch = () => {
    if (live.current) { const a = live.current; live.current = null; set((s) => ({ sketches: { ...s.sketches, [s.predictFor]: a } })); }
    lastX.current = -1;
  };

  /* --- analysis ---------------------------------------------------------- */
  const run = async () => {
    if (!signal || !sound) return;
    const size = st.size, hop = Math.max(1, Math.round(size * (1 - st.overlap)));
    const feats = FEATURES.map((f) => f.id).filter((id) => st.feats.includes(id));
    if (!feats.length) { setRunStatus({ msg: t('st.nofeat'), kind: 'bad' }); return; }
    if (signal.length < size) { setRunStatus({ msg: t('st.tooshort'), kind: 'bad' }); return; }
    const nFrames = Math.floor((signal.length - size) / hop) + 1;
    if (nFrames > 60000) log.warn(t('st.big', { min: (sound.buffer.duration / 60).toFixed(0), n: nFrames.toLocaleString(lang) }));
    const id = ++runId.current;
    setProg(0); setRunStatus({ msg: t('st.running') });
    const t0 = performance.now();
    try {
      const res = await describe(signal, sound.buffer.sampleRate, feats, { frameSize: size, hopSize: hop, onProgress: (p) => { if (id === runId.current) setProg(p); } });
      if (id !== runId.current) return;
      setResult(res); set({ ran: true });
      setRunStatus({ msg: t('st.done', { n: res.nFrames.toLocaleString(lang) }), kind: 'ok' });
      log.ok(res.nFrames + ' frames · ' + feats.length + ' descriptors · ' + ((performance.now() - t0) / 1000).toFixed(1) + ' s');
    } catch (e) {
      if (id === runId.current) setRunStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' });
    } finally { if (id === runId.current) setProg(null); }
  };

  const restored = useRef(false);
  useEffect(() => { if (!restored.current && signal) { restored.current = true; if (st.ran) void run(); } }, [signal]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- table ------------------------------------------------------------- */
  const names = result ? Object.keys(result.features) : [];
  const order = useMemo(() => {
    if (!result) return [];
    const series = !sort.col || sort.col === 'time' ? result.times : result.features[sort.col];
    if (!series) return [];
    const idx = Array.from({ length: result.nFrames }, (_, i) => i);
    idx.sort((a, b) => { const x = series[a], y = series[b]; if (!isFinite(x)) return 1; if (!isFinite(y)) return -1; return (x - y) * sort.dir; });
    return idx.slice(0, MAX_ROWS);
  }, [result, sort]);
  const rowAt = (i: number) => [result!.times[i], ...names.map((n) => result!.features[n][i])];

  const exportPng = () => {
    const canvases = curvesRef.current ? Array.from(curvesRef.current.querySelectorAll('canvas')) : [];
    if (!canvases.length) return;
    const w = canvases[0].width, h = canvases.reduce((a, c) => a + c.height, 0);
    const out = document.createElement('canvas'); out.width = w; out.height = h;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = css('--panel'); ctx.fillRect(0, 0, w, h);
    let y = 0;
    for (const c of canvases) { ctx.drawImage(c, 0, y); y += c.height; }
    png(out, 'courbes.png');
  };

  const mfcc = result?.matrices?.mfcc;


  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        <SoundSource value={st.soundId} onChange={(id) => set({ soundId: id, ran: false })} demos={['sine', 'sweep', 'noise', 'bell', 'pluck', 'texture']} />
        <TransportBar tp={tp} />
        <p className="caption">{sound ? t('caption.loaded', { name: sound.meta.name, dur: sound.buffer.duration.toFixed(2), sr: sound.buffer.sampleRate, ch: sound.buffer.numberOfChannels }) : t('caption.none')}</p>
        <Plot draw={(cv) => (signal ? draw.waveform(cv, signal, { label: sound!.meta.name }) : draw.clear(cv, 130))} deps={[signal]} transport={sound ? tp : null} />
      </Panel>

      <Panel title={t('sp.title')} hintHtml={rich('sp.hint')}>
        <Controls>
          <Field label={t('sp.for')}>
            <select value={st.predictFor} onChange={(e) => set({ predictFor: e.target.value })}>
              {PREDICTABLE.map((id) => <option key={id} value={id}>{t('f.' + id)}</option>)}
            </select>
          </Field>
          <button type="button" onClick={() => set((s) => { const sk = { ...s.sketches }; delete sk[s.predictFor]; return { sketches: sk }; })}>{t('sp.clear')}</button>
        </Controls>
        <p className="da-legend" dangerouslySetInnerHTML={{ __html: rich('sp.legend') }} />
        <Plot className="sketch" draw={drawSketch} deps={[st.predictFor, st.sketches, sound?.buffer]} ariaLabel={t('sp.aria')} canvasRef={sketchCv}
          onPointerDown={(e) => { lastX.current = -1; e.currentTarget.setPointerCapture(e.pointerId); sketchPoint(e); }}
          onPointerMove={(e) => { if (e.buttons) sketchPoint(e); }}
          onPointerUp={endSketch} onPointerLeave={(e) => { if (!e.buttons) endSketch(); }} />
      </Panel>

      <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>
        <Controls>
          <Field label={t('opt.frame')}>
            <select value={st.size} onChange={(e) => set({ size: +e.target.value })}>{[256, 512, 1024, 2048, 4096].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
          <Field label={t('opt.overlap')}>
            <select value={st.overlap} onChange={(e) => set({ overlap: +e.target.value })}>
              <option value={0}>{t('opt.none')}</option><option value={0.5}>50 %</option><option value={0.75}>75 %</option>
            </select>
          </Field>
        </Controls>
        <fieldset className="fieldset">
          <legend className="s-label">{t('opt.features')}</legend>
          <div className="checks">
            {FEATURES.map((f) => (
              <Check key={f.id} code={f.id} checked={st.feats.includes(f.id)}
                onChange={(v) => set((s) => ({ feats: v ? [...s.feats, f.id] : s.feats.filter((x) => x !== f.id) }))}>{t('f.' + f.id)}</Check>
            ))}
          </div>
        </fieldset>
        <Controls><button type="button" className="primary" disabled={!signal || prog !== null} onClick={() => void run()}>{t('btn.run')}</button></Controls>
        <Progress value={prog} />
        <Status s={runStatus} />
      </Panel>

      {result ? (
        <Panel title={t('s3.title')}>
          <p className="hint">{t('res.hint', { size: result.frameSize, hop: result.hopSize, ms: (result.frameSize / result.sampleRate * 1000).toFixed(1), hz: (result.sampleRate / result.frameSize).toFixed(1) })}</p>
          <div ref={curvesRef}>
            {names.map((n) => (
              <Plot key={n} transport={tp} deps={[result, st.sketches[n]]}
                draw={(cv) => { draw.curve(cv, result.times, result.features[n], { label: t('f.' + n), unit: unitFor(n), height: 130 }); overlaySketch(cv, st.sketches[n]); }} />
            ))}
            {mfcc && st.mfccView === 'curves' ? Array.from({ length: mfcc.rows - 1 }, (_, r) => (
              <Plot key={'m' + r} transport={tp} deps={[result]}
                draw={(cv) => draw.curve(cv, result.times, mfcc.data.subarray((r + 1) * mfcc.cols, (r + 2) * mfcc.cols), { label: t('mfcc.curve', { k: r + 1 }), height: 64 })} />
            )) : null}
            {mfcc && st.mfccView === 'heat' ? (
              <Plot transport={tp} deps={[result]} ariaLabel={t('mfcc.aria')} draw={(cv) => {
                // coefficient 0 is overall level, not timbre: without it the other twelve use the whole colour range
                const rows = mfcc.rows - 1, yl: { row: number; text: string }[] = [];
                for (let k = 1; k <= rows; k += (rows > 8 ? 2 : 1)) yl.push({ row: k - 0.5, text: String(k) });
                draw.heat(cv, { rows, cols: mfcc.cols, data: mfcc.data.subarray(mfcc.cols) }, { height: 170, label: t('f.mfcc'), x1: result.times[result.nFrames - 1].toFixed(1) + ' s', yLabels: yl });
              }} />
            ) : null}
          </div>
          {mfcc ? (
            <>
              <Controls>
                <Field label={t('mfcc.view')}>
                  <select value={st.mfccView} onChange={(e) => set({ mfccView: e.target.value as State['mfccView'] })}>
                    <option value="heat">{t('mfcc.viewHeat')}</option><option value="curves">{t('mfcc.viewCurves')}</option>
                  </select>
                </Field>
              </Controls>
              <p className="hint" dangerouslySetInnerHTML={{ __html: rich('mfcc.explain') }} />
            </>
          ) : null}
          <Controls>
            <button type="button" onClick={() => { csvRows(['time_s', ...names], result.nFrames, rowAt, 'descripteurs.csv'); log.ok('CSV — ' + result.nFrames + ' rows'); }}>{t('btn.csv')}</button>
            <button type="button" onClick={exportPng}>{t('btn.png')}</button>
          </Controls>

          <h2 style={{ marginTop: '1.4rem' }}>{t('s4.title')}</h2>
          <p className="hint">{t('s4.hint')}</p>
          <div className="table-wrap">
            <table className="table">
              <caption className="s-label">{t('tbl.caption', { n: result.nFrames.toLocaleString(lang), shown: Math.min(MAX_ROWS, result.nFrames).toLocaleString(lang) })}</caption>
              <thead><tr>
                <SortHeader label={t('col.time')} col="time" sort={sort} onSort={setSort} title={t('tbl.sortBy', { col: t('col.time') })} />
                {names.map((n) => <SortHeader key={n} label={t('f.' + n)} col={n} sort={sort} onSort={setSort} title={t('tbl.sortBy', { col: t('f.' + n) })} />)}
              </tr></thead>
              <tbody>{order.map((i) => <tr key={i}>{rowAt(i).map((v, j) => <td key={j}>{fmt(v)}</td>)}</tr>)}</tbody>
              {result.nFrames > MAX_ROWS ? <tfoot><tr><td colSpan={names.length + 1} className="left muted">{t('tbl.more', { n: (result.nFrames - MAX_ROWS).toLocaleString(lang) })}</td></tr></tfoot> : null}
            </table>
          </div>
        </Panel>
      ) : null}
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tp} />} side={<>
      <Section id="sound" title={t('s1.title')}>
        <SoundSource value={st.soundId} onChange={(id) => set({ soundId: id, ran: false })} demos={['sine', 'sweep', 'noise', 'bell', 'pluck', 'texture']} />
        <p className="caption">{sound ? t('caption.loaded', { name: sound.meta.name, dur: sound.buffer.duration.toFixed(2), sr: sound.buffer.sampleRate, ch: sound.buffer.numberOfChannels }) : t('caption.none')}</p>
      </Section>
      <Section id="analysis" title={t('s2.title')}>
        <Controls>
          <Field label={t('opt.frame')}>
            <select value={st.size} onChange={(e) => set({ size: +e.target.value })}>{[256, 512, 1024, 2048, 4096].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
          <Field label={t('opt.overlap')}>
            <select value={st.overlap} onChange={(e) => set({ overlap: +e.target.value })}>
              <option value={0}>{t('opt.none')}</option><option value={0.5}>50 %</option><option value={0.75}>75 %</option>
            </select>
          </Field>
        </Controls>
        <fieldset className="fieldset">
          <legend className="s-label">{t('opt.features')}</legend>
          <div className="checks">
            {FEATURES.map((f) => (
              <Check key={f.id} code={f.id} checked={st.feats.includes(f.id)}
                onChange={(v) => set((s) => ({ feats: v ? [...s.feats, f.id] : s.feats.filter((x) => x !== f.id) }))}>{t('f.' + f.id)}</Check>
            ))}
          </div>
        </fieldset>
        <Controls><button type="button" className="primary" disabled={!signal || prog !== null} onClick={() => void run()}>{t('btn.run')}</button></Controls>
        <Progress value={prog} />
        <Status s={runStatus} />
        {result ? <p className="caption">{t('res.hint', { size: result.frameSize, hop: result.hopSize, ms: (result.frameSize / result.sampleRate * 1000).toFixed(1), hz: (result.sampleRate / result.frameSize).toFixed(1) })}</p> : null}
      </Section>
    </>}>
      <Split id="main">
        <Pane id="wave" title={t('wb.waveform')} weight={0.8} min={100}>
          {signal ? <Plot fill draw={(cv) => draw.waveform(cv, signal, { label: sound!.meta.name })} deps={[signal]} transport={tp} /> : <Empty />}
        </Pane>
        <Pane id="curves" title={t('s3.title')} weight={2.4}
          actions={result ? <>
            {mfcc ? (
              <select value={st.mfccView} aria-label={t('mfcc.view')} onChange={(e) => set({ mfccView: e.target.value as State['mfccView'] })}>
                <option value="heat">{t('mfcc.viewHeat')}</option><option value="curves">{t('mfcc.viewCurves')}</option>
              </select>
            ) : null}
            <button type="button" onClick={() => { csvRows(['time_s', ...names], result.nFrames, rowAt, 'descripteurs.csv'); log.ok('CSV — ' + result.nFrames + ' rows'); }}>{t('btn.csv')}</button>
            <button type="button" onClick={exportPng}>{t('btn.png')}</button>
          </> : null}>
          {result ? (
            <>
              <div ref={curvesRef}>
                {names.map((n) => (
                  <Plot key={n} transport={tp} deps={[result, st.sketches[n]]}
                    draw={(cv) => { draw.curve(cv, result.times, result.features[n], { label: t('f.' + n), unit: unitFor(n), height: 130 }); overlaySketch(cv, st.sketches[n]); }} />
                ))}
                {mfcc && st.mfccView === 'curves' ? Array.from({ length: mfcc.rows - 1 }, (_, r) => (
                  <Plot key={'m' + r} transport={tp} deps={[result]}
                    draw={(cv) => draw.curve(cv, result.times, mfcc.data.subarray((r + 1) * mfcc.cols, (r + 2) * mfcc.cols), { label: t('mfcc.curve', { k: r + 1 }), height: 64 })} />
                )) : null}
                {mfcc && st.mfccView === 'heat' ? (
                  <Plot transport={tp} deps={[result]} ariaLabel={t('mfcc.aria')} draw={(cv) => {
                    // coefficient 0 is overall level, not timbre: without it the other twelve use the whole colour range
                    const rows = mfcc.rows - 1, yl: { row: number; text: string }[] = [];
                    for (let k = 1; k <= rows; k += (rows > 8 ? 2 : 1)) yl.push({ row: k - 0.5, text: String(k) });
                    draw.heat(cv, { rows, cols: mfcc.cols, data: mfcc.data.subarray(mfcc.cols) }, { height: 170, label: t('f.mfcc'), x1: result.times[result.nFrames - 1].toFixed(1) + ' s', yLabels: yl });
                  }} />
                ) : null}
              </div>
            </>
          ) : <Empty />}
        </Pane>
        <Pane id="table" title={t('s4.title')} weight={1.4} flush
          actions={result ? <span className="caption">{t('tbl.caption', { n: result.nFrames.toLocaleString(lang), shown: Math.min(MAX_ROWS, result.nFrames).toLocaleString(lang) })}</span> : null}>
          {result ? (
            <div className="table-wrap">
              <table className="table">
                <thead><tr>
                  <SortHeader label={t('col.time')} col="time" sort={sort} onSort={setSort} title={t('tbl.sortBy', { col: t('col.time') })} />
                  {names.map((n) => <SortHeader key={n} label={t('f.' + n)} col={n} sort={sort} onSort={setSort} title={t('tbl.sortBy', { col: t('f.' + n) })} />)}
                </tr></thead>
                <tbody>{order.map((i) => <tr key={i}>{rowAt(i).map((v, j) => <td key={j}>{fmt(v)}</td>)}</tr>)}</tbody>
                {result.nFrames > MAX_ROWS ? <tfoot><tr><td colSpan={names.length + 1} className="left muted">{t('tbl.more', { n: (result.nFrames - MAX_ROWS).toLocaleString(lang) })}</td></tr></tfoot> : null}
              </table>
            </div>
          ) : <Empty />}
        </Pane>
      </Split>
    </Workbench>
  );
}
