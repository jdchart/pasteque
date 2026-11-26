/* Signal processing. A port of Atelier.dsp: same algorithms, same numbers.

   Long files are normal: nothing here may be O(n) in the *argument list* (no
   spread or Function.apply over sample arrays), and every long loop yields to
   the browser between chunks so the page stays responsive. */

import MeydaLib from 'meyda';
import { tr } from '../i18n/core';

/* Meyda's API is a mutable singleton; type only what we use. */
type MeydaT = {
  sampleRate: number; bufferSize: number; windowingFunction: string;
  numberOfMFCCCoefficients: number; chromaFilterBank?: unknown;
  extract: (f: string | string[], frame: Float32Array) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
};
export const Meyda = MeydaLib as unknown as MeydaT;

export type Progress = (p: number) => void;

export function mono(buffer: AudioBuffer): Float32Array {
  const n = buffer.length, ch = buffer.numberOfChannels;
  if (ch === 1) return buffer.getChannelData(0).slice();
  const out = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) out[i] += d[i] / ch;
  }
  return out;
}

export const isPowerOfTwo = (v: number) => v > 0 && (v & (v - 1)) === 0;

/** Min/max of a long array — a loop, never Math.min(...values). */
export function extent(values: ArrayLike<number>): { min: number; max: number } | null {
  let lo = Infinity, hi = -Infinity, seen = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (typeof v !== 'number' || !isFinite(v)) continue;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    seen = true;
  }
  return seen ? { min: lo, max: hi } : null;
}

/** Peak envelope decimated to `width` columns — for waveform drawing. */
export function envelope(signal: ArrayLike<number>, width: number) {
  const per = signal.length / width;
  const mins = new Float32Array(width), maxs = new Float32Array(width);
  for (let c = 0; c < width; c++) {
    const start = Math.floor(c * per);
    let stop = Math.min(Math.floor((c + 1) * per), signal.length);
    if (stop <= start) stop = Math.min(start + 1, signal.length);
    let lo = Infinity, hi = -Infinity;
    for (let i = start; i < stop; i++) {
      const v = signal[i];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    mins[c] = isFinite(lo) ? lo : 0;
    maxs[c] = isFinite(hi) ? hi : 0;
  }
  return { mins, maxs };
}

export function meanStd(arr: ArrayLike<number>) {
  let n = 0, s = 0, s2 = 0;
  for (let i = 0; i < arr.length; i++) {
    const v = arr[i];
    if (typeof v !== 'number' || !isFinite(v)) continue;
    n++; s += v; s2 += v * v;
  }
  if (!n) return { mean: NaN, std: NaN, n: 0 };
  const m = s / n;
  return { mean: m, std: Math.sqrt(Math.max(0, s2 / n - m * m)), n };
}

/* --- FFT ------------------------------------------------------------------- */

export type WindowType = 'hann' | 'hamming' | 'blackman' | 'rect';
const windowCache: Record<string, Float32Array> = {};

export function windowFn(size: number, type: WindowType | string = 'hann'): Float32Array {
  const key = type + ':' + size;
  if (windowCache[key]) return windowCache[key];
  const w = new Float32Array(size);
  for (let i = 0; i < size; i++) {
    const x = 2 * Math.PI * i / (size - 1);
    if (type === 'rect') w[i] = 1;
    else if (type === 'hamming') w[i] = 0.54 - 0.46 * Math.cos(x);
    else if (type === 'blackman') w[i] = 0.42 - 0.5 * Math.cos(x) + 0.08 * Math.cos(2 * x);
    else w[i] = 0.5 - 0.5 * Math.cos(x);
  }
  windowCache[key] = w;
  return w;
}

/** In-place radix-2 complex FFT. */
export function fft(re: Float32Array | Float64Array, im: Float32Array | Float64Array) {
  const n = re.length;
  let j = 0, tmp: number;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      tmp = re[i]; re[i] = re[j]; re[j] = tmp;
      tmp = im[i]; im[i] = im[j]; im[j] = tmp;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const half = len >> 1;
    const ang = -2 * Math.PI / len;
    const wlr = Math.cos(ang), wli = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let k = 0; k < half; k++) {
        const m = i + k, step = m + half;
        const cr = re[step] * wr - im[step] * wi;
        const ci = re[step] * wi + im[step] * wr;
        re[step] = re[m] - cr; im[step] = im[m] - ci;
        re[m] += cr; im[m] += ci;
        const tr2 = wr * wlr - wi * wli; wi = wr * wli + wi * wlr; wr = tr2;
      }
    }
  }
}

