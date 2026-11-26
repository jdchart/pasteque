/* The session's sound library. Every tool picks its sound from here, so a
   file imported once is available in every tab. The audio itself (decoded
   buffers, original bytes) is runtime-only; the metadata is in the store and
   travels in the session file, with the bytes when the student chooses to
   embed them. Demo sounds are rebuilt from their recipe. */

import { useSyncExternalStore } from 'react';
import * as audio from '../lib/audio';
import { mono } from '../lib/dsp';
import { log } from '../lib/log';
import { tr } from '../i18n/core';
import { getState, newId, setState, SoundMeta } from './store';
import { makeDemo } from '../lib/demos';
import { wavBlob } from '../lib/io';

export type Loaded = { meta: SoundMeta; buffer: AudioBuffer; signal: Float32Array; bytes?: ArrayBuffer };

const runtime = new Map<string, { buffer: AudioBuffer; signal: Float32Array; bytes?: ArrayBuffer }>();
let version = 0;
const listeners = new Set<() => void>();
const bump = () => { version++; listeners.forEach((f) => f()); };
const subscribe = (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; };

export function getSound(id: string | null | undefined): Loaded | null {
  if (!id) return null;
  const meta = getState().sounds.find((s) => s.id === id);
  const r = runtime.get(id);
  if (!meta || !r) return null;
  return { meta, ...r };
}

export function getSoundBytes(id: string) { return runtime.get(id)?.bytes; }

/** Re-render when a sound's audio arrives or leaves (store changes re-render anyway). */
export function useSoundVersion() { return useSyncExternalStore(subscribe, () => version); }

function metaFor(name: string, buffer: AudioBuffer, extra: Partial<SoundMeta>): SoundMeta {
  return { id: newId(), name, source: 'file', duration: buffer.duration, sampleRate: buffer.sampleRate,
           channels: buffer.numberOfChannels, ...extra };
}

/** Import audio files into the session. Returns the new metas (skipped files are logged). */
export async function importFiles(files: File[], onStatus?: (msg: string) => void): Promise<SoundMeta[]> {
  const added: SoundMeta[] = [];
  for (const f of files) {
    try {
      onStatus?.(tr('st.decoding', { name: f.name }));
      const bytes = await audio.readBytes(f);
      const buffer = await audio.decodeBytes(bytes);
      // the same file imported twice is the same sound
      const existing = getState().sounds.find((s) => s.source === 'file' && s.name === f.name && Math.abs(s.duration - buffer.duration) < 1e-3);
      if (existing) {
        runtime.set(existing.id, { buffer, signal: mono(buffer), bytes });
        if (existing.missing) setState((s) => ({ sounds: s.sounds.map((x) => (x.id === existing.id ? { ...x, missing: false } : x)) }));
        added.push({ ...existing, missing: false });
        continue;
      }
      const meta = metaFor(f.name, buffer, { source: 'file', size: bytes.byteLength });
      runtime.set(meta.id, { buffer, signal: mono(buffer), bytes });
      setState((s) => ({ sounds: [...s.sounds, meta] }), { dirty: true });
      log.ok(f.name + ' — ' + buffer.duration.toFixed(2) + ' s, ' + buffer.sampleRate + ' Hz, ' + buffer.numberOfChannels + ' ch');
      added.push(meta);
    } catch (e) {
      log.error('« ' + f.name + ' » : ' + (e as Error).message);
      onStatus?.((e as Error).message);
    }
  }
  bump();
  return added;
}

/** A computed signal (a separated layer, a filtered sound…) as a session
    sound: kept as WAV bytes, so it can be embedded in the session file and
    used by every other tool. */
export async function addSignal(name: string, signal: Float32Array, sampleRate: number): Promise<SoundMeta> {
  const bytes = await wavBlob(signal, sampleRate).arrayBuffer();
  const buffer = audio.toBuffer(signal, sampleRate);
  const meta = metaFor(name, buffer, { source: 'file', size: bytes.byteLength });
  runtime.set(meta.id, { buffer, signal: signal.slice(), bytes });
  setState((s) => ({ sounds: [...s.sounds, meta] }), { dirty: true });
  log.ok(name + ' — ' + buffer.duration.toFixed(2) + ' s');
  bump();
  return meta;
}

/** A demo sound in the session (reused if the same recipe is already there). */
export function addDemo(kind: string, duration?: number): SoundMeta {
  const found = getState().sounds.find((s) => s.source === 'demo' && s.demo?.kind === kind && (s.demo?.duration ?? 0) === (duration ?? 0));
  if (found && runtime.has(found.id)) return found;
  const buffer = makeDemo(kind, duration);
  const meta = found || metaFor(tr('demo.' + kind), buffer, { source: 'demo', demo: { kind, duration } });
  runtime.set(meta.id, { buffer, signal: mono(buffer) });
  if (!found) setState((s) => ({ sounds: [...s.sounds, meta] }), { dirty: true });
  log.ok(meta.name + ' — ' + buffer.duration.toFixed(2) + ' s, ' + buffer.sampleRate + ' Hz');
  bump();
  return meta;
}

export function removeSound(id: string) {
  runtime.delete(id);
  setState((s) => ({ sounds: s.sounds.filter((x) => x.id !== id) }), { dirty: true });
  bump();
}

/** Give a listed-but-missing sound its audio back from a file. */
export async function relink(id: string, file: File) {
  const bytes = await audio.readBytes(file);
  const buffer = await audio.decodeBytes(bytes);
  runtime.set(id, { buffer, signal: mono(buffer), bytes });
  setState((s) => ({ sounds: s.sounds.map((x) => (x.id === id ? { ...x, missing: false, duration: buffer.duration, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, size: bytes.byteLength } : x)) }), { dirty: true });
  bump();
}

/** After opening a session: rebuild demos, decode embedded files, flag the rest. */
export async function restoreSounds(metas: SoundMeta[], embedded: Record<string, ArrayBuffer>): Promise<number> {
  runtime.clear();
  let missing = 0;
  const out: SoundMeta[] = [];
  for (const m of metas) {
    try {
      if (m.source === 'demo' && m.demo) {
        const buffer = makeDemo(m.demo.kind, m.demo.duration);
        runtime.set(m.id, { buffer, signal: mono(buffer) });
        out.push({ ...m, missing: false });
      } else if (embedded[m.id]) {
        const bytes = embedded[m.id];
        const buffer = await audio.decodeBytes(bytes);
        runtime.set(m.id, { buffer, signal: mono(buffer), bytes });
        out.push({ ...m, missing: false });
      } else { missing++; out.push({ ...m, missing: true }); }
    } catch (e) {
      log.error(m.name + ' : ' + (e as Error).message);
      missing++; out.push({ ...m, missing: true });
    }
  }
  setState({ sounds: out });
  bump();
  return missing;
}

export function clearSounds() { runtime.clear(); bump(); }
