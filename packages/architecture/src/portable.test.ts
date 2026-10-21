import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { parsePortableAtlas, serializePortableAtlas, type PortableAtlas } from './portable.js';

function fixture(): PortableAtlas {
  const read = (name: string) => JSON.parse(readFileSync(new URL(`../../../fixtures/architecture/demo-${name}.json`, import.meta.url), 'utf8')
    .replaceAll('golden-worktree-okie-2026-07-14-v1', 'a'.repeat(40)));
  return { format: 'okie-atlas', version: 1, repository: { commitSha: 'a'.repeat(40), treeHash: 'b'.repeat(40) },
    snapshot: read('snapshot'), view: read('view'), story: read('story'), stories: [],
    analysis: { mode: 'quick', adapters: [{ language: 'typescript', tool: 'typescript', version: '5.9.3', coverage: 'syntax', limitations: ['No project type information.'] }] } };
}

test('portable atlas round-trips the semantic fixture and optional source without a server', () => {
  const bundle = fixture();
  bundle.sources = [{ path: 'src/example.ts', text: 'export const answer = 42;\n' }];
  assert.deepEqual(parsePortableAtlas(serializePortableAtlas(bundle)), bundle);
});

test('portable body windows retain original ranges and reject malformed capture metadata', () => {
  const bundle = fixture();
  const entity = bundle.snapshot.entities.find(row => row.sourceExcerpts?.length)!;
  const excerpt = entity.sourceExcerpts![0]!;
  excerpt.sourceStartLine = excerpt.startLine;
  excerpt.sourceEndLine = excerpt.endLine + 20;
  entity.sourceRefs.push({ path: excerpt.path, commitSha: excerpt.frozenRevision,
    ...(excerpt.symbol ? { symbol: excerpt.symbol } : {}), startLine: excerpt.sourceStartLine, endLine: excerpt.sourceEndLine });
  assert.deepEqual(parsePortableAtlas(serializePortableAtlas(bundle)), bundle);
  Object.assign(excerpt, { sourceEndLine: 'not a line' });
  assert.throws(() => parsePortableAtlas(JSON.stringify(bundle)), /sourceEndLine/);
});

test('portable import rejects incompatible, malformed and mixed-revision graphs', () => {
  assert.throws(() => parsePortableAtlas('{}'), /Unsupported/);
  assert.throws(() => parsePortableAtlas('bad json'), /valid JSON/);
  const bundle = fixture();
  bundle.repository.commitSha = 'c'.repeat(40);
  assert.throws(() => serializePortableAtlas(bundle), /revision/);
  const mixed = fixture();
  const ref = mixed.snapshot.entities.flatMap(entity => entity.sourceRefs)[0]!;
  ref.commitSha = 'c'.repeat(40);
  assert.throws(() => serializePortableAtlas(mixed), /revision/);
  assert.throws(() => parsePortableAtlas(JSON.stringify({ ...fixture(), snapshot: { commitSha: 'a'.repeat(40) } })), /Invalid scan graph/);
});

test('portable sources reject path traversal, duplicate paths and credential-bearing URLs', () => {
  for (const path of ['../secret', '/absolute', 'C:\\file', 'https://example.com/file', 'src/../file']) {
    assert.throws(() => serializePortableAtlas({ ...fixture(), sources: [{ path, text: '' }] }), /repository-relative/);
  }
  assert.throws(() => serializePortableAtlas({ ...fixture(), sources: [{ path: 'x.ts', text: 'a' }, { path: 'x.ts', text: 'b' }] }), /unique/);
  const bundle = fixture();
  bundle.repository.url = 'https://token@example.com/repo';
  assert.throws(() => serializePortableAtlas(bundle), /credentials/);
});

