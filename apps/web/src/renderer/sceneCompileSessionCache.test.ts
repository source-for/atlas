import { afterEach, expect, it, vi } from 'vitest';
import { createSceneCompileSession } from './compileSceneOffThread';
import type { ScanSceneInput } from './scanScene';
import type { SceneCompileRequest, SceneCompileResponse } from './sceneCompileProtocol';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });
it('tracks actual worker cache eviction after two abandoned compiles without restarting or resending the graph', async () => {
  const host = { onmessage: null as ((event: { data: SceneCompileRequest }) => void) | null, postMessage: vi.fn() };
  vi.stubGlobal('self', host);
  await import('./sceneCompileWorker');
  class Bridge {
    static latest: Bridge;
    onmessage?: (event: { data: SceneCompileResponse }) => void;
    terminate = vi.fn();
    postMessage = vi.fn();
    constructor() { Bridge.latest = this; }
    finish() {
      // Exercise the actual worker's two-scene cache, across the clone boundary.
      host.onmessage!({ data: structuredClone(this.postMessage.mock.lastCall![0]) });
      const reply = structuredClone(host.postMessage.mock.lastCall![0]) as SceneCompileResponse;
      expect(reply.ok).toBe(true);
      this.onmessage?.({ data: reply });
    }
  }
  vi.stubGlobal('Worker', Bridge);
  const input: ScanSceneInput = { snapshot: structuredClone(demoSnapshot) as unknown as ScanSceneInput['snapshot'], view: structuredClone(demoView) as unknown as ScanSceneInput['view'], focusEntityId: demoView.rootEntityId, boot: 'full', modeOptions: {}, childCounts: {}, unpublishedChildren: [] };
  const session = createSceneCompileSession();
  try {
    const first = session.compile(input, { generation: 0 });
    const worker = Bridge.latest;
    worker.finish();
    const published = await first;
    const a = session.compile({ ...input, previous: published }, { generation: 0 });
    const rejectedA = expect(a).rejects.toMatchObject({ name: 'AbortError' });
    const b = session.compile({ ...input, previous: published }, { generation: 0 });
    const rejectedB = expect(b).rejects.toMatchObject({ name: 'AbortError' });
    worker.finish(); // A finishes abandoned; B starts.
    const latest = session.compile({ ...input, previous: published }, { generation: 0 });
    worker.finish(); // B finishes abandoned; published scene is now evicted.
    const request = worker.postMessage.mock.lastCall![0] as SceneCompileRequest;
    expect(request.graph).toBeUndefined();
    expect(request.previousId).toBeUndefined();
    expect(request.input.previous).toBe(published);
    worker.finish();
    expect(await latest).toBeDefined();
    await rejectedA; await rejectedB;
    expect(worker.terminate).not.toHaveBeenCalled();
    expect(worker.postMessage.mock.calls.filter(([r]) => r.graph)).toHaveLength(1);
  } finally { session.dispose(); }
});
