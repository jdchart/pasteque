/* The session file: the only way work leaves the page and comes back.

   {
     "format": "pasteque-session", "version": 1, "saved": "<ISO date>",
     "name": "…",
     "prefs":     { lang, theme, textScale, hints },
     "workspace": { tabs, active, homeView },
     "sounds":    [ SoundMeta … ],          // demos carry their recipe
     "tools":     { <toolId>: { … } },      // each tool's own serialisable state
     "audio":     { <soundId>: "<base64 of the original file>" }   // optional
   }

   Fields a version does not know are ignored; missing ones take defaults, so
   old sessions keep opening as tools grow. */

import { useState } from 'react';
import { tr } from '../i18n/core';
import { base64ToBytes, bytesToBase64, pickFiles, readText, saveJSON, slug } from '../lib/io';
import { fmtBytes } from '../lib/fmt';
import { log } from '../lib/log';
import { alertDialog, confirmDialog, openDialog, promptDialog, toast } from '../ui/dialogs';
import { AppState, freshState, getState, replaceState, setState, SoundMeta } from './store';
import { clearSounds, getSoundBytes, importFiles, relink, removeSound, restoreSounds, useSoundVersion, getSound } from './sounds';
import { useT } from '../i18n/react';
import { useApp } from './store';
import { fmtTime } from '../lib/fmt';

export const FORMAT = 'pasteque-session';
export const VERSION = 1;

type SessionFile = {
  format: string; version: number; saved?: string; name?: string;
  prefs?: Partial<Pick<AppState, 'lang' | 'theme' | 'textScale' | 'hints'>>;
  workspace?: Partial<Pick<AppState, 'tabs' | 'active' | 'homeView'>>;
  sounds?: SoundMeta[]; tools?: Record<string, unknown>; audio?: Record<string, string>;
};

function embeddableSize(): number {
  return getState().sounds.reduce((a, s) => a + (s.source === 'file' ? (getSoundBytes(s.id)?.byteLength || 0) : 0), 0);
}

export function buildSession(name: string, embed: boolean): string {
  const s = getState();
  const out: SessionFile = {
    format: FORMAT, version: VERSION, saved: new Date().toISOString(), name,
    prefs: { lang: s.lang, theme: s.theme, textScale: s.textScale, hints: s.hints },
    workspace: { tabs: s.tabs, active: s.active, homeView: s.homeView },
    sounds: s.sounds.map(({ missing, ...m }) => m), // eslint-disable-line @typescript-eslint/no-unused-vars
    tools: s.tools,
  };
  if (embed) {
    out.audio = {};
    for (const m of s.sounds) {
      const b = m.source === 'file' ? getSoundBytes(m.id) : undefined;
      if (b) out.audio[m.id] = bytesToBase64(b);
    }
  }
  return JSON.stringify(out, null, 1);
}

function SaveBody({ close }: { close: (v?: { name: string; embed: boolean } | null) => void }) {
  const { t } = useT();
  const s = getState();
  const size = embeddableSize();
  const [name, setName] = useState(s.name || '');
  const [embed, setEmbed] = useState(size > 0 && size < 60 * 1024 * 1024);
  return (
    <form onSubmit={(e) => { e.preventDefault(); close({ name: name.trim() || t('session.untitled'), embed }); }}>
      <div className="modal-body">
        <p className="muted">{t('session.saveHint')}</p>
        <label className="field"><span className="s-label">{t('session.saveName')}</span>
          <input type="text" value={name} placeholder={t('session.untitled')} onChange={(e) => setName(e.target.value)} data-autofocus /></label>
        {size > 0 ? (
          <label className="check"><input type="checkbox" checked={embed} onChange={(e) => setEmbed(e.target.checked)} />
            <span>{t('session.embed', { size: fmtBytes(Math.round(size * 4 / 3)) })}</span></label>
        ) : <p className="small muted">{t('session.embedNone')}</p>}
        {size > 0 && !embed ? <p className="small muted">{t('session.embedOff')}</p> : null}
      </div>
      <div className="modal-foot">
        <button type="button" onClick={() => close(null)}>{t('cancel')}</button>
        <button type="submit" className="primary">{t('session.saveBtn')}</button>
      </div>
    </form>
  );
}

export async function saveSession() {
  const r = await openDialog<{ name: string; embed: boolean } | null>({ title: tr('session.saveTitle'), dismissValue: null, render: (close) => <SaveBody close={close} /> });
  if (!r) return;
  const text = buildSession(r.name, r.embed);
  const file = (slug(r.name) || 'session') + '.pasteque.json';
  saveJSON(text, file);
  setState({ name: r.name, dirty: false, savedAt: new Date().toISOString() });
  log.ok(tr('session.saved.toast', { name: file }));
  toast(tr('session.saved.toast', { name: file }), 'ok');
}

