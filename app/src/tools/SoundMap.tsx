/* Carte sonore — port of ats-carte-sonore.html.
   A session corpus (session/corpora.ts), described by the batch tab or here,
   projected to a plane — PCA, t-SNE or two chosen axes — and played as
   an instrument: hover triggers grains, click selects and labels, the arrows
   walk the map, passes are recorded to WAV. The projection is saved in the
   session, so a t-SNE map reopens as it was. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Empty, Pane, Section, Split, Workbench } from '../ui/Workbench';
import { useApp, useToolState } from '../session/store';
import { useSoundVersion } from '../session/sounds';
import { CorpusEntry, entrySound, getCorpus, setDescription, updateEntry, useCorpora, useCorpus } from '../session/corpora';
import { addToCorpusDialog, CorpusInput } from '../ui/CorpusPicker';
import { useT } from '../i18n/react';
import { tr } from '../i18n/core';
import { Check, Controls, Field, Panel, Plot, Progress, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { columns, describeSegment } from '../lib/corpus';
import { css, fit, isDark } from '../lib/draw';
import { extent, pca, tsne } from '../lib/dsp';
import { Distance, distances, isomap, smacof, umap } from '../lib/reduce';
import * as audio from '../lib/audio';
import { csvRows, png, saveWav, saveWavZip, slug } from '../lib/io';
import { fmtTime } from '../lib/fmt';
import { S } from './SoundMap.strings';

const DEFAULT_FEATURES = ['rms', 'spectralCentroid', 'spectralFlatness', 'pitch', 'mfcc'];
const PALETTE_L = ['#14549e', '#a41f1a', '#12664a', '#7a5200', '#5b2a86', '#0b6b7a', '#8a3a10', '#3d5a1e', '#6d1f5e', '#333c47'];
const PALETTE_D = ['#7fb4ff', '#ff9086', '#6cc79c', '#e0b354', '#c9a3ff', '#5fd3e6', '#f2a36a', '#b6d98a', '#ff9fe0', '#c4ccd6'];

/** A described corpus item: the entry and its values, flat. */
type MapRow = CorpusEntry & { [col: string]: unknown };
type State = {
  corpusId: string | null;
  method: Method; ax: string; ay: string; subset: string[] | null;
  dist: Distance; perplexity: number; neighbours: number; minDist: number; isoK: number; seed: number;
  hover: boolean; gain: number;
  /** the projection, for the corpus it was made from */
  positions: { id: string; x: number; y: number }[] | null; posCorpus: string | null; axisLabels: [string, string]; selected: number;
  /** the points picked for export (entry ids) */
  picked: string[];
};
type Method = 'pca' | 'mds' | 'isomap' | 'tsne' | 'umap' | 'manual';
const DEFAULTS: State = { corpusId: null, method: 'pca', ax: '', ay: '', subset: null,
  dist: 'euclidean', perplexity: 15, neighbours: 15, minDist: 0.1, isoK: 8, seed: 1,
  hover: true, gain: 1, positions: null, posCorpus: null, axisLabels: ['', ''], selected: -1, picked: [] };
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
  const [descProg, setDescProg] = useState<number | null>(null);
  const [loadStatus, setLoadStatus] = useState<StatusMsg>(null);
  const [projStatus, setProjStatus] = useState<StatusMsg>(null);
  const [expStatus, setExpStatus] = useState<StatusMsg>(null);
  const [hovered, setHovered] = useState(-1);
  const [tip, setTip] = useState<{ i: number; x: number; y: number } | null>(null);
  const [recT, setRecT] = useState<string | null>(null);
  const passes = useRef(0);
  const geo = useRef<{ px: number; py: number; r: number }[]>([]);

  const corpora = useCorpora();
  const corpusObj = useCorpus(st.corpusId);
  useEffect(() => { if (!corpusObj && corpora.length && !st.corpusId) set({ corpusId: corpora[corpora.length - 1].id }); }, [corpusObj, corpora.length]); // eslint-disable-line react-hooks/exhaustive-deps
  const soundFor = (r: CorpusEntry) => entrySound(r);

  /* --- the corpus --------------------------------------------------------- */
  const allRows = corpusObj?.entries || [];
  const ready = allRows.filter((r) => soundFor(r));
  const pending = corpusObj ? ready.filter((r) => !(corpusObj.desc && r.values)) : [];
  const fileNames = Array.from(new Set(ready.map((r) => r.file))).sort();
  /** the described part of the corpus, as flat rows */
  const corpus = useMemo(() => {
    if (!corpusObj?.desc) return null;
    const rows: MapRow[] = corpusObj.entries.filter((e) => e.values).map((e) => ({ ...e, ...e.values }));
    return rows.length ? { features: corpusObj.desc.features, columns: corpusObj.desc.columns, rows } : null;
  }, [corpusObj]);

  const describeAll = async () => {
    if (!corpusObj) return;
    const id = corpusObj.id, feats = corpusObj.desc?.features || DEFAULT_FEATURES, cols = corpusObj.desc?.columns || columns(DEFAULT_FEATURES);
    const segs = pending, values = new Map<string, Record<string, number>>();
    setDescProg(0);
    try {
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], snd = soundFor(s)!;
        setLoadStatus({ msg: t('st.running', { i: i + 1, n: segs.length }) });
        const r = await describeSegment(snd.signal, snd.buffer.sampleRate, s.start, s.end, feats, { onProgress: (p) => setDescProg((i + p) / segs.length) });
        const v: Record<string, number> = {};
        cols.forEach((c) => { v[c] = r[c]; });
        values.set(s.id, v);
      }
      if (getCorpus(id)) setDescription(id, { features: feats, columns: cols }, values);
      setLoadStatus({ msg: t('st.described', { n: segs.length }), kind: 'ok' });
    } catch (e) { setLoadStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }); }
    finally { setDescProg(null); }
  };

  /* --- projection ---------------------------------------------------------- */
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
      set({ positions: segs.map((s, i) => ({ id: s.id, x: Y[i][0], y: Y[i][1] })), posCorpus: corpusObj?.id || null, axisLabels: [lx, ly], selected: -1 });
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
    if (!corpus || !st.positions || st.posCorpus !== corpusObj?.id) return [];
    const byId = new Map(corpus.rows.map((r) => [r.id, r]));
    return st.positions.map((p) => ({ ...p, seg: byId.get(p.id)! })).filter((p) => p.seg && soundFor(p.seg));
  }, [corpus, st.positions, st.posCorpus, sounds]); // eslint-disable-line react-hooks/exhaustive-deps
  const offMap = corpus && points.length ? corpus.rows.filter((r) => soundFor(r)).length - points.length : 0;
  const pal = () => (isDark() ? PALETTE_D : PALETTE_L);
  const colourOf = (file: string) => pal()[Math.max(0, fileNames.indexOf(file)) % PALETTE_L.length];
  const sel = st.selected;
  /* picking several points: shift/⌘-click toggles one, a drag on the empty map draws a box */
  const pickedSet = useMemo(() => new Set(st.picked), [st.picked]);
  const picks = points.filter((p) => pickedSet.has(p.id));
  const [boxView, setBoxView] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  const box = useRef<{ x0: number; y0: number; x1: number; y1: number; add: boolean } | null>(null);
  const skipClick = useRef(false);

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
      if (pickedSet.has(p.id)) {
        ctx.beginPath(); ctx.arc(px, py, r + 3.5, 0, 2 * Math.PI);
        ctx.lineWidth = 2; ctx.strokeStyle = css('--accent'); ctx.stroke();
        ctx.beginPath(); ctx.arc(px, py, r, 0, 2 * Math.PI);
      }
      if (i === sel || i === hovered) { ctx.lineWidth = i === sel ? 3 : 2; ctx.strokeStyle = i === sel ? css('--ink') : css('--accent'); ctx.stroke(); }
      if (p.seg.label) { ctx.fillStyle = css('--ink'); ctx.font = '11px ' + css('--sans'); ctx.textAlign = 'left'; ctx.fillText(String(p.seg.label), px + r + 3, py + 4); }
    });
    if (boxView) {
      const x = Math.min(boxView.x0, boxView.x1), y = Math.min(boxView.y0, boxView.y1), bw = Math.abs(boxView.x1 - boxView.x0), bh = Math.abs(boxView.y1 - boxView.y0);
      ctx.fillStyle = css('--accent'); ctx.globalAlpha = 0.08; ctx.fillRect(x, y, bw, bh); ctx.globalAlpha = 1;
      ctx.setLineDash([4, 3]); ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, bw, bh); ctx.setLineDash([]);
    }
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
    const p = points[sel]; if (!p || !corpusObj) return;
    updateEntry(corpusObj.id, p.id, { label });
  };

  const local = (e: React.PointerEvent<HTMLCanvasElement> | React.MouseEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, r };
  };
  const onMapDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = local(e);
    skipClick.current = false;
    if (nearest(x, y) >= 0) return;
    box.current = { x0: x, y0: y, x1: x, y1: y, add: e.shiftKey || e.metaKey || e.ctrlKey };
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  };
  const onMapMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y, r } = local(e);
    if (box.current) {
      box.current.x1 = x; box.current.y1 = y;
      if (Math.abs(x - box.current.x0) > 4 || Math.abs(y - box.current.y0) > 4) { setBoxView({ ...box.current }); setTip(null); }
      return;
    }
    const i = nearest(x, y);
    if (i !== hovered) { setHovered(i); if (i >= 0 && st.hover) play(i); }
    setTip(i >= 0 ? { i, x: Math.min(r.width - 240, x + 14), y: y + 14 } : null);
  };
  const onMapUp = () => {
    const b = box.current; box.current = null;
    if (!b) return;
    setBoxView(null);
    if (Math.abs(b.x1 - b.x0) <= 4 && Math.abs(b.y1 - b.y0) <= 4) return;
    skipClick.current = true;
    const x0 = Math.min(b.x0, b.x1), x1 = Math.max(b.x0, b.x1), y0 = Math.min(b.y0, b.y1), y1 = Math.max(b.y0, b.y1);
    const inside = points.filter((_, i) => { const g = geo.current[i]; return g && g.px >= x0 && g.px <= x1 && g.py >= y0 && g.py <= y1; }).map((p) => p.id);
    set({ picked: b.add ? Array.from(new Set([...st.picked, ...inside])) : inside });
  };
  const onMapClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (skipClick.current) { skipClick.current = false; return; }
    const { x, y } = local(e), i = nearest(x, y), mod = e.shiftKey || e.metaKey || e.ctrlKey;
    if (i >= 0 && mod) { const id = points[i].id; set({ picked: pickedSet.has(id) ? st.picked.filter((p) => p !== id) : [...st.picked, id] }); play(i); return; }
    if (i >= 0) { select(i); play(i); return; }
    if (!mod && st.picked.length) set({ picked: [] });
  };

  /* --- the picked points: listen, download, keep -------------------------------- */
  const pickChain = useRef<object | null>(null);
  const playPicks = () => {
    const list = picks, token = {}; pickChain.current = token; let k = 0;
    const next = () => {
      if (pickChain.current !== token || k >= list.length) return;
      const p = list[k++], snd = soundFor(p.seg);
      if (!snd) { next(); return; }
      set({ selected: points.indexOf(p) });
      audio.playRange(snd.buffer, p.seg.start, p.seg.end, () => setTimeout(next, 120));
    };
    next();
  };
  const numOf = (id: string) => (corpusObj ? corpusObj.entries.findIndex((e) => e.id === id) + 1 : 0);
  const downloadPicks = async () => {
    const items = picks.map((p) => {
      const snd = soundFor(p.seg); if (!snd) return null;
      const sr = snd.buffer.sampleRate;
      const name = String(numOf(p.id)).padStart(3, '0') + '_' + (slug(String(p.seg.label || ''), 30) || slug(p.seg.file.replace(/\.[^.]+$/, ''), 30) || 'son') + '.wav';
      return { name, signal: snd.signal.subarray(Math.floor(p.seg.start * sr), Math.floor(p.seg.end * sr)), sampleRate: sr };
    }).filter(Boolean) as { name: string; signal: Float32Array; sampleRate: number }[];
    if (!items.length) return;
    await saveWavZip(items, (slug(corpusObj?.name || '') || 'carte') + '_selection.zip');
    setExpStatus({ msg: t('st.zip', { n: items.length }), kind: 'ok' });
  };
  const picksToCorpus = async () => {
    if (!corpusObj || !picks.length) return;
    await addToCorpusDialog(picks.map((p) => ({ ...corpusObj.entries.find((e) => e.id === p.id)!, origin: 'copy' as const })),
      { title: t('pick.toCorpusTitle'), from: corpusObj.desc, exclude: corpusObj.id, canReplace: false });
  };
  const pickBar = picks.length ? (
    <div className="cs-picks" role="group" aria-label={t('pick.count', { n: picks.length })}>
      <b>{t('pick.count', { n: picks.length })}</b>
      <button type="button" onClick={playPicks}>{t('pick.play')}</button>
      <button type="button" className="primary" onClick={() => void downloadPicks()}>{t('pick.zip')}</button>
      <button type="button" onClick={() => void picksToCorpus()}>{t('pick.toCorpus')}</button>
      <button type="button" onClick={() => { pickChain.current = null; set({ picked: [] }); }}>{t('pick.clear')}</button>
    </div>
  ) : <span className="small muted">{t('pick.hint')}</span>;
  const csvExport = () => {
    csvRows(['id', 'file', 'start', 'end', 'label', 'x', 'y', 'picked'], points.length, (i) => { const p = points[i], s = p.seg; return [numOf(p.id), s.file, s.start.toFixed(4), s.end.toFixed(4), s.label || '', p.x, p.y, pickedSet.has(p.id) ? 1 : 0]; }, 'carte.csv');
    setExpStatus({ msg: t('st.csv'), kind: 'ok' });
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

  const corpusBlock = (
    <>
      <CorpusInput value={st.corpusId} onChange={(id) => set({ corpusId: id, selected: -1, picked: [] })} lesson={lesson} demos={['events', 'texture8', 'bell', 'pluck', 'noise', 'sweep']} />
      {corpus ? <p className="small muted">{t('desc.line', { n: corpus.rows.length, f: corpus.features.map((f) => t('f.' + f)).join(', ') })}</p> : null}
      {offMap > 0 ? <p className="readout" dangerouslySetInnerHTML={{ __html: rich('summary.offMap', { n: offMap }) }} /> : null}
      {pending.length ? (
        <Controls><button type="button" className="primary" disabled={prog !== null || descProg !== null} onClick={() => void describeAll()}>
          {corpus ? t('btn.describeNew', { n: pending.length }) : t('btn.describe')}</button></Controls>
      ) : null}
      <Progress value={descProg} />
      <Status s={loadStatus} />
    </>
  );

  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        {corpusBlock}
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
          <Plot className="map" draw={drawMap} deps={[points, sel, hovered, st.axisLabels, pickedSet, boxView]} tabIndex={0} onKeyDown={onKey} canvasRef={mapCv}
            ariaLabel={t('map.aria', { n: points.length })}
            onPointerDown={onMapDown} onPointerMove={onMapMove} onPointerUp={onMapUp}
            onPointerLeave={() => { setHovered(-1); setTip(null); }}
            onClick={onMapClick}>
            {tip && points[tip.i] ? (
              <div className="cs-tip" style={{ left: tip.x, top: tip.y }}>
                {t('tip', { file: points[tip.i].seg.file, start: fmtTime(points[tip.i].seg.start), end: fmtTime(points[tip.i].seg.end), label: String(points[tip.i].seg.label || '') })}
              </div>
            ) : null}
          </Plot>
          <div className="cs-legend">{fileNames.map((n) => <span key={n} style={{ color: colourOf(n) }}>{n}</span>)}</div>
          <div className="cs-pickrow">{pickBar}</div>
          {selP ? (
            <p className="cs-selected">
              <span>{t('sel.text', { file: selP.seg.file, start: fmtTime(selP.seg.start) })}</span>{' '}
              <input type="text" value={String(selP.seg.label || '')} aria-label={t('sel.labelAria')} placeholder={t('sel.labelPh')} onChange={(e) => setLabel(e.target.value)} />
            </p>
          ) : null}
          <TransportBar tp={tp} />
          <Controls>
            <button type="button" onClick={() => mapCv.current && png(mapCv.current, 'carte_sonore.png')}>{t('btn.png')}</button>
            <button type="button" onClick={csvExport}>{t('btn.csv')}</button>
          </Controls>
          <Status s={expStatus} />
        </Panel>
      ) : null}
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tp} />} side={<>
      <Section id="corpus" title={t('s1.title')}>
        {corpusBlock}
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
            <button type="button" onClick={csvExport}>{t('btn.csv')}</button>
          </> : null}>
          {points.length ? (
            <>
              <Plot fill className="map" draw={drawMap} deps={[points, sel, hovered, st.axisLabels, pickedSet, boxView]} tabIndex={0} onKeyDown={onKey} canvasRef={mapCv}
                ariaLabel={t('map.aria', { n: points.length })}
                onPointerDown={onMapDown} onPointerMove={onMapMove} onPointerUp={onMapUp}
                onPointerLeave={() => { setHovered(-1); setTip(null); }}
                onClick={onMapClick}>
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
              <div className="wb-pane-foot cs-pickrow">{pickBar}</div>
            </>
          ) : <Empty />}
        </Pane>
      </Split>
    </Workbench>
  );
}
