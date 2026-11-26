/* The session's corpora. A corpus is a named list of entries — a piece of a
   session sound (start, end), with a label — plus, once described, the
   descriptor statistics of each entry. It is what the corpus tools share:
   segmentation adds to it, the corpus tool edits, merges and imports it,
   batch description describes it (in place), the sound map projects it.

   Corpora live in the store (state.corpora) and travel in the session file.
   Entries point at their sound by id, and by file name as a fallback, so a
   corpus.json imported before (or without) its audio finds it once loaded. */

import { useMemo } from 'react';
import { tr } from '../i18n/core';
import { columns as columnsFor } from '../lib/corpus';
import { getSound } from './sounds';
import { AppState, getState, newId, setState, useApp } from './store';

export type EntryOrigin = 'segmentation' | 'manual' | 'sound' | 'import' | 'copy';
export type CorpusEntry = {
  id: string; soundId: string; file: string; start: number; end: number; label: string;
  origin?: EntryOrigin;
  /** descriptor statistics, present once described (keys = corpus.desc.columns) */
  values?: Record<string, number>;
};
export type CorpusDesc = { features: string[]; columns: string[] };
export type Corpus = { id: string; name: string; created: string; entries: CorpusEntry[]; desc: CorpusDesc | null };

/* --- reading ------------------------------------------------------------- */

export const useCorpora = () => useApp((s) => s.corpora);
export const getCorpora = () => getState().corpora;
export const getCorpus = (id: string | null | undefined) => (id ? getState().corpora.find((c) => c.id === id) : undefined);
export function useCorpus(id: string | null | undefined) {
  const all = useCorpora();
  return useMemo(() => (id ? all.find((c) => c.id === id) : undefined), [all, id]);
}

/** The audio of an entry: its session sound, or a loaded session sound with its file name. */
export function entrySound(e: Pick<CorpusEntry, 'soundId' | 'file'>) {
  const s = e.soundId ? getSound(e.soundId) : null;
  if (s) return s;
  const m = getState().sounds.find((x) => x.name === e.file && getSound(x.id));
  return m ? getSound(m.id) : null;
}

export const isDescribed = (c: Corpus, e: CorpusEntry) => !!(c.desc && e.values);
export const undescribed = (c: Corpus) => c.entries.filter((e) => !isDescribed(c, e));

/** "Corpus 3": the first free default name. */
export function freshName(base = tr('corpus.default')) {
  const names = new Set(getState().corpora.map((c) => c.name));
  for (let n = 1; ; n++) { const x = base + ' ' + n; if (!names.has(x)) return x; }
}

/* --- writing ------------------------------------------------------------- */

const write = (f: (cs: Corpus[]) => Corpus[]) => setState((s) => ({ corpora: f(s.corpora) }), { dirty: true });
const patchCorpus = (id: string, f: (c: Corpus) => Corpus) => write((cs) => cs.map((c) => (c.id === id ? f(c) : c)));

export const newEntry = (e: Omit<CorpusEntry, 'id'>): CorpusEntry => ({ ...e, id: newId('e') });

export function createCorpus(name?: string, entries: CorpusEntry[] = [], desc: CorpusDesc | null = null): string {
  const c: Corpus = { id: newId('c'), name: name?.trim() || freshName(), created: new Date().toISOString(), entries, desc };
  write((cs) => [...cs, c]);
  return c.id;
}

export const renameCorpus = (id: string, name: string) => patchCorpus(id, (c) => ({ ...c, name: name.trim() || c.name }));
export const deleteCorpus = (id: string) => write((cs) => cs.filter((c) => c.id !== id));

const sameCols = (a: CorpusDesc | null, b: CorpusDesc | null) => !!a && !!b && a.columns.join() === b.columns.join();
const sameSpan = (a: CorpusEntry, b: CorpusEntry) =>
  (a.soundId && a.soundId === b.soundId || !a.soundId && a.file === b.file) && Math.abs(a.start - b.start) < 1e-4 && Math.abs(a.end - b.end) < 1e-4;

/** Entries coming from elsewhere keep their description only if it is in the
    same columns (a corpus not described yet takes the description they bring). */
function adopt(target: Corpus, entries: CorpusEntry[], from: CorpusDesc | null): CorpusEntry[] {
  const keep = target.desc ? sameCols(target.desc, from) : !!from;
  return entries.map((e) => {
    const { values, ...rest } = e;
    return keep && values ? { ...rest, values } : rest;
  });
}

