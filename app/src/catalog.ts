/* What the app offers: sandbox tools, lessons, and the courses that order
   them. Texts come from the original pages (their data-* attributes and the
   course overview). To add a tool: an entry here, a component in
   catalogComponents.ts. */

import { Lang } from './i18n/core';

type L = { fr: string; en: string };
export const pick = (l: L, lang: Lang) => l[lang] || l.fr;

export type ToolEntry = {
  id: string; kind: 'tool';
  title: L; subtitle: L; card: L; tag: L;
  short: L;                      // one line, for the sandbox cards
  classic?: string;              // the original page (its guided version is the lesson of the same id)
  glyph: string;                 // a one-character mark for menus and tabs
};

export type LessonEntry = {
  id: string; kind: 'lesson';
  title: L; subtitle: L; card: L; tag: L;
  legacy?: string; glyph: string;
  parts?: { id: string; title: L }[];  // sub-lessons, reachable as learn/<id>/<part>
};

const TAG_SPECTRUM = { fr: 'Son et spectre', en: 'Sound and spectrum' };
const TAG_LISTEN = { fr: 'Écoute et analyse', en: 'Listening and analysis' };
const TAG_CORPUS = { fr: 'Corpus', en: 'Corpus' };

export const TOOLS: ToolEntry[] = [
  { id: 'waveform', kind: 'tool', short: { fr: 'Amplitude, période, échantillons, repliement.', en: 'Amplitude, period, samples, aliasing.' }, glyph: '∿', classic: 'ats-forme-onde.html', tag: TAG_SPECTRUM,
    title: { fr: 'Forme d’onde et échantillonnage', en: 'Waveform and sampling' },
    subtitle: { fr: 'Comment l’ordinateur tient un son', en: 'How a computer holds a sound' },
    card: { fr: 'Regarder un son de près : amplitude, période, fréquence, puis zoomer jusqu’à voir les échantillons — et entendre ce qui se passe quand il y en a trop peu.',
            en: 'Look closely at a sound: amplitude, period, frequency, then zoom until the samples appear — and hear what happens when there are too few.' } },
  { id: 'additive', kind: 'tool', short: { fr: 'Empiler des sinusoïdes jusqu’au timbre.', en: 'Stack sines until they become a timbre.' }, glyph: 'Σ', classic: 'ats-synthese-additive.html', tag: TAG_SPECTRUM,
    title: { fr: 'Synthèse additive', en: 'Additive synthesis' },
    subtitle: { fr: 'Un son est une somme de sinusoïdes', en: 'A sound is a sum of sines' },
    card: { fr: 'Empiler des sinusoïdes une à une et écouter à quel moment elles cessent d’être plusieurs sons pour devenir un timbre.',
            en: 'Stack sines one by one and listen for the moment they stop being several sounds and become one timbre.' } },
  { id: 'fft', kind: 'tool', short: { fr: 'Spectrogramme : fenêtre, recouvrement, compromis.', en: 'Spectrogram: window, overlap, trade-off.' }, glyph: '▦', classic: 'ats-bac-a-sable-fft.html', tag: TAG_SPECTRUM,
    title: { fr: 'Bac à sable FFT', en: 'FFT sandbox' },
    subtitle: { fr: 'Le spectrogramme et son réglage', en: 'The spectrogram and its settings' },
    card: { fr: 'Changer la taille de la fenêtre d’analyse et regarder le spectrogramme du même son devenir net en fréquence ou net en temps — jamais les deux.',
            en: 'Change the analysis window and watch the spectrogram of the same sound become sharp in frequency or sharp in time — never both.' } },
  { id: 'descriptors', kind: 'tool', short: { fr: 'Prédire, puis mesurer : RMS, hauteur, centroïde, MFCC…', en: 'Predict, then measure: RMS, pitch, centroid, MFCC…' }, glyph: '⌇', classic: 'general-descripteurs-audio.html', tag: TAG_LISTEN,
    title: { fr: 'Descripteurs audio', en: 'Audio descriptors' },
    subtitle: { fr: 'Ce que la machine mesure dans un son', en: 'What the machine measures in a sound' },
    card: { fr: 'Importer un son, dessiner la courbe que vous attendez, puis calculer ce que la machine mesure vraiment — intensité, hauteur, centroïde, planéité, MFCC.',
            en: 'Load a sound, sketch the curve you expect, then compute what the machine really measures — intensity, pitch, centroid, flatness, MFCC.' } },
  { id: 'spectral', kind: 'tool', short: { fr: 'Séparer, filtrer, dessiner dans le spectre.', en: 'Separate, filter, draw in the spectrum.' }, glyph: '▦', tag: TAG_SPECTRUM,
    title: { fr: 'Atelier spectral', en: 'Spectral workshop' },
    subtitle: { fr: 'Découper un son dans le spectre', en: 'Cutting a sound in the spectrum' },
    card: { fr: 'Séparer l’harmonique du percussif, les transitoires du tonal, décomposer en composantes (NMF), réduire le bruit, ou peindre sur le spectrogramme ce qu’on garde — et exporter chaque couche.',
            en: 'Separate harmonic from percussive, transients from tonal, decompose into components (NMF), reduce noise, or paint on the spectrogram what to keep — and export every layer.' } },
  { id: 'segmentation', kind: 'tool', short: { fr: 'Couper des sons là où quelque chose change.', en: 'Cut sounds where something changes.' }, glyph: '⫶', classic: 'ats-segmentation.html', tag: TAG_CORPUS,
    title: { fr: 'Segmentation', en: 'Segmentation' },
    subtitle: { fr: 'Découper un corpus en unités', en: 'Cutting a corpus into units' },
    card: { fr: 'Laisser la machine couper vos sons là où quelque chose change, régler sa sensibilité, écouter chaque coupe — et noter où votre oreille n’est pas d’accord.',
            en: 'Let the machine cut your sounds where something changes, tune its sensitivity, listen to every cut — and note where your ear disagrees.' } },
  { id: 'batch', kind: 'tool', short: { fr: 'Décrire un corpus, trier, réécouter.', en: 'Describe a corpus, sort it, listen back.' }, glyph: '☰', classic: 'ats-description-par-lot.html', tag: TAG_CORPUS,
    title: { fr: 'Description par lot', en: 'Batch description' },
    subtitle: { fr: 'Un tableau pour écouter de loin', en: 'A table for listening from a distance' },
    card: { fr: 'Décrire tous les segments d’un corpus d’un coup, trier le tableau par n’importe quelle colonne et réécouter : trier, c’est déjà une façon d’écouter.',
            en: 'Describe every segment of a corpus at once, sort the table by any column and listen back: sorting is already a way of listening.' } },
  { id: 'soundmap', kind: 'tool', short: { fr: 'Le corpus comme plan à explorer et à jouer.', en: 'The corpus as a plane to explore and play.' }, glyph: '⁘', classic: 'ats-carte-sonore.html', tag: TAG_CORPUS,
    title: { fr: 'Carte sonore', en: 'Sound map' },
    subtitle: { fr: 'Le corpus comme espace', en: 'The corpus as a space' },
    card: { fr: 'Étaler un corpus décrit sur un plan où les sons semblables se retrouvent voisins, l’explorer à la souris, improviser avec, et enregistrer ses passes.',
            en: 'Spread a described corpus over a plane where similar sounds land close together, explore it with the mouse, improvise with it, and record your passes.' } },
];