test('portable imports reject malformed entity fields before deferred UI selection', () => {
  const malformed: [string, unknown][] = [
    ['id', 12], ['name', {}], ['kind', 'nonsense'], ['lineageId', []], ['parentId', false],
    ['responsibility', { bad: true }], ['technology', { bad: true }], ['technology', [1]],
    ['tags', [{}]], ['exposure', [{}]], ['exposure', [{ kind: 'invented', evidence: {} }]],
    ['owners', [null]], ['cyclomaticComplexity', '1'], ['coverageFileHitRate', '0.5'],
    ['coverageUntestedRanges', [{ startLine: '1', endLine: 2 }]], ['untestedBehaviours', [{}]],
    ['sourceRefs', [null]], ['sourceExcerpts', [{ symbol: 123 }]], ['confidence', '1'], ['fingerprint', {}],
  ];
  for (const [field, value] of malformed) {
    const bundle = fixture();
    const entity = bundle.snapshot.entities.at(-1)!;
    Object.assign(entity, { [field]: value });
    assert.throws(() => parsePortableAtlas(JSON.stringify(bundle)), /Invalid scan graph: snapshot\.entities\[/, field);
  }
});

test('portable imports validate relation, snapshot and layout runtime fields', () => {
  const malformed: [string, (bundle: PortableAtlas) => void][] = [
    ['snapshot repository identity', bundle => Object.assign(bundle.snapshot, { repositoryId: {} })],
    ['snapshot timestamp', bundle => Object.assign(bundle.snapshot, { generatedAt: [] })],
    ['relation id', bundle => Object.assign(bundle.snapshot.relations[0]!, { id: {} })],
    ['relation kind', bundle => Object.assign(bundle.snapshot.relations[0]!, { kind: 'invented' })],
    ['relation label', bundle => Object.assign(bundle.snapshot.relations[0]!, { label: {} })],
    ['relation technology', bundle => Object.assign(bundle.snapshot.relations[0]!, { technology: [] })],
    ['relation optional', bundle => Object.assign(bundle.snapshot.relations[0]!, { optional: 'false' })],
    ['evidence reason', bundle => Object.assign(bundle.snapshot.relations[0]!.evidence[0]!, { reason: {} })],
    ['view name', bundle => Object.assign(bundle.view, { name: {} })],
    ['view entity list', bundle => Object.assign(bundle.view, { entityIds: {} })],
    ['node locked', bundle => Object.assign(Object.values(bundle.view.layout.nodes)[0]!, { locked: 'true' })],
    ['edge points', bundle => Object.assign(bundle.view.layout, { edges: { edge: { points: [null] } } })],
  ];
  for (const [name, mutate] of malformed) {
    const bundle = fixture();
    mutate(bundle);
    assert.throws(() => parsePortableAtlas(JSON.stringify(bundle)), /Invalid scan graph: (snapshot|view)\./, name);
  }
});

test('portable exposure evidence is checked for structure, revision and source location', () => {
  const bundle = fixture();
  const entity = bundle.snapshot.entities.find(item => item.sourceRefs.length)!;
  entity.exposure = [{ kind: 'publicApi', evidence: { source: { ...entity.sourceRefs[0]! }, reason: 'Exported declaration.' } }];
  assert.deepEqual(parsePortableAtlas(serializePortableAtlas(bundle)), bundle);
  const source = entity.exposure[0]!.evidence.source;
  source.commitSha = 'c'.repeat(40);
  assert.throws(() => serializePortableAtlas(bundle), /revision/);
  source.commitSha = bundle.repository.commitSha;
  source.path = '../outside.ts';
  assert.throws(() => serializePortableAtlas(bundle), /repository-relative/);
  source.path = 'src/code.ts';
  source.startLine = 2;
  source.endLine = 1;
  assert.throws(() => serializePortableAtlas(bundle), /ordered line range/);
});

test('portable analyzer enums must be strings without coercion', () => {
  const mode = fixture();
  Object.assign(mode.analysis, { mode: ['quick'] });
  assert.throws(() => parsePortableAtlas(JSON.stringify(mode)), /analysis coverage/);
  const coverage = fixture();
  Object.assign(coverage.analysis.adapters[0]!, { coverage: ['syntax'] });
  assert.throws(() => parsePortableAtlas(JSON.stringify(coverage)), /coverage entry/);
});

test('portable container-membership report (CLA-263) round-trips and rejects malformed entries', () => {
  const alias = { path: 'api/share.ts', target: 'apps/web/api/share.ts', unit: 'apps/web' };
  const diagnostic = { code: 'reexport-across-containers', severity: 'warning' as const, path: 'api/share.ts', target: 'apps/web/api/share.ts',
    containerIds: ['container:apps-web', 'container:tooling'], entityIds: ['component:api-share-ts'], message: 'm' };
  const withMembership = (membership: unknown): PortableAtlas => {
    const bundle = fixture();
    (bundle.analysis as Record<string, unknown>).membership = membership;
    return bundle;
  };
  const valid = withMembership({ reexportAliases: [alias], diagnostics: [diagnostic] });
  assert.deepEqual(parsePortableAtlas(serializePortableAtlas(valid)), valid);
  // Forward compatible: an unknown future code still parses.
  const future = withMembership({ reexportAliases: [], diagnostics: [{ ...diagnostic, code: 'some-future-code' }] });
  assert.deepEqual(parsePortableAtlas(JSON.stringify(future)).analysis.membership?.diagnostics[0]?.code, 'some-future-code');
  const malformed: unknown[] = [
    [], 'x', { reexportAliases: [] }, { diagnostics: [] },
    { reexportAliases: [{ ...alias, path: '../escape.ts' }], diagnostics: [] },
    { reexportAliases: [{ ...alias, target: '/abs.ts' }], diagnostics: [] },
    { reexportAliases: [{ ...alias, unit: '' }], diagnostics: [] },
    { reexportAliases: [], diagnostics: [{ ...diagnostic, code: '' }] },
    { reexportAliases: [], diagnostics: [{ ...diagnostic, severity: 'error' }] },
    { reexportAliases: [], diagnostics: [{ ...diagnostic, path: 'src/../x.ts' }] },
    { reexportAliases: [], diagnostics: [{ ...diagnostic, target: 'https://example.com/x.ts' }] },
    { reexportAliases: [], diagnostics: [{ ...diagnostic, containerIds: [1] }] },
    { reexportAliases: [], diagnostics: [{ ...diagnostic, entityIds: 'x' }] },
    { reexportAliases: [], diagnostics: [{ ...diagnostic, message: 3 }] },
  ];
  for (const membership of malformed) {
    assert.throws(() => parsePortableAtlas(JSON.stringify(withMembership(membership))), /container-membership/, JSON.stringify(membership));
  }
});

test('portable scan-level limitations (CLA-299) round-trip and must be strings', () => {
  const bundle = fixture();
  bundle.analysis.limitations = ['1 Git submodule(s) were not scanned (their content is another repository).'];
  assert.deepEqual(parsePortableAtlas(serializePortableAtlas(bundle)), bundle);
  assert.equal(parsePortableAtlas(JSON.stringify(fixture())).analysis.limitations, undefined, 'optional');
  for (const invalid of ['x', [1], {}]) {
    const bad = fixture();
    (bad.analysis as Record<string, unknown>).limitations = invalid;
    assert.throws(() => parsePortableAtlas(JSON.stringify(bad)), /limitations list/);
  }
});

test('portable generator (CLA-604) is optional, round-trips at version 1, and must name a tool and version', () => {
  const bundle = { ...fixture(), generator: { name: '@sourcefor/atlas', version: '0.1.0' } };
  assert.deepEqual(parsePortableAtlas(serializePortableAtlas(bundle)), bundle);
  assert.equal(parsePortableAtlas(serializePortableAtlas(bundle)).version, 1);
  for (const generator of [null, 'sourcefor-atlas', { name: '@sourcefor/atlas' }, { name: '', version: '0.1.0' }, { name: '@sourcefor/atlas', version: 1 }, { name: 'x'.repeat(201), version: '0.1.0' }]) {
    assert.throws(() => parsePortableAtlas(JSON.stringify({ ...fixture(), generator })), /generator/, JSON.stringify(generator));
  }
});