/** Add entries (an entry already there — same sound, same span — is skipped). Returns how many were added. */
export function addEntries(id: string, entries: CorpusEntry[], opts: { from?: CorpusDesc | null; replaceSounds?: string[] } = {}): number {
  const c = getCorpus(id); if (!c) return 0;
  let base = c.entries;
  if (opts.replaceSounds?.length) base = base.filter((e) => !opts.replaceSounds!.includes(e.soundId));
  const fresh = adopt(c, entries, opts.from ?? null).filter((e) => !base.some((b) => sameSpan(b, e)));
  const desc = c.desc || (opts.from && fresh.some((e) => e.values) ? opts.from : null);
  patchCorpus(id, (x) => ({ ...x, desc, entries: [...base, ...fresh.map((e) => ({ ...e, id: newId('e') }))] }));
  return fresh.length;
}

export function removeEntries(id: string, ids: string[]) {
  const drop = new Set(ids);
  patchCorpus(id, (c) => ({ ...c, entries: c.entries.filter((e) => !drop.has(e.id)) }));
}

/** Edit an entry. A new span loses its description (it is no longer the same sound). */
export function updateEntry(id: string, entryId: string, patch: Partial<Omit<CorpusEntry, 'id'>>) {
  patchCorpus(id, (c) => ({
    ...c, entries: c.entries.map((e) => {
      if (e.id !== entryId) return e;
      const next = { ...e, ...patch };
      if ((patch.start !== undefined && patch.start !== e.start) || (patch.end !== undefined && patch.end !== e.end)) delete next.values;
      return next;
    }),
  }));
}

/** Cut an entry in two at a time inside it (both halves lose the description). */
export function splitEntry(id: string, entryId: string, at: number): boolean {
  const c = getCorpus(id), e = c?.entries.find((x) => x.id === entryId);
  if (!c || !e || at <= e.start + 0.01 || at >= e.end - 0.01) return false;
  const { values: _v, ...rest } = e; // eslint-disable-line @typescript-eslint/no-unused-vars
  patchCorpus(id, (x) => ({ ...x, entries: x.entries.flatMap((y) => (y.id === entryId
    ? [{ ...rest, end: at }, { ...rest, id: newId('e'), start: at, label: rest.label }] : [y])) }));
  return true;
}

/** Store a description: the columns, and the values of the entries described
    (others keep theirs when the columns are unchanged, lose them otherwise). */
export function setDescription(id: string, desc: CorpusDesc, values: Map<string, Record<string, number>>) {
  patchCorpus(id, (c) => {
    const same = sameCols(c.desc, desc);
    return {
      ...c, desc,
      entries: c.entries.map((e) => {
        const v = values.get(e.id);
        if (v) return { ...e, values: v };
        if (same) return e;
        const { values: _drop, ...rest } = e; // eslint-disable-line @typescript-eslint/no-unused-vars
        return rest;
      }),
    };
  });
}

export function clearDescription(id: string) {
  patchCorpus(id, (c) => ({ ...c, desc: null, entries: c.entries.map(({ values: _v, ...e }) => e) })); // eslint-disable-line @typescript-eslint/no-unused-vars
}

/** A new corpus holding the entries of several (in order). Descriptions are
    kept when the described sources all used the same columns (entries from
    undescribed ones just wait to be described). */
export function mergeCorpora(ids: string[], name: string, dedupe = true): string {
  const srcs = ids.map(getCorpus).filter(Boolean) as Corpus[];
  const described = srcs.filter((c) => c.desc && c.entries.some((e) => e.values));
  const desc = described.length && described.every((c) => sameCols(c.desc, described[0].desc)) ? described[0].desc : null;
  const out: CorpusEntry[] = [];
  for (const c of srcs) for (const e of c.entries) {
    if (dedupe && out.some((o) => sameSpan(o, e))) continue;
    const { values, ...rest } = e;
    out.push({ ...rest, id: newId('e'), ...(desc && values && sameCols(c.desc, desc) ? { values } : {}) });
  }
  return createCorpus(name, out, desc);
}

export function duplicateCorpus(id: string): string | null {
  const c = getCorpus(id); if (!c) return null;
  return createCorpus(tr('corpus.copyOf', { name: c.name }), c.entries.map((e) => ({ ...e, id: newId('e') })), c.desc);
}

/* --- files ---------------------------------------------------------------- */

/** corpus.json, in the format the classic pages read ("atelier-corpus"), with
    the corpus name and every entry (undescribed ones without values). */
