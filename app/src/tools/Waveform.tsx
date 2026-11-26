/* Forme d'onde et échantillonnage — port of ats-forme-onde.html.
   A synthetic sound (or a file from the session), a magnifier down to the
   samples, and a sampling/quantisation section with aliasing made audible. */

import { useEffect, useMemo } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Pane, Section, Split, Workbench } from '../ui/Workbench';
import { useToolState } from '../session/store';
import { useT } from '../i18n/react';
import { Check, Controls, Field, Panel, Plot, Readout, TransportBar, useTransport } from '../ui/kit';
import { SoundSource, useLoadedSound } from '../ui/SoundSource';
import { css, fit } from '../lib/draw';
import { envelope } from '../lib/dsp';
import { toBuffer } from '../lib/audio';
import { fmtTime } from '../lib/fmt';
import { S } from './Waveform.strings';

const SR = 44100, DUR = 2;
const RATES = [44100, 22050, 11025, 8000, 4000, 3000];
const BITS = [16, 8, 4, 2];

type State = { shape: string; freq: number; amp: number; zoom: number; pos: number; dots: boolean; sr: number; bits: number; soundId: string | null; useFile: boolean };
const DEFAULTS: State = { shape: 'sine', freq: 500, amp: 70, zoom: 300, pos: 0, dots: true, sr: 44100, bits: 16, soundId: null, useFile: false };

const freqOf = (v: number) => Math.round(20 * Math.pow(250, v / 1000));   // 20..5000 Hz, log

function shapeValue(shape: string, phase: number) {
  switch (shape) {
    case 'square': return phase < 0.5 ? 1 : -1;
    case 'saw': return 2 * phase - 1;
    case 'triangle': return phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    default: return Math.sin(2 * Math.PI * phase);
  }
}

/** Sample the ideal formula at `sr` — no anti-aliasing on purpose. */
function synth(shape: string, f: number, a: number, sr: number, n: number) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = a * shapeValue(shape, (f * i / sr) % 1);
  const fade = Math.floor(sr * 0.01);
  for (let k = 0; k < fade && k < n / 2; k++) { out[k] *= k / fade; out[n - 1 - k] *= k / fade; }
  return out;
}