export async function newSession() {
  const s = getState();
  if (s.dirty && !(await confirmDialog({ title: tr('session.newTitle'), message: tr('session.newMsg'), ok: tr('discard'), danger: true }))) return;
  clearSounds();
  replaceState(freshState(s));
  history.replaceState(null, '', '#/');
}

export async function openSession(file?: File) {
  if (!file) {
    const fs = await pickFiles('.json,application/json');
    if (!fs.length) return;
    file = fs[0];
  }
  let data: SessionFile;
  try {
    data = JSON.parse(await readText(file));
    if (!data || data.format !== FORMAT) throw new Error('format');
  } catch {
    await alertDialog({ title: tr('session.openTitle'), message: tr('session.badFile') });
    return;
  }
  const cur = getState();
  if (cur.dirty && !(await confirmDialog({ title: tr('session.openTitle'), message: tr('session.replaceMsg', { name: data.name || file.name }), ok: tr('continue'), danger: true }))) return;

  const base = freshState(cur);
  const next: AppState = {
    ...base,
    ...(data.prefs || {}),
    name: data.name || '',
    tabs: Array.isArray(data.workspace?.tabs) ? data.workspace!.tabs! : [],
    active: data.workspace?.active || 'home',
    homeView: data.workspace?.homeView || 'home',
    sounds: [], tools: data.tools && typeof data.tools === 'object' ? data.tools : {},
    dirty: false, savedAt: data.saved || null,
  };
  if (!next.tabs.some((t) => t.id === next.active)) next.active = 'home';
  replaceState(next);
  const embedded: Record<string, ArrayBuffer> = {};
  for (const [id, b64] of Object.entries(data.audio || {})) {
    try { embedded[id] = base64ToBytes(b64); } catch { /* left missing */ }
  }
  const missing = await restoreSounds(Array.isArray(data.sounds) ? data.sounds : [], embedded);
  setState({ dirty: false });
  if ((data.version || 0) > VERSION) toast(tr('session.newer'), 'info', 6000);
  log.ok(tr('session.opened', { name: next.name || file.name }));
  toast(tr('session.opened', { name: next.name || file.name }), 'ok');
  if (missing) {
    log.warn(tr('session.missing', { n: missing }));
    toast(tr('session.missing', { n: missing }), 'bad', 7000);
  }
}

export async function renameSession() {
  const v = await promptDialog({ title: tr('session.renameTitle'), label: tr('session.saveName'), value: getState().name });
  if (v !== null) setState({ name: v }, { dirty: true });
}

export async function importSoundsDialog() {
  const fs = await pickFiles('audio/*', true);
  if (!fs.length) return;
  const added = await importFiles(fs);
  if (added.length) toast(tr('sounds.added', { n: added.length }), 'ok');
}

function SoundsBody() {
  const { t } = useT();
  const sounds = useApp((s) => s.sounds);
  useSoundVersion();
  return (
    <div className="modal-body">
      {!sounds.length ? <p className="muted">{t('sounds.empty')}</p> : (
        <table className="table sounds-table"><tbody>
          {sounds.map((s) => {
            const ok = !s.missing && !!getSound(s.id);
            return (
              <tr key={s.id} className={ok ? '' : 'missing'}>
                <td className="left"><b>{s.name}</b><br /><span className="small muted">
                  {s.source === 'demo' ? t('sounds.demo') : t('sounds.file')} · {fmtTime(s.duration)} · {s.sampleRate} Hz{s.size ? ' · ' + fmtBytes(s.size) : ''}
                  {ok ? '' : ' — ' + t('sounds.missing')}</span></td>
                <td className="acts">
                  {!ok && s.source === 'file' ? <button type="button" onClick={async () => { const f = await pickFiles('audio/*'); if (f[0]) await relink(s.id, f[0]).catch((e) => toast((e as Error).message, 'bad')); }}>{t('sounds.relink')}</button> : null}
                  <button type="button" onClick={async () => { if (await confirmDialog({ title: t('sounds.title'), message: t('sounds.removeMsg', { name: s.name }), ok: t('sounds.remove'), danger: true })) removeSound(s.id); }}>{t('sounds.remove')}</button>
                </td>
              </tr>
            );
          })}
        </tbody></table>
      )}
      <div className="row-end"><button type="button" onClick={() => void importSoundsDialog()}>{t('sounds.import')}</button></div>
    </div>
  );
}

export function soundsDialog() {
  return openDialog<void>({ title: tr('sounds.title'), wide: true, render: () => <SoundsBody /> });
}
