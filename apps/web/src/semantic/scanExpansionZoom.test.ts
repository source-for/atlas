import { describe, expect, it } from 'vitest';
import demoSnapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import demoView from '../../../../fixtures/architecture/demo-view.json';
import demoStory from '../../../../fixtures/architecture/demo-story.json';
import { ATLAS_SEMANTIC_ZOOM_BANDS, semanticLevelAtZoom } from '../renderer/cameraBounds';
import { semanticBounds } from '../renderer/goldenC4Scene';
import { compileScanFixture } from '../renderer/scanFixture';
import { scanCodeReferenceWidth, scanCodeRevealWindow } from './scanCodeRevealWindow';
import { createScanContainerMorph, createScanReverseMorph, sampleScanContainerMorph, scanClosedCodeBridgeYieldsEarly } from './scanContainerMorph';
import { SCAN_CONTAINER_LEAVE_ZOOM, SCAN_EXPANSION_FLOOR_ZOOM, scaleScanExpansionLensTarget, scanExpansionThresholds, scanExpansionZoomBands, scanExpansionZoomFactor } from './scanExpansionZoom';
import { measureSemanticLensTarget, validateRestoredSemanticLensPath } from './semanticLens';

const focusId = 'container:web-app';
const lensPath = ['system:okie', focusId];

function scenes() {
  const scan = compileScanFixture({ snapshot: structuredClone(demoSnapshot), view: structuredClone(demoView), story: structuredClone(demoStory) });
  const source = scan.createScene(scan.navigation.rootEntityId);
  return { source, target: scan.createScene(focusId, source) };
}

/** Every zoom the app derives for one layout, through the same calls App.tsx makes. */
function thresholds(safeWidth: number, phone: boolean, shared = scenes()) {
  const { source, target } = shared;
  const factor = scanExpansionZoomFactor(safeWidth, phone);
  const bands = scanExpansionZoomBands(factor);
  // Inward: the first zoom that leaves `previous` for a deeper level. Outward: the last zoom still in it.
  const crossing = (from: number, previous: number, step: number) => {
    for (let zoom = from; zoom > 0.3 && zoom < 9; zoom += step) {
      const level = semanticLevelAtZoom(zoom, previous, bands);
      if (step > 0 ? level > previous : level < previous) return step > 0 ? zoom : zoom - step;
    }
    return NaN;
  };
  const lens = scaleScanExpansionLensTarget(measureSemanticLensTarget(source, focusId, 'container', { x: 0, y: 0, zoom: 1 },
    { width: safeWidth, height: 844 }, { top: 0, right: 0, bottom: 0, left: 0 }), factor)!;
  const expansionEnd = (startZoom: number) => createScanContainerMorph(source, target, focusId, startZoom, safeWidth, factor)!.fullZoom;
  const reverse = (arrivalZoom?: number) => {
    const morph = createScanReverseMorph(source, target, focusId, 'component', arrivalZoom, factor, safeWidth)!;
    return [morph.startZoom, morph.fullZoom];
  };
  const restored = (scene: typeof source, zoom: number) => validateRestoredSemanticLensPath(scene, 'context', lensPath, zoom, factor).entries.length === lensPath.length;
  const restoreLeave = (scene: typeof source) => {
    for (let zoom = 0.5; zoom < 5; zoom += 0.0005) if (restored(scene, zoom)) return zoom;
    return NaN;
  };
  const windows = target.entities.filter(entity => entity.parentId === focusId)
    .map(entity => scanCodeRevealWindow(semanticBounds(target, entity.id, 'component'), safeWidth)!);
  const earliest = windows.reduce((first, window) => window.armZoom < first.armZoom ? window : first);
  return {
    factor, lens, expansionEnd, reverse,
    bandCommit: crossing(0.5, 1, 0.0005), bandLeave: crossing(7, 2, -0.0005),
    restoreLeaveRoot: restoreLeave(source), restoreLeaveOwn: restoreLeave(target),
    code: earliest,
  };
}

