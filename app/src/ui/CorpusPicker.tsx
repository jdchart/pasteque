/* Corpus pieces shared by the corpus tools: choosing a session corpus,
   adding results to one (a dialog), importing corpus.json / segments.csv,
   and the "corpus" input block of the batch description and the sound map. */

import { useState } from 'react';
import { tr } from '../i18n/core';
import { useT } from '../i18n/react';
import { fromJSON, parseSegmentsCSV } from '../lib/corpus';
import { readText } from '../lib/io';
import { fmtTime } from '../lib/fmt';
import { log } from '../lib/log';
import { openItem } from '../shell/nav';
import { setToolState } from '../session/store';
import { useSoundVersion } from '../session/sounds';
import {
  addEntries, Corpus, CorpusDesc, CorpusEntry, createCorpus, entriesFromJSON, entrySound, freshName, getCorpora, getCorpus,
  newEntry, soundEntries, soundIdByName, undescribed, useCorpora, useCorpus,
} from '../session/corpora';
import { openDialog, toast } from './dialogs';
import { Field, Status, StatusMsg } from './kit';
import { SoundAdder } from './SoundList';

const NEW = '__new__';

export function corpusLine(c: Corpus) {
  const n = c.entries.length, d = c.desc ? c.entries.length - undescribed(c).length : 0;
  return tr('corpus.line', { name: c.name, n }) + (d ? ' · ' + tr('corpus.lineDesc', { d }) : '');
}

/** A select over the session's corpora, with "new corpus" at the end. */
export function CorpusPicker({ value, onChange, label, allowNew = true }: {
  value: string | null; onChange: (id: string | null) => void; label?: string; allowNew?: boolean;
}) {
  const { t } = useT();
  const corpora = useCorpora();
  const cur = value && corpora.some((c) => c.id === value) ? value : '';
  return (
    <Field label={label || t('corpus.pick')}>
      <select value={cur} onChange={(e) => {
        const v = e.target.value;
        if (v === NEW) onChange(createCorpus());
        else onChange(v || null);
      }}>
        <option value="">{corpora.length ? t('corpus.none') : t('corpus.noneYet')}</option>
        {corpora.map((c) => <option key={c.id} value={c.id}>{corpusLine(c)}</option>)}
        {allowNew ? <option value={NEW}>{t('corpus.new')}</option> : null}
      </select>
    </Field>
  );
}

/* --- import --------------------------------------------------------------- */

/** corpus.json or segments.csv → entries (and a description, from a described corpus.json). */
export async function readCorpusFile(f: File): Promise<{ entries: CorpusEntry[]; desc: CorpusDesc | null; name: string }> {
  const text = await readText(f);
  const base = f.name.replace(/\.(json|csv)$/i, '');
  if (/\.json$/i.test(f.name) || f.type === 'application/json') {
    const o = fromJSON(text) as unknown as { name?: string; features?: string[]; columns?: string[]; segments: Record<string, unknown>[] };
    return { ...entriesFromJSON(o), name: o.name || base };
  }
  const segs = parseSegmentsCSV(text);
  return { entries: segs.map((s) => newEntry({ soundId: soundIdByName(s.file), file: s.file, start: s.start, end: s.end, label: s.label || '', origin: 'import' })), desc: null, name: base };
}

/** Import files into a corpus (or a new one per file when target is null). Returns the corpus last written. */
export async function importIntoCorpus(files: File[], target: string | null, onStatus?: (s: StatusMsg) => void): Promise<string | null> {
  let last: string | null = target;
  for (const f of files) {
    try {
      const r = await readCorpusFile(f);
      let id = target;
      if (!id || !getCorpus(id)) { id = createCorpus(uniqueName(r.name), [], r.desc); }
      const n = addEntries(id, r.entries, { from: r.desc });
      const missing = new Set(r.entries.filter((e) => !entrySound(e)).map((e) => e.file)).size;
      const msg = tr('corpus.imported', { n, name: getCorpus(id)!.name }) + (missing ? ' ' + tr('corpus.importMissing', { n: missing }) : '');
      log.ok(msg); onStatus?.({ msg, kind: 'ok' });
      last = id;
    } catch (e) { onStatus?.({ msg: f.name + ' : ' + (e as Error).message, kind: 'bad' }); }
  }
  return last;
}

function uniqueName(n: string) {
  const names = new Set(getCorpora().map((c) => c.name));
  if (!names.has(n)) return n;
  for (let k = 2; ; k++) if (!names.has(n + ' (' + k + ')')) return n + ' (' + k + ')';
}

/* --- adding results to a corpus ------------------------------------------------ */

export type AddResult = { corpusId: string; added: number; next: 'stay' | 'open' };

