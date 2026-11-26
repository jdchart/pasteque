/* Description par lot — port of ats-description-par-lot.html.
   A session corpus (session/corpora.ts: from segmentation, the corpus tool,
   whole files dropped here, a corpus.json or segments.csv) → one row of
   descriptor statistics per item; filter, top-N, sort, chained listening;
   corpus.json and CSV. The description is stored in the corpus itself, so
   the sound map (and a saved session) find it there. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Empty, Pane, Section, Split, Workbench } from '../ui/Workbench';
import { setToolState, useToolState } from '../session/store';
import { useSoundVersion } from '../session/sounds';
import { CorpusEntry, corpusToJSON, entrySound, getCorpus, setDescription, updateEntry, useCorpora, useCorpus } from '../session/corpora';
import { useT } from '../i18n/react';
import { tr } from '../i18n/core';
import { Check, Controls, Field, Panel, Progress, SortHeader, SortState, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { CorpusInput } from '../ui/CorpusPicker';
import { columns, describeSegment } from '../lib/corpus';
import * as audio from '../lib/audio';
import { csvRows, saveJSON, slug } from '../lib/io';
import { fmt, fmtTime } from '../lib/fmt';
import { log } from '../lib/log';
import { toast } from '../ui/dialogs';
import { openItem } from '../shell/nav';
import { S } from './Batch.strings';

const FEATURES = [
  { id: 'rms', on: true }, { id: 'spectralCentroid', on: true }, { id: 'spectralFlatness', on: true },
  { id: 'pitch', on: true }, { id: 'spectralSpread', on: false }, { id: 'spectralRolloff', on: false },
  { id: 'zcr', on: false }, { id: 'mfcc', on: true },
];
const DEMOS = ['events', 'texture8', 'bell', 'pluck', 'noise', 'sweep'];

/** A table row: a corpus item, its number in the corpus, and its values. */
type Row = CorpusEntry & { n: number; [col: string]: unknown };
type State = { corpusId: string | null; feats: string[]; filter: string; topn: number; sort: SortState };
const DEFAULTS: State = { corpusId: null, feats: FEATURES.filter((f) => f.on).map((f) => f.id), filter: '', topn: 0, sort: { col: null, dir: -1 } };