describe('where "narrow" begins for the scan expansion (CLA-404)', () => {
  it('is 1 on anything that is not a phone, at every safe width', () => {
    for (const safeWidth of [1325, 965, 909, 786, 785, 645, 549, 390, 287, 100]) {
      expect(scanExpansionZoomFactor(safeWidth, false), String(safeWidth)).toBe(1);
    }
    expect(scanExpansionZoomFactor(undefined, false)).toBe(1);
    expect(scanExpansionZoomFactor(undefined, true)).toBe(1);
  });

  it('on a phone is the CLA-381 code-window ratio, flipping at the same safe width', () => {
    // 330 = the component card face at focus; the code window narrows below 330 / 0.42 = 785.71.
    expect(scanCodeReferenceWidth()).toBe(330);
    expect(scanExpansionZoomFactor(786, true)).toBe(1);
    expect(scanExpansionZoomFactor(785.72, true)).toBe(1);
    expect(scanExpansionZoomFactor(785.7, true)).toBeCloseTo(0.42 * 785.7 / 330, 12);
    expect(scanExpansionZoomFactor(785, true)).toBeCloseTo(0.999090909, 8);
    expect(scanExpansionZoomFactor(390, true)).toBeCloseTo(0.496363636, 8);
    expect(scanExpansionZoomFactor(287, true)).toBeCloseTo(0.365272727, 8);
    // The code window moves by exactly this ratio, phone or not.
    const face = { width: 85, height: 42 };
    for (const safeWidth of [785, 549, 390, 287]) {
      expect(scanCodeRevealWindow(face, safeWidth)!.armZoom / scanCodeRevealWindow(face)!.armZoom).toBeCloseTo(scanExpansionZoomFactor(safeWidth, true), 12);
    }
  });

  it('falls back to exactly 1 once the scaled component band would drop under the container band', () => {
    // 3.35 x f >= 1.16 needs f >= 0.34627, a safe width of 272.07. At that limit the scaled
    // leave zoom, 3.12 x f = 1.0803, is still above the container's own 1.08.
    expect((3.35 - 0.23) * (1.16 / 3.35)).toBeGreaterThan(SCAN_CONTAINER_LEAVE_ZOOM);
    expect(scanExpansionZoomFactor(273, true)).toBeCloseTo(0.42 * 273 / 330, 12);
    expect(scanExpansionZoomFactor(272.08, true)).toBeLessThan(1);
    expect(scanExpansionZoomFactor(272.06, true)).toBe(1);
    expect(scanExpansionZoomFactor(272, true)).toBe(1);
    expect(scanExpansionZoomFactor(257, true)).toBe(1);
    expect(scanExpansionZoomFactor(1, true)).toBe(1);
  });

  it('scales a transition then floors its enter zoom at the container commit zoom', () => {
    expect(SCAN_EXPANSION_FLOOR_ZOOM).toBeCloseTo(1.24, 12);
    expect(SCAN_CONTAINER_LEAVE_ZOOM).toBeCloseTo(1.08, 12);
    expect(scanExpansionThresholds(3.35, 0.23, 3.75, 1)).toEqual({ enterZoom: 3.35, hysteresis: 0.23, fullZoom: 3.75 });
    const at390 = scanExpansionThresholds(3.35, 0.23, 3.75, scanExpansionZoomFactor(390, true));
    expect(at390.enterZoom).toBeCloseTo(1.662818, 6);
    expect(at390.hysteresis).toBeCloseTo(0.114164, 6);
    expect(at390.fullZoom).toBeCloseTo(1.861364, 6);
    const at287 = scanExpansionThresholds(3.35, 0.23, 3.75, scanExpansionZoomFactor(287, true));
    expect(at287.enterZoom).toBe(SCAN_EXPANSION_FLOOR_ZOOM);
    expect(at287.enterZoom - at287.hysteresis).toBeGreaterThan(SCAN_CONTAINER_LEAVE_ZOOM);
  });

  it('hands back the shared bands and an untouched lens target at factor 1', () => {
    expect(scanExpansionZoomBands(1)).toBe(ATLAS_SEMANTIC_ZOOM_BANDS);
    const target = { currentDetail: 'container', nextDetail: 'component', enterZoom: 3.35, hysteresis: 0.23, policy: { fullZoom: 3.75 } };
    expect(scaleScanExpansionLensTarget(target, 1)).toBe(target);
    const other = { ...target, currentDetail: 'component', nextDetail: 'code' };
    expect(scaleScanExpansionLensTarget(other, 0.5)).toBe(other);
    const scaled = scanExpansionZoomBands(0.5);
    expect(scaled.map(band => band.enterZoom)).toEqual([0, 1.16, 1.675, 7.1]);
    expect(scaled[2]!.hysteresis).toBeCloseTo(0.115, 12);
    expect(scaled[1]).toBe(ATLAS_SEMANTIC_ZOOM_BANDS[1]);
  });
});

