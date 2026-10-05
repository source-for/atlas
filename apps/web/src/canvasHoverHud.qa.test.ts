import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCAN_BAND_DEPTH_MIN_ENTITIES } from './renderer/scanFixture';
import { BAND_COST_HANG_GUARD_ENTITIES } from '@okie/scene-compiler';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const css = readFileSync(new URL('./app.css', import.meta.url), 'utf8');
const hud = readFileSync(new URL('./canvasHoverHud.tsx', import.meta.url), 'utf8');

function declarations(source: string, selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = source.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`));
  if (!match) throw new Error(`Missing CSS rule for ${selector}`);
  return match[1]!;
}

describe('CLA-113 canvas hover HUD', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(BAND_COST_HANG_GUARD_ENTITIES).toBe(2000);
    expect(hud).not.toMatch(/SCAN_BAND_DEPTH_MIN_ENTITIES\s*=\s*[3-9]\d{3}/u);
    expect(app).not.toContain('SCAN_BAND_DEPTH_MIN_ENTITIES = 3000');
  });

  it('picks hover in exploration, not only the connect tool', () => {
    const viewportStart = app.indexOf('function CanvasViewport');
    const viewportEnd = app.indexOf('function App()', viewportStart);
    const viewport = app.slice(viewportStart, viewportEnd);
    expect(viewport).toContain('setHoveredPick(previous => samePickResult(previous, next) ? previous : next)');
    expect(viewport).toContain("event.pointerType === 'touch'");
    expect(viewport).not.toMatch(/if \(authoringEnabled\) \{\s*const bounds = event\.currentTarget\.getBoundingClientRect\(\);\s*setHoveredPick/u);
    expect(viewport).toContain("authoringEnabled && authoringTool === 'connect'");
    expect(viewport).toContain('canvasHoverHudModel');
    expect(viewport).toContain('suppress:');
    expect(viewport).toContain('<CanvasHoverHud');
    expect(viewport).toContain('onPointerLeave');
    expect(hud).toContain('entityIdsByDetail[detail]');
    expect(hud).toContain('paintedBoundary');
  });

  it('keeps connect-tool ports on hoveredPick and does not capture pointer on the HUD', () => {
    const overlay = declarations(css, '.canvas-hover-hud');
    expect(overlay).toContain('pointer-events: none');
    expect(overlay).toContain('backdrop-filter: blur(16px)');
    expect(overlay).toContain('background: rgba(7, 10, 11, 0.94)');
    expect(overlay).toMatch(/z-index:\s*7/);
    expect(app).toContain("authoringEnabled && authoringTool === 'connect'");
    expect(app).toContain("authoringTool === 'connect' && hoveredPick?.kind === 'entity'");
    expect(hud).toContain('data-testid="canvas-hover-hud"');
    expect(app).toContain('<CanvasHoverHud');
  });
});

describe('CLA-114 L4 card copy', () => {
  it('does not raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(BAND_COST_HANG_GUARD_ENTITIES).toBe(2000);
  });

  it('paints L4 from codeCardCopy and keeps inspector source paths', () => {
    // CLA-381: the HUD reads the exact lines Canvas paints, which come from codeCardCopy.
    expect(hud).toContain('canvasCardTextLayout(entity, detail, boundary, zoom, screenWidth)');
    expect(readFileSync(new URL('./renderer/Canvas2DRenderer.ts', import.meta.url), 'utf8')).toContain('codeCardCopy(entity)');
    expect(app).toContain('source.path');
    expect(app).toContain('lines ${source.startLine}–${source.endLine}');
    expect(app).toContain('className="source-card"');
  });
});
