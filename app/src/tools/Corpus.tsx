/* Corpus — the session's corpora, made and kept by hand.
   A corpus is a list of pieces of sounds. It fills from the segmentation
   (its kept segments), from whole sounds, from segments selected by hand on
   a waveform, from a corpus.json or a segments.csv, and from other corpora
   (copy, merge). Here it is edited — labels, bounds, cuts, removals — and
   exported; the batch description describes it and the sound map plays it. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { openItem } from '../shell/nav';
import { Empty, Pane, Section, Split, Workbench } from '../ui/Workbench';
import { setToolState, useApp, useToolState } from '../session/store';
import { useSoundVersion } from '../session/sounds';
import {
  addEntries, CorpusEntry, corpusToJSON, createCorpus, deleteCorpus, duplicateCorpus, entrySound, freshName,
  getCorpus, mergeCorpora, newEntry, removeEntries, renameCorpus, soundEntries, splitEntry, updateEntry, useCorpora, useCorpus,
} from '../session/corpora';
import { useT } from '../i18n/react';
import { tr } from '../i18n/core';
import { Controls, Field, Panel, Plot, SortHeader, SortState, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { SoundAdder } from '../ui/SoundList';
import { SoundSource, useLoadedSound } from '../ui/SoundSource';
import { addToCorpusDialog, corpusLine, importIntoCorpus } from '../ui/CorpusPicker';
import { confirmDialog, openDialog, promptDialog, toast } from '../ui/dialogs';
import * as draw from '../lib/draw';
import { css, padLeft } from '../lib/draw';
import { envelope } from '../lib/dsp';
import * as audio from '../lib/audio';
import { csvRows, pickFiles, saveJSON, saveWavZip, slug } from '../lib/io';
import { fmtTime } from '../lib/fmt';
import { log } from '../lib/log';
import { S } from './Corpus.strings';

type State = { cur: string | null; soundId: string | null; sel: [number, number] | null; label: string; filter: string; sort: SortState };
const DEFAULTS: State = { cur: null, soundId: null, sel: null, label: '', filter: '', sort: { col: null, dir: 1 } };
const DEMOS = ['events', 'texture8', 'mixture', 'bell', 'pluck', 'noise', 'sweep'];

/* --- merge dialog ---------------------------------------------------------- */
function MergeBody({ initial, close }: { initial: string[]; close: (v?: { ids: string[]; name: string; dedupe: boolean } | null) => void }) {
  const { t } = useT(S);
  const corpora = useCorpora();
  const [ids, setIds] = useState<string[]>(initial);
  const [name, setName] = useState(freshName(tr('corpus.default')));
  const [dedupe, setDedupe] = useState(true);
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (ids.length) close({ ids: corpora.filter((c) => ids.includes(c.id)).map((c) => c.id), name, dedupe }); }}>
      <div className="modal-body">
        <p className="muted">{t('merge.msg')}</p>
        <fieldset className="fieldset"><legend className="s-label">{t('merge.which')}</legend>
          {corpora.map((c) => (
            <label key={c.id} className="check"><input type="checkbox" checked={ids.includes(c.id)}
              onChange={(e) => setIds(e.target.checked ? [...ids, c.id] : ids.filter((x) => x !== c.id))} /><span>{corpusLine(c)}</span></label>
          ))}
        </fieldset>
        <label className="field"><span className="s-label">{t('merge.name')}</span><input type="text" value={name} onChange={(e) => setName(e.target.value)} data-autofocus /></label>
        <label className="check"><input type="checkbox" checked={dedupe} onChange={(e) => setDedupe(e.target.checked)} /><span>{t('merge.dedupe')}</span></label>
      </div>
      <div className="modal-foot">
        <button type="button" onClick={() => close(null)}>{t('cancel')}</button>
        <button type="submit" className="primary" disabled={ids.length < 1}>{t('merge.ok')}</button>
      </div>
    </form>
  );
}

