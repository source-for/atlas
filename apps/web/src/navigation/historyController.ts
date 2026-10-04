import type { Camera } from '../renderer/types';
import {
  canonicalNavigationState,
  canonicalNavigationUrl,
  navigationStateFromUrl,
  type NavigationDefaults,
  type NavigationState,
  type NavigationUrlOptions,
} from './navigationState';

export type NavigationHistoryAdapter = {
  getHref(): string;
  pushState(data: unknown, url: string): void;
  replaceState(data: unknown, url: string): void;
  addPopStateListener(listener: () => void): () => void;
  /** Optional: lets a deferred camera URL land before the page is hidden/unloaded. */
  addPageHideListener?(listener: () => void): () => void;
  now(): number;
};

export type NavigationCommit = {
  state: NavigationState;
  canonicalUrl: string;
  settledEpoch: number;
  source: 'initialize' | 'push' | 'replace' | 'camera' | 'popstate';
};

export type NavigationHistoryController = {
  start(restoreInitial?: boolean): Promise<NavigationState>;
  current(): NavigationState;
  push(state: NavigationState): void;
  replace(state: NavigationState): void;
  commitSettledCamera(camera: Camera, baseState?: NavigationState): void;
  flush(state: NavigationState): void;
  /** Writes any deferred camera URL now (e.g. before reading location.href to share it). */
  flushUrl(): void;
  /** Cancel a pending async restore without changing the current URL/state. */
  cancelRestore(): void;
  dispose(): void;
};

export type NavigationHistoryOptions = {
  defaults: NavigationDefaults;
  adapter?: NavigationHistoryAdapter;
  urlOptions?: NavigationUrlOptions;
  restore(state: NavigationState, source: 'initialize' | 'popstate'): NavigationState | void | Promise<NavigationState | void>;
  onCommit?(commit: NavigationCommit): void;
  cameraCoalesceMs?: number;
  /** Minimum spacing of camera-only URL replacements (default 200 ms); see `write`. */
  cameraUrlMinIntervalMs?: number;
};

/**
 * WebKit throws a SecurityError past 100 pushState/replaceState calls per window
 * (10 s today, 30 s in older Safari). Camera-only writes stay under this rolling budget.
 */
const URL_WRITE_BUDGET = 80;
const URL_WRITE_WINDOW_MS = 30_000;
const URL_WRITE_RETRY_MS = 1_000;

const CAMERA_URL_PARAMS = ['cx', 'cy', 'z'] as const;

/** True when two URLs differ at most in the camera query parameters. */
function differsOnlyInCamera(next: string, current: string) {
  try {
    const b = new URL(current);
    const a = new URL(next, b);
    for (const key of CAMERA_URL_PARAMS) {
      a.searchParams.delete(key);
      b.searchParams.delete(key);
    }
    return a.href === b.href;
  } catch {
    return false;
  }
}

function browserAdapter(): NavigationHistoryAdapter {
  return {
    getHref: () => window.location.href,
    pushState: (data, url) => window.history.pushState(data, '', url),
    replaceState: (data, url) => window.history.replaceState(data, '', url),
    addPopStateListener(listener) {
      window.addEventListener('popstate', listener);
      return () => window.removeEventListener('popstate', listener);
    },
    addPageHideListener(listener) {
      window.addEventListener('pagehide', listener);
      return () => window.removeEventListener('pagehide', listener);
    },
    now: () => performance.now(),
  };
}

