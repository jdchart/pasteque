/* The application shell: top bar (brand, menus, session, language, theme),
   the ruler, the tab strip, the panes (tabs stay mounted while open), and a
   status bar with the journal. */

import { Suspense, useEffect, useState, useSyncExternalStore } from 'react';
import { PaneBoundary } from './ui/PaneBoundary';
import { COURSES, TOOLS, pick, findLesson, findTool } from './catalog';
import { COMPONENTS } from './catalogComponents';
import { useT } from './i18n/react';
import { tr } from './i18n/core';
import { getState, setState, useApp, Tab } from './session/store';
import { importSoundsDialog, newSession, openSession, renameSession, saveSession, soundsDialog } from './session/file';
import { importFiles } from './session/sounds';
import { activate, closeAllTabs, closeTab, cycleTab, openItem, showCourse, showHome, startHashSync } from './shell/nav';
import { Menu, Menubar } from './shell/Menubar';
import { Logo } from './shell/Logo';
import { DialogHost, anyDialogOpen, openDialog, toast } from './ui/dialogs';
import { AboutPage, CoursePage, HomePage, LearnPage, SandboxPage } from './pages/Pages';
import { log, Entry } from './lib/log';
import { Seg } from './ui/kit';

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const MOD = isMac ? '⌘' : 'Ctrl+';

function Journal() {
  const { t } = useT();
  const entries = useSyncExternalStore(log.subscribe, log.all);
  return (
    <>
      <div className="modal-body journal">
        {!entries.length ? <p className="muted">{t('journal.empty')}</p> : (
          <ul>{[...entries].reverse().map((e) => (
            <li key={e.id} className={'lv-' + e.level}><time>{e.t.toLocaleTimeString()}</time><b>{e.level.toUpperCase()}</b><span>{e.msg}</span></li>
          ))}</ul>
        )}
      </div>
      <div className="modal-foot">
        <button type="button" onClick={() => log.clear()}>{t('journal.clear')}</button>
        <button type="button" onClick={() => { void navigator.clipboard?.writeText(log.text()).then(() => toast(t('journal.copied'), 'ok')); }}>{t('journal.copy')}</button>
      </div>
    </>
  );
}
const openJournal = () => openDialog<void>({ title: tr('journal.title'), wide: true, render: () => <Journal /> });

function Shortcuts() {
  const { t } = useT();
  const rows: [string, string][] = [
    [MOD + 'S', t('k.save')], [MOD + 'O', t('k.open')], ['Ctrl+Alt+→ / ←', t('k.tabs')],
    ['Alt+W', t('k.close')], ['F10', t('k.menu')], ['Espace', t('k.play')],
  ];
  return <div className="modal-body"><table className="table keys"><tbody>{rows.map(([k, v]) => <tr key={k}><td><kbd>{k}</kbd></td><td className="left">{v}</td></tr>)}</tbody></table></div>;
}

function StatusBar() {
  const { t } = useT();
  const entries = useSyncExternalStore(log.subscribe, log.all);
  const sounds = useApp((s) => s.sounds);
  const last: Entry | undefined = entries[entries.length - 1];
  const errors = entries.filter((e) => e.level === 'err').length;
  return (
    <footer className="statusbar">
      <button type="button" className="sb-log" onClick={() => void openJournal()} title={t('m.journal')}>
        <span className={'dot lv-' + (last ? last.level : 'none')} />
        <span className="sb-msg">{last ? last.msg : t('journal.empty')}</span>
      </button>
      <span className="grow" />
      {errors ? <button type="button" className="sb-btn bad" onClick={() => void openJournal()}>{errors} ✕</button> : null}
      <button type="button" className="sb-btn" onClick={() => void soundsDialog()}>♪ {sounds.length}</button>
      <button type="button" className="sb-btn" onClick={() => void openJournal()}>{t('m.journal')}</button>
    </footer>
  );
}

function TabBar() {
  const { t, lang } = useT();
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const label = (tab: Tab) => {
    const e = tab.kind === 'tool' ? findTool(tab.ref) : findLesson(tab.ref);
    return e ? [e.glyph, pick(e.title, lang)] : ['?', tab.ref];
  };
  return (
    <nav className="tabbar" role="tablist" aria-label="Onglets">
      <button type="button" role="tab" aria-selected={active === 'home'} className={'tab home' + (active === 'home' ? ' on' : '')} onClick={() => activate('home')}>
        <Logo size={15} /><span>{t('tab.home')}</span>
      </button>
      {tabs.map((tab) => {
        const [g, title] = label(tab);
        return (
          <div key={tab.id} role="tab" aria-selected={active === tab.id} className={'tab' + (active === tab.id ? ' on' : '')}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(tab.id); } }}>
            <button type="button" className="tab-main" onClick={() => activate(tab.id)}><span className="glyph" aria-hidden="true">{g}</span><span>{title}</span>{tab.kind === 'lesson' ? <small className="tab-kind">{t('lesson')}</small> : null}</button>
            <button type="button" className="tab-x" aria-label={t('tab.close') + ' ' + title} onClick={() => closeTab(tab.id)}>×</button>
          </div>
        );
      })}
    </nav>
  );
}

