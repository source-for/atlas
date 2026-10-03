import { compileScanScene } from './scanScene';
import type { AtlasScene } from './types';
import type { SceneWorkerRequest, SceneWorkerResponse } from './sceneCompileProtocol';
import { initializeNeighborhoodBootstrap } from './neighborhoodBootstrap';

const worker = self as unknown as { onmessage: ((event: MessageEvent<SceneWorkerRequest>) => void) | null; postMessage(value: SceneCompileResponse): void };
let graph: SceneWorkerRequest['graph'];
let generation: number | undefined;
const scenes = new Map<number, AtlasScene>();
const retainScene = (id: number, scene: AtlasScene) => {
  scenes.set(id, scene);
  while (scenes.size > 2) scenes.delete(scenes.keys().next().value!);
};
worker.onmessage = event => {
  const request = event.data;
  if ('operation' in request) {
    // Failed/invalid initialization must not leave any older graph usable.
    graph = undefined; generation = undefined; scenes.clear();
    try {
      const result = initializeNeighborhoodBootstrap(request.packet, request.modeOptions);
      if (result.status === 'ready') {
        graph = { snapshot: request.packet.snapshot, view: request.packet.view, childCounts: request.packet.childCounts, unpublishedChildren: request.packet.unpublishedChildren ?? [] };
        generation = request.generation;
        retainScene(request.id, result.scene);
      }
      worker.postMessage({ operation: 'initializeNeighborhood', id: request.id, generation: request.generation, ...result });
    } catch {
      worker.postMessage({ operation: 'initializeNeighborhood', id: request.id, generation: request.generation, status: 'failed' });
    }
    return;
  }
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
    retainScene(request.id, scene);
    worker.postMessage({ id: request.id, generation: request.generation, ok: true, scene, durationMs: performance.now() - start });
  } catch {
    // Scalar diagnostics only: source and error text never leave the worker.
    worker.postMessage({ id: request.id, generation: request.generation, ok: false });
  }
};
