/* Dimensionality reduction to two axes, for the sound map. Exact, O(n²)
   algorithms: right for a corpus of a few hundred to a couple of thousand
   segments, and readable. Every long loop yields to the browser.

     classical MDS (Torgerson), metric MDS (SMACOF), Isomap, UMAP.
   PCA and t-SNE are in dsp.ts. All take standardised vectors and a distance. */

import { Progress, standardise } from './dsp';

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

export type Distance = 'euclidean' | 'cosine' | 'manhattan';

/** Pairwise distances of standardised vectors, n × n. */
export async function distances(vectors: number[][], metric: Distance): Promise<{ n: number; D: Float64Array }> {
  const X = standardise(vectors), n = X.length, d = n ? X[0].length : 0;
  const D = new Float64Array(n * n);
  const norm = new Float64Array(n);
  if (metric === 'cosine') for (let i = 0; i < n; i++) { let s = 0; for (let k = 0; k < d; k++) s += X[i][k] * X[i][k]; norm[i] = Math.sqrt(s) || 1; }
  for (let i = 0; i < n; i++) {
    const a = X[i];
    for (let j = i + 1; j < n; j++) {
      const b = X[j]; let s = 0;
      if (metric === 'manhattan') for (let k = 0; k < d; k++) s += Math.abs(a[k] - b[k]);
      else if (metric === 'cosine') { for (let k = 0; k < d; k++) s += a[k] * b[k]; s = Math.max(0, 1 - s / (norm[i] * norm[j])); }
      else { for (let k = 0; k < d; k++) { const t = a[k] - b[k]; s += t * t; } s = Math.sqrt(s); }
      D[i * n + j] = D[j * n + i] = s;
    }
    if (i % 200 === 199) await tick();
  }
  return { n, D };
}

/** Seeded uniform random numbers in [0, 1). */
export function rng(seed: number) {
  let s = (Math.abs(Math.floor(seed)) % 2147483646) + 1;
  return () => { s = (s * 16807) % 2147483647; return (s - 1) / 2147483646; };
}

/* --- classical MDS ----------------------------------------------------------- */

/** Torgerson: double-centre −½D², keep the two leading eigenvectors (power
    iteration with deflation), scaled by √λ. With Euclidean distances this is PCA. */
export async function classicalMds(n: number, D: Float64Array, onProgress?: Progress): Promise<number[][]> {
  if (n < 3) return Array.from({ length: n }, () => [0, 0]);
  const B = new Float64Array(n * n), rowMean = new Float64Array(n);
  let all = 0;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) { const v = -0.5 * D[i * n + j] * D[i * n + j]; B[i * n + j] = v; rowMean[i] += v / n; }
  for (let i = 0; i < n; i++) all += rowMean[i] / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) B[i * n + j] += all - rowMean[i] - rowMean[j];
  const out = Array.from({ length: n }, () => [0, 0]);
  const vecs: Float64Array[] = [];
  const rnd = rng(7);
  for (let c = 0; c < 2; c++) {
    let v = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = rnd() - 0.5;
    let lambda = 0;
    for (let it = 0; it < 300; it++) {
      const w = new Float64Array(n);
      for (let i = 0; i < n; i++) { let s = 0; const r = i * n; for (let j = 0; j < n; j++) s += B[r + j] * v[j]; w[i] = s; }
      for (const u of vecs) { let dot = 0; for (let i = 0; i < n; i++) dot += w[i] * u[i]; for (let i = 0; i < n; i++) w[i] -= dot * u[i]; }
      let norm = 0; for (let i = 0; i < n; i++) norm += w[i] * w[i];
      norm = Math.sqrt(norm) || 1;
      let delta = 0; for (let i = 0; i < n; i++) { const x = w[i] / norm; delta += Math.abs(x - v[i]); v[i] = x; }
      lambda = norm;
      if (it % 10 === 9) { onProgress?.((c + it / 300) / 2); await tick(); }
      if (delta < 1e-9 * n) break;
    }
    vecs.push(v);
    const sc = Math.sqrt(Math.max(0, lambda));
    for (let i = 0; i < n; i++) out[i][c] = v[i] * sc;
  }
  return out;
}