function Pane({ tab, on }: { tab: Tab; on: boolean }) {
  const C = COMPONENTS[tab.kind + ':' + tab.ref];
  return (
    <div className="pane" hidden={!on} role="tabpanel">
      {C ? <PaneBoundary><Suspense fallback={<div className="pane-loading"><span className="spin" /></div>}><C tab={tab} /></Suspense></PaneBoundary> : null}
    </div>
  );
}

function HomePane({ on }: { on: boolean }) {
  const view = useApp((s) => s.homeView);
  return (
    <div className="pane" hidden={!on} role="tabpanel">
      {view.startsWith('course:') ? <CoursePage id={view.slice(7)} /> : view === 'learn' ? <LearnPage /> : view === 'sandbox' ? <SandboxPage /> : view === 'about' ? <AboutPage /> : <HomePage />}
    </div>
  );
}

export default function App() {
  const { t, lang } = useT();
  const theme = useApp((s) => s.theme);
  const textScale = useApp((s) => s.textScale);
  const hints = useApp((s) => s.hints);
  const name = useApp((s) => s.name);
  const dirty = useApp((s) => s.dirty);
  const tabs = useApp((s) => s.tabs);
  const active = useApp((s) => s.active);
  const [menuSignal, setMenuSignal] = useState(0);
  const [dropping, setDropping] = useState(false);

  useEffect(() => startHashSync(), []);
  useEffect(() => { document.title = (name ? name + ' · ' : '') + 'pastèque'; }, [name]);

  // leaving with unsaved work: the one place a browser dialog is unavoidable
  useEffect(() => {
    const f = (e: BeforeUnloadEvent) => { if (getState().dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', f);
    return () => window.removeEventListener('beforeunload', f);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (anyDialogOpen()) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && !e.altKey && e.code === 'KeyS') { e.preventDefault(); void saveSession(); }
      else if (mod && !e.altKey && e.code === 'KeyO') { e.preventDefault(); void openSession(); }
      else if (e.altKey && !mod && e.code === 'KeyW') { const a = getState().active; if (a !== 'home') { e.preventDefault(); closeTab(a); } }
      else if (e.ctrlKey && e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) { e.preventDefault(); cycleTab(e.key === 'ArrowRight' ? 1 : -1); }
      else if (e.key === 'F10') { e.preventDefault(); setMenuSignal((n) => n + 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // a session file or sounds dropped anywhere that is not a drop zone
  useEffect(() => {
    let depth = 0;
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files');
    const enter = (e: DragEvent) => { if (hasFiles(e)) { depth++; setDropping(true); } };
    const leave = () => { depth = Math.max(0, depth - 1); if (!depth) setDropping(false); };
    const over = (e: DragEvent) => { if (hasFiles(e)) e.preventDefault(); };
    const drop = (e: DragEvent) => {
      depth = 0; setDropping(false);
      if (!hasFiles(e)) return;
      e.preventDefault();
      const fs = Array.from(e.dataTransfer?.files || []);
      const json = fs.find((f) => /\.json$/i.test(f.name));
      if (json) { void openSession(json); return; }
      const audio = fs.filter((f) => f.type.startsWith('audio/') || /\.(wav|mp3|flac|m4a|ogg|aiff?)$/i.test(f.name));
      if (audio.length) void importFiles(audio).then((a) => { if (a.length) toast(tr('sounds.added', { n: a.length }), 'ok'); });
    };
    window.addEventListener('dragenter', enter); window.addEventListener('dragleave', leave);
    window.addEventListener('dragover', over); window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter); window.removeEventListener('dragleave', leave);
      window.removeEventListener('dragover', over); window.removeEventListener('drop', drop);
    };
  }, []);

  const menus: Menu[] = [
    { id: 'session', label: t('menu.session'), items: [
      { label: t('m.new'), onSelect: () => void newSession() },
      { label: t('m.open'), onSelect: () => void openSession(), shortcut: MOD + 'O' },
      { label: t('m.save'), onSelect: () => void saveSession(), shortcut: MOD + 'S' },
      { label: t('m.rename'), onSelect: () => void renameSession() },
      { kind: 'sep' },
      { label: t('m.importSounds'), onSelect: () => void importSoundsDialog() },
      { label: t('m.sounds'), onSelect: () => void soundsDialog() },
      { kind: 'sep' },
      { label: t('m.closeTab'), onSelect: () => { if (active !== 'home') closeTab(active); }, disabled: active === 'home', shortcut: 'Alt+W' },
      { label: t('m.closeAll'), onSelect: closeAllTabs, disabled: !tabs.length },
    ] },
    { id: 'learn', label: t('menu.learn'), items: [
      { label: t('m.allCourses'), onSelect: () => showHome('learn') },
      { kind: 'sep' },
      ...COURSES.map((c) => ({ label: pick(c.title, lang), glyph: c.glyph, hint: c.soon ? t('soon') : t('course.nModules', { n: c.modules.length }), onSelect: () => showCourse(c.id) })),
    ] },
    { id: 'sandbox', label: t('menu.sandbox'), items: [
      { label: t('m.allTools'), onSelect: () => showHome('sandbox') },
      { kind: 'sep' },
      ...TOOLS.map((e) => ({ label: pick(e.title, lang), glyph: e.glyph, hint: pick(e.tag, lang), onSelect: () => openItem('tool', e.id) })),
    ] },
    { id: 'view', label: t('menu.view'), items: [
      { label: t('m.home'), onSelect: () => showHome('home') },
      { kind: 'sep' },
      { label: t('m.themeAuto'), checked: theme === 'auto', onSelect: () => setState({ theme: 'auto' }) },
      { label: t('m.themeLight'), checked: theme === 'light', onSelect: () => setState({ theme: 'light' }) },
      { label: t('m.themeDark'), checked: theme === 'dark', onSelect: () => setState({ theme: 'dark' }) },
      { kind: 'sep' },
      { label: t('m.langFr'), checked: lang === 'fr', onSelect: () => setState({ lang: 'fr' }) },
      { label: t('m.langEn'), checked: lang === 'en', onSelect: () => setState({ lang: 'en' }) },
      { kind: 'sep' },
      { label: t('m.hints'), checked: hints, onSelect: () => setState({ hints: !hints }) },
      { label: t('m.textBigger'), onSelect: () => setState({ textScale: Math.min(1.5, +(textScale + 0.1).toFixed(2)) }) },
      { label: t('m.textSmaller'), onSelect: () => setState({ textScale: Math.max(0.8, +(textScale - 0.1).toFixed(2)) }) },
      { label: t('m.textReset'), onSelect: () => setState({ textScale: 1 }), disabled: textScale === 1 },
      { kind: 'sep' },
      { label: t('m.journal'), onSelect: () => void openJournal() },
    ] },
    { id: 'help', label: t('menu.help'), items: [
      { label: t('m.about'), onSelect: () => showHome('about') },
      { label: t('m.shortcuts'), onSelect: () => void openDialog<void>({ title: tr('shortcuts.title'), render: () => <Shortcuts /> }) },
      { label: t('m.classic'), onSelect: () => showHome('about') },
    ] },
  ];

  return (
    <div className="app">
      <header className="topbar">
        <button type="button" className="brand" onClick={() => showHome('home')} title={t('tab.home')}>
          <Logo size={22} /><span className="s-brand">{t('app.name')}</span>
        </button>
        <Menubar menus={menus} openSignal={menuSignal} />
        <span className="grow" />
        <button type="button" className={'session-chip' + (dirty ? ' dirty' : '')} onClick={() => void renameSession()} title={t('m.rename') + (dirty ? ' — ' + t('session.unsaved') : '')}>
          <span className="pip" /><span className="chip-name">{name || t('session.untitled')}</span>
        </button>
        <Seg label="Langue / Language" value={lang} onChange={(v) => setState({ lang: v })} options={[{ value: 'fr', label: 'FR' }, { value: 'en', label: 'EN' }]} />
        <button type="button" className="icon-btn theme-btn" title={t(theme === 'dark' ? 'm.themeDark' : theme === 'light' ? 'm.themeLight' : 'm.themeAuto')}
          onClick={() => setState({ theme: theme === 'auto' ? 'light' : theme === 'light' ? 'dark' : 'auto' })}>
          {theme === 'dark' ? '☾' : theme === 'light' ? '☀' : '◐'}
        </button>
      </header>
      <div className="s-ruler" />
      <TabBar />
      <main className="panes">
        <HomePane on={active === 'home'} />
        {tabs.map((tab) => <Pane key={tab.id} tab={tab} on={active === tab.id} />)}
      </main>
      <StatusBar />
      <DialogHost />
      {dropping ? <div className="drop-veil"><div className="s-card">{t('session.dropHint')}</div></div> : null}
    </div>
  );
}
