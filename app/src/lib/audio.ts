/* Audio: one shared AudioContext, a master bus that can be recorded, file
   decoding, synthesised demo sounds, and fire-and-forget playback.
   Port of Atelier.audio; behaviour kept. */

import { tr } from '../i18n/core';

let audioCtx: AudioContext | null = null;
let currentSource: AudioBufferSourceNode | null = null;
let masterGain: GainNode | null = null;

/** Who owns the single "current" voice: a transport registers its stop here so
    starting any other playback pauses it. */
let currentOwner: { stopped: () => void } | null = null;

export function ctx(): AudioContext {
  if (!audioCtx) {
    const C = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) throw new Error(tr('err.noWebAudio'));
    audioCtx = new C();
  }
  if (audioCtx.state === 'suspended') void audioCtx.resume();
  return audioCtx;
}

export function master(): GainNode {
  const c = ctx();
  if (!masterGain) { masterGain = c.createGain(); masterGain.connect(c.destination); }
  return masterGain;
}

/** Decode audio bytes. The bytes are copied first: decodeAudioData detaches its input. */
export function decodeBytes(bytes: ArrayBuffer): Promise<AudioBuffer> {
  return new Promise((resolve, reject) => {
    ctx().decodeAudioData(bytes.slice(0), (b) => resolve(b), () => reject(new Error(tr('err.decode'))));
  });
}

export function readBytes(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onerror = () => reject(new Error(tr('err.read')));
    r.onload = () => resolve(r.result as ArrayBuffer);
    r.readAsArrayBuffer(file);
  });
}

export async function decodeFile(file: File): Promise<AudioBuffer> {
  return decodeBytes(await readBytes(file));
}

export function toBuffer(sig: Float32Array, sr: number): AudioBuffer {
  const b = ctx().createBuffer(1, Math.max(1, sig.length), sr);
  b.getChannelData(0).set(sig);
  return b;
}

export type DemoKind = 'sine' | 'sweep' | 'noise' | 'bell' | 'pluck' | 'texture';
export const DEMO_KINDS: DemoKind[] = ['sine', 'sweep', 'noise', 'bell', 'pluck', 'texture'];

/** Synthesised demo sounds — the fallback when nobody has a file to hand. */
export function generate(kind: string, opts: { duration?: number; frequency?: number } = {}): AudioBuffer {
  const c = ctx();
  const sr = c.sampleRate;
  const dur = opts.duration || 3;
  const n = Math.floor(sr * dur);
  const buf = c.createBuffer(1, n, sr);
  const x = buf.getChannelData(0);
  let i: number, t: number;

  if (kind === 'sine') {
    const f = opts.frequency || 440;
    for (i = 0; i < n; i++) x[i] = 0.7 * Math.sin(2 * Math.PI * f * i / sr);
  } else if (kind === 'sweep') {
    const f0 = 80, f1 = 8000; let phase = 0;
    for (i = 0; i < n; i++) {
      phase += 2 * Math.PI * (f0 * Math.pow(f1 / f0, i / n)) / sr;
      x[i] = 0.6 * Math.sin(phase);
    }
  } else if (kind === 'noise') {
    for (i = 0; i < n; i++) x[i] = 0.5 * (Math.random() * 2 - 1);
  } else if (kind === 'bell') {
    const carrier = 520, ratio = 1.41;
    for (i = 0; i < n; i++) {
      t = i / sr;
      x[i] = 0.7 * Math.exp(-t * 2.2) *
        Math.sin(2 * Math.PI * carrier * t + 7 * Math.exp(-t * 5) * Math.sin(2 * Math.PI * carrier * ratio * t));
    }
  } else if (kind === 'pluck') {
    const freq = opts.frequency || 196;
    const len = Math.round(sr / freq);
    const ring = new Float32Array(len);
    for (i = 0; i < len; i++) ring[i] = Math.random() * 2 - 1;
    let idx = 0;
    for (i = 0; i < n; i++) {
      const next = (idx + 1) % len;
      ring[idx] = 0.498 * (ring[idx] + ring[next]);
      x[i] = 0.8 * ring[idx] * Math.exp(-i / sr * 0.8);
      idx = next;
    }
  } else if (kind === 'texture') {
    let y1 = 0, y2 = 0;
    for (i = 0; i < n; i++) {
      t = i / sr;
      const cut = 0.02 + 0.35 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.25 * t));
      const w = Math.random() * 2 - 1;
      y1 += cut * (w - y1);
      y2 += cut * (y1 - y2);
      x[i] = 0.9 * (y1 - y2) * 6;
    }
  } else {
    throw new Error(tr('err.unknownDemo', { k: kind }));
  }
  const fade = Math.min(Math.floor(sr * 0.01), Math.floor(n / 2));
  for (i = 0; i < fade; i++) { x[i] *= i / fade; x[n - 1 - i] *= i / fade; }
  return buf;
}

