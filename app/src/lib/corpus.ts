/* A corpus: many files, many segments, each summarised by descriptor
   statistics. The batch description, the sound map and the segmentation tool
   share these formats (and the legacy pages' corpus.json / segments.csv). */

import { tr } from '../i18n/core';
import { describe, meanStd, Progress } from './dsp';

export const FEATURES = ['rms', 'spectralCentroid', 'spectralFlatness', 'spectralSpread',
  'spectralRolloff', 'zcr', 'pitch', 'mfcc'];

export type SegRow = { id: number; file: string; start: number; end: number; label: string; [col: string]: number | string };

/** Mean and standard deviation of each scalar series over one segment, plus
    the mean MFCC vector and the voiced share. */
export async function describeSegment(signal: Float32Array, sampleRate: number, start: number, end: number,
  features: string[], opts: { frameSize?: number; hopSize?: number; onProgress?: Progress } = {}): Promise<Record<string, number>> {
  const size = opts.frameSize || 1024, hop = opts.hopSize || 512;
  const a = Math.max(0, Math.floor(start * sampleRate));
  const b = Math.min(signal.length, Math.floor(end * sampleRate));
  let slice = signal.subarray(a, b);
  if (slice.length < size) { const padded = new Float32Array(size); padded.set(slice); slice = padded; }
  const res = await describe(slice, sampleRate, features, { frameSize: size, hopSize: hop, onProgress: opts.onProgress });
  const row: Record<string, number> = { duration: (b - a) / sampleRate };
  for (const f of Object.keys(res.features)) {
    const ms = meanStd(res.features[f]);
    row[f + '_mean'] = ms.mean;
    row[f + '_std'] = ms.std;
    if (f === 'pitch') row.voiced = res.nFrames ? ms.n / res.nFrames : 0;
  }
  const m = res.matrices.mfcc;
  if (m) for (let r = 0; r < m.rows; r++) row['mfcc_' + r] = meanStd(m.data.subarray(r * m.cols, (r + 1) * m.cols)).mean;
  return row;
}

/** Column order for tables and CSV. */
export function columns(features: string[]): string[] {
  const cols = ['duration'];
  for (const f of features) {
    if (f === 'mfcc') { for (let r = 0; r < 13; r++) cols.push('mfcc_' + r); }
    else { cols.push(f + '_mean'); cols.push(f + '_std'); if (f === 'pitch') cols.push('voiced'); }
  }
  return cols;
}

export type CorpusFile = { format: 'atelier-corpus'; version: number; created?: string; meta?: unknown;
  features: string[]; columns: string[]; segments: SegRow[] };

export function toJSON(segments: SegRow[], features: string[], meta: unknown): string {
  const cols = columns(features);
  return JSON.stringify({
    format: 'atelier-corpus', version: 1, created: new Date().toISOString(), meta: meta || {},
    features, columns: cols,
    segments: segments.map((s) => {
      const o: Record<string, unknown> = { id: s.id, file: s.file, start: s.start, end: s.end, label: s.label || '' };
      cols.forEach((c) => { o[c] = s[c]; });
      return o;
    }),
  }, null, 1);
}

export function fromJSON(text: string): CorpusFile {
  const o = JSON.parse(text);
  if (!o || o.format !== 'atelier-corpus' || !Array.isArray(o.segments)) throw new Error(tr('err.corpusFormat'));
  return o as CorpusFile;
}

export type CsvSeg = { file: string; start: number; end: number; label: string };

/** Parse a segments CSV (file,start,end[,label]); separator , or ; */
export function parseSegmentsCSV(text: string): CsvSeg[] {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const sep = lines[0].indexOf(';') >= 0 && lines[0].indexOf(',') < 0 ? ';' : ',';
  const cells = (line: string) => {
    const out: string[] = []; let cur = '', q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
        else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === sep) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const head = cells(lines[0]).map((h) => h.trim().toLowerCase());
  const fi = head.indexOf('file'), si = head.indexOf('start'), ei = head.indexOf('end'), li = head.indexOf('label');
  if (fi < 0 || si < 0 || ei < 0) throw new Error(tr('err.segmentsCsv'));
  const segs: CsvSeg[] = [];
  for (let r = 1; r < lines.length; r++) {
    const c = cells(lines[r]);
    const st = parseFloat(c[si]), en = parseFloat(c[ei]);
    if (!isFinite(st) || !isFinite(en)) continue;
    segs.push({ file: c[fi].trim(), start: st, end: en, label: li >= 0 ? (c[li] || '') : '' });
  }
  return segs;
}
