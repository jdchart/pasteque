/* Navigation: catalog views live in the pinned Home tab; tools and lessons
   open as their own tabs and stay mounted until closed. The URL hash mirrors
   where you are, so links are shareable and Back works:
     #/  #/learn  #/sandbox  #/about  #/sandbox/<tool>
     #/learn/<course> (its landing page)  #/learn/<lesson>[/<part>] */

import { findCourse, findLesson, findTool } from '../catalog';
import { getState, HomeView, setState, subscribe, Tab } from '../session/store';

export const tabId = (kind: 'tool' | 'lesson', ref: string) => kind + ':' + ref;

export function routeOf(): string {
  const s = getState();
  if (s.active === 'home') {
    if (s.homeView.startsWith('course:')) return '/learn/' + s.homeView.slice(7);
    return s.homeView === 'home' ? '/' : '/' + s.homeView;
  }
  const tab = s.tabs.find((t) => t.id === s.active);
  if (!tab) return '/';
  return (tab.kind === 'tool' ? '/sandbox/' : '/learn/') + tab.ref + (tab.sub ? '/' + tab.sub : '');
}

export function showHome(view: HomeView = 'home') { setState({ active: 'home', homeView: view }); }
export function showCourse(id: string) { showHome(`course:${id}`); }

export function openItem(kind: 'tool' | 'lesson', ref: string, sub?: string) {
  if (kind === 'tool' ? !findTool(ref) : !findLesson(ref)) { showHome(kind === 'tool' ? 'sandbox' : 'learn'); return; }
  const id = tabId(kind, ref);
  setState((s) => {
    const exists = s.tabs.find((t) => t.id === id);
    const tabs: Tab[] = exists
      ? s.tabs.map((t) => (t.id === id && sub !== undefined ? { ...t, sub } : t))
      : [...s.tabs, { id, kind, ref, sub }];
    return { tabs, active: id };
  });
}

export function activate(id: string) { setState({ active: id }); }

export function setTabSub(id: string, sub: string) {
  setState((s) => ({ tabs: s.tabs.map((t) => (t.id === id ? { ...t, sub } : t)) }));
}

export function closeTab(id: string) {
  const s = getState();
  const i = s.tabs.findIndex((t) => t.id === id);
  if (i < 0) return;
  const tabs = s.tabs.filter((t) => t.id !== id);
  let active = s.active;
  if (active === id) active = tabs.length ? tabs[Math.min(i, tabs.length - 1)].id : 'home';
  setState({ tabs, active });
}

export function closeAllTabs() { setState({ tabs: [], active: 'home' }); }

export function cycleTab(dir: 1 | -1) {
  const s = getState();
  const ids = ['home', ...s.tabs.map((t) => t.id)];
  const i = ids.indexOf(s.active);
  setState({ active: ids[(i + dir + ids.length) % ids.length] });
}

export function navigate(route: string) {
  const parts = route.replace(/^#?\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!parts.length) return showHome('home');
  if (parts[0] === 'about') return showHome('about');
  if (parts[0] === 'sandbox') return parts[1] ? openItem('tool', parts[1]) : showHome('sandbox');
  if (parts[0] === 'learn') {
    if (!parts[1]) return showHome('learn');
    if (findCourse(parts[1])) return showCourse(parts[1]);
    return openItem('lesson', parts[1], parts[2]);
  }
  showHome('home');
}

/** Keep the hash and the state in step, in both directions. */
export function startHashSync() {
  navigate(location.hash);
  let last = routeOf();
  if (location.hash !== '#' + last) history.replaceState(null, '', '#' + last);
  const unsub = subscribe(() => {
    const r = routeOf();
    if (r === last) return;
    last = r;
    if (location.hash !== '#' + r) history.pushState(null, '', '#' + r);
  });
  const onPop = () => { const r = location.hash.replace(/^#/, '') || '/'; if (r !== last) navigate(r); };
  window.addEventListener('popstate', onPop);
  window.addEventListener('hashchange', onPop);
  return () => { unsub(); window.removeEventListener('popstate', onPop); window.removeEventListener('hashchange', onPop); };
}
