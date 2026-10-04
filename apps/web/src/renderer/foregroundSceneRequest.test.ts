import { expect, it, vi } from 'vitest';
import { completeForegroundSceneRequest, createForegroundSceneRequestOwner, createSceneGenerationFence, preparedSceneEntity, createForegroundRequestStatus, prepareForegroundWithRetry, beginForegroundPlaybackPreparation, beginForegroundCameraIntent, storyArrivalCanPublish } from './foregroundSceneRequest';
import { runLevelSceneGesture, clearLevelScenePreparation } from './levelScenePreparation';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
it('moves the raw camera without cancelling pending level ownership or dispatching reverse scope work', () => {
  const foreground = createForegroundSceneRequestOwner(); const request = foreground.begin();
  const loading = vi.fn(); const status = createForegroundRequestStatus(loading); const tracked = status.track(request);
  const controller = new AbortController(); const level = { current: controller as AbortController | undefined };
  const reverse = vi.fn();
  const supersede = () => { foreground.cameraIntent(); status.cancel(); };
  for (let sample = 0; sample < 10; sample++) {
    expect(beginForegroundCameraIntent(level.current, supersede)).toBe(false);
    expect(runLevelSceneGesture(level.current, { x: sample, zoom: 1 }, reverse)).toEqual({ x: sample, zoom: 1 });
  }
  expect(reverse).not.toHaveBeenCalled(); expect(request.owns()).toBe(true);
  expect(loading.mock.calls).toEqual([[true]]);
  tracked.finish(); clearLevelScenePreparation(level, controller, vi.fn());
  expect(foreground.pending()).toBe(false); expect(level.current).toBeUndefined();
  const navigation = foreground.begin();
  expect(beginForegroundCameraIntent(level.current, supersede)).toBe(true);
  expect(navigation.signal.aborted).toBe(true);
});
it('story preparation keeps playback on the old playing step without interruption, history writes or paused announcement', () => {
  const state = { step: 2, playing: true, phase: 'hold', preparing: false };
  const interrupt = vi.fn(() => { state.playing = false; state.phase = 'paused'; });
  const pauseWithoutHistory = vi.fn();
  beginForegroundPlaybackPreparation('story', { interrupt, pauseWithoutHistory, preserveStory: () => { state.preparing = true; } });
  expect(state).toEqual({ step: 2, playing: true, phase: 'hold', preparing: true });
  expect(interrupt).not.toHaveBeenCalled(); expect(pauseWithoutHistory).not.toHaveBeenCalled();
});
it('retries unrelated graph churn, publishes exactly once, and does not treat the generation fence as obsolete intent', async () => {
  let generation = 1;
  const owner = createForegroundSceneRequestOwner(); const token = owner.begin();
  const generationFence = createSceneGenerationFence(() => generation);
  const status = createForegroundRequestStatus(vi.fn());
  const request = status.track({ ...token, current: token.owns, generationFence, owns: () => token.owns() && generationFence.owns() });
  let attempts = 0; const publish = vi.fn();
  await prepareForegroundWithRetry(request, async () => {
    generationFence.capture(generation);
    if (++attempts === 1) { generation++; expect(status.obsolete()).toBe(false); }
    return { generation };
  }, 3, publish);
  expect(attempts).toBe(2); expect(publish).toHaveBeenCalledExactlyOnceWith({ generation: 2 });
  request.finish();
});
it('bounds persistent graph churn and never retries a newer gesture or request', async () => {
  let generation = 1; const owner = createForegroundSceneRequestOwner(); const token = owner.begin();
  const generationFence = createSceneGenerationFence(() => generation);
  const request = { current: token.owns, generationFence, owns: () => token.owns() && generationFence.owns() };
  const compile = vi.fn(async () => { generationFence.capture(generation++); return 'stale'; });
  await expect(prepareForegroundWithRetry(request, compile)).rejects.toThrow('changed while');
  expect(compile).toHaveBeenCalledTimes(3);
  const interrupted = vi.fn(async () => { owner.cameraIntent(); throw new DOMException('New gesture', 'AbortError'); });
  await expect(prepareForegroundWithRetry(request, interrupted)).rejects.toMatchObject({ name: 'AbortError' });
  expect(interrupted).toHaveBeenCalledTimes(1);
});
it('releases preparation and pending cue even when synchronous publication throws', async () => {
  const owner = createForegroundSceneRequestOwner(); const status = createForegroundRequestStatus(vi.fn());
  const request = status.track(owner.begin()); const failure = vi.fn();
  await completeForegroundSceneRequest(request, async () => 'prepared', () => { throw new Error('bad commit'); }, failure);
  expect(owner.pending()).toBe(false); expect(status.obsolete()).toBe(false); expect(failure).toHaveBeenCalledOnce();
});
it('delayed scene cleanup preserves a newer owner and stale finish cannot clear its loading cue', () => {
  const pending = vi.fn();
  const status = createForegroundRequestStatus(pending);
  const owner = createForegroundSceneRequestOwner();
  let scene = 'old';
  const old = owner.begin();
  const first = status.track({ ...old, owns: () => old.owns() && scene === 'old' });
  scene = 'new'; // First publication updates the refs before React runs its effect.
  const current = owner.begin();
  const next = status.track({ ...current, owns: () => current.owns() && scene === 'new' });
  expect(status.obsolete()).toBe(false);
  first.finish();
  expect(pending.mock.calls).toEqual([[true], [true]]);
  expect(current.owns()).toBe(true);
  scene = 'unrelated';
  expect(status.obsolete()).toBe(true);
  owner.cancel(); status.cancel();
  next.finish();
  expect(pending.mock.calls).toEqual([[true], [true], [false]]);
  expect(current.signal.aborted).toBe(true);
});
it('missing Open-inside target and relationship selection stay unavailable instead of borrowing stale geometry', () => {
  const oldSelection = { id: 'selected', x: 100, revision: 1 };
  const prepared = { entities: [{ id: 'other', x: 5, revision: 2 }] };
  expect(preparedSceneEntity(prepared, 'requested')).toBeUndefined();
  expect(preparedSceneEntity(prepared, oldSelection.id)).toBeUndefined();
  expect(prepared.entities).toEqual([{ id: 'other', x: 5, revision: 2 }]);
  const retained = { ...prepared, entities: [...prepared.entities, { id: 'selected', x: 7, revision: 2 }] };
  expect(preparedSceneEntity(retained, oldSelection.id)).toEqual({ id: 'selected', x: 7, revision: 2 });
});
it('permits own ensure merges, but rejects generation changes in a cached reply publication microtask', async () => {
  let generation = 1;
  const fence = createSceneGenerationFence(() => generation);
  generation++;
  expect(fence.owns()).toBe(true);
  const owner = createForegroundSceneRequestOwner();
  const request = owner.begin();
  const publish = vi.fn();
  const pending = completeForegroundSceneRequest({ ...request, owns: () => request.owns() && fence.owns() }, async () => {
    fence.capture(generation);
    queueMicrotask(() => generation++);
    return 'cached compiled scene';
  }, publish, vi.fn());
  await pending;
  expect(publish).not.toHaveBeenCalled();
  fence.allowChanges();
  generation++;
  expect(fence.owns()).toBe(true);
  fence.capture(generation);
  expect(fence.owns()).toBe(true);
});
it('only publishes the latest preparation after rapid Open-inside/story/history requests', async () => {
  const owner = createForegroundSceneRequestOwner();
  const first = owner.begin();
  const firstReply = deferred<string>();
  const publish = vi.fn(); const failure = vi.fn();
  const old = completeForegroundSceneRequest(first, () => firstReply.promise, publish, failure);
  const second = owner.begin();
  const secondReply = deferred<string>();
  const latest = completeForegroundSceneRequest(second, () => secondReply.promise, publish, failure);
  firstReply.resolve('old scene'); await old;
  expect(first.signal.aborted).toBe(true);
  expect(owner.pending()).toBe(true);
  secondReply.resolve('latest scene'); await latest;
  expect(publish.mock.calls).toEqual([['latest scene']]);
  expect(failure).not.toHaveBeenCalled(); expect(owner.pending()).toBe(false);
});
it('camera rendering does not cancel preparation, but a real camera intent rejects stale publication', async () => {
  const owner = createForegroundSceneRequestOwner();
  const request = owner.begin(); const reply = deferred<string>();
  const publish = vi.fn(); const failure = vi.fn();
  const currentCamera = { x: 0 };
  const pending = completeForegroundSceneRequest(request, () => reply.promise, () => publish(currentCamera.x), failure);
  for (let frame = 0; frame < 60; frame++) currentCamera.x = frame;
  reply.resolve('scene'); await pending;
  expect(publish).toHaveBeenCalledWith(59);
  const moved = owner.begin(); const movedReply = deferred<string>();
  const stale = completeForegroundSceneRequest(moved, () => movedReply.promise, publish, failure);
  owner.cameraIntent(); movedReply.resolve('stale scene'); await stale;
  expect(moved.signal.aborted).toBe(true);
  expect(publish).toHaveBeenCalledTimes(1); expect(failure).not.toHaveBeenCalled();
});
it('does not publish late scenes/errors after fixture, scene or selection ownership changes', async () => {
  for (const action of ['late scene', 'late error', 'abort error']) {
    const owner = createForegroundSceneRequestOwner();
    const request = owner.begin(); const reply = deferred<string>();
    let sameSource = true;
    const publish = vi.fn(); const failure = vi.fn();
    const pending = completeForegroundSceneRequest({ ...request, owns: () => request.owns() && sameSource }, () => reply.promise, publish, failure);
    if (action === 'abort error') reply.reject(new DOMException('Snapshot changed', 'AbortError'));
    else {
      sameSource = false;
      if (action === 'late scene') reply.resolve('late'); else reply.reject(new Error('late failure'));
    }
    await pending;
    expect(publish).not.toHaveBeenCalled(); expect(failure).not.toHaveBeenCalled(); expect(owner.pending()).toBe(false);
  }
});
it('current genuine failure is reported once and releases foreground compilation ownership', async () => {
  const owner = createForegroundSceneRequestOwner(); const request = owner.begin();
  const error = new Error('unavailable map'); const failure = vi.fn();
  await completeForegroundSceneRequest(request, async () => { throw error; }, vi.fn(), failure);
  expect(failure).toHaveBeenCalledWith(error); expect(owner.pending()).toBe(false);
});

