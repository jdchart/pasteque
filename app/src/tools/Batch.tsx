/* Description par lot — port of ats-description-par-lot.html.
   Files (+ an optional segments.csv, or segments handed over by the
   segmentation tab) → one row of descriptor statistics per segment; filter,
   top-N, sort, chained listening; corpus.json and CSV. The described table
   is kept in the session (it is small), and can be sent to the sound map. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Empty, Pane, Section, Split, Workbench } from '../ui/Workbench';
import { setToolState, useApp, useToolState } from '../session/store';
import { getSound, useSoundVersion } from '../session/sounds';
import { useT } from '../i18n/react';
import { tr } from '../i18n/core';
import { Check, Controls, Field, Panel, Progress, SortHeader, SortState, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { SoundAdder } from '../ui/SoundList';
import { columns, CsvSeg, describeSegment, parseSegmentsCSV, toJSON, SegRow } from '../lib/corpus';
import * as audio from '../lib/audio';
import { csvRows, readText, saveJSON } from '../lib/io';
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

export type Row = SegRow & { soundId: string };
export type Described = { features: string[]; columns: string[]; rows: Row[] };
type HandedSeg = { soundId: string; start: number; end: number; label: string };
type State = {
  soundIds: string[]; csvSegs: CsvSeg[] | null; segs: HandedSeg[] | null; inbox: number; inboxFrom: string;
  feats: string[]; filter: string; topn: number; sort: SortState; result: Described | null;
};
const DEFAULTS: State = { soundIds: [], csvSegs: null, segs: null, inbox: 0, inboxFrom: '', feats: FEATURES.filter((f) => f.on).map((f) => f.id), filter: '', topn: 0, sort: { col: null, dir: -1 }, result: null };

export default function Batch({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('batch') : findTool('batch'))!;
  const { t, rich } = useT(S);
  const [st, set] = useToolState<State>(lesson ? 'lesson:batch' : 'batch', DEFAULTS);
  useSoundVersion();
  const sounds = useApp((s) => s.sounds);
  const tp = useTransport();
  const [prog, setProg] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<StatusMsg>(null);
  const [expStatus, setExpStatus] = useState<StatusMsg>(null);
  const [hl, setHl] = useState<number | null>(null);
  const chain = useRef<object | null>(null);

  const nameOf = (id: string) => sounds.find((s) => s.id === id)?.name || '?';
  const ready = st.soundIds.filter((id) => getSound(id));

  /* the segments to describe: handed over, from a CSV, or one per file */
  const { segments, missing } = useMemo(() => {
    const out: { id: number; soundId: string; file: string; start: number; end: number; label: string }[] = [];
    let miss = 0, id = 0;
    if (st.segs) {
      st.segs.forEach((s) => { if (ready.includes(s.soundId)) out.push({ id: id++, soundId: s.soundId, file: nameOf(s.soundId), start: s.start, end: s.end, label: s.label }); else miss++; });
    } else if (st.csvSegs) {
      st.csvSegs.forEach((s) => {
        const sid = ready.find((x) => nameOf(x) === s.file);
        if (!sid) { miss++; return; }
        out.push({ id: id++, soundId: sid, file: s.file, start: s.start, end: s.end, label: s.label || '' });
      });
    } else {
      [...ready].sort((a, b) => nameOf(a).localeCompare(nameOf(b))).forEach((sid) => out.push({ id: id++, soundId: sid, file: nameOf(sid), start: 0, end: getSound(sid)!.buffer.duration, label: '' }));
    }
    return { segments: out, missing: miss };
  }, [st.segs, st.csvSegs, ready.join(), sounds]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { if (missing) log.warn(t('seg.missing', { n: missing })); }, [missing]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (st.inbox && st.inboxFrom === 'segmentation') setRunStatus({ msg: tr('pipe.fromSeg', { n: st.segs?.length || 0, files: st.soundIds.length }), kind: 'ok' }); }, [st.inbox]); // eslint-disable-line react-hooks/exhaustive-deps

  const onOther = async (files: File[]) => {
    for (const f of files) {
      if (!/\.csv$/i.test(f.name) && f.type !== 'text/csv') continue;
      try {
        const segs = parseSegmentsCSV(await readText(f));
        const matched = segs.filter((s) => st.soundIds.some((id) => nameOf(id) === s.file)).length;
        set({ csvSegs: segs, segs: null, result: null });
        log.ok(t('st.csvLoaded', { n: segs.length, matched }));
        setRunStatus({ msg: t('st.csvLoaded', { n: segs.length, matched }), kind: 'ok' });
      } catch (e) { setRunStatus({ msg: f.name + ' : ' + (e as Error).message, kind: 'bad' }); }
    }
  };

  const run = async () => {
    const feats = FEATURES.map((f) => f.id).filter((id) => st.feats.includes(id));
    if (!feats.length) { setRunStatus({ msg: t('st.nofeat'), kind: 'bad' }); return; }
    const cols = columns(feats);
    setProg(0);
    const t0 = performance.now(), rows: Row[] = [];
    try {
      for (let i = 0; i < segments.length; i++) {
        const s = segments[i], snd = getSound(s.soundId)!;
        setRunStatus({ msg: t('st.running', { i: i + 1, n: segments.length, name: s.file }) });
        const r = await describeSegment(snd.signal, snd.buffer.sampleRate, s.start, s.end, feats, { onProgress: (p) => setProg((i + p) / segments.length) });
        const row: Row = { ...s };
        cols.forEach((c) => { row[c] = r[c]; });
        rows.push(row);
      }
      set({ result: { features: feats, columns: cols, rows }, sort: { col: null, dir: -1 } });
      setRunStatus({ msg: t('st.done', { n: segments.length, t: ((performance.now() - t0) / 1000).toFixed(1) }), kind: 'ok' });
    } catch (e) { setRunStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }); }
    finally { setProg(null); }
  };

  /* --- table ------------------------------------------------------------ */
  const res = st.result;
  const colLabel = (c: string) => {
    if (c === 'duration') return t('c.duration');
    if (c === 'voiced') return t('c.voiced');
    const m = /^(.+)_(mean|std)$/.exec(c);
    return m ? t('f.' + m[1]) + ' ' + t('c.' + m[2]) : c.replace('_', ' ');
  };
  const visible = useMemo(() => {
    if (!res) return [];
    const q = st.filter.trim().toLowerCase();
    const rows = res.rows.filter((s) => !q || s.file.toLowerCase().includes(q) || String(s.label || '').toLowerCase().includes(q));
    const c = st.sort.col, d = st.sort.dir;
    if (c) rows.sort((a, b) => {
      const x = a[c], y = b[c];
      if (typeof x === 'string' || typeof y === 'string') return String(x).localeCompare(String(y)) * d;
      if (!isFinite(x)) return 1; if (!isFinite(y)) return -1;
      return (x - y) * d;
    });
    return st.topn ? rows.slice(0, st.topn) : rows;
  }, [res, st.filter, st.sort, st.topn]);
  const onSort = (s: SortState) => set({ sort: { col: s.col, dir: st.sort.col === s.col ? s.dir : -1 } });

  const play = (r: Row, onEnded?: () => void) => {
    const snd = getSound(r.soundId); if (!snd) return;
    setHl(r.id);
    if (onEnded) { audio.playRange(snd.buffer, r.start, r.end, () => { setHl(null); onEnded(); }); return; }
    // a single segment goes through the transport, so it can be scrubbed and replayed
    if (tp.buffer !== snd.buffer) tp.setBuffer(snd.buffer);
    tp.setRange(r.start, r.end); tp.play();
  };
  const playTop = () => {
    const rows = visible, token = {}; chain.current = token; let k = 0;
    const next = () => { if (chain.current !== token || k >= rows.length) return; play(rows[k++], () => setTimeout(next, 150)); };
    next();
  };
  useEffect(() => { if (hl !== null) document.getElementById('row-' + entry.id + '-' + hl)?.scrollIntoView({ block: 'nearest' }); }, [hl, entry.id]);

  const setLabel = (id: number, label: string) => set((s) => (s.result ? { result: { ...s.result, rows: s.result.rows.map((r) => (r.id === id ? { ...r, label } : r)) } } : {}));

  const sendToMap = () => {
    if (!res) return;
    setToolState(lesson ? 'lesson:soundmap' : 'soundmap', { corpus: res, inbox: Date.now(), inboxFrom: 'batch', positions: null });
    const msg = tr('pipe.sentMap', { n: res.rows.length });
    log.ok(msg); toast(msg, 'ok');
    openItem(lesson ? 'lesson' : 'tool', 'soundmap');
  };

  const totalDur = segments.reduce((a, s) => a + (s.end - s.start), 0);
  const fileCount = (id: string) => segments.filter((s) => s.soundId === id).length;


  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        <SoundAdder ids={st.soundIds} demos={['events', 'texture8', 'bell', 'pluck', 'noise', 'sweep']}
          accept="audio/*,.csv,text/csv" main={t('drop.main')} formats={t('drop.formats')} onOther={(f) => void onOther(f)}
          onAdd={(ids) => set((s) => ({ soundIds: [...s.soundIds, ...ids.filter((id) => !s.soundIds.includes(id))], result: null }))} />
        <ul className="sg-files">
          {st.soundIds.map((id) => (
            <li key={id}>
              <span className="mono small grow">{nameOf(id)} — {fmtTime(getSound(id)?.buffer.duration || 0)} · {fileCount(id)}</span>
              <button type="button" className="icon-btn" aria-label={t('files.remove')} title={t('files.remove')}
                onClick={() => set((s) => ({ soundIds: s.soundIds.filter((x) => x !== id), result: null }))}>×</button>
            </li>
          ))}
        </ul>
        {st.segs || st.csvSegs ? (
          <p className="small muted">
            {st.segs ? tr('pipe.fromSeg', { n: st.segs.length, files: new Set(st.segs.map((s) => s.soundId)).size }) : 'segments.csv — ' + st.csvSegs!.length}
            {' '}<button type="button" className="link-btn" onClick={() => set({ segs: null, csvSegs: null, result: null })}>×</button>
          </p>
        ) : null}
        <p className="readout">{t('summary', { files: ready.length, segs: segments.length, dur: fmtTime(totalDur) })}</p>
      </Panel>

      <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>
        <fieldset className="fieldset">
          <legend className="s-label">{t('opt.features')}</legend>
          <div className="checks">
            {FEATURES.map((f) => (
              <Check key={f.id} code={f.id} checked={st.feats.includes(f.id)}
                onChange={(v) => set((s) => ({ feats: v ? [...s.feats, f.id] : s.feats.filter((x) => x !== f.id) }))}>{t('f.' + f.id)}</Check>
            ))}
          </div>
        </fieldset>
        <Controls><button type="button" className="primary" disabled={!segments.length || prog !== null} onClick={() => void run()}>{t('btn.run')}</button></Controls>
        <Progress value={prog} />
        <Status s={runStatus} />
      </Panel>

      {res ? (
        <Panel title={t('s3.title')} hintHtml={rich('s3.hint')}>
          <Controls>
            <Field label={t('q.filter')}><input type="text" value={st.filter} placeholder={t('q.filterPh')} onChange={(e) => set({ filter: e.target.value })} /></Field>
            <Field label={t('q.top')}>
              <select value={st.topn} onChange={(e) => set({ topn: +e.target.value })}><option value={0}>{t('q.all')}</option>{[3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </Field>
            <button type="button" onClick={playTop}>{t('btn.playTop')}</button>
            <button type="button" onClick={() => { chain.current = null; tp.stop(); audio.stop(); setHl(null); }}>{t('btn.stop')}</button>
          </Controls>
          <TransportBar tp={tp} />
          <p className="readout">{t('sort.summary', { col: st.sort.col ? colLabel(st.sort.col) : '—', dir: st.sort.col ? t(st.sort.dir > 0 ? 'asc' : 'desc') : '', shown: visible.length, n: res.rows.length })}</p>
          <div className="table-wrap">
            <table className="table">
              <thead><tr>
                <th scope="col">{t('col.n')}</th><th scope="col">{t('col.play')}</th>
                <SortHeader className="left" label={t('col.file')} col="file" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.file') })} />
                <SortHeader label={t('col.start')} col="start" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.start') })} />
                <SortHeader className="left" label={t('col.label')} col="label" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.label') })} />
                {res.columns.map((c) => <SortHeader key={c} label={colLabel(c)} col={c} sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: colLabel(c) })} />)}
              </tr></thead>
              <tbody>
                {visible.map((r, i) => (
                  <tr key={r.id} id={'row-' + entry.id + '-' + r.id} className={hl === r.id ? 'on' : ''}>
                    <td>{r.id + 1}</td>
                    <td><button type="button" aria-label={t('play.aria', { n: r.id + 1 })} onClick={() => { chain.current = null; play(r); }}>▶</button></td>
                    <td className="left">{r.file}</td><td>{fmtTime(r.start)}</td>
                    <td className="left"><input type="text" value={String(r.label || '')} aria-label={t('label.aria', { n: r.id + 1 })} onChange={(e) => setLabel(r.id, e.target.value)} /></td>
                    {res.columns.map((c) => <td key={c} className={st.sort.col === c && i < 3 ? 'top' : ''}>{fmt(r[c])}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Controls>
            <button type="button" onClick={() => { saveJSON(toJSON(res.rows, res.features, { tool: 'description-par-lot' }), 'corpus.json'); setExpStatus({ msg: t('st.json', { n: res.rows.length }), kind: 'ok' }); }}>{t('btn.json')}</button>
            <button type="button" onClick={() => {
              csvRows(['id', 'file', 'start', 'end', 'label', ...res.columns], res.rows.length, (i) => {
                const s = res.rows[i];
                return [s.id + 1, s.file, s.start.toFixed(4), s.end.toFixed(4), s.label || '', ...res.columns.map((c) => (isFinite(s[c] as number) ? s[c] : ''))];
              }, 'corpus.csv');
              setExpStatus({ msg: t('st.csv'), kind: 'ok' });
            }}>{t('btn.csv')}</button>
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
      <Section id="corpus" title={t('s1.title')}>
        <SoundAdder ids={st.soundIds} demos={['events', 'texture8', 'bell', 'pluck', 'noise', 'sweep']}
          accept="audio/*,.csv,text/csv" main={t('drop.main')} formats={t('drop.formats')} onOther={(f) => void onOther(f)}
          onAdd={(ids) => set((s) => ({ soundIds: [...s.soundIds, ...ids.filter((id) => !s.soundIds.includes(id))], result: null }))} />
        <ul className="sg-files">
          {st.soundIds.map((id) => (
            <li key={id}>
              <span className="mono small grow">{nameOf(id)} — {fmtTime(getSound(id)?.buffer.duration || 0)} · {fileCount(id)}</span>
              <button type="button" className="icon-btn" aria-label={t('files.remove')} title={t('files.remove')}
                onClick={() => set((s) => ({ soundIds: s.soundIds.filter((x) => x !== id), result: null }))}>×</button>
            </li>
          ))}
        </ul>
        {st.segs || st.csvSegs ? (
          <p className="small muted">
            {st.segs ? tr('pipe.fromSeg', { n: st.segs.length, files: new Set(st.segs.map((s) => s.soundId)).size }) : 'segments.csv — ' + st.csvSegs!.length}
            {' '}<button type="button" className="link-btn" onClick={() => set({ segs: null, csvSegs: null, result: null })}>×</button>
          </p>
        ) : null}
        <p className="readout">{t('summary', { files: ready.length, segs: segments.length, dur: fmtTime(totalDur) })}</p>
      </Section>
      <Section id="describe" title={t('s2.title')}>
        <fieldset className="fieldset">
          <legend className="s-label">{t('opt.features')}</legend>
          <div className="checks">
            {FEATURES.map((f) => (
              <Check key={f.id} code={f.id} checked={st.feats.includes(f.id)}
                onChange={(v) => set((s) => ({ feats: v ? [...s.feats, f.id] : s.feats.filter((x) => x !== f.id) }))}>{t('f.' + f.id)}</Check>
            ))}
          </div>
        </fieldset>
        <Controls><button type="button" className="primary" disabled={!segments.length || prog !== null} onClick={() => void run()}>{t('btn.run')}</button></Controls>
        <Progress value={prog} />
        <Status s={runStatus} />
      </Section>
      {res ? (
        <Section id="query" title={t('sec.listen')}>
          <Controls>
            <Field label={t('q.filter')}><input type="text" value={st.filter} placeholder={t('q.filterPh')} onChange={(e) => set({ filter: e.target.value })} /></Field>
            <Field label={t('q.top')}>
              <select value={st.topn} onChange={(e) => set({ topn: +e.target.value })}><option value={0}>{t('q.all')}</option>{[3, 5, 10].map((n) => <option key={n} value={n}>{n}</option>)}</select>
            </Field>
            <button type="button" className="primary" onClick={playTop}>{t('btn.playTop')}</button>
            <button type="button" className="wide" onClick={() => { chain.current = null; tp.stop(); audio.stop(); setHl(null); }}>{t('btn.stop')}</button>
          </Controls>
        </Section>
      ) : null}
    </>}>
      <Split id="main">
        <Pane id="table" title={t('s3.title')} flush
          actions={res ? <span className="caption">{t('sort.summary', { col: st.sort.col ? colLabel(st.sort.col) : '—', dir: st.sort.col ? t(st.sort.dir > 0 ? 'asc' : 'desc') : '', shown: visible.length, n: res.rows.length })}</span> : null}>
          {res ? (
            <>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr>
                    <th scope="col">{t('col.n')}</th><th scope="col">{t('col.play')}</th>
                    <SortHeader className="left" label={t('col.file')} col="file" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.file') })} />
                    <SortHeader label={t('col.start')} col="start" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.start') })} />
                    <SortHeader className="left" label={t('col.label')} col="label" sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: t('col.label') })} />
                    {res.columns.map((c) => <SortHeader key={c} label={colLabel(c)} col={c} sort={st.sort} onSort={onSort} title={t('tbl.sortBy', { col: colLabel(c) })} />)}
                  </tr></thead>
                  <tbody>
                    {visible.map((r, i) => (
                      <tr key={r.id} id={'row-' + entry.id + '-' + r.id} className={hl === r.id ? 'on' : ''}>
                        <td>{r.id + 1}</td>
                        <td><button type="button" aria-label={t('play.aria', { n: r.id + 1 })} onClick={() => { chain.current = null; play(r); }}>▶</button></td>
                        <td className="left">{r.file}</td><td>{fmtTime(r.start)}</td>
                        <td className="left"><input type="text" value={String(r.label || '')} aria-label={t('label.aria', { n: r.id + 1 })} onChange={(e) => setLabel(r.id, e.target.value)} /></td>
                        {res.columns.map((c) => <td key={c} className={st.sort.col === c && i < 3 ? 'top' : ''}>{fmt(r[c])}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="wb-pane-foot">
                <button type="button" onClick={() => { saveJSON(toJSON(res.rows, res.features, { tool: 'description-par-lot' }), 'corpus.json'); setExpStatus({ msg: t('st.json', { n: res.rows.length }), kind: 'ok' }); }}>{t('btn.json')}</button>
                <button type="button" onClick={() => {
                  csvRows(['id', 'file', 'start', 'end', 'label', ...res.columns], res.rows.length, (i) => {
                    const s = res.rows[i];
                    return [s.id + 1, s.file, s.start.toFixed(4), s.end.toFixed(4), s.label || '', ...res.columns.map((c) => (isFinite(s[c] as number) ? s[c] : ''))];
                  }, 'corpus.csv');
                  setExpStatus({ msg: t('st.csv'), kind: 'ok' });
                }}>{t('btn.csv')}</button>
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
