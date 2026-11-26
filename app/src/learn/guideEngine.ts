/* The descriptor guide's machinery, ported from general-guide-descripteurs:
   seeded synthesis of the example sounds, per-segment statistics, the curve
   with grey bands where there is no value, and the magnifier ("loupe") that
   shows one frame the way each descriptor sees it. Pure functions of their
   arguments; the component owns the state. */

import { ctx as audioCtx, generate } from '../lib/audio';
import { Description, extent, Matrix, Meyda, magnitude, windowFn } from '../lib/dsp';
import * as draw from '../lib/draw';
import { css, geomOf, padLeft } from '../lib/draw';
import type { Descriptor, SegSpec } from './guide.data';

/* === synthesis: seeded noise, so an example measures the same every time === */

export const SR = 44100;
const SEG = 1.5;
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
const rmsOf = (x: Float32Array) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / Math.max(1, x.length)); };
const setRms = (x: Float32Array, r: number) => { const k = r / (rmsOf(x) || 1); for (let i = 0; i < x.length; i++) x[i] *= k; return x; };
const dB = (v: number) => Math.pow(10, v / 20);

const sine = (n: number, f: number, amp: number) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = amp * Math.sin(2 * Math.PI * f * i / SR); return x; };
function partials(n: number, list: number[][]) {
  const x = new Float32Array(n);
  list.forEach((p) => { for (let i = 0; i < n; i++) x[i] += p[1] * Math.sin(2 * Math.PI * p[0] * i / SR); });
  return x;
}
function harm(n: number, f0: number, nh: number, rms: number) {
  const list: number[][] = [];
  for (let k = 1; k <= nh && f0 * k < SR / 2; k++) list.push([f0 * k, 1 / k]);
  return setRms(partials(n, list), rms);
}
const white = (n: number, rms: number) => { const x = new Float32Array(n); for (let i = 0; i < n; i++) x[i] = rnd() * 2 - 1; return setRms(x, rms); };
function pink(n: number, rms: number) {   // Paul Kellet's filter on white noise
  const x = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179; b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.96900 * b2 + w * 0.1538520; b3 = 0.86650 * b3 + w * 0.3104856;
    b4 = 0.55000 * b4 + w * 0.5329522; b5 = -0.7616 * b5 - w * 0.0168980;
    x[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362; b6 = w * 0.115926;
  }
  return setRms(x, rms);
}
function band(n: number, f0: number, f1: number, rms: number) {   // random-phase sines 1 Hz apart: a brick-wall band
  const x = new Float32Array(n);
  for (let f = f0; f <= f1; f++) {
    const ph = rnd() * 2 * Math.PI, w = 2 * Math.PI * f / SR;
    for (let i = 0; i < n; i++) x[i] += Math.sin(w * i + ph);
  }
  return setRms(x, rms);
}
function biquad(x: Float32Array, type: 'lp' | 'hp', fc: number) {    // RBJ cookbook, Q = 0.707
  const w0 = 2 * Math.PI * fc / SR, c = Math.cos(w0), a = Math.sin(w0) / (2 * 0.7071);
  const a0 = 1 + a, a1 = -2 * c, a2 = 1 - a;
  let b0, b1, b2;
  if (type === 'lp') { b0 = (1 - c) / 2; b1 = 1 - c; b2 = (1 - c) / 2; }
  else { b0 = (1 + c) / 2; b1 = -(1 + c); b2 = (1 + c) / 2; }
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const y = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    const v = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
const DRONE_RMS = 0.3;
const drone = (n: number) => harm(n, 80, 20, DRONE_RMS);
function hiss(n: number, rel: number) {           // 6–12 kHz, `rel` dB below the drone
  let x = white(n, 0.3);
  x = biquad(biquad(x, 'hp', 6000), 'hp', 6000);
  x = biquad(biquad(x, 'lp', 12000), 'lp', 12000);
  return setRms(x, DRONE_RMS * dB(rel));
}
function sineHiss(n: number, rel: number) {
  const s = sine(n, 1000, 0.5), h = white(n, rmsOf(s) * dB(rel));
  for (let i = 0; i < n; i++) s[i] += h[i];
  return s;
}
function vibrato(n: number) {
  const x = new Float32Array(n); let ph = 0;
  for (let i = 0; i < n; i++) { ph += 2 * Math.PI * 440 * (1 + 0.03 * Math.sin(2 * Math.PI * 6 * i / SR)) / SR; x[i] = 0.5 * Math.sin(ph); }
  return x;
}
function notes(n: number, noiseRms: number) {     // four short notes a second
  const x = new Float32Array(n), per = Math.round(SR / 4);
  for (let i = 0; i < n; i++) {
    const t = (i % per) / SR, tt = i / SR; let v = 0;
    for (let k = 1; k <= 4; k++) v += Math.sin(2 * Math.PI * 440 * k * tt) / k;
    x[i] = 0.4 * v * Math.exp(-t * 25);
  }
  if (noiseRms) { const w = white(n, noiseRms); for (let j = 0; j < n; j++) x[j] += w[j]; }
  return x;
}
function pluck(n: number, freq: number, amp: number) {    // Karplus–Strong with seeded noise
  const len = Math.round(SR / freq), ring = new Float32Array(len), x = new Float32Array(n);
  let idx = 0;
  for (let i = 0; i < len; i++) ring[i] = rnd() * 2 - 1;
  for (let i = 0; i < n; i++) {
    const next = (idx + 1) % len;
    ring[idx] = 0.498 * (ring[idx] + ring[next]);
    x[i] = amp * ring[idx] * Math.exp(-i / SR * 0.8);
    idx = next;
  }
  return x;
}
function fade(x: Float32Array) {
  const f = Math.min(Math.floor(SR * 0.01), Math.floor(x.length / 2));
  for (let i = 0; i < f; i++) { x[i] *= i / f; x[x.length - 1 - i] *= i / f; }
  return x;
}

/** One segment spec → samples at SR. The last numeric argument of most kinds is an optional duration. */
function makeSegment(s: SegSpec): Float32Array {
  const k = s[1] as string, a = s.slice(2) as (number & number[][])[];
  const N = (d?: number) => Math.round(SR * (d || SEG));
  switch (k) {
    case 'sine': return fade(sine(N(a[2]), a[0], a[1]));
    case 'partials': return fade(partials(N(a[2]), a[0] as unknown as number[][]));
    case 'harm': return fade(harm(N(a[3]), a[0], a[1], a[2]));
    case 'white': return fade(white(N(a[2]), a[0]));
    case 'pink': return fade(pink(N(a[1]), a[0]));
    case 'band': return fade(band(N(a[3]), a[0], a[1], a[2]));
    case 'drone': return fade(drone(N()));
    case 'hiss': return fade(hiss(N(), a[0]));
    case 'sinehiss': return fade(sineHiss(N(), a[0]));
    case 'vibrato': return fade(vibrato(N(a[0])));
    case 'notes': return notes(N(a[1]), a[0]);
    case 'pluck': return pluck(N(a[2]), a[0], a[1]);
    case 'silence': return new Float32Array(N());
  }
  throw new Error('segment ' + k);
}

export type Seg = { lab: string; t0: number; t1: number };

/** An example: an AudioBuffer plus its segment boundaries. */
export function buildExample(ex: { segs: SegSpec[] }): { buffer: AudioBuffer; segs: Seg[] } {
  seed = 12345;
  if (ex.segs.length === 1 && ex.segs[0][1] === 'demo') {
    const b = generate(ex.segs[0][2] as string, { duration: (ex.segs[0][3] as number) || 3 });
    return { buffer: b, segs: [{ lab: '', t0: 0, t1: b.duration }] };
  }
  const parts = ex.segs.map(makeSegment);
  const total = parts.reduce((a, p) => a + p.length, 0);
  const buf = audioCtx().createBuffer(1, total, SR), d = buf.getChannelData(0);
  let off = 0;
  const segs: Seg[] = [];
  parts.forEach((p, i) => { d.set(p, off); segs.push({ lab: ex.segs[i][0] as string, t0: off / SR, t1: (off + p.length) / SR }); off += p.length; });
  return { buffer: buf, segs };
}

/* === statistics ============================================================ */

export function median(arr: ArrayLike<number>) {
  const a: number[] = [];
  for (let i = 0; i < arr.length; i++) if (isFinite(arr[i])) a.push(arr[i]);
  if (!a.length) return { med: NaN, nan: 1 };
  a.sort((x, y) => x - y);
  return { med: a[a.length >> 1], nan: 1 - a.length / arr.length };
}
/** Frames lying wholly inside a segment. */
export function framesIn(res: Description, seg: Seg) {
  const half = res.frameSize / 2 / res.sampleRate, out: number[] = [];
  for (let i = 0; i < res.nFrames; i++) { const t = res.times[i]; if (t - half >= seg.t0 - 1e-9 && t + half <= seg.t1 + 1e-9) out.push(i); }
  return out;
}
export function matrixRowMedians(m: Matrix, idx: number[], from: number) {
  const out: number[] = [];
  for (let r = from; r < m.rows; r++) out.push(median(idx.map((i) => m.data[r * m.cols + i])).med);
  return out;
}

/* === drawing =============================================================== */

/** Dashed boundaries and A/B/C labels, on the canvas's time mapping. */
export function markSegments(cv: HTMLCanvasElement, segs: Seg[], dur: number, labelY: number) {
  if (!segs.length) return;
  const g = geomOf(cv), ctx = cv.getContext('2d')!;
  ctx.save();
  ctx.strokeStyle = css('--warn'); ctx.fillStyle = css('--warn');
  ctx.setLineDash([4, 3]); ctx.lineWidth = 1;
  ctx.font = '600 12px ' + css('--sans'); ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  segs.forEach((s, i) => {
    const x = g.padL + s.t0 / dur * g.plotW;
    if (i > 0) { ctx.beginPath(); ctx.moveTo(x + 0.5, g.padT); ctx.lineTo(x + 0.5, g.padT + g.plotH); ctx.stroke(); }
    if (s.lab) ctx.fillText(s.lab, x + 4, g.padT + labelY);
  });
  ctx.restore();
}

/** A descriptor curve that is always drawn: frames without a value become grey
    bands, so "nothing" is visible as such; a sound with no value at all still
    gets its axes and a sentence saying so. Returns whether bands were drawn. */
export function drawCurve(cv: HTMLCanvasElement, res: Description, vals: ArrayLike<number>, dur: number,
  label: string, unit: string, noneText: string, skipFirst: boolean): boolean {
  const times = res.times, ext = extent(vals);
  const from = skipFirst ? 1 : 0;           // flux has no value on its first frame by definition
  let gotNaN = false;
  for (let i = from; i < vals.length; i++) if (!isFinite(vals[i])) { gotNaN = true; break; }
  if (ext) draw.curve(cv, times, vals, { label, unit, height: 160, tMax: dur });
  else {
    const { ctx, w, h } = draw.fit(cv, 160), pL = padLeft(), padT = 10, padB = 18;
    const plotW = Math.max(10, w - pL - 8), plotH = Math.max(10, h - padT - padB);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(pL, padT); ctx.lineTo(pL, padT + plotH); ctx.lineTo(pL + plotW, padT + plotH); ctx.stroke();
    ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
    ctx.textAlign = 'left'; ctx.fillText('0 s', pL, h - 4);
    ctx.textAlign = 'right'; ctx.fillText(dur.toFixed(1) + ' s', pL + plotW, h - 4);
    ctx.textAlign = 'left'; ctx.fillStyle = css('--ink'); ctx.font = '12px ' + css('--sans');
    ctx.fillText(label + (unit ? ' (' + unit + ')' : ''), pL + 6, padT + 11);
    draw.setGeom(cv, { padL: pL, padT, plotW, plotH });
  }
  if (gotNaN) {
    const g = geomOf(cv), c2 = cv.getContext('2d')!, half = res.hopSize / 2 / res.sampleRate;
    c2.save(); c2.fillStyle = css('--line'); c2.globalAlpha = 0.55;
    for (let i = from; i < vals.length; i++) {
      if (isFinite(vals[i])) continue;
      let j = i; while (j + 1 < vals.length && !isFinite(vals[j + 1])) j++;
      let t0 = Math.max(0, times[i] - half), t1 = Math.min(dur, times[j] + half);
      if (i === 0) t0 = 0;
      if (j === vals.length - 1) t1 = dur;
      c2.fillRect(g.padL + t0 / dur * g.plotW, g.padT, Math.max(1, (t1 - t0) / dur * g.plotW), g.plotH);
      i = j;
    }
    c2.restore();
    if (!ext) {
      c2.fillStyle = css('--ink'); c2.font = '600 13px ' + css('--sans'); c2.textAlign = 'center';
      c2.fillText(noneText, g.padL + g.plotW / 2, g.padT + g.plotH / 2 + 4);
    }
  }
  return gotNaN;
}

/* === the magnifier ========================================================= */

export type LegendItem = [string, string];        // [css colour variable, string key]

let chromaKey = '';
export function meyda(res: Description, feats: string[], frame: Float32Array): Record<string, any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  const M = Meyda as any; // eslint-disable-line @typescript-eslint/no-explicit-any
  M.sampleRate = res.sampleRate; M.bufferSize = res.frameSize; M.windowingFunction = 'hanning';
  M.numberOfMFCCCoefficients = 13;
  if (feats.includes('chroma')) {
    // Meyda keeps a stale chroma filter bank across frame sizes
    const k = res.frameSize + ':' + res.sampleRate;
    if (chromaKey !== k) { M.chromaFilterBank = undefined; chromaKey = k; }
  }
  return M.extract(feats, frame);
}

