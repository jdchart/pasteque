/* A multi-sound picker for the corpus tools: drop files, or add a session
   sound or a demo; the list itself is the caller's (an array of sound ids). */

import { useState } from 'react';
import { useApp } from '../session/store';
import { addDemo, importFiles, useSoundVersion, getSound } from '../session/sounds';
import { useT } from '../i18n/react';
import { DropZone, Status, StatusMsg } from './kit';

export function SoundAdder({ ids, onAdd, demos, demoDuration, onOther, accept, main, formats, label }: {
  ids: string[]; onAdd: (ids: string[]) => void; demos: string[]; demoDuration?: number;
  /** files that are not audio (a CSV, a corpus.json) go here */
  onOther?: (files: File[]) => void; accept?: string; main?: string; formats?: string; label?: string;
}) {
  const { t } = useT();
  const sounds = useApp((s) => s.sounds);
  useSoundVersion();
  const [status, setStatus] = useState<StatusMsg>(null);
  const others = sounds.filter((s) => !s.missing && getSound(s.id) && !ids.includes(s.id));
  return (
    <div className="sound-source">
      <DropZone multiple accept={accept} main={main} formats={formats} onFiles={async (all) => {
        const isAudio = (f: File) => f.type.startsWith('audio/') || /\.(wav|mp3|flac|m4a|ogg|oga|aiff?|aac|webm)$/i.test(f.name);
        const other = all.filter((f) => !isAudio(f)), fs = all.filter(isAudio);
        if (other.length && onOther) onOther(other);
        if (!fs.length) return;
        const added = await importFiles(fs, (m) => setStatus({ msg: m }));
        if (added.length) { onAdd(added.map((a) => a.id)); setStatus({ msg: t('sounds.added', { n: added.length }), kind: 'ok' }); }
        else setStatus({ msg: t('err.decode'), kind: 'bad' });
      }} />
      <label className="field"><span className="s-label">{label || t('files.add')}</span>
        <select value="" onChange={(e) => {
          const v = e.target.value; if (!v) return;
          if (v.startsWith('demo:')) { try { onAdd([addDemo(v.slice(5), demoDuration).id]); } catch (err) { setStatus({ msg: (err as Error).message, kind: 'bad' }); } }
          else onAdd([v.slice(3)]);
        }}>
          <option value="">{t('sounds.none')}</option>
          {others.length ? <optgroup label={t('sounds.sessionGroup')}>{others.map((s) => <option key={s.id} value={'id:' + s.id}>{s.name}</option>)}</optgroup> : null}
          <optgroup label={t('sounds.demoGroup')}>{demos.map((k) => <option key={k} value={'demo:' + k}>{t('demo.' + k)}</option>)}</optgroup>
        </select>
      </label>
      <Status s={status} />
    </div>
  );
}