/* --- metric MDS (SMACOF) ----------------------------------------------------- */

/** Minimises the stress Σ (‖yᵢ − yⱼ‖ − dᵢⱼ)² by Guttman transforms, starting from
    classical MDS. Returns the layout and the normalised stress (0 = perfect). */
export async function smacof(n: number, D: Float64Array, opts: { iterations?: number; onProgress?: Progress } = {}): Promise<{ Y: number[][]; stress: number }> {
  let Y = await classicalMds(n, D, (p) => opts.onProgress?.(p * 0.2));
  if (n < 3) return { Y, stress: 0 };
  const iters = opts.iterations || 200;
  let sumD2 = 0; for (let k = 0; k < n * n; k++) sumD2 += D[k] * D[k];
  let stress = Infinity;
  for (let it = 0; it < iters; it++) {
    const Z = Array.from({ length: n }, () => [0, 0]);
    let s = 0;
    for (let i = 0; i < n; i++) {
      let bii = 0, zx = 0, zy = 0;
      for (let j = 0; j < n; j++) {
        if (i === j) continue;
        const dx = Y[i][0] - Y[j][0], dy = Y[i][1] - Y[j][1], dij = Math.sqrt(dx * dx + dy * dy);
        const delta = D[i * n + j];
        if (j > i) s += (dij - delta) * (dij - delta);
        const b = dij > 1e-12 ? -delta / dij : 0;
        bii -= b; zx += b * Y[j][0]; zy += b * Y[j][1];
      }
      Z[i][0] = (bii * Y[i][0] + zx) / n; Z[i][1] = (bii * Y[i][1] + zy) / n;
    }
    const ns = Math.sqrt(2 * s / (sumD2 || 1));
    Y = Z;
    if (Math.abs(stress - ns) < 1e-6) { stress = ns; break; }
    stress = ns;
    if (it % 5 === 4) { opts.onProgress?.(0.2 + 0.8 * it / iters); await tick(); }
  }
  return { Y, stress };
}

/* --- Isomap ------------------------------------------------------------------ */

/** Geodesic distances along the k-nearest-neighbour graph, then classical MDS.
    Unconnected pieces of the graph are pushed apart at 1.2 × the largest
    geodesic distance; `components` says how many there were. */
export async function isomap(n: number, D: Float64Array, opts: { k?: number; onProgress?: Progress } = {}): Promise<{ Y: number[][]; components: number }> {
  const k = Math.max(2, Math.min(n - 1, opts.k || 8));
  const adj: { j: number; w: number }[][] = Array.from({ length: n }, () => []);
  const has = new Set<number>();
  for (let i = 0; i < n; i++) {
    const order = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i).sort((a, b) => D[i * n + a] - D[i * n + b]).slice(0, k);
    for (const j of order) {
      const a = Math.min(i, j), b = Math.max(i, j);
      if (has.has(a * n + b)) continue;
      has.add(a * n + b);
      adj[a].push({ j: b, w: D[i * n + j] }); adj[b].push({ j: a, w: D[i * n + j] });
    }
  }
  const G = new Float64Array(n * n).fill(Infinity);
  const comp = new Int32Array(n).fill(-1);
  let components = 0;
  for (let s = 0; s < n; s++) {
    // Dijkstra with a binary heap
    const dist = G.subarray(s * n, (s + 1) * n);
    dist[s] = 0;
    const heap: [number, number][] = [[0, s]];
    const push = (e: [number, number]) => { heap.push(e); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last; let i = 0;
        for (;;) { const l = 2 * i + 1, r = l + 1; let m = i; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === i) break; [heap[m], heap[i]] = [heap[i], heap[m]]; i = m; }
      }
      return top;
    };
    while (heap.length) {
      const [d0, u] = pop();
      if (d0 > dist[u]) continue;
      for (const { j, w } of adj[u]) { const nd = d0 + w; if (nd < dist[j]) { dist[j] = nd; push([nd, j]); } }
    }
    if (comp[s] < 0) { for (let j = 0; j < n; j++) if (isFinite(dist[j])) comp[j] = components; components++; }
    if (s % 50 === 49) { opts.onProgress?.(0.6 * s / n); await tick(); }
  }
  let maxG = 0;
  for (let q = 0; q < G.length; q++) if (isFinite(G[q]) && G[q] > maxG) maxG = G[q];
  for (let q = 0; q < G.length; q++) if (!isFinite(G[q])) G[q] = 1.2 * maxG;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const v = 0.5 * (G[i * n + j] + G[j * n + i]); G[i * n + j] = G[j * n + i] = v; }
  const Y = await classicalMds(n, G, (p) => opts.onProgress?.(0.6 + 0.4 * p));
  return { Y, components };
}