describe('desktop thresholds are the numbers on main (CLA-404)', () => {
  // Literals measured on main b25cbd2 with the demo scan fixture, container:web-app.
  // 549 is 1024x768 with the inspector open and 645 is 1280 with a 520 inspector: both are
  // below the CLA-381 breakpoint, so a rule keyed on safe width alone would move them.
  const shared = scenes();
  it.each([
    [1325, 4.270112, 4.270112, 4.296, 4.270112],
    [965, 4.270112, 4.270112, 4.296, 4.270112],
    [909, 4.270112, 4.270112, 4.296, 4.270112],
    [645, 4.02, 4.176, 4.296, 3.505373],
    [549, 4.02, 4.176, 4.296, 2.983643],
    // A narrow desktop window: mouse and hover, so not a phone.
    [390, 4.02, 4.176, 4.296, 2.119528],
  ])('safe width %s, not a phone', (safeWidth, endFromEnter, endFrom348, endFromCommit, codeArm) => {
    const measured = thresholds(safeWidth, false, shared);
    expect(measured.factor).toBe(1);
    expect(measured.lens.enterZoom).toBe(3.35);
    expect(measured.lens.hysteresis).toBe(0.23);
    expect(measured.lens.policy!.fullZoom).toBe(3.75);
    expect(measured.bandCommit).toBeCloseTo(3.58, 3);
    expect(measured.bandLeave).toBeCloseTo(3.12, 3);
    expect(measured.expansionEnd(3.35)).toBeCloseTo(endFromEnter, 6);
    expect(measured.expansionEnd(3.48)).toBeCloseTo(endFrom348, 6);
    expect(measured.expansionEnd(3.58)).toBeCloseTo(endFromCommit, 6);
    expect(measured.expansionEnd(1.7)).toBe(3.35);
    expect(measured.reverse()[0]).toBeCloseTo(2.030303, 6);
    expect(measured.reverse()[1]).toBe(3.35);
    expect(measured.reverse(3.2)[0]).toBeCloseTo(1.939394, 6);
    expect(measured.reverse(3.2)[1]).toBe(3.2);
    expect(measured.reverse(1.5)[0]).toBeCloseTo(0.909091, 6);
    expect(measured.restoreLeaveRoot).toBeCloseTo(3.12, 3);
    expect(measured.restoreLeaveOwn).toBeCloseTo(2.7495, 3);
    expect(measured.code.armZoom).toBeCloseTo(codeArm, 6);
  });

  it('a phone too narrow to keep the order gets the same numbers as main', () => {
    for (const safeWidth of [272, 257]) {
      const measured = thresholds(safeWidth, true, shared);
      expect(measured.factor).toBe(1);
      expect(measured.lens.enterZoom).toBe(3.35);
      expect(measured.bandCommit).toBeCloseTo(3.58, 3);
      expect(measured.bandLeave).toBeCloseTo(3.12, 3);
      expect(measured.expansionEnd(1.3)).toBe(3.35);
      expect(measured.expansionEnd(3.35)).toBeCloseTo(4.02, 6);
      expect(measured.reverse()[0]).toBeCloseTo(2.030303, 6);
      expect(measured.restoreLeaveRoot).toBeCloseTo(3.12, 3);
    }
  });

  it('a phone just past the breakpoint is on main\'s numbers and just inside it moves by under 0.1%', () => {
    const past = thresholds(786, true, shared);
    expect(past.factor).toBe(1);
    expect(past.lens.enterZoom).toBe(3.35);
    expect(past.expansionEnd(3.35)).toBeCloseTo(4.270112, 6);
    const inside = thresholds(785, true, shared);
    expect(inside.lens.enterZoom).toBeCloseTo(3.346955, 6);
    expect(inside.bandLeave).toBeCloseTo(3.1175, 3);
    expect(inside.expansionEnd(inside.lens.enterZoom)).toBeCloseTo(inside.code.armZoom, 8);
    expect(inside.code.armZoom).toBeCloseTo(4.26623, 5);
  });
});

