/* The catalog views shown in the pinned Home tab: the main menu, Learn,
   Sandbox and About. */

import { Course, COURSES, findCourse, findItem, LESSONS, pick, TOOL_GROUPS, TOOLS, ToolEntry, LessonEntry } from '../catalog';
import { useT, Rich } from '../i18n/react';
import { openItem, showCourse, showHome } from '../shell/nav';
import { useApp } from '../session/store';
import { newSession, openSession, saveSession } from '../session/file';

/** A course as a card: opens its landing page. */
function CourseCard({ c }: { c: Course }) {
  const { lang, t } = useT();
  return (
    <button type="button" className={'card s-card course-card' + (c.soon ? ' soon' : '')} onClick={() => showCourse(c.id)}>
      <span className="card-glyph" aria-hidden="true">{c.glyph}</span>
      <span className="card-kicker s-label">{pick(c.meta, lang)}</span>
      <h3>{pick(c.title, lang)}</h3>
      <p>{pick(c.blurb, lang)}</p>
      <span className="s-label card-foot">{c.soon ? t('soon') : t('course.nModules', { n: c.modules.length })} →</span>
    </button>
  );
}

/** A tool or lesson as a tile: big glyph, title, one line. */
function Tile({ e }: { e: ToolEntry | LessonEntry }) {
  const { lang, t } = useT();
  const line = e.kind === 'tool' ? pick(e.short, lang) : pick(e.subtitle, lang);
  return (
    <button type="button" className={'tile s-card ' + e.kind} onClick={() => openItem(e.kind, e.id)}>
      <span className="tile-glyph" aria-hidden="true">{e.glyph}</span>
      <span className="tile-text">
        <span className="s-label">{t(e.kind === 'tool' ? 'tool' : 'lesson')}</span>
        <strong>{pick(e.title, lang)}</strong>
        <span className="tile-line">{line}</span>
      </span>
    </button>
  );
}

/** The home illustration: a watermelon slice cut along a waveform. The flat
    cut is the time axis; the flesh carries partials (concentric arcs) and the
    seeds sit on them like notes. Theme colours only, so it follows dark mode. */
function HeroArt() {
  const W = 520, H = 330, cx = 260, top = 92, R = 210;
  const wave = (() => {
    let d = '';
    for (let i = 0; i <= 520; i++) {
      const x = i, u = (x - cx) / 250;
      const env = Math.exp(-u * u * 2.2) * (0.35 + 0.65 * Math.abs(Math.sin(x * 0.021)));
      const y = top - 34 * env * (Math.sin(x * 0.19) * 0.75 + Math.sin(x * 0.47 + 1) * 0.25);
      d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }
    return d;
  })();
  const arcs = [0.28, 0.44, 0.58, 0.7, 0.8, 0.88];
  const seeds: { x: number; y: number; a: number }[] = [];
  [[0.44, [-58, -30, 4, 36, 64]], [0.7, [-66, -44, -20, 22, 46, 70]], [0.58, [-12, 18]]].forEach(([f, angs]) => {
    (angs as number[]).forEach((deg) => {
      const r = (f as number) * (R - 22), t = (90 + deg) * Math.PI / 180;
      seeds.push({ x: cx + r * Math.cos(t), y: top + r * Math.sin(t), a: deg });
    });
  });
  const bars = Array.from({ length: 34 }, (_, i) => {
    const x = cx - 170 + i * 10.3, u = (i - 16.5) / 17;
    const h = 16 + 70 * Math.exp(-u * u * 3) * (0.55 + 0.45 * Math.abs(Math.cos(i * 0.9)));
    return { x, h };
  });
  return (
    <svg className="hero-art" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="pastèque">
      <defs>
        <clipPath id="hero-flesh"><path d={`M${cx - R + 26} ${top} A${R - 26} ${R - 26} 0 0 0 ${cx + R - 26} ${top} Z`} /></clipPath>
      </defs>
      {/* rind, pith, flesh */}
      <path d={`M${cx - R} ${top} A${R} ${R} 0 0 0 ${cx + R} ${top} Z`} className="ha-rind" />
      <path d={`M${cx - R + 12} ${top} A${R - 12} ${R - 12} 0 0 0 ${cx + R - 12} ${top} Z`} className="ha-pith" />
      <path d={`M${cx - R + 26} ${top} A${R - 26} ${R - 26} 0 0 0 ${cx + R - 26} ${top} Z`} className="ha-flesh" />
      <g clipPath="url(#hero-flesh)">
        {bars.map((b, i) => <rect key={i} x={b.x} y={top} width={6} height={b.h} className="ha-bar" />)}
        {arcs.map((f) => { const r = f * (R - 22); return <path key={f} d={`M${cx - r} ${top} A${r} ${r} 0 0 0 ${cx + r} ${top}`} className="ha-arc" />; })}
      </g>
      {seeds.map((sd, i) => <ellipse key={i} cx={sd.x} cy={sd.y} rx={4} ry={7} transform={`rotate(${sd.a} ${sd.x} ${sd.y})`} className="ha-seed" />)}
      {/* the cut: an axis, and the sound running along it */}
      <line x1={0} x2={W} y1={top} y2={top} className="ha-axis" />
      {Array.from({ length: 27 }, (_, i) => <line key={i} x1={i * 20} x2={i * 20} y1={top} y2={top + (i % 5 ? 4 : 8)} className="ha-tick" />)}
      <path d={wave} className="ha-wave" />
    </svg>
  );
}

