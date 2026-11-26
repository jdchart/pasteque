/* Spectral processing: analyse (STFT), change the spectrum with masks,
   resynthesise (inverse STFT, overlap-add). Every operation here produces
   soft masks — one per output layer — so the layers add back up to the
   original (except noise reduction's floor and NMF's approximation).

     hpss      — harmonic / percussive by median filtering (Fitzgerald 2010);
                 with a margin > 1, a third residual layer (Driedger 2014):
                 tonal / transient / noise;
     nmf       — non-negative matrix factorisation of the magnitude (KL
                 divergence), K spectral templates × their activations;
     denoise   — spectral gate against a noise profile;
     drawn     — a mask painted on the spectrogram.                        */

import { fft, isPowerOfTwo, Progress, windowFn } from './dsp';
import { tr } from '../i18n/core';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export type Stft = {
  re: Float32Array; im: Float32Array; mag: Float32Array;   // frame-major: frame i, bin k at i * bins + k
  nFrames: number; bins: number; size: number; hop: number; sampleRate: number; length: number;
};

/** STFT with size/2 zeros on each side, so the edges are analysed like the middle. */
export async function stft(signal: Float32Array, sampleRate: number, size = 2048, hop = size / 4, onProgress?: Progress): Promise<Stft> {
  if (!isPowerOfTwo(size)) throw new Error(tr('err.pow2'));
  const pad = size / 2, len = signal.length;
  const nFrames = Math.floor((len + 2 * pad - size) / hop) + 1, bins = size / 2 + 1;
  const re = new Float32Array(nFrames * bins), im = new Float32Array(nFrames * bins), mag = new Float32Array(nFrames * bins);
  const win = windowFn(size, 'hann'), fr = new Float64Array(size), fi = new Float64Array(size);
  for (let i = 0; i < nFrames;) {
    const end = Math.min(nFrames, i + 150);
    for (; i < end; i++) {
      const off = i * hop - pad;
      for (let k = 0; k < size; k++) { const j = off + k; fr[k] = j >= 0 && j < len ? signal[j] * win[k] : 0; fi[k] = 0; }
      fft(fr, fi);
      const o = i * bins;
      for (let k = 0; k < bins; k++) { re[o + k] = fr[k]; im[o + k] = fi[k]; mag[o + k] = Math.hypot(fr[k], fi[k]); }
    }
    onProgress?.(i / nFrames);
    await tick();
  }
  return { re, im, mag, nFrames, bins, size, hop, sampleRate, length: len };
}

/** Inverse STFT of the spectrum multiplied by a mask (same layout as mag). */
export async function istft(S: Stft, mask: Float32Array | null, onProgress?: Progress): Promise<Float32Array> {
  const { size, hop, bins, nFrames, length } = S, pad = size / 2;
  const out = new Float64Array(length + 2 * pad), norm = new Float64Array(length + 2 * pad);
  const win = windowFn(size, 'hann'), fr = new Float64Array(size), fi = new Float64Array(size);
  for (let i = 0; i < nFrames;) {
    const end = Math.min(nFrames, i + 150);
    for (; i < end; i++) {
      const o = i * bins;
      // conj(X), full spectrum by Hermitian symmetry, forward FFT, conj, /N  =  inverse FFT
      for (let k = 0; k < bins; k++) { const m = mask ? mask[o + k] : 1; fr[k] = S.re[o + k] * m; fi[k] = -S.im[o + k] * m; }
      for (let k = bins; k < size; k++) { fr[k] = fr[size - k]; fi[k] = -fi[size - k]; }
      fft(fr, fi);
      const off = i * hop;
      for (let k = 0; k < size; k++) { const w = win[k]; out[off + k] += fr[k] / size * w; norm[off + k] += w * w; }
    }
    onProgress?.(i / nFrames);
    await tick();
  }
  const y = new Float32Array(length);
  for (let j = 0; j < length; j++) { const nn = norm[j + pad]; y[j] = nn > 1e-8 ? out[j + pad] / nn : 0; }
  return y;
}

