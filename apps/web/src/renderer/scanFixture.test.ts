import { c4CodeChildSlots, sliceArchitectureNeighborhood, type ArchitectureSnapshot, type ArchitectureView } from '@okie/architecture';
import { describe, expect, it, vi } from 'vitest';
import { compileScanScene, type ScanSceneInput } from './scanScene';
import * as scanSceneCompiler from './scanScene';
import type { SceneCompileRequest } from './sceneCompileProtocol';
import { semanticInspectorHierarchyPlan } from '../semantic/semanticLensEngine';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { compileScanFixture, compileScanNeighborhoodFixture, fetchScanNeighborhoodHost, fetchScanTrioLoader, loadPublishedEnrichmentHonesty, loadScanFixture, loadScanNeighborhoodFixture, loadScanNeighborhoodFixtureFromSearch, resolveScanDocLoader, ScanFixtureError, bootFocusFromSearch, SCAN_CONTAINER_GRID_NODES, SCAN_L2_RESIDENT_PREVIEW_PILLS, SCAN_RELATION_EDGE_BUDGET, SCAN_RESIDENT_NODES_PER_BAND, type ScanTrioLoader } from './scanFixture';

function validTrio() {
  return {
    snapshot: structuredClone(demoSnapshot),
    view: structuredClone(demoView),
    story: structuredClone(demoStory),
  };
}