export type Scratch = { re?: Float32Array; im?: Float32Array };

/** Magnitude spectrum of one frame: size/2 + 1 bins, windowed. */
export function magnitude(frame: ArrayLike<number>, win: Float32Array | null, scratch: Scratch = {}): Float32Array {
  const n = frame.length;
  if (!scratch.re || scratch.re.length !== n) { scratch.re = new Float32Array(n); scratch.im = new Float32Array(n); }
  const re = scratch.re, im = scratch.im!;
  for (let i = 0; i < n; i++) { re[i] = frame[i] * (win ? win[i] : 1); im[i] = 0; }
  fft(re, im);
  const bins = (n >> 1) + 1;
  const out = new Float32Array(bins);
  const norm = 2 / n;
  for (let i = 0; i < bins; i++) out[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]) * norm;
  return out;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** Walk a signal frame by frame, yielding to the browser between chunks. */
export async function eachFrame(signal: Float32Array, size: number, hop: number,
  fn: (frame: Float32Array, i: number, off: number) => void, onProgress?: Progress): Promise<number> {
  const nFrames = Math.max(0, Math.floor((signal.length - size) / hop) + 1);
  const frame = new Float32Array(size);
  const CHUNK = 200;
  let i = 0;
  for (;;) {
    const end = Math.min(i + CHUNK, nFrames);
    for (; i < end; i++) {
      const off = i * hop;
      frame.set(signal.subarray(off, off + size));
      fn(frame, i, off);
    }
    if (onProgress) onProgress(nFrames ? i / nFrames : 1);
    if (i >= nFrames) return nFrames;
    await tick();
  }
}

export type Spectrogram = {
  columns: number; bins: number; data: Float32Array; colTimes: Float64Array;
  flux: Float32Array; fluxTimes: Float64Array; nFrames: number;
  frameSize: number; hopSize: number; sampleRate: number; maxMag: number; duration: number;
};

/** Spectrogram reduced to at most maxColumns columns (max over the frames each
    covers), plus the spectral flux per frame — the novelty curve. Row-major:
    bin k occupies data[k * cols …]. */
export async function spectrogram(signal: Float32Array, sampleRate: number,
  opts: { frameSize?: number; hopSize?: number; window?: string; maxColumns?: number; onProgress?: Progress } = {}): Promise<Spectrogram> {
  const size = opts.frameSize || 1024;
  const hop = opts.hopSize || Math.floor(size / 4);
  if (!isPowerOfTwo(size)) throw new Error(tr('err.pow2'));
  const win = windowFn(size, opts.window || 'hann');
  const nFrames = Math.max(0, Math.floor((signal.length - size) / hop) + 1);
  const bins = (size >> 1) + 1;
  const cols = Math.min(nFrames, opts.maxColumns || 4096);
  const per = nFrames / Math.max(1, cols);
  const data = new Float32Array(cols * bins);
  const colTimes = new Float64Array(cols);
  const flux = new Float32Array(nFrames);
  const fluxTimes = new Float64Array(nFrames);
  const prev = new Float32Array(bins);
  const scratch: Scratch = {};
  let maxMag = 0;
  for (let c = 0; c < cols; c++) colTimes[c] = ((c + 0.5) * per * hop + size / 2) / sampleRate;
  await eachFrame(signal, size, hop, (frame, i, off) => {
    const mag = magnitude(frame, win, scratch);
    const col = Math.min(cols - 1, Math.floor(i / per));
    let f = 0;
    for (let k = 0; k < bins; k++) {
      const v = mag[k];
      const idx = k * cols + col;
      if (v > data[idx]) data[idx] = v;
      if (v > maxMag) maxMag = v;
      const d = v - prev[k];
      if (d > 0) f += d;
      prev[k] = v;
    }
    flux[i] = i === 0 ? 0 : f;
    fluxTimes[i] = (off + size / 2) / sampleRate;
  }, opts.onProgress);
  return { columns: cols, bins, data, colTimes, flux, fluxTimes, nFrames,
           frameSize: size, hopSize: hop, sampleRate, maxMag, duration: signal.length / sampleRate };
}

