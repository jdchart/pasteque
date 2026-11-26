/* Downloads and reading files the user picked. Never fetch(): everything
   comes from the file picker or a drop. */

import { tr } from '../i18n/core';

export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function csvCell(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** A CSV streamed row by row: no second copy of a 300 000-row table. */
export function csvRows(header: string[], nRows: number, getRow: (i: number) => unknown[], filename: string) {
  const parts = ['﻿' + header.map(csvCell).join(',') + '\n'];
  let chunk: string[] = [];
  for (let i = 0; i < nRows; i++) {
    chunk.push(getRow(i).map(csvCell).join(','));
    if (chunk.length >= 2000) { parts.push(chunk.join('\n') + '\n'); chunk = []; }
  }
  if (chunk.length) parts.push(chunk.join('\n') + '\n');
  saveBlob(new Blob(parts, { type: 'text/csv;charset=utf-8' }), filename);
}

export function png(canvas: HTMLCanvasElement, filename: string) {
  canvas.toBlob((blob) => { if (blob) saveBlob(blob, filename); });
}

/** 16-bit PCM WAV from one or more channels. */
export function wavBlob(channels: Float32Array | Float32Array[], sampleRate: number): Blob {
  const chs = Array.isArray(channels) ? channels : [channels];
  const nCh = chs.length, n = chs[0].length;
  const buf = new ArrayBuffer(44 + n * nCh * 2), v = new DataView(buf);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * nCh * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, nCh, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * nCh * 2, true);
  v.setUint16(32, nCh * 2, true); v.setUint16(34, 16, true);
  str(36, 'data'); v.setUint32(40, n * nCh * 2, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < nCh; c++) {
    let s = chs[c][i]; s = s > 1 ? 1 : s < -1 ? -1 : s;
    v.setInt16(o, s < 0 ? s * 32768 : s * 32767, true); o += 2;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

export const saveWav = (channels: Float32Array | Float32Array[], sr: number, filename: string) => saveBlob(wavBlob(channels, sr), filename);
export const saveText = (text: string, filename: string, mime = 'text/plain') =>
  saveBlob(new Blob(['﻿' + text], { type: mime + ';charset=utf-8' }), filename);
export const saveJSON = (text: string, filename: string) => saveBlob(new Blob([text], { type: 'application/json' }), filename);

export function readText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(tr('err.read')));
    r.onload = () => resolve(r.result as string);
    r.readAsText(file);
  });
}

/** Open the browser's file picker without a visible input. */
export function pickFiles(accept: string, multiple = false): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept; input.multiple = multiple;
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve(input.files ? Array.from(input.files) : []); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}

export function slug(s: string, max = 60): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, max);
}

/* base64 for embedding sound files in a session */
export function bytesToBase64(bytes: ArrayBuffer): string {
  const u = new Uint8Array(bytes); let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u.length; i += CH) s += String.fromCharCode.apply(null, Array.from(u.subarray(i, i + CH)));
  return btoa(s);
}
export function base64ToBytes(b64: string): ArrayBuffer {
  const s = atob(b64), u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u.buffer;
}
