// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SceneSourceExcerpt } from '../renderer/types';
import { useInspectorSourceExcerpt, type InspectorSourceExcerptStatus } from './inspectorSourceExcerpt';
import { createPendingInspectorChildSlot, inspectorLevelLabel, pendingInspectorChild, visiblePendingInspectorChild, type PendingInspectorChild } from './pendingInspectorChild';

const excerpt = (symbol: string): SceneSourceExcerpt => ({ path: `src/${symbol}.ts`, symbol, language: 'typescript', startLine: 1, endLine: 1, highlightLine: 1, frozenRevision: 'r', text: `export const ${symbol} = 1;`, lines: [`export const ${symbol} = 1;`] });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

describe('pending inspector child slot', () => {
  const child = (id: string): PendingInspectorChild => ({ id, name: id, levelLabel: 'L3 · COMPONENT', fromSelectionId: 'container:web' });

  it('lets the last open win: settling a superseded open neither clears nor repaints the newer one', () => {
    const published: Array<string | undefined> = [];
    const slot = createPendingInspectorChildSlot(pending => published.push(pending?.id));
    const first = slot.show(child('component:a'));
    const second = slot.show(child('component:b'));
    first.settle();
    expect(published).toEqual(['component:a', 'component:b']);
    second.settle();
    expect(published).toEqual(['component:a', 'component:b', undefined]);
    second.settle();
    slot.clear();
    expect(published).toHaveLength(3);
  });

  it('clears for a cancelled navigation, after which the late settle is a no-op', () => {
    const published: Array<string | undefined> = [];
    const slot = createPendingInspectorChildSlot(pending => published.push(pending?.id));
    const open = slot.show(child('component:a'));
    slot.clear();
    open.settle();
    expect(published).toEqual(['component:a', undefined]);
  });

  it('draws only while the reader is still on the selection the open started from', () => {
    const pending = child('component:a');
    expect(visiblePendingInspectorChild(pending, 'container:web', false)).toBe(pending);
    expect(visiblePendingInspectorChild(pending, 'component:a', false)).toBeUndefined();
    expect(visiblePendingInspectorChild(pending, 'container:other', false)).toBeUndefined();
    expect(visiblePendingInspectorChild(pending, 'container:web', true)).toBeUndefined();
    expect(visiblePendingInspectorChild(undefined, 'container:web', false)).toBeUndefined();
  });

  it('labels scene and snapshot entities the way the loaded inspector kicker does', () => {
    expect(inspectorLevelLabel({ id: 'a', name: 'A', kind: 'component' })).toBe('L3 · COMPONENT');
    expect(inspectorLevelLabel({ id: 'a', name: 'A', kind: 'dataStore' })).toBe('L2 · CONTAINER');
    expect(inspectorLevelLabel({ id: 'a', name: 'A', kind: 'component', detail: 'component', kindLabel: 'Library' })).toBe('L3 · LIBRARY');
    expect(pendingInspectorChild({ id: 'a', name: 'A', kind: 'container' }, 'system:s')).toEqual({ id: 'a', name: 'A', levelLabel: 'L2 · CONTAINER', fromSelectionId: 'system:s' });
  });
});

describe('Source tab excerpt request', () => {
  afterEach(() => { vi.unstubAllGlobals(); });

  function harness() {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const requests = new Map<string, ReturnType<typeof deferred<readonly SceneSourceExcerpt[] | undefined>>>();
    const attached: string[] = [];
    const statuses: InspectorSourceExcerptStatus[] = [];
    const attachedExcerpts = new Set<string>();
    function Probe({ entityId }: { entityId: string }) {
      statuses.push(useInspectorSourceExcerpt({
        entityId, wanted: true, hasExcerpts: attachedExcerpts.has(entityId), blocked: false,
        load: id => { const request = deferred<readonly SceneSourceExcerpt[] | undefined>(); requests.set(id, request); return request.promise; },
        attach: id => { attached.push(id); attachedExcerpts.add(id); },
        onFailure: () => {},
      }));
      return null;
    }
    const root = createRoot(document.createElement('div'));
    return { requests, attached, statuses, render: (entityId: string) => act(async () => root.render(<Probe entityId={entityId}/>)), unmount: () => act(async () => root.unmount()) };
  }

  it('is loading from the first render, and drops a response for an entity no longer selected', async () => {
    const probe = harness();
    await probe.render('code:a');
    expect(probe.statuses[0]).toBe('loading');
    await probe.render('code:b');
    await act(async () => probe.requests.get('code:a')!.resolve([excerpt('a')]));
    expect(probe.attached).toEqual([]);
    expect(probe.statuses.at(-1)).toBe('loading');
    await act(async () => probe.requests.get('code:b')!.resolve([]));
    expect(probe.statuses.at(-1)).toBe('unavailable');
    // Back to a: its own request again, not b's settled outcome.
    await probe.render('code:a');
    expect(probe.statuses.at(-1)).toBe('loading');
    await act(async () => probe.requests.get('code:a')!.resolve([excerpt('a')]));
    expect(probe.attached).toEqual(['code:a']);
    await probe.unmount();
  });
});
