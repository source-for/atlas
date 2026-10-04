import type { Camera } from './renderer/types';

export type StoryViewport = { width: number; height: number };

export type StoryFlight = {
  source: Camera;
  target: Camera;
  overviewZoom?: number;
  durationMs: number;
  elapsedMs: number;
  canonicalDurationMs: number;
  canonicalElapsedMs: number;
  startedAtMs: number;
  running: boolean;
  frozenCamera?: Camera;
};

export type StoryFlightSample = {
  camera: Camera;
  elapsedMs: number;
  segmentElapsedMs: number;
  progress: number;
  easedProgress: number;
  visualProgress: number;
  departureProgress: number;
  arrived: boolean;
};

export type StoryArrivalHoldClock = {
  phase: 'arrival' | 'hold';
  phaseElapsedMs: number;
  holdElapsedMs: number;
  startedAtMs: number;
  running: boolean;
  playHoldAfterArrival: boolean;
  holdDurationMs: number;
};

export type StoryArrivalHoldSample = {
  phase: 'arrival' | 'hold';
  phaseElapsedMs: number;
  holdElapsedMs: number;
  arrived: boolean;
  holdComplete: boolean;
};

export const STORY_HOLD_DURATION_MS = 4_200;
export const STORY_MAX_HOLD_DURATION_MS = 12_000;
export const STORY_FOCUS_TRANSITION_MS = 200;
export const STORY_ARRIVAL_SETTLE_MS = 150;
export const STORY_MAX_FLIGHT_DURATION_MS = 1_100;

