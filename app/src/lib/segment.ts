/* Segmentation analyses. Each one turns a signal into a novelty curve (one
   value per analysis frame, high where a cut is likely) plus the rule that
   places a cut from a peak of that curve. The segmentation tool then picks the
   peaks with the shared sensitivity / minimum-gap logic (dsp.peaks).

     onsets      — onset detection functions from one STFT pass: log spectral
                   flux, high-frequency content, complex domain, energy;
     transients  — time domain: a fast energy envelope rising above a slow one
                   (what a "transient designer" listens to);
     self-similarity — a frame × frame similarity matrix on a chosen feature
                   (log spectrum, MFCC, chroma, or a set of descriptors), and
                   Foote's checkerboard novelty along its diagonal.            */

import { describe, fft, isPowerOfTwo, magnitude, Matrix, Progress, Scratch, windowFn } from './dsp';
import { tr } from '../i18n/core';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export type Novelty = {
  values: Float32Array;
  times: Float64Array;          // seconds, one per value
  frameSec: number;             // time between two values
  cutAt: (i: number) => number; // cut time (s) for a peak at index i
  matrix?: Matrix;              // the self-similarity matrix, when there is one
};

/* --- onset detection functions ------------------------------------------------ */

export type Odf = 'logflux' | 'hfc' | 'complex' | 'energy';
export const ODFS: Odf[] = ['logflux', 'hfc', 'complex', 'energy'];

export type OnsetCurves = {
  times: Float64Array; rms: Float32Array; frameSize: number; hop: number; sampleRate: number;
  odf: Record<Odf, Float32Array>;
};

/** All four detection functions in one STFT pass. */
export async function onsetCurves(signal: Float32Array, sampleRate: number,
  opts: { frameSize?: number; hopSize?: number; onProgress?: Progress } = {}): Promise<OnsetCurves> {
  const size = opts.frameSize || 1024, hop = opts.hopSize || 256;
  if (!isPowerOfTwo(size)) throw new Error(tr('err.pow2'));
  const win = windowFn(size, 'hann');
  const nFrames = Math.max(0, Math.floor((signal.length - size) / hop) + 1);
  const bins = (size >> 1) + 1;
  const times = new Float64Array(nFrames), rms = new Float32Array(nFrames);
  const logflux = new Float32Array(nFrames), hfc = new Float32Array(nFrames);
  const complex = new Float32Array(nFrames), energy = new Float32Array(nFrames);
  const re = new Float64Array(size), im = new Float64Array(size);
  const prevLog = new Float32Array(bins), prevMag = new Float32Array(bins);
  const ph1 = new Float32Array(bins), ph2 = new Float32Array(bins);
  let prevHfc = 0, prevRms = 0;
  const CHUNK = 200;
  for (let i = 0; i < nFrames;) {
    const end = Math.min(nFrames, i + CHUNK);
    for (; i < end; i++) {
      const off = i * hop;
      let e = 0;
      for (let k = 0; k < size; k++) { const v = signal[off + k]; e += v * v; re[k] = v * win[k]; im[k] = 0; }
      fft(re, im);
      const r = Math.sqrt(e / size);
      let lf = 0, h = 0, cd = 0;
      for (let k = 0; k < bins; k++) {
        const mag = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * 2 / size;
        const ph = Math.atan2(im[k], re[k]);
        // log flux against the max of the 3 neighbouring bins of the previous
        // frame (a light "superflux"): vibrato does not read as an onset
        const l = Math.log1p(100 * mag);
        const ref = Math.max(prevLog[k], k > 0 ? prevLog[k - 1] : 0, k + 1 < bins ? prevLog[k + 1] : 0);
        if (l > ref) lf += l - ref;
        h += k * mag * mag;
        // complex domain, rectified: distance to the spectrum predicted from the
        // two previous frames (same magnitude, phase advancing steadily)
        if (mag >= prevMag[k]) {
          const pp = 2 * ph1[k] - ph2[k];
          const dr = mag * Math.cos(ph) - prevMag[k] * Math.cos(pp), di = mag * Math.sin(ph) - prevMag[k] * Math.sin(pp);
          cd += Math.sqrt(dr * dr + di * di);
        }
        prevLog[k] = l; ph2[k] = ph1[k]; ph1[k] = ph; prevMag[k] = mag;
      }
      times[i] = (off + size / 2) / sampleRate;
      rms[i] = r;
      logflux[i] = i === 0 ? 0 : lf;
      hfc[i] = i === 0 ? 0 : Math.max(0, h - prevHfc);
      complex[i] = i < 2 ? 0 : cd;
      energy[i] = i === 0 ? 0 : Math.max(0, r - prevRms);
      prevHfc = h; prevRms = r;
    }
    if (opts.onProgress) opts.onProgress(nFrames ? i / nFrames : 1);
    await tick();
  }
  return { times, rms, frameSize: size, hop, sampleRate, odf: { logflux, hfc, complex, energy } };
}