/** Take the single "current" voice: stops whatever played before. */
export function claim(src: AudioBufferSourceNode | null, owner: { stopped: () => void } | null) {
  stop();
  currentSource = src;
  currentOwner = owner;
}
export function release(src: AudioBufferSourceNode) {
  if (currentSource === src) { currentSource = null; currentOwner = null; }
}

export function stop() {
  const owner = currentOwner;
  currentOwner = null;
  if (currentSource) {
    try { currentSource.stop(); } catch { /* already stopped */ }
    currentSource = null;
  }
  if (owner) owner.stopped();
}

export function play(buffer: AudioBuffer, onEnded?: () => void) {
  return playRange(buffer, 0, buffer.duration, onEnded);
}

/** Play part of a buffer. start/end in seconds. */
export function playRange(buffer: AudioBuffer, start?: number, end?: number, onEnded?: () => void) {
  const c = ctx();
  const src = c.createBufferSource();
  src.buffer = buffer;
  src.connect(master());
  claim(src, null);
  src.onended = () => { release(src); if (onEnded) onEnded(); };
  const s = Math.max(0, start || 0);
  const d = Math.max(0.01, Math.min(buffer.duration, end === undefined ? buffer.duration : end) - s);
  src.start(0, s, d);
  return src;
}

/** Fire-and-forget playback of a slice, overlapping allowed (for the map). */
export function trigger(buffer: AudioBuffer, start?: number, end?: number, gain?: number) {
  const c = ctx();
  const src = c.createBufferSource();
  src.buffer = buffer;
  const g = c.createGain();
  const s = Math.max(0, start || 0);
  const d = Math.max(0.01, Math.min(buffer.duration, end === undefined ? buffer.duration : end) - s);
  const now = c.currentTime, fade = Math.min(0.01, d / 4), level = gain === undefined ? 1 : gain;
  g.gain.setValueAtTime(0, now);
  g.gain.linearRampToValueAtTime(level, now + fade);
  g.gain.setValueAtTime(level, now + d - fade);
  g.gain.linearRampToValueAtTime(0, now + d);
  src.connect(g); g.connect(master());
  src.start(now, s, d);
  return src;
}

/* --- recording what goes through master() --------------------------------- */

let recorder: { node: ScriptProcessorNode; chunks: Float32Array[]; t0: number; sampleRate: number } | null = null;

export const record = {
  start() {
    const c = ctx();
    if (recorder) return;
    if (!c.createScriptProcessor) throw new Error(tr('err.noRecord'));
    const node = c.createScriptProcessor(4096, 1, 1);
    const chunks: Float32Array[] = [];
    node.onaudioprocess = (e) => { chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
    master().connect(node);
    node.connect(c.destination);   // a ScriptProcessor only runs when connected
    recorder = { node, chunks, t0: c.currentTime, sampleRate: c.sampleRate };
  },
  stop(): { samples: Float32Array; sampleRate: number; duration: number } | null {
    if (!recorder) return null;
    const r = recorder; recorder = null;
    try { master().disconnect(r.node); } catch { /* already gone */ }
    try { r.node.disconnect(); } catch { /* ignore */ }
    r.node.onaudioprocess = null;
    let n = 0;
    for (const c of r.chunks) n += c.length;
    const out = new Float32Array(n); let o = 0;
    for (const c of r.chunks) { out.set(c, o); o += c.length; }
    return { samples: out, sampleRate: r.sampleRate, duration: n / r.sampleRate };
  },
  active: () => !!recorder,
  elapsed: () => (recorder ? ctx().currentTime - recorder.t0 : 0),
};
