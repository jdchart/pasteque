/* The frame every tool and lesson sits in: its title, its place in the
   course, a link to the classic page, then the work area. */

import { ReactNode } from 'react';
import { ToolEntry, LessonEntry, pick } from '../catalog';
import { useT, Rich } from '../i18n/react';

export function ToolFrame({ entry, lede, children, actions }: {
  entry: ToolEntry | LessonEntry; lede?: string; children: ReactNode; actions?: ReactNode;
}) {
  const { lang, t } = useT();
  return (
    <div className="tool">
      <header className="tool-head">
        <div className="tool-titles">
          <span className="s-label">{pick(entry.tag, lang)} · {t(entry.kind === 'tool' ? 'tool' : 'lesson')}</span>
          <h1><span className="glyph" aria-hidden="true">{entry.glyph}</span>{pick(entry.title, lang)}</h1>
          <p className="subtitle">{pick(entry.subtitle, lang)}</p>
        </div>
        <div className="tool-actions">
          {actions}
          {entry.kind === 'lesson' && entry.legacy ? <a className="pill-link" href={entry.legacy} target="_blank" rel="noopener" title={entry.legacy}>{t('tab.legacy')} ↗</a> : null}
        </div>
      </header>
      {lede ? <Rich as="p" className="lede tool-lede hint" html={lede} /> : null}
      {children}
    </div>
  );
}
