/* Which component renders each tool and lesson. Lazy, so a tab's code (and
   its strings) loads only when the tab is first opened. */

import { ComponentType, lazy } from 'react';
import type { Tab } from './session/store';

export type PaneProps = { tab: Tab };
type C = ComponentType<PaneProps>;

export const COMPONENTS: Record<string, C> = {
  'tool:waveform': lazy(() => import('./tools/Waveform')),
  'tool:additive': lazy(() => import('./tools/Additive')),
  'tool:fft': lazy(() => import('./tools/FftSandbox')),
  'tool:descriptors': lazy(() => import('./tools/Descriptors')),
  'tool:spectral': lazy(() => import('./tools/Spectral')),
  'tool:segmentation': lazy(() => import('./tools/Segmentation')),
  'tool:corpus': lazy(() => import('./tools/Corpus')),
  'tool:batch': lazy(() => import('./tools/Batch')),
  'tool:soundmap': lazy(() => import('./tools/SoundMap')),
  // the guided versions: same components, paged layout (they read tab.kind)
  'lesson:waveform': lazy(() => import('./tools/Waveform')),
  'lesson:additive': lazy(() => import('./tools/Additive')),
  'lesson:fft': lazy(() => import('./tools/FftSandbox')),
  'lesson:descriptors': lazy(() => import('./tools/Descriptors')),
  'lesson:spectral': lazy(() => import('./tools/Spectral')),
  'lesson:segmentation': lazy(() => import('./tools/Segmentation')),
  'lesson:corpus': lazy(() => import('./tools/Corpus')),
  'lesson:batch': lazy(() => import('./tools/Batch')),
  'lesson:soundmap': lazy(() => import('./tools/SoundMap')),
  'lesson:descriptor-guide': lazy(() => import('./learn/DescriptorGuide')),
};