/* --- median filtering (HPSS) -------------------------------------------------- */

/** k-th smallest of buf[0..n) (destroys the order). */
function select(buf: Float32Array, n: number, k: number): number {
  let lo = 0, hi = n - 1;
  while (hi > lo) {
    const pivot = buf[(lo + hi) >> 1];
    let i = lo, j = hi;
    while (i <= j) {
      while (buf[i] < pivot) i++;
      while (buf[j] > pivot) j--;
      if (i <= j) { const t = buf[i]; buf[i] = buf[j]; buf[j] = t; i++; j--; }
    }
    if (k <= j) hi = j; else if (k >= i) lo = i; else return buf[k];
  }
  return buf[k];
}

async function medianTime(S: Stft, L: number, onProgress?: Progress): Promise<Float32Array> {
  const { nFrames: T, bins: B, mag } = S, out = new Float32Array(T * B), h = L >> 1, buf = new Float32Array(L);
  for (let k = 0; k < B; k++) {
    for (let i = 0; i < T; i++) {
      let n = 0;
      for (let d = -h; d <= h; d++) { const j = i + d; buf[n++] = j >= 0 && j < T ? mag[j * B + k] : 0; }
      out[i * B + k] = select(buf, n, n >> 1);
    }
    if (k % 64 === 63) { onProgress?.(k / B); await tick(); }
  }
  return out;
}

async function medianFreq(S: Stft, L: number, onProgress?: Progress): Promise<Float32Array> {
  const { nFrames: T, bins: B, mag } = S, out = new Float32Array(T * B), h = L >> 1, buf = new Float32Array(L);
  for (let i = 0; i < T; i++) {
    const o = i * B;
    for (let k = 0; k < B; k++) {
      let n = 0;
      for (let d = -h; d <= h; d++) { const j = k + d; buf[n++] = j >= 0 && j < B ? mag[o + j] : 0; }
      out[o + k] = select(buf, n, n >> 1);
    }
    if (i % 64 === 63) { onProgress?.(i / T); await tick(); }
  }
  return out;
}

/** Harmonic / percussive soft masks; with margin > 1, also a residual mask.
    lenTime / lenFreq are the median lengths in frames / bins (odd). */
export async function hpssMasks(S: Stft, opts: { lenTime: number; lenFreq: number; margin: number; onProgress?: Progress }): Promise<Float32Array[]> {
  const H = await medianTime(S, opts.lenTime | 1, (p) => opts.onProgress?.(p * 0.5));
  const P = await medianFreq(S, opts.lenFreq | 1, (p) => opts.onProgress?.(0.5 + p * 0.5));
  const n = H.length, b = Math.max(1, opts.margin), mh = new Float32Array(n), mp = new Float32Array(n);
  for (let q = 0; q < n; q++) {
    const h2 = H[q] * H[q], p2 = P[q] * P[q], e = 1e-20;
    mh[q] = h2 / (h2 + b * b * p2 + e);
    mp[q] = p2 / (p2 + b * b * h2 + e);
  }
  if (b <= 1.0001) return [mh, mp];
  const mr = new Float32Array(n);
  for (let q = 0; q < n; q++) mr[q] = Math.max(0, 1 - mh[q] - mp[q]);
  return [mh, mp, mr];
}

/* --- NMF --------------------------------------------------------------------- */

export type NmfResult = { masks: Float32Array[]; W: Float32Array; H: Float32Array; K: number; rowsW: number; colsH: number; centroids: number[] };

/** KL-NMF on a pooled magnitude (≤ 256 bands × ≤ 600 frames), then Wiener
    masks at full resolution. Components are sorted by spectral centroid,
    low to high, so the order means something. */
