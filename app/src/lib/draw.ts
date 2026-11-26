/* Canvas drawing. A port of Atelier.draw. Colours come from CSS custom
   properties at draw time, so a theme change only needs a redraw. The legacy
   names (--accent, --line, --ink-soft…) are mapped onto the suite tokens in
   styles/tokens.css. */

import { extent, envelope, Spectrogram, Matrix } from './dsp';
import { fmt } from './fmt';

export type Geom = { padL: number; padT: number; plotW: number; plotH: number };
const geoms = new WeakMap<HTMLCanvasElement, Geom>();
export const geomOf = (c: HTMLCanvasElement): Geom =>
  geoms.get(c) || { padL: 0, padT: 0, plotW: c.clientWidth || 1, plotH: c.clientHeight || 1 };
export const setGeom = (c: HTMLCanvasElement, g: Geom) => { geoms.set(c, g); };

export function css(name: string): string {
  return getComputedStyle(document.body).getPropertyValue(name).trim() || '#888';
}
export const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
/** Left padding of curves and heat maps: room for the y labels. */
export const padLeft = () => 3.6 * remPx();

export function fit(canvas: HTMLCanvasElement, cssHeight?: number) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 800;
  // a "fill" canvas takes the height its pane gives it; others get the height asked for
  const fill = canvas.dataset.fill === '1';
  const h = fill ? Math.max(40, canvas.clientHeight || cssHeight || 130) : (cssHeight || 130);
  if (!fill) canvas.style.height = h + 'px';
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w, h };
}

export function clear(canvas: HTMLCanvasElement, h = 60) {
  const f = fit(canvas, h); f.ctx.clearRect(0, 0, f.w, f.h);
  geoms.delete(canvas);
}

export function waveform(canvas: HTMLCanvasElement, signal: Float32Array, opts: { height?: number; color?: string; label?: string } = {}) {
  const { ctx, w, h } = fit(canvas, opts.height || 130), mid = h / 2;
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
  setGeom(canvas, { padL: 0, padT: 0, plotW: w, plotH: h });
  const env = envelope(signal, Math.max(1, Math.floor(w)));
  ctx.strokeStyle = opts.color || css('--accent');
  ctx.beginPath();
  for (let c = 0; c < env.mins.length; c++) {
    ctx.moveTo(c + 0.5, mid - env.maxs[c] * mid * 0.94);
    ctx.lineTo(c + 0.5, mid - env.mins[c] * mid * 0.94);
  }
  ctx.stroke();
  if (opts.label) canvas.setAttribute('aria-label', opts.label);
}

/** One descriptor curve against time. Series longer than the canvas are drawn
    as a per-pixel min/max band, so 300 000 points draw in one pass. */
export function curve(canvas: HTMLCanvasElement, times: ArrayLike<number>, values: ArrayLike<number>,
  opts: { height?: number; min?: number; max?: number; tMax?: number; label?: string; unit?: string; color?: string } = {}) {
  const { ctx, w, h } = fit(canvas, opts.height || 130);
  const padL = padLeft(), padB = 18, padT = 10;
  ctx.clearRect(0, 0, w, h);
  const ext = extent(values);
  if (!ext) return;
  const lo = opts.min !== undefined ? opts.min : ext.min;
  let hi = opts.max !== undefined ? opts.max : ext.max;
  if (hi - lo < 1e-12) hi = lo + 1;
  const plotW = Math.max(10, w - padL - 8), plotH = Math.max(10, h - padT - padB);
  const n = values.length;
  const tMax = opts.tMax || (n ? times[n - 1] : 1);

  ctx.strokeStyle = css('--line-firm');
  ctx.fillStyle = css('--ink-soft');
  ctx.font = '11px ' + css('--mono');
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padL, padT); ctx.lineTo(padL, padT + plotH); ctx.lineTo(padL + plotW, padT + plotH);
  ctx.stroke();
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  ctx.fillText(fmt(hi), padL - 6, padT + 5);
  ctx.fillText(fmt(lo), padL - 6, padT + plotH - 5);
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText('0 s', padL, h - 4);
  ctx.textAlign = 'right';
  ctx.fillText(tMax.toFixed(1) + ' s', padL + plotW, h - 4);
  if (opts.label) {
    ctx.textAlign = 'left';
    ctx.fillStyle = css('--ink');
    ctx.font = '12px ' + css('--sans');
    ctx.fillText(opts.label + (opts.unit ? ' (' + opts.unit + ')' : ''), padL + 6, padT + 11);
  }
  setGeom(canvas, { padL, padT, plotW, plotH });

  const y = (v: number) => padT + plotH - ((v - lo) / (hi - lo)) * plotH;
  ctx.strokeStyle = opts.color || css('--accent');
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  if (n > plotW * 1.5) {
    const cols = Math.floor(plotW), per = n / cols;
    for (let c = 0; c < cols; c++) {
      const s = Math.floor(c * per);
      let e = Math.min(Math.floor((c + 1) * per), n);
      if (e <= s) e = Math.min(s + 1, n);
      let mn = Infinity, mx = -Infinity;
      for (let i = s; i < e; i++) {
        const v = values[i];
        if (typeof v !== 'number' || !isFinite(v)) continue;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      if (!isFinite(mn)) continue;
      const xp = padL + c + 0.5;
      ctx.moveTo(xp, y(mx));
      ctx.lineTo(xp, y(mn) + 0.6);
    }
  } else {
    let started = false;
    for (let j = 0; j < n; j++) {
      const val = values[j];
      if (typeof val !== 'number' || !isFinite(val)) { started = false; continue; }
      const xx = padL + (tMax ? times[j] / tMax : 0) * plotW;
      if (!started) { ctx.moveTo(xx, y(val)); started = true; } else ctx.lineTo(xx, y(val));
    }
  }
  ctx.stroke();
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', (opts.label || '') + ' — ' + fmt(lo) + ' … ' + fmt(hi) + (opts.unit ? ' ' + opts.unit : ''));
}

