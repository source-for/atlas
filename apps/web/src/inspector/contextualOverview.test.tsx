import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { goldenSnapshot } from '@okie/scene-compiler';
import { buildContextualOverview, contextualOverviewEntityId } from './contextualOverview';
import { ContextualOverviewView, overviewScrollHost, resetOverviewScroll } from './ContextualOverviewView';

describe('contextual overview contract', () => {
  it('uses accepted local responsibility and immediate parent, deduplicating identical links', () => {
    const snapshot = { ...goldenSnapshot, entities: [
      { id: 'root', kind: 'softwareSystem' as const, name: 'System', responsibility: 'System summary', sourceRefs: [] },
      { id: 'child', kind: 'component' as const, name: 'Child', parentId: 'root', responsibility: 'No summary supplied.', sourceRefs: [] },
      { id: 'dep', kind: 'component' as const, name: 'Dependency', sourceRefs: [] },
    ], relations: [1, 2].map(id => ({ id: String(id), from: 'child', to: 'dep', kind: 'uses' as const, evidence: [] })) };
    const overview = buildContextualOverview(snapshot, 'child')!;
    expect(overview.parent?.id).toBe('root');
    expect(overview.entity.summary).toBeUndefined();
    expect(overview.dependencies).toHaveLength(1);
    const markup = renderToStaticMarkup(<ContextualOverviewView overview={overview} onOpenEntity={() => undefined}/>);
    expect(markup).not.toContain('System summary');
    expect(markup).not.toContain('No summary supplied.');
  });
  it.each([0, 5, 6])('bounds each sidebar group with a truthful total for %i items', count => {
    const items = Array.from({ length: count }, (_, i) => ({ id: `child-${i}`, name: `Child ${i}`, relationship: 'uses' }));
    const markup = renderToStaticMarkup(<ContextualOverviewView overview={{ entity: { id: 'root', name: 'Root', kind: 'system' }, dependencies: items, dependents: [], children: [] }} onOpenEntity={() => undefined}/>);
    expect((markup.match(/<span>Child /g) ?? []).length).toBe(Math.min(count, 5));
    expect(markup.includes(`Show all ${count}`)).toBe(count > 5);
    if (count) expect(markup).toContain(`detail-count">${count}</span>`);
    else { expect(markup).not.toContain('No relationships captured.'); expect(markup).not.toContain('Direct dependencies'); }
  });
});

it('presents authored multi-file membership with declarations and preserves file fallback honesty', () => {
  const snapshot = { ...goldenSnapshot, relations: [], entities: [
    { id: 'container:app', kind: 'container' as const, name: 'App', sourceRefs: [] },
    { id: 'component:core', kind: 'component' as const, parentId: 'container:app', name: 'Core', responsibility: 'Owns navigation.', tags: ['okie:component-mapping'], sourceRefs: [{ path: 'src/a.ts', commitSha: 'sha' }, { path: 'src/b.ts', commitSha: 'sha' }] },
    { id: 'code:a', kind: 'code' as const, parentId: 'component:core', name: 'navigate', sourceRefs: [{ path: 'src/a.ts', commitSha: 'sha', startLine: 4 }] },
    { id: 'code:b', kind: 'code' as const, parentId: 'component:core', name: 'restore', sourceRefs: [{ path: 'src/b.ts', commitSha: 'sha', startLine: 8 }] },
    { id: 'component:file', kind: 'component' as const, parentId: 'container:app', name: 'src/c.ts', sourceRefs: [{ path: 'src/c.ts', commitSha: 'sha' }] },
  ] };
  const overview = buildContextualOverview(snapshot, 'component:core')!;
  expect(overview.componentBasis).toBe('authored');
  expect(overview.implementationFiles?.map(file => [file.path, file.code.map(code => code.id)])).toEqual([
    ['src/a.ts', ['code:a']], ['src/b.ts', ['code:b']],
  ]);
  const markup = renderToStaticMarkup(<ContextualOverviewView overview={overview} onOpenEntity={() => undefined}/>);
  expect(markup).toContain('Owns navigation.');
  expect(markup).toContain('Authored component');
  expect(markup).toContain('Implementing files');
  expect(markup).toContain('navigate');
  expect(buildContextualOverview(snapshot, 'component:file')?.componentBasis).toBe('file');
  expect(buildContextualOverview(snapshot, 'container:app')?.implementationFiles).toBeUndefined();
});