export async function nmf(S: Stft, opts: { K: number; iterations?: number; seed?: number; onProgress?: Progress }): Promise<NmfResult> {
  const { nFrames: T, bins: B, mag } = S, K = Math.max(1, Math.min(16, opts.K));
  const pf = Math.max(1, Math.ceil(B / 256)), tf = Math.max(1, Math.ceil(T / 600));
  const R = Math.ceil(B / pf), C = Math.ceil(T / tf);
  const V = new Float32Array(R * C);                 // row-major: band r, frame c
  for (let i = 0; i < T; i++) for (let k = 0; k < B; k++) V[Math.floor(k / pf) * C + Math.floor(i / tf)] += mag[i * B + k];
  let seed = (opts.seed || 1) * 7919 % 2147483647 || 1;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  let vmean = 0; for (let q = 0; q < V.length; q++) vmean += V[q]; vmean = vmean / V.length || 1;
  const W = new Float32Array(R * K), H = new Float32Array(K * C);
  for (let q = 0; q < W.length; q++) W[q] = 0.1 + rnd();
  for (let q = 0; q < H.length; q++) H[q] = (0.1 + rnd()) * vmean / K;
  const WH = new Float32Array(R * C), Q = new Float32Array(R * C);
  const iters = opts.iterations || 150, eps = 1e-12;
  const product = () => {
    WH.fill(0);
    for (let r = 0; r < R; r++) for (let k = 0; k < K; k++) { const w = W[r * K + k]; if (!w) continue; const ho = k * C, o = r * C; for (let c = 0; c < C; c++) WH[o + c] += w * H[ho + c]; }
  };
  for (let it = 0; it < iters; it++) {
    product();
    for (let q = 0; q < V.length; q++) Q[q] = V[q] / (WH[q] + eps);
    // H ← H ⊙ (Wᵀ Q) / (Wᵀ 1)
    for (let k = 0; k < K; k++) {
      let ws = 0; for (let r = 0; r < R; r++) ws += W[r * K + k];
      for (let c = 0; c < C; c++) { let s = 0; for (let r = 0; r < R; r++) s += W[r * K + k] * Q[r * C + c]; H[k * C + c] *= s / (ws + eps); }
    }
    product();
    for (let q = 0; q < V.length; q++) Q[q] = V[q] / (WH[q] + eps);
    // W ← W ⊙ (Q Hᵀ) / (1 Hᵀ)
    for (let k = 0; k < K; k++) {
      let hs = 0; for (let c = 0; c < C; c++) hs += H[k * C + c];
      for (let r = 0; r < R; r++) { let s = 0; const o = r * C, ho = k * C; for (let c = 0; c < C; c++) s += Q[o + c] * H[ho + c]; W[r * K + k] *= s / (hs + eps); }
    }
    // keep templates at unit sum (activations carry the level)
    for (let k = 0; k < K; k++) {
      let s = 0; for (let r = 0; r < R; r++) s += W[r * K + k];
      if (s > eps) { for (let r = 0; r < R; r++) W[r * K + k] /= s; for (let c = 0; c < C; c++) H[k * C + c] *= s; }
    }
    if (it % 5 === 4) { opts.onProgress?.(0.85 * it / iters); await tick(); }
  }
  // order by centroid
  const hzPerBand = pf * S.sampleRate / S.size;
  const cent = Array.from({ length: K }, (_, k) => { let s = 0, m = 0; for (let r = 0; r < R; r++) { s += W[r * K + k]; m += W[r * K + k] * (r + 0.5) * hzPerBand; } return s ? m / s : 0; });
  const order = cent.map((_, k) => k).sort((a, b) => cent[a] - cent[b]);
  const W2 = new Float32Array(R * K), H2 = new Float32Array(K * C);
  order.forEach((k, j) => { for (let r = 0; r < R; r++) W2[r * K + j] = W[r * K + k]; H2.set(H.subarray(k * C, (k + 1) * C), j * C); });
  // masks at full resolution: activations interpolated in time, templates repeated in frequency
  const masks = Array.from({ length: K }, () => new Float32Array(T * B));
  const parts = new Float32Array(K);
  for (let i = 0; i < T; i++) {
    const x = (i + 0.5) / tf - 0.5, c0 = Math.max(0, Math.min(C - 1, Math.floor(x))), c1 = Math.min(C - 1, c0 + 1), f = Math.max(0, Math.min(1, x - c0));
    for (let k = 0; k < B; k++) {
      const r = Math.floor(k / pf);
      let tot = 0;
      for (let j = 0; j < K; j++) { const h = H2[j * C + c0] * (1 - f) + H2[j * C + c1] * f; const v = W2[r * K + j] * h; parts[j] = v; tot += v; }
      const o = i * B + k;
      for (let j = 0; j < K; j++) masks[j][o] = tot > eps ? parts[j] / tot : 1 / K;
    }
    if (i % 200 === 199) { opts.onProgress?.(0.85 + 0.15 * i / T); await tick(); }
  }
  return { masks, W: W2, H: H2, K, rowsW: R, colsH: C, centroids: order.map((k) => cent[k]) };
}