export function frameIndexAt(res: Description, t: number) {
  const i = Math.round((t * res.sampleRate - res.frameSize / 2) / res.hopSize);
  return Math.max(0, Math.min(res.nFrames - 1, i));
}
export function frameAt(res: Description, signal: Float32Array, i: number) {
  const size = res.frameSize, off = i * res.hopSize, f = new Float32Array(size);
  f.set(signal.subarray(off, off + size));
  return f;
}

/** Waveform modes (rms, zcr, pitch): the frame itself. */
export function loupeWave(cv: HTMLCanvasElement, frame: Float32Array, mode: string, value: number, sampleRate: number): LegendItem[] {
  const { ctx, w, h } = draw.fit(cv, 170), n = frame.length, win = windowFn(n, 'hann'), mid = h / 2;
  let peak = 1e-9;
  for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(frame[i]));
  const sc = (h / 2 - 8) / peak, X = (k: number) => 6 + k / (n - 1) * (w - 12);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, mid + 0.5); ctx.lineTo(w, mid + 0.5); ctx.stroke();
  const path = (get: (k: number) => number, col: string, lw: number) => {
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
    for (let k = 0; k < n; k++) { const y = mid - get(k) * sc; if (k) ctx.lineTo(X(k), y); else ctx.moveTo(X(k), y); }
    ctx.stroke();
  };
  if (mode === 'rms') {
    path((k) => frame[k], css('--line-firm'), 1);
    path((k) => frame[k] * win[k], css('--accent'), 1.4);
    if (isFinite(value)) {
      ctx.strokeStyle = css('--warn'); ctx.lineWidth = 2; ctx.setLineDash([6, 4]);
      [value, -value].forEach((v) => { ctx.beginPath(); ctx.moveTo(0, mid - v * sc); ctx.lineTo(w, mid - v * sc); ctx.stroke(); });
      ctx.setLineDash([]);
    }
    return [['--line-firm', 'lg.raw'], ['--accent', 'lg.win'], ['--warn', 'lg.rms']];
  }
  if (mode === 'zcr') {
    path((k) => frame[k] * win[k], css('--accent'), 1.2);
    ctx.fillStyle = css('--warn');
    for (let i = 1; i < n; i++) {
      const a = frame[i - 1] * win[i - 1], b = frame[i] * win[i];
      if ((a >= 0 && b < 0) || (a < 0 && b >= 0)) { ctx.beginPath(); ctx.arc(X(i), mid, 2.4, 0, 2 * Math.PI); ctx.fill(); }
    }
    return [['--accent', 'lg.win'], ['--warn', 'lg.cross']];
  }
  path((k) => frame[k], css('--accent'), 1.2);
  if (isFinite(value)) {
    const per = sampleRate / value;
    ctx.strokeStyle = css('--warn'); ctx.lineWidth = 1.5;
    // the first few periods only: at 2 kHz a frame holds ~45 of them
    for (let t = 0, c = 0; t < n && c <= 6; t += per, c++) { ctx.beginPath(); ctx.moveTo(X(t), 6); ctx.lineTo(X(t), h - 6); ctx.stroke(); }
    return [['--accent', 'lg.raw'], ['--warn', 'lg.period']];
  }
  return [['--accent', 'lg.raw'], ['--bad', 'lg.nopitch']];
}