/* --- UMAP -------------------------------------------------------------------- */

/** Fit 1 / (1 + a·x^(2b)) to the target curve that min_dist describes (spread 1). */
function fitAB(minDist: number): [number, number] {
  const xs: number[] = [], ys: number[] = [];
  for (let i = 0; i < 300; i++) { const x = 3 * (i + 0.5) / 300; xs.push(x); ys.push(x < minDist ? 1 : Math.exp(-(x - minDist))); }
  const err = (a: number, b: number) => { let e = 0; for (let i = 0; i < xs.length; i++) { const r = 1 / (1 + a * Math.pow(xs[i], 2 * b)) - ys[i]; e += r * r; } return e; };
  let best: [number, number] = [1.6, 0.9], be = err(1.6, 0.9);
  let la = Math.log(best[0]), b0 = best[1], spanA = 3, spanB = 1;
  for (let round = 0; round < 5; round++) {
    for (let i = 0; i <= 24; i++) for (let j = 0; j <= 24; j++) {
      const a = Math.exp(la + spanA * (i / 12 - 1)), b = Math.max(0.05, b0 + spanB * (j / 12 - 1));
      const e = err(a, b); if (e < be) { be = e; best = [a, b]; }
    }
    la = Math.log(best[0]); b0 = best[1]; spanA /= 4; spanB /= 4;
  }
  return best;
}

/** UMAP with exact nearest neighbours, a PCA-like start (classical MDS) and the
    reference SGD with negative sampling. */
