/** Foreground navigation owns one preparation at a time. Real camera input
 * advances its intent epoch; renderer/flight frames never advance that epoch. */
export function createForegroundSceneRequestOwner() {
  let generation = 0;
  let cameraIntentEpoch = 0;
  let active: { generation: number; controller: AbortController } | undefined;
  const cancel = () => { generation++; active?.controller.abort(); active = undefined; };
  return {
    begin() {
      cancel();
      const request = { generation, controller: new AbortController() };
      active = request;
      const cameraEpoch = cameraIntentEpoch;
      return {
        signal: request.controller.signal,
        owns: () => active === request && generation === request.generation
          && cameraIntentEpoch === cameraEpoch && !request.controller.signal.aborted,
        finish: () => { if (active === request) active = undefined; },
      };
    },
    cameraIntent() { cameraIntentEpoch++; cancel(); },
    cancel,
    pending: () => active !== undefined,
  };
}

export function isSceneRequestAbort(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError';
}

/** Publication and errors share the same ownership fence, including late worker
 * replies. Finishing an old request must never clear a newer pending request. */
export async function completeForegroundSceneRequest<T>(
  request: { owns(): boolean; finish(): void; beginPublication?(): void },
  prepare: () => Promise<T>,
  publish: (result: T) => void,
  onFailure: (error: unknown) => void,
): Promise<void> {
  try {
    const result = await prepare();
    if (request.owns()) { request.beginPublication?.(); publish(result); }
  } catch (error) {
    if (request.owns() && !isSceneRequestAbort(error)) onFailure(error);
  } finally { request.finish(); }
}

/** Retry only graph revision churn owned by the same user intent. New gestures,
 * selections and requests never revive an obsolete request. */
export async function prepareForegroundWithRetry<T>(request: {
  current(): boolean;
  owns(): boolean;
  generationFence: { owns(): boolean; allowChanges(): void };
  beginPublication?(): void;
}, prepare: () => Promise<T>, maxAttempts = 3, publish?: (result: T) => void): Promise<T> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (!request.current()) throw new DOMException('Navigation superseded', 'AbortError');
    try {
      const result = await prepare();
      if (request.owns()) {
        if (publish) { request.beginPublication?.(); publish(result); }
        return result;
      }
      throw new DOMException('Navigation superseded', 'AbortError');
    } catch (error) {
      if (!request.current()) throw error;
      if (!request.generationFence.owns() && attempt + 1 < maxAttempts) {
        request.generationFence.allowChanges();
        continue;
      }
      // Current-intent aborts (including exhausted graph retries) need visible
      // failure; silently swallowing them would drop the requested navigation.
      if (isSceneRequestAbort(error)) throw new Error('This view changed while it was being prepared. Try again.');
      throw error;
    }
  }
  throw new Error('This view could not be prepared.');
}
/** Ensures may advance the graph before compilation. Once compilation begins,
 * the prepared result owns exactly that graph generation through publication. */
export function createSceneGenerationFence(readGeneration: () => number) {
  let captured: number | undefined;
  return {
    allowChanges: () => { captured = undefined; },
    capture: (generation: number) => { captured = generation; },
    owns: () => captured === undefined || captured === readGeneration(),
  };
}
/** Resolve only the prepared protocol's entity, never geometry from an older scene. */
export function preparedSceneEntity<T extends { id: string }>(scene: { entities: readonly T[] }, requestedId: string): T | undefined {
  return scene.entities.find(entity => entity.id === requestedId);
}
/** A planner can retain an earlier aggregate while probing newer snapshots. */
export function createPreparedSceneGenerations<T extends object>(readGeneration: () => number) {
  const generations = new WeakMap<T, number>();
  return {
    record: (scene: T) => { generations.set(scene, readGeneration()); },
    generationOf: (scene: T) => generations.get(scene),
  };
}
/** Tracks visible preparation independently of delayed React effect cleanup. */
export function createForegroundRequestStatus(onPending: (pending: boolean) => void) {
  let active: { owns(): boolean; current?(): boolean } | undefined;
  let publishing: typeof active;
  return {
    track<T extends { owns(): boolean; finish(): void; beginPublication?(): void }>(request: T) {
      active = request;
      publishing = undefined;
      onPending(true);
      return { ...request, beginPublication: () => {
        // Nested story/foreground trackers share the publication boundary.
        request.beginPublication?.();
        if (active === request) publishing = request;
      }, finish: () => {
        request.finish();
        if (active === request) { active = undefined; publishing = undefined; onPending(false); }
      } };
    },
    cancel() { active = undefined; publishing = undefined; onPending(false); },
    obsolete: () => Boolean(active && publishing !== active && !(active.current?.() ?? active.owns())),
  };
}

/** A queued old flight arrival must not write history during newer preparation. */
export function storyArrivalCanPublish(preparing: boolean, expected: object, current: object | undefined): boolean {
  return !preparing && expected === current;
}
/** Story-owned preparation and history restoration must never masquerade as
 * an external story interruption (which also writes the old URL). */
export function beginForegroundPlaybackPreparation(mode: 'navigation' | 'story' | 'restore', actions: {
  interrupt(): void;
  pauseWithoutHistory(): void;
  preserveStory(): void;
}) {
  if (mode === 'restore') actions.pauseWithoutHistory();
  else if (mode === 'story') actions.preserveStory();
  else actions.interrupt();
}
import { levelScenePreparationPending } from './levelScenePreparation';

/** Selected level preparation owns compilation while raw gesture cameras move.
 * Other navigation is superseded immediately by deliberate camera input. */
export function beginForegroundCameraIntent(level: AbortController | undefined, supersede: () => void): boolean {
  if (levelScenePreparationPending(level)) return false;
  supersede();
  return true;
}

/** Relationship editing freezes playback without becoming a camera/navigation
 * intent or writing the old story entry over an in-flight history restoration.
 */
export function beginMapInteraction(mode: 'camera' | 'semantic-edit', actions: {
  beginCameraIntent(): boolean;
  interrupt(): void;
  pauseWithoutHistory(): void;
}): boolean {
  if (mode === 'semantic-edit') { actions.pauseWithoutHistory(); return true; }
  if (!actions.beginCameraIntent()) return false;
  actions.interrupt();
  return true;
}