/** Band modes (Bark loudness, MFCC, chroma): one bar per band. */
export function loupeBars(cv: HTMLCanvasElement, values: ArrayLike<number> | undefined, o: { lg: string; signed?: boolean; max?: number; labels?: 'c' | 'pc'; pc?: string[] }): LegendItem[] {
  const { ctx, w, h } = draw.fit(cv, 170);
  ctx.clearRect(0, 0, w, h);
  const vals = values ? Array.from(values) : [], n = vals.length;
  if (!n) return [];
  let lo = 0, hi = o.max || 0;
  for (let i = 0; i < n; i++) if (isFinite(vals[i])) { hi = Math.max(hi, vals[i]); if (o.signed) lo = Math.min(lo, vals[i]); }
  if (o.signed) { const m = Math.max(Math.abs(lo), Math.abs(hi), 1e-9); lo = -m; hi = m; }
  if (hi - lo < 1e-12) hi = lo + 1;
  const padB = 18, padT = 8, plotH = h - padB - padT, bw = (w - 12) / n;
  const Y = (v: number) => padT + (hi - v) / (hi - lo) * plotH;
  ctx.font = '11px ' + css('--mono'); ctx.textAlign = 'center';
  for (let i = 0; i < n; i++) {
    const v = isFinite(vals[i]) ? vals[i] : 0, x = 6 + i * bw;
    ctx.fillStyle = (o.signed && i === 0) ? css('--line-firm') : css('--accent');
    const y0 = Y(0), y1 = Y(v);
    ctx.fillRect(x + bw * 0.12, Math.min(y0, y1), bw * 0.76, Math.max(1, Math.abs(y1 - y0)));
    ctx.fillStyle = css('--ink-soft');
    const lab = o.labels === 'pc' && o.pc ? o.pc[i] : (o.labels === 'c' ? 'c' + i : String(i + 1));
    if (n <= 13 || i % 2 === 0) ctx.fillText(lab, x + bw / 2, h - 4);
  }
  ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(6, Y(0) + 0.5); ctx.lineTo(w - 6, Y(0) + 0.5); ctx.stroke();
  return o.lg === 'mfcc' ? [['--line-firm', 'lg.mfcc0'], ['--accent', 'lg.mfcc']] : [['--accent', o.lg]];
}