export async function umap(n: number, D: Float64Array, opts: { neighbours?: number; minDist?: number; epochs?: number; seed?: number; onProgress?: Progress } = {}): Promise<number[][]> {
  if (n < 4) return Array.from({ length: n }, (_, i) => [i, 0]);
  const k = Math.max(2, Math.min(n - 1, opts.neighbours || 15));
  const rnd = rng(opts.seed || 1);
  // fuzzy simplicial set: per point, rho = nearest distance, sigma so the weights sum to log2(k)
  const W = new Map<number, number>();
  const target = Math.log2(k);
  for (let i = 0; i < n; i++) {
    const nn = Array.from({ length: n }, (_, j) => j).filter((j) => j !== i).sort((a, b) => D[i * n + a] - D[i * n + b]).slice(0, k);
    const ds = nn.map((j) => D[i * n + j]);
    const rho = ds.find((d) => d > 0) ?? 0;
    let lo = 0, hi = Infinity, sigma = 1;
    for (let it = 0; it < 64; it++) {
      let s = 0; for (const d of ds) s += Math.exp(-Math.max(0, d - rho) / sigma);
      if (Math.abs(s - target) < 1e-5) break;
      if (s > target) { hi = sigma; sigma = (lo + hi) / 2; } else { lo = sigma; sigma = isFinite(hi) ? (lo + hi) / 2 : sigma * 2; }
    }
    nn.forEach((j, q) => W.set(i * n + j, Math.exp(-Math.max(0, ds[q] - rho) / sigma)));
  }
  // symmetrise: w + wᵀ − w·wᵀ
  const heads: number[] = [], tails: number[] = [], weights: number[] = [];
  const seen = new Set<number>();
  W.forEach((w, key) => {
    const i = Math.floor(key / n), j = key % n, a = Math.min(i, j), b = Math.max(i, j);
    if (seen.has(a * n + b)) return; seen.add(a * n + b);
    const w1 = W.get(a * n + b) || 0, w2 = W.get(b * n + a) || 0, v = w1 + w2 - w1 * w2;
    heads.push(a, b); tails.push(b, a); weights.push(v, v);
  });
  const epochs = opts.epochs || (n > 2000 ? 200 : 500);
  let wMax = 0; for (const w of weights) if (w > wMax) wMax = w;
  const E = heads.length;
  const eps = new Float64Array(E), next = new Float64Array(E), epsNeg = new Float64Array(E), nextNeg = new Float64Array(E);
  const NEG = 5;
  for (let e = 0; e < E; e++) {
    eps[e] = weights[e] > wMax / epochs ? wMax / weights[e] : -1;
    next[e] = eps[e]; epsNeg[e] = eps[e] / NEG; nextNeg[e] = epsNeg[e];
  }
  const [a, b] = fitAB(Math.max(0, Math.min(0.99, opts.minDist ?? 0.1)));
  // start: classical MDS rescaled to [0, 10], plus a little noise
  const init = await classicalMds(n, D);
  const Y = init.map((p) => [p[0], p[1]]);
  for (let c = 0; c < 2; c++) {
    let lo = Infinity, hi = -Infinity; for (const p of Y) { lo = Math.min(lo, p[c]); hi = Math.max(hi, p[c]); }
    for (const p of Y) p[c] = (hi > lo ? 10 * (p[c] - lo) / (hi - lo) : 5) + (rnd() - 0.5) * 1e-2;
  }
  const clip = (v: number) => (v > 4 ? 4 : v < -4 ? -4 : v);
  for (let ep = 0; ep < epochs; ep++) {
    const alpha = 1 - ep / epochs;
    for (let e = 0; e < E; e++) {
      if (eps[e] < 0 || next[e] > ep) continue;
      const yi = Y[heads[e]], yj = Y[tails[e]];
      let dx = yi[0] - yj[0], dy = yi[1] - yj[1], d2 = dx * dx + dy * dy;
      if (d2 > 0) {
        const g = (-2 * a * b * Math.pow(d2, b - 1)) / (a * Math.pow(d2, b) + 1);
        const gx = clip(g * dx) * alpha, gy = clip(g * dy) * alpha;
        yi[0] += gx; yi[1] += gy; yj[0] -= gx; yj[1] -= gy;
      }
      next[e] += eps[e];
      const nNeg = Math.floor((ep - nextNeg[e]) / epsNeg[e]);
      for (let q = 0; q < nNeg; q++) {
        const kk = Math.floor(rnd() * n);
        if (kk === heads[e]) continue;
        const yk = Y[kk];
        dx = yi[0] - yk[0]; dy = yi[1] - yk[1]; d2 = dx * dx + dy * dy;
        let gx = 4, gy = 4;
        if (d2 > 0) { const g = (2 * b) / ((0.001 + d2) * (a * Math.pow(d2, b) + 1)); gx = clip(g * dx); gy = clip(g * dy); }
        yi[0] += gx * alpha; yi[1] += gy * alpha;
      }
      nextNeg[e] += nNeg * epsNeg[e];
    }
    if (ep % 10 === 9) { opts.onProgress?.(ep / epochs); await tick(); }
  }
  return Y;
}