describe('a phone expands a container before its files\' code window (CLA-404)', () => {
  const shared = scenes();
  it.each([
    // safe width, lens enter, band commit, leave, code arm, code start
    [390, 1.662818, 1.777, 1.549, 2.119528, 2.408555],
    // A real 390x844 phone: the level rail and the details toggle leave 287.
    [287, 1.24, 1.3245, 1.156, 1.559755, 1.772449],
    [273, 1.24, 1.32, 1.1605, 1.48367, 1.685988],
  ])('safe width %s', (safeWidth, enter, commit, leave, codeArm, codeStart) => {
    const measured = thresholds(safeWidth, true, shared);
    expect(measured.factor).toBeLessThan(1);
    expect(measured.lens.enterZoom).toBeCloseTo(enter, 6);
    expect(measured.bandCommit).toBeCloseTo(commit, 3);
    expect(measured.bandLeave).toBeCloseTo(leave, 3);
    // CLA-381 put the code window here; it has not moved.
    expect(measured.code.armZoom).toBeCloseTo(codeArm, 6);
    expect(measured.code.startZoom).toBeCloseTo(codeStart, 6);
    // Ordering: container level, then the expansion, then the code window.
    expect(measured.lens.enterZoom).toBeGreaterThanOrEqual(SCAN_EXPANSION_FLOOR_ZOOM);
    expect(measured.bandLeave).toBeGreaterThan(SCAN_CONTAINER_LEAVE_ZOOM);
    expect(measured.bandLeave).toBeLessThan(measured.lens.enterZoom);
    expect(measured.lens.policy!.fullZoom!).toBeLessThanOrEqual(measured.code.armZoom);
    // A saved L3 view is kept down to the leave zoom and dropped below it.
    expect(measured.restoreLeaveRoot).toBeCloseTo(leave, 3);
  });

  it('ends exactly at the code arm at 390 and 287 when it starts at the lens enter zoom', () => {
    for (const safeWidth of [390, 287]) {
      const measured = thresholds(safeWidth, true, shared);
      expect(measured.expansionEnd(measured.lens.enterZoom)).toBeCloseTo(measured.code.armZoom, 8);
    }
  });

  // The requirement: the expansion is over before the code start zoom, so the code reveal
  // follows the pinch. The arm zoom is the target; the minimum span (x1.2) can carry the end
  // a little past it. Starts: the floor, and where a real phone pinch began in browser QA.
  const overArmLimit = 0.09;
  it.each([
    // safe width, start zoom, ends at or before the arm
    [272.08, 1.24, false], [272.08, 1.30, false], [272.08, 1.32, false], [272.08, 1.34, false],
    [273, 1.24, false], [273, 1.30, false], [273, 1.32, false], [273, 1.34, false],
    [287, 1.24, true], [287, 1.30, false], [287, 1.32, false], [287, 1.34, false],
    [309, 1.24, true], [309, 1.30, true], [309, 1.32, true], [309, 1.34, true],
    [390, 1.24, true], [390, 1.30, true], [390, 1.32, true], [390, 1.34, true],
  ])('safe width %s from zoom %s ends before code starts', (safeWidth, startZoom, withinArm) => {
    const measured = thresholds(safeWidth, true, shared);
    expect(measured.factor).toBeLessThan(1);
    const end = measured.expansionEnd(startZoom);
    expect(end).toBeGreaterThan(startZoom);
    expect(end).toBeLessThan(measured.code.startZoom);
    if (withinArm) expect(end).toBeLessThanOrEqual(measured.code.armZoom + 1e-9);
    else {
      expect(end).toBeGreaterThan(measured.code.armZoom);
      expect(end / measured.code.armZoom - 1).toBeLessThan(overArmLimit);
    }
  });

  it('also ends before code starts from the latest zoom the lens or the level band can start it', () => {
    for (const safeWidth of [272.08, 273, 287, 309, 390, 549, 785]) {
      const measured = thresholds(safeWidth, true, shared);
      for (const startZoom of [measured.lens.enterZoom, measured.bandCommit]) {
        const end = measured.expansionEnd(startZoom);
        expect(end, `${safeWidth} ${startZoom}`).toBeLessThan(measured.code.startZoom);
        expect(end / measured.code.armZoom - 1, `${safeWidth} ${startZoom}`).toBeLessThan(overArmLimit);
      }
    }
  });

  it('contracts a cold L3 view above the container level instead of through it', () => {
    for (const safeWidth of [390, 287, 273]) {
      const measured = thresholds(safeWidth, true, shared);
      for (const arrival of [undefined, 3.2, 1.6, 1.4, 1.25]) {
        const [start, full] = measured.reverse(arrival);
        expect(start, `${safeWidth} ${arrival}`).toBeGreaterThanOrEqual(SCAN_CONTAINER_LEAVE_ZOOM);
        expect(full).toBeGreaterThan(start!);
      }
      expect(measured.reverse()[0]).toBe(SCAN_EXPANSION_FLOOR_ZOOM);
      expect(measured.reverse(1.6)[0]).toBe(SCAN_EXPANSION_FLOOR_ZOOM);
    }
  });

  it('contracts over the zooms the expansion opened over: from its end down to the floor', () => {
    // safe width, where an expansion from the scaled enter zoom ends
    for (const [safeWidth, top] of [[390, 2.119528], [287, 1.559755], [273, 1.488]] as const) {
      const measured = thresholds(safeWidth, true, shared);
      expect(measured.expansionEnd(measured.lens.enterZoom)).toBeCloseTo(top, 6);
      // Arriving from above (a file's code just closed) the whole interval is still ahead.
      for (const arrival of [undefined, 3.2, top * 1.09]) {
        expect(measured.reverse(arrival)[0], `${safeWidth} ${arrival}`).toBe(SCAN_EXPANSION_FLOOR_ZOOM);
        expect(measured.reverse(arrival)[1], `${safeWidth} ${arrival}`).toBeCloseTo(top, 6);
      }
      // A view restored below the top is anchored where it arrived, as on desktop.
      expect(measured.reverse(1.4)).toEqual([1.4 / 1.2, 1.4]);
    }
  });

  it('never hangs a phone contraction below the zoom where containers leave, wherever the view arrived', () => {
    const { source, target } = shared;
    // Around both limits (1.08, 1.24), browser QA's stranded arrival (0.472), and the far ends.
    const arrivals = [0.3, 0.472, 0.9, 1.07, SCAN_CONTAINER_LEAVE_ZOOM, 1.0801, 1.15, 1.2399, 1.24, 1.3, 1.6, 3.2, 4.4];
    for (const safeWidth of [273, 287, 390, 785]) {
      const factor = scanExpansionZoomFactor(safeWidth, true);
      expect(factor).toBeLessThan(1);
      for (const arrival of arrivals) {
        const morph = createScanReverseMorph(source, target, focusId, 'component', arrival, factor, safeWidth)!;
        expect(morph.startZoom, `${safeWidth} ${arrival}`).toBeGreaterThanOrEqual(SCAN_CONTAINER_LEAVE_ZOOM);
        expect(morph.fullZoom, `${safeWidth} ${arrival}`).toBeGreaterThan(morph.startZoom);
        // At or below the leave zoom it is already closed where it arrived.
        if (arrival <= SCAN_CONTAINER_LEAVE_ZOOM) expect(sampleScanContainerMorph(morph, arrival).progress, `${safeWidth} ${arrival}`).toBe(0);
      }
    }
    // QA's case was 0.286 -> 0.472, under the camera's own minimum zoom.
    const stranded = createScanReverseMorph(source, target, focusId, 'component', 0.472, scanExpansionZoomFactor(287, true), 287)!;
    expect([stranded.startZoom, stranded.fullZoom]).toEqual([SCAN_EXPANSION_FLOOR_ZOOM, expect.closeTo(1.559755, 6)]);
    // Main anchors any arrival, and so does everything that is not a phone.
    expect(createScanReverseMorph(source, target, focusId, 'component', 0.472, 1, 390)).toMatchObject({ startZoom: 0.472 / 1.65, fullZoom: 0.472 });
    expect(createScanReverseMorph(source, target, focusId, 'component', 0.472, scanExpansionZoomFactor(272, true), 272)).toMatchObject({ startZoom: 0.472 / 1.65, fullZoom: 0.472 });
  });

  it('keeps the arrival anchor for a phone view that arrives just above the container leave zoom', () => {
    const { source, target } = shared;
    const factor = scanExpansionZoomFactor(287, true);
    const interval = (arrival: number) => {
      const morph = createScanReverseMorph(source, target, focusId, 'component', arrival, factor, 287)!;
      return [morph.startZoom, morph.fullZoom];
    };
    // Above 1.08 the view contracts from where it is, down to the leave zoom ...
    expect(interval(1.15)).toEqual([SCAN_CONTAINER_LEAVE_ZOOM, 1.15]);
    expect(interval(1.0801)).toEqual([SCAN_CONTAINER_LEAVE_ZOOM, 1.0801]);
    // ... and only at or below it is the anchor given up for the interval above.
    expect(interval(SCAN_CONTAINER_LEAVE_ZOOM)).toEqual([SCAN_EXPANSION_FLOOR_ZOOM, expect.closeTo(1.559755, 6)]);
    expect(interval(1.07)).toEqual([SCAN_EXPANSION_FLOOR_ZOOM, expect.closeTo(1.559755, 6)]);
  });

  it('gives up a closed code bridge on the way out at once on a phone only', () => {
    const closedCode = { progress: 0, targetDetail: 'code' };
    const phone = scanExpansionZoomFactor(287, true);
    expect(scanClosedCodeBridgeYieldsEarly(closedCode, phone)).toBe(true);
    // Desktop, and a phone too narrow to scale, hold it until the band is left, as on main.
    expect(scanClosedCodeBridgeYieldsEarly(closedCode, 1)).toBe(false);
    expect(scanClosedCodeBridgeYieldsEarly(closedCode, scanExpansionZoomFactor(272, true))).toBe(false);
    expect(scanClosedCodeBridgeYieldsEarly(closedCode, scanExpansionZoomFactor(390, false))).toBe(false);
    // The container's own dormant expansion is still held through the container level.
    expect(scanClosedCodeBridgeYieldsEarly({ progress: 0, targetDetail: 'component' }, phone)).toBe(false);
    // Code that is still part-way open keeps its bridge.
    expect(scanClosedCodeBridgeYieldsEarly({ progress: 0.2, targetDetail: 'code' }, phone)).toBe(false);
  });

  it('keeps the interval an expansion was built with when the device or width changes under it', () => {
    const { source, target } = shared;
    const phone = scanExpansionZoomFactor(390, true);
    const morph = createScanContainerMorph(source, target, focusId, 1.7, 390, phone)!;
    const interval = [morph.startZoom, morph.fullZoom];
    const half = sampleScanContainerMorph(morph, 1.9);
    expect(half.progress).toBeGreaterThan(0);
    expect(half.progress).toBeLessThan(1);
    morph.progress = half.progress;
    // Rotation or devtools turns the phone off mid-expansion: a new morph would use main's
    // interval, but this one still samples its own, in both directions.
    expect(scanExpansionZoomFactor(844, true)).toBe(1);
    expect(createScanContainerMorph(source, target, focusId, 1.7, 844, 1)!.fullZoom).toBe(3.35);
    expect([morph.startZoom, morph.fullZoom]).toEqual(interval);
    expect(sampleScanContainerMorph(morph, morph.fullZoom).progress).toBe(1);
    expect(sampleScanContainerMorph(morph, morph.startZoom).progress).toBe(0);
  });
});