it('nested preparation trackers permit owned React-like publication mutations until final cleanup', async () => {
  const owner = createForegroundSceneRequestOwner();
  const foreground = createForegroundRequestStatus(vi.fn());
  const story = createForegroundRequestStatus(vi.fn());
  const token = owner.begin();
  let scene = 'old';
  const generationFence = createSceneGenerationFence(() => 1);
  const observations: Array<{ pending: boolean; foregroundObsolete: boolean; storyObsolete: boolean }> = [];
  const request = story.track(foreground.track({ ...token, tokenCurrent: token.owns, generationFence,
    current: () => token.owns() && scene === 'old', owns: () => token.owns() && scene === 'old' && generationFence.owns() }));
  await completeForegroundSceneRequest({ ...request, owns: request.tokenCurrent },
    () => prepareForegroundWithRetry(request, async () => 'new', 3, result => {
      scene = result;
      expect(request.current()).toBe(false); // Exact ownership fence is unchanged.
      expect(foreground.obsolete()).toBe(false);
      expect(story.obsolete()).toBe(false);
      queueMicrotask(() => observations.push({ pending: owner.pending(), foregroundObsolete: foreground.obsolete(), storyObsolete: story.obsolete() }));
    }), () => {}, error => { throw error; });
  expect(observations).toEqual([{ pending: true, foregroundObsolete: false, storyObsolete: false }]);
  expect(owner.pending()).toBe(false);
  expect(foreground.obsolete()).toBe(false); expect(story.obsolete()).toBe(false);
});

