/* Segmentation — port of ats-segmentation.html.
   Several files, cut where the spectral flux peaks; sensitivity and minimum
   gap; labels that survive re-cutting; a table to listen, label and keep;
   segments.csv and one WAV per segment. New here: the kept segments can be
   sent straight to the batch description tab. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Empty, Pane, Section, Split, Workbench } from '../ui/Workbench';
import { getState, setToolState, useToolState } from '../session/store';
import { getSound } from '../session/sounds';
import { useT } from '../i18n/react';
import { tr } from '../i18n/core';
import { Check, Controls, Field, Panel, Plot, Progress, Readout, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { SoundAdder } from '../ui/SoundList';
import { useLoadedSound } from '../ui/SoundSource';
import { useSoundVersion } from '../session/sounds';
import * as draw from '../lib/draw';
import { css, padLeft } from '../lib/draw';
import { envelope, peaks, spectrogram, Spectrogram } from '../lib/dsp';
import { Novelty, Odf, ODFS, OnsetCurves, onsetCurves, onsetNovelty, SSM_DESCRIPTORS, SsmDistance, SsmFeature, ssmNovelty, transientNovelty } from '../lib/segment';
import * as audio from '../lib/audio';
import { csvRows, saveWav } from '../lib/io';
import { fmtTime } from '../lib/fmt';
import { log } from '../lib/log';
import { toast } from '../ui/dialogs';
import { openItem } from '../shell/nav';
import { S } from './Segmentation.strings';

const FRAME = 1024, HOP = 256;
export type Seg = { start: number; end: number; label: string; keep: boolean };
type FileEntry = { soundId: string; segments: Seg[] | null };
type Method = 'flux' | 'onset' | 'transient' | 'ssm';
type State = {
  files: FileEntry[]; cur: number; sens: number; mingap: number;
  method: Method; odf: Odf; backtrack: boolean; attack: number; floor: number;
  ssmFeature: SsmFeature; ssmDesc: string[]; ssmDist: SsmDistance; kernel: number;
};
const DEFAULTS: State = {
  files: [], cur: -1, sens: 50, mingap: 0.25,
  method: 'flux', odf: 'logflux', backtrack: true, attack: 30, floor: 50,
  ssmFeature: 'mfcc', ssmDesc: ['rms', 'spectralCentroid', 'spectralFlatness'], ssmDist: 'cosine', kernel: 2,
};
const METHODS: Method[] = ['flux', 'onset', 'transient', 'ssm'];
const GAPS: [number, string][] = [[0.02, '20 ms'], [0.05, '50 ms'], [0.1, '100 ms'], [0.25, '250 ms'], [0.5, '500 ms'], [1, '1 s'], [2, '2 s'], [5, '5 s']];

/** What the analysis depends on (sensitivity and gap only re-pick peaks). */
function analysisKey(p: State): string {
  switch (p.method) {
    case 'onset': return 'onset';
    case 'transient': return 'tr:' + p.attack + ':' + p.floor;
    case 'ssm': return 'ssm:' + p.ssmFeature + ':' + (p.ssmFeature === 'descriptors' ? p.ssmDesc.join(',') : '') + ':' + p.ssmDist + ':' + p.kernel;
    default: return 'flux';
  }
}

function fluxNovelty(spec: Spectrogram): Novelty {
  const half = FRAME / 2 / spec.sampleRate;
  return { values: spec.flux, times: spec.fluxTimes, frameSec: HOP / spec.sampleRate, cutAt: (i) => Math.max(0, spec.fluxTimes[i] - half) };
}

function segmentsFor(nov: Novelty, duration: number, sens: number, gapSec: number): Seg[] {
  const gapFrames = Math.max(1, Math.round(gapSec / nov.frameSec));
  const idx = peaks(nov.values, { sensitivity: sens, minGapFrames: gapFrames });
  const cuts = idx.map((i) => nov.cutAt(i)).sort((a, b) => a - b);
  // walls at 0 and end; drop a first cut too close to 0
  const bounds = [0];
  cuts.forEach((c) => { if (c - bounds[bounds.length - 1] >= gapSec * 0.5) bounds.push(c); });
  if (duration - bounds[bounds.length - 1] < gapSec * 0.5 && bounds.length > 1) bounds.pop();
  bounds.push(duration);
  const segs: Seg[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) segs.push({ start: bounds[i], end: bounds[i + 1], label: '', keep: true });
  return segs;
}

