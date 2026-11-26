/* The session: everything a student's work consists of, and nothing else.
   It lives in memory and leaves the page only as a JSON file the student
   downloads (session/file.ts). No localStorage, no cookies, no server.

   Tabs stay mounted while open, so switching tab never loses what a tool is
   doing; the serialisable part of each tool's state lives here (useToolState),
   so it can be saved and reopened. */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { Lang, setLangCore } from '../i18n/core';
import type { Corpus } from './corpora';

export type Theme = 'auto' | 'light' | 'dark';
export type HomeView = 'home' | 'learn' | 'sandbox' | 'about' | `course:${string}`;
export type Tab = { id: string; kind: 'tool' | 'lesson'; ref: string; sub?: string };

export type SoundMeta = {
  id: string; name: string;
  source: 'file' | 'demo';
  demo?: { kind: string; duration?: number };   // rebuilt on opening
  duration: number; sampleRate: number; channels: number;
  size?: number;            // bytes of the original file
  missing?: boolean;        // listed in a session but its audio is not loaded
};

export type AppState = {
  lang: Lang; theme: Theme; textScale: number;
  /** the explanations in tools and lessons (hints) are shown */
  hints: boolean;
  name: string; dirty: boolean; savedAt: string | null;
  tabs: Tab[]; active: string; homeView: HomeView;
  sounds: SoundMeta[];
  /** the corpora shared by the corpus tools (session/corpora.ts) */
  corpora: Corpus[];
  tools: Record<string, unknown>;
  /** bumped when everything drawn must be redrawn (theme, OS scheme, text size) */
  epoch: number;
};

const initialLang = (): Lang => (navigator.language || 'fr').toLowerCase().startsWith('fr') ? 'fr' : (navigator.language ? 'en' : 'fr');

export function freshState(keep?: Pick<AppState, 'lang' | 'theme' | 'textScale' | 'hints'>): AppState {
  return {
    lang: keep?.lang ?? initialLang(), theme: keep?.theme ?? 'auto', textScale: keep?.textScale ?? 1, hints: keep?.hints ?? true,
    name: '', dirty: false, savedAt: null,
    tabs: [], active: 'home', homeView: 'home',
    sounds: [], corpora: [], tools: {}, epoch: 0,
  };
}

let state: AppState = freshState();
const listeners = new Set<() => void>();

function applyEnvironment(prev: AppState | null, next: AppState) {
  const root = document.documentElement;
  if (!prev || prev.theme !== next.theme) {
    if (next.theme === 'auto') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', next.theme);
  }
  if (!prev || prev.textScale !== next.textScale) root.style.setProperty('--ui-scale', String(next.textScale));
  if (!prev || prev.lang !== next.lang) { setLangCore(next.lang); root.lang = next.lang; }
  if (!prev || prev.hints !== next.hints) root.classList.toggle('no-hints', !next.hints);
}
applyEnvironment(null, state);

export const getState = () => state;

/** Replace part of the state. Visual settings (theme, language, text size)
    and navigation do not make the session "dirty"; tool work does. */
export function setState(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>), opts: { dirty?: boolean } = {}) {
  const p = typeof patch === 'function' ? patch(state) : patch;
  const prev = state;
  let next = { ...state, ...p };
  if (opts.dirty) next.dirty = true;
  if (prev.theme !== next.theme || prev.textScale !== next.textScale) next = { ...next, epoch: next.epoch + 1 };
  applyEnvironment(prev, next);
  state = next;
  listeners.forEach((f) => f());
}

export function replaceState(next: AppState) {
  const prev = state;
  applyEnvironment(prev, next);
  state = { ...next, epoch: prev.epoch + 1 };
  listeners.forEach((f) => f());
}

export function subscribe(f: () => void) { listeners.add(f); return () => { listeners.delete(f); }; }

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

/* The OS colour scheme can change under the "auto" theme: redraw. */
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  if (state.theme === 'auto') setState((s) => ({ epoch: s.epoch + 1 }));
});

/** A tool's serialisable state, merged over its defaults (so a session saved
    by an older version still opens). */
export function useToolState<T extends object>(key: string, defaults: T): [T, (patch: Partial<T> | ((s: T) => Partial<T>)) => void] {
  const raw = useApp((s) => s.tools[key]) as Partial<T> | undefined;
  const value = useMemo(() => (raw ? { ...defaults, ...raw } : defaults) as T, [raw]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = useCallback((patch: Partial<T> | ((s: T) => Partial<T>)) => {
    setState((s) => {
      const cur = { ...defaults, ...(s.tools[key] as Partial<T> | undefined) } as T;
      const p = typeof patch === 'function' ? patch(cur) : patch;
      return { tools: { ...s.tools, [key]: { ...cur, ...p } } };
    }, { dirty: true });
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return [value, update];
}

export function getToolState<T>(key: string): T | undefined { return state.tools[key] as T | undefined; }

export const newId = (p = 's') => p + Math.random().toString(36).slice(2, 9);

/** Write into another tool's state — how one tool hands its result to the next. */
export function setToolState(key: string, patch: Record<string, unknown>) {
  setState((s) => ({ tools: { ...s.tools, [key]: { ...(s.tools[key] as object | undefined), ...patch } } }), { dirty: true });
}
