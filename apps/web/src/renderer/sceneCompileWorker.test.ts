import { afterEach, expect, it, vi } from 'vitest';
import type { SceneCompileRequest, SceneCompileResponse } from './sceneCompileProtocol';
import type { ScanSceneInput } from './scanScene';
const compile = vi.hoisted(() => vi.fn((input: ScanSceneInput) => ({ rootEntityId: input.focusEntityId, previous: input.previous })));
vi.mock('./scanScene', () => ({ compileScanScene: compile }));
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); compile.mockClear(); });
it('owns one graph generation and bounds previous scene references to the last two results', async () => {
  const worker = { onmessage: null as ((event: { data: SceneCompileRequest }) => void) | null, postMessage: vi.fn() };
  vi.stubGlobal('self', worker);
  await import('./sceneCompileWorker');
  const input = { focusEntityId: 'root' } as SceneCompileRequest['input'];
  const snapshot = {} as ScanSceneInput['snapshot'];
  const graph = { snapshot, view: { rootEntityId: 'root' }, childCounts: { root: 3 }, unpublishedChildren: [] } as unknown as NonNullable<SceneCompileRequest['graph']>;
  const send = (request: SceneCompileRequest) => {
    worker.onmessage!({ data: request });
    return worker.postMessage.mock.lastCall![0] as SceneCompileResponse;
  };
  const first = send({ id: 1, generation: 0, graph, input });
  expect(first.ok).toBe(true);
  expect(compile.mock.lastCall![0]).toMatchObject(graph);
  send({ id: 2, generation: 0, previousId: 1, input });
  expect(compile.mock.lastCall![0].previous).toBe(first.scene);
  send({ id: 3, generation: 0, input });
  expect(send({ id: 4, generation: 0, previousId: 1, input }).ok).toBe(false);
  expect(send({ id: 5, generation: 1, input }).ok).toBe(false);
  expect(send({ id: 6, generation: 1, graph, previousId: 3, input }).ok).toBe(false);
  expect(send({ id: 7, generation: 1, input }).ok).toBe(true);
});
