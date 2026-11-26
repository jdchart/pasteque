/* Guide des descripteurs — port of general-guide-descripteurs.html.
   One chapter per descriptor (the tab's sub-route: #/learn/descriptor-guide/rms):
   what it is for, what it measures and how, examples to listen to with the
   pitfall each one shows, your own sound, the curve with its per-segment
   report, and the magnifier that shows one frame as the descriptor sees it. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { findLesson } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { setTabSub } from '../shell/nav';
import { useToolState } from '../session/store';
import { useT } from '../i18n/react';
import { escapeHtml, Lang, plain, translate, Vars } from '../i18n/core';
import { Check, Controls, Field, Plot, Progress, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { SoundSource, useLoadedSound } from '../ui/SoundSource';
import * as draw from '../lib/draw';
import { css, geomOf } from '../lib/draw';
import { describe, Description, extent, mono } from '../lib/dsp';
import { png, slug } from '../lib/io';
import { fmt as fmtRaw } from '../lib/fmt';
import { log } from '../lib/log';
import { DESC, EX_TRAPS } from './guide.data';
import { S } from './guide.strings';
import { buildExample, drawCurve, frameAt, frameIndexAt, framesIn, LegendItem, loupeBars, loupeSpectrum, loupeWave,
  markSegments, matrixRowMedians, median, meyda, Seg, SPECTRUM_LOUPES, SR } from './guideEngine';

type State = { ownId: string | null; useOwn: boolean; ex: Record<string, number>; logf: boolean; exOpen: boolean; trapsOpen: boolean };
const DEFAULTS: State = { ownId: null, useOwn: false, ex: {}, logf: false, exOpen: true, trapsOpen: true };

/** The guide's strings are plain text with *italic* terms: escape all, then mark. */
const richOf = (lang: Lang) => (key: string, vars?: Vars) => escapeHtml(translate(S, key, vars, lang)).replace(/\*([^*]+)\*/g, '<em>$1</em>');
const H = ({ html, as: As = 'span', className }: { html: string; as?: 'span' | 'p' | 'li' | 'h2' | 'h3' | 'div'; className?: string }) =>
  <As className={className} dangerouslySetInnerHTML={{ __html: html }} />;

