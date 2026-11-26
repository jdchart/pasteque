# pasteque — context for Claude

Interactive sound-analysis lessons and sandbox tools for Jacob's students, hosted on GitHub Pages.

- Repo: https://github.com/jdchart/pasteque (user `jdchart`), branch `main`.
- Live URL: https://jdchart.github.io/pasteque/
- Deployed by GitHub Actions (`.github/workflows/deploy.yml`, Pages source = "GitHub Actions"): `npm run site` in `app/` builds the React app and assembles `app/site/`, which is what gets published.

## Two parts

### 1. The React app (`app/`) — the site root
Vite + React 19 + TypeScript, meyda for descriptors. Visual language from the suite (scribe / biblioweb / cv): tokens in `src/styles/tokens.css` (`--s-*`), with the legacy Atelier names (`--accent`, `--ink-soft`…) aliased onto them.

- `src/catalog.ts` — the single list of tools, lessons and courses (ids, legacy filenames, FR/EN texts). Menus, home page and routes are all built from it. `src/catalogComponents.ts` maps ids to lazy components.
  - **Learn = courses.** Each course has a landing page (`#/learn/<course>`) with **modules numbered from 1** (not the course's session numbers); a module lists its lessons (`items: ['lesson:…']`). Lessons are reached through their course; `#/learn/<lesson>/<part>` still works.
  - **Every tool has two versions, one component.** `#/learn/<id>` is the guided lesson: the paged layout of the classic page (`ToolFrame` + `Panel`s), with its narrative, predictions, comparisons and the "Classic version" link. `#/sandbox/<id>` is the tool: `Workbench` layout, no narrative, no prediction, no classic link. The component reads `tab.kind === 'lesson'`; state keys are `'lesson:<id>'` vs `'<id>'`, and the pipeline hand-offs stay within the same version.
  - **Sandbox** cards show only glyph, title and the one-line `short`.
- `src/shell/` — menubar, tabs, hash routing (`#/`, `#/learn`, `#/learn/<course>`, `#/learn/<lesson>[/<part>]`, `#/sandbox`, `#/sandbox/<tool>`, `#/about`), `ToolFrame` (the paged frame of lessons).
- `src/session/` — the app store (`useApp`, `useToolState(key, DEFAULTS)`, `setToolState` for hand-offs between tools), the sound library, and the session file (`.pasteque.json`: save / open / new).
- `src/ui/` — custom dialogs/toasts (never `alert/confirm/prompt`), the UI kit (`Panel`, `Plot`, transport…), `SoundSource`, `PaneBoundary` (an error stays in its tab).
- `src/lib/` — DSP, drawing, audio, demos, I/O (ports of the Atelier runtime). Added since: `segment.ts` (onset functions, transients, self-similarity + Foote novelty), `reduce.ts` (distances, classical/SMACOF MDS, Isomap, UMAP), `spectral.ts` (STFT/ISTFT, HPSS/HPR, NMF, spectral gate, drawn masks). All exact O(n²)/O(n·k) code, no dependencies.
- `src/ui/Workbench.tsx` — the sandbox tools' application layout: header bar (glyph, title, transport, ⓘ dialog), a resizable/collapsible sidebar of `<Section>`s for settings, and a main `<Split>` of `<Pane>`s (resizable by dragging dividers, foldable by clicking the title, each scrolling inside; nested Splits allowed). The ⓘ dialog gives a one-line description and a link to the guided version. Plots inside panes use `<Plot fill>` to take the pane's height. Layout is remembered per tool while the app is open, not saved in the session.
- `src/session/corpora.ts` — **session corpora** (`state.corpora`, saved in the session file): named lists of entries `{id, soundId, file, start, end, label, origin, values?}` + `desc` (features/columns) once described. The corpus pipeline goes through them: Segmentation → "Add to a corpus…" dialog (`ui/CorpusPicker.tsx`) → Corpus tool (`tools/Corpus.tsx`: manage, hand-made segments, merge, copy, import/export) → Batch (describes the corpus *in place*, only new items when the descriptors are unchanged) → Sound map (`corpusId`, positions keyed by entry id + `posCorpus`). Editing an entry's bounds drops its values. The sound map's multi-selection (`picked`: shift/⌘-click, drag a box on the empty map) downloads as one ZIP of WAVs (`saveWavZip` / `zipBlob` in `lib/io.ts`, stored ZIP, no dependency) or goes to another corpus. `migrateTools` turns pre-corpora sessions (batch `result`, sound map `corpus`) into corpora on open.
- `src/tools/<Tool>.tsx` + `<Tool>.strings.ts` — each renders the lesson (paged) or the sandbox tool (Workbench) version; tools are app-like, narrative belongs to lessons. `src/learn/` — lessons (descriptor guide: `DescriptorGuide.tsx`, `guideEngine.ts`, `guide.data.ts`, `guide.strings.ts`).
- Strings: FR/EN per tool, extracted from the legacy `Atelier.i18n.add` blocks; `useT(S)` gives `t`, `rich` (escapes vars, `*x*` → `<em>`).

**Rules**
- Persistence is ONLY the session JSON the student downloads and reopens. No localStorage/IndexedDB. Tool state must be serialisable; heavy results are recomputed on restore (or kept small).
- All open tabs stay mounted (hidden), so work survives tab switches; tools pass data through the store (segmentation → session corpus → batch → sound map), not through files.
- Must work from `file://` too: the build is one classic IIFE script (see `vite.config.ts`), no network at runtime. Don't reintroduce ES-module output or code splitting.
- Before calling it done: `npm run site`, then check in a browser (served and `file://`), with no console errors.

### 2. Classic pages (repo root) — kept at their old URLs
`ats-*.html`, `general-*.html`: self-contained pages (inline CSS, the Atelier runtime, vendored Meyda), ~140–150 KB each. Students have these links; they must keep working. The old landing page `index.html` is published as `classique.html` (the app takes the root).

These are GENERATED by `.claude/assets/scripts/build_web.py` in the course-material repo, from `courses/<COURSE>/overview.md` and the tools' `data-*` attributes. That script is not in this repo: regenerate there and copy here; don't hand-edit (a hand-edit is overwritten by the next copy). They link home via `data-home="index.html"`, which now lands on the app. Keep `.nojekyll`.

## Adding a tool or lesson to the app
1. Component in `src/tools/` (Workbench layout) or `src/learn/` (lesson, `ToolFrame`) with a `.strings.ts`; state through `useToolState('<id>', DEFAULTS)`.
2. Entry in `TOOLS` (with `short`) / `LESSONS` in `src/catalog.ts`, add it to a course module if relevant, and register it in `src/catalogComponents.ts`.
3. If a classic page exists, copy it to the root and set its filename on the catalog entry (the "Classic version" link); add a row to `README.md`.
4. `npm run site`, test, commit + push to `main` (only when Jacob asks).

## Status (2026-11-26)
- The app is committed and deployed by `.github/workflows/deploy.yml` on every push to `main`. Settings › Pages › Source must be "GitHub Actions" (otherwise Pages serves the repo root: old landing page + classic pages).
- Transport playheads and click-to-seek use absolute time over the whole sound, even while a range (a segment) plays.
- `Transport.setBuffer` with the buffer it already holds is a no-op (a re-render or a focus effect used to stop what had just started). `audio.trigger` (the sound map) caps overlapping voices at 6; `audio.stop()` also silences them.
- The "Add to a corpus…" dialog defaults to a new corpus, or to the corpus that already holds segments of the same sounds (re-segmenting) — never to an unrelated last corpus.
- Open question for Jacob: the FFT "three sizes" comparison was removed from the sandbox version (kept in the lesson) — he may want it back.
- The classic pages likely share a dark-theme bug fixed in the app (`isDark()` failed on `#000`, so heat maps kept the light colour map); fix belongs in the generator repo.
- Spectral workshop (`spectral`, tool + auto lesson) is not in any course module yet. Its lesson version is the same tool in Panels.
- Corpus tool (`corpus`) added 2026-11-26 and put in ATS module 3 between Segmentation and Batch — Jacob may want it elsewhere. Its lesson text is new (not from a classic page); no classic page exists.
- Segmentation and sound-map lessons offer every method the sandbox has (shared control blocks in each component: `methodCtl`/`cutCtl`, `projCtl`), with a per-method explanation under the choice. Segmentation's main view is the waveform with numbered segment bands and cut lines.
- Courses: only ATS has modules (1–4). Max/MSP is a "coming soon" landing page.
- Browser testing that worked here: `playwright-core` installed in the session scratchpad (never in `app/`), driving the system Chrome (`/Applications/Google Chrome.app/…`), against `python3 -m http.server` in `app/site/`, then the `file://` path, then the live URL. Hidden tabs stay mounted, so scope locators with `:visible`.

## To do (another time)
- **Sound-event / object detection with a small model** (Jacob, 2026-11-26). Candidate: YAMNet (521 AudioSet classes, ~3.7 MB weights) via TF.js. Constraint: must work on GitHub Pages *and* from `file://` with no network, as one IIFE — so either bundle weights + runtime into the script (~4–5 MB more) or load it only in the served version. Likely home: a "detect events" method in Segmentation (labelled segments) and labels as a colour in the sound map.
