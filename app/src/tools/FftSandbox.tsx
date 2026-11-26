/* Bac à sable FFT — port of ats-bac-a-sable-fft.html.
   One sound, the analysis window as the variable: spectrogram, the spectrum
   of the slice under the playhead, and a 256 / 1024 / 4096 comparison.
   The spectrograms themselves are not saved in the session (they are large
   and quick to recompute): the settings are, and the analysis reruns on its
   own when a saved session is reopened. */

import { useEffect, useRef, useState } from 'react';
import { findLesson, findTool } from '../catalog';
import type { PaneProps } from '../catalogComponents';
import { ToolFrame } from '../shell/ToolFrame';
import { Empty, Pane, Section, Split, Workbench } from '../ui/Workbench';
import { useToolState } from '../session/store';
import { useT } from '../i18n/react';
import { Controls, Field, Panel, Plot, Progress, Readout, Status, StatusMsg, TransportBar, useTransport } from '../ui/kit';
import { SoundSource, useLoadedSound } from '../ui/SoundSource';
import * as draw from '../lib/draw';
import { css } from '../lib/draw';
import { magnitude, spectrogram, Spectrogram, windowFn } from '../lib/dsp';
import { png } from '../lib/io';
import { S } from './FftSandbox.strings';

type State = { soundId: string | null; size: number; overlap: number; win: string; scale: 'lin' | 'log'; range: number; ran: boolean; compared: boolean };
const DEFAULTS: State = { soundId: null, size: 1024, overlap: 0.75, win: 'hann', scale: 'log', range: 70, ran: false, compared: false };
const CMP_SIZES = [256, 1024, 4096];

