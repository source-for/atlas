import { describe, expect, it } from 'vitest';
import { scanCodeRevealWindow } from './scanCodeRevealWindow';

describe('scan file-face reveal window', () => {
  it('uses nominal component presentation width without a global code-band floor', () => {
    const window = scanCodeRevealWindow({ width: 85.00948766603416, height: 42.50474383301708 })!;
    expect(window.startZoom).toBeCloseTo(4.85239955357, 8);
    expect(window.fullZoom).toBeCloseTo(5.82287946428, 8);
    expect(window.fullZoom).toBeLessThan(7.1);
    expect(85.00948766603416 * window.startZoom).toBeCloseTo(412.5);
    expect(85.00948766603416 * window.fullZoom).toBeCloseTo(495);
  });
  it('does not shift width-defined descent when support copy changes card height', () => {
    const wide = scanCodeRevealWindow({ width: 85, height: 26 });
    expect(scanCodeRevealWindow({ width: 85, height: 150 })).toEqual(wide);
    expect(scanCodeRevealWindow({ width: 170, height: 26 })!.startZoom).toBe(wide!.startZoom / 2);
  });
  it('rejects unavailable geometry and unreachable collapsed intervals', () => {
    for (const face of [undefined, { width: 0, height: 20 }, { width: NaN, height: 20 }, { width: 20, height: 0 }, { width: 1, height: 1 }]) expect(scanCodeRevealWindow(face)).toBeUndefined();
  });
});
