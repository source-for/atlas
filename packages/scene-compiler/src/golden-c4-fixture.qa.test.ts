import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildC4ProjectionBundle,
  SOURCE_EXCERPT_LIMITS,
  selectC4BandProjection,
  validateSnapshot,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type C4Band,
  type C4ProjectionBundle,
} from '@okie/architecture';
import { goldenSnapshot, goldenStory, goldenView, GOLDEN_WORKTREE_REVISION } from './golden-fixture.js';

const repositoryRoot = fileURLToPath(new URL('../../../', import.meta.url));
const fixture = (path: string): string => fileURLToPath(new URL(`../../../fixtures/${path}`, import.meta.url));

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(fixture(path), 'utf8')) as T;
}

function hash(value: unknown): string {
  let result = 2_166_136_261;
  for (const character of JSON.stringify(value)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

test('frozen Okie fixture has exact stable IDs, strict C4 parentage, and pinned real-file evidence', async () => {
  const [snapshot, view, story] = await Promise.all([
    readJson<ArchitectureSnapshot>('architecture/demo-snapshot.json'),
    readJson<ArchitectureView>('architecture/demo-view.json'),
    readJson<ArchitectureStory>('architecture/demo-story.json'),
  ]);
  assert.deepEqual(snapshot, goldenSnapshot);
  assert.deepEqual(view, goldenView);
  assert.deepEqual(story, goldenStory);
  assert.equal(snapshot.id, 'snapshot:okie-golden-worktree-v1');
  assert.equal(snapshot.repositoryId, 'repo:okie-golden');
  assert.equal(snapshot.commitSha, GOLDEN_WORKTREE_REVISION);
  assert.deepEqual(validateSnapshot(snapshot), []);
  assert.equal(hash(snapshot.entities.map(entity => entity.id).sort()), '1bd2200b');
  assert.equal(hash(snapshot.relations.map(relation => relation.id).sort()), 'd631b701');

  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const byKind = (kind: string) => snapshot.entities.filter(entity => entity.kind === kind);
  assert.deepEqual(
    [byKind('person').length + byKind('softwareSystem').length + byKind('externalSystem').length, byKind('container').length, byKind('component').length, byKind('code').length],
    [4, 5, 20, 41],
  );
  assert.equal(entityById.get('system:okie')?.parentId, undefined);
  for (const entity of [...byKind('person'), ...byKind('externalSystem')]) assert.equal(entity.parentId, undefined);
  for (const entity of byKind('container')) assert.equal(entity.parentId, 'system:okie');
  for (const entity of byKind('component')) assert.equal(entityById.get(entity.parentId ?? '')?.kind, 'container');
  for (const entity of byKind('code')) assert.equal(entityById.get(entity.parentId ?? '')?.kind, 'component');
  assert.equal(snapshot.relations.some(relation => relation.kind === 'contains'), false);
  assert.equal(new Set(snapshot.entities.map(entity => entity.lineageId)).size, snapshot.entities.length);
  assert.equal(new Set(snapshot.relations.map(relation => relation.lineageId)).size, snapshot.relations.length);

  const evidenceRows: unknown[] = [];
  const sources = [
    ...snapshot.entities.flatMap(entity => entity.sourceRefs.map(source => ({ owner: ['entity', entity.id] as const, source }))),
    ...snapshot.relations.flatMap(relation => relation.evidence.map(evidence => ({ owner: ['relation', relation.id] as const, source: evidence.source }))),
  ];
  for (const { owner, source } of sources) {
    assert.equal(source.commitSha, GOLDEN_WORKTREE_REVISION);
    assert.equal(source.path.startsWith('/'), false);
    assert.equal(source.path.split('/').includes('..'), false);
    await access(`${repositoryRoot}${source.path}`);
    evidenceRows.push([owner[0], owner[1], source.path, source.symbol ?? null, source.startLine ?? null, source.endLine ?? null, source.commitSha]);
  }
  evidenceRows.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  assert.equal(hash(evidenceRows), '45ebfc3e');

  const ids = new Set(snapshot.entities.map(entity => entity.id));
  for (const entity of snapshot.entities) if (entity.parentId) assert.equal(ids.has(entity.parentId), true);
  for (const relation of snapshot.relations) {
    assert.equal(ids.has(relation.from), true);
    assert.equal(ids.has(relation.to), true);
    assert.ok(relation.evidence.length > 0);
  }
});

test('golden code excerpts are exact, portable, capped, symbol-coherent slices of frozen repository files', async () => {
  const codeEntities = goldenSnapshot.entities.filter(entity => entity.kind === 'code');
  assert.equal(codeEntities.length, 41);
  const excerptRows: unknown[] = [];
  for (const entity of codeEntities) {
    assert.equal(entity.sourceExcerpts?.length, 1, `${entity.id} must carry one frozen excerpt`);
    const excerpt = entity.sourceExcerpts![0]!;
    const source = entity.sourceRefs[0]!;
    assert.deepEqual({
      path: excerpt.path,
      symbol: excerpt.symbol,
      revision: excerpt.frozenRevision,
      startLine: excerpt.startLine,
      endLine: excerpt.endLine,
    }, {
      path: source.path,
      symbol: source.symbol,
      revision: source.commitSha,
      startLine: source.startLine,
      endLine: source.endLine,
    });
    assert.equal(excerpt.path.startsWith('/'), false);
    assert.equal(excerpt.path.includes('\\'), false);
    assert.equal(excerpt.path.split('/').includes('..'), false);
    assert.equal(excerpt.frozenRevision, goldenSnapshot.commitSha);
    assert.equal(excerpt.lines.length <= SOURCE_EXCERPT_LIMITS.maxLines, true);
    assert.equal([...excerpt.text].length <= SOURCE_EXCERPT_LIMITS.maxTextCharacters, true);
    assert.equal(excerpt.text, excerpt.lines.join('\n'));
    for (const line of excerpt.lines) {
      assert.equal([...line].length <= SOURCE_EXCERPT_LIMITS.maxLineCharacters, true);
    }

    const actualLines = (await readFile(`${repositoryRoot}${excerpt.path}`, 'utf8')).replace(/\r\n/g, '\n').split('\n');
    assert.deepEqual(
      actualLines.slice(excerpt.startLine - 1, excerpt.endLine),
      excerpt.lines,
      `${entity.id} excerpt must match the checked repository file exactly`,
    );
    if (excerpt.symbol) {
      const symbolLeaf = excerpt.symbol.split('::').at(-1)!;
      assert.ok(excerpt.lines[excerpt.highlightLine - excerpt.startLine]!.includes(symbolLeaf),
        `${entity.id} highlight must contain ${symbolLeaf}`);
    }
    excerptRows.push([
      entity.id,
      excerpt.path,
      excerpt.symbol ?? null,
      excerpt.language,
      excerpt.startLine,
      excerpt.endLine,
      excerpt.highlightLine,
      excerpt.frozenRevision,
      excerpt.text,
    ]);
  }
  assert.equal(JSON.stringify(goldenSnapshot).includes(repositoryRoot), false, 'canonical data must never contain a local absolute root');
  assert.equal(new Set(excerptRows.map(row => JSON.stringify(row))).size, codeEntities.length);
});

test('checked C4 bundle and Mermaid-ready materialized projections are canonical and byte-stable', async () => {
  const checked = await readJson<C4ProjectionBundle>('renderer/demo-c4-projections.json');
  const rebuilt = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'view-family:okie-golden:system-root',
  });
  assert.deepEqual(rebuilt, checked);
  assert.equal(hash(checked), 'f10be4d8');
  const expected: Record<C4Band, { count: [number, number]; hash: string }> = {
    context: { count: [4, 3], hash: '660a6972' },
    container: { count: [9, 5], hash: '3a8c0a59' },
    component: { count: [29, 23], hash: 'a7a6f555' },
    code: { count: [70, 12], hash: '80b10122' },
  };

  for (const band of ['context', 'container', 'component', 'code'] as const) {
    const projection = selectC4BandProjection(checked, band);
    assert.deepEqual([projection.nodes.length, projection.edges.length], expected[band].count);
    assert.equal(hash(projection), expected[band].hash);
    assert.deepEqual(projection.nodes.map(node => node.id), [...projection.nodes.map(node => node.id)].sort());
    assert.deepEqual(projection.edges.map(edge => edge.id), [...projection.edges.map(edge => edge.id)].sort());
    const nodeIds = new Set(projection.nodes.map(node => node.id));
    for (const edge of projection.edges) {
      assert.equal(nodeIds.has(edge.fromVisualId), true);
      assert.equal(nodeIds.has(edge.toVisualId), true);
      assert.notEqual(edge.fromVisualId, edge.toVisualId);
      assert.ok(edge.relations.length > 0);
      assert.ok(edge.route.points.length >= 2);
    }
  }

  const reversed = buildC4ProjectionBundle({
    ...goldenSnapshot,
    entities: [...goldenSnapshot.entities].reverse(),
    relations: [...goldenSnapshot.relations].reverse(),
  }, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
    familyId: 'view-family:okie-golden:system-root',
  });
  for (const band of ['context', 'container', 'component', 'code'] as const) {
    assert.equal(JSON.stringify(selectC4BandProjection(reversed, band)), JSON.stringify(selectC4BandProjection(checked, band)));
  }
});

test('CLA-102: golden curated system technology badge string is unchanged', () => {
  const system = goldenSnapshot.entities.find(entity => entity.id === 'system:okie');
  assert.deepEqual(system?.technology, ['TypeScript', 'Rust', 'WebAssembly', 'wgpu']);
  assert.equal(system?.technology?.join(' · '), 'TypeScript · Rust · WebAssembly · wgpu');
});
