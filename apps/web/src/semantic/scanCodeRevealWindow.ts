import { C4_COMPONENT_CARD_FACE } from '@okie/architecture';
import { C4_CAMERA_LIMITS, C4_PRESENTATION_AT_FOCUS } from '@okie/scene-compiler';

export type ScanCodeRevealWindow = { startZoom: number; fullZoom: number; leaveStartZoom: number; leaveFullZoom: number; armZoom: number };
/** Scan L3→L4 uses the painted file face, never its reserved symbol-owner box.
 * Freeze this geometry-derived window before asynchronous neighborhood preparation. */
export function scanCodeRevealWindow(face: { width: number; height: number } | undefined, safeWidth?: number): ScanCodeRevealWindow | undefined {
  if (!face || !Number.isFinite(face.width) || !Number.isFinite(face.height) || face.width <= 0 || face.height <= 0) return undefined;
  const scale = C4_PRESENTATION_AT_FOCUS.component.geometryScale;
  // Width defines the focused-card size; summary wrapping must not postpone descent.
  const referenceWidth = safeWidth !== undefined && Number.isFinite(safeWidth) && safeWidth > 0
    ? Math.min(C4_COMPONENT_CARD_FACE.width * scale, safeWidth * 0.42)
    : C4_COMPONENT_CARD_FACE.width * scale;
  const referenceZoom = referenceWidth / face.width;
  const startZoom = Math.min(C4_CAMERA_LIMITS.maxZoom, referenceZoom * 1.25);
  const fullZoom = Math.min(C4_CAMERA_LIMITS.maxZoom, referenceZoom * 1.50);
  const deadband = referenceZoom * 0.05;
  return fullZoom > startZoom ? { startZoom, fullZoom, armZoom: referenceZoom * 1.10, leaveStartZoom: startZoom - deadband, leaveFullZoom: fullZoom - deadband } : undefined;
}