export function corpusToJSON(c: Corpus): string {
  const cols = c.desc?.columns || [];
  return JSON.stringify({
    format: 'atelier-corpus', version: 1, created: new Date().toISOString(), name: c.name,
    meta: { tool: 'pasteque', corpus: c.name },
    features: c.desc?.features || [], columns: cols,
    segments: c.entries.map((e, i) => {
      const o: Record<string, unknown> = { id: i, file: e.file, start: e.start, end: e.end, label: e.label || '' };
      if (e.values) cols.forEach((k) => { o[k] = e.values![k]; });
      return o;
    }),
  }, null, 1);
}

/** Entries from a corpus.json; a description is kept when it has values. */
export function entriesFromJSON(o: { features?: string[]; columns?: string[]; segments: Record<string, unknown>[] }): { entries: CorpusEntry[]; desc: CorpusDesc | null } {
  const cols = Array.isArray(o.columns) ? o.columns : [];
  const desc = cols.length && Array.isArray(o.features) ? { features: o.features, columns: cols } : null;
  const entries = o.segments.map((s) => {
    const file = String(s.file ?? '');
    const e: CorpusEntry = { id: newId('e'), soundId: soundIdByName(file), file, start: Number(s.start) || 0, end: Number(s.end) || 0, label: String(s.label ?? ''), origin: 'import' };
    if (desc && cols.some((k) => typeof s[k] === 'number')) {
      e.values = {};
      cols.forEach((k) => { const v = s[k]; e.values![k] = typeof v === 'number' ? v : NaN; });
    }
    return e;
  });
  return { entries, desc: desc && entries.some((e) => e.values) ? desc : null };
}

export function soundIdByName(file: string): string {
  return getState().sounds.find((s) => s.name === file)?.id || '';
}

/** Whole session sounds as entries. */
export function soundEntries(ids: string[]): CorpusEntry[] {
  return ids.map((sid) => {
    const m = getState().sounds.find((s) => s.id === sid);
    return m ? newEntry({ soundId: sid, file: m.name, start: 0, end: getSound(sid)?.buffer.duration ?? m.duration, label: '', origin: 'sound' }) : null;
  }).filter(Boolean) as CorpusEntry[];
}

export const describedColumns = columnsFor;

/* --- older sessions --------------------------------------------------------- */

type Legacy = { soundIds?: string[]; result?: { features: string[]; columns: string[]; rows: Record<string, unknown>[] } | null;
  corpus?: { features: string[]; columns: string[]; rows: Record<string, unknown>[] } | null;
  positions?: { id: number | string; x: number; y: number }[] | null; corpusId?: string | null };

/** Sessions saved before corpora existed kept their corpus inside the batch
    and sound map tools: turn those into session corpora. */
export function migrateTools(s: AppState): AppState {
  const corpora = [...s.corpora];
  const tools = { ...s.tools };
  const fromRows = (name: string, r: NonNullable<Legacy['result']>) => {
    const desc = { features: r.features, columns: r.columns };
    const ids = new Map<unknown, string>();
    const entries = r.rows.map((row) => {
      const id = newId('e'); ids.set(row.id, id);
      const values: Record<string, number> = {};
      r.columns.forEach((k) => { const v = row[k]; values[k] = typeof v === 'number' ? v : NaN; });
      return { id, soundId: typeof row.soundId === 'string' ? row.soundId : '', file: String(row.file ?? ''), start: Number(row.start) || 0, end: Number(row.end) || 0, label: String(row.label ?? ''), origin: 'import' as const, values };
    });
    const c: Corpus = { id: newId('c'), name, created: new Date().toISOString(), entries, desc };
    corpora.push(c);
    return { id: c.id, ids };
  };
  for (const key of ['batch', 'lesson:batch']) {
    const t = tools[key] as Legacy | undefined;
    if (t?.result && !t.corpusId) {
      const m = fromRows(tr('corpus.migrated.batch'), t.result);
      tools[key] = { ...t, result: null, corpusId: m.id };
    }
  }
  for (const key of ['soundmap', 'lesson:soundmap']) {
    const t = tools[key] as Legacy | undefined;
    if (t?.corpus && !t.corpusId) {
      const m = fromRows(tr('corpus.migrated.map'), t.corpus);
      const positions = t.positions ? t.positions.map((p) => ({ ...p, id: m.ids.get(p.id) || '' })).filter((p) => p.id) : null;
      tools[key] = { ...t, corpus: null, corpusId: m.id, positions, posCorpus: m.id };
    }
  }
  return corpora.length === s.corpora.length ? s : { ...s, corpora, tools };
}