/** Fundamental frequency of one frame by YIN. Hz, or NaN when not periodic
    enough. Lowest detectable pitch ≈ 2·sr/size. */
export function pitch(frame: ArrayLike<number>, sampleRate: number, opts: { threshold?: number; fMin?: number; fMax?: number } = {}): number {
  const n = frame.length, half = n >> 1;
  const thr = opts.threshold || 0.15;
  const fMin = opts.fMin || 50, fMax = opts.fMax || 2000;
  const tauMin = Math.max(2, Math.floor(sampleRate / fMax));
  const tauMax = Math.min(half - 1, Math.ceil(sampleRate / fMin));
  const d = new Float32Array(half);
  let e = 0;
  for (let i = 0; i < half; i++) e += frame[i] * frame[i];
  if (e / half < 1e-7) return NaN;                 // silence
  for (let tau = 1; tau < half; tau++) {
    let s = 0;
    for (let i = 0; i < half; i++) { const delta = frame[i] - frame[i + tau]; s += delta * delta; }
    d[tau] = s;
  }
  let run = 0, best = -1;
  d[0] = 1;
  for (let tau = 1; tau < half; tau++) { run += d[tau]; d[tau] = run ? d[tau] * tau / run : 1; }
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (d[tau] < thr) {
      while (tau + 1 <= tauMax && d[tau + 1] < d[tau]) tau++;
      best = tau; break;
    }
  }
  if (best < 0) return NaN;
  const x0 = d[best - 1], x1 = d[best], x2 = d[best + 1] !== undefined ? d[best + 1] : x1;
  const denom = x0 - 2 * x1 + x2;
  const shift = denom ? 0.5 * (x0 - x2) / denom : 0;
  return sampleRate / (best + shift);
}

/** Peak picking on a novelty curve. sensitivity 0..1 (1 = many cuts). */
export function peaks(values: ArrayLike<number>, opts: { sensitivity?: number; minGapFrames?: number; localWindow?: number } = {}): number[] {
  const n = values.length;
  if (!n) return [];
  const sens = Math.min(1, Math.max(0, opts.sensitivity === undefined ? 0.5 : opts.sensitivity));
  const gap = Math.max(1, opts.minGapFrames || 1);
  const w = opts.localWindow || 16;
  const sm = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let k = -1; k <= 1; k++) if (i + k >= 0 && i + k < n) { s += values[i + k]; c++; }
    sm[i] = s / c;
  }
  const ext = extent(sm);
  const hi = ext ? ext.max : 1;
  if (hi <= 0) return [];
  for (let i = 0; i < n; i++) sm[i] /= hi;
  // The exponent is chosen so the count changes visibly across the middle of the
  // slider: a dial that does nothing between 25 % and 50 % teaches nothing.
  const margin = 0.5 * Math.pow(1 - sens, 1.8) + 0.015;
  const out: number[] = [];
  let last = -Infinity;
  for (let i = 1; i < n - 1; i++) {
    if (sm[i] < sm[i - 1] || sm[i] < sm[i + 1]) continue;
    const lo = Math.max(0, i - w), up = Math.min(n - 1, i + w);
    let m = 0;
    for (let k = lo; k <= up; k++) m += sm[k];
    m /= (up - lo + 1);
    if (sm[i] - m < margin) continue;
    if (i - last < gap) {
      if (sm[i] > sm[out[out.length - 1]]) { out[out.length - 1] = i; last = i; }
      continue;
    }
    out.push(i); last = i;
  }
  return out;
}

/* --- describe(): descriptor curves ---------------------------------------- */
/* Meyda's scalar features, plus four names of our own:
     'pitch'        — YIN, Hz (NaN where nothing periodic is found);
     'mfcc'         — 13 coefficients per frame, in result.matrices.mfcc;
     'chroma'       — 12 pitch classes per frame (C first), in result.matrices.chroma;
     'spectralFlux' — sum of the increases of the magnitude spectrum since the
                      previous frame (NaN on the first frame).                   */

