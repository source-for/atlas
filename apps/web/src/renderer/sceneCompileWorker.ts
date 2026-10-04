import { sceneWorkerClock, type WorkerClocks } from '../performance/sceneWorkerTimings';
import { compileScanScene } from './scanScene';
import type { AtlasScene } from './types';
import type { SceneWorkerRequest, SceneWorkerResponse, SceneCompileRequest, SceneWorkerProgress } from './sceneCompileProtocol';
import { initializeNeighborhoodBootstrap } from './neighborhoodBootstrap';

const moduleReady = sceneWorkerClock();
const worker = self as unknown as { onmessage: ((event: MessageEvent<SceneWorkerRequest>) => void) | null; postMessage(value: SceneWorkerResponse): void };
let graph: SceneCompileRequest['graph'];
let generation: number | undefined;
let graphInstalledAt: number | undefined;
const scenes = new Map<number, AtlasScene>();
const retainScene = (id: number, scene: AtlasScene) => {
  scenes.set(id, scene);
  while (scenes.size > 2) scenes.delete(scenes.keys().next().value!);
};
worker.onmessage = event => {
  const request = event.data;
  const clocks: WorkerClocks | undefined = request.diagnostics ? {workerTimeOrigin:performance.timeOrigin, workerModuleReady:moduleReady, workerReceived:sceneWorkerClock()} : undefined;
  const mark = (key: keyof WorkerClocks) => { if (clocks) clocks[key] = sceneWorkerClock(); };
  const progress = (phase: SceneWorkerProgress['phase']) => worker.postMessage({ operation: 'progress', id: request.id, generation: request.generation, phase, ...(clocks ? {clocks:{...clocks}, workerPhaseAt:sceneWorkerClock()} : {}) });
  const postResult = (response: SceneWorkerResponse) => {
    mark('workerResultPostBefore');
    worker.postMessage({...response, ...(clocks ? {clocks:{...clocks}} : {})});
    if (clocks) {
      mark('workerResultPostAfter');
      // The scalar ACK measures return from the result clone/post call; no extra message without diagnostics.
      try { worker.postMessage({operation:'timing', id:request.id, generation:request.generation, clocks:{...clocks}}); } catch { /* diagnostics must not turn a successful result into failure */ }
    }
  };
  progress('received');
  if ('operation' in request) {
    // Failed/invalid initialization must not leave any older graph usable.
    graph = undefined; generation = undefined; graphInstalledAt = undefined; scenes.clear();
    try {
      const result = initializeNeighborhoodBootstrap(request.packet, request.modeOptions, clocks ? phase => mark(phase === 'start' ? 'workerCompileStart' : 'workerCompileEnd') : undefined);
      if (result.status === 'ready') {
        graph = { snapshot: request.packet.snapshot, view: request.packet.view, childCounts: request.packet.childCounts, unpublishedChildren: request.packet.unpublishedChildren ?? [] };
        generation = request.generation;
        graphInstalledAt = clocks ? sceneWorkerClock() : undefined;
        if (clocks) clocks.workerGraphInstalled = graphInstalledAt;
        retainScene(request.id, result.scene);
      }
      postResult({ operation: 'initializeNeighborhood', id: request.id, generation: request.generation, ...result });
    } catch {
      if (clocks?.workerCompileStart !== undefined && clocks.workerCompileEnd === undefined) mark('workerCompileEnd');
      postResult({ operation: 'initializeNeighborhood', id: request.id, generation: request.generation, status: 'failed' });
    }
    return;
  }
  try {
    if (request.graph) {
      graph = request.graph;
      generation = request.generation;
      graphInstalledAt = clocks ? sceneWorkerClock() : undefined;
      scenes.clear();
    }
    if (!graph || generation !== request.generation) throw new Error('Missing graph generation');
    if (clocks) clocks.workerGraphInstalled = graphInstalledAt;
    const previous = request.previousId === undefined ? request.input.previous : scenes.get(request.previousId);
    if (request.previousId !== undefined && !previous) throw new Error('Missing previous scene');
    const start = performance.now();
    progress('compiling');
    mark('workerCompileStart');
    const scene = compileScanScene({ ...request.input, ...graph, previous }, progress);
    mark('workerCompileEnd');
    progress('compiled');
    retainScene(request.id, scene);
    postResult({ id: request.id, generation: request.generation, ok: true, scene, durationMs: performance.now() - start });
  } catch {
    if (clocks?.workerCompileStart !== undefined && clocks.workerCompileEnd === undefined) mark('workerCompileEnd');
    // Compile failures return only a flag, never exception text. Bootstrap
    // validation above intentionally returns structured issues (including entity IDs)
    // to preserve the public validator error; timing exports remain scalar-only.
    postResult({ id: request.id, generation: request.generation, ok: false });
  }
};