describe('scan fixture loader', () => {
  it('retries optional enrichment after worker failure without compiling large graphs on the UI thread', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const owner = snapshot.entities.find(entity => entity.kind === 'component')!;
    snapshot.entities.push(...Array.from({ length: 2001 }, (_, i) => ({ id: `code:enrich-${i}`, name: `leaf${i}`, kind: 'code' as const, parentId: owner.id, sourceRefs: [] })));
    const packet = { ...sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: view.rootEntityId }), snapshot, view };
    const fixture = compileScanNeighborhoodFixture(packet, demoStory, { loadNeighborhood: async () => packet, loadExcerpts: async () => undefined, loadStory: async () => demoStory });
    const compiler = vi.spyOn(scanSceneCompiler, 'compileScanScene');
    vi.stubGlobal('Worker', undefined);
    try {
      expect(await fixture.enrichInitialScene()).toBeUndefined();
      expect(compiler).not.toHaveBeenCalled();
      let posts = 0;
      class Worker {
        onmessage: ((event: MessageEvent) => void) | null = null;
        terminate() {}
        postMessage(raw: SceneCompileRequest) {
          posts++;
          const request = structuredClone(raw);
          const scene = compileScanScene({ ...request.input, ...request.graph! });
          queueMicrotask(() => this.onmessage?.({ data: structuredClone({ id: request.id, generation: request.generation, ok: true, scene }) } as MessageEvent));
        }
      }
      vi.stubGlobal('Worker', Worker);
      expect(await fixture.enrichInitialScene()).toBeDefined();
      expect(posts).toBe(1);
    } finally { fixture.disposeSceneWorker(); compiler.mockRestore(); vi.unstubAllGlobals(); }
  });

  it('optional enrichment falls back synchronously for small graphs and remains separate from the shallow cache', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const owner = snapshot.entities.find(entity => entity.kind === 'component')!;
    snapshot.entities.push(...Array.from({ length: 150 }, (_, i) => ({ id: `code:small-enrich-${i}`, name: `leaf${i}`, kind: 'code' as const, parentId: owner.id, sourceRefs: [] })));
    const packet = { ...sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: view.rootEntityId }), snapshot, view };
    const fixture = compileScanNeighborhoodFixture(packet, demoStory, { loadNeighborhood: async () => packet, loadExcerpts: async () => undefined, loadStory: async () => demoStory });
    vi.stubGlobal('Worker', undefined);
    try {
      await fixture.prepareInitialScene();
      const shallow = fixture.createScene(view.rootEntityId);
      const expected = compileScanScene({ snapshot, view, focusEntityId: view.rootEntityId, boot: 'neighborhood', modeOptions: {}, childCounts: packet.childCounts, unpublishedChildren: packet.unpublishedChildren ?? [] });
      expect(await fixture.enrichInitialScene()).toEqual(expected);
      expect(fixture.createScene(view.rootEntityId)).toBe(shallow);
    } finally { fixture.disposeSceneWorker(); vi.unstubAllGlobals(); }
  });

  it('retransmits the real graph with attached source excerpts after evidence advances its generation', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const entity = snapshot.entities.find(entity => entity.id === 'code:web-shell:app')!;
    const excerpts = entity.sourceExcerpts!;
    expect(excerpts.length).toBeGreaterThan(0);
    delete entity.sourceExcerpts;
    const packet = { ...sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: view.rootEntityId }), snapshot, view };
    const fixture = compileScanNeighborhoodFixture(packet, demoStory, { loadNeighborhood: async () => packet, loadExcerpts: async () => structuredClone(excerpts), loadStory: async () => demoStory });
    const requests: SceneCompileRequest[] = [];
    let graph: SceneCompileRequest['graph'];
    class Worker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      terminate() {}
      postMessage(raw: SceneCompileRequest) {
        const request = structuredClone(raw); requests.push(request);
        graph = request.graph ?? graph;
        const scene = compileScanScene({ ...request.input, ...graph! });
        queueMicrotask(() => this.onmessage?.({ data: structuredClone({ id: request.id, generation: request.generation, ok: true, scene }) } as MessageEvent));
      }
    }
    vi.stubGlobal('Worker', Worker);
    try {
      await fixture.createSceneAsync(view.rootEntityId);
      await fixture.ensureExcerpts(entity.id);
      const scene = await fixture.createSceneAsync(entity.id);
      expect(requests).toHaveLength(2);
      expect(requests[1]!.generation).toBeGreaterThan(requests[0]!.generation);
      expect(requests[0]!.graph!.snapshot.entities.find(candidate => candidate.id === entity.id)?.sourceExcerpts).toBeUndefined();
      expect(requests[1]!.graph!.snapshot.entities.find(candidate => candidate.id === entity.id)?.sourceExcerpts).toEqual(excerpts);
      expect(scene.entities.find(candidate => candidate.id === entity.id)?.sourceExcerpts).toEqual(excerpts);
    } finally { fixture.disposeSceneWorker(); vi.unstubAllGlobals(); }
  });

  it('keeps large navigation off the main thread when workers are unsupported or time out', async () => {
    const trio = validTrio();
    const snapshot = trio.snapshot as unknown as ArchitectureSnapshot;
    const owner = snapshot.entities.find(entity => entity.kind === 'component')!;
    snapshot.entities.push(...Array.from({ length: 2001 }, (_, index) => ({ id: `component:worker-required-${index}`, kind: 'component' as const, parentId: owner.parentId, name: `Worker required ${index}`, sourceRefs: [] })));
    const fixture = compileScanFixture(trio);
    const compile = vi.spyOn(scanSceneCompiler, 'compileScanScene');
    vi.stubGlobal('Worker', undefined);
    try {
      await expect(fixture.createSceneAsync(fixture.navigation.rootEntityId)).rejects.toThrow('Background scene preparation');
      expect(compile).not.toHaveBeenCalled();
      vi.useFakeTimers();
      vi.stubGlobal('Worker', class { onmessage = null; onerror = null; postMessage() {} terminate() {} });
      const result = fixture.createSceneAsync(fixture.navigation.rootEntityId);
      const rejection = expect(result).rejects.toThrow('Background scene preparation');
      await vi.advanceTimersByTimeAsync(20_000);
      await rejection;
      expect(compile).not.toHaveBeenCalled();
    } finally { fixture.disposeSceneWorker(); compile.mockRestore(); vi.useRealTimers(); vi.unstubAllGlobals(); }
  });

  it('retries a real neighborhood merge while the worker is preparing a level', async () => {
    const packet = sliceArchitectureNeighborhood(structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot, structuredClone(demoView) as unknown as ArchitectureView, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(packet, demoStory, {
      loadNeighborhood: async focus => sliceArchitectureNeighborhood(structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot, structuredClone(demoView) as unknown as ArchitectureView, { focusEntityId: focus }),
      loadExcerpts: async () => [], loadStory: async () => demoStory,
    });
    const requests: SceneCompileRequest[] = [];
    let graph: SceneCompileRequest['graph'];
    let reply: (() => void) | undefined;
    class Worker {
      onmessage: ((event: MessageEvent) => void) | null = null;
      onerror = null;
      terminate() {}
      postMessage(raw: SceneCompileRequest) {
        const request = structuredClone(raw); requests.push(request);
        if (request.graph) graph = request.graph;
        const scene = compileScanScene({ ...request.input, ...graph } as ScanSceneInput);
        const emit = () => this.onmessage?.({ data: structuredClone({ id: request.id, generation: request.generation, ok: true, scene }) } as MessageEvent);
        if (requests.length === 1) reply = emit; else queueMicrotask(emit);
      }
    }
    vi.stubGlobal('Worker', Worker);
    try {
      const prepared = fixture.createSceneAsync('system:okie');
      await fixture.ensureNeighborhood('container:web-app');
      reply!();
      const scene = await prepared;
      expect(requests).toHaveLength(2);
      expect(requests[1]!.generation).toBeGreaterThan(requests[0]!.generation);
      expect(scene.entities.some(entity => entity.id === 'component:web-shell')).toBe(true);
      expect(fixture.getSceneGeneration()).toBe(1);
    } finally { fixture.disposeSceneWorker(); vi.unstubAllGlobals(); }
  });

  it('loads a listed declaration outside the component preview before planning its code drill', () => {
    const trio = validTrio();
    const snapshot = trio.snapshot as unknown as ArchitectureSnapshot;
    const owner = snapshot.entities.find(entity => entity.kind === 'component')!;
    const extra = Array.from({ length: 153 }, (_, index) => ({
      id: `code:mapped-${String(index).padStart(3, '0')}`, kind: 'code' as const,
      parentId: owner.id, name: `declaration${index}`, sourceRefs: [],
    }));
    snapshot.entities.push(...extra);
    const fixture = compileScanFixture({ ...trio, snapshot }, { targetAspect: 1.6 });
    const shallow = fixture.createScene(owner.parentId!);
    const targetId = extra[152]!.id;
    const viewport = { width: 1280, height: 720 };
    const safeArea = { top: 80, right: 300, bottom: 72, left: 64 };
    expect(semanticInspectorHierarchyPlan(shallow, targetId, viewport, safeArea)).toBeUndefined();
    const focused = fixture.createScene(owner.id, shallow, { keepEntityIds: [targetId] });
    const plan = semanticInspectorHierarchyPlan(focused, targetId, viewport, safeArea);
    expect(plan?.detail).toBe('code');
    expect(plan?.targetId).toBe(targetId);
    expect(focused.projection!.entityIdsByDetail.code.filter(id => id.startsWith('code:mapped-')).length)
      .toBeLessThanOrEqual(SCAN_RESIDENT_NODES_PER_BAND);
  });

  it('uses code landmarks for a component-focused cold residency window', () => {
    const trio = validTrio();
    const snapshot = trio.snapshot as unknown as ArchitectureSnapshot;
    const owner = snapshot.entities.find(entity => entity.kind === 'component')!;
    const extra = Array.from({ length: 96 }, (_, index) => ({
      id: `code:paging-${String(index).padStart(3, '0')}`,
      kind: 'code' as const,
      parentId: owner.id,
      name: `paging${index}`,
      sourceRefs: [],
    }));
    snapshot.entities.push(...extra);
    const fixture = compileScanFixture({ ...trio, snapshot }, { targetAspect: 1.6 });
    const landmark = fixture.createScene(owner.id);
    const codeOwner = landmark.projection!.boundsByEntityIdAndDetail[owner.id]!.code!;
    const lateId = extra[90]!.id;
    const slots = c4CodeChildSlots(codeOwner, snapshot.entities
      .filter(entity => entity.parentId === owner.id && entity.kind === 'code')
      .map(entity => entity.id));
    const late = slots[lateId]!;
    const scene = fixture.createScene(owner.id, undefined, {
      worldBounds: { x: late.x - 0.01, y: late.y - 0.01, width: late.width + 0.02, height: late.height + 0.02 },
      keepEntityIds: [extra[0]!.id],
    });
    expect(fixture.scopeCompileOptions(owner.id).pageCodeLandmarks).toBe(true);
    expect(scene.projection!.entityIdsByDetail.code).toEqual(expect.arrayContaining([lateId, extra[0]!.id]));
    expect(scene.projection!.entityIdsByDetail.code.filter(id => id.startsWith('code:paging-')).length)
      .toBeLessThanOrEqual(SCAN_RESIDENT_NODES_PER_BAND);
  });

  it('compiles a valid trio into a live scene + story via the demo compile path', () => {
    const fixture = compileScanFixture(validTrio());
    expect(fixture.story.steps.length).toBeGreaterThan(0);
    expect(fixture.navigation.rootEntityId).toBe(demoView.rootEntityId);
    expect(fixture.navigation.snapshotId).toBe(demoSnapshot.id);

    const scene = fixture.createScene(fixture.navigation.rootEntityId);
    expect(scene.entities).toHaveLength(demoSnapshot.entities.length);
    expect(scene.projection).toBeDefined();
    expect(scene.protocolSnapshot).toBeDefined();

    // Re-focus recompiles the SAME scanned snapshot (not the golden one).
    const refocused = fixture.createScene(scene.entities[1]!.id, scene);
    expect(refocused.id).toBe(scene.id);
    expect(refocused.entities).toHaveLength(demoSnapshot.entities.length);

    // Hang-guard is a no-op on the demo-sized snapshot. CLA-107/109 pre-places
    // L3 and L4 in the small-repo system compile.
    expect(fixture.createScene(fixture.navigation.rootEntityId).scanGuardRefusal).toBeUndefined();
    expect(refocused.scanGuardRefusal).toBeUndefined();
    expect(fixture.scopeCompileOptions(fixture.navigation.rootEntityId)).toEqual({
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
      maxL2PreviewPillsPerOwner: SCAN_L2_RESIDENT_PREVIEW_PILLS,
    });
    expect((scene.projection?.entityIdsByDetail.component ?? [])
      .filter(id => scene.entities.find(entity => entity.id === id)?.detail === 'component').length).toBeGreaterThan(0);
    expect((scene.projection?.entityIdsByDetail.code ?? [])
      .filter(id => scene.entities.find(entity => entity.id === id)?.detail === 'code').length).toBeGreaterThan(0);
  });


  it('applies the mode-level aspect target below the scoped-compile size gate (task #30)', () => {
    const base = compileScanFixture(validTrio());
    const landscape = compileScanFixture(validTrio(), { targetAspect: 1.6 });
    // Aspect is a per-mode compile input at every repo size, independent of the
    // hang-guard entity count. Per-kind maxBand still scopes the root (CLA-66).
    expect(landscape.targetAspect).toBe(1.6);
    expect(base.targetAspect).toBeUndefined();
    const root = base.navigation.rootEntityId;
    const off = JSON.stringify(base.createScene(root).protocolSnapshot);
    const on = JSON.stringify(landscape.createScene(root).protocolSnapshot);
    expect(on).not.toEqual(off);
    expect(landscape.scopeCompileOptions(root)).toEqual({
      maxBand: 'code',
      maxEdgesPerBand: SCAN_RELATION_EDGE_BUDGET,
      maxGridNodes: SCAN_CONTAINER_GRID_NODES,
      maxNodesPerBand: SCAN_RESIDENT_NODES_PER_BAND,
      pageCodeLandmarks: true,
      maxL2PreviewPillsPerOwner: SCAN_L2_RESIDENT_PREVIEW_PILLS,
    });
  });


  it('throws ScanFixtureError listing issues for an invalid snapshot', () => {
    const trio = validTrio();
    const entities = (trio.snapshot as { entities: unknown[] }).entities;
    entities.push(entities[0]); // duplicate entity id
    let caught: unknown;
    try { compileScanFixture(trio); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(ScanFixtureError);
    expect((caught as ScanFixtureError).issues.some(issue => /duplicate entity id/u.test(issue.message))).toBe(true);
    expect((caught as ScanFixtureError).issues[0]!.path).toMatch(/^snapshot\./u);
  });

  it('compiles extra catalog stories after the overview without replacing story.json', () => {
    const extra = { ...structuredClone(demoStory), id: 'story:okie-paste-a-repo', title: 'Okie: Paste a repository' };
    const fixture = compileScanFixture({
      ...validTrio(),
      stories: { schemaVersion: 1, stories: [structuredClone(demoStory), extra] },
    });
    expect(fixture.story.id).toBe((demoStory as { id: string }).id);
    expect(fixture.stories.map(plan => plan.id)).toEqual([(demoStory as { id: string }).id, extra.id]);
    expect(compileScanFixture(validTrio()).stories).toHaveLength(1);
  });

  it('never accepts a non-object document silently', () => {
    expect(() => compileScanFixture({ snapshot: null, view: demoView, story: demoStory })).toThrow(/must be a JSON object/u);
  });

  it('rejects via the loader when a fetched document is structurally invalid', async () => {
    const load: ScanTrioLoader = async name =>
      name === 'snapshot' ? { not: 'a snapshot' } : name === 'view' ? demoView : demoStory;
    await expect(loadScanFixture(load)).rejects.toBeInstanceOf(ScanFixtureError);
  });
});