export type Matrix = { rows: number; cols: number; data: Float32Array };
export type Description = {
  times: Float64Array; sampleRate: number; frameSize: number; hopSize: number; nFrames: number;
  features: Record<string, Float64Array>; matrices: Record<string, Matrix>;
};

const OWN = ['pitch', 'mfcc', 'chroma', 'spectralFlux'];

async function describeMeyda(signal: Float32Array, sampleRate: number, features: string[], size: number, hop: number, onProgress?: Progress) {
  if (!isPowerOfTwo(size)) throw new Error(tr('err.pow2'));
  const M = Meyda;
  M.sampleRate = sampleRate; M.bufferSize = size; M.windowingFunction = 'hanning';
  const nFrames = Math.max(0, Math.floor((signal.length - size) / hop) + 1);
  const out: Record<string, Float64Array> = {};
  features.forEach((f) => { out[f] = new Float64Array(nFrames); });
  await eachFrame(signal, size, hop, (frame, i) => {
    const f = M.extract(features, frame);
    for (const name of features) {
      let v = f[name];
      if (name === 'spectralCentroid') v = v * sampleRate / size;
      else if (name === 'loudness') v = v ? v.total : NaN;
      out[name][i] = typeof v === 'number' ? v : NaN;
    }
  }, onProgress);
  return out;
}

export async function describe(signal: Float32Array, sampleRate: number, features: string[],
  opts: { frameSize?: number; hopSize?: number; onProgress?: Progress } = {}): Promise<Description> {
  const size = opts.frameSize || 1024;
  const hop = opts.hopSize || Math.floor(size / 2);
  if (!isPowerOfTwo(size)) throw new Error(tr('err.pow2'));
  const nFrames = Math.max(0, Math.floor((signal.length - size) / hop) + 1);
  const scalar = features.filter((f) => OWN.indexOf(f) < 0);
  const steps = (scalar.length ? 1 : 0) + OWN.filter((f) => features.indexOf(f) >= 0).length;
  let done = 0;
  const sub: Progress = (p) => { if (opts.onProgress) opts.onProgress((done + p) / Math.max(1, steps)); };

  const times = new Float64Array(nFrames);
  for (let i = 0; i < nFrames; i++) times[i] = (i * hop + size / 2) / sampleRate;
  const res: Description = { times, sampleRate, frameSize: size, hopSize: hop, nFrames, features: {}, matrices: {} };

  if (scalar.length) { res.features = await describeMeyda(signal, sampleRate, scalar, size, hop, sub); done++; }

  if (features.indexOf('pitch') >= 0) {
    const p = new Float64Array(nFrames);
    await eachFrame(signal, size, hop, (frame, i) => { p[i] = pitch(frame, sampleRate); }, sub);
    res.features.pitch = p; done++;
  }
  if (features.indexOf('mfcc') >= 0) {
    const M = Meyda, rows = 13;
    M.sampleRate = sampleRate; M.bufferSize = size; M.windowingFunction = 'hanning';
    M.numberOfMFCCCoefficients = rows;
    const data = new Float32Array(rows * nFrames);
    await eachFrame(signal, size, hop, (frame, i) => {
      const m = M.extract('mfcc', frame);
      if (m) for (let r = 0; r < rows; r++) data[r * nFrames + i] = m[r];
    }, sub);
    res.matrices.mfcc = { rows, cols: nFrames, data }; done++;
  }
  if (features.indexOf('chroma') >= 0) {
    const M = Meyda, rows = 12;
    M.sampleRate = sampleRate; M.bufferSize = size; M.windowingFunction = 'hanning';
    // Meyda 5.6.3 rebuilds its chroma filter bank only when the number of bands
    // changes, not the frame size or sample rate: drop it so it is rebuilt.
    M.chromaFilterBank = undefined;
    const data = new Float32Array(rows * nFrames);
    await eachFrame(signal, size, hop, (frame, i) => {
      const c = M.extract('chroma', frame);
      if (c) for (let r = 0; r < rows; r++) data[r * nFrames + i] = c[r];
    }, sub);
    res.matrices.chroma = { rows, cols: nFrames, data }; done++;
  }
  if (features.indexOf('spectralFlux') >= 0) {
    // the same measure as the novelty curve of spectrogram(): half-wave rectified
    const win = windowFn(size, 'hann'), scratch: Scratch = {};
    const bins = (size >> 1) + 1, prev = new Float32Array(bins);
    const fl = new Float64Array(nFrames);
    await eachFrame(signal, size, hop, (frame, i) => {
      const mag = magnitude(frame, win, scratch);
      let s = 0;
      for (let k = 0; k < bins; k++) { const d = mag[k] - prev[k]; if (d > 0) s += d; prev[k] = mag[k]; }
      fl[i] = i === 0 ? NaN : s;
    }, sub);
    res.features.spectralFlux = fl; done++;
  }
  return res;
}