export default function Batch({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('batch') : findTool('batch'))!;
  const { t, rich } = useT(S);
  const [st, set] = useToolState<State>(lesson ? 'lesson:batch' : 'batch', DEFAULTS);
  useSoundVersion();
  const corpora = useCorpora();
  const corpus = useCorpus(st.corpusId);
  const tp = useTransport();
  const [prog, setProg] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<StatusMsg>(null);
  const [expStatus, setExpStatus] = useState<StatusMsg>(null);
  const [hl, setHl] = useState<string | null>(null);
  const chain = useRef<object | null>(null);

  // no corpus chosen yet: take the last one of the session
  useEffect(() => { if (!corpus && corpora.length && !st.corpusId) set({ corpusId: corpora[corpora.length - 1].id }); }, [corpus, corpora.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const feats = FEATURES.map((f) => f.id).filter((id) => st.feats.includes(id));
  const cols = columns(feats);
  const sameCols = !!corpus?.desc && corpus.desc.columns.join() === cols.join();
  const entries = corpus?.entries || [];
  const playable = entries.filter((e) => entrySound(e));
  const todo = sameCols ? playable.filter((e) => !e.values) : playable;
  const missing = entries.length - playable.length;

  const run = async (all: boolean) => {
    if (!corpus) return;
    if (!feats.length) { setRunStatus({ msg: t('st.nofeat'), kind: 'bad' }); return; }
    const list = all ? playable : todo, id = corpus.id;
    if (!list.length) return;
    setProg(0);
    const t0 = performance.now(), values = new Map<string, Record<string, number>>();
    try {
      for (let i = 0; i < list.length; i++) {
        const e = list[i], snd = entrySound(e)!;
        setRunStatus({ msg: t('st.running', { i: i + 1, n: list.length, name: e.file }) });
        const r = await describeSegment(snd.signal, snd.buffer.sampleRate, e.start, e.end, feats, { onProgress: (p) => setProg((i + p) / list.length) });
        const v: Record<string, number> = {};
        cols.forEach((c) => { v[c] = r[c]; });
        values.set(e.id, v);
      }
      if (!getCorpus(id)) return;
      setDescription(id, { features: feats, columns: cols }, values);
      set({ sort: { col: null, dir: -1 } });
      setRunStatus({ msg: t('st.done', { n: list.length, t: ((performance.now() - t0) / 1000).toFixed(1) }), kind: 'ok' });
    } catch (e) { setRunStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }); }
    finally { setProg(null); }
  };

  /* --- table ------------------------------------------------------------ */
  const res = corpus?.desc && entries.some((e) => e.values) ? corpus.desc : null;
  const colLabel = (c: string) => {
    if (c === 'duration') return t('c.duration');
    if (c === 'voiced') return t('c.voiced');
    const m = /^(.+)_(mean|std)$/.exec(c);
    return m ? t('f.' + m[1]) + ' ' + t('c.' + m[2]) : c.replace('_', ' ');
  };
  const rows: Row[] = useMemo(() => (res ? entries.map((e, n) => ({ ...e, ...(e.values || {}), n })) : []), [entries, res]);
  const visible = useMemo(() => {
    const q = st.filter.trim().toLowerCase();
    const out = rows.filter((s) => !q || s.file.toLowerCase().includes(q) || String(s.label || '').toLowerCase().includes(q));
    const c = st.sort.col, d = st.sort.dir;
    if (c) out.sort((a, b) => {
      const x = a[c], y = b[c];
      if (typeof x === 'string' || typeof y === 'string') return String(x ?? '').localeCompare(String(y ?? '')) * d;
      const nx = typeof x === 'number' && isFinite(x), ny = typeof y === 'number' && isFinite(y);
      if (!nx) return ny ? 1 : 0; if (!ny) return -1;
      return ((x as number) - (y as number)) * d;
    });
    return st.topn ? out.slice(0, st.topn) : out;
  }, [rows, st.filter, st.sort, st.topn]);
  const onSort = (s: SortState) => set({ sort: { col: s.col, dir: st.sort.col === s.col ? s.dir : -1 } });

  const play = (r: Row, onEnded?: () => void) => {
    const snd = entrySound(r); if (!snd) { onEnded?.(); return; }
    setHl(r.id);
    if (onEnded) { audio.playRange(snd.buffer, r.start, r.end, () => { setHl(null); onEnded(); }); return; }
    // a single item goes through the transport, so it can be scrubbed and replayed
    if (tp.buffer !== snd.buffer) tp.setBuffer(snd.buffer);
    tp.setRange(r.start, r.end); tp.play();
  };
  const playTop = () => {
    const list = visible, token = {}; chain.current = token; let k = 0;
    const next = () => { if (chain.current !== token || k >= list.length) return; play(list[k++], () => setTimeout(next, 150)); };
    next();
  };
  useEffect(() => { if (hl !== null) document.getElementById('row-' + entry.id + '-' + hl)?.scrollIntoView({ block: 'nearest' }); }, [hl, entry.id]);

  const setLabel = (id: string, label: string) => { if (corpus) updateEntry(corpus.id, id, { label }); };

  const sendToMap = () => {
    if (!corpus) return;
    setToolState(lesson ? 'lesson:soundmap' : 'soundmap', { corpusId: corpus.id });
    const msg = tr('pipe.sentMap', { n: entries.length });
    log.ok(msg); toast(msg, 'ok');
    openItem(lesson ? 'lesson' : 'tool', 'soundmap');
  };

  const base = corpus ? slug(corpus.name) || 'corpus' : 'corpus';
  const exportJson = () => { if (!corpus) return; saveJSON(corpusToJSON(corpus), base + '.corpus.json'); setExpStatus({ msg: t('st.json', { n: entries.length }), kind: 'ok' }); };
  const exportCsv = () => {
    if (!res) return;
    csvRows(['id', 'file', 'start', 'end', 'label', ...res.columns], rows.length, (i) => {
      const s = rows[i];
      return [s.n + 1, s.file, s.start.toFixed(4), s.end.toFixed(4), s.label || '', ...res.columns.map((c) => (typeof s[c] === 'number' && isFinite(s[c] as number) ? s[c] : ''))];
    }, base + '.csv');
    setExpStatus({ msg: t('st.csv'), kind: 'ok' });
  };

  const corpusBlock = (
    <>
      <CorpusInput value={st.corpusId} onChange={(id) => set({ corpusId: id })} lesson={lesson} demos={DEMOS} />
      {missing ? <p className="small muted">{t('seg.missing', { n: missing })}</p> : null}
    </>
  );
  const describeBlock = (
    <>
      <fieldset className="fieldset">
        <legend className="s-label">{t('opt.features')}</legend>
        <div className="checks">
          {FEATURES.map((f) => (
            <Check key={f.id} code={f.id} checked={st.feats.includes(f.id)}
              onChange={(v) => set((s) => ({ feats: v ? [...s.feats, f.id] : s.feats.filter((x) => x !== f.id) }))}>{t('f.' + f.id)}</Check>
          ))}
        </div>
      </fieldset>
      <Controls>
        {todo.length || !sameCols ? (
          <button type="button" className="primary" disabled={!todo.length || prog !== null} onClick={() => void run(false)}>
            {sameCols && todo.length < playable.length ? t('btn.runNew', { n: todo.length }) : t('btn.run')}</button>
        ) : null}
        {sameCols && todo.length < playable.length ? <button type="button" disabled={prog !== null} onClick={() => void run(true)}>{t('btn.rerun')}</button> : null}
      </Controls>
      {corpus?.desc && !sameCols ? <p className="small muted">{t('st.featsChanged')}</p> : null}
      {sameCols && !todo.length && playable.length ? <p className="small muted">{t('st.allDone')}</p> : null}
      <Progress value={prog} />
      <Status s={runStatus} />
    </>
  );
  const tableEl = res ? (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <SortHeader label={t('col.n')} col="n" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.n') })} />
          <th scope="col">{t('col.play')}</th>
          <SortHeader className="left" label={t('col.file')} col="file" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.file') })} />
          <SortHeader label={t('col.start')} col="start" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.start') })} />
          <SortHeader className="left" label={t('col.label')} col="label" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.label') })} />
          {res.columns.map((c) => <SortHeader key={c} label={colLabel(c)} col={c} sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: colLabel(c) })} />)}
        </tr></thead>
        <tbody>
          {visible.map((r, i) => (
            <tr key={r.id} id={'row-' + entry.id + '-' + r.id} className={(hl === r.id ? 'on' : '') + (r.values ? '' : ' off')}>
              <td>{r.n + 1}</td>
              <td><button type="button" disabled={!entrySound(r)} aria-label={t('play.aria', { n: r.n + 1 })} onClick={() => { chain.current = null; play(r); }}>▶</button></td>
              <td className="left">{r.file}</td><td>{fmtTime(r.start)}</td>
              <td className="left"><input type="text" value={String(r.label || '')} aria-label={t('label.aria', { n: r.n + 1 })} onChange={(e) => setLabel(r.id, e.target.value)} /></td>
              {res.columns.map((c) => <td key={c} className={st.sort.col === c && i < 3 ? 'top' : ''}>{fmt(r[c])}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ) : null;
  const queryCtl = (
    <>
      <Field label={t('q.filter')}><input type="text" value={st.filter} placeholder={t('q.filterPh')} onChange={(e) => set({ filter: e.target.value })} /></Field>
      <Field label={t('q.top')}>
        <select value={st.topn} onChange={(e) => set({ topn: +e.target.value })}><option value={0}>{t('q.all')}</option>{[3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select>
      </Field>
    </>
  );
  const sortLine = res ? t('sort.summary', { col: st.sort.col ? (st.sort.col === 'n' ? t('col.n') : colLabel(st.sort.col)) : '—', dir: st.sort.col ? t(st.sort.dir > 0 ? 'asc' : 'desc') : '', shown: visible.length, n: rows.length }) : '';
  const expBtns = (
    <>
      <button type="button" onClick={exportJson}>{t('btn.json')}</button>
      <button type="button" onClick={exportCsv}>{t('btn.csv')}</button>
    </>
  );

  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>{corpusBlock}</Panel>

      <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>{describeBlock}</Panel>

      {res ? (
        <Panel title={t('s3.title')} hintHtml={rich('s3.hint')}>
          <Controls>
            {queryCtl}
            <button type="button" onClick={playTop}>{t('btn.playTop')}</button>
            <button type="button" onClick={() => { chain.current = null; tp.stop(); audio.stop(); setHl(null); }}>{t('btn.stop')}</button>
          </Controls>
          <TransportBar tp={tp} />
          <p className="readout">{sortLine}</p>
          {tableEl}
          <Controls>
            {expBtns}
            <span className="grow" />
            <button type="button" className="primary" onClick={sendToMap} title={tr('pipe.hint')}>{tr('pipe.toMap')}</button>
          </Controls>
          <Status s={expStatus} />
          <p className="small muted">{tr('pipe.hint')}</p>
        </Panel>
      ) : null}
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tp} />} side={<>
      <Section id="corpus" title={t('s1.title')}>{corpusBlock}</Section>
      <Section id="describe" title={t('s2.title')}>{describeBlock}</Section>
      {res ? (
        <Section id="query" title={t('sec.listen')}>
          <Controls>
            {queryCtl}
            <button type="button" className="primary" onClick={playTop}>{t('btn.playTop')}</button>
            <button type="button" className="wide" onClick={() => { chain.current = null; tp.stop(); audio.stop(); setHl(null); }}>{t('btn.stop')}</button>
          </Controls>
        </Section>
      ) : null}
    </>}>
      <Split id="main">
        <Pane id="table" title={corpus ? t('s3.title') + ' — ' + corpus.name : t('s3.title')} flush
          actions={res ? <span className="caption">{sortLine}</span> : null}>
          {res ? (
            <>
              {tableEl}
              <div className="wb-pane-foot">
                {expBtns}
                <Status s={expStatus} />
                <span className="grow" />
                <button type="button" className="primary" onClick={sendToMap} title={tr('pipe.hint')}>{tr('pipe.toMap')}</button>
              </div>
            </>
          ) : <Empty />}
        </Pane>
      </Split>
    </Workbench>
  );
}