it('publication status belongs only to its token and cannot shield a newer request from invalidation', () => {
  const owner = createForegroundSceneRequestOwner(); const status = createForegroundRequestStatus(vi.fn());
  let scene = 'old';
  const token = owner.begin(); const old = status.track({ ...token, current: () => token.owns() && scene === 'old' });
  old.beginPublication();
  const nextToken = owner.begin(); const next = status.track({ ...nextToken, current: () => nextToken.owns() && scene === 'old' });
  old.beginPublication(); scene = 'new';
  expect(status.obsolete()).toBe(true);
  old.finish(); expect(nextToken.owns()).toBe(true); expect(status.obsolete()).toBe(true);
  next.finish(); expect(status.obsolete()).toBe(false);
});

it('publication callback failures retain token-owned failure reporting and release both trackers', async () => {
  const owner = createForegroundSceneRequestOwner(); const foreground = createForegroundRequestStatus(vi.fn()); const story = createForegroundRequestStatus(vi.fn());
  const token = owner.begin(); let scene = 'old';
  const request = story.track(foreground.track({ ...token, tokenCurrent: token.owns, generationFence: createSceneGenerationFence(() => 1), current: () => token.owns() && scene === 'old' }));
  const failure = vi.fn();
  await completeForegroundSceneRequest({ ...request, owns: request.tokenCurrent },
    () => prepareForegroundWithRetry(request, async () => 'prepared', 3, () => { scene = 'new'; throw new Error('bad publication'); }), () => {}, failure);
  expect(failure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'bad publication' }));
  expect(owner.pending()).toBe(false); expect(foreground.obsolete()).toBe(false); expect(story.obsolete()).toBe(false);
});

it('fences an old queued arrival during preparation or after flight replacement', () => {
  const oldFlight = {}; const newFlight = {};
  expect(storyArrivalCanPublish(true, oldFlight, oldFlight)).toBe(false);
  expect(storyArrivalCanPublish(false, oldFlight, newFlight)).toBe(false);
  expect(storyArrivalCanPublish(false, oldFlight, undefined)).toBe(false);
  expect(storyArrivalCanPublish(false, oldFlight, oldFlight)).toBe(true);
});