describe('multi-repo scan doc resolution', () => {
  // Fake glob maps standing in for import.meta.glob's build-time output.
  const marker = (label: string) => () => Promise.resolve({ default: label });
  const root = {
    '../../../../fixtures/scan/snapshot.json': marker('root-snapshot'),
    '../../../../fixtures/scan/view.json': marker('root-view'),
    '../../../../fixtures/scan/story.json': marker('root-story'),
  };
  const repo = {
    '../../../../fixtures/scan/colinhacks__zod/snapshot.json': marker('zod-snapshot'),
    '../../../../fixtures/scan/colinhacks__zod/view.json': marker('zod-view'),
    '../../../../fixtures/scan/colinhacks__zod/story.json': marker('zod-story'),
    '../../../../fixtures/scan/acme__app/snapshot.json': marker('app-snapshot'),
    '../../../../fixtures/scan/acme__app/view.json': marker('app-view'),
    '../../../../fixtures/scan/acme__app/story.json': marker('app-story'),
  };

  it('no slug resolves the root self-scan trio (back-compat path unchanged)', async () => {
    expect((await resolveScanDocLoader('snapshot', undefined, { root, repo })()).default).toBe('root-snapshot');
    expect((await resolveScanDocLoader('view', undefined, { root, repo })()).default).toBe('root-view');
    // The root resolver never crosses into a per-repo directory.
    expect((await resolveScanDocLoader('story', undefined, { root, repo: {} })()).default).toBe('root-story');
  });

  it('a slug selects exactly that repo directory', async () => {
    expect((await resolveScanDocLoader('snapshot', 'colinhacks__zod', { root, repo })()).default).toBe('zod-snapshot');
    expect((await resolveScanDocLoader('view', 'acme__app', { root, repo })()).default).toBe('app-view');
  });

  it('fails closed on an unknown slug, listing the available slugs sorted', () => {
    try {
      resolveScanDocLoader('snapshot', 'missing__repo', { root, repo });
      throw new Error('expected a ScanFixtureError');
    } catch (error) {
      expect(error).toBeInstanceOf(ScanFixtureError);
      const message = (error as ScanFixtureError).issues[0]!.message;
      expect(message).toContain('No scanned repository “missing__repo”');
      expect(message).toContain('acme__app, colinhacks__zod');
    }
  });

  it('reports an incomplete slug directory distinctly from an unknown one', () => {
    const partial = { '../../../../fixtures/scan/half__done/snapshot.json': marker('x') };
    expect(() => resolveScanDocLoader('view', 'half__done', { root, repo: partial })).toThrow(/missing view\.json/u);
  });

  it('fails closed with guidance when no repos are available at all', () => {
    expect(() => resolveScanDocLoader('snapshot', 'anything', { root, repo: {} })).toThrow(/none are available/u);
  });
});

