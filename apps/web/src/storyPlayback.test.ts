import { describe, expect, it } from 'vitest';
import {
  STORY_ARRIVAL_SETTLE_MS,
  STORY_HOLD_DURATION_MS,
  STORY_MAX_FLIGHT_DURATION_MS,
  createStoryFlight,
  createStoryArrivalClock,
  cumulativeStoryStepOffsets,
  decodeStoryCinematicPosition,
  estimateStoryDuration,
  formatStoryDuration,
  pauseStoryFlight,
  freezeCommittedStoryFlight,
  resumeStoryFlight,
  resolveStoryHoldDuration,
  sampleStoryArrivalClock,
  sampleStoryFlight,
  storyFlightDuration,
  storyCinematicPosition,
} from './storyPlayback';

const viewport = { width: 1_200, height: 800 };

describe('cinematic story flight sampling', () => {
  it('interpolates world center linearly and zoom logarithmically after easing', () => {
    const flight = createStoryFlight(
      { x: 0, y: 0, zoom: 1 },
      { x: 200, y: 100, zoom: 2 },
      viewport,
      1_000,
      { durationMs: 600 },
    );
    const halfway = sampleStoryFlight(flight, 1_300);
    expect(halfway).toMatchObject({ elapsedMs: 300, progress: 0.5, easedProgress: 0.5, arrived: false });
    expect(halfway.camera).toMatchObject({ x: 100, y: 50 });
    expect(halfway.camera.zoom).toBeCloseTo(Math.SQRT2, 12);
    expect(sampleStoryFlight(flight, 1_600).camera).toEqual({ x: 200, y: 100, zoom: 2 });
  });

  it('is integer-ms and direction independent', () => {
    const flight = createStoryFlight(
      { x: -50, y: 80, zoom: 0.4 },
      { x: 320, y: -40, zoom: 1.2 },
      viewport,
      10,
      { durationMs: 900 },
    );
    const positions = [0, 225, 450, 675, 900];
    const ascending = new Map(positions.map(position => [position, sampleStoryFlight(flight, 10 + position)]));
    const descending = new Map([...positions].reverse().map(position => [position, sampleStoryFlight(flight, 10 + position)]));
    expect(descending).toEqual(ascending);
  });

  it('pauses at the sampled camera and resumes the remaining flight from the live camera', () => {
    const flight = createStoryFlight(
      { x: 0, y: 0, zoom: 1 },
      { x: 300, y: 120, zoom: 2 },
      viewport,
      0,
      { durationMs: 600 },
    );
    const paused = pauseStoryFlight(flight, 240);
    expect(paused.flight.elapsedMs).toBe(240);
    expect(sampleStoryFlight(paused.flight, 400).camera).toEqual(paused.sample.camera);
    const moved = { x: paused.sample.camera.x + 30, y: paused.sample.camera.y, zoom: paused.sample.camera.zoom };
    const resumed = resumeStoryFlight(paused.flight, moved, viewport, 500);
    expect(resumed.durationMs).toBe(360);
    expect(sampleStoryFlight(resumed, 500).camera).toEqual(moved);
    expect(sampleStoryFlight(resumed, 860).camera).toEqual(flight.target);
  });

  it('uses curated adaptive durations and skips imperceptible flights', () => {
    expect(storyFlightDuration({ x: 0, y: 0, zoom: 1 }, { x: 0, y: 0, zoom: 1 }, viewport)).toBe(0);
    const short = storyFlightDuration({ x: 0, y: 0, zoom: 1 }, { x: 10, y: 10, zoom: 1 }, viewport);
    const medium = storyFlightDuration({ x: 0, y: 0, zoom: 1 }, { x: 2_000, y: 0, zoom: 1 }, viewport);
    const long = storyFlightDuration({ x: 0, y: 0, zoom: 0.25 }, { x: 12_000, y: 0, zoom: 1 }, viewport);
    expect(short).toBeGreaterThanOrEqual(480);
    expect(medium).toBeGreaterThan(short);
    expect(long).toBe(1_100);
  });

  it('widens a long route to an overview before closing on the target', () => {
    const source = { x: 0, y: 0, zoom: 2 };
    const target = { x: 4_000, y: 0, zoom: 2 };
    const flight = createStoryFlight(source, target, viewport, 0, { durationMs: 1_100 });
    const midpoint = sampleStoryFlight(flight, 550);
    expect(flight.overviewZoom).toBeDefined();
    expect(midpoint.camera.x).toBe(2_000);
    expect(midpoint.camera.zoom).toBeLessThan(source.zoom);
    expect(sampleStoryFlight(flight, 1_100).camera).toEqual(target);
  });

  it('starts the hold only after the arrival barrier and preserves prior hold elapsed', () => {
    const clock = createStoryArrivalClock(1_000, { holdElapsedMs: 900, playHoldAfterArrival: true });
    expect(sampleStoryArrivalClock(clock, 1_000 + STORY_ARRIVAL_SETTLE_MS - 1)).toMatchObject({
      phase: 'arrival',
      holdElapsedMs: 900,
    });
    expect(sampleStoryArrivalClock(clock, 1_000 + STORY_ARRIVAL_SETTLE_MS)).toMatchObject({
      phase: 'hold',
      holdElapsedMs: 900,
    });
    expect(sampleStoryArrivalClock(clock, 1_000 + STORY_ARRIVAL_SETTLE_MS + STORY_HOLD_DURATION_MS)).toMatchObject({
      phase: 'hold',
      holdComplete: true,
    });
  });

  it('resolves deterministic narration holds with authoritative authored durations', () => {
    expect(resolveStoryHoldDuration('short narration')).toBe(4_200);
    expect(resolveStoryHoldDuration(Array.from({ length: 18 }, () => 'word').join(' '))).toBe(7_200);
    expect(resolveStoryHoldDuration('short narration', 8_000)).toBe(8_000);
    expect(resolveStoryHoldDuration('short narration', 1_800)).toBe(1_800);
    expect(resolveStoryHoldDuration(Array.from({ length: 60 }, () => 'word').join(' '))).toBe(12_000);
  });

  it('derives the launcher duration from narration holds and transition budgets', () => {
    expect(estimateStoryDuration([1_600, 1_800, 1_800, 2_000])).toBe(12_200);
    expect(formatStoryDuration(12_200)).toBe('13 sec');
    expect(formatStoryDuration(60_001)).toBe('2 min');
  });

  it('round-trips holds over twelve seconds with cumulative non-overlapping step offsets', () => {
    const holds = [1_800, 15_000, 4_200];
    const offsets = cumulativeStoryStepOffsets(holds);
    expect(offsets).toEqual([
      0,
      STORY_MAX_FLIGHT_DURATION_MS + STORY_ARRIVAL_SETTLE_MS + 1_800,
      (STORY_MAX_FLIGHT_DURATION_MS + STORY_ARRIVAL_SETTLE_MS) * 2 + 16_800,
    ]);
    const positionMs = storyCinematicPosition(
      1,
      'hold',
      14_999,
      STORY_MAX_FLIGHT_DURATION_MS,
      holds[1],
      offsets[1],
    );
    expect(decodeStoryCinematicPosition(1, positionMs, holds[1], offsets[1])).toEqual({
      phase: 'hold',
      elapsedMs: 14_999,
    });
    expect(positionMs).toBeLessThan(offsets[2]);
  });
});

it('freezes the committed flight sample through a long restore delay and resumes only its remaining canonical duration', () => {
  const flight = createStoryFlight({ x: 0, y: 0, zoom: 1 }, { x: 200, y: 100, zoom: 2 }, viewport, 1000, { durationMs: 600 });
  const committed = sampleStoryFlight(flight, 1250);
  const live = { ...committed.camera, x: committed.camera.x + 4 };
  const frozen = freezeCommittedStoryFlight(flight, committed, live, 9000);
  expect(frozen.flight.running).toBe(false);
  expect(frozen.flight.canonicalElapsedMs).toBe(250);
  expect(frozen.flight.frozenCamera).toEqual(live);
  expect(sampleStoryFlight(frozen.flight, 20000).elapsedMs).toBe(250);
  const resumed = resumeStoryFlight(frozen.flight, live, viewport, 20000);
  expect(resumed.durationMs).toBe(350);
  expect(sampleStoryFlight(resumed, 20000).elapsedMs).toBe(250);
  expect(sampleStoryFlight(resumed, 20350).elapsedMs).toBe(600);
});
