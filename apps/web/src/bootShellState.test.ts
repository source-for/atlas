import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BootShell } from './BootShell';
import { advanceBootShellStep, BOOT_SHELL_STEPS, bootShellHeaderSlots, bootShellLayout, bootShellStepLabel } from './bootShellState';
import { initialInspectorOpen } from './embedChrome';
import { defaultInspectorWidth } from './inspector/inspectorPanel';
import { parseAppRoute } from './renderer/route';

const top = {};
const page = (innerWidth: number) => ({ innerWidth, self: top, top });

describe('CLA-268 boot shell steps', () => {
  it('names each step in plain words, in boot order', () => {
    expect(BOOT_SHELL_STEPS.map(bootShellStepLabel)).toEqual(['Loading atlas data…', 'Preparing the view…', 'Opening the map…']);
  });

  it('only moves forward: a late report of an earlier step never replaces a later one', () => {
    expect(advanceBootShellStep('data', 'view')).toBe('view');
    expect(advanceBootShellStep('view', 'opening')).toBe('opening');
    expect(advanceBootShellStep('data', 'opening')).toBe('opening');
    expect(advanceBootShellStep('opening', 'view')).toBe('opening');
    expect(advanceBootShellStep('view', 'data')).toBe('view');
    expect(advanceBootShellStep('view', 'view')).toBe('view');
  });
});

describe('CLA-268 boot shell layout matches App\'s first render', () => {
  it.each([1440, 1280, 1061, 1060, 901, 900, 640])('a top-level page %ipx wide', width => {
    expect(bootShellLayout(page(width), '')).toEqual({
      embed: false,
      detailsOpen: initialInspectorOpen(page(width), ''),
      detailsWidth: defaultInspectorWidth(width),
    });
  });

  it('desktop: inspector open at the default width', () => {
    expect(bootShellLayout(page(1440), '')).toEqual({ embed: false, detailsOpen: true, detailsWidth: 403 });
  });

  it('embeds (?embed=1 or framed) get embed chrome with the inspector closed', () => {
    expect(bootShellLayout(page(1440), '?embed=1')).toMatchObject({ embed: true, detailsOpen: false });
    expect(bootShellLayout({ innerWidth: 800, self: {}, top: {} }, '')).toMatchObject({ embed: true, detailsOpen: false });
  });
});

describe('CLA-268 boot shell header slots', () => {
  it('holds the embed button\'s place on a published /r/ page outside embeds, in App\'s order', () => {
    expect(bootShellHeaderSlots(parseAppRoute('/r/source-for/atlas'), false)).toEqual(['import', 'screenshot', 'share', 'embed', 'repo']);
    expect(bootShellHeaderSlots(parseAppRoute('/r/THISS/okie'), false)).toEqual(['import', 'screenshot', 'share', 'embed', 'repo']);
  });
  it('has no embed slot inside an embed or off /r/', () => {
    expect(bootShellHeaderSlots(parseAppRoute('/r/source-for/atlas'), true)).toEqual(['import', 'screenshot', 'share', 'repo']);
    expect(bootShellHeaderSlots(parseAppRoute('/'), false)).toEqual(['import', 'screenshot', 'share', 'repo']);
  });
});

describe('CLA-268 boot shell view', () => {
  const markup = renderToStaticMarkup(createElement(BootShell, { layout: { embed: false, detailsOpen: true, detailsWidth: 403 }, step: 'view', headerSlots: ['import', 'screenshot', 'share', 'embed', 'repo'] as const, fontsReady: true }));

  it('is busy, with one live region naming the step', () => {
    expect(markup).toMatch(/^<div aria-busy="true" aria-label="Atlas loading" class="app-shell boot-shell" data-boot-step="view" data-embed="false"/);
    expect(markup.match(/role="status"/g)).toHaveLength(1);
    expect(markup).toContain('<p class="boot-status" role="status">Preparing the view…</p>');
  });

  it('holds no controls: nothing can take focus or be clicked', () => {
    expect(markup).not.toMatch(/<(button|input|a|select|textarea|details|summary)[\s>]/);
    expect(markup).not.toMatch(/tabindex|href=|contenteditable/);
  });

  it('uses App\'s shell regions so each sits in App\'s box', () => {
    for (const region of ['class="topbar"', 'class="search-zone"', 'class="search-trigger"', 'class="top-actions"', 'class="diagram-view-bar"', 'class="workspace has-details"', 'class="map-stage"', 'class="level-rail"', 'class="details-panel open"', '--details-width:403px']) {
      expect(markup).toContain(region);
    }
    // Each header slot carries its App control's classes (App's narrow-width rules hide or keep them alike).
    expect(markup).toContain('<div aria-hidden="true" class="top-actions"><span class="icon-button"></span><span class="diagram-add-menu screenshot-menu"><span class="boot-menu-summary"></span></span><span class="icon-button share-view-button"></span><span class="embed-atlas-control"><span class="icon-button embed-atlas-button"></span></span><span class="icon-button"></span></div>');
    // App's ids and test ids stay App's: the skeleton is never mistaken for the mounted atlas.
    expect(markup).not.toMatch(/id="architecture-inspector"|data-testid="atlas-(app|canvas)"/);
  });

  it('hides the wordmark until its webfont is in, so a face swap cannot move it', () => {
    const pending = renderToStaticMarkup(createElement(BootShell, { layout: { embed: false, detailsOpen: true, detailsWidth: 403 }, step: 'data', headerSlots: ['import', 'screenshot', 'share', 'repo'] as const, fontsReady: false }));
    expect(pending).toContain('data-fonts="pending"');
    expect(markup).toContain('data-fonts="ready"');
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(css).toContain('.boot-shell[data-fonts="pending"] .brand-line { visibility: hidden; }');
  });

  it('stops pulsing under prefers-reduced-motion', () => {
    const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\) \{\s*\.boot-line,\s*\.boot-status::before \{ animation: none; \}/);
  });
});