describe('runtime-fetch scan trio loader (hosted /r URLs)', () => {
  it('GETs /scan/<slug>/{name}.json and compiles nothing itself', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      calls.push(url);
      return new Response(JSON.stringify({ ok: url }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const load = fetchScanTrioLoader('thiss__okie', fetchImpl);
    expect(await load('snapshot')).toEqual({ ok: '/scan/thiss__okie/snapshot.json' });
    expect(await load('view')).toEqual({ ok: '/scan/thiss__okie/view.json' });
    expect(calls).toEqual([
      '/scan/thiss__okie/snapshot.json',
      '/scan/thiss__okie/view.json',
    ]);
  });

  it('fails closed on 404 without putting tokens in the message', async () => {
    const load = fetchScanTrioLoader('acme__app', async () => new Response('nope', { status: 404 }));
    try {
      await load('story');
      throw new Error('expected ScanFixtureError');
    } catch (error) {
      expect(error).toBeInstanceOf(ScanFixtureError);
      const message = (error as ScanFixtureError).issues[0]!.message;
      expect(message).toContain('/scan/acme__app/story.json');
      expect(message).not.toMatch(/gho_|ghp_|github_pat_|Bearer /u);
    }
  });
});

describe('CLA-73 slim neighborhood boot', () => {
  it('reads sel from the share URL for the boot focus', () => {
    expect(bootFocusFromSearch('?sel=container:web-app&detail=component')).toBe('container:web-app');
    expect(bootFocusFromSearch('?root=system:okie&lens=container:web-app')).toBe('container:web-app');
    expect(bootFocusFromSearch('?nav=1')).toBeUndefined();
  });

  it('GETs neighborhood.json + story.json, never snapshot.json', async () => {
    const calls: string[] = [];
    const packet = sliceArchitectureNeighborhood(
      structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot,
      structuredClone(demoView) as unknown as ArchitectureView,
      { focusEntityId: 'system:okie' },
    );
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      calls.push(url);
      if (url.includes('neighborhood.json')) {
        return new Response(JSON.stringify(packet), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('story.json')) {
        return new Response(JSON.stringify(demoStory), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (url.includes('excerpt.json')) {
        return new Response(JSON.stringify({ kind: 'excerpt', schemaVersion: 1, entityId: 'x', sourceExcerpts: [] }), { status: 200 });
      }
      return new Response('nope', { status: 404 });
    };
    const host = fetchScanNeighborhoodHost('thiss__okie', fetchImpl);
    await host.loadNeighborhood('system:okie');
    await host.loadStory();
    expect(calls.some(url => url.includes('neighborhood.json') && url.includes('focus=system%3Aokie'))).toBe(true);
    expect(calls).toContain('/scan/thiss__okie/story.json');
    expect(calls.some(url => url.includes('snapshot.json'))).toBe(false);
    expect(calls.some(url => url.includes('view.json'))).toBe(false);
  });

  it('pins story, sidecars, excerpts, and deeper neighborhoods to the bootstrap publication', async () => {
    const calls: string[] = [];
    const packet = { ...sliceArchitectureNeighborhood(
      structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot,
      structuredClone(demoView) as unknown as ArchitectureView,
      { focusEntityId: 'system:okie' },
    ), publication: { versionId: 'publication-old', artifactRevisionId: 'artifact-old' } };
    const fetchImpl: typeof fetch = async input => {
      const url = String(input); calls.push(url);
      if (url.includes('neighborhood.json')) return new Response(JSON.stringify(packet));
      if (url.includes('story.json')) return new Response(JSON.stringify(demoStory));
      if (url.includes('excerpt.json')) return new Response(JSON.stringify({ kind: 'excerpt', schemaVersion: 1, entityId: 'code:web-shell:app', sourceExcerpts: [] }));
      return new Response('{}', { status: 404 });
    };
    const fixture = await loadScanNeighborhoodFixture(fetchScanNeighborhoodHost('thiss__okie', fetchImpl), undefined);
    await fixture.ensureExcerpts('code:web-shell:app');
    await fixture.ensureNeighborhood('container:web-app');
    expect(calls[0]).toBe('/scan/thiss__okie/neighborhood.json');
    for (const url of calls.slice(1)) expect(new URL(url, 'http://fixture.test').searchParams.get('version')).toBe('publication-old');
  });

  it('compiles an L1 neighborhood without L4 excerpts and still lazy-loads Source', async () => {
    const packet = sliceArchitectureNeighborhood(
      structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot,
      structuredClone(demoView) as unknown as ArchitectureView,
      { focusEntityId: 'system:okie' },
    );
    expect(packet.snapshot.entities.some(entity => entity.kind === 'code')).toBe(false);
    expect(packet.snapshot.entities.some(entity => entity.sourceExcerpts?.length)).toBe(false);
    const excerpts = [{
      path: 'apps/web/src/App.tsx',
      language: 'tsx' as const,
      startLine: 1,
      endLine: 2,
      highlightLine: 1,
      frozenRevision: 'sha',
      lines: ['export function App() {', '}'],
      text: 'export function App() {\n}',
    }];
    const host = {
      loadNeighborhood: async (focus: string) => sliceArchitectureNeighborhood(
        structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot,
        structuredClone(demoView) as unknown as ArchitectureView,
        { focusEntityId: focus || 'system:okie' },
      ),
      loadExcerpts: async () => excerpts,
      loadStory: async () => demoStory,
    };
    const fixture = compileScanNeighborhoodFixture(packet, demoStory, host);
    expect(fixture.boot).toBe('neighborhood');
    expect(fixture.childCounts['container:web-app']).toBeGreaterThan(0);
    const scene = fixture.createScene(fixture.navigation.rootEntityId);
    expect(scene.entities.some(entity => entity.kind === 'container')).toBe(true);
    expect(scene.entities.some(entity => entity.detail === 'code')).toBe(false);

    await fixture.ensureNeighborhood('container:web-app');
    expect(fixture.snapshot.entities.some(entity => entity.id === 'component:web-shell')).toBe(true);

    const loaded = await fixture.ensureExcerpts('code:web-shell:app');
    expect(loaded?.[0]?.text).toContain('export function App()');

    const sourceEntity = fixture.snapshot.entities.find(entity => entity.id === 'component:web-shell');
    expect(sourceEntity).toBeDefined();
    sourceEntity!.sourceExcerpts = undefined;
    const generation = fixture.getSceneGeneration();
    const attached = await fixture.ensureExcerpts('component:web-shell');
    expect(attached?.[0]?.text).toContain('export function App()');
    expect(fixture.getSceneGeneration()).toBe(generation + 1);
    await fixture.ensureExcerpts('component:web-shell');
    expect(fixture.getSceneGeneration()).toBe(generation + 1);
    // This fixture shares packet entities with the separate deep-link case below.
    sourceEntity!.sourceExcerpts = undefined;

    const requested: string[] = [];
    const deepHost = {
      ...host,
      loadNeighborhood: async (focus: string) => {
        requested.push(focus);
        return host.loadNeighborhood(focus);
      },
    };
    const l1 = compileScanNeighborhoodFixture(packet, demoStory, deepHost);
    await l1.ensureNeighborhood('code:web-shell:app');
    expect(requested).toEqual(['code:web-shell:app']);
    expect(l1.snapshot.entities.some(entity => entity.id === 'code:web-shell:app')).toBe(true);
  });

  it.each([true, false])('restores deep URLs from canonical root geometry (complete root: %s)', async completeRoot => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const requested: string[] = [];
    const host = {
      loadNeighborhood: async (focus: string) => {
        requested.push(focus);
        return sliceArchitectureNeighborhood(snapshot, view, {
          focusEntityId: focus || view.rootEntityId,
          ...(!focus && completeRoot ? { maxBand: 'code' as const } : {}),
        });
      },
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const live = await loadScanNeighborhoodFixture(host, undefined, { targetAspect: 1.6 });
    for (const focus of ['system:okie', 'container:web-app', 'component:web-shell', 'code:web-shell:app']) {
      await live.ensureNeighborhood(focus);
    }
    requested.length = 0;
    const restored = await loadScanNeighborhoodFixtureFromSearch(host,
      '?root=container:web-app&lens=system:okie&lens=container:web-app&lens=component:web-shell&sel=code:web-shell:app&cx=446.959&cy=-241.815&z=3.71572',
      { targetAspect: 1.6 });
    expect(requested[0]).toBe('');
    if (completeRoot) expect(requested).toEqual(['']);
    expect(restored.snapshot.entities).toEqual(live.snapshot.entities);
    for (const focus of ['system:okie', 'container:web-app', 'component:web-shell']) {
      const expected = live.createScene(focus);
      const actual = restored.createScene(focus);
      expect(actual.entities).toEqual(expected.entities);
      expect(actual.protocolSnapshot).toEqual(expected.protocolSnapshot);
      expect(actual.scanGuardRefusal).toEqual(expected.scanGuardRefusal);
    }
  });

  it('CLA-94: rail step-out re-fetches the view-root neighborhood after a nested merge', async () => {
    const snapshot = structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot;
    const view = structuredClone(demoView) as unknown as ArchitectureView;
    const requested: string[] = [];
    const host = {
      loadNeighborhood: async (focus: string) => {
        requested.push(focus);
        return sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: focus || 'system:okie' });
      },
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    };
    const l1 = sliceArchitectureNeighborhood(snapshot, view, { focusEntityId: 'system:okie' });
    const fixture = compileScanNeighborhoodFixture(l1, demoStory, host);
    requested.length = 0;
    await fixture.ensureNeighborhood('system:okie');
    expect(requested).toEqual([]);

    await fixture.ensureNeighborhood('container:web-app');
    requested.length = 0;
    await fixture.ensureNeighborhood('system:okie');
    expect(requested).toEqual(['system:okie']);
    expect(fixture.snapshot.entities.some(entity => entity.kind === 'externalSystem' || entity.kind === 'person')).toBe(true);
  });

  it('CLA-75: loads secret-free enrichment honesty from published sidecars, not snapshot.json', async () => {
    const packet = sliceArchitectureNeighborhood(
      structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot,
      structuredClone(demoView) as unknown as ArchitectureView,
      { focusEntityId: 'system:okie' },
    );
    const host = {
      loadNeighborhood: async () => packet,
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
      loadEnrichmentReport: async () => ({
        promptVersion: 'okie-enrichment/v2',
        enrichedContainers: [],
        collapsedSelfEdges: 0,
        results: [{
          containerId: 'container:apps-web',
          accepted: false,
          reasons: ['gate: <root> llm gateway 401 from https://okietest:okie-test-url-token-cla75-fake@example.invalid/v1'],
        }],
        scanRoot: '/secret/scan',
        apiKey: 'okie-test-llm-key-cla75-fake',
      }),
      loadEnrichmentStatus: async () => ({
        state: 'complete',
        acceptedContainers: 0,
        attemptedContainers: 1,
        why: 'rejected',
        note: 'do not show',
      }),
    };
    const fixture = await loadScanNeighborhoodFixture(host, 'system:okie');
    expect(fixture.enrichmentHonesty?.why).toBe('rejected');
    expect(fixture.enrichmentHonesty?.chip).toContain('0 accepted');
    expect(JSON.stringify(fixture.enrichmentHonesty)).not.toMatch(/okie-test-url-token|example\.invalid|scanRoot|okie-test-llm-key|do not show/i);
    expect(fixture.boot).toBe('neighborhood');
  });

  it('CLA-75: omits honesty chrome when enrichment sidecars are absent', async () => {
    const packet = sliceArchitectureNeighborhood(
      structuredClone(demoSnapshot) as unknown as ArchitectureSnapshot,
      structuredClone(demoView) as unknown as ArchitectureView,
      { focusEntityId: 'system:okie' },
    );
    const fixture = await loadScanNeighborhoodFixture({
      loadNeighborhood: async () => packet,
      loadExcerpts: async () => undefined,
      loadStory: async () => demoStory,
    }, 'system:okie');
    expect(fixture.enrichmentHonesty).toBeUndefined();
  });

  it('CLA-99: missing enrichment-status.json is non-fatal and is not a user error', async () => {
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async input => {
      const url = String(input);
      calls.push(url);
      return new Response('not found', { status: 404 });
    };
    await expect(loadPublishedEnrichmentHonesty('thiss__okie', fetchImpl)).resolves.toBeUndefined();
    expect(calls).toEqual([
      '/scan/thiss__okie/enrichment-report.json',
      '/scan/thiss__okie/enrichment-status.json',
    ]);
  });

  it('CLA-266: the hosted edge 204 (optional sidecar published without) reads as missing (empty body)', async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 204 });
    await expect(loadPublishedEnrichmentHonesty('thiss__okie', fetchImpl)).resolves.toBeUndefined();
  });

  it('does not raise the 2000 hang-guard', () => {
    const fixture = compileScanFixture(validTrio());
    expect(fixture.boot).toBe('full');
  });
});