export default function DescriptorGuide({ tab }: PaneProps) {
  const entry = findLesson('descriptor-guide')!;
  const { lang } = useT(S);
  const r = useMemo(() => richOf(lang), [lang]);
  const t = (k: string, v?: Vars) => plain(translate(S, k, v, lang));
  const fmt = (v: unknown) => { const s = fmtRaw(v); return lang === 'fr' ? s.replace('.', ',') : s; };

  const [st, set] = useToolState<State>('descriptor-guide', DEFAULTS);
  const d = DESC.find((x) => x.id === tab.sub) || DESC[0];
  const select = (id: string) => setTabSub(tab.id, id);
  const own = useLoadedSound(st.useOwn ? st.ownId : null);
  const exIdx = Math.min(d.ex.length - 1, st.ex[d.id] ?? 0);
  const [size, setSize] = useState(d.ex[exIdx].frame || 1024);
  const tp = useTransport();

  /* the sound: the student's own (kept across chapters), or this chapter's example */
  const example = useMemo(() => (own ? null : buildExample(d.ex[exIdx])), [own, d, exIdx]);
  const source = useMemo(() => {
    if (own) return { key: 'own:' + own.meta.id, buffer: own.buffer, signal: own.signal, name: own.meta.name, segs: [] as Seg[] };
    const b = example!.buffer;
    return { key: 'ex:' + d.id + ':' + exIdx, buffer: b, signal: mono(b), name: t('x.' + d.id + '.' + exIdx + '.label'), segs: example!.segs };
  }, [own, example]); // eslint-disable-line react-hooks/exhaustive-deps
  const isExample = !own;

  // every example states its frame size: what it shows depends on it
  useEffect(() => { if (!own) setSize(d.ex[exIdx].frame || 1024); }, [d.id, exIdx, own]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { tp.setBuffer(source.buffer); log.ok(plain(source.name) + ' — ' + source.buffer.duration.toFixed(2) + ' s, ' + source.buffer.sampleRate + ' Hz'); }, [source.buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  /* analysis, cached per sound, descriptor and frame size */
  const cache = useRef(new Map<string, Description>());
  // a result is kept with the key it was computed for: just after a change of
  // chapter, sound or frame size, the previous one must not be drawn as this one
  const curKey = source.key + ':' + d.feat + ':' + size;
  const [held, setHeld] = useState<{ key: string; res: Description } | null>(null);
  const result = held && held.key === curKey ? held.res : null;
  const setResult = (res: Description | null, key = curKey) => setHeld(res ? { key, res } : null);
  const [prog, setProg] = useState<number | null>(null);
  const [status, setStatus] = useState<StatusMsg>(null);
  const token = useRef(0);
  useEffect(() => {
    const key = curKey, my = ++token.current;
    if (source.signal.length < size) { setResult(null); setStatus({ msg: t('st.tooshort'), kind: 'bad' }); return; }
    const hit = cache.current.get(key);
    if (hit) { setResult(hit); setProg(null); return; }
    setResult(null); setProg(0);
    setStatus({ msg: t('st.running', { name: t('d.' + d.id + '.name') }) });
    describe(source.signal, source.buffer.sampleRate, [d.feat], { frameSize: size, hopSize: size / 2, onProgress: (p) => { if (my === token.current) setProg(p); } })
      .then((res) => {
        if (d.feat === 'spectralSpread') {        // bins → Hz, to sit beside the centroid
          const v = res.features.spectralSpread, k = res.sampleRate / size;
          for (let i = 0; i < v.length; i++) v[i] *= k;
        }
        cache.current.set(key, res);
        if (my !== token.current) return;
        setResult(res, key); setProg(null);
        setStatus({ msg: t('st.done', { name: t('d.' + d.id + '.name'), n: res.nFrames.toLocaleString(lang) }), kind: 'ok' });
      })
      .catch((e) => { if (my === token.current) { setProg(null); setStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' }); } });
  }, [source.key, d.feat, size]); // eslint-disable-line react-hooks/exhaustive-deps

  const unit = d.unit ? t(d.unit) : '';
  const pcNames = t('pc').split(',');
  const series = result ? result.features[d.feat] : undefined;
  const dur = source.buffer.duration;

  /* per-segment report: what the example is there to show */
  const report = useMemo(() => {
    if (!result || !isExample || !source.segs.length) return '';
    const parts: string[] = [];
    if (d.id === 'mfcc') {
      const m = result.matrices.mfcc, prof: number[][] = [];
      source.segs.forEach((s) => { const med = matrixRowMedians(m, framesIn(result, s), 0); prof.push(med.slice(1)); parts.push(s.lab + '  c0 ' + fmt(med[0]) + ' · c1 ' + fmt(med[1])); });
      const dist: string[] = [];
      for (let a = 0; a < source.segs.length; a++) for (let b = a + 1; b < source.segs.length; b++) {
        let s2 = 0; for (let k = 0; k < prof[a].length; k++) s2 += Math.pow(prof[a][k] - prof[b][k], 2);
        dist.push(source.segs[a].lab + '–' + source.segs[b].lab + ' ' + fmt(Math.sqrt(s2)));
      }
      return parts.join('   |   ') + '\n' + t('mfcc.dist') + (lang === 'fr' ? ' : ' : ': ') + dist.join(' · ');
    }
    if (d.id === 'chroma') {
      const c = result.matrices.chroma;
      source.segs.forEach((s) => {
        const lit = matrixRowMedians(c, framesIn(result, s), 0).map((v, k) => ({ k, v })).filter((o) => o.v >= 0.5).sort((x, y) => y.v - x.v);
        parts.push(s.lab + '  ' + (lit.length ? lit.map((o) => pcNames[o.k] + ' ' + fmt(o.v)).join(', ') : t('seg.none')));
      });
      return parts.join('   |   ');
    }
    if (!series) return '';
    source.segs.forEach((s) => {
      const vals = framesIn(result, s).map((i) => series[i]), m = median(vals);
      let txt = isFinite(m.med) ? fmt(m.med) + (unit ? ' ' + unit : '') : t('seg.none');
      if (d.id === 'flux' && isFinite(m.med)) txt = t('seg.medmax', { med: fmt(m.med), max: fmt(extent(vals)!.max) });
      if (isFinite(m.med) && m.nan > 0.2) txt += ' (' + t('seg.nan', { p: Math.round(m.nan * 100) }) + ')';
      parts.push(s.lab + '  ' + txt);
    });
    return parts.join('   |   ');
  }, [result, isExample, source, d, lang]); // eslint-disable-line react-hooks/exhaustive-deps
  const meas = report ? t('meas.title') + '\n' + report.replace(/^\s+/, '') : '';

  const stats = useMemo(() => {
    if (!result || !series) return '';
    const m = median(series), ext = extent(series);
    if (!ext) return r('stats.none');
    const u = unit ? ' ' + unit : '';
    return escapeHtml(t('stats', { med: fmt(m.med) + u, min: fmt(ext.min) + u, max: fmt(ext.max) + u }) + (m.nan > 0.005 ? t('stats.nan', { p: Math.round(m.nan * 100) }) : ''));
  }, [result, series, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  /* curve */
  const [bands, setBands] = useState(false);
  const drawMain = (cv: HTMLCanvasElement) => {
    if (!result) { draw.clear(cv, 60); return; }
    const label = t('d.' + d.id + '.name');
    if (d.id === 'mfcc') {
      const m = result.matrices.mfcc, rows = m.rows - 1, yl = [];
      for (let k = 1; k <= rows; k += 2) yl.push({ row: k - 0.5, text: 'c' + k });
      draw.heat(cv, { rows, cols: m.cols, data: m.data.subarray(m.cols) }, { height: 190, label: 'MFCC c1–c12', x1: fmt(dur) + ' s', yLabels: yl });
      setBands(false);
    } else if (d.id === 'chroma') {
      const yl = pcNames.map((n, i) => ({ row: i + 0.5, text: n }));
      draw.heat(cv, result.matrices.chroma, { height: 220, min: 0, max: 1, label, x1: fmt(dur) + ' s', yLabels: yl });
      setBands(false);
    } else if (series) {
      setBands(drawCurve(cv, result, series, dur, label, unit, t('curve.none'), d.feat === 'spectralFlux'));
    }
    if (isExample) markSegments(cv, source.segs, dur, 16);
  };

  /* the magnifier follows the playhead: on every seek, and while playing */
  const [loupeT, setLoupeT] = useState(0);
  useEffect(() => tp.onSeek((x) => setLoupeT(x)), [tp]);
  useEffect(() => tp.onFrame((x) => { if (tp.playing()) setLoupeT(x); }), [tp]);
  const fi = result ? frameIndexAt(result, loupeT) : -1;
  const valueText = () => {
    if (d.id === 'mfcc' || d.id === 'chroma') return t('d.' + d.id + '.tab');
    const v = series ? series[fi] : NaN;
    return t('d.' + d.id + '.tab') + ' = ' + (isFinite(v) ? fmt(v) + (unit ? ' ' + unit : '') : '—');
  };
  const [loupeLegend, setLoupeLegend] = useState<LegendItem[]>([]);
  const drawLoupe = (cv: HTMLCanvasElement) => {
    if (!result) { draw.clear(cv, 60); setLoupeLegend([]); return; }
    const frame = frameAt(result, source.signal, fi), L = d.loupe;
    let items: LegendItem[];
    if (L === 'rms' || L === 'zcr' || L === 'pitch') items = loupeWave(cv, frame, L, series ? series[fi] : NaN, result.sampleRate);
    else if (L === 'bark') items = loupeBars(cv, meyda(result, ['loudness'], frame).loudness?.specific, { lg: 'lg.bark' });
    else if (L === 'mfcc') items = loupeBars(cv, meyda(result, ['mfcc'], frame).mfcc, { lg: 'mfcc', signed: true, labels: 'c' });
    else if (L === 'chroma') items = loupeBars(cv, meyda(result, ['chroma'], frame).chroma, { lg: 'lg.chroma', max: 1, labels: 'pc', pc: pcNames });
    else items = loupeSpectrum(cv, result, frame, fi > 0 ? frameAt(result, source.signal, fi - 1) : null, L, st.logf, t('lg.silent'));
    setLoupeLegend((old) => (JSON.stringify(old) === JSON.stringify(items) ? old : items));
  };
  const loupeRead = result ? r('loupe.read', { i: fi, t: fmt(result.times[fi]), v: valueText() }) : r('loupe.empty');

  /* traps: those this example brings out; for the student's own sound, all of them */
  const all = Array.from({ length: d.nTraps }, (_, i) => i);
  const shown = isExample ? (EX_TRAPS[d.id][exIdx] || []) : all;
  const rest = all.filter((i) => !shown.includes(i));

  const frameHint = (() => {
    const sr = source.buffer.sampleRate || SR, hop = size / 2;
    let s = t('frame.hint', { size, hop, ms: fmt(size / sr * 1000), hz: fmt(sr / size) });
    if (d.id === 'pitch') s += t('frame.pitch', { f: String(Math.round(Math.max(50, 2 * sr / size))) });
    // a semitone is f·(2^(1/12) − 1) ≈ 0.0595 f wide: below f = bin / 0.0595 two notes share a bin
    if (d.id === 'chroma') s += t('frame.chroma', { f: String(Math.round(sr / size / 0.0595)) });
    return s;
  })();

  /* tabs: arrows, Home, End */
  const onTabsKey = (e: React.KeyboardEvent) => {
    const i = DESC.indexOf(d); let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % DESC.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + DESC.length) % DESC.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = DESC.length - 1;
    if (j < 0) return;
    e.preventDefault(); select(DESC[j].id);
    setTimeout(() => document.getElementById('gd-tab-' + DESC[j].id)?.focus(), 0);
  };

  /* export: title, settings and measurements as text, then the three canvases */
  const waveCv = useRef<HTMLCanvasElement | null>(null), curveCv = useRef<HTMLCanvasElement | null>(null), loupeCv = useRef<HTMLCanvasElement | null>(null);
  const exportPng = () => {
    if (!result || !waveCv.current || !curveCv.current || !loupeCv.current) return;
    const dpr = window.devicePixelRatio || 1, cvs = [waveCv.current, curveCv.current, loupeCv.current];
    const pad = Math.round(16 * dpr), W = Math.max(...cvs.map((c) => c.width)) + 2 * pad, maxW = W - 2 * pad;
    const probe = document.createElement('canvas').getContext('2d')!, sans = css('--sans'), monoF = css('--mono');
    const wrap = (text: string, font: string) => {
      probe.font = font; const lines: string[] = []; let cur = '';
      String(text).split(/\s+/).forEach((w) => { const tt = cur ? cur + ' ' + w : w; if (probe.measureText(tt).width > maxW && cur) { lines.push(cur); cur = w; } else cur = tt; });
      if (cur) lines.push(cur);
      return lines;
    };
    const F = (px: number, weight = '') => weight + ' ' + Math.round(px * dpr) + 'px ';
    type Block = { lines: string[]; font: string; color: string; lh: number } | { gap: number } | { canvas: HTMLCanvasElement; head?: boolean };
    const blocks: Block[] = [];
    const text = (s: string, font: string, color: string, lh: number) => { if (s) blocks.push({ lines: wrap(s, font), font, color, lh: Math.round(lh * dpr) }); };
    text(t('d.' + d.id + '.name') + ' — ' + plain(source.name), F(17, '600') + sans, '--ink', 24);
    text(t('png.frame', { size: result.frameSize, hop: result.hopSize, sr: result.sampleRate }) + ' · ' + plain(caption), F(12) + sans, '--ink-soft', 18);
    text(plain(stats.replace(/<[^>]+>/g, '')), F(12) + monoF, '--ink', 18);
    meas.split('\n').forEach((l) => text(l, F(12) + monoF, '--ink', 18));
    if (isExample) text(t('x.' + d.id + '.' + exIdx + '.shows'), F(12) + sans, '--ink-soft', 18);
    blocks.push({ gap: Math.round(6 * dpr) }, { canvas: cvs[0], head: true }, { canvas: cvs[1], head: true }, { gap: Math.round(10 * dpr) });
    text(t('png.cursor', { t: fmt(+tp.time().toFixed(2)) }) + ' · ' + plain(loupeRead.replace(/<[^>]+>/g, '')), F(12) + monoF, '--ink', 18);
    blocks.push({ canvas: cvs[2] });
    text(loupeLegend.map(([, k]) => t(k)).join(' · '), F(11) + sans, '--ink-soft', 16);
    let Ht = pad;
    blocks.forEach((b) => { Ht += 'gap' in b ? b.gap : 'canvas' in b ? b.canvas.height + Math.round(4 * dpr) : b.lines.length * b.lh; });
    Ht += pad;
    const out = document.createElement('canvas'); out.width = W; out.height = Ht;
    const ctx = out.getContext('2d')!;
    ctx.fillStyle = css('--panel'); ctx.fillRect(0, 0, W, Ht);
    let y = pad; const now = tp.time();
    blocks.forEach((b) => {
      if ('gap' in b) { y += b.gap; return; }
      if ('canvas' in b) {
        ctx.drawImage(b.canvas, pad, y);
        const g = geomOf(b.canvas);
        if (b.head) {           // the playhead, where the student left it
          const x = pad + (g.padL + now / dur * g.plotW) * dpr;
          ctx.strokeStyle = css('--bad'); ctx.lineWidth = Math.max(1, 1.5 * dpr);
          ctx.beginPath(); ctx.moveTo(x, y + g.padT * dpr); ctx.lineTo(x, y + (g.padT + g.plotH) * dpr); ctx.stroke();
        }
        y += b.canvas.height + Math.round(4 * dpr); return;
      }
      ctx.font = b.font; ctx.fillStyle = css(b.color); ctx.textBaseline = 'top';
      b.lines.forEach((l) => { ctx.fillText(l, pad, y); y += b.lh; });
    });
    const name = (slug(d.id + '-' + plain(source.name)) || d.id) + '.png';
    png(out, name);
    setStatus({ msg: t('png.saved', { name }), kind: 'ok' });
    log.ok('PNG ' + W + '×' + Ht + ' — ' + name);
  };

  const caption = r('caption.loaded', { name: source.name, dur: fmt(dur), sr: source.buffer.sampleRate, ch: source.buffer.numberOfChannels });
  const legendRow = (items: LegendItem[], band?: boolean) => (
    <div className="gd-legend">{items.map(([c, k]) => <span key={k} className={band ? 'gd-band' : ''} style={{ ['--sw' as string]: css(c) }} dangerouslySetInnerHTML={{ __html: r(k) }} />)}</div>
  );

  return (
    <ToolFrame entry={entry} lede={r('lede')}>
      <details className="gd-common">
        <summary><H html={r('common.title')} /></summary>
        <ul>{[1, 2, 3, 4].map((i) => <H key={i} as="li" html={r('common.' + i)} />)}</ul>
      </details>

      <div className="gd-tabs" role="tablist" aria-label={t('tabs.aria')} onKeyDown={onTabsKey}>
        {DESC.map((x) => (
          <button key={x.id} id={'gd-tab-' + x.id} type="button" role="tab" aria-selected={x === d} tabIndex={x === d ? 0 : -1}
            className={'gd-tab' + (x === d ? ' on' : '')} onClick={() => select(x.id)} dangerouslySetInnerHTML={{ __html: r('d.' + x.id + '.tab') }} />
        ))}
      </div>

      <section className="panel s-card gd-panel" role="tabpanel" aria-labelledby={'gd-tab-' + d.id}>
        <div className="gd-head"><H as="h2" html={r('d.' + d.id + '.name')} /><code>{d.feat}</code></div>
        <div className="gd-use"><H as="h3" html={r('h.use')} /><H as="p" html={r('d.' + d.id + '.use')} /></div>
        <div className="gd-how">
          {(['what', 'how', 'tool'] as const).map((k) => <div key={k}><H as="h3" html={r('h.' + k)} /><H as="p" html={r('d.' + d.id + '.' + k)} /></div>)}
        </div>

        <div className="gd-row">
          <Field label={t('ex.label')}>
            <select className="gd-ex" value={own ? '' : String(exIdx)} onChange={(e) => {
              if (e.target.value === '') return;
              set((s) => ({ useOwn: false, ex: { ...s.ex, [d.id]: +e.target.value } }));
            }}>
              <option value="">{own ? t('ex.own', { name: own.meta.name }) : t('ex.pick')}</option>
              {d.ex.map((_, i) => <option key={i} value={i}>{t('x.' + d.id + '.' + i + '.label')}</option>)}
            </select>
          </Field>
          <Field label={t('opt.frame')}>
            <select value={size} onChange={(e) => setSize(+e.target.value)}>{[512, 1024, 2048, 4096].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
        </div>
        <details className="gd-own">
          <summary>{t('drop.main')}</summary>
          <SoundSource value={st.ownId} onChange={(id) => set({ ownId: id, useOwn: !!id })} demos={['sine', 'sweep', 'noise', 'bell', 'pluck', 'texture']} />
          {own ? <button type="button" className="link-btn" onClick={() => set({ useOwn: false })}>← {t('ex.pick')}</button> : null}
        </details>
        <p className="hint" dangerouslySetInnerHTML={{ __html: escapeHtml(frameHint).replace(/\*([^*]+)\*/g, '<em>$1</em>') }} />

        <div className="gd-notes">
          <details className="gd-example" open={st.exOpen} onToggle={(e) => { const o = (e.target as HTMLDetailsElement).open; if (o !== st.exOpen) set({ exOpen: o }); }}>
            <summary><H as="h3" html={r('h.example')} /></summary>
            <H as="p" html={isExample ? r('x.' + d.id + '.' + exIdx + '.shows') : r('ex.ownNote')} />
            <div className="gd-meas">{meas}</div>
          </details>
          <details className="gd-traps" open={st.trapsOpen} onToggle={(e) => { const o = (e.target as HTMLDetailsElement).open; if (o !== st.trapsOpen) set({ trapsOpen: o }); }}>
            <summary><H as="h3" html={r(isExample ? 'h.traps' : 'h.trapsAll')} /></summary>
            {shown.length ? <ul>{shown.map((i) => <H key={i} as="li" html={r('d.' + d.id + '.trap' + i)} />)}</ul> : <H as="p" html={r('traps.none')} />}
            {rest.length ? (
              <details className="gd-others">
                <summary><H html={r('h.trapsOther', { n: rest.length })} /></summary>
                <ul>{rest.map((i) => <H key={i} as="li" html={r('d.' + d.id + '.trap' + i)} />)}</ul>
              </details>
            ) : null}
          </details>
        </div>

        <TransportBar tp={tp} />
        <H as="p" className="caption" html={caption} />
        <Plot canvasRef={waveCv} transport={tp} deps={[source, d.id]} draw={(cv) => { draw.waveform(cv, source.signal, { label: plain(source.name), height: 90 }); if (isExample) markSegments(cv, source.segs, dur, 3); }} />
        <Plot canvasRef={curveCv} transport={tp} deps={[result, d.id, source]} draw={drawMain} />
        {bands && result && d.id !== 'mfcc' && d.id !== 'chroma' ? legendRow([['--line', 'curve.band']], true) : null}
        <Progress value={prog} />
        <Status s={status} />
        <p className="gd-readout" dangerouslySetInnerHTML={{ __html: stats }} />
        <Controls><button type="button" disabled={!result} onClick={exportPng}>{t('btn.png')}</button></Controls>

        <H as="h3" html={r('loupe.title')} />
        <H as="p" className="hint" html={r('loupe.hint')} />
        {SPECTRUM_LOUPES.includes(d.loupe) ? <Controls><Check checked={st.logf} onChange={(v) => set({ logf: v })}>{t('loupe.log')}</Check></Controls> : null}
        <p className="gd-readout" dangerouslySetInnerHTML={{ __html: loupeRead }} />
        <Plot canvasRef={loupeCv} deps={[result, fi, d.id, st.logf, source]} draw={drawLoupe} ariaLabel={plain(loupeRead.replace(/<[^>]+>/g, ''))} />
        {legendRow(loupeLegend)}
      </section>
    </ToolFrame>
  );
}