/** Sequential colour map, monotone in lightness: white → blue → black in the
    light theme, black → violet → orange → white in the dark one. */
export function colormap(dark: boolean): Uint8ClampedArray {
  const stops = dark
    ? [[0, 0, 0], [40, 10, 70], [110, 30, 120], [190, 60, 90], [240, 130, 40], [252, 220, 90], [255, 255, 240]]
    : [[255, 255, 255], [220, 230, 245], [150, 180, 225], [80, 120, 190], [30, 60, 130], [10, 20, 60], [0, 0, 0]];
  const lut = new Uint8ClampedArray(256 * 3);
  for (let i = 0; i < 256; i++) {
    const x = i / 255 * (stops.length - 1), k = Math.min(stops.length - 2, Math.floor(x)), f = x - k;
    for (let c = 0; c < 3; c++) lut[i * 3 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c]) * f;
  }
  return lut;
}

export function isDark(): boolean {
  // the browser may shorten #000000 to #000: let a canvas normalise any colour to #rrggbb
  const probe = document.createElement('canvas').getContext('2d')!;
  probe.fillStyle = '#ffffff';
  probe.fillStyle = css('--bg');
  const v = String(probe.fillStyle);
  if (/^#[0-9a-f]{6}$/i.test(v)) {
    return (parseInt(v.substr(1, 2), 16) * 0.299 + parseInt(v.substr(3, 2), 16) * 0.587 + parseInt(v.substr(5, 2), 16) * 0.114) < 128;
  }
  const rgb = v.replace(/[^\d,.]/g, '').split(',');
  return rgb.length >= 3 && (+rgb[0] * 0.299 + +rgb[1] * 0.587 + +rgb[2] * 0.114) < 128;
}

export type HeatOpts = {
  height?: number; padL?: number; padB?: number; padT?: number; scale?: 'linear' | 'db'; min?: number; max?: number;
  dbRange?: number; maxRows?: number; logFreq?: boolean; minRow?: number; smooth?: boolean;
  yLabels?: { row: number; text: string }[]; x0?: string; x1?: string; label?: string;
  cursor?: number; marks?: number[]; markColor?: string;
};

