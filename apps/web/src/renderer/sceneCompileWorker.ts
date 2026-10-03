import { compileScanScene, type ScanSceneInput } from './scanScene';
import type { AtlasScene } from './types';
import type { SceneCompileRequest, SceneCompileResponse } from './sceneCompileProtocol';

const worker = self as unknown as { onmessage: ((event: MessageEvent<SceneCompileRequest>) => void) | null; postMessage(value: SceneCompileResponse): void };
let graph: Pick<ScanSceneInput, 'snapshot'> | undefined;
let generation: number | undefined;
const scenes = new Map<number, AtlasScene>();
worker.onmessage = event => {
  const request = event.data;
  try {
    if (request.graph) {
      graph = request.graph;
      generation = request.generation;
      scenes.clear();
    }
    if (!graph || generation !== request.generation) throw new Error('Missing graph generation');
    const previous = request.previousId === undefined ? request.input.previous : scenes.get(request.previousId);
    if (request.previousId !== undefined && !previous) throw new Error('Missing previous scene');
    const start = performance.now();
    const scene = compileScanScene({ ...request.input, ...graph, previous });
    scenes.set(request.id, scene);
    while (scenes.size > 2) scenes.delete(scenes.keys().next().value!);
    worker.postMessage({ id: request.id, generation: request.generation, ok: true, scene, durationMs: performance.now() - start });
  } catch {
    // Scalar diagnostics only: source and error text never leave the worker.
    worker.postMessage({ id: request.id, generation: request.generation, ok: false });
  }
};