export default function FftSandbox({ tab }: PaneProps) {
  const lesson = tab.kind === 'lesson';
  const entry = (lesson ? findLesson('fft') : findTool('fft'))!;
  const { t, rich, lang } = useT(S);
  const [st, set] = useToolState<State>(lesson ? 'lesson:fft' : 'fft', DEFAULTS);
  const sound = useLoadedSound(st.soundId);
  const tp = useTransport();
  const [spec, setSpec] = useState<Spectrogram | null>(null);
  const [compared, setCompared] = useState<{ size: number; spec: Spectrogram }[]>([]);
  const [cursorT, setCursorT] = useState<number | null>(null);
  const [prog, setProg] = useState<number | null>(null);
  const [runStatus, setRunStatus] = useState<StatusMsg>(null);
  const runId = useRef(0);
  const busy = prog !== null;

  const signal = sound?.signal, sr = sound?.buffer.sampleRate || 44100;
  const hop = Math.max(1, Math.round(st.size * (1 - st.overlap)));
  const frames = signal ? Math.max(0, Math.floor((signal.length - st.size) / hop) + 1) : 0;

  // a new sound: forget the analyses made on the previous one
  useEffect(() => {
    runId.current++;
    tp.setBuffer(sound?.buffer || null);
    setSpec(null); setCompared([]); setCursorT(null); setProg(null);
  }, [sound?.buffer]); // eslint-disable-line react-hooks/exhaustive-deps

  // scrubbing and inspecting are the same gesture: wherever the playhead is,
  // that is the slice the spectrum below shows
  useEffect(() => tp.onSeek((x) => setCursorT(x)), [tp]);

  const compute = (size: number, h: number, onProgress: (v: number) => void) =>
    spectrogram(signal!, sr, { frameSize: size, hopSize: h, window: st.win, maxColumns: 3000, onProgress });

  const run = async () => {
    if (!signal) return;
    if (signal.length < st.size) { setRunStatus({ msg: t('st.tooshort'), kind: 'bad' }); return; }
    const id = ++runId.current;
    setProg(0); setRunStatus({ msg: t('st.running') });
    const t0 = performance.now();
    try {
      const s = await compute(st.size, hop, (v) => { if (id === runId.current) setProg(v); });
      if (id !== runId.current) return;
      setSpec(s); setCursorT(null); set({ ran: true });
      setRunStatus({ msg: t('st.done', { n: s.nFrames.toLocaleString(lang), cols: s.columns, t: ((performance.now() - t0) / 1000).toFixed(1) }), kind: 'ok' });
    } catch (e) {
      if (id === runId.current) setRunStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' });
    } finally { if (id === runId.current) setProg(null); }
  };

  const compare = async () => {
    if (!signal) return;
    const id = ++runId.current, out: { size: number; spec: Spectrogram }[] = [];
    setProg(0);
    try {
      for (let i = 0; i < CMP_SIZES.length; i++) {
        const size = CMP_SIZES[i];
        setRunStatus({ msg: t('cmp.running', { size }) });
        const s = await compute(size, Math.max(1, Math.round(size * (1 - st.overlap))), (v) => { if (id === runId.current) setProg((i + v) / CMP_SIZES.length); });
        if (id !== runId.current) return;
        out.push({ size, spec: s });
      }
      setCompared(out); set({ compared: true }); setRunStatus(null);
    } catch (e) {
      if (id === runId.current) setRunStatus({ msg: t('st.failed', { msg: (e as Error).message }), kind: 'bad' });
    } finally { if (id === runId.current) setProg(null); }
  };

  // a reopened session: redo what had been done
  const restored = useRef(false);
  useEffect(() => {
    if (restored.current || !signal) return;
    restored.current = true;
    if (st.ran && !spec) void run().then(() => { if (st.compared) void compare(); });
    else if (st.compared) void compare();
  }, [signal]); // eslint-disable-line react-hooks/exhaustive-deps

  const specLabel = (s: Spectrogram) => t('spec.label', { size: s.frameSize, ms: (s.frameSize / s.sampleRate * 1000).toFixed(1), hz: (s.sampleRate / s.frameSize).toFixed(1) });
  const drawSpec = (cv: HTMLCanvasElement) => { if (spec) draw.spectrogram(cv, spec, { height: 300, logFreq: st.scale === 'log', dbRange: st.range, label: specLabel(spec) }); };

  const drawSlice = (cv: HTMLCanvasElement) => {
    if (!spec || cursorT === null || !signal) { draw.clear(cv, 150); return; }
    const size = spec.frameSize, ssr = spec.sampleRate;
    const centre = Math.round(cursorT * ssr), start = Math.max(0, Math.min(signal.length - size, centre - size / 2));
    const mag = magnitude(signal.subarray(start, start + size), windowFn(size, st.win));
    const db = new Float64Array(mag.length), freqs = new Float64Array(mag.length);
    const top = 20 * Math.log10(spec.maxMag || 1e-9), rng = st.range;
    for (let k = 0; k < mag.length; k++) { db[k] = Math.max(top - rng, 20 * Math.log10(mag[k] > 1e-12 ? mag[k] : 1e-12)); freqs[k] = k * ssr / size; }
    draw.curve(cv, freqs, db, { label: t('slice.aria', { t: cursorT.toFixed(2) }), unit: 'dB', min: top - rng, max: top, height: 150 });
    // curve() labels the x axis in seconds; overwrite with hertz
    const c = cv.getContext('2d')!, w = cv.clientWidth, h = cv.clientHeight;
    c.fillStyle = css('--sunken'); c.fillRect(0, h - 16, w, 16);
    c.fillStyle = css('--ink-soft'); c.font = '11px ' + css('--mono');
    c.textAlign = 'left'; c.fillText('0 Hz', draw.padLeft(), h - 4);
    c.textAlign = 'right'; c.fillText((ssr / 2 / 1000).toFixed(1) + ' kHz', w - 8, h - 4);
  };

  const onSpecKey = (e: React.KeyboardEvent) => {
    if (!spec) return;
    const step = spec.duration / 100;
    if (e.key === 'ArrowLeft') tp.seek((cursorT || 0) - step);
    else if (e.key === 'ArrowRight') tp.seek((cursorT || 0) + step);
    else if (e.key === 'Enter' || e.key === ' ') tp.toggle();
    else return;
    e.preventDefault();
  };

  const specCanvas = useRef<HTMLCanvasElement | null>(null);


  if (lesson) return (
    <ToolFrame entry={entry} lede={rich('lede')}>
      <Panel title={t('s1.title')} hintHtml={rich('s1.hint')}>
        <SoundSource value={st.soundId} onChange={(id) => set({ soundId: id, ran: false, compared: false })}
          demos={['anatomy', 'sine', 'sweep', 'bell', 'pluck', 'texture']} />
        <TransportBar tp={tp} />
        <p className="caption">{sound ? t('caption.loaded', { name: sound.meta.name, dur: sound.buffer.duration.toFixed(2), sr: sound.buffer.sampleRate }) : t('caption.none')}</p>
        <Plot draw={(cv) => (signal ? draw.waveform(cv, signal, { label: sound!.meta.name, height: 90 }) : draw.clear(cv, 90))} deps={[signal]} transport={sound ? tp : null} />
      </Panel>

      <Panel title={t('s2.title')} hintHtml={rich('s2.hint')}>
        <Controls>
          <Field label={t('opt.size')}>
            <select value={st.size} onChange={(e) => set({ size: +e.target.value })}>{[128, 256, 512, 1024, 2048, 4096, 8192].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
          <Field label={t('opt.overlap')}>
            <select value={st.overlap} onChange={(e) => set({ overlap: +e.target.value })}>
              <option value={0}>{t('opt.none')}</option><option value={0.5}>50 %</option><option value={0.75}>75 %</option><option value={0.875}>{lang === 'fr' ? '87,5 %' : '87.5 %'}</option>
            </select>
          </Field>
          <Field label={t('opt.window')}>
            <select value={st.win} onChange={(e) => set({ win: e.target.value })}>
              <option value="hann">Hann</option><option value="hamming">Hamming</option><option value="blackman">Blackman</option><option value="rect">{t('opt.rect')}</option>
            </select>
          </Field>
          <Field label={t('opt.scale')}>
            <select value={st.scale} onChange={(e) => set({ scale: e.target.value as State['scale'] })}><option value="lin">{t('opt.lin')}</option><option value="log">{t('opt.log')}</option></select>
          </Field>
          <Field label={t('opt.range')}>
            <select value={st.range} onChange={(e) => set({ range: +e.target.value })}>{[50, 70, 90, 110].map((n) => <option key={n} value={n}>{n} dB</option>)}</select>
          </Field>
          <button type="button" className="primary" disabled={!signal || busy} onClick={() => void run()}>{t('btn.run')}</button>
          <button type="button" disabled={!signal || busy} onClick={() => void compare()}>{t('btn.compare')}</button>
        </Controls>
        <Readout html={rich('readout', { size: st.size, ms: (st.size / sr * 1000).toFixed(1), bins: st.size / 2 + 1, hz: (sr / st.size).toFixed(1), hop: (hop / sr * 1000).toFixed(1), frames: frames.toLocaleString(lang) })} />
        <Progress value={prog} />
        <Status s={runStatus} />
      </Panel>

      {spec ? (
        <Panel title={t('s3.title')} hintHtml={rich('s3.hint')}>
          <Plot className="crosshair" draw={drawSpec} deps={[spec, st.scale, st.range]} transport={tp} tabIndex={0} onKeyDown={onSpecKey} canvasRef={specCanvas} />
          <p className="caption">{spec && cursorT !== null ? t('slice.at', { t: cursorT.toFixed(2), ms: (spec.frameSize / spec.sampleRate * 1000).toFixed(1) }) : t('slice.none')}</p>
          <Plot draw={drawSlice} deps={[spec, cursorT, st.win, st.range]} />
          <Controls><button type="button" onClick={() => specCanvas.current && png(specCanvas.current, 'spectrogramme_' + spec.frameSize + '.png')}>{t('btn.png')}</button></Controls>
        </Panel>
      ) : null}

      {compared.length ? (
        <Panel title={t('s4.title')} hintHtml={rich('s4.hint')}>
          {compared.map((c) => (
            <Plot key={c.size} draw={(cv) => draw.spectrogram(cv, c.spec, { height: 190, logFreq: st.scale === 'log', dbRange: st.range, label: specLabel(c.spec) })} deps={[c.spec, st.scale, st.range]} />
          ))}
        </Panel>
      ) : null}
    </ToolFrame>
  );

  return (
    <Workbench entry={entry} toolbar={<TransportBar tp={tp} />} side={<>
      <Section id="sound" title={t('s1.title')}>
        <SoundSource value={st.soundId} onChange={(id) => set({ soundId: id, ran: false, compared: false })}
          demos={['anatomy', 'sine', 'sweep', 'bell', 'pluck', 'texture']} />
        <p className="caption">{sound ? t('caption.loaded', { name: sound.meta.name, dur: sound.buffer.duration.toFixed(2), sr: sound.buffer.sampleRate }) : t('caption.none')}</p>
      </Section>
      <Section id="settings" title={t('s2.title')}>
        <Controls>
          <Field label={t('opt.size')}>
            <select value={st.size} onChange={(e) => set({ size: +e.target.value })}>{[128, 256, 512, 1024, 2048, 4096, 8192].map((n) => <option key={n} value={n}>{n}</option>)}</select>
          </Field>
          <Field label={t('opt.overlap')}>
            <select value={st.overlap} onChange={(e) => set({ overlap: +e.target.value })}>
              <option value={0}>{t('opt.none')}</option><option value={0.5}>50 %</option><option value={0.75}>75 %</option><option value={0.875}>{lang === 'fr' ? '87,5 %' : '87.5 %'}</option>
            </select>
          </Field>
          <Field label={t('opt.window')}>
            <select value={st.win} onChange={(e) => set({ win: e.target.value })}>
              <option value="hann">Hann</option><option value="hamming">Hamming</option><option value="blackman">Blackman</option><option value="rect">{t('opt.rect')}</option>
            </select>
          </Field>
          <Field label={t('opt.scale')}>
            <select value={st.scale} onChange={(e) => set({ scale: e.target.value as State['scale'] })}><option value="lin">{t('opt.lin')}</option><option value="log">{t('opt.log')}</option></select>
          </Field>
          <Field label={t('opt.range')}>
            <select value={st.range} onChange={(e) => set({ range: +e.target.value })}>{[50, 70, 90, 110].map((n) => <option key={n} value={n}>{n} dB</option>)}</select>
          </Field>
          <button type="button" className="primary" disabled={!signal || busy} onClick={() => void run()}>{t('btn.run')}</button>
        </Controls>
        <Readout html={rich('readout', { size: st.size, ms: (st.size / sr * 1000).toFixed(1), bins: st.size / 2 + 1, hz: (sr / st.size).toFixed(1), hop: (hop / sr * 1000).toFixed(1), frames: frames.toLocaleString(lang) })} />
        <Progress value={prog} />
        <Status s={runStatus} />
      </Section>
    </>}>
      <Split id="main">
        <Pane id="wave" title={t('wb.waveform')} weight={0.8} min={90}>
          {signal ? <Plot fill draw={(cv) => draw.waveform(cv, signal, { label: sound!.meta.name })} deps={[signal]} transport={tp} /> : <Empty />}
        </Pane>
        <Pane id="spec" title={t('s3.title')} weight={3}
          actions={spec ? <button type="button" onClick={() => specCanvas.current && png(specCanvas.current, 'spectrogramme_' + spec.frameSize + '.png')}>{t('btn.png')}</button> : null}>
          {spec ? <Plot fill className="crosshair" draw={drawSpec} deps={[spec, st.scale, st.range]} transport={tp} tabIndex={0} onKeyDown={onSpecKey} canvasRef={specCanvas} /> : <Empty />}
        </Pane>
        <Pane id="slice" title={t('pane.slice')} weight={1.3}
          actions={spec ? <span className="caption">{cursorT !== null ? t('slice.at', { t: cursorT.toFixed(2), ms: (spec.frameSize / spec.sampleRate * 1000).toFixed(1) }) : ''}</span> : null}>
          {spec && cursorT !== null ? <Plot fill draw={drawSlice} deps={[spec, cursorT, st.win, st.range]} /> : <Empty>{spec ? t('slice.none') : undefined}</Empty>}
        </Pane>
      </Split>
    </Workbench>
  );
}