/** Re-cut, carrying labels over when a boundary survived. */
function recut(nov: Novelty, duration: number, sens: number, gap: number, old: Seg[] | null): Seg[] {
  const segs = segmentsFor(nov, duration, sens, gap);
  segs.forEach((s) => (old || []).forEach((o) => { if (Math.abs(o.start - s.start) < 0.02 && o.label) { s.label = o.label; s.keep = o.keep; } }));
  return segs;
}

export default function Segmentation({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('segmentation') : findTool('segmentation'))!;
  const { t, rich } = useT(S);
  const [raw, set] = useToolState<State>(lesson ? 'lesson:segmentation' : 'segmentation', DEFAULTS);
  const eff = (p: State): State => ({ ...DEFAULTS, ...p });
  const st = eff(raw);
  useSoundVersion();
  const tp = useTransport();
  // runtime only, recomputed when needed: spectrograms, onset curves, novelties
  const specs = useRef(new Map<string, Spectrogram>());
  const onsets = useRef(new Map<string, OnsetCurves>());
  const novs = useRef(new Map<string, Novelty>());
  const [, bumpSpecs] = useState(0);
  const [prog, setProg] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<StatusMsg>(null);
  const [expStatus, setExpStatus] = useState<StatusMsg>(null);
  const [hl, setHl] = useState(-1);
  const chain = useRef<object | null>(null);
  const busy = prog !== null;

  const files = st.files.filter((f) => getState().sounds.some((s) => s.id === f.soundId && !s.missing));
  const curFile = st.cur >= 0 ? st.files[st.cur] : undefined;
  const sound = useLoadedSound(curFile?.soundId);
  const spec = curFile ? specs.current.get(curFile.soundId) : undefined;
  const segs = curFile?.segments || null;

  /** The novelty of a file for these settings, if it is already computed. */
  const novFor = (soundId: string, p: State): Novelty | undefined => {
    const key = analysisKey(p);
    if (key === 'flux') { const sp = specs.current.get(soundId); return sp ? fluxNovelty(sp) : undefined; }
    if (key === 'onset') { const oc = onsets.current.get(soundId); return oc ? onsetNovelty(oc, p.odf, p.backtrack) : undefined; }
    return novs.current.get(soundId + '|' + key);
  };
  const nov = curFile ? novFor(curFile.soundId, st) : undefined;

  useEffect(() => { tp.setBuffer(sound?.buffer || null); chain.current = null; setHl(-1); }, [sound?.buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  const analyse = async (soundId: string, p: State, onProgress: (p: number) => void): Promise<Novelty> => {
    const s = getSound(soundId);
    if (!s) throw new Error(tr('sounds.missing'));
    const key = analysisKey(p), sr = s.buffer.sampleRate;
    const needSpec = !specs.current.has(soundId), needMore = key !== 'flux' && !novFor(soundId, p);
    const split = needSpec && needMore ? 0.35 : needSpec ? 1 : 0;
    if (needSpec) {
      const sp = await spectrogram(s.signal, sr, { frameSize: FRAME, hopSize: HOP, maxColumns: 2000, onProgress: (x) => onProgress(x * split) });
      specs.current.set(soundId, sp);
    }
    if (needMore) {
      const sub = (x: number) => onProgress(split + (1 - split) * x);
      if (key === 'onset') onsets.current.set(soundId, await onsetCurves(s.signal, sr, { frameSize: FRAME, hopSize: HOP, onProgress: sub }));
      else if (p.method === 'transient') novs.current.set(soundId + '|' + key, await transientNovelty(s.signal, sr, { attackMs: p.attack, floorDb: p.floor, onProgress: sub }));
      else if (p.method === 'ssm') novs.current.set(soundId + '|' + key, await ssmNovelty(s.signal, sr, { feature: p.ssmFeature, descriptors: p.ssmDesc, distance: p.ssmDist, kernelSec: p.kernel, onProgress: sub }));
    }
    bumpSpecs((n) => n + 1);
    return novFor(soundId, p)!;
  };

  const setSegments = (soundId: string, segments: Seg[] | null) =>
    set((s) => ({ files: s.files.map((f) => (f.soundId === soundId ? { ...f, segments } : f)) }));

  // a reopened session (or new settings on a file shown): the cuts are saved, the analyses are not
  useEffect(() => {
    if (curFile?.segments && sound && (!spec || !nov) && !busy) {
      setProg(0);
      analyse(curFile.soundId, st, setProg).catch((e) => setRunStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' })).finally(() => setProg(null));
    }
  }, [curFile?.soundId, sound?.buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  const runOne = async (f: FileEntry, p: State, onProgress: (p: number) => void) => {
    const n = await analyse(f.soundId, p, onProgress);
    const s = getSound(f.soundId)!;
    const out = recut(n, s.buffer.duration, p.sens / 100, p.mingap, f.segments);
    setSegments(f.soundId, out);
    return out;
  };

  const run = async (p: State = st) => {
    if (!curFile || busy) return;
    const name = sound?.meta.name || '';
    setProg(0); setRunStatus({ msg: t('st.running', { name }) });
    try {
      const out = await runOne(curFile, p, setProg);
      setRunStatus({ msg: t('st.done', { name, n: out.length }), kind: 'ok' });
    } catch (e) { setRunStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }); }
    finally { setProg(null); }
  };

  const runAll = async () => {
    if (!files.length || busy) return;
    setProg(0);
    let total = 0;
    try {
      for (let i = 0; i < files.length; i++) {
        setRunStatus({ msg: t('st.running', { name: getSound(files[i].soundId)?.meta.name || '' }) });
        total += (await runOne(files[i], st, (p) => setProg((i + p) / files.length))).length;
      }
      setRunStatus({ msg: t('st.doneAll', { files: files.length, n: total }), kind: 'ok' });
    } catch (e) { setRunStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }); }
    finally { setProg(null); }
  };

  /** Sensitivity and gap re-pick at once; other settings re-analyse a file already cut. */
  const onParams = (patch: Partial<State>) => {
    const next = eff({ ...st, ...patch });
    set(patch);
    if (!curFile?.segments || !sound) return;
    const n = novFor(curFile.soundId, next);
    if (n) {
      const out = recut(n, sound.buffer.duration, next.sens / 100, next.mingap, curFile.segments);
      setSegments(curFile.soundId, out);
      setRunStatus({ msg: t('st.done', { name: sound.meta.name, n: out.length }), kind: 'ok' });
    }
    else if (!busy) void run(next);
  };

  /* --- listening -------------------------------------------------------- */
  const playSegment = (i: number) => {
    if (!segs) return;
    chain.current = null; setHl(i);
    tp.setRange(segs[i].start, segs[i].end); tp.play();
  };
  const playAll = () => {
    if (!segs || !sound) return;
    const order = segs.map((s, i) => (s.keep ? i : -1)).filter((i) => i >= 0);
    const token = {}; chain.current = token;
    let k = 0;
    const next = () => {
      if (chain.current !== token || k >= order.length) { if (chain.current === token) { setHl(-1); tp.setRange(0, null); } return; }
      const i = order[k++];
      setHl(i);
      audio.playRange(sound.buffer, segs[i].start, segs[i].end, () => setTimeout(next, 150));
    };
    next();
  };
  // scrubbing selects the segment under the playhead: the table and the picture agree
  useEffect(() => tp.onSeek((x) => {
    if (!segs) return;
    const i = segs.findIndex((s) => x >= s.start && x < s.end);
    if (i >= 0) setHl(i);
  }), [tp, segs]);
  useEffect(() => { if (hl >= 0) document.getElementById('seg-' + entry.id + '-' + hl)?.scrollIntoView({ block: 'nearest' }); }, [hl, entry.id]);

  const onSpecKey = (e: React.KeyboardEvent) => {
    if (!segs) return;
    let i = hl;
    if (e.key === 'ArrowRight') i = Math.min(segs.length - 1, i + 1);
    else if (e.key === 'ArrowLeft') i = Math.max(0, i - 1);
    else if (e.key === 'Enter' || e.key === ' ') { if (i < 0) i = 0; }
    else return;
    e.preventDefault(); playSegment(i);
  };

  const editSeg = (i: number, patch: Partial<Seg>) => {
    if (!curFile || !segs) return;
    setSegments(curFile.soundId, segs.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  };

  /* --- export ----------------------------------------------------------- */
  const kept = () => {
    const rows: { soundId: string; file: string; i: number; start: number; end: number; label: string }[] = [];
    st.files.forEach((f) => {
      const s = getSound(f.soundId);
      if (!f.segments || !s) return;
      f.segments.forEach((g, i) => { if (g.keep) rows.push({ soundId: f.soundId, file: s.meta.name, i, start: g.start, end: g.end, label: g.label }); });
    });
    return rows;
  };
  const exportCsv = () => {
    const rows = kept();
    if (!rows.length) { setExpStatus({ msg: t('st.none'), kind: 'bad' }); return; }
    csvRows(['file', 'start', 'end', 'label'], rows.length, (i) => [rows[i].file, rows[i].start.toFixed(4), rows[i].end.toFixed(4), rows[i].label], 'segments.csv');
    setExpStatus({ msg: t('st.csv', { n: rows.length }), kind: 'ok' });
  };
  const exportWavs = () => {
    const rows = kept();
    if (!rows.length) { setExpStatus({ msg: t('st.none'), kind: 'bad' }); return; }
    let k = 0;
    const next = () => {
      if (k >= rows.length) return;
      const r = rows[k++], s = getSound(r.soundId)!, sr = s.buffer.sampleRate;
      saveWav(s.signal.subarray(Math.floor(r.start * sr), Math.floor(r.end * sr)), sr, r.file.replace(/\.[^.]+$/, '') + '_' + String(r.i + 1).padStart(2, '0') + '.wav');
      setTimeout(next, 250);
    };
    next();
    setExpStatus({ msg: t('st.wavAll', { n: rows.length }), kind: 'ok' });
  };
  const sendToBatch = () => {
    const rows = kept();
    if (!rows.length) { setExpStatus({ msg: t('st.none'), kind: 'bad' }); return; }
    const ids = Array.from(new Set(rows.map((r) => r.soundId)));
    setToolState(lesson ? 'lesson:batch' : 'batch', { soundIds: ids, segs: rows.map((r) => ({ soundId: r.soundId, start: r.start, end: r.end, label: r.label })), inbox: Date.now(), inboxFrom: 'segmentation' });
    const msg = tr('pipe.sentBatch', { n: rows.length, files: ids.length });
    log.ok(msg); toast(msg, 'ok');
    openItem(lesson ? 'lesson' : 'tool', 'batch');
  };

  const marks = segs && sound ? segs.slice(1).map((s) => s.start / sound.buffer.duration) : [];
  const cmp = useMemo(() => (nov && sound ? [0.25, 0.5, 0.75].map((s) => ({ s, n: segmentsFor(nov, sound.buffer.duration, s, st.mingap).length })) : []), [nov?.values, nov?.cutAt, sound, st.mingap]); // eslint-disable-line react-hooks/exhaustive-deps
  const gapLabel = st.mingap >= 1 ? st.mingap + ' s' : Math.round(st.mingap * 1000) + ' ms';
  const methodTag = st.method === 'onset' ? t('odf.' + st.odf) : t('m.' + st.method);
  const ready = !!(spec && nov && segs && sound);

  /* --- the waveform with its cuts: the main picture ------------------------- */
  const drawWave = (cv: HTMLCanvasElement, height?: number) => {
    if (!sound || !segs) return;
    const { ctx, w, h } = draw.fit(cv, height || 190);
    const padL = padLeft(), padT = 20, padB = 18, plotW = Math.max(10, w - padL - 8), plotH = Math.max(10, h - padT - padB);
    ctx.clearRect(0, 0, w, h);
    const dur = sound.buffer.duration, X = (x: number) => padL + (x / dur) * plotW;
    // one band per segment, alternating; the current one in the accent
    segs.forEach((g, i) => {
      const x0 = X(g.start), x1 = X(g.end);
      ctx.fillStyle = i === hl ? css('--accent-bg') : i % 2 ? css('--sunken') : css('--panel');
      ctx.fillRect(x0, padT, x1 - x0, plotH);
      if (x1 - x0 > 14) {
        ctx.fillStyle = i === hl ? css('--accent') : g.keep ? css('--ink') : css('--line-firm');
        ctx.font = (i === hl ? '600 ' : '') + '10px ' + css('--mono'); ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillText(String(i + 1), (x0 + x1) / 2, padT - 6);
      }
    });
    // the waveform, coloured by segment: kept in ink, unticked faded, current in the accent
    const cols = Math.max(1, Math.floor(plotW)), env = envelope(sound.signal, cols);
    let peak = 1e-9; for (let c = 0; c < cols; c++) peak = Math.max(peak, Math.abs(env.mins[c]), Math.abs(env.maxs[c]));
    const mid = padT + plotH / 2, amp = (plotH / 2) * 0.92 / peak;
    const segAt = (x: number) => { for (let i = 0; i < segs.length; i++) if (x < segs[i].end) return i; return segs.length - 1; };
    const groups: Record<string, number[]> = { on: [], keep: [], off: [] };
    for (let c = 0; c < cols; c++) { const i = segAt((c + 0.5) / cols * dur); groups[i === hl ? 'on' : segs[i].keep ? 'keep' : 'off'].push(c); }
    ([['off', css('--line-firm')], ['keep', css('--ink-soft')], ['on', css('--accent')]] as const).forEach(([k, col]) => {
      ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.beginPath();
      for (const c of groups[k]) { const x = padL + c + 0.5; ctx.moveTo(x, mid - env.maxs[c] * amp); ctx.lineTo(x, mid - env.mins[c] * amp + 0.5); }
      ctx.stroke();
    });
    // the cuts: full-height lines with a marker
    ctx.strokeStyle = css('--warn'); ctx.fillStyle = css('--warn'); ctx.lineWidth = 2;
    segs.slice(1).forEach((g) => {
      const x = Math.round(X(g.start)) + 0.5;
      ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(x - 4, padT); ctx.lineTo(x + 4, padT); ctx.lineTo(x, padT + 6); ctx.closePath(); ctx.fill();
    });
    ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1; ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);
    ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
    ctx.textAlign = 'left'; ctx.fillText('0 s', padL, h - 4);
    ctx.textAlign = 'right'; ctx.fillText(dur.toFixed(1) + ' s', padL + plotW, h - 4);
    draw.setGeom(cv, { padL, padT, plotW, plotH });
    cv.setAttribute('aria-label', t('wave.aria', { name: sound.meta.name, n: segs.length }));
  };
  const onWaveClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!segs || !sound) return;
    const r = e.currentTarget.getBoundingClientRect(), g = draw.geomOf(e.currentTarget);
    const x = ((e.clientX - r.left - g.padL) / g.plotW) * sound.buffer.duration;
    const i = segs.findIndex((s) => x >= s.start && x < s.end);
    if (i >= 0) playSegment(i);
  };

  /* --- pieces shared by the lesson and the tool ------------------------------- */
  const addFiles = (ids: string[]) => set((s) => {
    const fresh = ids.filter((id) => !s.files.some((f) => f.soundId === id));
    const all = [...s.files, ...fresh.map((id) => ({ soundId: id, segments: null }))];
    return { files: all, cur: all.findIndex((f) => f.soundId === ids[ids.length - 1]) };
  });
  const fileList = (
    <ul className="sg-files" aria-label={t('current.label')}>
      {st.files.map((f, i) => {
        const s = getSound(f.soundId);
        return (
          <li key={f.soundId} className={i === st.cur ? 'on' : ''}>
            <button type="button" className="link-btn" aria-current={i === st.cur} onClick={() => set({ cur: i })}>
              {t(f.segments ? 'file.line' : 'file.none', { name: s?.meta.name || '?', dur: fmtTime(s?.buffer.duration || 0), n: f.segments ? f.segments.length : 0 })}
            </button>
            <button type="button" className="icon-btn" aria-label={t('files.remove')} title={t('files.remove')}
              onClick={() => set((x) => { const fs = x.files.filter((y) => y.soundId !== f.soundId); return { files: fs, cur: Math.min(x.cur, fs.length - 1) }; })}>×</button>
          </li>
        );
      })}
    </ul>
  );
  const methodCtl = (
    <>
      <Controls>
        <Field label={t('m.label')}>
          <select value={st.method} disabled={busy} onChange={(e) => onParams({ method: e.target.value as Method })}>
            {METHODS.map((m) => <option key={m} value={m}>{t('m.' + m)}</option>)}
          </select>
        </Field>
        {st.method === 'onset' ? <>
          <Field label={t('odf.label')}>
            <select value={st.odf} disabled={busy} onChange={(e) => onParams({ odf: e.target.value as Odf })}>
              {ODFS.map((o) => <option key={o} value={o}>{t('odf.' + o)}</option>)}
            </select>
          </Field>
          <Check checked={st.backtrack} onChange={(v) => onParams({ backtrack: v })}>{t('opt.backtrack')}</Check>
        </> : null}
        {st.method === 'transient' ? <>
          <Field label={t('tr.attack')}>
            <select value={st.attack} disabled={busy} onChange={(e) => onParams({ attack: +e.target.value })}>
              {[5, 10, 30, 80].map((v) => <option key={v} value={v}>{v} ms</option>)}
            </select>
          </Field>
          <Field label={t('tr.floor')}>
            <select value={st.floor} disabled={busy} onChange={(e) => onParams({ floor: +e.target.value })}>
              {[30, 40, 50, 60, 80].map((v) => <option key={v} value={v}>−{v} dB</option>)}
            </select>
          </Field>
        </> : null}
        {st.method === 'ssm' ? <>
          <Field label={t('ssm.feature')}>
            <select value={st.ssmFeature} disabled={busy} onChange={(e) => onParams({ ssmFeature: e.target.value as SsmFeature })}>
              {(['spectrum', 'mfcc', 'chroma', 'descriptors'] as SsmFeature[]).map((f) => <option key={f} value={f}>{t('ssm.f.' + f)}</option>)}
            </select>
          </Field>
          <Field label={t('ssm.dist')}>
            <select value={st.ssmDist} disabled={busy} onChange={(e) => onParams({ ssmDist: e.target.value as SsmDistance })}>
              <option value="cosine">{t('ssm.d.cosine')}</option><option value="euclidean">{t('ssm.d.euclidean')}</option>
            </select>
          </Field>
          <Field label={t('ssm.kernel')}>
            <select value={st.kernel} disabled={busy} onChange={(e) => onParams({ kernel: +e.target.value })}>
              {[0.5, 1, 2, 4, 8, 16].map((v) => <option key={v} value={v}>{v} s</option>)}
            </select>
          </Field>
        </> : null}
      </Controls>
      {st.method === 'ssm' && st.ssmFeature === 'descriptors' ? (
        <fieldset className="fieldset" disabled={busy}>
          <legend className="s-label">{t('ssm.desc')}</legend>
          <div className="checks">
            {SSM_DESCRIPTORS.map((d) => <Check key={d} checked={st.ssmDesc.includes(d)}
              onChange={(v) => { const next = v ? SSM_DESCRIPTORS.filter((x) => x === d || st.ssmDesc.includes(x)) : st.ssmDesc.filter((x) => x !== d); if (next.length) onParams({ ssmDesc: next }); }}>{t('d.' + d)}</Check>)}
          </div>
        </fieldset>
      ) : null}
    </>
  );
  const cutCtl = (wide: boolean) => (
    <>
      <Controls>
        <Field label={t('sens.label')}><input type="range" min={0} max={100} value={st.sens} onChange={(e) => onParams({ sens: +e.target.value })} /></Field>
        <Field label={t('mingap.label')}>
          <select value={st.mingap} onChange={(e) => onParams({ mingap: +e.target.value })}>
            {GAPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </Field>
        <button type="button" className="primary" disabled={!curFile || busy} onClick={() => void run()}>{t('btn.run')}</button>
        <button type="button" className={wide ? 'wide' : ''} disabled={!st.files.length || busy} onClick={() => void runAll()}>{t('btn.runAll')}</button>
      </Controls>
      <Readout html={rich('readout', { s: st.sens, g: gapLabel })} />
      <Progress value={prog} />
      <Status s={runStatus} />
    </>
  );
  const wavePlot = (fill: boolean) => (
    <Plot fill={fill} className="pointer" transport={tp} tabIndex={0} onKeyDown={onSpecKey} onClick={onWaveClick} deps={[sound, segs, hl]} draw={(cv) => drawWave(cv)}
      ariaLabel={sound && segs ? t('wave.aria', { name: sound.meta.name, n: segs.length }) : undefined} />
  );
  const specPlot = (fill: boolean) => (
    <Plot fill={fill} className="pointer" transport={tp} tabIndex={0} onKeyDown={onSpecKey} onClick={onWaveClick} deps={[spec, segs, hl]}
      draw={(cv) => draw.spectrogram(cv, spec!, { height: 200, logFreq: true, dbRange: 70, marks, label: t('spec.label', { name: sound!.meta.name, n: segs!.length }) + ' · ' + methodTag, cursor: hl >= 0 && segs![hl] ? segs![hl].start / sound!.buffer.duration : undefined })} />
  );
  const novPlot = (fill: boolean) => (
    <Plot fill={fill} transport={tp} deps={[nov!.values, segs]} draw={(cv) => {
      draw.curve(cv, nov!.times, nov!.values, { label: t('nov.' + st.method, { odf: t('odf.' + st.odf) }), height: 110, tMax: sound!.buffer.duration });
      const ctx = cv.getContext('2d')!, w = cv.clientWidth, h = cv.clientHeight;
      const pL = padLeft(), padB = 18, padT = 10, plotW = Math.max(10, w - pL - 8), plotH = Math.max(10, h - padT - padB);
      ctx.strokeStyle = css('--warn'); ctx.lineWidth = 1; ctx.beginPath();
      segs!.slice(1).forEach((g) => { const x = pL + g.start / sound!.buffer.duration * plotW; ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); });
      ctx.stroke();
    }} />
  );
  const ssmPlot = (fill: boolean) => (
    <Plot fill={fill} className="pointer" transport={tp} onClick={onWaveClick} deps={[nov!.matrix, segs, hl]} draw={(cv) => {
      const dur = sound!.buffer.duration;
      const g = draw.heat(cv, nov!.matrix!, { height: 260, padL: padLeft(), label: t('ssm.label', { f: t('ssm.f.' + st.ssmFeature), d: t('ssm.d.' + st.ssmDist) }), x1: dur.toFixed(1) + ' s', marks });
      if (!g) return;
      const ctx = cv.getContext('2d')!;
      ctx.strokeStyle = css('--warn'); ctx.lineWidth = 1; ctx.globalAlpha = 0.7; ctx.beginPath();
      marks.forEach((m) => { const y = g.padT + g.plotH - m * g.plotH; ctx.moveTo(g.padL, y); ctx.lineTo(g.padL + g.plotW, y); });
      ctx.stroke(); ctx.globalAlpha = 1;
      if (hl >= 0 && segs![hl]) {
        const a = segs![hl].start / dur, b = segs![hl].end / dur;
        ctx.strokeStyle = css('--bad'); ctx.lineWidth = 1.5;
        ctx.strokeRect(g.padL + a * g.plotW, g.padT + g.plotH - b * g.plotH, (b - a) * g.plotW, (b - a) * g.plotH);
      }
    }} />
  );
  const cmpLine = cmp.map((c) => t('cmp.row', { s: Math.round(c.s * 100), n: c.n })).join(' · ');
  const exportBtns = <>
    <button type="button" onClick={playAll}>{t('btn.playAll')}</button>
    <button type="button" onClick={exportCsv}>{t('btn.csv')}</button>
    <button type="button" onClick={exportWavs}>{t('btn.wavAll')}</button>
  </>;
  const table = segs ? (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <th scope="col">{t('col.n')}</th><th scope="col">{t('col.play')}</th><th scope="col">{t('col.start')}</th><th scope="col">{t('col.end')}</th>
          <th scope="col">{t('col.dur')}</th><th scope="col" className="left">{t('col.label')}</th><th scope="col">{t('col.keep')}</th>
        </tr></thead>
        <tbody>
          {segs.map((g, i) => (
            <tr key={i} id={'seg-' + entry.id + '-' + i} className={(i === hl ? 'on' : '') + (g.keep ? '' : ' off')}>
              <td>{i + 1}</td>
              <td><button type="button" aria-label={t('play.aria', { n: i + 1 })} onClick={() => playSegment(i)}>▶</button></td>
              <td>{fmtTime(g.start)}</td><td>{fmtTime(g.end)}</td><td>{(g.end - g.start).toFixed(2)}</td>
              <td className="left"><input type="text" value={g.label} aria-label={t('label.aria', { n: i + 1 })} onChange={(e) => editSeg(i, { label: e.target.value })} /></td>
              <td><input type="checkbox" checked={g.keep} aria-label={t('keep.aria', { n: i + 1 })} onChange={(e) => editSeg(i, { keep: e.target.checked })} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : null;

  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        <SoundAdder ids={st.files.map((f) => f.soundId)} demos={['events', 'texture8', 'mixture']} onAdd={addFiles} />
        <TransportBar tp={tp} />
        {fileList}
        {st.files.length ? <p className="status ok">{t('st.loaded', { n: st.files.length })}</p> : null}
      </Panel>

      <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>
        {methodCtl}
        <p className="hint" dangerouslySetInnerHTML={{ __html: rich('m.help.' + st.method) }} />
        {cutCtl(false)}
      </Panel>

      {ready ? (
        <Panel title={t('s3.title')} hintHtml={rich('s3.hint')}>
          {wavePlot(false)}
          <p className="caption">{t('wave.caption')}</p>
          {specPlot(false)}
          {novPlot(false)}
          <p className="caption">{t('cmp.caption')}</p>
          <div className="sg-compare">{cmp.map((c) => <span key={c.s}>{t('cmp.row', { s: Math.round(c.s * 100), n: c.n })}</span>)}</div>
          {st.method === 'ssm' && nov!.matrix ? <>
            <h2 style={{ marginTop: '1rem' }}>{t('pane.ssm')}</h2>
            <p className="hint">{t('ssm.help')}</p>
            {ssmPlot(false)}
          </> : null}

          <h2 style={{ marginTop: '1rem' }}>{t('s4.title')}</h2>
          <p className="hint">{t('s4.hint')}</p>
          <Controls>
            {exportBtns}
            <span className="grow" />
            <button type="button" className="primary" onClick={sendToBatch} title={t('pipe.hint')}>{t('pipe.toBatch')}</button>
          </Controls>
          {table}
          <Status s={expStatus} />
          <p className="small muted">{t('pipe.hint')}</p>
        </Panel>
      ) : null}
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tp} />} side={<>
      <Section id="files" title={t('s1.title')}>
        <SoundAdder ids={st.files.map((f) => f.soundId)} demos={['events', 'texture8', 'mixture']} onAdd={addFiles} />
        {fileList}
        {st.files.length ? <p className="status ok">{t('st.loaded', { n: st.files.length })}</p> : null}
      </Section>
      <Section id="method" title={t('m.title')} help={rich('m.help.' + st.method)}>{methodCtl}</Section>
      <Section id="settings" title={t('s2.title')}>{cutCtl(true)}</Section>
    </>}>
      <Split id="main">
        <Pane id="wave" title={t('pane.wave')} weight={1.5} min={110} help={t('wave.caption')}
          actions={ready ? <span className="caption">{t('spec.label', { name: sound!.meta.name, n: segs!.length })} · {methodTag}</span> : null}>
          {ready ? wavePlot(true) : <Empty />}
        </Pane>
        <Pane id="spec" title={t('pane.spec')} weight={1.3}>
          {ready ? specPlot(true) : <Empty />}
        </Pane>
        <Pane id="novelty" title={t('pane.novelty')} weight={0.8} min={90}
          actions={ready ? <span className="caption" title={t('cmp.caption')}>{cmpLine}</span> : null}>
          {ready ? novPlot(true) : <Empty />}
        </Pane>
        {st.method === 'ssm' ? (
          <Pane id="ssm" title={t('pane.ssm')} weight={1.6} min={120} help={rich('ssm.help')}>
            {ready && nov!.matrix ? ssmPlot(true) : <Empty />}
          </Pane>
        ) : null}
        <Pane id="segments" title={t('s4.title')} weight={1.6} flush
          actions={ready ? <>
            {exportBtns}
            <button type="button" className="primary" onClick={sendToBatch} title={t('pipe.hint')}>{t('pipe.toBatch')}</button>
          </> : null}>
          {ready ? (
            <>
              {table}
              {expStatus && expStatus.msg ? <div className="wb-pane-foot"><Status s={expStatus} /></div> : null}
            </>
          ) : <Empty />}
        </Pane>
      </Split>
    </Workbench>
  );
}
