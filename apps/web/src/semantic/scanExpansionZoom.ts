import { C4_ZOOM_BANDS } from '@okie/scene-compiler';
import { ATLAS_SEMANTIC_ZOOM_BANDS, type SemanticZoomBand } from '../renderer/cameraBounds';
import { scanCodeReferenceWidth } from './scanCodeRevealWindow';

const containerBand = C4_ZOOM_BANDS[1]!;
const componentBand = C4_ZOOM_BANDS[2]!;
const componentLevel = 2;

/** A scaled container expansion never starts below the zoom at which containers have arrived. */
export const SCAN_EXPANSION_FLOOR_ZOOM = containerBand.enterZoom + containerBand.hysteresis;
/** Below this zoom the container level itself is left; a contraction must be over by then. */
export const SCAN_CONTAINER_LEAVE_ZOOM = containerBand.enterZoom - containerBand.hysteresis;

/**
 * How much earlier the scan L2→L3 expansion runs on a phone (CLA-404). The single definition
 * of "narrow" for the expansion: a phone-sized touch viewport (`isPhoneSizedTouchViewport`)
 * whose map is narrower than the CLA-381 breakpoint. The factor is the one CLA-381 applies to
 * the code window, so the expansion keeps its desktop place ahead of that window.
 *
 * Exactly `1` (today's thresholds, on every path) when the device is not a phone, when the
 * map is not narrow, or when scaling would put the component band's enter zoom under the
 * container band's own (the same ratio keeps its leave zoom above the container's). Past
 * that point the two levels would be entered in the wrong order and only the floor would
 * separate them, so nothing is scaled at all.
 */
export function scanExpansionZoomFactor(safeWidth: number | undefined, phone: boolean): number {
  if (!phone) return 1;
  const factor = scanCodeReferenceWidth(safeWidth) / scanCodeReferenceWidth();
  if (!(factor < 1)) return 1;
  if (componentBand.enterZoom * factor < containerBand.enterZoom) return 1;
  return factor;
}

export type ScanExpansionThresholds = { enterZoom: number; hysteresis: number; fullZoom: number | undefined };

/** A container→component transition moved earlier: enter is scaled then floored, and the
 * hysteresis and the fade to full keep their proportion. Unchanged at factor 1. */
export function scanExpansionThresholds(enterZoom: number, hysteresis: number, fullZoom: number | undefined, factor: number): ScanExpansionThresholds {
  if (!(factor < 1)) return { enterZoom, hysteresis, fullZoom };
  const enter = Math.max(enterZoom * factor, SCAN_EXPANSION_FLOOR_ZOOM);
  return { enterZoom: enter, hysteresis: hysteresis * factor, fullZoom: fullZoom === undefined ? undefined : enter + Math.max(0, fullZoom - enterZoom) * factor };
}

/** The component band's enter zoom after scaling: the floor under a completed expansion. */
export function scanExpansionEnterZoom(factor: number): number {
  return scanExpansionThresholds(componentBand.enterZoom, componentBand.hysteresis, undefined, factor).enterZoom;
}

/** The level bands a scan atlas resolves zoom against. The shared bands themselves at factor 1. */
export function scanExpansionZoomBands(factor: number): readonly SemanticZoomBand[] {
  if (!(factor < 1)) return ATLAS_SEMANTIC_ZOOM_BANDS;
  return ATLAS_SEMANTIC_ZOOM_BANDS.map((band, level) => level === componentLevel
    ? { ...band, ...scanExpansionThresholds(band.enterZoom, band.hysteresis, undefined, factor) } : band);
}

type ExpansionLensTarget = {
  currentDetail: string;
  nextDetail: string;
  enterZoom: number;
  hysteresis?: number;
  policy?: { fullZoom?: number };
};

/** Move a measured container→component lens target earlier. Every other target is returned as is. */
export function scaleScanExpansionLensTarget<T extends ExpansionLensTarget>(target: T | undefined, factor: number): T | undefined {
  if (!target || !(factor < 1) || target.currentDetail !== 'container' || target.nextDetail !== 'component') return target;
  const scaled = scanExpansionThresholds(target.enterZoom, target.hysteresis ?? 0, target.policy?.fullZoom, factor);
  return {
    ...target,
    enterZoom: scaled.enterZoom,
    ...(target.hysteresis !== undefined ? { hysteresis: scaled.hysteresis } : {}),
    ...(target.policy ? { policy: { ...target.policy, ...(scaled.fullZoom !== undefined ? { fullZoom: scaled.fullZoom } : {}) } } : {}),
  };
}