/** A novelty from one detection function. With backtrack, the cut moves back
    from the peak to the energy trough before it (at most 200 ms): the cut
    lands before the attack instead of in it. */
const compressed = new WeakMap<Float32Array, Float32Array>();
/** log(1 + 10·v / mean): a few huge attacks (a noise burst) no longer flatten
    every other peak below the threshold. */
function compress(v: Float32Array): Float32Array {
  const have = compressed.get(v); if (have) return have;
  let s = 0, n = 0; for (let i = 0; i < v.length; i++) if (v[i] > 0) { s += v[i]; n++; }
  const m = n ? s / n : 1, out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Math.log1p(10 * v[i] / m);
  compressed.set(v, out);
  return out;
}

export function onsetNovelty(oc: OnsetCurves, odf: Odf, backtrack: boolean): Novelty {
  const frameSec = oc.hop / oc.sampleRate, half = oc.frameSize / 2 / oc.sampleRate;
  const maxBack = Math.round(0.2 / frameSec);
  return {
    values: compress(oc.odf[odf]), times: oc.times, frameSec,
    cutAt: (i) => {
      if (!backtrack) return Math.max(0, oc.times[i] - half);
      let j = i;
      while (j > 0 && i - j < maxBack && oc.rms[j - 1] < oc.rms[j] * 0.995) j--;
      return Math.max(0, oc.times[j] - half);
    },
  };
}

/* --- transients ------------------------------------------------------------ */

/** Short-window energy (dB) against a slow-attack copy of itself: steady
    sounds and slow swells give ~0, a sharp attack a jump of several dB.
    attackMs is the rise time below which a change counts as a transient;
    floorDb ignores anything quieter than the loudest moment minus floorDb. */
export async function transientNovelty(signal: Float32Array, sampleRate: number,
  opts: { attackMs?: number; floorDb?: number; onProgress?: Progress } = {}): Promise<Novelty> {
  const hop = 64, win = 512;
  const n = Math.max(0, Math.floor((signal.length - win) / hop) + 1);
  const fast = new Float32Array(n), times = new Float64Array(n);
  const CHUNK = 4000;
  for (let i = 0; i < n;) {
    const end = Math.min(n, i + CHUNK);
    for (; i < end; i++) {
      const off = i * hop;
      let e = 0;
      for (let k = 0; k < win; k++) { const v = signal[off + k]; e += v * v; }
      fast[i] = 10 * Math.log10(e / win + 1e-12);
      times[i] = (off + win / 2) / sampleRate;
    }
    if (opts.onProgress) opts.onProgress(n ? i / n : 1);
    await tick();
  }
  let top = -Infinity;
  for (let i = 0; i < n; i++) if (fast[i] > top) top = fast[i];
  const floor = top - (opts.floorDb || 50);
  const frameSec = hop / sampleRate;
  const alpha = 1 - Math.exp(-frameSec / ((opts.attackMs || 30) / 1000));
  const values = new Float32Array(n);
  let slow = n ? fast[0] : 0;
  for (let i = 0; i < n; i++) {
    const f = fast[i];
    slow = f < slow ? f : slow + alpha * (f - slow);   // follows down at once, up slowly
    values[i] = f > floor ? Math.max(0, f - slow) : 0;
  }
  return {
    values, times, frameSec,
    // back to where the rise starts: the window's centre is then just before the attack
    cutAt: (i) => { let j = i; while (j > 0 && values[j - 1] > 0 && values[j - 1] < values[j]) j--; return Math.max(0, times[j] - win / 4 / sampleRate); },
  };
}

