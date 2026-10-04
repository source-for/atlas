import { navigationEntityReference } from './entityReferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNavigationHistoryController, type NavigationHistoryAdapter } from './historyController';
import { canonicalNavigationState, canonicalNavigationUrl, type NavigationDefaults, type NavigationState } from './navigationState';
import { beginForegroundPlaybackPreparation, createForegroundSceneRequestOwner } from '../renderer/foregroundSceneRequest';

const defaults: NavigationDefaults = {
  repositoryId: 'repo:atlas',
  snapshotId: 'snapshot:one',
  viewId: 'view:c4',
  rootEntityId: 'system:atlas',
  selectedId: 'system:atlas',
  camera: { x: 0, y: 0, zoom: 1 },
};

type FakeHistory = NavigationHistoryAdapter & {
  href: string;
  pushes: string[];
  replacements: string[];
  replacementTimes: number[];
  throwOnReplace: boolean;
  pop(url: string): void;
  hide(): void;
};

function fakeHistory(href: string): FakeHistory {
  let listener: (() => void) | undefined;
  let hideListener: (() => void) | undefined;
  return {
    href,
    pushes: [],
    replacements: [],
    replacementTimes: [],
    throwOnReplace: false,
    getHref() { return this.href; },
    pushState(_data, url) {
      this.href = url;
      this.pushes.push(url);
    },
    replaceState(_data, url) {
      if (this.throwOnReplace) throw new DOMException('Attempt to use history.replaceState() more than 100 times per 10 seconds', 'SecurityError');
      this.href = url;
      this.replacements.push(url);
      this.replacementTimes.push(Date.now());
    },
    addPopStateListener(next) {
      listener = next;
      return () => { if (listener === next) listener = undefined; };
    },
    addPageHideListener(next) {
      hideListener = next;
      return () => { if (hideListener === next) hideListener = undefined; };
    },
    now: () => Date.now(),
    pop(url) {
      this.href = url;
      listener?.();
    },
    hide() { hideListener?.(); },
  };
}

const state = (patch: Partial<NavigationState>) => canonicalNavigationState(patch, defaults);