export default function Waveform({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('waveform') : findTool('waveform'))!;
  const { t, rich, lang } = useT(S);
  const [st, set] = useToolState<State>(lesson ? 'lesson:waveform' : 'waveform', DEFAULTS);
  const tpSrc = useTransport(), tpSamp = useTransport();
  const loaded = useLoadedSound(st.useFile ? st.soundId : null);
  const file = loaded ? { buffer: loaded.buffer, signal: loaded.signal, name: loaded.meta.name } : null;
  const f = freqOf(st.freq), a = st.amp / 100;

  const synthSig = useMemo(() => synth(st.shape, f, a, SR, SR * DUR), [st.shape, f, a]);
  const sig = file ? file.signal : synthSig;
  const rate = file ? file.buffer.sampleRate : SR;

  useEffect(() => { tpSrc.setBuffer(file ? file.buffer : toBuffer(synthSig, SR)); }, [tpSrc, file?.buffer, synthSig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { tpSamp.setBuffer(null); }, [tpSamp, file?.buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  const sampled = useMemo(() => {
    const levels = Math.pow(2, st.bits);
    let out: Float32Array;
    if (!file) out = synth(st.shape, f, a, st.sr, Math.floor(st.sr * DUR));
    else {
      // nearest-neighbour decimation, no filter — the aliasing is the lesson
      const src = file.signal, srcRate = file.buffer.sampleRate, n = Math.floor(src.length * st.sr / srcRate);
      out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = src[Math.min(src.length - 1, Math.round(i * srcRate / st.sr))];
    }
    const step = 2 / levels;
    for (let k = 0; k < out.length; k++) out[k] = Math.max(-1, Math.min(1 - step, Math.round(out[k] / step) * step));
    return { sig: out, sr: st.sr, levels };
  }, [file?.signal, st.shape, f, a, st.sr, st.bits]); // eslint-disable-line react-hooks/exhaustive-deps

  /* magnifier */
  const total = sig.length / rate * 1000;
  const ms = 0.5 * Math.pow(total / 0.5, 1 - st.zoom / 1000);
  const n = Math.max(2, Math.round(ms / 1000 * rate));
  const start = Math.max(0, Math.min(sig.length - n, Math.round((sig.length - n) * st.pos / 1000)));

  const drawWave = (cv: HTMLCanvasElement) => {
    const slice = sig.subarray(start, start + n);
    const { ctx, w, h } = fit(cv, 220), mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    const showDots = st.dots && n <= w / 4;
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.4;
    if (n > w * 1.5) {
      const env = envelope(slice, Math.floor(w));
      ctx.beginPath();
      // one continuous path through each column's max and min: separate strokes per column read as stripes
      for (let c = 0; c < env.mins.length; c++) {
        const top = mid - env.maxs[c] * mid * 0.92, bot = mid - env.mins[c] * mid * 0.92;
        if (c === 0) ctx.moveTo(c + 0.5, top); else ctx.lineTo(c + 0.5, top);
        ctx.lineTo(c + 0.5, bot);
      }
      ctx.stroke();
    } else {
      ctx.beginPath();
      for (let i = 0; i < n; i++) { const x = i / (n - 1) * w, y = mid - slice[i] * mid * 0.92; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
      ctx.stroke();
      if (showDots) {
        ctx.fillStyle = css('--accent'); ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1;
        for (let j = 0; j < n; j++) {
          const x = j / (n - 1) * w, y = mid - slice[j] * mid * 0.92;
          ctx.beginPath(); ctx.moveTo(x, mid); ctx.lineTo(x, y); ctx.stroke();
          ctx.beginPath(); ctx.arc(x, y, 3, 0, 2 * Math.PI); ctx.fill();
        }
      }
    }
    ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
    ctx.textAlign = 'left'; ctx.fillText(fmtTime(start / rate), 4, h - 5);
    ctx.textAlign = 'right'; ctx.fillText('+' + (ms < 10 ? ms.toFixed(2) : ms.toFixed(1)) + ' ms', w - 4, h - 5);
  };

  /* sampling */
  const ny = st.sr / 2;
  const alias = !file && f > ny ? rich('samp.alias', { f, alias: Math.round(Math.abs(f - st.sr * Math.round(f / st.sr))) }) : '';
  const msS = file ? 8 : Math.min(40, Math.max(4, 4000 / f));
  const drawSamp = (cv: HTMLCanvasElement) => {
    const orig = sig, nO = Math.round(msS / 1000 * rate);
    const s0 = Math.max(0, Math.min(orig.length - nO, Math.round((orig.length - nO) * st.pos / 1000)));
    const s = sampled, startS = Math.round(s0 * s.sr / rate), nS = Math.max(2, Math.round(msS / 1000 * s.sr));
    const { ctx, w, h } = fit(cv, 220), mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1.2; ctx.globalAlpha = 0.7;
    ctx.beginPath();
    for (let i = 0; i < nO; i++) { const x = i / (nO - 1) * w, y = mid - orig[s0 + i] * mid * 0.92; if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y); }
    ctx.stroke(); ctx.globalAlpha = 1;
    // reconstruction: straight lines between the retained samples
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.6;
    ctx.beginPath();
    for (let j = 0; j < nS; j++) {
      const idx = Math.min(s.sig.length - 1, startS + j), x = j / (nS - 1) * w, y = mid - s.sig[idx] * mid * 0.92;
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
    if (nS <= w / 4) {
      ctx.fillStyle = css('--warn');
      for (let k = 0; k < nS; k++) {
        const idx = Math.min(s.sig.length - 1, startS + k);
        ctx.beginPath(); ctx.arc(k / (nS - 1) * w, mid - s.sig[idx] * mid * 0.92, 3.2, 0, 2 * Math.PI); ctx.fill();
      }
    }
    ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
    ctx.textAlign = 'right'; ctx.fillText(msS.toFixed(1) + ' ms', w - 4, h - 5);
  };

  const L = (x: number) => x.toLocaleString(lang);


  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        <Controls>
          <Field label={t('shape.label')}>
            <select value={st.shape} onChange={(e) => set({ shape: e.target.value, useFile: false })}>
              {['sine', 'triangle', 'saw', 'square'].map((k) => <option key={k} value={k}>{t('shape.' + k)}</option>)}
            </select>
          </Field>
          <Field label={<>{t('freq.label')} <span className="val">{f} Hz</span></>}>
            <input type="range" min={0} max={1000} value={st.freq} onChange={(e) => set({ freq: +e.target.value, useFile: false })} />
          </Field>
          <Field label={<>{t('amp.label')} <span className="val">{a.toFixed(2)}</span></>}>
            <input type="range" min={0} max={100} value={st.amp} onChange={(e) => set({ amp: +e.target.value, useFile: false })} />
          </Field>
        </Controls>
        <Readout html={file ? rich('src.file', { name: file.name, dur: file.buffer.duration.toFixed(2), sr: file.buffer.sampleRate })
                             : rich('src.readout', { f, p: (1000 / f).toFixed(2), a: a.toFixed(2) })} />
        <TransportBar tp={tpSrc} />
        <details open={st.useFile}>
          <summary onClick={(e) => { e.preventDefault(); set({ useFile: !st.useFile }); }}>{t('file.summary')}</summary>
          <div style={{ marginTop: '.6rem' }}>
            <SoundSource value={st.soundId} onChange={(id) => set({ soundId: id, useFile: !!id })} demos={['sweep', 'bell', 'pluck', 'noise', 'texture']} />
            {file ? <p className="status ok">{t('st.loaded')}</p> : null}
          </div>
        </details>
      </Panel>

      <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>
        <Controls>
          <Field label={t('zoom.label')}><input type="range" min={0} max={1000} value={st.zoom} onChange={(e) => set({ zoom: +e.target.value })} /></Field>
          <Field label={t('pos.label')}><input type="range" min={0} max={1000} value={st.pos} onChange={(e) => set({ pos: +e.target.value })} /></Field>
          <Check checked={st.dots} onChange={(v) => set({ dots: v })}>{t('dots.label')}</Check>
        </Controls>
        <Readout html={rich('zoom.readout', { ms: ms < 10 ? ms.toFixed(2) : ms.toFixed(0), n: L(n), sr: rate,
          per: file ? '' : t('zoom.period', { k: (ms / 1000 * f).toFixed(1), f }) })} />
        <Plot draw={drawWave} deps={[sig, start, n, st.dots]} transport={tpSrc} ariaLabel={t('wave.aria', { ms: ms.toFixed(1) })} />
      </Panel>

      <Panel title={t('s3.title')} hintHtml={rich('s3.hint')}>
        <Controls>
          <Field label={t('sr.label')}>
            <select value={st.sr} onChange={(e) => set({ sr: +e.target.value })}>{RATES.map((r) => <option key={r} value={r}>{L(r)} Hz</option>)}</select>
          </Field>
          <Field label={t('bits.label')}>
            <select value={st.bits} onChange={(e) => set({ bits: +e.target.value })}>{BITS.map((b) => <option key={b} value={b}>{b} bits</option>)}</select>
          </Field>
          {/* one transport, two buffers: A/B the same passage at will */}
          <button type="button" onClick={() => { tpSamp.setBuffer(file ? file.buffer : toBuffer(synthSig, SR)); tpSamp.play(); }}>{t('btn.playOrig')}</button>
          <button type="button" onClick={() => { tpSamp.setBuffer(toBuffer(sampled.sig, sampled.sr)); tpSamp.play(); }}>{t('btn.playSamp')}</button>
        </Controls>
        <TransportBar tp={tpSamp} />
        <Readout html={rich('samp.readout', { sr: L(st.sr), ny: L(ny), levels: L(sampled.levels) }) + alias} />
        <Plot draw={drawSamp} deps={[sig, sampled, st.pos, msS]} ariaLabel={t('samp.aria', { sr: st.sr })} />
        <p className="caption hint">{t('samp.caption')}</p>
      </Panel>
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tpSrc} />} side={<>
      <Section id="source" title={t('s1.title')}>
        <Controls>
          <Field label={t('shape.label')}>
            <select value={st.shape} onChange={(e) => set({ shape: e.target.value, useFile: false })}>
              {['sine', 'triangle', 'saw', 'square'].map((k) => <option key={k} value={k}>{t('shape.' + k)}</option>)}
            </select>
          </Field>
          <Field label={<>{t('freq.label')} <span className="val">{f} Hz</span></>}>
            <input type="range" min={0} max={1000} value={st.freq} onChange={(e) => set({ freq: +e.target.value, useFile: false })} />
          </Field>
          <Field label={<>{t('amp.label')} <span className="val">{a.toFixed(2)}</span></>}>
            <input type="range" min={0} max={100} value={st.amp} onChange={(e) => set({ amp: +e.target.value, useFile: false })} />
          </Field>
          <Check checked={st.useFile} onChange={(v) => set({ useFile: v })}>{t('file.summary')}</Check>
        </Controls>
        {st.useFile ? (
          <>
            <SoundSource value={st.soundId} onChange={(id) => set({ soundId: id, useFile: !!id })} demos={['sweep', 'bell', 'pluck', 'noise', 'texture']} />
            {file ? <p className="status ok">{t('st.loaded')}</p> : null}
          </>
        ) : null}
        <Readout html={file ? rich('src.file', { name: file.name, dur: file.buffer.duration.toFixed(2), sr: file.buffer.sampleRate })
                             : rich('src.readout', { f, p: (1000 / f).toFixed(2), a: a.toFixed(2) })} />
      </Section>
      <Section id="zoom" title={t('s2.title')}>
        <Controls>
          <Field label={t('zoom.label')}><input type="range" min={0} max={1000} value={st.zoom} onChange={(e) => set({ zoom: +e.target.value })} /></Field>
          <Field label={t('pos.label')}><input type="range" min={0} max={1000} value={st.pos} onChange={(e) => set({ pos: +e.target.value })} /></Field>
          <Check checked={st.dots} onChange={(v) => set({ dots: v })}>{t('dots.label')}</Check>
        </Controls>
        <Readout html={rich('zoom.readout', { ms: ms < 10 ? ms.toFixed(2) : ms.toFixed(0), n: L(n), sr: rate,
          per: file ? '' : t('zoom.period', { k: (ms / 1000 * f).toFixed(1), f }) })} />
      </Section>
      <Section id="sampling" title={t('s3.title')}>
        <Controls>
          <Field label={t('sr.label')}>
            <select value={st.sr} onChange={(e) => set({ sr: +e.target.value })}>{RATES.map((r) => <option key={r} value={r}>{L(r)} Hz</option>)}</select>
          </Field>
          <Field label={t('bits.label')}>
            <select value={st.bits} onChange={(e) => set({ bits: +e.target.value })}>{BITS.map((b) => <option key={b} value={b}>{b} bits</option>)}</select>
          </Field>
          {/* one transport, two buffers: A/B the same passage at will */}
          <button type="button" onClick={() => { tpSamp.setBuffer(file ? file.buffer : toBuffer(synthSig, SR)); tpSamp.play(); }}>{t('btn.playOrig')}</button>
          <button type="button" onClick={() => { tpSamp.setBuffer(toBuffer(sampled.sig, sampled.sr)); tpSamp.play(); }}>{t('btn.playSamp')}</button>
        </Controls>
        <Readout html={rich('samp.readout', { sr: L(st.sr), ny: L(ny), levels: L(sampled.levels) }) + alias} />
      </Section>
    </>}>
      <Split id="main">
        <Pane id="wave" title={t('s2.title')} weight={1.2}>
          <Plot fill draw={drawWave} deps={[sig, start, n, st.dots]} transport={tpSrc} ariaLabel={t('wave.aria', { ms: ms.toFixed(1) })} />
        </Pane>
        <Pane id="samp" title={t('s3.title')} weight={1}>
          <TransportBar tp={tpSamp} />
          <Plot fill draw={drawSamp} deps={[sig, sampled, st.pos, msS]} ariaLabel={t('samp.aria', { sr: st.sr })} />
          <p className="caption hint">{t('samp.caption')}</p>
        </Pane>
      </Split>
    </Workbench>
  );
}