/* --- self-similarity ------------------------------------------------------- */

export type SsmFeature = 'spectrum' | 'mfcc' | 'chroma' | 'descriptors';
export type SsmDistance = 'cosine' | 'euclidean';
export const SSM_DESCRIPTORS = ['rms', 'loudness', 'spectralCentroid', 'spectralSpread', 'spectralFlatness',
  'spectralRolloff', 'spectralCrest', 'zcr', 'pitch'];

const SSM_FRAME = 2048, SSM_HOP = 512, BANDS = 40;

/** One feature vector per analysis frame: frames × dims, row-major. */
async function featureFrames(signal: Float32Array, sr: number, feature: SsmFeature, descriptors: string[], onProgress?: Progress) {
  const nFrames = Math.max(0, Math.floor((signal.length - SSM_FRAME) / SSM_HOP) + 1);
  if (feature === 'spectrum') {
    // 40 log-spaced bands from 40 Hz to Nyquist, log-compressed
    const bins = SSM_FRAME / 2 + 1, edges: number[] = [];
    const lo = Math.log(40), hi = Math.log(sr / 2);
    for (let b = 0; b <= BANDS; b++) edges.push(Math.min(bins - 1, Math.max(1, Math.round(Math.exp(lo + (hi - lo) * b / BANDS) / (sr / 2) * (bins - 1)))));
    const data = new Float32Array(nFrames * BANDS), win = windowFn(SSM_FRAME, 'hann'), scratch: Scratch = {};
    const frame = new Float32Array(SSM_FRAME);
    for (let i = 0; i < nFrames;) {
      const end = Math.min(nFrames, i + 200);
      for (; i < end; i++) {
        frame.set(signal.subarray(i * SSM_HOP, i * SSM_HOP + SSM_FRAME));
        const mag = magnitude(frame, win, scratch);
        for (let b = 0; b < BANDS; b++) {
          const a = edges[b], z = Math.max(a + 1, edges[b + 1]);
          let s = 0; for (let k = a; k < z; k++) s += mag[k];
          data[i * BANDS + b] = Math.log1p(1000 * s / (z - a));
        }
      }
      if (onProgress) onProgress(nFrames ? i / nFrames : 1);
      await tick();
    }
    return { n: nFrames, dims: BANDS, data };
  }
  const feats = feature === 'descriptors' ? descriptors : [feature];
  if (!feats.length) throw new Error(tr('err.noDescriptor'));
  const res = await describe(signal, sr, feats, { frameSize: SSM_FRAME, hopSize: SSM_HOP, onProgress });
  if (feature === 'mfcc' || feature === 'chroma') {
    const m = res.matrices[feature];
    const skip = feature === 'mfcc' ? 1 : 0;          // MFCC 0 is loudness, not timbre
    const dims = m.rows - skip, data = new Float32Array(res.nFrames * dims);
    for (let i = 0; i < res.nFrames; i++) for (let r = 0; r < dims; r++) data[i * dims + r] = m.data[(r + skip) * m.cols + i];
    return { n: res.nFrames, dims, data };
  }
  // descriptors: z-scored per dimension over the file, NaN (unvoiced pitch…) → 0 (the mean)
  const dims = feats.length, data = new Float32Array(res.nFrames * dims);
  feats.forEach((f, d) => {
    const s = res.features[f];
    let sum = 0, sum2 = 0, cnt = 0;
    for (let i = 0; i < s.length; i++) if (isFinite(s[i])) { sum += s[i]; sum2 += s[i] * s[i]; cnt++; }
    const mean = cnt ? sum / cnt : 0, sd = cnt > 1 ? Math.sqrt(Math.max(0, sum2 / cnt - mean * mean)) : 1;
    for (let i = 0; i < s.length; i++) data[i * dims + d] = isFinite(s[i]) && sd > 1e-12 ? (s[i] - mean) / sd : 0;
  });
  return { n: res.nFrames, dims, data };
}

/** Self-similarity matrix and its checkerboard novelty. The frames are averaged
    into at most maxFrames blocks, so a long file stays an N² the browser can hold. */
