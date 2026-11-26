/* A transport bound to one AudioBuffer: play, pause, stop, seek, a range (a
   segment), and playheads on attached canvases with click/drag-to-seek.
   Port of Atelier.transport. The playhead is a DOM element moved over the
   canvas, never a canvas redraw: a 300 000-point curve cannot repaint at 60 fps.
   Controls are rendered by <TransportBar>; this class owns the state. */

import * as audio from './audio';
import { geomOf } from './draw';

type Head = { canvas: HTMLCanvasElement; el: HTMLElement; off: () => void };

export class Transport {
  buffer: AudioBuffer | null = null;
  private rangeStart = 0;
  private rangeEnd: number | null = null;
  private position = 0;
  private playingFlag = false;
  private src: AudioBufferSourceNode | null = null;
  private startedAt = 0;
  private raf = 0;
  private heads: Head[] = [];
  private seekListeners = new Set<(t: number) => void>();
  private changeListeners = new Set<() => void>();
  private frameListeners = new Set<(t: number) => void>();
  private owner = { stopped: () => { if (this.playingFlag) this.pause(); } };

  constructor(buffer?: AudioBuffer | null) { if (buffer) this.buffer = buffer; }

  lo() { return this.rangeStart; }
  hi() { return this.rangeEnd !== null ? this.rangeEnd : (this.buffer ? this.buffer.duration : 0); }
  span() { return Math.max(0.0001, this.hi() - this.lo()); }
  playing() { return this.playingFlag; }

  time(): number {
    if (!this.buffer) return 0;
    if (!this.playingFlag) return Math.min(Math.max(this.position, this.lo()), this.hi());
    const t = audio.ctx().currentTime - this.startedAt;
    return Math.min(Math.max(t, this.lo()), this.hi());
  }

  /** React subscription: fires on play/pause/buffer changes (not every frame). */
  subscribe(fn: () => void) { this.changeListeners.add(fn); return () => { this.changeListeners.delete(fn); }; }
  /** Fires on every animation frame while playing, and after each seek. */
  onFrame(fn: (t: number) => void) { this.frameListeners.add(fn); return () => { this.frameListeners.delete(fn); }; }
  onSeek(fn: (t: number) => void) { this.seekListeners.add(fn); return () => { this.seekListeners.delete(fn); }; }
  private changed() { this.changeListeners.forEach((f) => f()); }

  private paint() {
    const t = this.time();
    for (const h of this.heads) {
      const g = geomOf(h.canvas);
      // plots show the whole sound: the playhead sits at its absolute time, even while a range plays
      const u = this.buffer ? t / Math.max(0.0001, this.buffer.duration) : 0;
      h.el.style.display = this.buffer ? 'block' : 'none';
      h.el.style.left = (g.padL + u * g.plotW) + 'px';
      h.el.style.top = g.padT + 'px';
      h.el.style.height = g.plotH + 'px';
    }
    this.frameListeners.forEach((f) => f(t));
  }

  private tick = () => {
    if (!this.playingFlag) return;
    if (this.time() >= this.hi() - 0.001) { this.stop(); return; }
    this.paint();
    this.raf = requestAnimationFrame(this.tick);
  };

  play() {
    if (!this.buffer || this.playingFlag) return this;
    const c = audio.ctx();
    if (this.position >= this.hi() - 0.001 || this.position < this.lo()) this.position = this.lo();
    const src = c.createBufferSource();
    src.buffer = this.buffer;
    src.connect(audio.master());
    audio.claim(src, this.owner);
    src.onended = () => {
      audio.release(src);
      if (this.playingFlag && this.src === src && this.time() >= this.hi() - 0.01) this.stop();
    };
    this.startedAt = c.currentTime - this.position;
    src.start(0, this.position, Math.max(0.01, this.hi() - this.position));
    this.src = src;
    this.playingFlag = true;
    this.raf = requestAnimationFrame(this.tick);
    this.changed();
    return this;
  }

  pause() {
    if (!this.playingFlag) return this;
    this.position = this.time();
    this.playingFlag = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const src = this.src; this.src = null;
    if (src) { audio.release(src); try { src.stop(); } catch { /* already stopped */ } }
    this.paint();
    this.changed();
    return this;
  }

  stop() { this.pause(); this.position = this.lo(); this.paint(); this.changed(); return this; }
  toggle() { return this.playingFlag ? this.pause() : this.play(); }

  seek(seconds: number, quiet = false) {
    if (!this.buffer) return this;
    this.position = Math.min(Math.max(seconds, this.lo()), this.hi());
    if (this.playingFlag) { this.pause(); this.play(); }
    this.paint();
    if (!quiet) this.seekListeners.forEach((f) => f(this.position));
    this.changed();
    return this;
  }

  setBuffer(buf: AudioBuffer | null) {
    this.stop();
    this.buffer = buf;
    this.rangeStart = 0; this.rangeEnd = null; this.position = 0;
    this.paint();
    this.changed();
    return this;
  }

  setRange(start: number, end: number | null) {
    this.rangeStart = start || 0;
    this.rangeEnd = end === undefined || end === null ? null : end;
    this.position = this.lo();
    this.paint();
    this.changed();
    return this;
  }

  /** Give a canvas a playhead (the element is the caller's) and click-to-seek. */
  attach(canvas: HTMLCanvasElement, el: HTMLElement) {
    if (this.heads.some((h) => h.canvas === canvas)) return () => {};
    canvas.classList.add('scrubbable');
    let dragging = false;
    const seekFrom = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect(), g = geomOf(canvas);
      const u = Math.min(1, Math.max(0, (e.clientX - r.left - g.padL) / Math.max(1, g.plotW)));
      const at = u * (this.buffer ? this.buffer.duration : 0);
      // a click outside the range playing leaves the range: the whole sound again
      if (at < this.lo() || at > this.hi()) { this.rangeStart = 0; this.rangeEnd = null; }
      this.seek(at);
    };
    const onDown = (e: PointerEvent) => {
      if (!this.buffer || canvas.dataset.noseek === '1') return;   // the canvas is used for something else right now
      dragging = true;
      try { canvas.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      seekFrom(e);
    };
    const onMove = (e: PointerEvent) => { if (dragging) seekFrom(e); };
    const onUp = () => { dragging = false; };
    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('pointercancel', onUp);
    const head: Head = {
      canvas, el,
      off: () => {
        canvas.removeEventListener('pointerdown', onDown);
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerup', onUp);
        canvas.removeEventListener('pointercancel', onUp);
        canvas.classList.remove('scrubbable');
        el.style.display = 'none';
      },
    };
    this.heads.push(head);
    this.paint();
    return () => { head.off(); this.heads = this.heads.filter((h) => h !== head); };
  }

  /** Re-place the playheads after a redraw changed the canvas geometry. */
  refresh() { this.paint(); return this; }
}
