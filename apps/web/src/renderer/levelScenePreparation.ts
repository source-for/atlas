export const LEVEL_SCENE_PREPARING = 'Preparing the next detail level…';
/** Camera gestures may move the camera, but must not supersede this selected compile. */
export function levelScenePreparationPending(current: AbortController | undefined): boolean {
  return current !== undefined && !current.signal.aborted;
}
/** An obsolete level request never clears a newer request's ownership or message. */
export function finishLevelScenePreparation(owner: { current: AbortController | undefined }, request: AbortController): boolean {
  if (owner.current !== request) return false;
  owner.current = undefined;
  return true;
}

/** Preserve camera movement while deferring every semantic scope transition. */
export function runLevelSceneGesture<T>(current: AbortController | undefined, camera: T, transition: () => T): T {
  return levelScenePreparationPending(current) ? camera : transition();
}

export function clearLevelScenePreparation(owner: { current: AbortController | undefined }, request: AbortController, updateMessage: (update: (current: string) => string) => void): void {
  if (finishLevelScenePreparation(owner, request)) updateMessage(current => current === LEVEL_SCENE_PREPARING ? 'Detail level preparation cancelled. Choose a level to try again.' : current);
}

export const LEVEL_SCENE_PREPARATION_TIMEOUT_MS = 20_000;
/** Bound the entire fetch/compile operation, including hosts without abortable fetch.
 * Late host replies remain fenced by the caller's aborted request before publication. */
export async function prepareLevelSceneWithDeadline<T>(request: AbortController, prepare: () => Promise<T>, onTimeout: () => void, timeoutMs = LEVEL_SCENE_PREPARATION_TIMEOUT_MS): Promise<T> {
  if (request.signal.aborted) throw new DOMException('Detail level preparation cancelled', 'AbortError');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new DOMException('Detail level preparation cancelled', 'AbortError'));
    if (request.signal.aborted) abort();
    else request.signal.addEventListener('abort', abort, { once: true });
    timer = setTimeout(() => {
      if (request.signal.aborted) return;
      onTimeout();
      request.abort();
    }, timeoutMs);
  });
  try {
    if (request.signal.aborted) throw new DOMException('Detail level preparation cancelled', 'AbortError');
    return await Promise.race([Promise.resolve().then(() => {
      if (request.signal.aborted) throw new DOMException('Detail level preparation cancelled', 'AbortError');
      return prepare();
    }), cancelled]);
  } finally {
    clearTimeout(timer);
    if (abort) request.signal.removeEventListener('abort', abort);
  }
}

/** Load the initial scope, recompute after merge, then load it before compiling.
 * Both compile and publication must still belong to the original request. */
export async function prepareLoadedLevelScene<T>(input: {
  signal: AbortSignal;
  initialFocus: string;
  ensure: (focus: string) => Promise<void>;
  recomputeFocus: () => string;
  owns: () => boolean;
  compile: () => Promise<T>;
  publish: (scene: T) => void;
  isPreparedCurrent?: (scene: T) => boolean;
}): Promise<void> {
  const current = () => !input.signal.aborted && input.owns();
  if (!current()) return;
  await input.ensure(input.initialFocus);
  if (!current()) return;
  await input.ensure(input.recomputeFocus());
  if (!current()) return;
  const prepared = await input.compile();
  if (!current()) return;
  if (input.isPreparedCurrent && !input.isPreparedCurrent(prepared)) throw new Error('Atlas data changed during detail preparation. Try again.');
  input.publish(prepared);
}