/* --- noise reduction --------------------------------------------------------- */

/** Spectral gate. The profile is the mean and spread of each bin over the
    frames [f0, f1) — or, with no range, over the quietest 10 % of frames. A
    bin passes when it stands `sensitivity` standard deviations above the
    noise; otherwise it is lowered by `reductionDb`. The mask is smoothed
    over ±2 frames and ±2 bins against "musical noise". Returns [kept, removed]. */
export function denoiseMasks(S: Stft, opts: { reductionDb: number; sensitivity: number; profile?: [number, number] | null }): Float32Array[] {
  const { nFrames: T, bins: B, mag } = S;
  let frames: number[];
  if (opts.profile && opts.profile[1] - opts.profile[0] >= 2) {
    frames = []; for (let i = Math.max(0, opts.profile[0]); i < Math.min(T, opts.profile[1]); i++) frames.push(i);
  } else {
    const e = Array.from({ length: T }, (_, i) => { let s = 0; for (let k = 0; k < B; k++) s += mag[i * B + k] * mag[i * B + k]; return s; });
    frames = e.map((_, i) => i).sort((a, b) => e[a] - e[b]).slice(0, Math.max(2, Math.floor(T * 0.1)));
  }
  const mu = new Float32Array(B), sd = new Float32Array(B);
  for (const i of frames) for (let k = 0; k < B; k++) mu[k] += mag[i * B + k] / frames.length;
  for (const i of frames) for (let k = 0; k < B; k++) { const d = mag[i * B + k] - mu[k]; sd[k] += d * d / frames.length; }
  for (let k = 0; k < B; k++) sd[k] = Math.sqrt(sd[k]);
  const raw = new Float32Array(T * B);
  for (let i = 0; i < T; i++) for (let k = 0; k < B; k++) {
    const thr = mu[k] + opts.sensitivity * sd[k], v = mag[i * B + k];
    // a soft knee of ±3 dB around the threshold
    const r = v / (thr + 1e-12);
    raw[i * B + k] = r <= 0.7 ? 0 : r >= 1.4 ? 1 : (r - 0.7) / 0.7;
  }
  const sm = new Float32Array(T * B);
  for (let i = 0; i < T; i++) for (let k = 0; k < B; k++) {
    let s = 0, n = 0;
    for (let a = -2; a <= 2; a++) { const ii = i + a; if (ii < 0 || ii >= T) continue; for (let b = -2; b <= 2; b++) { const kk = k + b; if (kk < 0 || kk >= B) continue; s += raw[ii * B + kk]; n++; } }
    sm[i * B + k] = s / n;
  }
  const floor = Math.pow(10, -Math.abs(opts.reductionDb) / 20);
  const kept = new Float32Array(T * B), removed = new Float32Array(T * B);
  for (let q = 0; q < kept.length; q++) { const g = floor + (1 - floor) * sm[q]; kept[q] = g; removed[q] = 1 - g; }
  return [kept, removed];
}