/** A matrix {rows, cols, data (row-major)} as a heat map, row 0 at the bottom. */
export function heat(canvas: HTMLCanvasElement, matrix: Matrix, opts: HeatOpts = {}): Geom | undefined {
  const { ctx, w, h } = fit(canvas, opts.height || 160);
  const padL = opts.padL !== undefined ? opts.padL : padLeft();
  const padB = opts.padB !== undefined ? opts.padB : 18, padT = opts.padT !== undefined ? opts.padT : 6;
  const plotW = Math.max(10, Math.floor(w - padL - 8)), plotH = Math.max(10, Math.floor(h - padT - padB));
  ctx.clearRect(0, 0, w, h);
  const { rows, cols, data } = matrix;
  if (!rows || !cols) return;
  const dark = isDark();
  const lut = colormap(dark);
  const db = opts.scale === 'db';
  let lo = opts.min, hi = opts.max;
  if (lo === undefined || hi === undefined) {
    const ext = extent(data);
    if (!ext) return;
    if (db) { hi = 20 * Math.log10(ext.max || 1e-9); lo = hi - (opts.dbRange || 80); }
    else { lo = lo === undefined ? ext.min : lo; hi = hi === undefined ? ext.max : hi; }
  }
  if (hi - lo < 1e-12) hi = lo + 1;
  const outH = Math.min(plotH, opts.maxRows || 1024), outW = Math.min(plotW, cols);
  const img = ctx.createImageData(outW, outH);
  const px = img.data;
  const logF = opts.logFreq, minRow = Math.max(1, opts.minRow || 1);
  const rowAt = (y: number) => {
    const t = 1 - y / outH;
    if (logF) return Math.exp(Math.log(minRow) + t * (Math.log(rows) - Math.log(minRow)));
    return t * rows;
  };
  for (let y = 0; y < outH; y++) {
    const r1 = rowAt(y + 1), r0 = rowAt(y);
    const ra = Math.max(0, Math.floor(r1)), rb = Math.min(rows - 1, Math.max(ra, Math.ceil(r0) - 1));
    for (let x = 0; x < outW; x++) {
      const ca = Math.floor(x * cols / outW), cb = Math.min(cols - 1, Math.max(ca, Math.floor((x + 1) * cols / outW) - 1));
      let v = -Infinity;
      for (let r = ra; r <= rb; r++) for (let c = ca; c <= cb; c++) { const d = data[r * cols + c]; if (d > v) v = d; }
      if (db) v = 20 * Math.log10(v > 1e-12 ? v : 1e-12);
      let u = (v - lo) / (hi - lo); if (!(u >= 0)) u = 0; if (u > 1) u = 1;
      const li = Math.round(u * 255) * 3, o = (y * outW + x) * 4;
      px[o] = lut[li]; px[o + 1] = lut[li + 1]; px[o + 2] = lut[li + 2]; px[o + 3] = 255;
    }
  }
  const off = document.createElement('canvas'); off.width = outW; off.height = outH;
  off.getContext('2d')!.putImageData(img, 0, 0);
  ctx.imageSmoothingEnabled = !!opts.smooth;
  ctx.drawImage(off, padL, padT, plotW, plotH);

  ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1;
  ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);
  ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
  ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
  if (opts.yLabels) {
    for (const lab of opts.yLabels) {
      const t = logF ? (Math.log(Math.max(minRow, lab.row)) - Math.log(minRow)) / (Math.log(rows) - Math.log(minRow)) : lab.row / rows;
      const yy = padT + plotH - t * plotH;
      if (yy < padT - 1 || yy > padT + plotH + 1) continue;
      ctx.fillText(lab.text, padL - 5, yy);
      ctx.beginPath(); ctx.moveTo(padL - 3, yy); ctx.lineTo(padL, yy); ctx.stroke();
    }
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
  ctx.fillText(opts.x0 || '0 s', padL, h - 4);
  ctx.textAlign = 'right';
  if (opts.x1) ctx.fillText(opts.x1, padL + plotW, h - 4);
  if (opts.label) {
    ctx.textAlign = 'left';
    ctx.font = '12px ' + css('--sans');
    const tw = ctx.measureText(opts.label).width;
    ctx.fillStyle = dark ? 'rgba(0,0,0,0.65)' : 'rgba(255,255,255,0.8)';
    ctx.fillRect(padL + 4, padT + 3, tw + 8, 16);
    ctx.fillStyle = css('--ink');
    ctx.fillText(opts.label, padL + 8, padT + 15);
  }
  if (typeof opts.cursor === 'number' && opts.cursor >= 0 && opts.cursor <= 1) {
    ctx.strokeStyle = css('--bad'); ctx.lineWidth = 1.5;
    const cx = padL + opts.cursor * plotW;
    ctx.beginPath(); ctx.moveTo(cx, padT); ctx.lineTo(cx, padT + plotH); ctx.stroke();
  }
  if (opts.marks) {
    ctx.strokeStyle = opts.markColor || css('--warn'); ctx.lineWidth = 1;
    ctx.beginPath();
    for (const m of opts.marks) { const mx = padL + m * plotW; ctx.moveTo(mx, padT); ctx.lineTo(mx, padT + plotH); }
    ctx.stroke();
  }
  canvas.setAttribute('role', 'img');
  if (opts.label) canvas.setAttribute('aria-label', opts.label);
  const g = { padL, padT, plotW, plotH };
  setGeom(canvas, g);
  return g;
}

/** A spectrogram as returned by dsp.spectrogram(). */
export function spectrogram(canvas: HTMLCanvasElement, spec: Spectrogram,
  opts: { fMax?: number; logFreq?: boolean; height?: number; dbRange?: number; label?: string; cursor?: number; marks?: number[]; smooth?: boolean } = {}) {
  const sr = spec.sampleRate, bins = spec.bins;
  const fMax = opts.fMax || sr / 2;
  const rows = Math.max(2, Math.min(bins, Math.round(bins * fMax / (sr / 2))));
  const hzPerBin = (sr / 2) / (bins - 1);
  const ticks = opts.logFreq ? [100, 200, 500, 1000, 2000, 5000, 10000, 20000] : [1000, 2000, 5000, 10000, 15000, 20000];
  const labels = ticks.filter((hz) => hz <= fMax).map((hz) => ({ row: hz / hzPerBin, text: hz >= 1000 ? (hz / 1000) + ' k' : hz + '' }));
  return heat(canvas, { rows, cols: spec.columns, data: spec.data }, {
    height: opts.height || 220, scale: 'db', dbRange: opts.dbRange || 80,
    max: 20 * Math.log10(spec.maxMag || 1e-9),
    logFreq: opts.logFreq, minRow: Math.max(1, Math.round(30 / hzPerBin)),
    yLabels: labels, label: opts.label, x1: spec.duration.toFixed(1) + ' s',
    cursor: opts.cursor, marks: opts.marks, smooth: opts.smooth,
  });
}
