/* Synthèse additive — port of ats-synthese-additive.html.
   Up to 16 partials, presets, inharmonic stretch, per-partial decay, the
   cumulative "fusion" sequence, a spectrum view and a two-period waveform. */

import { useEffect, useMemo, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Pane, Section, Split, Workbench } from '../ui/Workbench';
import { useToolState } from '../session/store';
import { useT } from '../i18n/react';
import { Controls, Field, Panel, Plot, Readout, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { css, fit } from '../lib/draw';
import * as audio from '../lib/audio';
import { saveWav } from '../lib/io';
import { S } from './Additive.strings';

const MAXP = 16, DUR = 2.5, STEP = 450;
type Preset = 'sine' | 'saw' | 'square' | 'clar' | 'formant' | 'bell';
const PRESETS: Record<Preset, (k: number) => number> = {
  sine: (k) => (k === 1 ? 1 : 0),
  saw: (k) => 1 / k,
  square: (k) => (k % 2 ? 1 / k : 0),
  clar: (k) => (k % 2 ? 1 / (k * k) * (k === 1 ? 1 : 2.2) : 0),
  formant: (k) => Math.exp(-Math.pow((k - 4) / 1.6, 2)) + (k === 1 ? 0.5 : 0),
  bell: (k) => 1 / Math.pow(k, 0.7),
};
const presetAmps = (p: Preset) => Array.from({ length: MAXP }, (_, i) => Math.min(1, PRESETS[p](i + 1)));

type State = { preset: Preset; f0: number; stretch: number; npart: number; decay: 'none' | 'equal' | 'high'; amps: number[] };
const DEFAULTS: State = { preset: 'saw', f0: 380, stretch: 0, npart: 12, decay: 'high', amps: presetAmps('saw') };

export default function Additive({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('additive') : findTool('additive'))!;
  const { t, rich } = useT(S);
  const [st, set] = useToolState<State>(lesson ? 'lesson:additive' : 'additive', DEFAULTS);
  const tp = useTransport();
  const [status, setStatus] = useState<StatusMsg>(null);
  const seqStop = useRef<(() => void) | null>(null);

  const f0 = Math.round(40 * Math.pow(25, st.f0 / 1000));            // 40..1000 Hz
  const expo = 1 + st.stretch / 100 * 0.5;                            // 1 .. 1.5
  const N = st.npart, amps = st.amps;
  const pf = (k: number) => f0 * Math.pow(k, expo);
  const env = (k: number, tt: number) => (st.decay === 'none' ? 1 : Math.exp(-(st.decay === 'high' ? 0.8 + 0.5 * k : 1.6) * tt));

  const render = (sr: number, dur: number, which: number | null = null) => {
    const n = Math.floor(sr * dur), out = new Float32Array(n);
    let norm = 0;
    for (let k = 1; k <= N; k++) if (!which || which === k) norm += amps[k - 1];
    norm = norm > 1 ? 0.8 / norm : 0.8;
    for (let k = 1; k <= N; k++) {
      if (which && which !== k) continue;
      const a = amps[k - 1] * norm; if (!a) continue;
      const f = pf(k); if (f > sr / 2) continue;
      const w = 2 * Math.PI * f / sr;
      for (let i = 0; i < n; i++) out[i] += a * env(k, i / sr) * Math.sin(w * i);
    }
    const fade = Math.floor(sr * 0.01);
    for (let j = 0; j < fade; j++) { out[j] *= j / fade; out[n - 1 - j] *= j / fade; }
    return out;
  };

  /* The transport always holds the sound the spectrum describes. Debounced:
     dragging a slider must not re-render 60 times a second. */
  const key = JSON.stringify([amps, f0, expo, N, st.decay]);
  useEffect(() => {
    const id = setTimeout(() => {
      const sr = audio.ctx().sampleRate, was = tp.playing();
      tp.setBuffer(audio.toBuffer(render(sr, DUR), sr));
      if (was) tp.play();
    }, 120);
    return () => clearTimeout(id);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => () => seqStop.current?.(), []);

  const applyPreset = (p: Preset) => {
    const patch: Partial<State> = { preset: p, amps: presetAmps(p) };
    if (p === 'bell') { patch.stretch = 40; patch.decay = 'high'; } else if (p !== 'formant') patch.stretch = 0;
    set(patch);
  };
  const setAmp = (k: number, v: number) => set((s) => { const a = s.amps.slice(); a[k - 1] = v; return { amps: a }; });

  const playPartial = (k: number) => {
    const sr = audio.ctx().sampleRate;
    audio.play(audio.toBuffer(render(sr, 1.2, k), sr));
  };

  /* The fusion demo: partials enter cumulatively, one every STEP ms, all held. */
  const playSeq = () => {
    const c = audio.ctx(), master = audio.master();
    const oscs: OscillatorNode[] = [], gains: GainNode[] = [];
    const t0 = c.currentTime + 0.05;
    let norm = 0;
    for (let k = 1; k <= N; k++) norm += amps[k - 1];
    norm = norm > 1 ? 0.8 / norm : 0.8;
    for (let k = 1; k <= N; k++) {
      const f = pf(k), a = amps[k - 1] * norm;
      if (!a || f > c.sampleRate / 2) continue;
      const o = c.createOscillator(), g = c.createGain();
      o.frequency.value = f;
      const tIn = t0 + (k - 1) * STEP / 1000;
      g.gain.setValueAtTime(0, t0); g.gain.setValueAtTime(0, tIn); g.gain.linearRampToValueAtTime(a, tIn + 0.02);
      o.connect(g); g.connect(master); o.start(t0);
      oscs.push(o); gains.push(g);
    }
    const tEnd = t0 + (N - 1) * STEP / 1000 + 2.0;
    gains.forEach((g) => { g.gain.setValueAtTime(g.gain.value, tEnd - 0.1); g.gain.linearRampToValueAtTime(0, tEnd); });
    oscs.forEach((o) => o.stop(tEnd + 0.05));
    const stopAll = () => { oscs.forEach((o) => { try { o.stop(); } catch { /* done */ } }); seqStop.current = null; };
    audio.claim(null, { stopped: stopAll });      // any other playback ends the sequence
    seqStop.current = stopAll;
    setStatus({ msg: t('st.seq', { ms: STEP }) });
  };

  const drawSpectrum = (cv: HTMLCanvasElement) => {
    const { ctx, w, h } = fit(cv, 200), padL = 8, padB = 20, padT = 8;
    ctx.clearRect(0, 0, w, h);
    const fMax = Math.max(pf(N) * 1.08, f0 * 4);
    const x = (hz: number) => padL + hz / fMax * (w - padL - 8);
    ctx.strokeStyle = css('--line-firm'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(padL, h - padB + 0.5); ctx.lineTo(w - 8, h - padB + 0.5); ctx.stroke();
    ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
    const tick = fMax > 4000 ? 2000 : fMax > 1500 ? 500 : 200;
    ctx.textAlign = 'center';
    for (let hz = 0; hz <= fMax; hz += tick) ctx.fillText(hz >= 1000 ? (hz / 1000) + 'k' : String(hz), x(hz), h - 5);
    for (let k = 1; k <= N; k++) {
      const a = amps[k - 1], xx = x(pf(k)), top = padT + (1 - a) * (h - padT - padB);
      ctx.strokeStyle = a ? css('--accent') : css('--line'); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(xx, h - padB); ctx.lineTo(xx, top); ctx.stroke();
      if (a > 0.03) { ctx.fillStyle = css('--ink'); ctx.fillText(String(k), xx, top - 4); }
    }
  };

  const drawWave = (cv: HTMLCanvasElement) => {
    const { ctx, w, h } = fit(cv, 200), mid = h / 2;
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = css('--line'); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();
    let norm = 0;
    for (let k = 1; k <= N; k++) norm += amps[k - 1];
    norm = norm > 1 ? 0.9 / norm : 0.9;
    const span = 2 / f0;
    ctx.strokeStyle = css('--accent'); ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let px = 0; px < w; px++) {
      const tt = px / w * span; let v = 0;
      for (let k = 1; k <= N; k++) v += amps[k - 1] * norm * Math.sin(2 * Math.PI * pf(k) * tt);
      const y = mid - v * mid * 0.92;
      if (px === 0) ctx.moveTo(px, y); else ctx.lineTo(px, y);
    }
    ctx.stroke();
    ctx.fillStyle = css('--ink-soft'); ctx.font = '11px ' + css('--mono');
    ctx.textAlign = 'right'; ctx.fillText((span * 1000).toFixed(2) + ' ms', w - 4, h - 5);
  };

  const readout = useMemo(() => rich('readout', {
    f0, n: N, top: Math.round(pf(N)), law: expo === 1 ? t('law.harm') : t('law.stretch', { e: expo.toFixed(2) }),
  }), [rich, t, f0, N, expo]); // eslint-disable-line react-hooks/exhaustive-deps


  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        <Controls>
          <Field label={t('preset.label')}>
            <select value={st.preset} onChange={(e) => applyPreset(e.target.value as Preset)}>
              {(Object.keys(PRESETS) as Preset[]).map((p) => <option key={p} value={p}>{t('preset.' + p)}</option>)}
            </select>
          </Field>
          <Field label={<>{t('f0.label')} <span className="val">{f0} Hz</span></>}>
            <input type="range" min={0} max={1000} value={st.f0} onChange={(e) => set({ f0: +e.target.value })} />
          </Field>
          <Field label={<>{t('stretch.label')} <span className="val">{expo.toFixed(2)}</span></>}>
            <input type="range" min={0} max={100} value={st.stretch} onChange={(e) => set({ stretch: +e.target.value })} />
          </Field>
          <Field label={t('npart.label')}>
            <select value={st.npart} onChange={(e) => set({ npart: +e.target.value })}>{[4, 8, 12, 16].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
        </Controls>
        <Readout html={readout} />

        <div className="sa-partials" role="group" aria-label={t('partials.aria')}>
          {Array.from({ length: N }, (_, i) => i + 1).map((k) => (
            <div className="sa-partial" key={k}>
              <span className="sa-k">{k}</span>
              <input type="range" min={0} max={100} value={Math.round(amps[k - 1] * 100)} aria-label={'k = ' + k}
                onChange={(e) => setAmp(k, +e.target.value / 100)} />
              <span className="sa-hz">{Math.round(pf(k))} Hz</span>
              <button type="button" aria-label={t('partial.solo', { k })} onClick={() => playPartial(k)}>▶</button>
            </div>
          ))}
        </div>

        <Controls>
          <Field label={t('decay.label')}>
            <select value={st.decay} onChange={(e) => set({ decay: e.target.value as State['decay'] })}>
              {['none', 'equal', 'high'].map((d) => <option key={d} value={d}>{t('decay.' + d)}</option>)}
            </select>
          </Field>
          <button type="button" className="primary" onClick={playSeq}>{t('btn.seq')}</button>
          <button type="button" onClick={() => audio.stop()}>{t('btn.stop')}</button>
          <button type="button" onClick={() => {
            const sr = 44100; saveWav(render(sr, DUR), sr, 'additive_' + f0 + 'Hz.wav');
            setStatus({ msg: t('st.wav', { dur: DUR, sr }), kind: 'ok' });
          }}>{t('btn.wav')}</button>
        </Controls>
        <TransportBar tp={tp} />
        <Status s={status} />
      </Panel>

      <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>
        <div className="cols">
          <div><p className="caption">{t('view.spectrum')}</p><Plot draw={drawSpectrum} deps={[key]} ariaLabel={t('spec.aria', { n: N })} /></div>
          <div><p className="caption">{t('view.wave')}</p><Plot draw={drawWave} deps={[key]} ariaLabel={t('wave.aria')} /></div>
        </div>
      </Panel>
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tp} />} side={<>
      <Section id="sound" title={t('s1.title')}>
        <Controls>
          <Field label={t('preset.label')}>
            <select value={st.preset} onChange={(e) => applyPreset(e.target.value as Preset)}>
              {(Object.keys(PRESETS) as Preset[]).map((p) => <option key={p} value={p}>{t('preset.' + p)}</option>)}
            </select>
          </Field>
          <Field label={<>{t('f0.label')} <span className="val">{f0} Hz</span></>}>
            <input type="range" min={0} max={1000} value={st.f0} onChange={(e) => set({ f0: +e.target.value })} />
          </Field>
          <Field label={<>{t('stretch.label')} <span className="val">{expo.toFixed(2)}</span></>}>
            <input type="range" min={0} max={100} value={st.stretch} onChange={(e) => set({ stretch: +e.target.value })} />
          </Field>
          <Field label={t('npart.label')}>
            <select value={st.npart} onChange={(e) => set({ npart: +e.target.value })}>{[4, 8, 12, 16].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
        </Controls>
        <Readout html={readout} />
      </Section>
      <Section id="listen" title={t('btn.seq')}>
        <Controls>
          <Field label={t('decay.label')}>
            <select value={st.decay} onChange={(e) => set({ decay: e.target.value as State['decay'] })}>
              {['none', 'equal', 'high'].map((d) => <option key={d} value={d}>{t('decay.' + d)}</option>)}
            </select>
          </Field>
          <button type="button" className="primary" onClick={playSeq}>{t('btn.seq')}</button>
          <button type="button" onClick={() => audio.stop()}>{t('btn.stop')}</button>
          <button type="button" onClick={() => {
            const sr = 44100; saveWav(render(sr, DUR), sr, 'additive_' + f0 + 'Hz.wav');
            setStatus({ msg: t('st.wav', { dur: DUR, sr }), kind: 'ok' });
          }}>{t('btn.wav')}</button>
        </Controls>
        <Status s={status} />
      </Section>
    </>}>
      <Split id="main">
        <Pane id="partials" title={t('pane.partials')} weight={1} min={150}>
          <div className="sa-partials" role="group" aria-label={t('partials.aria')}>
            {Array.from({ length: N }, (_, i) => i + 1).map((k) => (
              <div className="sa-partial" key={k}>
                <span className="sa-k">{k}</span>
                <input type="range" min={0} max={100} value={Math.round(amps[k - 1] * 100)} aria-label={'k = ' + k}
                  onChange={(e) => setAmp(k, +e.target.value / 100)} />
                <span className="sa-hz">{Math.round(pf(k))} Hz</span>
                <button type="button" aria-label={t('partial.solo', { k })} onClick={() => playPartial(k)}>▶</button>
              </div>
            ))}
          </div>
        </Pane>
        <Pane id="views" title={t('s2.title')} weight={1.3}>
          <div className="wb-row">
            <div className="wb-col"><p className="caption">{t('view.spectrum')}</p><Plot fill draw={drawSpectrum} deps={[key]} ariaLabel={t('spec.aria', { n: N })} /></div>
            <div className="wb-col"><p className="caption">{t('view.wave')}</p><Plot fill draw={drawWave} deps={[key]} ariaLabel={t('wave.aria')} /></div>
          </div>
        </Pane>
      </Split>
    </Workbench>
  );
}