export async function ssmNovelty(signal: Float32Array, sampleRate: number,
  opts: { feature: SsmFeature; descriptors: string[]; distance: SsmDistance; kernelSec: number; maxFrames?: number; onProgress?: Progress }): Promise<Novelty> {
  const sub = (a: number, b: number): Progress => (p) => opts.onProgress?.(a + (b - a) * p);
  const F = await featureFrames(signal, sampleRate, opts.feature, opts.descriptors, sub(0, 0.6));
  if (F.n < 4) throw new Error(tr('err.tooShort'));
  const N = Math.min(F.n, opts.maxFrames || 900), per = F.n / N, D = F.dims;
  const X = new Float64Array(N * D);
  for (let b = 0; b < N; b++) {
    const a = Math.floor(b * per), z = Math.max(a + 1, Math.floor((b + 1) * per));
    for (let i = a; i < z; i++) for (let d = 0; d < D; d++) X[b * D + d] += F.data[i * D + d];
    for (let d = 0; d < D; d++) X[b * D + d] /= (z - a);
  }
  const hopSec = SSM_HOP / sampleRate, blockSec = per * hopSec;
  const times = new Float64Array(N);
  for (let b = 0; b < N; b++) times[b] = Math.floor(b * per) * hopSec + SSM_FRAME / 2 / sampleRate;

  // the matrix
  const S = new Float32Array(N * N);
  if (opts.distance === 'cosine') {
    const norm = new Float64Array(N);
    for (let b = 0; b < N; b++) { let s = 0; for (let d = 0; d < D; d++) s += X[b * D + d] * X[b * D + d]; norm[b] = Math.sqrt(s) || 1; }
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        let s = 0; for (let d = 0; d < D; d++) s += X[i * D + d] * X[j * D + d];
        const c = s / (norm[i] * norm[j]);
        S[i * N + j] = S[j * N + i] = (c + 1) / 2;
      }
      if (i % 50 === 49) { opts.onProgress?.(0.6 + 0.2 * i / N); await tick(); }
    }
  } else {
    let mean = 0;
    for (let i = 0; i < N; i++) {
      for (let j = i; j < N; j++) {
        let s = 0; for (let d = 0; d < D; d++) { const t = X[i * D + d] - X[j * D + d]; s += t * t; }
        S[i * N + j] = S[j * N + i] = s; mean += i === j ? 0 : 2 * s;
      }
      if (i % 50 === 49) { opts.onProgress?.(0.6 + 0.2 * i / N); await tick(); }
    }
    mean = mean / Math.max(1, N * (N - 1)) || 1;
    for (let k = 0; k < S.length; k++) S[k] = Math.exp(-S[k] / mean);
  }

  // checkerboard kernel with a Gaussian taper: + within the past, + within the
  // future, − across; it peaks where the past stops resembling the future
  const L = Math.max(2, Math.min(Math.floor(N / 4), Math.round(opts.kernelSec / 2 / blockSec)));
  const K = new Float32Array(4 * L * L), sig = L / 2;
  for (let a = -L; a < L; a++) for (let b = -L; b < L; b++) {
    const sgn = ((a < 0) === (b < 0)) ? 1 : -1;
    const ga = (a + 0.5) / sig, gb = (b + 0.5) / sig;
    K[(a + L) * 2 * L + (b + L)] = sgn * Math.exp(-0.5 * (ga * ga + gb * gb));
  }
  const values = new Float32Array(N);
  for (let i = L; i <= N - L; i++) {
    let s = 0;
    for (let a = -L; a < L; a++) {
      const row = (i + a) * N + i, kr = (a + L) * 2 * L + L;
      for (let b = -L; b < L; b++) s += K[kr + b] * S[row + b];
    }
    values[i] = Math.max(0, s);
    if (i % 40 === 0) { opts.onProgress?.(0.8 + 0.2 * i / N); await tick(); }
  }
  opts.onProgress?.(1);
  return { values, times, frameSec: blockSec, cutAt: (i) => Math.max(0, times[i] - SSM_FRAME / 2 / sampleRate), matrix: { rows: N, cols: N, data: S } };
}
