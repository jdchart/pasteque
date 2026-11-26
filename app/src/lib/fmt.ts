import { getLang } from '../i18n/core';

/** A number for display: precision follows magnitude. '—' for nothing. */
export function fmt(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  if (a >= 1) return v.toFixed(2);
  if (a >= 0.001) return v.toFixed(4);
  return v.toExponential(1);
}

/** fmt() with a decimal comma in French. */
export const fmtL = (v: unknown) => { const s = fmt(v); return getLang() === 'fr' ? s.replace('.', ',') : s; };

/** Seconds as m:ss.t */
export function fmtTime(s: unknown): string {
  if (typeof s !== 'number' || !isFinite(s)) return '—';
  const m = Math.floor(s / 60), r = s - m * 60;
  return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1);
}

export const fmtInt = (n: number) => n.toLocaleString(getLang());

export function fmtBytes(n: number): string {
  const [b, k, m] = getLang() === 'fr' ? ['o', 'Ko', 'Mo'] : ['B', 'KB', 'MB'];
  if (n < 1024) return n + ' ' + b;
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + ' ' + k;
  return (n / 1024 / 1024).toFixed(1) + ' ' + m;
}
