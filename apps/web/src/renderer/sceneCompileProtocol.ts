import type { ScanSceneInput } from './scanScene';
import type { AtlasScene } from './types';

export type SceneCompileRequest = {
  id: number;
  generation: number;
  graph?: Pick<ScanSceneInput, 'snapshot' | 'view' | 'childCounts' | 'unpublishedChildren'>;
  input: Omit<ScanSceneInput, 'snapshot' | 'view' | 'childCounts' | 'unpublishedChildren'>;
  previousId?: number;
};
export type SceneCompileResponse = {
  id: number;
  generation: number;
  ok: boolean;
  scene?: AtlasScene;
  durationMs?: number;
};