export function createNavigationHistoryController(options: NavigationHistoryOptions): NavigationHistoryController {
  const adapter = options.adapter ?? browserAdapter();
  void options.cameraCoalesceMs;
  let state = canonicalNavigationState({}, options.defaults);
  let settledEpoch = 0;
  let restoreGeneration = 0;
  let detach = () => {};
  const cameraUrlMinIntervalMs = options.cameraUrlMinIntervalMs ?? 200;
  let lastReplaceAtMs = Number.NEGATIVE_INFINITY;
  const writeTimesMs: number[] = [];
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;
  /** The state whose URL is deferred (snapshot: a push moves `state` on before landing it). */
  let pendingState: NavigationState | undefined;

  const recordWrite = () => {
    const now = adapter.now();
    writeTimesMs.push(now);
    while (writeTimesMs.length && writeTimesMs[0] <= now - URL_WRITE_WINDOW_MS) writeTimesMs.shift();
  };
  /** Earliest time a camera-only replacement may be written (≤ now means immediately). */
  const cameraWriteSlotMs = () => {
    const now = adapter.now();
    while (writeTimesMs.length && writeTimesMs[0] <= now - URL_WRITE_WINDOW_MS) writeTimesMs.shift();
    const spaced = lastReplaceAtMs + cameraUrlMinIntervalMs;
    const budgeted = writeTimesMs.length >= URL_WRITE_BUDGET
      ? writeTimesMs[writeTimesMs.length - URL_WRITE_BUDGET] + URL_WRITE_WINDOW_MS
      : Number.NEGATIVE_INFINITY;
    return Math.max(spaced, budgeted);
  };
  const cancelPendingReplace = () => {
    if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    pendingTimer = undefined;
    pendingState = undefined;
  };
  const schedulePendingReplace = (delayMs: number) => {
    pendingState = state;
    if (pendingTimer !== undefined) return;
    pendingTimer = setTimeout(flushPendingReplace, Math.max(0, delayMs));
  };
  const replaceNow = (url: string) => {
    cancelPendingReplace();
    lastReplaceAtMs = adapter.now();
    recordWrite();
    try {
      adapter.replaceState(historyData(), url);
    } catch {
      // A browser rate limit (SecurityError) must not drop the commit: keep the
      // URL pending and retry; the in-memory state is already authoritative.
      schedulePendingReplace(URL_WRITE_RETRY_MS);
    }
  };
  /** The pending write is recomputed from the latest state and href, never replayed verbatim. */
  function flushPendingReplace() {
    const pending = pendingState;
    if (pendingTimer === undefined || !pending) return;
    cancelPendingReplace();
    const href = adapter.getHref();
    const url = canonicalNavigationUrl(pending, href, options.urlOptions);
    if (new URL(url, href).href !== new URL(href).href) replaceNow(url);
  }

  const notify = (source: NavigationCommit['source'], canonicalUrl: string) => {
    settledEpoch += 1;
    options.onCommit?.({ state, canonicalUrl, settledEpoch, source });
  };

  const historyData = () => ({ atlasNavigationVersion: state.version });

  const write = (mode: 'push' | 'replace', source: NavigationCommit['source'], immediate = false) => {
    restoreGeneration += 1;
    const canonicalUrl = canonicalNavigationUrl(state, adapter.getHref(), options.urlOptions);
    if (mode === 'push') {
      // A pending camera replacement belongs to the entry being left; land it first
      // so Back returns to the latest camera.
      flushPendingReplace();
      recordWrite();
      try {
        adapter.pushState(historyData(), canonicalUrl);
      } catch {
        // Rate-limited: at least keep the address bar on the current view.
        schedulePendingReplace(URL_WRITE_RETRY_MS);
      }
    } else {
      // CLA-326: wheel/pinch/assist frames commit on every frame. The URL is a side
      // effect: skip identical writes, and space camera-only changes so a long
      // gesture stays under WebKit's replaceState limit (100 per 10 s, which throws
      // a SecurityError). Commits/epochs stay synchronous; any semantic change
      // writes immediately; the trailing write lands the settled camera.
      const href = adapter.getHref();
      const cameraOnly = !immediate && differsOnlyInCamera(canonicalUrl, href);
      const slotMs = cameraWriteSlotMs();
      if (new URL(canonicalUrl, href).href === new URL(href).href) cancelPendingReplace();
      else if (cameraOnly && slotMs > adapter.now()) schedulePendingReplace(slotMs - adapter.now());
      else replaceNow(canonicalUrl);
    }
    notify(source, canonicalUrl);
  };

  const restoreFromLocation = async (source: 'initialize' | 'popstate') => {
    const generation = ++restoreGeneration;
    // The pending camera URL belonged to the entry the user just left.
    cancelPendingReplace();
    const decoded = navigationStateFromUrl(adapter.getHref(), options.defaults, options.urlOptions);
    const restored = await options.restore(decoded.state, source);
    if (generation !== restoreGeneration) return state;
    state = restored ?? decoded.state;
    const canonicalUrl = canonicalNavigationUrl(state, adapter.getHref(), options.urlOptions);
    adapter.replaceState(historyData(), canonicalUrl);
    notify(source, canonicalUrl);
    return state;
  };

  return {
    async start(restoreInitial = true) {
      detach();
      const detachPopState = adapter.addPopStateListener(() => { void restoreFromLocation('popstate'); });
      const detachPageHide = adapter.addPageHideListener?.(flushPendingReplace) ?? (() => {});
      detach = () => {
        detachPopState();
        detachPageHide();
      };
      if (restoreInitial) return restoreFromLocation('initialize');
      const decoded = navigationStateFromUrl(adapter.getHref(), options.defaults, options.urlOptions);
      state = decoded.state;
      adapter.replaceState(historyData(), decoded.canonicalUrl);
      notify('initialize', decoded.canonicalUrl);
      return state;
    },
    current: () => state,
    cancelRestore() { restoreGeneration += 1; },
    push(next) {
      state = canonicalNavigationState(next, options.defaults);
      write('push', 'push');
    },
    replace(next) {
      state = canonicalNavigationState(next, options.defaults);
      write('replace', 'replace');
    },
    commitSettledCamera(camera, baseState = state) {
      state = canonicalNavigationState({ ...baseState, camera }, options.defaults);
      write('replace', 'camera');
    },
    flush(next) {
      state = canonicalNavigationState(next, options.defaults);
      write('replace', 'replace', true);
    },
    flushUrl() {
      flushPendingReplace();
    },
    dispose() {
      flushPendingReplace();
      restoreGeneration += 1;
      detach();
      detach = () => {};
    },
  };
}