export function HomePage() {
  const { t, lang } = useT();
  const tabs = useApp((s) => s.tabs.length);
  const sounds = useApp((s) => s.sounds.length);
  const name = useApp((s) => s.name);
  const dirty = useApp((s) => s.dirty);
  return (
    <div className="page home">
      <header className="hero2">
        <div className="hero2-text">
          <span className="s-label">{t('app.org')}</span>
          <h1 className="hero2-title">{t('app.name')}</h1>
          <p className="hero2-lede">{t('home.lede')}</p>
          <div className="hero2-cta">
            <button type="button" className="primary big" onClick={() => showHome('learn')}>{t('home.learn')} →</button>
            <button type="button" className="big" onClick={() => showHome('sandbox')}>{t('home.sandbox')} →</button>
          </div>
        </div>
        <HeroArt />
      </header>

      <section className="home-band">
        <div className="band-head"><span className="band-n">01</span><h2>{t('home.learn')}</h2><p className="muted">{t('home.learnHint')}</p>
          <button type="button" className="link-btn" onClick={() => showHome('learn')}>{t('m.allCourses')} →</button></div>
        <div className="cards">{COURSES.map((c) => <CourseCard key={c.id} c={c} />)}</div>
      </section>

      <section className="home-band">
        <div className="band-head"><span className="band-n">02</span><h2>{t('home.sandbox')}</h2><p className="muted">{t('home.sandboxHint')}</p>
          <button type="button" className="link-btn" onClick={() => showHome('sandbox')}>{t('m.allTools')} →</button></div>
        <div className="home-tools">
          {TOOLS.map((e) => (
            <button key={e.id} type="button" className="home-tool" onClick={() => openItem('tool', e.id)}>
              <span className="home-tool-glyph" aria-hidden="true">{e.glyph}</span>
              <span className="home-tool-text"><strong>{pick(e.title, lang)}</strong><span>{pick(e.short, lang)}</span></span>
              <span className="home-tool-tag s-label">{pick(e.tag, lang)}</span>
            </button>
          ))}
        </div>
      </section>

      <section className="home-band">
        <div className="band-head"><span className="band-n">03</span><h2>{t('home.session')}</h2><p className="muted">{t('home.sessionHint')}</p></div>
        <div className="session-strip s-card">
          <div>
            <strong className="session-name">{name || t('session.untitled')}</strong>
            {dirty ? <span className="session-dirty">{t('session.unsaved')}</span> : null}
            <span className="small mono muted session-meta">{t('home.tabs', { n: tabs, s: sounds })}</span>
          </div>
          <div className="row">
            <button type="button" className="primary" onClick={() => void openSession()}>{t('home.open')}</button>
            <button type="button" onClick={() => void saveSession()}>{t('home.save')}</button>
            <button type="button" onClick={() => void newSession()}>{t('home.new')}</button>
          </div>
        </div>
      </section>
    </div>
  );
}

export function LearnPage() {
  const { t } = useT();
  return (
    <div className="page">
      <h1>{t('learn.title')}</h1>
      <p className="lede">{t('learn.lede')}</p>
      <div className="cards">{COURSES.map((c) => <CourseCard key={c.id} c={c} />)}</div>
    </div>
  );
}