export function quantizeStoryMilliseconds(value: number) {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

export function resolveStoryHoldDuration(narration: string, authoredDurationMs?: number) {
  const words = narration.trim() ? narration.trim().split(/\s+/u).length : 0;
  const readingTimeMs = Math.round(1_200 + words / 3 * 1_000);
  const fallbackMs = Math.max(STORY_HOLD_DURATION_MS, Math.min(STORY_MAX_HOLD_DURATION_MS, readingTimeMs));
  if (authoredDurationMs === undefined) return fallbackMs;
  const authoredMs = quantizeStoryMilliseconds(authoredDurationMs);
  return authoredMs > 0 ? authoredMs : fallbackMs;
}

export function cumulativeStoryStepOffsets(holdDurationsMs: readonly number[]) {
  let nextOffsetMs = 0;
  return holdDurationsMs.map(holdDurationMs => {
    const offsetMs = nextOffsetMs;
    nextOffsetMs += STORY_MAX_FLIGHT_DURATION_MS
      + STORY_ARRIVAL_SETTLE_MS
      + Math.max(1, quantizeStoryMilliseconds(holdDurationMs));
    return offsetMs;
  });
}

/** Conservative launcher estimate; responsive flights may complete sooner. */
export function estimateStoryDuration(holdDurationsMs: readonly number[]) {
  return holdDurationsMs.reduce((total, holdMs) => total
    + STORY_MAX_FLIGHT_DURATION_MS
    + STORY_ARRIVAL_SETTLE_MS
    + Math.max(1, quantizeStoryMilliseconds(holdMs)), 0);
}

export function formatStoryDuration(durationMs: number) {
  const seconds = Math.max(1, Math.ceil(quantizeStoryMilliseconds(durationMs) / 1_000));
  return seconds < 60 ? `${seconds} sec` : `${Math.ceil(seconds / 60)} min`;
}

export function easeStoryFlight(progress: number) {
  const value = Math.max(0, Math.min(1, progress));
  return value < 0.5
    ? 4 * value ** 3
    : 1 - (-2 * value + 2) ** 3 / 2;
}

export function storyFlightDuration(source: Camera, target: Camera, viewport: StoryViewport) {
  const anchorDistancePixels = Math.hypot(target.x - source.x, target.y - source.y)
    * target.zoom;
  if (anchorDistancePixels <= 0.5 && Math.abs(target.zoom - source.zoom) <= 0.001) return 0;
  const diagonal = Math.max(1, Math.hypot(viewport.width, viewport.height));
  const travelPixels = Math.hypot(target.x - source.x, target.y - source.y)
    * Math.min(source.zoom, target.zoom);
  const viewportDiagonals = travelPixels / diagonal;
  const zoomStops = Math.abs(Math.log2(target.zoom / source.zoom));
  return Math.max(480, Math.min(
    STORY_MAX_FLIGHT_DURATION_MS,
    Math.round(520 + 180 * Math.min(2, viewportDiagonals) + 140 * Math.min(2, zoomStops)),
  ));
}

function storyOverviewZoom(source: Camera, target: Camera, viewport: StoryViewport) {
  const diagonal = Math.max(1, Math.hypot(viewport.width, viewport.height));
  const travelPixels = Math.hypot(target.x - source.x, target.y - source.y)
    * Math.min(source.zoom, target.zoom);
  const zoomStops = Math.abs(Math.log2(target.zoom / source.zoom));
  if (travelPixels / diagonal <= 1 && zoomStops <= 1) return undefined;
  const sourceHalfWidth = viewport.width / source.zoom / 2;
  const sourceHalfHeight = viewport.height / source.zoom / 2;
  const targetHalfWidth = viewport.width / target.zoom / 2;
  const targetHalfHeight = viewport.height / target.zoom / 2;
  const unionWidth = Math.max(
    1,
    Math.max(source.x + sourceHalfWidth, target.x + targetHalfWidth)
      - Math.min(source.x - sourceHalfWidth, target.x - targetHalfWidth),
  );
  const unionHeight = Math.max(
    1,
    Math.max(source.y + sourceHalfHeight, target.y + targetHalfHeight)
      - Math.min(source.y - sourceHalfHeight, target.y - targetHalfHeight),
  );
  return Math.max(0.01, Math.min(
    source.zoom,
    target.zoom,
    viewport.width / unionWidth,
    viewport.height / unionHeight,
  ) * 0.92);
}

export function createStoryFlight(
  source: Camera,
  target: Camera,
  viewport: StoryViewport,
  nowMs: number,
  options: {
    durationMs?: number;
    elapsedMs?: number;
    running?: boolean;
    canonicalDurationMs?: number;
    canonicalElapsedMs?: number;
  } = {},
): StoryFlight {
  const durationMs = quantizeStoryMilliseconds(
    options.durationMs ?? storyFlightDuration(source, target, viewport),
  );
  const overviewZoom = storyOverviewZoom(source, target, viewport);
  return {
    source: { ...source },
    target: { ...target },
    ...(overviewZoom !== undefined
      ? { overviewZoom }
      : {}),
    durationMs,
    elapsedMs: Math.min(durationMs, quantizeStoryMilliseconds(options.elapsedMs ?? 0)),
    canonicalDurationMs: quantizeStoryMilliseconds(options.canonicalDurationMs ?? durationMs),
    canonicalElapsedMs: quantizeStoryMilliseconds(options.canonicalElapsedMs ?? options.elapsedMs ?? 0),
    startedAtMs: quantizeStoryMilliseconds(nowMs),
    running: options.running ?? true,
  };
}

export function sampleStoryFlight(flight: StoryFlight, nowMs: number): StoryFlightSample {
  const elapsedSinceStart = flight.running
    ? Math.max(0, quantizeStoryMilliseconds(nowMs) - flight.startedAtMs)
    : 0;
  const segmentElapsedMs = Math.min(flight.durationMs, flight.elapsedMs + elapsedSinceStart);
  const elapsedMs = Math.min(
    flight.canonicalDurationMs,
    flight.canonicalElapsedMs + elapsedSinceStart,
  );
  const segmentProgress = flight.durationMs === 0 ? 1 : segmentElapsedMs / flight.durationMs;
  const progress = flight.canonicalDurationMs === 0 ? 1 : elapsedMs / flight.canonicalDurationMs;
  const easedProgress = easeStoryFlight(segmentProgress);
  const sourceLogZoom = Math.log(flight.source.zoom);
  const targetLogZoom = Math.log(flight.target.zoom);
  const zoom = flight.overviewZoom === undefined
    ? Math.exp(sourceLogZoom + (targetLogZoom - sourceLogZoom) * easedProgress)
    : easedProgress <= 0.5
      ? Math.exp(sourceLogZoom + (Math.log(flight.overviewZoom) - sourceLogZoom) * easedProgress * 2)
      : Math.exp(Math.log(flight.overviewZoom) + (targetLogZoom - Math.log(flight.overviewZoom)) * (easedProgress - 0.5) * 2);
  const focusStartMs = Math.max(0, flight.canonicalDurationMs - STORY_FOCUS_TRANSITION_MS);
  const visualLinear = (elapsedMs - focusStartMs) / STORY_FOCUS_TRANSITION_MS;
  const sampledCamera = flight.frozenCamera ? { ...flight.frozenCamera } : {
      x: flight.source.x + (flight.target.x - flight.source.x) * easedProgress,
      y: flight.source.y + (flight.target.y - flight.source.y) * easedProgress,
      zoom,
    };
  return {
    camera: !flight.frozenCamera && elapsedMs >= flight.canonicalDurationMs
      ? { ...flight.target }
      : sampledCamera,
    elapsedMs,
    segmentElapsedMs,
    progress,
    easedProgress,
    visualProgress: easeStoryFlight(visualLinear),
    departureProgress: easeStoryFlight(elapsedMs / 120),
    arrived: elapsedMs >= flight.canonicalDurationMs,
  };
}

export function pauseStoryFlight(flight: StoryFlight, nowMs: number) {
  const sample = sampleStoryFlight(flight, nowMs);
  return {
    flight: {
      ...flight,
      elapsedMs: sample.segmentElapsedMs,
      canonicalElapsedMs: sample.elapsedMs,
      startedAtMs: quantizeStoryMilliseconds(nowMs),
      running: false,
      frozenCamera: { ...sample.camera },
    },
    sample,
  };
}

/** Freeze the last frame actually committed to the UI, independent of how long
 * neighborhood preparation took. No URL/history write belongs to this operation.
 */
export function freezeCommittedStoryFlight(flight: StoryFlight, sample: StoryFlightSample, liveCamera: Camera, nowMs: number) {
  return {
    flight: { ...flight, elapsedMs: sample.segmentElapsedMs, canonicalElapsedMs: sample.elapsedMs,
      startedAtMs: quantizeStoryMilliseconds(nowMs), running: false, frozenCamera: { ...liveCamera } },
    sample: { ...sample, camera: { ...liveCamera } },
  };
}

export function resumeStoryFlight(
  flight: StoryFlight,
  liveCamera: Camera,
  viewport: StoryViewport,
  nowMs: number,
) {
  const remainingMs = Math.max(1, flight.durationMs - flight.elapsedMs);
  const canonicalRemainingMs = Math.max(0, flight.canonicalDurationMs - flight.canonicalElapsedMs);
  return createStoryFlight(liveCamera, flight.target, viewport, nowMs, {
    durationMs: canonicalRemainingMs || remainingMs,
    canonicalDurationMs: flight.canonicalDurationMs,
    canonicalElapsedMs: flight.canonicalElapsedMs,
  });
}

export function createStoryArrivalClock(
  nowMs: number,
  options: { holdElapsedMs?: number; holdDurationMs?: number; playHoldAfterArrival?: boolean; reducedMotion?: boolean } = {},
): StoryArrivalHoldClock {
  const holdDurationMs = Math.max(1, quantizeStoryMilliseconds(options.holdDurationMs ?? STORY_HOLD_DURATION_MS));
  return {
    phase: 'arrival',
    phaseElapsedMs: 0,
    holdElapsedMs: Math.min(holdDurationMs, quantizeStoryMilliseconds(options.holdElapsedMs ?? 0)),
    startedAtMs: quantizeStoryMilliseconds(nowMs),
    running: true,
    playHoldAfterArrival: options.playHoldAfterArrival ?? false,
    holdDurationMs,
  };
}

export function sampleStoryArrivalClock(clock: StoryArrivalHoldClock, nowMs: number): StoryArrivalHoldSample {
  const elapsedSinceStart = clock.running
    ? Math.max(0, quantizeStoryMilliseconds(nowMs) - clock.startedAtMs)
    : 0;
  if (clock.phase === 'arrival') {
    const totalArrival = clock.phaseElapsedMs + elapsedSinceStart;
    if (totalArrival < STORY_ARRIVAL_SETTLE_MS) {
      return {
        phase: 'arrival',
        phaseElapsedMs: totalArrival,
        holdElapsedMs: clock.holdElapsedMs,
        arrived: false,
        holdComplete: false,
      };
    }
    const holdOverflow = clock.playHoldAfterArrival
      ? totalArrival - STORY_ARRIVAL_SETTLE_MS
      : 0;
    const holdElapsedMs = Math.min(clock.holdDurationMs, clock.holdElapsedMs + holdOverflow);
    return {
      phase: 'hold',
      phaseElapsedMs: holdElapsedMs,
      holdElapsedMs,
      arrived: true,
      holdComplete: holdElapsedMs >= clock.holdDurationMs,
    };
  }
  const holdElapsedMs = Math.min(
    clock.holdDurationMs,
    clock.holdElapsedMs + elapsedSinceStart,
  );
  return {
    phase: 'hold',
    phaseElapsedMs: holdElapsedMs,
    holdElapsedMs,
    arrived: true,
    holdComplete: holdElapsedMs >= clock.holdDurationMs,
  };
}

export function storyCinematicPosition(
  step: number,
  phase: 'flight' | 'arrival' | 'hold',
  elapsedMs: number,
  flightDurationMs = STORY_MAX_FLIGHT_DURATION_MS,
  holdDurationMs = STORY_HOLD_DURATION_MS,
  stepOffsetMs = Math.max(0, step) * (STORY_MAX_FLIGHT_DURATION_MS + STORY_ARRIVAL_SETTLE_MS + STORY_MAX_HOLD_DURATION_MS),
) {
  const local = phase === 'flight'
    ? Math.round(
        Math.max(0, Math.min(1, flightDurationMs === 0 ? 1 : elapsedMs / flightDurationMs))
          * STORY_MAX_FLIGHT_DURATION_MS,
      )
    : phase === 'arrival'
      ? STORY_MAX_FLIGHT_DURATION_MS + Math.min(STORY_ARRIVAL_SETTLE_MS, quantizeStoryMilliseconds(elapsedMs))
      : STORY_MAX_FLIGHT_DURATION_MS + STORY_ARRIVAL_SETTLE_MS + Math.min(holdDurationMs, quantizeStoryMilliseconds(elapsedMs));
  return stepOffsetMs + local;
}

export function decodeStoryCinematicPosition(
  step: number,
  positionMs: number,
  holdDurationMs = STORY_HOLD_DURATION_MS,
  stepOffsetMs = Math.max(0, step) * (STORY_MAX_FLIGHT_DURATION_MS + STORY_ARRIVAL_SETTLE_MS + STORY_MAX_HOLD_DURATION_MS),
) {
  const local = Math.max(0, quantizeStoryMilliseconds(positionMs) - stepOffsetMs);
  if (local < STORY_MAX_FLIGHT_DURATION_MS) {
    return {
      phase: 'flight' as const,
      elapsedMs: local,
      progress: local / STORY_MAX_FLIGHT_DURATION_MS,
    };
  }
  if (local < STORY_MAX_FLIGHT_DURATION_MS + STORY_ARRIVAL_SETTLE_MS) {
    return { phase: 'arrival' as const, elapsedMs: local - STORY_MAX_FLIGHT_DURATION_MS };
  }
  return {
    phase: 'hold' as const,
    elapsedMs: Math.min(
      holdDurationMs,
      local - STORY_MAX_FLIGHT_DURATION_MS - STORY_ARRIVAL_SETTLE_MS,
    ),
  };
}