function AddBody({ count, files, close, nextLabel, exclude, canReplace }: { count: number; files: number; nextLabel?: string; exclude?: string; canReplace: boolean; close: (v?: { target: string; name: string; replace: boolean; next: 'stay' | 'open' } | null) => void }) {
  const { t } = useT();
  const corpora = useCorpora().filter((c) => c.id !== exclude);
  const [target, setTarget] = useState<string>(corpora.length ? corpora[corpora.length - 1].id : NEW);
  const [name, setName] = useState(freshName());
  const [replace, setReplace] = useState(true);
  const submit = (next: 'stay' | 'open') => close({ target, name, replace, next });
  return (
    <form onSubmit={(e) => { e.preventDefault(); submit(nextLabel ? 'open' : 'stay'); }}>
      <div className="modal-body">
        <p>{t('corpus.addMsg', { n: count, files })}</p>
        <Field label={t('corpus.target')}>
          <select value={target} onChange={(e) => setTarget(e.target.value)} data-autofocus>
            {corpora.map((c) => <option key={c.id} value={c.id}>{corpusLine(c)}</option>)}
            <option value={NEW}>{t('corpus.new')}</option>
          </select>
        </Field>
        {target === NEW ? (
          <label className="field"><span className="s-label">{t('corpus.name')}</span>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} /></label>
        ) : canReplace ? (
          <label className="check"><input type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} />
            <span>{t('corpus.replace')}</span></label>
        ) : null}
      </div>
      <div className="modal-foot">
        <button type="button" onClick={() => close(null)}>{t('cancel')}</button>
        {nextLabel ? <button type="button" onClick={() => submit('stay')}>{t('corpus.addBtn')}</button> : null}
        <button type="submit" className="primary">{nextLabel || t('corpus.addBtn')}</button>
      </div>
    </form>
  );
}

/** Ask where to put some entries, and put them there. */
export async function addToCorpusDialog(entries: CorpusEntry[], opts: {
  nextLabel?: string; title?: string;
  /** entries copied from a described corpus keep their values when the columns match */
  from?: CorpusDesc | null; exclude?: string;
  /** offer to replace what came earlier from the same files (re-segmenting) */
  canReplace?: boolean;
} = {}): Promise<AddResult | null> {
  const files = new Set(entries.map((e) => e.soundId || e.file)).size;
  const r = await openDialog<{ target: string; name: string; replace: boolean; next: 'stay' | 'open' } | null>({
    title: opts.title || tr('corpus.addTitle'), dismissValue: null,
    render: (close) => <AddBody count={entries.length} files={files} nextLabel={opts.nextLabel} exclude={opts.exclude} canReplace={opts.canReplace !== false} close={close} />,
  });
  if (!r) return null;
  let id = r.target;
  let added: number;
  if (id === NEW || !getCorpus(id)) { id = createCorpus(r.name || freshName(), [], opts.from ?? null); added = addEntries(id, entries, { from: opts.from }); }
  else added = addEntries(id, entries, { from: opts.from, replaceSounds: r.replace && opts.canReplace !== false ? Array.from(new Set(entries.map((e) => e.soundId).filter(Boolean))) : [] });
  const msg = tr('corpus.added', { n: added, name: getCorpus(id)!.name });
  log.ok(msg); toast(msg, 'ok');
  return { corpusId: id, added, next: r.next };
}

/** Show a corpus in the corpus tool (same version as the caller). */
export function openInCorpusTool(lesson: boolean, corpusId: string | null) {
  if (corpusId) setToolState(lesson ? 'lesson:corpus' : 'corpus', { cur: corpusId });
  openItem(lesson ? 'lesson' : 'tool', 'corpus');
}

/* --- the input block of the batch description and the sound map ------------------ */

export function CorpusInput({ value, onChange, lesson, demos, onImported }: {
  value: string | null; onChange: (id: string | null) => void; lesson: boolean; demos: string[];
  onImported?: () => void;
}) {
  const { t } = useT();
  useSoundVersion();
  const corpus = useCorpus(value);
  const [status, setStatus] = useState<StatusMsg>(null);
  const ensure = () => (value && getCorpus(value) ? value : (() => { const id = createCorpus(); onChange(id); return id; })());
  const ids = corpus ? Array.from(new Set(corpus.entries.map((e) => e.soundId).filter(Boolean))) : [];
  const ready = corpus ? corpus.entries.filter((e) => entrySound(e)) : [];
  const missing = corpus ? Array.from(new Set(corpus.entries.filter((e) => !entrySound(e)).map((e) => e.file))) : [];
  const dur = ready.reduce((a, e) => a + (e.end - e.start), 0);
  return (
    <div className="corpus-input">
      <CorpusPicker value={value} onChange={onChange} />
      <SoundAdder ids={ids} demos={demos}
        accept="audio/*,.json,.csv,application/json,text/csv" main={t('corpus.drop')} formats={t('corpus.dropFormats')}
        onOther={async (fs) => { const id = await importIntoCorpus(fs, value && getCorpus(value) ? value : null, setStatus); if (id) { onChange(id); onImported?.(); } }}
        onAdd={(sids) => {
          const id = ensure();
          const n = addEntries(id, soundEntries(sids));
          setStatus({ msg: tr('corpus.added', { n, name: getCorpus(id)!.name }), kind: 'ok' });
        }} />
      {corpus ? (
        <p className="readout">
          {t('corpus.summary', { n: corpus.entries.length, files: new Set(corpus.entries.map((e) => e.file)).size, dur: fmtTime(dur) })}
          {missing.length ? <><br /><span className="status bad">{t('corpus.missing', { list: missing.slice(0, 5).join(', ') + (missing.length > 5 ? '…' : '') })}</span></> : null}
        </p>
      ) : <p className="small muted">{t('corpus.inputHint')}</p>}
      <Status s={status} />
      <p className="small"><button type="button" className="link-btn" onClick={() => openInCorpusTool(lesson, value)}>{t('corpus.manage')}</button></p>
    </div>
  );
}
