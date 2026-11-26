/* Carte sonore — port of ats-carte-sonore.html.
   A described corpus (from the batch tab, a corpus.json, or audio described
   here) projected to a plane — PCA, t-SNE or two chosen axes — and played as
   an instrument: hover triggers grains, click selects and labels, the arrows
   walk the map, passes are recorded to WAV. The projection is saved in the
   session, so a t-SNE map reopens as it was. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Empty, Pane, Section, Split, Workbench } from '../ui/Workbench';
import { useApp, useToolState, getState } from '../session/store';
import { getSound, useSoundVersion } from '../session/sounds';
import { useT } from '../i18n/react';
import { tr } from '../i18n/core';
import { Check, Controls, Field, Panel, Plot, Progress, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { SoundAdder } from '../ui/SoundList';
import { columns, CsvSeg, SegRow, describeSegment, fromJSON, parseSegmentsCSV } from '../lib/corpus';
import { css, fit, isDark } from '../lib/draw';
import { extent, pca, tsne } from '../lib/dsp';
import { Distance, distances, isomap, smacof, umap } from '../lib/reduce';
import * as audio from '../lib/audio';
import { csvRows, png, readText, saveWav } from '../lib/io';
import { fmtTime } from '../lib/fmt';
import { log } from '../lib/log';
import type { Described } from './Batch';
import { S } from './SoundMap.strings';

const DEFAULT_FEATURES = ['rms', 'spectralCentroid', 'spectralFlatness', 'pitch', 'mfcc'];
const PALETTE_L = ['#14549e', '#a41f1a', '#12664a', '#7a5200', '#5b2a86', '#0b6b7a', '#8a3a10', '#3d5a1e', '#6d1f5e', '#333c47'];
const PALETTE_D = ['#7fb4ff', '#ff9086', '#6cc79c', '#e0b354', '#c9a3ff', '#5fd3e6', '#f2a36a', '#b6d98a', '#ff9fe0', '#c4ccd6'];

/* rows from the batch tab carry their soundId; rows from a corpus.json are matched by file name */
type Corpus = Omit<Described, 'rows'> & { rows: SegRow[] };
type State = {
  soundIds: string[]; csvSegs: CsvSeg[] | null; corpus: Corpus | null; inbox: number; inboxFrom: string;
  method: Method; ax: string; ay: string; subset: string[] | null;
  dist: Distance; perplexity: number; neighbours: number; minDist: number; isoK: number; seed: number;
  hover: boolean; gain: number;
  positions: { id: number; x: number; y: number }[] | null; axisLabels: [string, string]; selected: number;
};
type Method = 'pca' | 'mds' | 'isomap' | 'tsne' | 'umap' | 'manual';
const DEFAULTS: State = { soundIds: [], csvSegs: null, corpus: null, inbox: 0, inboxFrom: '', method: 'pca', ax: '', ay: '', subset: null,
  dist: 'euclidean', perplexity: 15, neighbours: 15, minDist: 0.1, isoK: 8, seed: 1,
  hover: true, gain: 1, positions: null, axisLabels: ['', ''], selected: -1 };
const ALL_METHODS: Method[] = ['pca', 'mds', 'isomap', 'tsne', 'umap', 'manual'];

