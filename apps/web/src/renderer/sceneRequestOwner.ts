/** A single latest intent owns asynchronous scene publication. Cancelling also
 * interrupts active worker CPU through the AbortSignal supplied to compilation. */
export function createSceneRequestOwner() {
  let generation = 0;
  let controller: AbortController | undefined;
  return {
    begin() {
      controller?.abort();
      controller = new AbortController();
      const current = controller;
      const token = ++generation;
      return {
        signal: current.signal,
        owns: () => token === generation && !current.signal.aborted,
      };
    },
    cancel() { generation++; controller?.abort(); controller = undefined; },
  };
}
/** LRU retention is separate from visible/morph endpoint ownership. */
export function retainNeighborhoodScene<T>(cache: Map<string, T>, key: string, value: T): void {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > 8) cache.delete(cache.keys().next().value!);
}
export function readNeighborhoodScene<T>(cache: Map<string, T>, key: string): T | undefined {
  const scene = cache.get(key);
  if (scene !== undefined) retainNeighborhoodScene(cache, key, scene);
  return scene;
}

export type SceneRequestOwnership = { fixture: unknown; scene: unknown; session: unknown; selection: unknown };
/** Camera values deliberately are not ownership: pan continues during compile. */
export function ownsScenePublication(source: SceneRequestOwnership, current: SceneRequestOwnership): boolean {
  return source.fixture === current.fixture && source.scene === current.scene
    && source.session === current.session && source.selection === current.selection;
}

export type NeighborhoodSceneCacheScope = { fixture: unknown; generation: number };
export function ownsNeighborhoodSceneCache(scope: NeighborhoodSceneCacheScope | undefined, fixture: unknown, generation: number): boolean {
  return scope !== undefined && scope.fixture === fixture && scope.generation === generation;
}
