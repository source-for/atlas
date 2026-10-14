import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8');

describe('portable bootstrap', () => {
  it('compiles a validated local bundle directly before App is imported', () => {
    expect(main).toContain('parsePortableAtlas');
    expect(main).toContain('compileScanFixture({');
    expect(main).toContain('setActiveScanFixture(fixture)');
    expect(main).toContain("await import('./App')");
  });

  it('keeps portable imports local and never uses the hosted scan loader', () => {
    const portableBoot = main.slice(main.indexOf('async function bootPortableAtlas'), main.indexOf('async function boot()'));
    expect(portableBoot).toContain("fetch('./atlas.okie.json')");
    expect(portableBoot).not.toContain('loadScanFixture');
    expect(portableBoot).not.toContain('fetchScanNeighborhoodHost');
  });

  it('remounts one app and controls root without depending on persistence or reloading', () => {
    expect(main.match(/createRoot\(/g)).toHaveLength(1);
    expect(main).not.toContain('window.location.assign');
    expect(main).toContain('flushSync(() => renderRoot(null))');
    expect(main).toContain('refreshAppScanFixture()');
    expect(main).toContain('<StrictMode key={portableMountSequence}>');
    expect(main).toContain('setActivePortableAtlas(undefined)');
    expect(main).toContain('setActiveScanFixture(undefined)');
    expect(main).toContain("portableReloadPath({ pathname: window.location.pathname, hash: '' })");
    expect(main).toContain('resetNavigation || portableNavigationDiffers(window.location.search, bundle)');
  });
});
