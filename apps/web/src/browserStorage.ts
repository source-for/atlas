/**
 * CLA-610: the one way apps/web touches Web Storage and IndexedDB. In an opaque-origin document
 * (`<iframe sandbox="allow-scripts">` without allow-same-origin) and under some privacy settings, merely reading
 * `window.localStorage` throws SecurityError, so every access goes through a try/catch here.
 *
 * When the real Storage is unavailable, or a call on it throws, values live in memory for this page only: they are
 * gone on reload and never shared with another tab. That keeps preferences working within one visit without
 * claiming they were saved. IndexedDB gets no in-memory substitute: callers already report it as unavailable.
 */

export type BrowserStorage = Pick<Storage, 'getItem' | 'setItem'>;
type StorageKind = 'localStorage' | 'sessionStorage';
type StorageSource = { readonly [kind in StorageKind]?: BrowserStorage };

const pageMemory = new WeakMap<object, Map<StorageKind, Map<string, string>>>();

function memoryFor(source: object, kind: StorageKind): Map<string, string> {
  let kinds = pageMemory.get(source);
  if (!kinds) pageMemory.set(source, kinds = new Map());
  let values = kinds.get(kind);
  if (!values) kinds.set(kind, values = new Map());
  return values;
}

/** `source[kind]`, read lazily on every call (the getter itself may throw), with a page-lifetime memory fallback. */
export function browserStorage(kind: StorageKind, source: StorageSource = globalThis as StorageSource): BrowserStorage {
  const memory = () => memoryFor(source, kind);
  return {
    getItem(key) {
      const remembered = memory().get(key);
      if (remembered !== undefined) return remembered;
      try {
        const real = source[kind];
        if (real) return real.getItem(key);
      } catch { /* blocked: nothing remembered on this page */ }
      return null;
    },
    setItem(key, value) {
      try {
        const real = source[kind];
        if (real) { real.setItem(key, value); memory().delete(key); return; }
      } catch { /* blocked or full: remember for this page only */ }
      memory().set(key, String(value));
    },
  };
}

export const localStore = browserStorage('localStorage');

/** The IndexedDB factory, or undefined when the browser denies even reading it. */
export function indexedDbFactory(source: { readonly indexedDB?: IDBFactory } = globalThis): IDBFactory | undefined {
  try { return source.indexedDB; } catch { return undefined; }
}
