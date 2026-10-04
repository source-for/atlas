/** A replaced module or discarded document must not publish a late bootstrap. */
export function createStartupLifetime(target: Pick<Window, 'addEventListener' | 'removeEventListener'>) {
  const controller = new AbortController();
  const owned = new Set<() => void>();
  controller.signal.addEventListener('abort', () => {
    for (const dispose of owned) { owned.delete(dispose); dispose(); }
  }, { once: true });
  const pagehide = (event: PageTransitionEvent) => {
    // A bfcache document can resume the same startup on Back/Forward.
    if (!event.persisted) controller.abort();
  };
  target.addEventListener('pagehide', pagehide as EventListener);
  return {
    signal: controller.signal,
    own(dispose: () => void) {
      if (controller.signal.aborted) { dispose(); throw controller.signal.reason; }
      owned.add(dispose);
    },
    assertCurrent() { if (controller.signal.aborted) throw controller.signal.reason; },
    dispose() {
      target.removeEventListener('pagehide', pagehide as EventListener);
      controller.abort();
    },
  };
}
