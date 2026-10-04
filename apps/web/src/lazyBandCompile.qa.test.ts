import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8');

describe('CLA-66: lazy band compile is the default scan path', () => {
  it('drives Open inside through scoped compile using snapshot children', () => {
    expect(app).toContain('scanDrillDeeperDetail(scene, target, activeSnapshot)');
    expect(app).toContain('scanEntityHasChildren(activeSnapshot, selected.id)');
    expect(app).toContain('function composeScene(');
    expect(app).toContain('neighborhoodScenesRef');
  });

  it('compiles the committed box neighborhood on selection, camera settle, and tour', () => {
    expect(app).toContain('function prefetchCommittedBox(');
    expect(app).toContain('prefetchCommittedBox(entity.id)');
    expect(app).toContain('prefetchCommittedBox(semanticLensSessionRef.current.settled.at(-1)?.targetId ?? selected.id)');
    expect(app).toContain('scanCompileFocusForBand(');
    expect(app).toContain('stepScene');
    expect(app).toContain('function selectLevelLoaded(');
    // Static wiring guard; executable cancellation/deadline behavior lives in levelScenePreparation.test.ts.
    expect(app).toContain('void prepareLevelSceneWithDeadline(controller, () => prepareLoadedLevelScene({');
  });

  it('caches scan neighborhoods even when callers pass the authoring document', () => {
    expect(app).toContain('Scan snapshots are read-only; neighborhood cache is the CLA-66 prefetch.');
    expect(app).not.toContain('if (scanFixture && !authoring)');
    expect(app).toContain('if (scanFixture) {');
    expect(app).toContain('cacheableNeighborhoodScene(compiled)');
  });

  it('does not invent a new entity cap or raise the 2000 hang-guard in the shell', () => {
    expect(app).not.toMatch(/BAND_DEPTH.*=\s*\d{4,}/u);
  });
});