// CLA-149: software systems render through the block Overview, components through the classic one — both must lead with the explanation.
describe.each([
  { kind: 'softwareSystem', chip: 'Software system', childrenHeading: 'Children', blocks: true },
  { kind: 'component', chip: 'Component', childrenHeading: 'Implementing code', blocks: false },
])('overview leads with an accepted explanation (CLA-260) — $kind', ({ kind, chip, childrenHeading, blocks }) => {
  const overview = { entity: { id: 'system:okie', name: 'okie', kind, summary: 'Local responsibility.' }, dependencies: [], dependents: [], children: [{ id: 'container:web', name: 'Web', relationship: 'container' }] };
  const scope = { scopeId: 'system:okie', entityId: 'system:okie', name: 'okie', state: 'accepted' as const, stale: true, explanation: { format: 'v3' as const, summary: 'Maps a repository as an **atlas**.', keyPoints: ['Start at `App.tsx`.'], evidence: [{ entityId: 'container:web', path: 'apps/web/src/App.tsx', startLine: 1, endLine: 9 }] } };
  it('shows name, kind chip, explanation and evidence, without boilerplate', () => {
    const markup = renderToStaticMarkup(<ContextualOverviewView entityName={id => id === 'container:web' ? 'Web' : undefined} explanation={scope} onOpenEntity={() => undefined} onOpenEvidence={() => undefined} overview={overview}/>);
    expect(markup).toContain('<h3 class="overview-title">okie</h3>');
    expect(markup).toContain(`<span class="overview-chip">${chip}</span>`);
    expect(markup.includes('data-overview-blocks="v1"')).toBe(blocks);
    expect(markup).toContain('>Stale</span>');
    expect(markup).toContain('<strong>atlas</strong>');
    expect(markup).toContain('<code>apps/web/src/App.tsx:1–9</code>');
    expect(markup.indexOf(childrenHeading)).toBeGreaterThan(0);
    expect(markup.indexOf('explanation-view')).toBeLessThan(markup.indexOf(childrenHeading));
    expect(markup).not.toMatch(/Accepted operator explanation|No relationships captured|Local responsibility/iu);
    // The raw kind never leaks (case-insensitively, unless the human chip itself spells it, as "Component" does).
    expect(markup).not.toMatch(new RegExp(`${kind}|is a ${kind}`, chip.toLowerCase().includes(kind.toLowerCase()) ? 'u' : 'iu'));
  });
  it('falls back to the captured summary, then a quiet placeholder', () => {
    expect(renderToStaticMarkup(<ContextualOverviewView onOpenEntity={() => undefined} overview={overview}/>)).toContain('<p class="overview-description">Local responsibility.</p>');
    const bare = renderToStaticMarkup(<ContextualOverviewView onOpenEntity={() => undefined} overview={{ ...overview, entity: { id: 'system:okie', name: 'okie', kind } }}/>);
    expect(bare).toContain('No description has been captured yet.');
    expect(bare).not.toContain(`is a ${kind}`);
  });
  it('ignores an explanation with no summary, key points or evidence', () => {
    const empty = { ...scope, explanation: { format: 'v3' as const, summary: ' ', keyPoints: [], evidence: [] } };
    const markup = renderToStaticMarkup(<ContextualOverviewView explanation={empty} onOpenEntity={() => undefined} overview={overview}/>);
    expect(markup).toContain('<p class="overview-description">Local responsibility.</p>');
    expect(markup).not.toMatch(/explanation-view|>Stale</u);
  });
  it('renders legacy explanations without interactions', () => {
    const legacyScope = { ...scope, stale: false, explanation: { summary: 'Legacy text.', interactions: ['Calls the database'], roleWithinParent: 'Gateway', evidence: [] } };
    const markup = renderToStaticMarkup(<ContextualOverviewView explanation={legacyScope} onOpenEntity={() => undefined} overview={overview}/>);
    expect(markup).toContain('Legacy text.');
    expect(markup).not.toMatch(/Calls the database|Important interactions|Gateway|>Stale</u);
  });
  it("never shows another entity's explanation under this entity", () => {
    const other = { ...scope, scopeId: 'container:web', entityId: 'container:web' };
    const markup = renderToStaticMarkup(<ContextualOverviewView explanation={other} onOpenEntity={() => undefined} overview={overview}/>);
    expect(markup).toContain('<p class="overview-description">Local responsibility.</p>');
    expect(markup).not.toMatch(/atlas|explanation-view|>Stale</u);
    const draftScope = { ...scope, entityId: undefined };
    expect(renderToStaticMarkup(<ContextualOverviewView explanation={draftScope} onOpenEntity={() => undefined} overview={overview}/>)).toContain('<strong>atlas</strong>');
  });
});

