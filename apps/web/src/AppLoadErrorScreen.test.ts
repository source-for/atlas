import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppLoadErrorScreen } from './AppLoadErrorScreen';

describe('CLA-268 App load error screen', () => {
  const markup = renderToStaticMarkup(createElement(AppLoadErrorScreen, { error: new TypeError('Failed to fetch dynamically imported module: /assets/App-x.js'), onReload: () => undefined }));

  it('says what failed, shows the error and offers a reload, as an alert', () => {
    expect(markup).toMatch(/^<main role="alert"/);
    expect(markup).toContain('The atlas could not be opened');
    expect(markup).toContain('Failed to fetch dynamically imported module: /assets/App-x.js');
    expect(markup).toMatch(/<button[^>]*type="button">Reload page<\/button>/);
    expect(markup).not.toContain('Opening the map');
  });

  it('claims nothing about data: it also shows on routes that fetch none (the golden atlas ships in App\'s chunk)', () => {
    expect(markup).toContain('Part of the app did not load.');
    expect(markup).not.toMatch(/data loaded/i);
  });

  it('main.tsx replaces the skeleton with it when App fails to load, with a reload as the recovery', () => {
    const main = readFileSync(new URL('./main.tsx', import.meta.url), 'utf8');
    // The early request and the await before mount share one import; a failed import is not retried in the page.
    expect(main).toContain("appModule ??= import('./App');");
    expect(main).toMatch(/try \{\n\s+app = await loadAppModule\(\);\n\s+\} catch \(error\) \{[\s\S]{0,500}renderRoot\(<StrictMode><AppLoadErrorScreen error=\{error\} onReload=\{\(\) => window\.location\.reload\(\)\}\/><\/StrictMode>\);\n\s+return;/);
  });
});
