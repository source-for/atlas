import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SCAN_BAND_DEPTH_MIN_ENTITIES, SCAN_RESIDENT_NODES_PER_BAND } from './renderer/scanFixture';
import { VIEWPORT_TILE_WORLD_SIZE } from '@okie/architecture';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');
const fixture = (readFileSync(new URL('./renderer/scanFixture.ts', import.meta.url), 'utf8') + readFileSync(new URL('./renderer/scanScene.ts', import.meta.url), 'utf8'));

describe('CLA-74: viewport neighborhood is camera-resident tiles', () => {
  it('pages L3/L4 through the camera tile window and inspector +N more', () => {
    expect(app).toContain('function refreshViewportNeighborhood(');
    expect(app).toContain('expandRectByTileRing(cameraWorldRect(windowCamera, viewport))');
    expect(app).toContain("aria-expanded={expandedDetailLists.has('children')}");
    expect(app).toContain('`Show all ${inspectorChildren.length}`');
    expect(app).toContain('prefetchCommittedBox(');
  });

  it('does not inherit the previous band camera on Open inside / prefetch', () => {
    expect(app).not.toContain('cameraOverride ?? renderedCameraRef.current');
    expect(app).toContain('const windowCamera = scanKeepsResidentL3Landmarks(activeSnapshot, focusEntityId)');
    const prefetch = app.slice(app.indexOf('function prefetchCommittedBox('), app.indexOf('function revealOmittedEntity('));
    expect(prefetch).toContain('await fixture.ensureNeighborhood(focusId)');
    expect(prefetch).not.toContain('composeScene(');
    expect(prefetch).not.toContain('createSceneAsync(');
  });

  it('does not rewrite slim-boot fetch or raise the 2000 hang-guard', () => {
    expect(SCAN_BAND_DEPTH_MIN_ENTITIES).toBe(2000);
    expect(fixture).toContain('export const SCAN_BAND_DEPTH_MIN_ENTITIES = 2000;');
    expect(SCAN_RESIDENT_NODES_PER_BAND).toBe(50);
    expect(VIEWPORT_TILE_WORLD_SIZE).toBe(512);
    expect(app).not.toMatch(/protobuf|SceneSnapshot rewrite/u);
    expect(fixture).toContain("scanObjectPath(slug, 'neighborhood.json'");
    expect(fixture).toContain("scanObjectPath(slug, 'enrichment-report.json'");
  });
});
