import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildC4ProjectionBundle,
  C4_BANDS,
  C4_INTRINSIC_LAYOUT,
  measureC4Grid,
  type C4ProjectionBundle,
} from './c4.js';
import type { ArchitectureRelation, ArchitectureSnapshot, SourceRef } from './model.js';
import { compareText } from './text-order.js';

const source = (path: string, symbol: string): SourceRef => ({
  path,
  symbol,
  commitSha: '0123456789abcdef',
});

const evidence = (path: string, symbol: string) => [{ source: source(path, symbol), reason: 'qa fixture evidence' }];

const snapshot: ArchitectureSnapshot = {
  schemaVersion: 1,
  id: 'snapshot:c4-qa',
  repositoryId: 'repo:c4-qa',
  commitSha: '0123456789abcdef',
  generatedAt: '2026-07-14T00:00:00.000Z',
  entities: [
    { id: 'actor:developer', lineageId: 'actor:developer', kind: 'person', name: 'Developer', sourceRefs: [source('README.md', 'Developer')] },
    { id: 'system:okie', lineageId: 'system:okie', kind: 'softwareSystem', name: 'Okie', sourceRefs: [source('README.md', 'Okie')] },
    { id: 'external:repository', lineageId: 'external:repository', kind: 'externalSystem', name: 'Repository', sourceRefs: [source('packages/architecture/src/model.ts', 'SourceRef')] },
    { id: 'container:web', lineageId: 'container:web', kind: 'container', parentId: 'system:okie', name: 'Web', sourceRefs: [source('apps/web/src/App.tsx', 'App')] },
    { id: 'container:model', lineageId: 'container:model', kind: 'container', parentId: 'system:okie', name: 'Model', sourceRefs: [source('packages/architecture/src/model.ts', 'ArchitectureSnapshot')] },
    { id: 'component:shell', lineageId: 'component:shell', kind: 'component', parentId: 'container:web', name: 'Shell', sourceRefs: [source('apps/web/src/App.tsx', 'CanvasViewport')] },
    { id: 'component:schema', lineageId: 'component:schema', kind: 'component', parentId: 'container:model', name: 'Schema', sourceRefs: [source('packages/architecture/src/model.ts', 'ArchitectureEntity')] },
    { id: 'component:selectors', lineageId: 'component:selectors', kind: 'component', parentId: 'container:model', name: 'Selectors', sourceRefs: [source('packages/architecture/src/normalized.ts', 'selectScopedView')] },
    { id: 'code:app', lineageId: 'code:app', kind: 'code', parentId: 'component:shell', name: 'App', sourceRefs: [source('apps/web/src/App.tsx', 'App')] },
    { id: 'code:snapshot', lineageId: 'code:snapshot', kind: 'code', parentId: 'component:schema', name: 'ArchitectureSnapshot', sourceRefs: [source('packages/architecture/src/model.ts', 'ArchitectureSnapshot')] },
    { id: 'code:select-scoped', lineageId: 'code:select-scoped', kind: 'code', parentId: 'component:selectors', name: 'selectScopedView()', sourceRefs: [source('packages/architecture/src/normalized.ts', 'selectScopedView')] },
  ],
  relations: [
    { id: 'relation:developer-okie', lineageId: 'relation:developer-okie', from: 'actor:developer', to: 'system:okie', kind: 'uses', label: 'explores', evidence: evidence('apps/web/src/App.tsx', 'App') },
    { id: 'relation:repository-schema', lineageId: 'relation:repository-schema', from: 'external:repository', to: 'component:schema', kind: 'uses', label: 'supports', evidence: evidence('packages/architecture/src/model.ts', 'Evidence') },
    { id: 'relation:shell-schema', lineageId: 'relation:shell-schema', from: 'component:shell', to: 'component:schema', kind: 'calls', label: 'reads model', technology: 'TypeScript', evidence: evidence('apps/web/src/App.tsx', 'App') },
    { id: 'relation:shell-selectors', lineageId: 'relation:shell-selectors', from: 'component:shell', to: 'component:selectors', kind: 'calls', label: 'reads model', technology: 'TypeScript', evidence: evidence('apps/web/src/App.tsx', 'App') },
    { id: 'relation:app-snapshot', lineageId: 'relation:app-snapshot', from: 'code:app', to: 'code:snapshot', kind: 'calls', label: 'constructs', technology: 'in-process', evidence: evidence('apps/web/src/App.tsx', 'App') },
    { id: 'relation:app-select-scoped', lineageId: 'relation:app-select-scoped', from: 'code:app', to: 'code:select-scoped', kind: 'calls', label: 'selects', technology: 'in-process', optional: true, evidence: evidence('apps/web/src/App.tsx', 'App') },
    { id: 'relation:schema-selectors', lineageId: 'relation:schema-selectors', from: 'component:schema', to: 'component:selectors', kind: 'calls', label: 'indexes', evidence: evidence('packages/architecture/src/normalized.ts', 'buildNormalizedIndexes') },
    { id: 'relation:model-web', lineageId: 'relation:model-web', from: 'container:model', to: 'container:web', kind: 'returns', label: 'semantic state', evidence: evidence('packages/architecture/src/model.ts', 'ArchitectureSnapshot') },
  ],
};

