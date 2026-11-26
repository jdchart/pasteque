/* Translation core: plain functions, usable outside React (the DSP library
   raises translated errors). Components use the hooks in ./react.tsx. */

export type Lang = 'fr' | 'en';
export type Dict = Record<string, string>;
export type Strings = { fr: Dict; en: Dict };
export type Vars = Record<string, string | number>;

let current: Lang = 'fr';
export const getLang = (): Lang => current;
export const setLangCore = (l: Lang) => { current = l; };

/** French typography: narrow no-break spaces before : ; ! ? » and after «,
    and inside 4+ digit numbers written with a space. */
export function frTypo(s: string): string {
  return s.replace(/ ([:;!?»])/g, ' $1').replace(/« /g, '« ')
          .replace(/(\d) (\d{3})(?!\d)/g, '$1 $2');
}

export function interpolate(s: string, vars?: Vars): string {
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));
}

const registry: Strings[] = [];
/** Strings every module can reach (menus, transport, errors). */
export function registerCommon(S: Strings) { registry.push(S); }

export function lookup(S: Strings | null, key: string, lang: Lang = current): string {
  if (S && S[lang][key] !== undefined) return S[lang][key];
  for (let i = registry.length - 1; i >= 0; i--) {
    const v = registry[i][lang][key];
    if (v !== undefined) return v;
  }
  if (S && S.fr[key] !== undefined) return S.fr[key];
  return key;
}

export function translate(S: Strings | null, key: string, vars?: Vars, lang: Lang = current): string {
  return interpolate(lookup(S, key, lang), vars);
}

/** Translate with the common strings only. */
export const tr = (key: string, vars?: Vars) => translate(null, key, vars);

export function escapeHtml(s: string): string {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Rich text: the template is ours (it may carry <strong>, <span class> and
    *emphasis*); the variables are escaped, so a file name can never inject markup. */
export function richHtml(S: Strings | null, key: string, vars?: Vars, lang: Lang = current): string {
  const safe: Vars = {};
  if (vars) for (const k of Object.keys(vars)) safe[k] = escapeHtml(String(vars[k]));
  return interpolate(lookup(S, key, lang), safe).replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
}

/** Strip the *emphasis* markers for plain-text uses (status lines, options). */
export const plain = (s: string) => String(s).replace(/\*/g, '');

/** Apply frTypo to every French string of a dictionary. */
export function withFrTypo(S: Strings): Strings {
  const fr: Dict = {};
  for (const k of Object.keys(S.fr)) fr[k] = frTypo(S.fr[k]);
  return { fr, en: S.en };
}