export default function Corpus({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('corpus') : findTool('corpus'))!;
  const { t, rich } = useT(S);
  const [st, set] = useToolState<State>(lesson ? 'lesson:corpus' : 'corpus', DEFAULTS);
  useSoundVersion();
  useApp((s) => s.sounds);
  const corpora = useCorpora();
  const corpus = useCorpus(st.cur);
  const tp = useTransport();
  const sound = useLoadedSound(st.soundId);
  const [checked, setChecked] = useState<string[]>([]);
  const [hl, setHl] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusMsg>(null);
  const [expStatus, setExpStatus] = useState<StatusMsg>(null);
  const chain = useRef<object | null>(null);
  const drag = useRef<{ x0: number; t0: number; moved: boolean } | null>(null);

  // the current corpus: the one chosen, or the last one made
  useEffect(() => { if (!corpus && corpora.length) set({ cur: corpora[corpora.length - 1].id }); }, [corpus, corpora.length]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setChecked([]); setHl(null); }, [st.cur]);
  useEffect(() => { tp.setBuffer(sound?.buffer || null); }, [sound?.buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  const ensure = () => { if (corpus) return corpus.id; const id = createCorpus(); set({ cur: id }); return id; };

  /* --- corpora ---------------------------------------------------------------- */
  const onNew = async () => {
    const name = await promptDialog({ title: t('c.newTitle'), label: tr('corpus.name'), value: freshName(), ok: t('c.create') });
    if (name !== null) set({ cur: createCorpus(name) });
  };
  const onRename = async () => {
    if (!corpus) return;
    const name = await promptDialog({ title: t('c.renameTitle'), label: tr('corpus.name'), value: corpus.name });
    if (name) renameCorpus(corpus.id, name);
  };
  const onDelete = async () => {
    if (!corpus) return;
    if (!(await confirmDialog({ title: t('c.deleteTitle'), message: t('c.deleteMsg', { name: corpus.name, n: corpus.entries.length }), ok: t('c.delete'), danger: true }))) return;
    const rest = corpora.filter((c) => c.id !== corpus.id);
    deleteCorpus(corpus.id);
    set({ cur: rest.length ? rest[rest.length - 1].id : null });
  };
  const onDuplicate = () => { if (corpus) { const id = duplicateCorpus(corpus.id); if (id) set({ cur: id }); } };
  const onMerge = async () => {
    const r = await openDialog<{ ids: string[]; name: string; dedupe: boolean } | null>({
      title: t('merge.title'), dismissValue: null,
      render: (close) => <MergeBody initial={corpus ? [corpus.id] : []} close={close} />,
    });
    if (!r) return;
    const id = mergeCorpora(r.ids, r.name, r.dedupe);
    const c = getCorpus(id)!;
    const msg = t('merge.done', { name: c.name, n: c.entries.length, k: r.ids.length });
    log.ok(msg); toast(msg, 'ok');
    set({ cur: id });
  };
  const onImport = async (into: boolean) => {
    const fs = await pickFiles('.json,.csv,application/json,text/csv', true);
    if (!fs.length) return;
    const id = await importIntoCorpus(fs, into && corpus ? corpus.id : null, setStatus);
    if (id) set({ cur: id });
  };

  /* --- adding ------------------------------------------------------------------ */
  const addSounds = (ids: string[]) => {
    const id = ensure();
    const n = addEntries(id, soundEntries(ids));
    setStatus({ msg: tr('corpus.added', { n, name: getCorpus(id)!.name }), kind: 'ok' });
  };
  const sel = st.sel && sound ? [Math.max(0, Math.min(st.sel[0], st.sel[1])), Math.min(sound.buffer.duration, Math.max(st.sel[0], st.sel[1]))] as [number, number] : null;
  const addSelection = () => {
    if (!sound || !sel || sel[1] - sel[0] < 0.01) { setStatus({ msg: t('man.noSel'), kind: 'bad' }); return; }
    const id = ensure();
    const n = addEntries(id, [newEntry({ soundId: sound.meta.id, file: sound.meta.name, start: sel[0], end: sel[1], label: st.label.trim(), origin: 'manual' })]);
    setStatus({ msg: n ? tr('corpus.added', { n, name: getCorpus(id)!.name }) : t('man.dup'), kind: n ? 'ok' : 'bad' });
    if (n) set({ label: '' });
  };
  const setSelEdge = (k: 0 | 1, v: number) => {
    if (!sound || !isFinite(v)) return;
    const cur = sel || [0, sound.buffer.duration];
    const next: [number, number] = [...cur] as [number, number];
    next[k] = Math.max(0, Math.min(sound.buffer.duration, v));
    set({ sel: next });
  };

  /* --- the table ----------------------------------------------------------------- */
  const entries = corpus?.entries || [];
  const index = useMemo(() => new Map(entries.map((e, i) => [e.id, i])), [entries]);
  const visible = useMemo(() => {
    const q = st.filter.trim().toLowerCase();
    const rows = entries.filter((e) => !q || e.file.toLowerCase().includes(q) || e.label.toLowerCase().includes(q) || (e.origin ? t('o.' + e.origin).toLowerCase().includes(q) : false));
    const c = st.sort.col, d = st.sort.dir;
    if (c) rows.sort((a, b) => {
      const v = (e: CorpusEntry): number | string => (c === 'dur' ? e.end - e.start : c === 'n' ? index.get(e.id)! : (e as unknown as Record<string, number | string>)[c] ?? '');
      const x = v(a), y = v(b);
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * d;
    });
    return rows;
  }, [entries, st.filter, st.sort, index, t]);
  const onSort = (s: SortState) => set({ sort: s });
  const allChecked = visible.length > 0 && visible.every((e) => checked.includes(e.id));
  const toggleAll = () => setChecked(allChecked ? checked.filter((id) => !visible.some((e) => e.id === id)) : Array.from(new Set([...checked, ...visible.map((e) => e.id)])));
  const targets = () => (checked.length ? entries.filter((e) => checked.includes(e.id)) : visible);

  const focus = (e: CorpusEntry) => {
    const snd = entrySound(e);
    setHl(e.id);
    if (snd && snd.meta.id !== st.soundId) set({ soundId: snd.meta.id, sel: [e.start, e.end] });
    else set({ sel: [e.start, e.end] });
  };
  const play = (e: CorpusEntry, onEnded?: () => void) => {
    const snd = entrySound(e); if (!snd) { onEnded?.(); return; }
    focus(e);
    if (onEnded) { audio.playRange(snd.buffer, e.start, e.end, () => { setHl(null); onEnded(); }); return; }
    chain.current = null;
    if (tp.buffer !== snd.buffer) tp.setBuffer(snd.buffer);
    tp.setRange(e.start, e.end); tp.play();
  };
  const playRow = () => {
    const rows = targets(), token = {}; chain.current = token; let k = 0;
    const next = () => { if (chain.current !== token || k >= rows.length) return; play(rows[k++], () => setTimeout(next, 150)); };
    next();
  };
  const stopAll = () => { chain.current = null; tp.stop(); audio.stop(); setHl(null); };
  useEffect(() => { if (hl) document.getElementById('ce-' + entry.id + '-' + hl)?.scrollIntoView({ block: 'nearest' }); }, [hl, entry.id]);

  const onRemove = async () => {
    if (!corpus) return;
    const rows = targets();
    if (!rows.length) return;
    if (rows.length > 1 && !(await confirmDialog({ title: t('rm.title'), message: t('rm.msg', { n: rows.length, name: corpus.name }), ok: t('rm.ok'), danger: true }))) return;
    removeEntries(corpus.id, rows.map((e) => e.id));
    setChecked([]);
  };
  const onCopy = async () => {
    if (!corpus) return;
    const rows = targets();
    if (!rows.length) return;
    const r = await addToCorpusDialog(rows.map((e) => ({ ...e, origin: 'copy' as const })), { title: t('copy.title'), from: corpus.desc, exclude: corpus.id, canReplace: false });
    if (r) setChecked([]);
  };
  const onSplit = () => {
    if (!corpus || !sound) return;
    const at = tp.time();
    const e = entries.find((x) => entrySound(x)?.meta.id === sound.meta.id && at > x.start && at < x.end && (!hl || x.id === hl)) || entries.find((x) => entrySound(x)?.meta.id === sound.meta.id && at > x.start && at < x.end);
    if (!e || !splitEntry(corpus.id, e.id, at)) { setStatus({ msg: t('split.none'), kind: 'bad' }); return; }
    setStatus({ msg: t('split.done', { n: (index.get(e.id) ?? 0) + 1, t: fmtTime(at) }), kind: 'ok' });
  };

  /* --- export and hand-offs ----------------------------------------------------- */
  const base = corpus ? slug(corpus.name) || 'corpus' : 'corpus';
  const exportJson = () => { if (!corpus) return; saveJSON(corpusToJSON(corpus), base + '.corpus.json'); setExpStatus({ msg: t('exp.json', { n: corpus.entries.length }), kind: 'ok' }); };
  const exportCsv = () => {
    if (!corpus) return;
    csvRows(['file', 'start', 'end', 'label'], entries.length, (i) => [entries[i].file, entries[i].start.toFixed(4), entries[i].end.toFixed(4), entries[i].label], base + '_segments.csv');
    setExpStatus({ msg: t('exp.csv', { n: entries.length }), kind: 'ok' });
  };
  const exportWavs = async () => {
    const rows = targets().filter((e) => entrySound(e));
    if (!rows.length) { setExpStatus({ msg: t('exp.none'), kind: 'bad' }); return; }
    await saveWavZip(rows.map((e) => {
      const s = entrySound(e)!, sr = s.buffer.sampleRate;
      return { name: String((index.get(e.id) ?? 0) + 1).padStart(3, '0') + '_' + (slug(e.label, 30) || slug(e.file.replace(/\.[^.]+$/, ''), 30) || 'son') + '.wav',
        signal: s.signal.subarray(Math.floor(e.start * sr), Math.floor(e.end * sr)), sampleRate: sr };
    }), base + '_wav.zip');
    setExpStatus({ msg: t('exp.wav', { n: rows.length }), kind: 'ok' });
  };
  const handTo = (tool: 'batch' | 'soundmap') => {
    if (!corpus) return;
    setToolState(lesson ? 'lesson:' + tool : tool, { corpusId: corpus.id });
    openItem(lesson ? 'lesson' : 'tool', tool);
  };

  /* --- the waveform: this sound's items, and the selection --------------------------- */
  const mine = sound ? entries.filter((e) => entrySound(e)?.meta.id === sound.meta.id) : [];
  const drawWave = (cv: HTMLCanvasElement) => {
    const { ctx, w, h } = draw.fit(cv, 200);
    ctx.clearRect(0, 0, w, h);
    if (!sound) return;
    const padL = padLeft(), padT = 20, padB = 18, plotW = Math.max(10, w - padL - 8), plotH = Math.max(10, h - padT - padB);
    const dur = sound.buffer.duration, X = (x: number) => padL + (x / dur) * plotW;
    // the items of this sound, as bands numbered like the table (they may overlap)
    mine.forEach((e) => {
      const x0 = X(e.start), x1 = X(e.end), on = e.id === hl, n = (index.get(e.id) ?? 0) + 1;
      ctx.fillStyle = on ? css('--accent-bg') : n % 2 ? css('--sunken') : css('--panel');
      ctx.globalAlpha = on ? 1 : 0.85; ctx.fillRect(x0, padT, Math.max(1, x1 - x0), plotH); ctx.globalAlpha = 1;
      ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(Math.round(x0) + 0.5, padT); ctx.lineTo(Math.round(x0) + 0.5, padT + plotH); ctx.stroke();
      if (x1 - x0 > 14) {
        ctx.fillStyle = on ? css('--accent') : css('--ink-soft'); ctx.font = (on ? '600 ' : '') + '10px ' + css('--mono'); ctx.textAlign = 'center';
        ctx.fillText(String(n), (x0 + x1) / 2, padT - 6);
      }
    });
    const cols = Math.max(1, Math.floor(plotW)), env = envelope(sound.signal, cols);
    let peak = 1e-9; for (let c = 0; c < cols; c++) peak = Math.max(peak, Math.abs(env.mins[c]), Math.abs(env.maxs[c]));
    const mid = padT + plotH / 2, amp = (plotH / 2) * 0.92 / peak;
    ctx.strokeStyle = css('--ink-soft'); ctx.lineWidth = 1; ctx.beginPath();
    for (let c = 0; c < cols; c++) { const x = padL + c + 0.5; ctx.moveTo(x, mid - env.maxs[c] * amp); ctx.lineTo(x, mid - env.mins[c] * amp + 0.5); }
    ctx.stroke();
    if (sel) {
      const a = X(sel[0]), b = X(sel[1]);
      ctx.fillStyle = css('--accent'); ctx.globalAlpha = 0.16; ctx.fillRect(a, padT, Math.max(1, b - a), plotH); ctx.globalAlpha = 1;
      ctx.strokeStyle = css('--accent'); ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(a, padT); ctx.lineTo(a, padT + plotH); ctx.moveTo(b, padT); ctx.lineTo(b, padT + plotH); ctx.stroke();
    }
    ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1; ctx.strokeRect(padL + 0.5, padT + 0.5, plotW - 1, plotH - 1);
    ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
    ctx.textAlign = 'left'; ctx.fillText('0 s', padL, h - 4);
    ctx.textAlign = 'right'; ctx.fillText(dur.toFixed(2) + ' s', padL + plotW, h - 4);
    draw.setGeom(cv, { padL, padT, plotW, plotH });
    cv.dataset.noseek = '1';     // a drag selects; a click seeks (below)
  };
  const timeAt = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), g = draw.geomOf(e.currentTarget);
    return Math.max(0, Math.min(1, (e.clientX - r.left - g.padL) / Math.max(1, g.plotW))) * (sound?.buffer.duration || 0);
  };
  const onDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!sound) return;
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    drag.current = { x0: e.clientX, t0: timeAt(e), moved: false };
  };
  const onMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current; if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 4) return;
    d.moved = true;
    set({ sel: [d.t0, timeAt(e)] });
  };
  const onUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const d = drag.current; drag.current = null;
    if (!d || !sound) return;
    if (d.moved) { const s = [Math.min(d.t0, timeAt(e)), Math.max(d.t0, timeAt(e))] as [number, number]; set({ sel: s }); tp.setRange(s[0], s[1]); return; }
    // a click: on an item, select it; anywhere, move the playhead there
    const at = d.t0, hit = mine.filter((x) => at >= x.start && at < x.end).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
    if (hit) { setHl(hit.id); set({ sel: [hit.start, hit.end] }); }
    tp.setRange(0, null); tp.seek(at);
  };
  const playSel = () => { if (sound && sel) { tp.setRange(sel[0], sel[1]); tp.play(); } };

  /* --- pieces shared by the lesson and the tool ---------------------------------- */
  const corporaList = (
    <>
      {corpora.length ? (
        <ul className="sg-files" aria-label={t('c.list')}>
          {corpora.map((c) => (
            <li key={c.id} className={c.id === corpus?.id ? 'on' : ''}>
              <button type="button" className="link-btn" aria-current={c.id === corpus?.id} onClick={() => set({ cur: c.id })}>{corpusLine(c)}</button>
            </li>
          ))}
        </ul>
      ) : <p className="small muted">{t('c.empty')}</p>}
      <Controls>
        <button type="button" className="primary" onClick={() => void onNew()}>{t('c.new')}</button>
        <button type="button" disabled={!corpus} onClick={() => void onRename()}>{t('c.rename')}</button>
        <button type="button" disabled={!corpus} onClick={onDuplicate}>{t('c.duplicate')}</button>
        <button type="button" disabled={corpora.length < 2} onClick={() => void onMerge()}>{t('c.merge')}</button>
        <button type="button" disabled={!corpus} className="danger" onClick={() => void onDelete()}>{t('c.delete')}</button>
      </Controls>
      <Controls>
        <button type="button" onClick={() => void onImport(false)}>{t('c.importNew')}</button>
        <button type="button" disabled={!corpus} onClick={() => void onImport(true)}>{t('c.importInto')}</button>
      </Controls>
    </>
  );
  const soundsAdder = (
    <SoundAdder ids={Array.from(new Set(entries.map((e) => e.soundId)))} demos={DEMOS} onAdd={addSounds}
      accept="audio/*,.json,.csv,application/json,text/csv" main={tr('corpus.drop')} formats={tr('corpus.dropFormats')}
      onOther={async (fs) => { const id = await importIntoCorpus(fs, corpus?.id ?? null, setStatus); if (id) set({ cur: id }); }} />
  );
  const manual = (
    <>
      <SoundSource value={st.soundId} onChange={(id) => set({ soundId: id, sel: null })} demos={DEMOS} label={t('man.sound')} />
      <Controls>
        <Field label={t('man.start')}><input type="number" step={0.01} min={0} value={sel ? +sel[0].toFixed(3) : ''} disabled={!sound} onChange={(e) => setSelEdge(0, parseFloat(e.target.value))} /></Field>
        <Field label={t('man.end')}><input type="number" step={0.01} min={0} value={sel ? +sel[1].toFixed(3) : ''} disabled={!sound} onChange={(e) => setSelEdge(1, parseFloat(e.target.value))} /></Field>
      </Controls>
      <Controls>
        <Field label={t('man.label')}><input type="text" value={st.label} disabled={!sound} placeholder={t('man.labelPh')} onChange={(e) => set({ label: e.target.value })}
          onKeyDown={(e) => { if (e.key === 'Enter') addSelection(); }} /></Field>
      </Controls>
      <Controls>
        <button type="button" disabled={!sel} onClick={playSel}>{t('man.play')}</button>
        <button type="button" className="primary" disabled={!sel} onClick={addSelection}>{t('man.add')}</button>
        <button type="button" disabled={!sound} onClick={() => sound && set({ sel: [0, sound.buffer.duration] })}>{t('man.all')}</button>
      </Controls>
      {sound ? <p className="small muted">{sel ? t('man.selLine', { a: fmtTime(sel[0]), b: fmtTime(sel[1]), d: (sel[1] - sel[0]).toFixed(2) }) : t('man.dragHint')}</p> : null}
    </>
  );
  const nextBtns = (
    <>
      <button type="button" disabled={!entries.length} onClick={exportJson}>{t('exp.jsonBtn')}</button>
      <button type="button" disabled={!entries.length} onClick={exportCsv}>{t('exp.csvBtn')}</button>
      <button type="button" disabled={!entries.length} onClick={() => void exportWavs()}>{checked.length ? t('exp.wavSelBtn', { n: checked.length }) : t('exp.wavBtn')}</button>
    </>
  );
  const handBtns = (
    <>
      <button type="button" className="primary" disabled={!entries.length} onClick={() => handTo('batch')}>{tr('pipe.toBatchShort')}</button>
      <button type="button" disabled={!entries.length} onClick={() => handTo('soundmap')}>{tr('pipe.toMapShort')}</button>
    </>
  );
  const described = corpus?.desc ? entries.filter((e) => e.values).length : 0;
  const summary = corpus ? t('summary', {
    n: entries.length, files: new Set(entries.map((e) => e.file)).size, dur: fmtTime(entries.reduce((a, e) => a + (e.end - e.start), 0)),
  }) + (corpus.desc ? ' · ' + t('summary.desc', { d: described, f: corpus.desc.features.length }) : '') : '';

  const wavePlot = (fill: boolean) => (
    <Plot fill={fill} className="pointer corpus-wave" transport={tp} deps={[sound, mine, sel, hl, index]} draw={drawWave}
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}
      ariaLabel={sound ? t('wave.aria', { name: sound.meta.name, n: mine.length }) : undefined} />
  );
  const tableBar = (
    <Controls className="corpus-bar">
      <Field label={t('t.filter')}><input type="text" value={st.filter} placeholder={t('t.filterPh')} onChange={(e) => set({ filter: e.target.value })} /></Field>
      <button type="button" disabled={!visible.length} onClick={playRow}>{checked.length ? t('t.playSel', { n: checked.length }) : t('t.playShown')}</button>
      <button type="button" onClick={stopAll}>{t('t.stop')}</button>
      <button type="button" disabled={!visible.length} onClick={() => void onCopy()}>{checked.length ? t('t.copySel', { n: checked.length }) : t('t.copyShown')}</button>
      <button type="button" className="danger" disabled={!checked.length} onClick={() => void onRemove()}>{t('t.removeSel', { n: checked.length })}</button>
    </Controls>
  );
  const origin = (o?: string) => (o ? t('o.' + o) : '');
  const table = corpus && entries.length ? (
    <div className="table-wrap">
      <table className="table">
        <thead><tr>
          <th scope="col"><input type="checkbox" checked={allChecked} aria-label={t('t.all')} onChange={toggleAll} /></th>
          <SortHeader label={t('col.n')} col="n" sort={st.sort} onSort={onSort} />
          <th scope="col">{t('col.play')}</th>
          <SortHeader className="left" label={t('col.file')} col="file" sort={st.sort} onSort={onSort} />
          <SortHeader label={t('col.start')} col="start" sort={st.sort} onSort={onSort} />
          <th scope="col">{t('col.end')}</th>
          <SortHeader label={t('col.dur')} col="dur" sort={st.sort} onSort={onSort} />
          <SortHeader className="left" label={t('col.label')} col="label" sort={st.sort} onSort={onSort} />
          <SortHeader className="left" label={t('col.origin')} col="origin" sort={st.sort} onSort={onSort} />
          <th scope="col" title={t('col.descHint')}>{t('col.desc')}</th>
          <th scope="col"><span className="sr-only">{t('col.remove')}</span></th>
        </tr></thead>
        <tbody>
          {visible.map((e) => {
            const n = (index.get(e.id) ?? 0) + 1, ok = !!entrySound(e);
            return (
              <tr key={e.id} id={'ce-' + entry.id + '-' + e.id} className={(hl === e.id ? 'on' : '') + (ok ? '' : ' off')} onClick={(ev) => { if ((ev.target as HTMLElement).tagName === 'TD') focus(e); }}>
                <td><input type="checkbox" checked={checked.includes(e.id)} aria-label={t('t.check', { n })}
                  onChange={(ev) => setChecked(ev.target.checked ? [...checked, e.id] : checked.filter((x) => x !== e.id))} /></td>
                <td>{n}</td>
                <td><button type="button" disabled={!ok} aria-label={t('play.aria', { n })} onClick={() => play(e)}>▶</button></td>
                <td className="left" title={ok ? '' : t('t.missing')}>{e.file}</td>
                <td><input type="number" className="num" step={0.01} min={0} value={+e.start.toFixed(3)} aria-label={t('start.aria', { n })}
                  onChange={(ev) => { const v = parseFloat(ev.target.value); if (isFinite(v) && v >= 0 && v < e.end) updateEntry(corpus.id, e.id, { start: v }); }} /></td>
                <td><input type="number" className="num" step={0.01} min={0} value={+e.end.toFixed(3)} aria-label={t('end.aria', { n })}
                  onChange={(ev) => { const v = parseFloat(ev.target.value); const max = entrySound(e)?.buffer.duration ?? Infinity; if (isFinite(v) && v > e.start && v <= max + 1e-6) updateEntry(corpus.id, e.id, { end: v }); }} /></td>
                <td>{(e.end - e.start).toFixed(2)}</td>
                <td className="left"><input type="text" value={e.label} aria-label={t('label.aria', { n })} onChange={(ev) => updateEntry(corpus.id, e.id, { label: ev.target.value })} /></td>
                <td className="left small muted">{origin(e.origin)}</td>
                <td>{corpus.desc && e.values ? '✓' : ''}</td>
                <td><button type="button" className="icon-btn" aria-label={t('t.remove', { n })} title={t('t.remove', { n })} onClick={() => removeEntries(corpus.id, [e.id])}>×</button></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  ) : null;

  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        {corporaList}
        <Status s={status} />
      </Panel>
      <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>
        {soundsAdder}
      </Panel>
      <Panel title={t('s3.title')} hintHtml={rich('s3.hint')}>
        {manual}
        <TransportBar tp={tp} />
        {sound ? wavePlot(false) : null}
        {sound ? <Controls><button type="button" onClick={onSplit}>{t('split.btn')}</button></Controls> : null}
        <Status s={status} />
      </Panel>
      <Panel title={t('s4.title')} hintHtml={rich('s4.hint')}>
        {corpus ? <p className="readout">{summary}</p> : null}
        {corpus && entries.length ? <>{tableBar}{table}</> : <p className="small muted">{t('t.empty')}</p>}
      </Panel>
      <Panel title={t('s5.title')} hintHtml={rich('s5.hint')}>
        <Controls>{nextBtns}<span className="grow" />{handBtns}</Controls>
        <Status s={expStatus} />
      </Panel>
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tp} />} side={<>
      <Section id="corpora" title={t('sec.corpora')}>
        {corporaList}
        <Status s={status} />
      </Section>
      <Section id="sounds" title={t('sec.sounds')} help={rich('s2.hint')}>{soundsAdder}</Section>
      <Section id="manual" title={t('sec.manual')} help={rich('s3.hint')}>{manual}</Section>
      <Section id="next" title={t('sec.next')}>
        <Controls>{handBtns}</Controls>
        <Controls>{nextBtns}</Controls>
        <Status s={expStatus} />
      </Section>
    </>}>
      <Split id="main">
        <Pane id="wave" title={t('pane.wave')} weight={0.9} min={110} help={t('man.dragHint')}
          actions={sound ? <>
            <span className="caption">{sound.meta.name} · {t('wave.items', { n: mine.length })}</span>
            <button type="button" onClick={onSplit} title={t('split.hint')}>{t('split.btn')}</button>
          </> : null}>
          {sound ? wavePlot(true) : <Empty>{t('wave.empty')}</Empty>}
        </Pane>
        <Pane id="items" title={corpus ? corpus.name : t('pane.items')} weight={1.8} flush
          actions={corpus ? <span className="caption">{summary}</span> : null}>
          {corpus && entries.length ? (
            <>
              <div className="wb-pane-foot corpus-top">{tableBar}</div>
              {table}
            </>
          ) : <Empty>{corpus ? t('t.empty') : t('c.empty')}</Empty>}
        </Pane>
      </Split>
    </Workbench>
  );
}

