import { createElement, useMemo } from 'react';
import { useApp } from '../session/store';
import { Lang, Strings, translate, richHtml, plain, Vars } from './core';

export type T = {
  lang: Lang;
  /** plain text (the *emphasis* markers stripped) */
  t: (key: string, vars?: Vars) => string;
  /** HTML: trusted template, escaped variables */
  rich: (key: string, vars?: Vars) => string;
};

export function useT(S: Strings | null = null): T {
  const lang = useApp((s) => s.lang);
  return useMemo(() => ({
    lang,
    t: (k: string, v?: Vars) => plain(translate(S, k, v, lang)),
    rich: (k: string, v?: Vars) => richHtml(S, k, v, lang),
  }), [lang, S]);
}

/** Render a rich string produced by useT().rich */
export function Rich({ html, as = 'span', className, id }: { html: string; as?: string; className?: string; id?: string }) {
  return createElement(as, { className, id, dangerouslySetInnerHTML: { __html: html } });
}