describe('navigation history camera URL coalescing (CLA-326)', () => {
  beforeEach(() => { vi.useFakeTimers({ now: 10_000 }); });
  afterEach(() => { vi.useRealTimers(); });

  async function started() {
    const adapter = fakeHistory('https://atlas.example/map');
    const commits: number[] = [];
    const controller = createNavigationHistoryController({
      defaults,
      adapter,
      restore: vi.fn(),
      onCommit: commit => commits.push(commit.settledEpoch),
    });
    await controller.start(false);
    adapter.replacements.length = 0;
    adapter.replacementTimes.length = 0;
    return { adapter, controller, commits };
  }

  it('keeps a 10 s pinch under WebKit\'s 100-per-10 s replaceState limit and lands the settled camera', async () => {
    const { adapter, controller, commits } = await started();
    let camera = { x: 0, y: 0, zoom: 1 };
    // 60 Hz for 10 s, with the assist loop re-committing the same camera each frame.
    for (let frame = 0; frame < 600; frame += 1) {
      camera = { x: frame * 0.5, y: frame * 0.25, zoom: 1 + frame / 200 };
      controller.commitSettledCamera(camera);
      controller.replace(state({ camera }));
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(500);

    expect(commits).toHaveLength(1 + 1200); // every commit still notifies synchronously
    expect(adapter.replacements.length).toBeLessThanOrEqual(60);
    for (let index = 0; index < adapter.replacementTimes.length; index += 1) {
      const windowStart = adapter.replacementTimes[index];
      const inWindow = adapter.replacementTimes.filter(time => time >= windowStart && time < windowStart + 10_000);
      expect(inWindow.length).toBeLessThan(100);
    }
    expect(adapter.href).toBe(canonicalNavigationUrl(state({ camera }), 'https://atlas.example/map'));
    controller.dispose();
  });

  it('skips identical replacements', async () => {
    const { adapter, controller } = await started();
    const camera = { x: 5, y: 6, zoom: 1.5 };
    for (let frame = 0; frame < 20; frame += 1) controller.commitSettledCamera(camera);
    expect(adapter.replacements).toHaveLength(1);
    controller.dispose();
  });

  it('writes semantic changes immediately even inside a camera burst', async () => {
    const { adapter, controller } = await started();
    controller.commitSettledCamera({ x: 1, y: 1, zoom: 1 });
    controller.commitSettledCamera({ x: 2, y: 2, zoom: 1.1 });
    expect(adapter.replacements).toHaveLength(1);
    controller.replace(state({ selectedId: 'entity:orders', camera: { x: 3, y: 3, zoom: 1.2 } }));
    expect(adapter.replacements).toHaveLength(2);
    expect(adapter.href).toContain('sel=entity%3Aorders');
    vi.advanceTimersByTime(500);
    expect(adapter.replacements).toHaveLength(2); // the superseded camera write was dropped
    controller.dispose();
  });

  it('lands a pending camera URL on the current entry before a push', async () => {
    const { adapter, controller } = await started();
    controller.commitSettledCamera({ x: 1, y: 1, zoom: 1 });
    controller.commitSettledCamera({ x: 9, y: 9, zoom: 2 });
    controller.push(state({ selectedId: 'entity:payments' }));
    expect(adapter.replacements.at(-1)).toContain('cx=9');
    expect(adapter.pushes).toHaveLength(1);
    vi.advanceTimersByTime(500);
    expect(adapter.href).toBe(adapter.pushes[0]);
    controller.dispose();
  });

  it('drops a pending camera URL when the user navigates Back', async () => {
    const { adapter, controller } = await started();
    controller.commitSettledCamera({ x: 1, y: 1, zoom: 1 });
    controller.commitSettledCamera({ x: 9, y: 9, zoom: 2 });
    const previous = canonicalNavigationUrl(state({ selectedId: 'entity:orders' }), adapter.href);
    adapter.pop(previous);
    vi.advanceTimersByTime(500);
    await Promise.resolve();
    expect(adapter.replacements.some(url => url.includes('cx=9'))).toBe(false);
    controller.dispose();
  });

  it('flush() and flushUrl() write the current camera immediately (Copy link reads location.href next)', async () => {
    const { adapter, controller } = await started();
    controller.commitSettledCamera({ x: 1, y: 1, zoom: 1 });
    controller.commitSettledCamera({ x: 7, y: 7, zoom: 1.4 });
    expect(adapter.href).not.toContain('cx=7');
    controller.flushUrl();
    expect(adapter.href).toContain('cx=7');
    controller.commitSettledCamera({ x: 8, y: 8, zoom: 1.5 });
    controller.flush(state({ camera: { x: 9, y: 9, zoom: 1.6 } }));
    expect(adapter.href).toContain('cx=9');
    controller.dispose();
  });

  it('lands a deferred camera URL on dispose and on pagehide', async () => {
    const first = await started();
    first.controller.commitSettledCamera({ x: 1, y: 1, zoom: 1 });
    first.controller.commitSettledCamera({ x: 7, y: 7, zoom: 1.4 });
    first.controller.dispose();
    expect(first.adapter.href).toContain('cx=7');

    const second = await started();
    second.controller.commitSettledCamera({ x: 1, y: 1, zoom: 1 });
    second.controller.commitSettledCamera({ x: 6, y: 6, zoom: 1.3 });
    second.adapter.hide();
    expect(second.adapter.href).toContain('cx=6');
    second.controller.dispose();
  });

  it('stays under 100 writes per 30 s (older Safari) through a minute of continuous camera motion', async () => {
    const { adapter, controller } = await started();
    for (let frame = 0; frame < 60 * 60; frame += 1) {
      controller.commitSettledCamera({ x: frame, y: frame / 2, zoom: 1 + (frame % 300) / 300 });
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(31_000);
    for (let index = 0; index < adapter.replacementTimes.length; index += 1) {
      const windowStart = adapter.replacementTimes[index];
      expect(adapter.replacementTimes.filter(time => time >= windowStart && time < windowStart + 30_000).length).toBeLessThan(100);
    }
    expect(adapter.href).toContain(`cx=${60 * 60 - 1}`);
    controller.dispose();
  });

  it('keeps committing when the browser rate-limits replaceState, and retries the URL', async () => {
    const { adapter, controller, commits } = await started();
    adapter.throwOnReplace = true;
    expect(() => controller.replace(state({ selectedId: 'entity:orders' }))).not.toThrow();
    expect(commits.at(-1)).toBe(2);
    expect(controller.current().selectedId).toBe('entity:orders');
    adapter.throwOnReplace = false;
    vi.advanceTimersByTime(1_500);
    expect(adapter.href).toContain('sel=entity%3Aorders');
    controller.dispose();
  });
});

it('cancelRestore prevents a late async restore from replacing the URL or committing state', async () => {
  const adapter = fakeHistory('https://atlas.example/map?root=container%3Aapi&cx=200&cy=300&z=2');
  let finish!: () => void;
  const pending = new Promise<void>(resolve => { finish = resolve; });
  const controller = createNavigationHistoryController({ defaults, adapter, restore: () => pending });
  const startup = controller.start();
  controller.cancelRestore();
  finish(); await startup;
  expect(adapter.replacements).toHaveLength(0);
  expect(controller.current().rootEntityId).toBe(defaults.rootEntityId);
  expect(adapter.href).toContain('root=container%3Aapi');
  controller.dispose();
});
it('history restore pauses an active story without writing the old entry and commits corrected applied state', async () => {
  const adapter = fakeHistory('https://atlas.example/map?root=container%3Aapi&sel=component%3Afile&lens=system%3Aatlas&lens=missing');
  const commits = vi.fn(); let playing = true;
  const controller = createNavigationHistoryController({ defaults, adapter, onCommit: commits,
    restore: async next => {
      beginForegroundPlaybackPreparation('restore', {
        interrupt: () => controller.replace(state({})),
        pauseWithoutHistory: () => { playing = false; }, preserveStory: () => {},
      });
      expect(adapter.replacements).toHaveLength(0);
      await Promise.resolve();
      return { ...next, lensPath: ['system:atlas'] };
    },
  });
  await controller.start();
  expect(playing).toBe(false);
  expect(controller.current().rootEntityId).toBe('container:api');
  expect(controller.current().lensPath).toEqual(['system:atlas']);
  expect(adapter.href).not.toContain('missing'); expect(commits).toHaveBeenCalledOnce();
  controller.dispose();
});
it('cancels an unapplied restore by token while an older restore cannot cancel a newer popstate', async () => {
  const adapter = fakeHistory('https://atlas.example/map?root=container%3Afirst');
  const owner = createForegroundSceneRequestOwner();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  const controller = createNavigationHistoryController({ defaults, adapter, restore: async () => {
    const request = owner.begin();
    await blocked;
    if (request.owns()) controller.cancelRestore(); // Current token, even when full scene ownership was lost.
    request.finish();
  } });
  const first = controller.start();
  adapter.pop('https://atlas.example/map?root=container%3Asecond');
  release(); await first; await Promise.resolve();
  expect(controller.current().rootEntityId).toBe(defaults.rootEntityId);
  expect(adapter.replacements).toHaveLength(0);
  controller.dispose();
});
it('an obsolete restore never cancels the newer popstate that has already published', async () => {
  const adapter = fakeHistory('https://atlas.example/map?root=container%3Afirst');
  const owner = createForegroundSceneRequestOwner();
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  let calls = 0;
  const controller = createNavigationHistoryController({ defaults, adapter, restore: async next => {
    const token = owner.begin();
    if (++calls === 1) {
      await blocked;
      if (token.owns()) controller.cancelRestore();
    }
    token.finish();
    return next;
  } });
  const first = controller.start();
  adapter.pop('https://atlas.example/map?root=container%3Asecond');
  await Promise.resolve(); await Promise.resolve();
  expect(controller.current().rootEntityId).toBe('container:second');
  release(); await first;
  expect(controller.current().rootEntityId).toBe('container:second');
  expect(adapter.replacements).toHaveLength(1);
  controller.dispose();
});

it('Back restores canonical published selection outside initial residency and sees later snapshot merges', async () => {
  const root = 'system:atlas'; const component = 'component:apps-web-src-app-tsx';
  const published = { entities: [{ id: root }, { id: component }] };
  const hasEntity = navigationEntityReference({ rendered: { entities: [{ id: root }] }, published });
  const adapter = fakeHistory('https://atlas.example/map?root=system%3Aatlas');
  const restored: string[] = [];
  const controller = createNavigationHistoryController({ defaults, adapter, urlOptions: { references: { hasEntity } },
    restore: async next => { restored.push(next.selectedId); await Promise.resolve(); },
  });
  await controller.start();
  adapter.pop(`https://atlas.example/map?root=${root}&sel=${component}&lens=${root}&lens=${component}`);
  await Promise.resolve(); await Promise.resolve();
  expect(restored.at(-1)).toBe(component);
  expect(controller.current().selectedId).toBe(component);
  expect(new URL(adapter.href).searchParams.get('sel')).toBe(component);
  const merged = 'component:lazy-child'; published.entities.push({ id: merged });
  adapter.pop(`https://atlas.example/map?root=${root}&sel=${merged}`);
  await Promise.resolve(); await Promise.resolve();
  expect(controller.current().selectedId).toBe(merged);
  expect(new URL(adapter.href).searchParams.get('sel')).toBe(merged);
  controller.dispose();
});