/* --- drawn masks --------------------------------------------------------------- */

/** A brush stroke on the spectrogram: points in (seconds, hertz), radius as a
    fraction of the plot height, ar = the plot's width/height when drawn. */
export type Stroke = { erase: boolean; r: number; ar: number; pts: [number, number][] };

/** The display's frequency axis (draw.spectrogram with logFreq): hertz ↔ 0 (top) … 1 (bottom). */
export function freqAxis(sampleRate: number, size: number) {
  const bins = size / 2 + 1, hzPerBin = (sampleRate / 2) / (bins - 1);
  const minRow = Math.max(1, Math.round(30 / hzPerBin)), lo = Math.log(minRow), hi = Math.log(bins);
  return {
    toY: (hz: number) => 1 - (Math.log(Math.max(minRow, hz / hzPerBin)) - lo) / (hi - lo),
    toHz: (y: number) => Math.exp(lo + (1 - y) * (hi - lo)) * hzPerBin,
  };
}

/** Paint the strokes, as alpha, into a w × h canvas spanning [t0, t1] seconds. */
export function rasterStrokes(strokes: Stroke[], w: number, h: number, t0: number, t1: number,
  axis: { toY: (hz: number) => number }, opts: { color?: string; feather?: number } = {}): HTMLCanvasElement {
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(w)); cv.height = Math.max(1, Math.round(h));
  const ctx = cv.getContext('2d')!;
  const span = Math.max(1e-6, t1 - t0);
  if (opts.feather) ctx.filter = 'blur(' + opts.feather + 'px)';
  for (const s of strokes) {
    ctx.save();
    ctx.globalCompositeOperation = s.erase ? 'destination-out' : 'source-over';
    // units: x in [0, ar·(…)], y in [0, 1]; the brush is round on the screen it was drawn on
    ctx.scale(w / s.ar, h);
    ctx.strokeStyle = ctx.fillStyle = opts.color || '#000';
    ctx.lineWidth = 2 * s.r; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const P = s.pts.map(([t, hz]) => [((t - t0) / span) * s.ar, axis.toY(hz)]);
    ctx.beginPath();
    if (P.length === 1) { ctx.arc(P[0][0], P[0][1], s.r, 0, 2 * Math.PI); ctx.fill(); }
    else { ctx.moveTo(P[0][0], P[0][1]); for (let i = 1; i < P.length; i++) ctx.lineTo(P[i][0], P[i][1]); ctx.stroke(); }
    ctx.restore();
  }
  return cv;
}

/** The strokes as a mask on the STFT grid of a region starting at `t0` seconds. */
export function drawnMask(S: Stft, strokes: Stroke[], t0: number, keep: boolean): Float32Array[] {
  const { nFrames: T, bins: B, hop, sampleRate: sr, size } = S;
  const dur = S.length / sr, MW = Math.min(2048, Math.max(64, T)), MH = 512;
  const axis = freqAxis(sr, size);
  const cv = rasterStrokes(strokes, MW, MH, t0, t0 + dur, axis, { feather: 1.5 });
  const a = cv.getContext('2d')!.getImageData(0, 0, MW, MH).data;
  const hzPerBin = (sr / 2) / (B - 1);
  const rowOf = new Int32Array(B);
  for (let k = 0; k < B; k++) rowOf[k] = Math.max(0, Math.min(MH - 1, Math.floor(axis.toY(Math.max(1, k) * hzPerBin) * MH)));
  const m = new Float32Array(T * B), inv = new Float32Array(T * B);
  for (let i = 0; i < T; i++) {
    const t = (i * hop) / sr, x = Math.max(0, Math.min(MW - 1, Math.floor(t / dur * MW)));
    for (let k = 0; k < B; k++) {
      const v = a[(rowOf[k] * MW + x) * 4 + 3] / 255;
      m[i * B + k] = keep ? v : 1 - v; inv[i * B + k] = keep ? 1 - v : v;
    }
  }
  return [m, inv];
}