export function CoursePage({ id }: { id: string }) {
  const { t, lang } = useT();
  const c = findCourse(id);
  if (!c) return <LearnPage />;
  return (
    <div className="page course-page">
      <button type="button" className="link-btn back" onClick={() => showHome('learn')}>← {t('course.back')}</button>
      <header className="course-head">
        <span className="course-glyph" aria-hidden="true">{c.glyph}</span>
        <div>
          <span className="s-label">{pick(c.meta, lang)}</span>
          <h1>{pick(c.title, lang)}</h1>
          <p className="lede">{pick(c.blurb, lang)}</p>
        </div>
      </header>
      {c.intro.map((p, i) => <p key={i} className="course-intro">{pick(p, lang)}</p>)}
      {c.soon || !c.modules.length ? <p className="s-label">{t('course.empty')}</p> : (
        <ol className="modules">
          {c.modules.map((m) => (
            <li key={m.n} className="module" id={'module-' + c.id + '-' + m.n}>
              <div className="module-n" aria-hidden="true">{m.n}</div>
              <div className="module-body">
                <span className="s-label">{t('course.module', { n: m.n })}</span>
                <h2>{pick(m.title, lang)}</h2>
                <p>{pick(m.blurb, lang)}</p>
                <div className="tiles">
                  {m.items.map((ref) => { const e = findItem(ref); return e ? <Tile key={ref} e={e} /> : null; })}
                </div>
              </div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

export function SandboxPage() {
  const { t, lang } = useT();
  return (
    <div className="page">
      <h1>{t('sandbox.title')}</h1>
      <p className="lede">{t('sandbox.lede')}</p>
      {TOOL_GROUPS.map((g) => (
        <section key={g.fr}>
          <h2 className="section-title">{pick(g, lang)}</h2>
          <div className="tool-cards">
            {TOOLS.filter((e) => e.tag.fr === g.fr).map((e) => (
              <button key={e.id} type="button" className="tool-card s-card" onClick={() => openItem('tool', e.id)}>
                <span className="tool-card-glyph" aria-hidden="true">{e.glyph}</span>
                <strong>{pick(e.title, lang)}</strong>
                <span>{pick(e.short, lang)}</span>
              </button>
            ))}
          </div>
        </section>
      ))}
      <p className="small muted">{t('home.classic')}</p>
    </div>
  );
}

const ABOUT = {
  fr: `<p><b>pastèque</b> réunit les outils d’écoute et d’analyse sonore qui accompagnent les cours de musicologie de Jacob Hart (Université Rennes 2) : des <em>leçons</em> qui expliquent et font écouter, et un <em>bac à sable</em> d’outils libres.</p>
<p>Tout est calculé dans votre navigateur. Les sons que vous chargez ne quittent pas votre machine ; rien n’est gardé dans le navigateur non plus. Votre travail tient dans un <b>fichier de session</b> (JSON) que vous téléchargez et rouvrez quand vous voulez — avec, si vous le souhaitez, les sons eux-mêmes.</p>
<p>Les pages d’origine restent en ligne à leurs anciennes adresses (menu Aide › Pages classiques).</p>
<p class="small muted">Analyse : Meyda 5.6.3 (MIT) ; FFT, YIN, détection d’attaques, auto-similarité, HPSS, NMF, PCA, MDS, Isomap, t-SNE et UMAP maison. Police : JetBrains Mono (OFL).</p>`,
  en: `<p><b>pastèque</b> gathers the listening and sound-analysis tools that go with Jacob Hart’s musicology courses (Université Rennes 2): <em>lessons</em> that explain and make you listen, and a <em>sandbox</em> of open tools.</p>
<p>Everything is computed in your browser. The sounds you load never leave your machine, and nothing is kept in the browser either. Your work fits in a <b>session file</b> (JSON) you download and reopen whenever you like — with the sounds themselves, if you wish.</p>
<p>The original pages are still online at their old addresses (Help › Classic pages).</p>
<p class="small muted">Analysis: Meyda 5.6.3 (MIT); home-made FFT, YIN, onset detection, self-similarity, HPSS, NMF, PCA, MDS, Isomap, t-SNE and UMAP. Typeface: JetBrains Mono (OFL).</p>`,
};

export function AboutPage() {
  const { t, lang } = useT();
  return (
    <div className="page narrow">
      <h1>{t('about.title')}</h1>
      <Rich as="div" className="prose" html={ABOUT[lang]} />
      <h2 className="section-title">{t('m.classic')}</h2>
      <ul className="tool-list">
        {LESSONS.filter((e) => e.legacy).map((e) => (
          <li key={e.id}><a href={e.legacy} target="_blank" rel="noopener">{pick(e.title, lang)} <small>{e.legacy}</small></a></li>
        ))}
      </ul>
    </div>
  );
}
