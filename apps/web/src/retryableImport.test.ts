import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { AppLoadErrorScreen } from './AppLoadErrorScreen';
import { retryableImport } from './retryableImport';

describe('CLA-268 App chunk import', () => {
  it('shares one pending import between the early request and the await before mount', async () => {
    const load = vi.fn(async () => ({ App: 'app' }));
    const loadApp = retryableImport(load);
    const early = loadApp();
    expect(loadApp()).toBe(early);
    await expect(early).resolves.toEqual({ App: 'app' });
    await loadApp();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('forgets a failed import, so the next call imports again', async () => {
    const load = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'))
      .mockResolvedValueOnce({ App: 'app' });
    const loadApp = retryableImport(load as () => Promise<{ App: string }>);
    const early = loadApp();
    // The await before mount still sees the early failure (it was in flight when awaited)…
    await expect(early).rejects.toThrow('Failed to fetch dynamically imported module');
    await Promise.resolve();
    // …and a retry imports again instead of replaying the cached rejection.
    await expect(loadApp()).resolves.toEqual({ App: 'app' });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('CLA-268 App load error screen', () => {
  const markup = renderToStaticMarkup(createElement(AppLoadErrorScreen, { error: new TypeError('Failed to fetch dynamically imported module: /assets/App-x.js'), onReload: () => undefined }));

  it('says what failed, shows the error and offers a reload, as an alert', () => {
    expect(markup).toMatch(/^<main role="alert"/);
    expect(markup).toContain('The atlas could not be opened');
    expect(markup).toContain('Failed to fetch dynamically imported module: /assets/App-x.js');
    expect(markup).toMatch(/<button[^>]*type="button">Reload page<\/button>/);
    expect(markup).not.toContain('Opening the map');
  });

  it('main.tsx replaces the skeleton with it when App fails to load', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    expect(main).toContain("const loadAppModule = retryableImport(() => import('./App'));");
    expect(main).toMatch(/try \{\n\s+appModule = await loadAppModule\(\);\n\s+\} catch \(error\) \{[\s\S]{0,400}renderRoot\(<StrictMode><AppLoadErrorScreen error=\{error\} onReload=\{\(\) => window\.location\.reload\(\)\}\/><\/StrictMode>\);\n\s+return;/);
  });
});