/* --- projection to 2D ------------------------------------------------------- */

/** Standardise columns (zero mean, unit variance); NaN → column mean. */
export function standardise(vectors: number[][]): Float64Array[] {
  const n = vectors.length; if (!n) return [];
  const d = vectors[0].length;
  const mean = new Float64Array(d), std = new Float64Array(d), cnt = new Float64Array(d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) {
    const v = vectors[i][j]; if (isFinite(v)) { mean[j] += v; cnt[j]++; }
  }
  for (let j = 0; j < d; j++) mean[j] = cnt[j] ? mean[j] / cnt[j] : 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) {
    const w = vectors[i][j]; if (isFinite(w)) std[j] += (w - mean[j]) * (w - mean[j]);
  }
  for (let j = 0; j < d; j++) std[j] = cnt[j] > 1 ? Math.sqrt(std[j] / (cnt[j] - 1)) : 1;
  return vectors.map((vec) => {
    const out = new Float64Array(d);
    for (let k = 0; k < d; k++) {
      const x = isFinite(vec[k]) ? vec[k] : mean[k];
      out[k] = std[k] > 1e-12 ? (x - mean[k]) / std[k] : 0;
    }
    return out;
  });
}

/** PCA to two axes by power iteration on the covariance matrix. */
export function pca(vectors: number[][]): number[][] {
  const X = standardise(vectors);
  const n = X.length; if (!n) return [];
  const d = X[0].length;
  const C: Float64Array[] = [];
  for (let i = 0; i < d; i++) C.push(new Float64Array(d));
  for (let k = 0; k < n; k++) for (let i = 0; i < d; i++) for (let j = i; j < d; j++) C[i][j] += X[k][i] * X[k][j];
  for (let i = 0; i < d; i++) for (let j = i; j < d; j++) { C[i][j] /= Math.max(1, n - 1); C[j][i] = C[i][j]; }
  const comps: Float64Array[] = [];
  for (let c = 0; c < 2; c++) {
    let v = new Float64Array(d);
    for (let i = 0; i < d; i++) v[i] = 1 / Math.sqrt(d) + 0.01 * i * (c + 1);
    for (let it = 0; it < 200; it++) {
      const w = new Float64Array(d);
      for (let i = 0; i < d; i++) for (let j = 0; j < d; j++) w[i] += C[i][j] * v[j];
      for (const u of comps) {
        let dot = 0; for (let i = 0; i < d; i++) dot += w[i] * u[i];
        for (let i = 0; i < d; i++) w[i] -= dot * u[i];
      }
      let norm = 0; for (let i = 0; i < d; i++) norm += w[i] * w[i];
      norm = Math.sqrt(norm) || 1;
      v = w.map((x) => x / norm);
    }
    comps.push(v);
  }
  return X.map((x) => {
    const p = [0, 0];
    for (let i = 0; i < d; i++) { p[0] += x[i] * comps[0][i]; p[1] += x[i] * comps[1][i]; }
    return p;
  });
}