export const DESCRIPTOR_PARTS: { id: string; title: L }[] = [
  { id: 'rms', title: { fr: 'RMS', en: 'RMS' } },
  { id: 'loudness', title: { fr: 'Loudness', en: 'Loudness' } },
  { id: 'pitch', title: { fr: 'Hauteur', en: 'Pitch' } },
  { id: 'centroid', title: { fr: 'Centroïde', en: 'Centroid' } },
  { id: 'spread', title: { fr: 'Étalement', en: 'Spread' } },
  { id: 'flatness', title: { fr: 'Planéité', en: 'Flatness' } },
  { id: 'rolloff', title: { fr: 'Rolloff', en: 'Rolloff' } },
  { id: 'zcr', title: { fr: 'Passages par zéro', en: 'Zero crossings' } },
  { id: 'flux', title: { fr: 'Flux', en: 'Flux' } },
  { id: 'mfcc', title: { fr: 'MFCC', en: 'MFCC' } },
  { id: 'chroma', title: { fr: 'Chroma', en: 'Chroma' } },
];

/** Every sandbox tool also exists as a guided lesson: the paged layout of the
    classic page, with its narrative, predictions and comparisons. Same id. */
const TOOL_LESSONS: LessonEntry[] = TOOLS.map((e) => ({
  id: e.id, kind: 'lesson', glyph: e.glyph, legacy: e.classic, tag: e.tag, title: e.title, subtitle: e.subtitle, card: e.card,
}));

export const LESSONS: LessonEntry[] = [
  ...TOOL_LESSONS,
  { id: 'descriptor-guide', kind: 'lesson', glyph: '§', legacy: 'general-guide-descripteurs.html', tag: TAG_LISTEN,
    title: { fr: 'Guide des descripteurs', en: 'Descriptor guide' },
    subtitle: { fr: 'Onze descripteurs, un par leçon', en: 'Eleven descriptors, one per lesson' },
    card: { fr: 'Un chapitre par descripteur (RMS, loudness, hauteur, centroïde, étalement, planéité, rolloff, passages par zéro, flux, MFCC, chroma) : son fonctionnement, des exemples à écouter avec leurs pièges, et votre propre son.',
            en: 'One chapter per descriptor (RMS, loudness, pitch, centroid, spread, flatness, rolloff, zero crossings, flux, MFCC, chroma): how it works, examples to listen to with their pitfalls, and your own sound.' },
    parts: DESCRIPTOR_PARTS },
];