/** Spectrum modes (centroid, spread, rolloff, flatness, flux). */
export function loupeSpectrum(cv: HTMLCanvasElement, res: Description, frame: Float32Array, prevFrame: Float32Array | null,
  mode: string, logf: boolean, silentText: string): LegendItem[] {
  const { ctx, w, h } = draw.fit(cv, 200);
  const sr = res.sampleRate, size = res.frameSize, binHz = sr / size, nyq = sr / 2;
  const fx = meyda(res, ['amplitudeSpectrum', 'spectralCentroid', 'spectralSpread', 'spectralRolloff'], frame);
  const amp: Float32Array = fx.amplitudeSpectrum, n = amp.length;
  const padL = 44, padR = 10, padT = 8, padB = 20, plotW = w - padL - padR, plotH = h - padT - padB, fMin = 20;
  const X = (hz: number) => (!logf ? padL + Math.min(1, hz / nyq) * plotW
    : padL + Math.max(0, Math.log(Math.max(hz, fMin) / fMin) / Math.log(nyq / fMin)) * plotW);
  let peak = 1e-12;
  for (let i = 0; i < n; i++) peak = Math.max(peak, amp[i]);
  const FLOOR = -100;
  const dbOf = (v: number, ref: number) => Math.max(FLOOR, 20 * Math.log10(Math.max(v, 1e-12) / ref));
  const Y = (db: number) => padT + (-db / -FLOOR) * plotH;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1;
  ctx.strokeRect(padL + 0.5, padT + 0.5, plotW, plotH);
  ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  [0, -40, -80].forEach((db) => ctx.fillText(db + ' dB', padL - 4, Y(db)));
  ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
  (logf ? [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000] : [0, 2000, 5000, 10000, 15000, 20000]).forEach((hz) => {
    if (hz <= nyq) ctx.fillText(hz >= 1000 ? (hz / 1000) + 'k' : String(hz), X(hz), h - 5);
  });
  if (peak < 1e-9) {
    ctx.textAlign = 'center'; ctx.fillText(silentText, padL + plotW / 2, padT + plotH / 2);
    return [['--accent', 'lg.spec']];
  }
  const spectrumPath = (a: ArrayLike<number>, ref: number, col: string, lw: number) => {
    ctx.strokeStyle = col; ctx.lineWidth = lw; ctx.beginPath();
    for (let k = 1; k < a.length; k++) { const x = X(k * binHz), y = Y(dbOf(a[k], ref)); if (k === 1) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke();
  };
  if (mode === 'flux') {
    // the same spectra as the flux computation: magnitude(), Hann window
    const win = windowFn(size, 'hann');
    const cur = magnitude(frame, win), prev = prevFrame ? magnitude(prevFrame, win) : null;
    let ref = 1e-12;
    for (let i = 0; i < cur.length; i++) { ref = Math.max(ref, cur[i]); if (prev) ref = Math.max(ref, prev[i]); }
    if (prev) {
      ctx.fillStyle = css('--warn');
      for (let i = 1; i < cur.length; i++) {
        if (cur[i] <= prev[i]) continue;
        const x0 = X((i - 0.5) * binHz), x1 = X((i + 0.5) * binHz), ya = Y(dbOf(cur[i], ref)), yb = Y(dbOf(prev[i], ref));
        ctx.fillRect(x0, ya, Math.max(1, x1 - x0), Math.max(1, yb - ya));
      }
      spectrumPath(prev, ref, css('--line-firm'), 1);
    }
    spectrumPath(cur, ref, css('--accent'), 1.3);
    return [['--line-firm', 'lg.prev'], ['--accent', 'lg.cur'], ['--warn', 'lg.up']];
  }
  spectrumPath(amp, peak, css('--accent'), 1.3);
  const items: LegendItem[] = [['--accent', 'lg.spec']];
  const cHz = fx.spectralCentroid * binHz, sHz = fx.spectralSpread * binHz;
  if (mode === 'spread' && isFinite(sHz)) {
    ctx.fillStyle = css('--accent-bg'); ctx.globalAlpha = 0.75;
    const a0 = X(Math.max(0, cHz - sHz)), a1 = X(Math.min(nyq, cHz + sHz));
    ctx.fillRect(a0, padT + 1, Math.max(1, a1 - a0), plotH - 1);
    ctx.globalAlpha = 1;
    spectrumPath(amp, peak, css('--accent'), 1.3);
    items.push(['--ok', 'lg.spread']);
    ctx.strokeStyle = css('--ok'); ctx.lineWidth = 2;
    [a0, a1].forEach((x) => { ctx.beginPath(); ctx.moveTo(x, padT); ctx.lineTo(x, padT + plotH); ctx.stroke(); });
  }
  if ((mode === 'centroid' || mode === 'spread') && isFinite(cHz)) {
    ctx.strokeStyle = css('--warn'); ctx.lineWidth = 2.5;
    ctx.beginPath(); ctx.moveTo(X(cHz), padT); ctx.lineTo(X(cHz), padT + plotH); ctx.stroke();
    items.push(['--warn', 'lg.centroid']);
  }
  if (mode === 'rolloff') {
    let tot = 0; for (let i = 0; i < n; i++) tot += amp[i];
    ctx.strokeStyle = css('--ok'); ctx.lineWidth = 1.6; ctx.beginPath();
    let acc = 0;
    for (let i = 0; i < n; i++) {
      acc += amp[i];
      const yy = padT + (1 - acc / tot) * plotH;
      if (i) ctx.lineTo(X(i * binHz), yy); else ctx.moveTo(X(fMin), yy);
    }
    ctx.stroke();
    const y99 = padT + 0.01 * plotH;
    ctx.setLineDash([3, 3]); ctx.strokeStyle = css('--ok'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, y99); ctx.lineTo(padL + plotW, y99); ctx.stroke(); ctx.setLineDash([]);
    if (isFinite(fx.spectralRolloff)) {
      ctx.strokeStyle = css('--warn'); ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.moveTo(X(fx.spectralRolloff), padT); ctx.lineTo(X(fx.spectralRolloff), padT + plotH); ctx.stroke();
    }
    items.push(['--ok', 'lg.cum'], ['--warn', 'lg.rolloff']);
  }
  if (mode === 'flatness') {
    let sl = 0, sa = 0;
    for (let i = 0; i < n; i++) { sl += Math.log(Math.max(amp[i], 1e-30)); sa += amp[i]; }
    const gm = Math.exp(sl / n), am = sa / n;
    ctx.lineWidth = 2;
    ([[gm, '--ok'], [am, '--warn']] as [number, string][]).forEach(([v, c]) => {
      ctx.strokeStyle = css(c); ctx.beginPath(); const y = Y(dbOf(v, peak)); ctx.moveTo(padL, y); ctx.lineTo(padL + plotW, y); ctx.stroke();
    });
    items.push(['--ok', 'lg.gm'], ['--warn', 'lg.am']);
  }
  return items;
}

/** Which way the loupe draws a descriptor. */
export const SPECTRUM_LOUPES = ['centroid', 'spread', 'rolloff', 'flatness', 'flux'];
export type { Descriptor };