/** t-SNE, plain O(n²) — fine for a few hundred segments. Yields between iterations. */
export async function tsne(vectors: number[][], opts: { perplexity?: number; iterations?: number; seed?: number; onProgress?: Progress;
  /** precomputed distances (n × n, not squared): another metric than Euclidean */ distances?: Float64Array } = {}): Promise<number[][]> {
  const X = standardise(vectors);
  const n = X.length;
  if (n < 3) return X.map(() => [0, 0]);
  const perp = Math.min(opts.perplexity || 15, Math.floor((n - 1) / 3)) || 2;
  const iters = opts.iterations || 400;
  let seed = opts.seed || 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
  const d = X[0].length;
  const D = new Float64Array(n * n);
  if (opts.distances) {
    // squared, and rescaled so the mean matches what Euclidean on standardised data would give
    const pre = opts.distances;
    let m = 0; for (let q = 0; q < n * n; q++) m += pre[q] * pre[q];
    const scale = m > 0 ? (2 * d * n * (n - 1) / n / n) / (m / (n * n)) : 1;
    for (let q = 0; q < n * n; q++) D[q] = pre[q] * pre[q] * scale;
  } else for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    let s = 0; for (let k = 0; k < d; k++) { const t = X[i][k] - X[j][k]; s += t * t; }
    D[i * n + j] = s; D[j * n + i] = s;
  }
  const P = new Float64Array(n * n);
  const target = Math.log(perp);
  for (let i = 0; i < n; i++) {
    let beta = 1, lo = -Infinity, hi = Infinity;
    const row = new Float64Array(n);
    for (let tries = 0; tries < 50; tries++) {
      let sum = 0;
      for (let j = 0; j < n; j++) { row[j] = i === j ? 0 : Math.exp(-D[i * n + j] * beta); sum += row[j]; }
      let H = 0;
      for (let j = 0; j < n; j++) if (row[j] > 0) { const pj = row[j] / sum; H -= pj * Math.log(pj); }
      const diff = H - target;
      if (Math.abs(diff) < 1e-4) break;
      if (diff > 0) { lo = beta; beta = isFinite(hi) ? (beta + hi) / 2 : beta * 2; }
      else { hi = beta; beta = isFinite(lo) ? (beta + lo) / 2 : beta / 2; }
      if (!isFinite(sum) || sum === 0) break;
    }
    let tot = 0; for (let j = 0; j < n; j++) tot += row[j];
    for (let j = 0; j < n; j++) P[i * n + j] = tot ? row[j] / tot : 0;
  }
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const p = (P[i * n + j] + P[j * n + i]) / (2 * n);
    P[i * n + j] = p; P[j * n + i] = p;
  }
  const Y: number[][] = [], dY: number[][] = [], gains: number[][] = [], iY: number[][] = [];
  for (let i = 0; i < n; i++) {
    Y.push([(rnd() - 0.5) * 1e-2, (rnd() - 0.5) * 1e-2]);
    dY.push([0, 0]); gains.push([1, 1]); iY.push([0, 0]);
  }
  let it = 0;
  while (it < iters) {
    const batchEnd = Math.min(iters, it + 20);
    for (; it < batchEnd; it++) {
      const exag = it < 100 ? 4 : 1, mom = it < 250 ? 0.5 : 0.8, eta = 100;
      const Q = new Float64Array(n * n); let qs = 0;
      for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
        const dx = Y[i][0] - Y[j][0], dy = Y[i][1] - Y[j][1];
        const q = 1 / (1 + dx * dx + dy * dy);
        Q[i * n + j] = q; Q[j * n + i] = q; qs += 2 * q;
      }
      for (let i = 0; i < n; i++) {
        let gx = 0, gy = 0;
        for (let j = 0; j < n; j++) {
          if (i === j) continue;
          const q2 = Q[i * n + j];
          const mult = 4 * (exag * P[i * n + j] - q2 / qs) * q2;
          gx += mult * (Y[i][0] - Y[j][0]); gy += mult * (Y[i][1] - Y[j][1]);
        }
        dY[i][0] = gx; dY[i][1] = gy;
      }
      for (let i = 0; i < n; i++) for (let k = 0; k < 2; k++) {
        gains[i][k] = (Math.sign(dY[i][k]) !== Math.sign(iY[i][k])) ? gains[i][k] + 0.2 : gains[i][k] * 0.8;
        if (gains[i][k] < 0.01) gains[i][k] = 0.01;
        iY[i][k] = mom * iY[i][k] - eta * gains[i][k] * dY[i][k];
        Y[i][k] += iY[i][k];
      }
      let mx = 0, my = 0;
      for (let i = 0; i < n; i++) { mx += Y[i][0]; my += Y[i][1]; }
      for (let i = 0; i < n; i++) { Y[i][0] -= mx / n; Y[i][1] -= my / n; }
    }
    if (opts.onProgress) opts.onProgress(it / iters);
    await tick();
  }
  return Y;
}
