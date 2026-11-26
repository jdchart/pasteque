/* Choosing a sound: drop or import a file, pick one already in the session,
   or synthesise a demo. Whatever is chosen joins the session's library, so
   the next tool can use it too. */

import { useState } from 'react';
import { useApp } from '../session/store';
import { addDemo, importFiles, useSoundVersion, getSound } from '../session/sounds';
import { useT } from '../i18n/react';
import { DropZone, Field, Status, StatusMsg } from './kit';

export function SoundSource({ value, onChange, demos, demoDuration = 4, label }: {
  value: string | null; onChange: (id: string | null) => void; demos: string[]; demoDuration?: number; label?: string;
}) {
  const { t } = useT();
  const sounds = useApp((s) => s.sounds);
  useSoundVersion();
  const [status, setStatus] = useState<StatusMsg>(null);
  const ready = sounds.filter((s) => !s.missing && getSound(s.id));

  const onFiles = async (files: File[]) => {
    const added = await importFiles(files, (m) => setStatus({ msg: m }));
    if (added.length) { onChange(added[0].id); setStatus({ msg: t('sounds.added', { n: added.length }), kind: 'ok' }); }
    else setStatus({ msg: t('err.decode'), kind: 'bad' });
  };
  const onPick = (v: string) => {
    if (!v) return;
    if (v.startsWith('demo:')) {
      try { const m = addDemo(v.slice(5), demoDuration); onChange(m.id); setStatus(null); }
      catch (e) { setStatus({ msg: (e as Error).message, kind: 'bad' }); }
    } else onChange(v.slice(3));
  };
  const cur = value && ready.some((s) => s.id === value) ? 'id:' + value : '';

  return (
    <div className="sound-source">
      <DropZone onFiles={onFiles} compact />
      <Field label={label || t('sounds.pick')}>
        <select value={cur} onChange={(e) => onPick(e.target.value)}>
          <option value="">{t('sounds.none')}</option>
          {ready.length ? (
            <optgroup label={t('sounds.sessionGroup')}>
              {ready.map((s) => <option key={s.id} value={'id:' + s.id}>{s.name}</option>)}
            </optgroup>
          ) : null}
          <optgroup label={t('sounds.demoGroup')}>
            {demos.map((k) => <option key={k} value={'demo:' + k}>{t('demo.' + k)}</option>)}
          </optgroup>
        </select>
      </Field>
      <Status s={status} />
    </div>
  );
}

/** The loaded sound for an id, re-rendering when audio arrives. */
export function useLoadedSound(id: string | null | undefined) {
  useApp((s) => s.sounds);
  useSoundVersion();
  return getSound(id);
}