export default function SoundMap({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('soundmap') : findTool('soundmap'))!;
  const { t, rich } = useT(S);
  const [raw, set] = useToolState<State>(lesson ? 'lesson:soundmap' : 'soundmap', DEFAULTS);
  const st: State = { ...DEFAULTS, ...raw };
  const methods = ALL_METHODS;
  if (!methods.includes(st.method)) st.method = 'pca';
  useSoundVersion();
  const sounds = useApp((s) => s.sounds);
  const tp = useTransport();
  const [prog, setProg] = useState<number | null>(null);
  const [loadStatus, setLoadStatus] = useState<StatusMsg>(null);
  const [projStatus, setProjStatus] = useState<StatusMsg>(null);
  const [expStatus, setExpStatus] = useState<StatusMsg>(null);
  const [hovered, setHovered] = useState(-1);
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  const [recT, setRecT] = useState<string | null>(null);
  const passes = useRef(0);
  const geo = useRef<{ px: number; py: number; r: number }[]>([]);

  const nameOf = (id: string) => sounds.find((s) => s.id === id)?.name || '?';
  /** The audio of a corpus row: its session sound, or a session sound with its file name. */
  const soundFor = (r: SegRow) => {
    const sid = typeof r.soundId === 'string' ? r.soundId : '';
    if (sid && getSound(sid)) return getSound(sid);
    const m = getState().sounds.find((s) => s.name === r.file && getSound(s.id));
    return m ? getSound(m.id) : null;
  };

  useEffect(() => { if (st.inbox && st.inboxFrom === 'batch') setLoadStatus({ msg: tr('pipe.fromBatch', { n: st.corpus?.rows.length || 0 }), kind: 'ok' }); }, [st.inbox]); // eslint-disable-line react-hooks/exhaustive-deps

  /* --- the corpus --------------------------------------------------------- */
  const pending = useMemo(() => {          // segments waiting to be described
    if (st.corpus) return [];
    const ids = st.soundIds.filter((id) => getSound(id));
    let id = 0;
    if (st.csvSegs) return st.csvSegs.map((s): SegRow => ({ id: id++, file: s.file, start: s.start, end: s.end, label: s.label || '', soundId: ids.find((x) => nameOf(x) === s.file) || '' }));
    return [...ids].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).map((sid): SegRow => ({ id: id++, file: nameOf(sid), start: 0, end: getSound(sid)!.buffer.duration, label: '', soundId: sid }));
  }, [st.corpus, st.csvSegs, st.soundIds, sounds]) as SegRow[]; // eslint-disable-line react-hooks/exhaustive-deps

  const allRows = st.corpus ? st.corpus.rows : pending;
  const ready = allRows.filter((r) => soundFor(r));
  const missingFiles = Array.from(new Set(allRows.filter((r) => !soundFor(r)).map((r) => r.file)));
  const fileNames = Array.from(new Set(ready.map((r) => r.file))).sort();

  const onOther = async (files: File[]) => {
    for (const f of files) {
      try {
        const text = await readText(f);
        if (/\.json$/i.test(f.name)) {
          const o = fromJSON(text);
          set({ corpus: { features: o.features, columns: o.columns, rows: o.segments.map((s, k) => ({ ...s, id: k })) }, positions: null, selected: -1, subset: null });
          log.ok(t('st.jsonLoaded', { n: o.segments.length, f: o.features.length }));
          setLoadStatus({ msg: t('st.jsonLoaded', { n: o.segments.length, f: o.features.length }), kind: 'ok' });
        } else if (/\.csv$/i.test(f.name)) {
          set({ csvSegs: parseSegmentsCSV(text), corpus: null, positions: null });
        }
      } catch (e) { setLoadStatus({ msg: f.name + ' : ' + (e as Error).message, kind: 'bad' }); }
    }
  };

  const describeAll = async () => {
    const segs = pending.filter((s) => soundFor(s));
    const cols = columns(DEFAULT_FEATURES), rows: Corpus['rows'] = [];
    setProg(0);
    try {
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], snd = soundFor(s)!;
        setLoadStatus({ msg: t('st.running', { i: i + 1, n: segs.length }) });
        const r = await describeSegment(snd.signal, snd.buffer.sampleRate, s.start, s.end, DEFAULT_FEATURES, { onProgress: (p) => setProg((i + p) / segs.length) });
        const row: SegRow = { ...s };
        cols.forEach((c) => { row[c] = r[c]; });
        rows.push(row);
      }
      set({ corpus: { features: DEFAULT_FEATURES, columns: cols, rows }, positions: null, subset: null });
      setLoadStatus({ msg: t('st.described', { n: segs.length }), kind: 'ok' });
    } catch (e) { setLoadStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }); }
    finally { setProg(null); }
  };

  /* --- projection ---------------------------------------------------------- */
  const corpus = st.corpus;
  const groups = useMemo(() => {
    if (!corpus) return [];
    const g = [{ id: 'duration', cols: ['duration'] }];
    corpus.features.forEach((f) => g.push({ id: f, cols: corpus.columns.filter((c) => c === f + '_mean' || c === f + '_std' || (c === 'voiced' && f === 'pitch') || (f === 'mfcc' && /^mfcc_/.test(c))) }));
    return g;
  }, [corpus]);
  const subset = st.subset || groups.filter((g) => g.id !== 'duration').map((g) => g.id);
  const axes = corpus ? corpus.columns.filter((c) => !/^mfcc_/.test(c)) : [];
  const ax = st.ax && axes.includes(st.ax) ? st.ax : (axes.includes('spectralCentroid_mean') ? 'spectralCentroid_mean' : axes[0]);
  const ay = st.ay && axes.includes(st.ay) ? st.ay : (axes.includes('rms_mean') ? 'rms_mean' : axes[0]);
  const colLabel = (c: string) => {
    if (c === 'duration') return t('f.duration');
    if (c === 'voiced') return t('c.voiced');
    const m = /^(.+)_(mean|std)$/.exec(c);
    return m ? t('f.' + m[1]) + ' ' + t('c.' + m[2]) : c.replace('_', ' ');
  };

  const plot = async (p: State = st) => {
    if (!corpus) return;
    const segs = corpus.rows.filter((r) => soundFor(r));
    let cols: string[];
    if (p.method === 'manual') cols = [ax, ay];
    else { cols = []; groups.forEach((g) => { if (subset.includes(g.id)) cols = cols.concat(g.cols); }); }
    if (cols.length < 2) { setProjStatus({ msg: t('st.fewSubset'), kind: 'bad' }); return; }
    const vectors = segs.map((s) => cols.map((c) => { const v = s[c]; return typeof v === 'number' && isFinite(v) ? v : NaN; }));
    const done = (Y: number[][], lx: string, ly: string, extra = '') => {
      set({ positions: segs.map((s, i) => ({ id: s.id, x: Y[i][0], y: Y[i][1] })), axisLabels: [lx, ly], selected: -1 });
      setProjStatus({ msg: t('st.plotted', { method: t('method.' + p.method), d: cols.length }) + extra, kind: 'ok' });
    };
    const axis = (n: number) => t('axis.' + p.method, { n });
    const onProgress = (x: number) => { setProg(x); setProjStatus({ msg: t('st.running.proj', { method: t('method.' + p.method), p: Math.round(x * 100) }) }); };
    setProg(0);
    try {
      if (p.method === 'pca') done(pca(vectors), axis(1), axis(2));
      else if (p.method === 'manual') done(vectors.map((v) => [v[0], v[1]]), colLabel(cols[0]), colLabel(cols[1]));
      else {
        const { n, D } = await distances(vectors, p.dist);
        if (p.method === 'tsne') done(await tsne(vectors, { perplexity: p.perplexity, seed: p.seed, distances: p.dist === 'euclidean' ? undefined : D, iterations: Math.min(500, 200 + segs.length), onProgress }), axis(1), axis(2));
        else if (p.method === 'umap') done(await umap(n, D, { neighbours: p.neighbours, minDist: p.minDist, seed: p.seed, onProgress }), axis(1), axis(2));
        else if (p.method === 'mds') { const r = await smacof(n, D, { onProgress }); done(r.Y, axis(1), axis(2), t('st.stress', { s: r.stress.toFixed(3) })); }
        else if (p.method === 'isomap') { const r = await isomap(n, D, { k: p.isoK, onProgress }); done(r.Y, axis(1), axis(2), r.components > 1 ? t('st.components', { n: r.components }) : ''); }
      }
    } catch (e) { setProjStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }); }
    finally { setProg(null); }
  };

  /* --- the map ------------------------------------------------------------- */
  const points = useMemo(() => {
    if (!corpus || !st.positions) return [];
    const byId = new Map(corpus.rows.map((r) => [r.id, r]));
    return st.positions.map((p) => ({ ...p, seg: byId.get(p.id)! })).filter((p) => p.seg && soundFor(p.seg));
  }, [corpus, st.positions, sounds]); // eslint-disable-line react-hooks/exhaustive-deps
  const pal = () => (isDark() ? PALETTE_D : PALETTE_L);
  const colourOf = (file: string) => pal()[Math.max(0, fileNames.indexOf(file)) % PALETTE_L.length];
  const sel = st.selected;

  const drawMap = (cv: HTMLCanvasElement) => {
    const { ctx, w, h } = fit(cv, Math.max(360, Math.min(560, window.innerHeight * 0.55))), pad = 28;
    ctx.clearRect(0, 0, w, h);
    geo.current = [];
    if (!points.length) return;
    const ex = extent(points.map((p) => p.x)) || { min: 0, max: 1 }, ey = extent(points.map((p) => p.y)) || { min: 0, max: 1 };
    const sx = (v: number) => pad + (ex.max > ex.min ? (v - ex.min) / (ex.max - ex.min) : 0.5) * (w - 2 * pad);
    const sy = (v: number) => h - pad - (ey.max > ey.min ? (v - ey.min) / (ey.max - ey.min) : 0.5) * (h - 2 * pad);
    const ed = extent(points.map((p) => p.seg.end - p.seg.start)) || { min: 0, max: 1 };
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
    ctx.strokeRect(pad - 8 + 0.5, pad - 8 + 0.5, w - 2 * pad + 16, h - 2 * pad + 16);
    ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
    ctx.textAlign = 'right'; ctx.fillText(st.axisLabels[0] + ' →', w - pad + 6, h - 6);
    ctx.save(); ctx.translate(12, pad - 8); ctx.rotate(-Math.PI / 2); ctx.textAlign = 'right'; ctx.fillText(st.axisLabels[1] + ' →', 0, 0); ctx.restore();
    points.forEach((p, i) => {
      const px = isFinite(p.x) ? sx(p.x) : w / 2, py = isFinite(p.y) ? sy(p.y) : h / 2, d = p.seg.end - p.seg.start;
      const r = 4 + (ed.max > ed.min ? Math.sqrt((d - ed.min) / (ed.max - ed.min)) : 0.5) * 7;
      geo.current[i] = { px, py, r };
      ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI);
      ctx.fillStyle = colourOf(p.seg.file); ctx.globalAlpha = 0.78; ctx.fill(); ctx.globalAlpha = 1;
      if (i === sel || i === hovered) { ctx.lineWidth = i === sel ? 3 : 2; ctx.strokeStyle = i === sel ? css('--ink') : css('--accent'); ctx.stroke(); }
      if (p.seg.label) { ctx.fillStyle = css('--ink'); ctx.font = '11px ' + css('--sans'); ctx.textAlign = 'left'; ctx.fillText(String(p.seg.label), px + r + 3, py + 4); }
    });
  };

  const nearest = (x: number, y: number) => {
    let best = -1, bd = 1e9;
    geo.current.forEach((g, i) => { const d = Math.hypot(g.px - x, g.py - y); if (d < bd && d <= g.r + 6) { bd = d; best = i; } });
    return best;
  };
  const play = (i: number) => { const p = points[i], snd = p && soundFor(p.seg); if (snd) audio.trigger(snd.buffer, p.seg.start, p.seg.end, st.gain); };
  const select = (i: number) => {
    set({ selected: i });
    const p = points[i], snd = p && soundFor(p.seg);
    if (snd) { if (tp.buffer !== snd.buffer) tp.setBuffer(snd.buffer); tp.setRange(p.seg.start, p.seg.end); }
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (!points.length) return;
    const dirs: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const d = dirs[e.key];
    if (d) {
      e.preventDefault();
      if (sel < 0 || !geo.current[sel]) { select(0); play(0); return; }
      const cur = geo.current[sel]; let best = -1, bs = 1e9;
      geo.current.forEach((p, i) => {
        if (i === sel) return;
        const dx = p.px - cur.px, dy = p.py - cur.py, along = dx * d[0] + dy * d[1];
        if (along <= 0) return;
        const score = Math.hypot(dx, dy) + 2 * Math.abs(dx * d[1] - dy * d[0]);
        if (score < bs) { bs = score; best = i; }
      });
      if (best >= 0) { select(best); play(best); }
    } else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (sel >= 0) play(sel); }
  };
  const setLabel = (label: string) => {
    const p = points[sel]; if (!p || !corpus) return;
    set({ corpus: { ...corpus, rows: corpus.rows.map((r) => (r.id === p.id ? { ...r, label } : r)) } });
  };

  /* --- recording ----------------------------------------------------------- */
  const recTimer = useRef<number>(0);
  useEffect(() => () => { clearInterval(recTimer.current); if (audio.record.active()) audio.record.stop(); }, []);
  const toggleRec = () => {
    if (audio.record.active()) {
      const r = audio.record.stop();
      clearInterval(recTimer.current); setRecT(null);
      if (!r || !r.samples.length) { setExpStatus({ msg: tr('err.emptyRecord'), kind: 'bad' }); return; }
      passes.current++;
      const n = String(passes.current).padStart(2, '0');
      saveWav(r.samples, r.sampleRate, 'passe_' + n + '.wav');
      setExpStatus({ msg: t('st.saved', { n, dur: r.duration.toFixed(1) }), kind: 'ok' });
    } else {
      try { audio.record.start(); } catch (err) { setExpStatus({ msg: (err as Error).message, kind: 'bad' }); return; }
      setRecT(fmtTime(0));
      recTimer.current = window.setInterval(() => setRecT(fmtTime(audio.record.elapsed())), 200);
    }
  };

  const mapCv = useRef<HTMLCanvasElement | null>(null);
  const selP = sel >= 0 ? points[sel] : undefined;
  const summary = rich('summary', { segs: allRows.length, ready: ready.length, desc: corpus ? corpus.rows.length : 0 })
    + (missingFiles.length ? rich('summary.missing', { list: missingFiles.slice(0, 6).join(', ') + (missingFiles.length > 6 ? '…' : '') }) : '');


  const projCtl = (
    <>
      <Controls>
        <Field label={t('method.label')}>
          <select value={st.method} onChange={(e) => set({ method: e.target.value as Method })}>
            {methods.map((m) => <option key={m} value={m}>{t('method.' + m)}</option>)}
          </select>
        </Field>
        {st.method !== 'pca' && st.method !== 'manual' ? (
          <Field label={t('opt.dist')}>
            <select value={st.dist} onChange={(e) => set({ dist: e.target.value as Distance })}>
              {(['euclidean', 'cosine', 'manhattan'] as Distance[]).map((d) => <option key={d} value={d}>{t('dist.' + d)}</option>)}
            </select>
          </Field>
        ) : null}
        {st.method === 'tsne' ? (
          <Field label={t('opt.perplexity', { v: st.perplexity })}><input type="range" min={2} max={50} value={st.perplexity} onChange={(e) => set({ perplexity: +e.target.value })} /></Field>
        ) : null}
        {st.method === 'umap' ? <>
          <Field label={t('opt.neighbours', { v: st.neighbours })}><input type="range" min={2} max={50} value={st.neighbours} onChange={(e) => set({ neighbours: +e.target.value })} /></Field>
          <Field label={t('opt.minDist', { v: st.minDist.toFixed(2) })}><input type="range" min={0} max={99} value={Math.round(st.minDist * 100)} onChange={(e) => set({ minDist: +e.target.value / 100 })} /></Field>
        </> : null}
        {st.method === 'isomap' ? (
          <Field label={t('opt.isoK', { v: st.isoK })}><input type="range" min={2} max={30} value={st.isoK} onChange={(e) => set({ isoK: +e.target.value })} /></Field>
        ) : null}
        {st.method === 'manual' ? (
          <>
            <Field label={t('ax.x')}><select value={ax} onChange={(e) => set({ ax: e.target.value })}>{axes.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}</select></Field>
            <Field label={t('ax.y')}><select value={ay} onChange={(e) => set({ ay: e.target.value })}>{axes.map((c) => <option key={c} value={c}>{colLabel(c)}</option>)}</select></Field>
          </>
        ) : null}
      </Controls>
      {st.method !== 'manual' ? (
        <fieldset className="fieldset">
          <legend className="s-label">{t('subset.legend')}</legend>
          <div className="checks">
            {groups.map((g) => <Check key={g.id} checked={subset.includes(g.id)} onChange={(v) => set({ subset: v ? [...subset, g.id] : subset.filter((x) => x !== g.id) })}>{t('f.' + g.id)}</Check>)}
          </div>
        </fieldset>
      ) : null}
      <Controls>
        <button type="button" className="primary" disabled={prog !== null} onClick={() => void plot()}>{t('btn.plot')}</button>
        {st.method === 'tsne' || st.method === 'umap' ? (
          <button type="button" disabled={prog !== null} title={t('btn.reseedHint')} onClick={() => { const p = { ...st, seed: st.seed + 1 }; set({ seed: p.seed }); void plot(p); }}>{t('btn.reseed')}</button>
        ) : null}
      </Controls>
      <Progress value={corpus ? prog : null} />
      <Status s={projStatus} />
    </>
  );

  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        <SoundAdder ids={st.soundIds} demos={['events', 'texture8', 'bell', 'pluck', 'noise', 'sweep']}
          accept="audio/*,.json,.csv,application/json,text/csv" main={t('drop.main')} formats={t('drop.formats')} onOther={(f) => void onOther(f)}
          onAdd={(ids) => set((s) => ({ soundIds: [...s.soundIds, ...ids.filter((id) => !s.soundIds.includes(id))] }))} />
        <ul className="sg-files">
          {st.soundIds.map((id) => (
            <li key={id}><span className="mono small grow">{nameOf(id)} — {fmtTime(getSound(id)?.buffer.duration || 0)}</span>
              <button type="button" className="icon-btn" aria-label={tr('files.remove')} onClick={() => set((s) => ({ soundIds: s.soundIds.filter((x) => x !== id) }))}>×</button></li>
          ))}
        </ul>
        {allRows.length ? <p className="readout" dangerouslySetInnerHTML={{ __html: summary }} /> : null}
        {corpus ? (
          <p className="small muted">{corpus.rows.length} segments · {corpus.features.join(', ')}{' '}
            <button type="button" className="link-btn" onClick={() => set({ corpus: null, positions: null, selected: -1 })}>×</button></p>
        ) : null}
        <Controls><button type="button" className="primary" disabled={!!corpus || !ready.length || prog !== null} onClick={() => void describeAll()}>{t('btn.describe')}</button></Controls>
        <Progress value={corpus ? null : prog} />
        <Status s={loadStatus} />
      </Panel>

      {corpus && ready.length ? (
        <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>
          {projCtl}
          <p className="hint" dangerouslySetInnerHTML={{ __html: rich('help.' + st.method) }} />
        </Panel>
      ) : null}

      {points.length ? (
        <Panel title={t('s3.title')} hintHtml={rich('s3.hint')}>
          <Controls>
            <Check checked={st.hover} onChange={(v) => set({ hover: v })}>{t('opt.hover')}</Check>
            <Field label={t('opt.gain')}><select value={st.gain} onChange={(e) => set({ gain: +e.target.value })}><option value={0.5}>−6 dB</option><option value={1}>0 dB</option></select></Field>
            <button type="button" className={recT !== null ? 'danger' : ''} onClick={toggleRec}>{recT !== null ? t('btn.recStop') : t('btn.rec')}</button>
            {recT !== null ? <span className="cs-rec" aria-live="polite">{t('rec.time', { t: recT })}</span> : null}
            <button type="button" onClick={() => { tp.stop(); audio.stop(); }}>{t('btn.stop')}</button>
          </Controls>
          <Plot className="map" draw={drawMap} deps={[points, sel, hovered, st.axisLabels]} tabIndex={0} onKeyDown={onKey} canvasRef={mapCv}
            ariaLabel={t('map.aria', { n: points.length })}
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, i = nearest(x, y);
              if (i !== hovered) { setHovered(i); if (i >= 0 && st.hover) play(i); }
              setTip(i >= 0 ? { i, x: Math.min(r.width - 240, x + 14), y: y + 14 } : null);
            }}
            onPointerLeave={() => { setHovered(-1); setTip(null); }}
            onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(), i = nearest(e.clientX - r.left, e.clientY - r.top); if (i >= 0) { select(i); play(i); } }}>
            {tip && points[tip.i] ? (
              <div className="cs-tip" style={{ left: tip.x, top: tip.y }}>
                {t('tip', { file: points[tip.i].seg.file, start: fmtTime(points[tip.i].seg.start), end: fmtTime(points[tip.i].seg.end), label: String(points[tip.i].seg.label || '') })}
              </div>
            ) : null}
          </Plot>
          <div className="cs-legend">{fileNames.map((n) => <span key={n} style={{ color: colourOf(n) }}>{n}</span>)}</div>
          {selP ? (
            <p className="cs-selected">
              <span>{t('sel.text', { file: selP.seg.file, start: fmtTime(selP.seg.start) })}</span>{' '}
              <input type="text" value={String(selP.seg.label || '')} aria-label={t('sel.labelAria')} placeholder={t('sel.labelPh')} onChange={(e) => setLabel(e.target.value)} />
            </p>
          ) : null}
          <TransportBar tp={tp} />
          <Controls>
            <button type="button" onClick={() => mapCv.current && png(mapCv.current, 'carte_sonore.png')}>{t('btn.png')}</button>
            <button type="button" onClick={() => {
              csvRows(['id', 'file', 'start', 'end', 'label', 'x', 'y'], points.length, (i) => { const p = points[i], s = p.seg; return [s.id + 1, s.file, s.start.toFixed(4), s.end.toFixed(4), s.label || '', p.x, p.y]; }, 'carte.csv');
              setExpStatus({ msg: t('st.csv'), kind: 'ok' });
            }}>{t('btn.csv')}</button>
          </Controls>
          <Status s={expStatus} />
        </Panel>
      ) : null}
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tp} />} side={<>
      <Section id="corpus" title={t('s1.title')}>
        <SoundAdder ids={st.soundIds} demos={['events', 'texture8', 'bell', 'pluck', 'noise', 'sweep']}
          accept="audio/*,.json,.csv,application/json,text/csv" main={t('drop.main')} formats={t('drop.formats')} onOther={(f) => void onOther(f)}
          onAdd={(ids) => set((s) => ({ soundIds: [...s.soundIds, ...ids.filter((id) => !s.soundIds.includes(id))] }))} />
        <ul className="sg-files">
          {st.soundIds.map((id) => (
            <li key={id}><span className="mono small grow">{nameOf(id)} — {fmtTime(getSound(id)?.buffer.duration || 0)}</span>
              <button type="button" className="icon-btn" aria-label={tr('files.remove')} onClick={() => set((s) => ({ soundIds: s.soundIds.filter((x) => x !== id) }))}>×</button></li>
          ))}
        </ul>
        {allRows.length ? <p className="readout" dangerouslySetInnerHTML={{ __html: summary }} /> : null}
        {corpus ? (
          <p className="small muted">{corpus.rows.length} segments · {corpus.features.join(', ')}{' '}
            <button type="button" className="link-btn" onClick={() => set({ corpus: null, positions: null, selected: -1 })}>×</button></p>
        ) : null}
        <Controls><button type="button" className="primary" disabled={!!corpus || !ready.length || prog !== null} onClick={() => void describeAll()}>{t('btn.describe')}</button></Controls>
        <Progress value={corpus ? null : prog} />
        <Status s={loadStatus} />
      </Section>
      {corpus && ready.length ? (
        <Section id="projection" title={t('s2.title')} help={rich('help.' + st.method)}>
          {projCtl}
        </Section>
      ) : null}
      {points.length ? (
        <Section id="play" title={t('s3.title')}>
          <Controls>
            <Check checked={st.hover} onChange={(v) => set({ hover: v })}>{t('opt.hover')}</Check>
            <Field label={t('opt.gain')}><select value={st.gain} onChange={(e) => set({ gain: +e.target.value })}><option value={0.5}>−6 dB</option><option value={1}>0 dB</option></select></Field>
            <button type="button" className={recT !== null ? 'danger' : ''} onClick={toggleRec}>{recT !== null ? t('btn.recStop') : t('btn.rec')}</button>
            <button type="button" onClick={() => { tp.stop(); audio.stop(); }}>{t('btn.stop')}</button>
          </Controls>
          {recT !== null ? <p className="cs-rec" aria-live="polite">{t('rec.time', { t: recT })}</p> : null}
        </Section>
      ) : null}
    </>}>
      <Split id="main">
        <Pane id="map" title={t('pane.map')} flush
          actions={points.length ? <>
            <button type="button" onClick={() => mapCv.current && png(mapCv.current, 'carte_sonore.png')}>{t('btn.png')}</button>
            <button type="button" onClick={() => {
              csvRows(['id', 'file', 'start', 'end', 'label', 'x', 'y'], points.length, (i) => { const p = points[i], s = p.seg; return [s.id + 1, s.file, s.start.toFixed(4), s.end.toFixed(4), s.label || '', p.x, p.y]; }, 'carte.csv');
              setExpStatus({ msg: t('st.csv'), kind: 'ok' });
            }}>{t('btn.csv')}</button>
          </> : null}>
          {points.length ? (
            <>
              <Plot fill className="map" draw={drawMap} deps={[points, sel, hovered, st.axisLabels]} tabIndex={0} onKeyDown={onKey} canvasRef={mapCv}
                ariaLabel={t('map.aria', { n: points.length })}
                onPointerMove={(e) => {
                  const r = e.currentTarget.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, i = nearest(x, y);
                  if (i !== hovered) { setHovered(i); if (i >= 0 && st.hover) play(i); }
                  setTip(i >= 0 ? { i, x: Math.min(r.width - 240, x + 14), y: y + 14 } : null);
                }}
                onPointerLeave={() => { setHovered(-1); setTip(null); }}
                onClick={(e) => { const r = e.currentTarget.getBoundingClientRect(), i = nearest(e.clientX - r.left, e.clientY - r.top); if (i >= 0) { select(i); play(i); } }}>
                {tip && points[tip.i] ? (
                  <div className="cs-tip" style={{ left: tip.x, top: tip.y }}>
                    {t('tip', { file: points[tip.i].seg.file, start: fmtTime(points[tip.i].seg.start), end: fmtTime(points[tip.i].seg.end), label: String(points[tip.i].seg.label || '') })}
                  </div>
                ) : null}
              </Plot>
              <div className="wb-pane-foot">
                <div className="cs-legend">{fileNames.map((n) => <span key={n} style={{ color: colourOf(n) }}>{n}</span>)}</div>
                <span className="grow" />
                {selP ? (
                  <span className="cs-selected">
                    <span>{t('sel.text', { file: selP.seg.file, start: fmtTime(selP.seg.start) })}</span>{' '}
                    <input type="text" value={String(selP.seg.label || '')} aria-label={t('sel.labelAria')} placeholder={t('sel.labelPh')} onChange={(e) => setLabel(e.target.value)} />
                  </span>
                ) : null}
                <Status s={expStatus} />
              </div>
            </>
          ) : <Empty />}
        </Pane>
      </Split>
    </Workbench>
  );
}