export type Module = {
  n: number; title: L; blurb: L;
  items: string[];                      // 'lesson:<id>' | 'tool:<id>', in the order they are used
};

export type Course = {
  id: string; glyph: string; title: L; meta: L; blurb: L; intro: L[]; soon?: boolean;
  modules: Module[];
};

export const COURSES: Course[] = [
  { id: 'ats', glyph: '◐', title: { fr: 'Analyse et Traitement du Son', en: 'Analyse et Traitement du Son' },
    meta: { fr: 'L3 · TD · 2026-2027', en: 'L3 · TD · 2026-2027' },
    blurb: { fr: 'Analyser, représenter et manipuler le son comme phénomène acoustique : de l’écoute à la partition graphique, du spectre au corpus.',
             en: 'Analysing, representing and manipulating sound as an acoustic phenomenon: from listening to the graphic score, from the spectrum to the corpus.' },
    intro: [
      { fr: 'Ce cours aborde la musique comme phénomène acoustique et physique. Vous y apprendrez à entendre, décrire et représenter les propriétés internes du son — spectre, timbre, morphologie — et à vous servir de cette compréhension aussi bien pour analyser que pour créer.',
        en: 'This course approaches music as an acoustic and physical phenomenon. You will learn to hear, describe and represent the internal properties of sound — spectrum, timbre, morphology — and to put that understanding to work in analysis as much as in creation.' },
      { fr: 'Les modules ci-dessous rassemblent les leçons et les outils du cours, dans l’ordre où on s’en sert. Tout fonctionne dans le navigateur ; votre travail se garde dans un fichier de session.',
        en: 'The modules below gather the course’s lessons and tools, in the order they are used. Everything runs in the browser; your work is kept in a session file.' },
    ],
    modules: [
      { n: 1, title: { fr: 'Le spectre, la FFT et le spectrogramme', en: 'The spectrum, the FFT and the spectrogram' },
        blurb: { fr: 'Forme d’onde, sinusoïde, échantillonnage, synthèse additive ; puis la FFT, chemin inverse qui retrouve les composantes d’un son, et son produit visible : le spectrogramme.',
                 en: 'Waveform, sine, sampling, additive synthesis; then the FFT, the way back to a sound’s components, and its visible product: the spectrogram.' },
        items: ['lesson:waveform', 'lesson:additive', 'lesson:fft'] },
      { n: 2, title: { fr: 'Les descripteurs audio : ce que la machine entend', en: 'Audio descriptors: what the machine hears' },
        blurb: { fr: 'Ce que mesurent les descripteurs (intensité, hauteur, moments spectraux, MFCC…) et comment ces mesures se rapportent à ce que nous entendons.',
                 en: 'What descriptors measure (loudness, pitch, spectral moments, MFCC…) and how those measurements relate to what we hear.' },
        items: ['lesson:descriptor-guide', 'lesson:descriptors'] },
      { n: 3, title: { fr: 'Décomposer et décrire un corpus', en: 'Decomposing and describing a corpus' },
        blurb: { fr: 'Couper un corpus en morceaux, puis décrire les morceaux à grande échelle — la description de la machine à côté de celle de l’oreille. L’écoute de loin.',
                 en: 'Cutting a corpus into pieces, then describing the pieces at scale — the machine’s description beside the ear’s. Distant listening.' },
        items: ['lesson:segmentation', 'lesson:batch'] },
      { n: 4, title: { fr: 'Les interfaces d’exploration', en: 'Exploration interfaces' },
        blurb: { fr: 'Projeter un corpus décrit sur un plan, l’explorer, l’interroger, et improviser avec.',
                 en: 'Projecting a described corpus onto a plane, exploring it, querying it, and improvising with it.' },
        items: ['lesson:soundmap'] },
    ] },
  { id: 'max', glyph: '◇', title: { fr: 'Introduction à Max/MSP', en: 'Introduction à Max/MSP' },
    meta: { fr: 'L3 · TD · 2026-2027', en: 'L3 · TD · 2026-2027' },
    blurb: { fr: 'Apprendre à construire un instrument : du premier objet au patch qui se joue.',
             en: 'Learning to build an instrument: from the first object to a patch someone can play.' },
    intro: [], soon: true, modules: [] },
];

export const findCourse = (id: string) => COURSES.find((c) => c.id === id);
/** Where an item is used: [course, module] pairs. */
export const usesOf = (ref: string) => COURSES.flatMap((c) => c.modules.filter((m) => m.items.includes(ref)).map((m) => ({ course: c, module: m })));

export const TOOL_GROUPS = [TAG_SPECTRUM, TAG_LISTEN, TAG_CORPUS];

export const findTool = (id: string) => TOOLS.find((t) => t.id === id);
export const findLesson = (id: string) => LESSONS.find((l) => l.id === id);
export function findItem(ref: string): ToolEntry | LessonEntry | undefined {
  const [k, id] = ref.split(':');
  return k === 'tool' ? findTool(id) : findLesson(id);
}