function projection(bundle: C4ProjectionBundle, band: (typeof C4_BANDS)[number]) {
  return bundle.projectionById[bundle.family.projectionIds[band]]!;
}

function relationById(id: string): ArchitectureRelation {
  const relation = snapshot.relations.find(candidate => candidate.id === id);
  assert.ok(relation, `missing source relation ${id}`);
  return relation;
}

function stableHash(value: unknown): string {
  let hash = 2_166_136_261;
  for (const character of JSON.stringify(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

test('focusing a finer entity preserves coarse C4 membership and its context anchor', () => {
  const withoutRelations = { ...snapshot, relations: [] };
  const contextLayouts = ['system:okie', 'container:web', 'component:shell', 'code:app'].map(focusEntityId => {
    const bundle = buildC4ProjectionBundle(withoutRelations, { rootEntityId: 'system:okie', focusEntityId });
    const context = projection(bundle, 'context');
    const layout = bundle.bandLayoutById[context.layoutId]!;
    const entries = context.visualNodeIds.map(id => ({
      id: bundle.index.entityIdByVisualNodeId[id],
      kind: bundle.visualNodeById[id]!.kind,
      bounds: layout.nodes[id],
    })).sort((a, b) => compareText(a.id!, b.id!));
    assert.deepEqual(entries.map(entry => entry.id), ['actor:developer', 'external:repository', 'system:okie']);
    assert.ok(entries.every(entry => ['person', 'externalSystem', 'softwareSystem'].includes(entry.kind)));
    for (const band of C4_BANDS) {
      const current = projection(bundle, band);
      for (const id of current.visualNodeIds) {
        const parent = bundle.visualNodeById[id]!.parentVisualId;
        if (parent) assert.ok(current.visualNodeIds.includes(parent), `${band} retains native-band ancestry`);
      }
    }
    return entries;
  });
  for (const layout of contextLayouts.slice(1)) assert.deepEqual(layout, contextLayouts[0]);
});

test('intrinsic C4 grid reserves readable code cards, component header, padding, and gaps', () => {
  const metrics = {
    gap: C4_INTRINSIC_LAYOUT.gap,
    paddingLeft: C4_INTRINSIC_LAYOUT.sidePadding,
    paddingRight: C4_INTRINSIC_LAYOUT.sidePadding,
    paddingTop: C4_INTRINSIC_LAYOUT.header.component,
    paddingBottom: C4_INTRINSIC_LAYOUT.bottomPadding,
  };
  const code = C4_INTRINSIC_LAYOUT.leaf.code;
  const measured = measureC4Grid([
    { id: 'code:c', ...code },
    { id: 'code:a', ...code },
    { id: 'code:b', ...code },
  ], metrics);

  assert.deepEqual(measured, {
    columns: 2,
    rows: 2,
    columnWidths: [224, 224],
    rowHeights: [112, 112],
    contentWidth: 464,
    contentHeight: 240,
    width: 504,
    height: 356,
  });
  assert.deepEqual(measureC4Grid([
    { id: 'code:b', ...code },
    { id: 'code:c', ...code },
    { id: 'code:a', ...code },
  ], metrics), measured, 'grid measurement must be insertion-order stable');
});

test('four C4 bands have distinct deterministic membership, labels, relations, and quantized layouts', () => {
  const first = buildC4ProjectionBundle(snapshot, { rootEntityId: 'system:okie' });
  const reversed = buildC4ProjectionBundle({
    ...snapshot,
    entities: [...snapshot.entities].reverse(),
    relations: [...snapshot.relations].reverse(),
  }, { rootEntityId: 'system:okie' });

  assert.deepEqual(reversed, first);
  const memberships = C4_BANDS.map(band => projection(first, band).visualNodeIds);
  const relations = C4_BANDS.map(band => projection(first, band).visualEdgeIds);
  const labels = C4_BANDS.map(band => projection(first, band).visualEdgeIds.map(id => first.visualEdgeById[id]!.label));
  assert.deepEqual(memberships.map(value => value.length), [3, 5, 8, 11]);
  assert.equal(new Set(memberships.map(stableHash)).size, 4);
  assert.equal(new Set(relations.map(stableHash)).size, 4);
  assert.equal(new Set(labels.map(stableHash)).size, 4);

  for (const band of C4_BANDS) {
    const current = projection(first, band);
    const visible = new Set(current.visualNodeIds);
    const layout = first.bandLayoutById[current.layoutId]!;
    assert.deepEqual(Object.keys(layout.nodes).sort(), [...visible].sort());
    assert.deepEqual(Object.keys(layout.edges).sort(), [...current.visualEdgeIds].sort());
    for (const value of Object.values(layout.nodes).flatMap(bounds => [bounds.x, bounds.y, bounds.width, bounds.height])) {
      assert.equal(Number.isFinite(value), true);
      assert.equal(Number.isInteger(value * 4), true, `${band} node geometry must use the quarter-unit grid`);
    }
    for (const edgeId of current.visualEdgeIds) {
      const edge = first.visualEdgeById[edgeId]!;
      assert.equal(edge.projectionId, current.id);
      assert.equal(visible.has(edge.fromVisualId), true);
      assert.equal(visible.has(edge.toVisualId), true);
      assert.notEqual(edge.fromVisualId, edge.toVisualId, 'projected self-edges must be suppressed');
      assert.deepEqual(edge.relations.map(value => value.logicalId), [...edge.relations.map(value => value.logicalId)].sort());
      for (const ref of edge.relations) assert.ok(relationById(ref.logicalId).evidence.length > 0);
      for (const point of layout.edges[edgeId]!.points) {
        assert.equal(Number.isInteger(point.x * 4), true, `${band} edge x must use the quarter-unit grid`);
        assert.equal(Number.isInteger(point.y * 4), true, `${band} edge y must use the quarter-unit grid`);
      }
    }
    for (const nodeId of current.visualNodeIds) {
      const parentId = first.visualNodeById[nodeId]!.parentVisualId;
      if (parentId) assert.equal(visible.has(parentId), true, `${band} must retain the visible parent of ${nodeId}`);
    }
  }
});

test('aggregation keys only on visible direction, endpoints, and kind while preserving metadata and evidence IDs', () => {
  const bundle = buildC4ProjectionBundle(snapshot, { rootEntityId: 'system:okie' });
  const containers = projection(bundle, 'container');
  const webId = bundle.index.visualNodeIdsByEntityId['container:web']![0]!;
  const modelId = bundle.index.visualNodeIdsByEntityId['container:model']![0]!;
  const calls = containers.visualEdgeIds
    .map(id => bundle.visualEdgeById[id]!)
    .filter(edge => edge.fromVisualId === webId && edge.toVisualId === modelId && edge.kind === 'calls');

  assert.equal(calls.length, 1, 'optional and technology facets must not split the endpoint+kind aggregate');
  assert.deepEqual(calls[0]!.relations.map(value => value.logicalId), [
    'relation:app-select-scoped',
    'relation:app-snapshot',
    'relation:shell-schema',
    'relation:shell-selectors',
  ]);
  assert.equal(calls[0]!.label, '4 calls');
  assert.deepEqual(calls[0]!.aggregate, {
    count: 4,
    kinds: ['calls'],
    labels: ['constructs', 'reads model', 'selects'],
    technologies: ['TypeScript', 'in-process'],
    optionalCount: 1,
  });

  const reverse = containers.visualEdgeIds
    .map(id => bundle.visualEdgeById[id]!)
    .find(edge => edge.fromVisualId === modelId && edge.toVisualId === webId && edge.kind === 'returns');
  assert.ok(reverse, 'direction must remain distinct from the forward aggregate');
  assert.equal(containers.visualEdgeIds.some(id => {
    const edge = bundle.visualEdgeById[id]!;
    return edge.fromVisualId === modelId && edge.toVisualId === modelId;
  }), false, 'internal component traffic must not become a container self-edge');
});

test('shared lineage nodes retain visual identity across explicit drill projection families', () => {
  const outer = buildC4ProjectionBundle(snapshot, { rootEntityId: 'system:okie' });
  const inner = buildC4ProjectionBundle(snapshot, { rootEntityId: 'container:model' });

  for (const entityId of ['system:okie', 'container:model', 'component:schema', 'component:selectors']) {
    const outerId = outer.index.visualNodeIdsByEntityId[entityId]?.[0];
    const innerId = inner.index.visualNodeIdsByEntityId[entityId]?.[0];
    assert.ok(outerId, `${entityId} must exist in the outer projection family`);
    assert.ok(innerId, `${entityId} must exist in the drilled projection family`);
    assert.equal(innerId, outerId, `${entityId} must interpolate as one retained visual node across drill`);
  }
});
