/* Atelier spectral — take a sound apart in the spectrum and put it back.
   One sound; optionally a time selection (the region processed); an
   operation that splits it into layers by soft masks — harmonic/percussive,
   tonal/transient/residual, NMF components, noise reduction, or a mask drawn
   on the spectrogram — and each layer listened to, exported as WAV or added
   to the session's sounds for the other tools.

   Saved in the session: the settings, the selection and the drawing. The
   layers are recomputed (they are audio) when a session is reopened. */

import { useEffect, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Empty, Pane, Section, Split, Workbench } from '../ui/Workbench';
import { useToolState } from '../session/store';
import { addSignal } from '../session/sounds';
import { useT } from '../i18n/react';
import { Controls, Field, Panel, Plot, Progress, Seg, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { SoundSource, useLoadedSound } from '../ui/SoundSource';
import * as draw from '../lib/draw';
import { css, geomOf } from '../lib/draw';
import { spectrogram, Spectrogram } from '../lib/dsp';
import { denoiseMasks, drawnMask, freqAxis, hpssMasks, istft, nmf, rasterStrokes, stft, Stroke } from '../lib/spectral';
import * as audio from '../lib/audio';
import { png, saveWav, slug } from '../lib/io';
import { fmtTime } from '../lib/fmt';
import { toast } from '../ui/dialogs';
import { S } from './Spectral.strings';

type Op = 'hpss' | 'transient' | 'nmf' | 'denoise' | 'drawn';
type Mode = 'listen' | 'select' | 'paint' | 'erase';
type State = {
  soundId: string | null; size: number; op: Op;
  lenTime: number; lenFreq: number; margin: number;
  nmfK: number; nmfIter: number; seed: number;
  nrDb: number; nrSens: number; nrProfile: [number, number] | null;
  keep: boolean; strokes: Stroke[]; brush: number; mode: Mode;
  sel: [number, number] | null; layer: number; ran: boolean;
};
const DEFAULTS: State = {
  soundId: null, size: 2048, op: 'hpss',
  lenTime: 17, lenFreq: 17, margin: 3,
  nmfK: 4, nmfIter: 150, seed: 1,
  nrDb: 24, nrSens: 1.5, nrProfile: null,
  keep: true, strokes: [], brush: 0.03, mode: 'listen',
  sel: null, layer: 0, ran: false,
};
const OPS: Op[] = ['hpss', 'transient', 'nmf', 'denoise', 'drawn'];
const MAX_SEC = 60;

type Layer = { name: string; signal: Float32Array; buffer: AudioBuffer; spec: Spectrogram };
type Result = { region: [number, number]; layers: Layer[]; nmfH?: { K: number; C: number; H: Float32Array; centroids: number[] } };

export default function Spectral({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('spectral') : findTool('spectral'))!;
  const { t, rich } = useT(S);
  const [raw, set] = useToolState<State>(lesson ? 'lesson:spectral' : 'spectral', DEFAULTS);
  const st: State = { ...DEFAULTS, ...raw };
  const sound = useLoadedSound(st.soundId);
  const tp = useTransport(), tpOut = useTransport();
  const [spec, setSpec] = useState<Spectrogram | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [prog, setProg] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusMsg>(null);
  const [draft, setDraft] = useState<Stroke | null>(null);
  const [dragSel, setDragSel] = useState<[number, number] | null>(null);
  const mainCv = useRef<HTMLCanvasElement | null>(null), outCv = useRef<HTMLCanvasElement | null>(null);
  const runId = useRef(0);
  const busy = prog !== null;
  const sr = sound?.buffer.sampleRate || 44100, dur = sound?.buffer.duration || 0;
  const sel = dragSel || st.sel;
  const layer = result ? result.layers[Math.min(st.layer, result.layers.length - 1)] : undefined;

  /* --- the sound and its picture ------------------------------------------ */
  useEffect(() => {
    runId.current++;
    tp.setBuffer(sound?.buffer || null); tpOut.setBuffer(null);
    setSpec(null); setResult(null); setProg(null);
    if (!sound) return;
    const id = runId.current;
    setProg(0);
    spectrogram(sound.signal, sr, { frameSize: st.size, hopSize: st.size / 4, maxColumns: 1600, onProgress: (p) => { if (id === runId.current) setProg(p); } })
      .then((s) => { if (id === runId.current) { setSpec(s); if (st.ran) void run(); } })
      .catch((e) => setStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }))
      .finally(() => { if (id === runId.current) setProg(null); });
  }, [sound?.buffer, st.size]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { tpOut.setBuffer(layer?.buffer || null); }, [layer?.buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  // the canvas is a scrubber only in "listen" mode
  useEffect(() => { if (mainCv.current) mainCv.current.dataset.noseek = st.mode === 'listen' ? '0' : '1'; });

  /* --- processing ------------------------------------------------------------ */
  const run = async () => {
    if (!sound) return;
    const region: [number, number] = st.sel ? [st.sel[0], st.sel[1]] : [0, dur];
    if (region[1] - region[0] > MAX_SEC) { setStatus({ msg: t('st.tooLong', { max: MAX_SEC }), kind: 'bad' }); return; }
    if (region[1] - region[0] < 0.1) { setStatus({ msg: t('st.tooShort'), kind: 'bad' }); return; }
    if (st.op === 'drawn' && !st.strokes.some((s) => !s.erase)) { setStatus({ msg: t('st.noDrawing'), kind: 'bad' }); return; }
    const id = ++runId.current, p0 = performance.now();
    const sig = sound.signal.subarray(Math.floor(region[0] * sr), Math.floor(region[1] * sr));
    const step = (a: number, b: number) => (p: number) => { if (id === runId.current) setProg(a + (b - a) * p); };
    setProg(0); setStatus({ msg: t('st.running', { op: t('op.' + st.op) }) });
    try {
      const S = await stft(sig, sr, st.size, st.size / 4, step(0, 0.1));
      let masks: Float32Array[], names: string[], nmfH: Result['nmfH'];
      if (st.op === 'hpss') { masks = await hpssMasks(S, { lenTime: st.lenTime, lenFreq: st.lenFreq, margin: 1, onProgress: step(0.1, 0.5) }); names = [t('l.harmonic'), t('l.percussive')]; }
      else if (st.op === 'transient') { masks = await hpssMasks(S, { lenTime: st.lenTime, lenFreq: st.lenFreq, margin: st.margin, onProgress: step(0.1, 0.5) }); names = [t('l.tonal'), t('l.transient'), t('l.residual')]; }
      else if (st.op === 'nmf') {
        const r = await nmf(S, { K: st.nmfK, iterations: st.nmfIter, seed: st.seed, onProgress: step(0.1, 0.5) });
        masks = r.masks; names = r.centroids.map((c, k) => t('l.component', { n: k + 1, hz: Math.round(c) }));
        nmfH = { K: r.K, C: r.colsH, H: r.H, centroids: r.centroids };
      } else if (st.op === 'denoise') {
        const fr = (x: number) => Math.round((x - region[0]) * sr / S.hop);
        const prof = st.nrProfile ? [fr(st.nrProfile[0]), fr(st.nrProfile[1])] as [number, number] : null;
        masks = denoiseMasks(S, { reductionDb: st.nrDb, sensitivity: st.nrSens, profile: prof }); names = [t('l.cleaned'), t('l.noise')];
      } else { masks = drawnMask(S, st.strokes, region[0], st.keep); names = st.keep ? [t('l.drawn'), t('l.rest')] : [t('l.withoutDrawn'), t('l.drawnOnly')]; }
      const layers: Layer[] = [];
      for (let i = 0; i < masks.length; i++) {
        const y = await istft(S, masks[i], step(0.5 + 0.5 * i / masks.length, 0.5 + 0.5 * (i + 0.7) / masks.length));
        const sp = await spectrogram(y.length >= st.size ? y : padTo(y, st.size), sr, { frameSize: st.size, hopSize: st.size / 4, maxColumns: 1200 });
        layers.push({ name: names[i], signal: y, buffer: audio.toBuffer(y, sr), spec: sp });
        if (id !== runId.current) return;
      }
      setResult({ region, layers, nmfH });
      set({ ran: true, layer: Math.min(st.layer, layers.length - 1) });
      setStatus({ msg: t('st.done', { n: layers.length, s: ((performance.now() - p0) / 1000).toFixed(1) }), kind: 'ok' });
    } catch (e) { if (id === runId.current) setStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }); }
    finally { if (id === runId.current) setProg(null); }
  };

  /* --- the canvas: listen, select, paint ---------------------------------------- */
  const axis = freqAxis(sr, st.size);
  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const cv = e.currentTarget, r = cv.getBoundingClientRect(), g = geomOf(cv);
    const u = Math.max(0, Math.min(1, (e.clientX - r.left - g.padL) / g.plotW)), v = Math.max(0, Math.min(1, (e.clientY - r.top - g.padT) / g.plotH));
    return { tt: u * dur, hz: axis.toHz(v), x: e.clientX, y: e.clientY, ar: g.plotW / g.plotH };
  };
  const anchor = useRef<{ tt: number; x: number; y: number } | null>(null);
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!spec || st.mode === 'listen') return;
    const p = at(e);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    anchor.current = p;
    if (st.mode === 'select') setDragSel([p.tt, p.tt]);
    else setDraft({ erase: st.mode === 'erase', r: st.brush, ar: p.ar, pts: [[p.tt, p.hz]] });
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!anchor.current) return;
    const p = at(e);
    if (st.mode === 'select') setDragSel([Math.min(anchor.current.tt, p.tt), Math.max(anchor.current.tt, p.tt)]);
    else if (draft && Math.hypot(p.x - anchor.current.x, p.y - anchor.current.y) > 2) {
      anchor.current = p;
      setDraft({ ...draft, pts: [...draft.pts, [p.tt, p.hz]] });
    }
  };
  const onUp = () => {
    if (!anchor.current) return;
    anchor.current = null;
    if (st.mode === 'select' && dragSel) { set({ sel: dragSel[1] - dragSel[0] > 0.02 ? dragSel : null }); setDragSel(null); }
    else if (draft) { set({ strokes: [...st.strokes, draft] }); setDraft(null); }
  };

  const drawMain = (cv: HTMLCanvasElement) => {
    if (!spec || !sound) return;
    const g = draw.spectrogram(cv, spec, { logFreq: true, dbRange: 80, label: sound.meta.name });
    if (!g) return;
    const ctx = cv.getContext('2d')!, X = (s: number) => g.padL + (s / dur) * g.plotW;
    const strokes = draft ? [...st.strokes, draft] : st.strokes;
    if (strokes.length) {
      const layerCv = rasterStrokes(strokes, g.plotW, g.plotH, 0, dur, axis, { color: css('--accent') });
      ctx.save(); ctx.globalAlpha = 0.45; ctx.drawImage(layerCv, g.padL, g.padT, g.plotW, g.plotH); ctx.restore();
    }
    if (st.nrProfile && st.op === 'denoise') {
      ctx.fillStyle = css('--warn'); ctx.globalAlpha = 0.85;
      ctx.fillRect(X(st.nrProfile[0]), g.padT + g.plotH - 5, Math.max(2, X(st.nrProfile[1]) - X(st.nrProfile[0])), 5);
      ctx.globalAlpha = 1;
    }
    if (sel) {
      ctx.fillStyle = css('--ink'); ctx.globalAlpha = 0.28;
      ctx.fillRect(g.padL, g.padT, X(sel[0]) - g.padL, g.plotH);
      ctx.fillRect(X(sel[1]), g.padT, g.padL + g.plotW - X(sel[1]), g.plotH);
      ctx.globalAlpha = 1; ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(X(sel[0]), g.padT); ctx.lineTo(X(sel[0]), g.padT + g.plotH); ctx.moveTo(X(sel[1]), g.padT); ctx.lineTo(X(sel[1]), g.padT + g.plotH); ctx.stroke();
    }
  };
  const drawOut = (cv: HTMLCanvasElement) => {
    if (!layer || !result) return;
    draw.spectrogram(cv, layer.spec, { logFreq: true, dbRange: 80, label: layer.name + ' · ' + fmtTime(result.region[0]) + ' → ' + fmtTime(result.region[1]) });
  };
  const drawAct = (cv: HTMLCanvasElement) => {
    const h = result?.nmfH; if (!h) return;
    draw.heat(cv, { rows: h.K, cols: h.C, data: flipRows(h.H, h.K, h.C) }, {
      yLabels: h.centroids.map((_, k) => ({ row: h.K - k - 0.5, text: String(k + 1) })), x1: (result!.region[1] - result!.region[0]).toFixed(1) + ' s', label: t('act.label'),
    });
  };

  /* --- export ------------------------------------------------------------------ */
  const base = () => slug((sound?.meta.name || 'son').replace(/\.[^.]+$/, ''));
  const exportLayer = (l: Layer) => saveWav(l.signal, sr, base() + '_' + slug(l.name) + '.wav');
  const toSession = async (l: Layer) => { const m = await addSignal(base() + ' — ' + l.name, l.signal, sr); toast(t('st.added', { name: m.name }), 'ok'); };
  const selSignal = () => (sound && st.sel ? sound.signal.slice(Math.floor(st.sel[0] * sr), Math.floor(st.sel[1] * sr)) : null);

  /* --- pieces shared by both layouts ------------------------------------------------ */
  const modeCtl = (
    <>
      <Seg<Mode> label={t('mode.label')} value={st.mode} onChange={(m) => set({ mode: m })}
        options={(['listen', 'select', 'paint', 'erase'] as Mode[]).map((m) => ({ value: m, label: t('mode.' + m), title: t('mode.' + m + '.hint') }))} />
      {st.mode === 'paint' || st.mode === 'erase' ? (
        <Field label={t('brush.label')}><input type="range" min={5} max={150} value={Math.round(st.brush * 1000)} onChange={(e) => set({ brush: +e.target.value / 1000 })} /></Field>
      ) : null}
    </>
  );
  const selCtl = (
    <>
      <p className="small mono">{st.sel ? t('sel.text', { a: fmtTime(st.sel[0]), b: fmtTime(st.sel[1]), d: (st.sel[1] - st.sel[0]).toFixed(2) }) : t('sel.none', { max: MAX_SEC })}</p>
      <Controls>
        <button type="button" disabled={!st.sel || !sound} onClick={() => sound && st.sel && audio.playRange(sound.buffer, st.sel[0], st.sel[1])}>{t('sel.play')}</button>
        <button type="button" disabled={!st.sel} onClick={() => { const y = selSignal(); if (y) saveWav(y, sr, base() + '_' + st.sel![0].toFixed(2) + '-' + st.sel![1].toFixed(2) + '.wav'); }}>{t('sel.wav')}</button>
        <button type="button" disabled={!st.sel} onClick={() => { const y = selSignal(); if (y) void addSignal(base() + ' ' + fmtTime(st.sel![0]) + '–' + fmtTime(st.sel![1]), y, sr).then((m) => toast(t('st.added', { name: m.name }), 'ok')); }}>{t('sel.session')}</button>
        <button type="button" disabled={!st.sel} onClick={() => set({ sel: null })}>{t('sel.clear')}</button>
      </Controls>
      <Controls>
        <button type="button" disabled={!st.strokes.length} onClick={() => set({ strokes: st.strokes.slice(0, -1) })}>{t('draw.undo')}</button>
        <button type="button" disabled={!st.strokes.length} onClick={() => set({ strokes: [] })}>{t('draw.clear')}</button>
        <span className="small muted">{t('draw.count', { n: st.strokes.length })}</span>
      </Controls>
    </>
  );
  const opCtl = (
    <>
      <Controls>
        <Field label={t('op.label')}>
          <select value={st.op} disabled={busy} onChange={(e) => set({ op: e.target.value as Op })}>{OPS.map((o) => <option key={o} value={o}>{t('op.' + o)}</option>)}</select>
        </Field>
        <Field label={t('size.label')}>
          <select value={st.size} disabled={busy} onChange={(e) => set({ size: +e.target.value })}>{[512, 1024, 2048, 4096].map((v) => <option key={v} value={v}>{v} ({(v / sr * 1000).toFixed(0)} ms)</option>)}</select>
        </Field>
      </Controls>
      {st.op === 'hpss' || st.op === 'transient' ? (
        <Controls>
          <Field label={t('hp.time', { v: st.lenTime, ms: Math.round(st.lenTime * st.size / 4 / sr * 1000) })}><input type="range" min={3} max={61} step={2} value={st.lenTime} onChange={(e) => set({ lenTime: +e.target.value })} /></Field>
          <Field label={t('hp.freq', { v: st.lenFreq, hz: Math.round(st.lenFreq * sr / st.size) })}><input type="range" min={3} max={61} step={2} value={st.lenFreq} onChange={(e) => set({ lenFreq: +e.target.value })} /></Field>
          {st.op === 'transient' ? <Field label={t('hp.margin', { v: st.margin.toFixed(1) })}><input type="range" min={11} max={60} value={Math.round(st.margin * 10)} onChange={(e) => set({ margin: +e.target.value / 10 })} /></Field> : null}
        </Controls>
      ) : null}
      {st.op === 'nmf' ? (
        <Controls>
          <Field label={t('nmf.k', { v: st.nmfK })}><input type="range" min={2} max={12} value={st.nmfK} onChange={(e) => set({ nmfK: +e.target.value })} /></Field>
          <Field label={t('nmf.iter', { v: st.nmfIter })}><input type="range" min={30} max={400} step={10} value={st.nmfIter} onChange={(e) => set({ nmfIter: +e.target.value })} /></Field>
          <button type="button" disabled={busy} title={t('nmf.reseedHint')} onClick={() => set({ seed: st.seed + 1 })}>{t('nmf.reseed', { n: st.seed })}</button>
        </Controls>
      ) : null}
      {st.op === 'denoise' ? (
        <>
          <Controls>
            <Field label={t('nr.db', { v: st.nrDb })}><input type="range" min={6} max={60} value={st.nrDb} onChange={(e) => set({ nrDb: +e.target.value })} /></Field>
            <Field label={t('nr.sens', { v: st.nrSens.toFixed(1) })}><input type="range" min={0} max={40} value={Math.round(st.nrSens * 10)} onChange={(e) => set({ nrSens: +e.target.value / 10 })} /></Field>
          </Controls>
          <p className="small mono">{st.nrProfile ? t('nr.profile', { a: fmtTime(st.nrProfile[0]), b: fmtTime(st.nrProfile[1]) }) : t('nr.auto')}</p>
          <Controls>
            <button type="button" disabled={!st.sel} title={t('nr.fromSelHint')} onClick={() => set({ nrProfile: st.sel, sel: null })}>{t('nr.fromSel')}</button>
            <button type="button" disabled={!st.nrProfile} onClick={() => set({ nrProfile: null })}>{t('nr.autoBtn')}</button>
          </Controls>
        </>
      ) : null}
      {st.op === 'drawn' ? (
        <Controls>
          <Seg<string> label={t('drawn.label')} value={st.keep ? 'keep' : 'remove'} onChange={(v) => set({ keep: v === 'keep' })}
            options={[{ value: 'keep', label: t('drawn.keep') }, { value: 'remove', label: t('drawn.remove') }]} />
        </Controls>
      ) : null}
      <Controls>
        <button type="button" className="primary" disabled={!spec || busy} onClick={() => void run()}>{st.sel ? t('btn.runSel') : t('btn.run')}</button>
      </Controls>
      <Progress value={prog} />
      <Status s={status} />
    </>
  );
  const layerCtl = result ? (
    <Controls>
      <Seg<number> label={t('layers.label')} value={Math.min(st.layer, result.layers.length - 1)} onChange={(i) => set({ layer: i })}
        options={result.layers.map((l, i) => ({ value: i, label: l.name }))} />
      {layer ? <>
        <button type="button" onClick={() => exportLayer(layer)}>{t('btn.wav')}</button>
        <button type="button" onClick={() => void toSession(layer)} title={t('btn.sessionHint')}>{t('btn.session')}</button>
      </> : null}
      <button type="button" onClick={() => result.layers.forEach((l, i) => setTimeout(() => exportLayer(l), i * 300))}>{t('btn.wavAll')}</button>
    </Controls>
  ) : null;
  const mainPlot = (fill: boolean) => (
    <Plot fill={fill} className={'spectral-main mode-' + st.mode} transport={tp} canvasRef={mainCv} deps={[spec, st.strokes, draft, sel, st.nrProfile, st.op]} draw={drawMain}
      ariaLabel={t('main.aria')} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} />
  );
  const outPlot = (fill: boolean) => <Plot fill={fill} transport={tpOut} canvasRef={outCv} deps={[layer]} draw={drawOut} />;
  const demos = ['mixture', 'anatomy', 'events', 'bell', 'texture8'];

  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        <SoundSource value={st.soundId} onChange={(id) => set({ soundId: id, sel: null, strokes: [], nrProfile: null, ran: false })} demos={demos} />
      </Panel>
      {sound ? (
        <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>
          <Controls>{modeCtl}</Controls>
          {spec ? mainPlot(false) : <Progress value={prog} />}
          <TransportBar tp={tp} />
          {selCtl}
        </Panel>
      ) : null}
      {spec ? (
        <Panel title={t('s3.title')} hintHtml={rich('help.' + st.op)}>{opCtl}</Panel>
      ) : null}
      {result ? (
        <Panel title={t('s4.title')} hintHtml={rich('s4.hint')}>
          {layerCtl}
          {outPlot(false)}
          <TransportBar tp={tpOut} />
          {result.nmfH ? <Plot deps={[result]} draw={drawAct} /> : null}
        </Panel>
      ) : null}
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tp} />} side={<>
      <Section id="sound" title={t('s1.title')}>
        <SoundSource value={st.soundId} onChange={(id) => set({ soundId: id, sel: null, strokes: [], nrProfile: null, ran: false })} demos={demos} />
      </Section>
      <Section id="edit" title={t('s2.title')} help={rich('s2.hint')}>
        <Controls>{modeCtl}</Controls>
        {selCtl}
      </Section>
      <Section id="op" title={t('s3.title')} help={rich('help.' + st.op)}>{opCtl}</Section>
    </>}>
      <Split id="main">
        <Pane id="spec" title={t('pane.spec')} weight={2} actions={spec ? <button type="button" onClick={() => mainCv.current && png(mainCv.current, base() + '_spectrogramme.png')}>{t('btn.png')}</button> : null}>
          {spec ? mainPlot(true) : <Empty />}
        </Pane>
        <Pane id="out" title={t('pane.out')} weight={2} actions={result ? <TransportBar tp={tpOut} /> : null}>
          {result ? (
            <>
              {outPlot(true)}
              <div className="wb-pane-foot">{layerCtl}</div>
            </>
          ) : <Empty />}
        </Pane>
        {result?.nmfH ? (
          <Pane id="act" title={t('pane.act')} weight={0.9} min={120}>
            <Plot fill deps={[result]} draw={drawAct} />
          </Pane>
        ) : null}
      </Split>
    </Workbench>
  );
}

function padTo(y: Float32Array, n: number) { const z = new Float32Array(n); z.set(y); return z; }
/** heat() draws row 0 at the bottom: put component 1 on top. */
function flipRows(H: Float32Array, K: number, C: number) {
  // each row scaled to its own maximum: when it sounds matters, not how loud
  const out = new Float32Array(K * C);
  for (let k = 0; k < K; k++) {
    let m = 0; for (let c = 0; c < C; c++) m = Math.max(m, H[k * C + c]);
    for (let c = 0; c < C; c++) out[(K - 1 - k) * C + c] = m > 0 ? H[k * C + c] / m : 0;
  }
  return out;
}
