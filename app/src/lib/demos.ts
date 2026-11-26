/* Every synthesised demo sound, by recipe name, so a session can rebuild them
   on opening instead of storing their audio. */

import { ctx, generate } from './audio';

/** The FFT sandbox's sound: a held note, regular clicks and a burst of noise —
    three things that react differently to the window size. */
function anatomy(): AudioBuffer {
  const c = ctx(), sr = c.sampleRate, dur = 4, n = sr * dur;
  const b = c.createBuffer(1, n, sr), x = b.getChannelData(0);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const tone = 0.35 * Math.sin(2 * Math.PI * 330 * t) + 0.12 * Math.sin(2 * Math.PI * 660 * t) +
                 0.08 * Math.sin(2 * Math.PI * 990 * t);
    const env = Math.min(1, t * 8) * Math.min(1, (dur - t) * 8);
    let click = 0;
    const phase = (t * 4) % 1;                    // 4 clicks per second
    if (phase < 0.002) click = 0.9 * (1 - phase / 0.002) * (Math.random() * 2 - 1);
    const burst = (t > 2.6 && t < 2.9) ? 0.5 * (Math.random() * 2 - 1) * Math.sin(Math.PI * (t - 2.6) / 0.3) : 0;
    x[i] = env * tone + click + burst;
  }
  return b;
}

/** The segmentation demos: clean attacks, or a texture with almost none. */
function segDemo(kind: 'events' | 'texture8'): AudioBuffer {
  const c = ctx(), sr = c.sampleRate, dur = 8, n = sr * dur;
  const b = c.createBuffer(1, n, sr), x = b.getChannelData(0);
  if (kind === 'events') {
    const onsets = [0.3, 1.1, 1.6, 2.7, 3.2, 3.5, 4.6, 5.9, 6.4, 7.1];
    const freqs = [220, 330, 440, 196, 262, 392, 294, 349, 523, 247];
    for (let i = 0; i < n; i++) {
      const t = i / sr; let v = 0;
      for (let k = 0; k < onsets.length; k++) {
        const dt = t - onsets[k];
        if (dt < 0 || dt > 1.2) continue;
        const env = Math.exp(-dt * (3 + k % 3));
        v += 0.4 * env * (Math.sin(2 * Math.PI * freqs[k] * dt) + 0.3 * Math.sin(2 * Math.PI * freqs[k] * 2.01 * dt));
        if (k % 4 === 3) v += 0.3 * env * (Math.random() * 2 - 1);
      }
      x[i] = v;
    }
  } else {
    let y1 = 0, y2 = 0;
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const cut = 0.02 + 0.2 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 0.11 * t));
      const w = Math.random() * 2 - 1;
      y1 += cut * (w - y1); y2 += cut * (y1 - y2);
      x[i] = 0.9 * (y1 - y2) * 6 * (0.6 + 0.4 * Math.sin(2 * Math.PI * 0.07 * t));
    }
  }
  return b;
}

/** For the spectral workshop: a held chord that changes, a drum pattern and a
    steady hiss — something to separate (harmonic / percussive / noise, NMF). */
function mixture(): AudioBuffer {
  const c = ctx(), sr = c.sampleRate, dur = 8, n = sr * dur;
  const b = c.createBuffer(1, n, sr), x = b.getChannelData(0);
  const chords = [[220, 277.2, 329.6], [196, 246.9, 293.7], [174.6, 220, 261.6], [196, 246.9, 329.6]];
  let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647 * 2 - 1; };
  let hp = 0, prev = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr, bar = Math.floor(t / 2), tb = t - bar * 2;
    let v = 0;
    for (const f of chords[bar % 4]) for (let h = 1; h <= 4; h++) v += 0.05 / h * Math.sin(2 * Math.PI * f * h * t);
    v *= Math.min(1, tb * 6) * Math.min(1, (2 - tb) * 6);
    const beat = t % 0.5, k = Math.floor(t / 0.5);
    if (k % 2 === 0) v += 0.6 * Math.exp(-beat * 30) * Math.sin(2 * Math.PI * (50 + 90 * Math.exp(-beat * 40)) * beat);   // kick
    else { const w = rnd(); hp = 0.6 * (hp + w - prev); prev = w; v += 0.35 * Math.exp(-beat * 18) * hp; }                   // snare-ish
    const hh = (t + 0.25) % 0.5;
    if (hh < 0.06) v += 0.12 * Math.exp(-hh * 80) * rnd();                                                                     // hat
    v += 0.012 * rnd();                                                                                                         // hiss
    x[i] = v;
  }
  return b;
}

export function makeDemo(kind: string, duration?: number): AudioBuffer {
  if (kind === 'anatomy') return anatomy();
  if (kind === 'mixture') return mixture();
  if (kind === 'events' || kind === 'texture8') return segDemo(kind);
  return generate(kind, { duration: duration || 4 });
}
