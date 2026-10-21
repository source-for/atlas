import { describe, expect, it } from 'vitest';
import { browserStorage, indexedDbFactory } from './browserStorage';

function realStorage() {
  const values = new Map<string, string>();
  return { values, getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}
const blockedWindow = () => Object.defineProperty({}, 'localStorage', { get() { throw new DOMException('sandboxed', 'SecurityError'); } });

describe('CLA-610 browserStorage', () => {
  it('writes through to working storage', () => {
    const local = realStorage();
    const store = browserStorage('localStorage', { localStorage: local });
    store.setItem('k', 'v');
    expect(local.values.get('k')).toBe('v');
    expect(browserStorage('localStorage', { localStorage: local }).getItem('k')).toBe('v');
  });

  it('blocked storage: remembered for this page only, not across a reload', () => {
    const page = blockedWindow();
    expect(browserStorage('localStorage', page).getItem('k')).toBeNull();
    browserStorage('localStorage', page).setItem('k', 'v');
    expect(browserStorage('localStorage', page).getItem('k')).toBe('v');
    expect(browserStorage('sessionStorage', page).getItem('k')).toBeNull();
    // A reloaded document is a new window: nothing was saved.
    expect(browserStorage('localStorage', blockedWindow()).getItem('k')).toBeNull();
  });

  it('a write that throws (quota) keeps this page consistent until storage works again', () => {
    const local = realStorage();
    let full = true;
    const source = { localStorage: { getItem: local.getItem, setItem: (key: string, value: string) => { if (full) throw new DOMException('full', 'QuotaExceededError'); local.setItem(key, value); } } };
    local.values.set('k', 'old');
    const store = browserStorage('localStorage', source);
    store.setItem('k', 'new');
    expect(store.getItem('k')).toBe('new');
    expect(local.values.get('k')).toBe('old');
    full = false;
    store.setItem('k', 'saved');
    local.values.set('k', 'other tab');
    expect(store.getItem('k')).toBe('other tab');
  });

  it('IndexedDB: the factory, or undefined (no in-memory stand-in) when reading it throws', () => {
    const factory = {} as IDBFactory;
    expect(indexedDbFactory({ indexedDB: factory })).toBe(factory);
    expect(indexedDbFactory(Object.defineProperty({}, 'indexedDB', { get() { throw new DOMException('sandboxed', 'SecurityError'); } }))).toBeUndefined();
  });
});