describe('overview scroll reset on entity change', () => {
  it('resets only the enclosing inspector scroll container', () => {
    const host = { scrollTop: 400 };
    const selectors: string[] = [];
    resetOverviewScroll({ closest: selector => { selectors.push(selector); return host; } });
    expect(host.scrollTop).toBe(0);
    expect(selectors).toEqual(['.details-scroll']);
  });
  it('is a no-op outside the inspector (operator page, tests, unmounted)', () => {
    expect(overviewScrollHost({ closest: () => null })).toBeUndefined();
    expect(overviewScrollHost(null)).toBeUndefined();
    expect(() => resetOverviewScroll(undefined)).not.toThrow();
  });
});

function storyOverviewSnapshot() {
  return { ...goldenSnapshot, entities: [
    { id: 'system:okie', kind: 'softwareSystem' as const, name: 'okie', sourceRefs: [] },
    { id: 'container:apps-web', parentId: 'system:okie', kind: 'container' as const, name: '@okie/web', responsibility: 'Renders the architecture atlas.', sourceRefs: [] },
    { id: 'component:app', parentId: 'container:apps-web', kind: 'component' as const, name: 'App', sourceRefs: [] },
  ], relations: [] };
}

it.each([0, 2])('uses the logical story selection for overview at step %i when rendered lens remains on system root', storyStep => {
  const snapshot = storyOverviewSnapshot();
  const id = contextualOverviewEntityId({ selectedId: 'container:apps-web', storyStep, explicitSelection: false, lensEntityId: 'system:okie', rootEntityId: 'system:okie' });
  const overview = buildContextualOverview(snapshot, id)!;
  expect(overview.entity).toMatchObject({ id: 'container:apps-web', name: '@okie/web', kind: 'container', summary: 'Renders the architecture atlas.' });
  expect(overview.children.map(child => child.id)).toEqual(['component:app']);
  const markup = renderToStaticMarkup(<ContextualOverviewView overview={overview} onOpenEntity={() => undefined}/>);
  expect(markup).toContain('@okie/web');
  expect(markup).toContain('Renders the architecture atlas.');
});

it('preserves idle contextual lens/root flow and explicit selection, including an interrupted story selection', () => {
  const snapshot = storyOverviewSnapshot();
  const input = { selectedId: 'component:app', storyStep: -1, explicitSelection: false, lensEntityId: 'container:apps-web', rootEntityId: 'system:okie' };
  expect(buildContextualOverview(snapshot, contextualOverviewEntityId(input))?.entity.id).toBe('container:apps-web');
  expect(buildContextualOverview(snapshot, contextualOverviewEntityId({ ...input, lensEntityId: undefined }))?.entity.id).toBe('system:okie');
  expect(buildContextualOverview(snapshot, contextualOverviewEntityId({ ...input, explicitSelection: true }))?.entity.id).toBe('component:app');
  expect(buildContextualOverview(snapshot, contextualOverviewEntityId({ ...input, storyStep: 2 }))?.entity.id).toBe('component:app');
});
