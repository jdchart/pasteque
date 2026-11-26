/* The journal: what used to be the on-page console of each tool. Every status
   line marked 'bad' lands here too, so a failure always leaves a trace. */

export type Level = 'info' | 'ok' | 'warn' | 'err';
export type Entry = { id: number; t: Date; level: Level; msg: string };

let entries: Entry[] = [];
let seq = 0;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

function push(level: Level, msg: string) {
  entries = [...entries.slice(-499), { id: ++seq, t: new Date(), level, msg }];
  emit();
}

export const log = {
  info: (m: string) => push('info', m),
  ok: (m: string) => push('ok', m),
  warn: (m: string) => push('warn', m),
  error: (m: string) => push('err', m),
  clear: () => { entries = []; emit(); },
  all: () => entries,
  text: () => entries.map((e) => e.t.toLocaleTimeString() + ' ' + e.level.toUpperCase() + ' ' + e.msg).join('\n'),
  subscribe: (f: () => void) => { listeners.add(f); return () => { listeners.delete(f); }; },
};

if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => log.error((e.message || 'Error') +
    (e.filename ? ' — ' + String(e.filename).split('/').pop() + ':' + e.lineno : '')));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { message?: string } | undefined;
    log.error('Unhandled: ' + (r && r.message ? r.message : String(r)));
  });
}
