import assert from 'node:assert/strict';
import test from 'node:test';
import type { NodeLayout, Point } from './model.js';
import {
  expandRoutingRect,
  routeOrthogonal,
  routeOrthogonalWithIntent,
  segmentIntersectsRectInterior,
  orthogonalGridBlockage,
} from './orthogonal-router.js';

function assertOrthogonal(points: readonly Point[]) {
  assert.ok(points.length >= 2 && points.length <= 16);
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    assert.ok(from.x === to.x || from.y === to.y, `segment ${index} must be orthogonal`);
    assert.notDeepEqual(from, to, `segment ${index} must have non-zero length`);
  }
}

function pointOnBoundary(point: Point, bounds: NodeLayout): boolean {
  const withinX = point.x >= bounds.x && point.x <= bounds.x + bounds.width;
  const withinY = point.y >= bounds.y && point.y <= bounds.y + bounds.height;
  return (withinY && (point.x === bounds.x || point.x === bounds.x + bounds.width))
    || (withinX && (point.y === bounds.y || point.y === bounds.y + bounds.height));
}

function assertAvoids(points: readonly Point[], bounds: NodeLayout) {
  for (let index = 0; index < points.length - 1; index += 1) {
    assert.equal(
      segmentIntersectsRectInterior(points[index]!, points[index + 1]!, bounds),
      false,
      `segment ${index} must avoid ${JSON.stringify(bounds)}`,
    );
  }
}

function pointOnPolyline(point: Point, points: readonly Point[]): boolean {
  return points.slice(0, -1).some((from, index) => {
    const to = points[index + 1]!;
    if (from.x === to.x && point.x === from.x) {
      return point.y >= Math.min(from.y, to.y) && point.y <= Math.max(from.y, to.y);
    }
    if (from.y === to.y && point.y === from.y) {
      return point.x >= Math.min(from.x, to.x) && point.x <= Math.max(from.x, to.x);
    }
    return false;
  });
}

test('routes deterministically around padded interiors with exact boundary endpoints', () => {
  const source = { x: 0, y: 40, width: 20, height: 20 };
  const target = { x: 160, y: 40, width: 20, height: 20 };
  const obstacles = [
    { id: 'center', bounds: { x: 70, y: 20, width: 40, height: 60 } },
    { id: 'lower', bounds: { x: 120, y: 80, width: 20, height: 20 } },
  ];
  const first = routeOrthogonal({ source, target, obstacles, clearance: 10 });
  const reversed = routeOrthogonal({ source, target, obstacles: [...obstacles].reverse(), clearance: 10 });

  assert.deepEqual(reversed, first);
  assert.equal(first.diagnostic, 'grid');
  assertOrthogonal(first.points);
  assert.equal(pointOnBoundary(first.points[0]!, source), true);
  assert.equal(pointOnBoundary(first.points.at(-1)!, target), true);
  assertAvoids(first.points, expandRoutingRect(obstacles[0]!.bounds, 10));
  assertAvoids(first.points, expandRoutingRect(obstacles[1]!.bounds, 10));
});

test('stable lane offsets separate parallel routes without moving endpoints off their nodes', () => {
  const source = { x: 0, y: 0, width: 30, height: 30 };
  const target = { x: 120, y: 0, width: 30, height: 30 };
  const upper = routeOrthogonal({ source, target, obstacles: [], clearance: 8, laneOffset: -6 });
  const lower = routeOrthogonal({ source, target, obstacles: [], clearance: 8, laneOffset: 6 });

  assert.notDeepEqual(upper.points, lower.points);
  for (const result of [upper, lower]) {
    assertOrthogonal(result.points);
    assert.equal(pointOnBoundary(result.points[0]!, source), true);
    assert.equal(pointOnBoundary(result.points.at(-1)!, target), true);
  }
});

test('bounded search reports a deterministic obstacle-safe exterior corridor fallback', () => {
  const source = { x: 0, y: 0, width: 20, height: 20 };
  const target = { x: 400, y: 0, width: 20, height: 20 };
  const obstacles = Array.from({ length: 8 }, (_, index) => ({
    id: `obstacle:${index}`,
    bounds: { x: 50 + index * 35, y: 55 + index * 17, width: 14, height: 14 },
  }));
  const result = routeOrthogonal({
    source,
    target,
    obstacles,
    clearance: 6,
    maxGridNodes: 64,
    maxPoints: 16,
  });

  assert.equal(result.diagnostic, 'exterior-corridor');
  assertOrthogonal(result.points);
  assert.equal(pointOnBoundary(result.points[0]!, source), true);
  assert.equal(pointOnBoundary(result.points.at(-1)!, target), true);
  for (const obstacle of obstacles) assertAvoids(result.points, expandRoutingRect(obstacle.bounds, 6));
});

test('guided routes honor preferred boundary ports and ordered orthogonal waypoints', () => {
  const source = { x: 0, y: 40, width: 20, height: 20 };
  const target = { x: 160, y: 40, width: 20, height: 20 };
  const center = { id: 'center', bounds: { x: 70, y: 20, width: 40, height: 60 } };
  const guides = [{ x: 40, y: 0 }, { x: 140, y: 0 }];
  const result = routeOrthogonalWithIntent({
    source,
    target,
    obstacles: [center],
    clearance: 10,
  }, {
    sourcePort: 'top',
    targetPort: 'top',
    waypoints: guides,
  });

  assert.equal(result.status, 'applied');
  assertOrthogonal(result.points);
  assert.deepEqual(result.points[0], { x: 10, y: 40 });
  assert.deepEqual(result.points.at(-1), { x: 170, y: 40 });
  for (const guide of guides) assert.equal(pointOnPolyline(guide, result.points), true);
  assertAvoids(result.points, expandRoutingRect(center.bounds, 10));
});

test('invalid and stale guidance deterministically degrades to the automatic safe route', () => {
  const options = {
    source: { x: 0, y: 40, width: 20, height: 20 },
    target: { x: 160, y: 40, width: 20, height: 20 },
    obstacles: [{ id: 'center', bounds: { x: 70, y: 20, width: 40, height: 60 } }],
    clearance: 10,
  };
  const automatic = routeOrthogonal(options);
  const stale = routeOrthogonalWithIntent(options, {
    waypoints: [{ x: 80, y: 40 }],
  });
  assert.equal(stale.status, 'fallback');
  assert.equal(stale.reason, 'waypoint-inside-obstacle');
  assert.deepEqual({
    points: stale.points,
    diagnostic: stale.diagnostic,
    exploredStates: stale.exploredStates,
  }, automatic);

  const malformed = routeOrthogonalWithIntent(options, {
    sourcePort: 'diagonal' as 'top',
    waypoints: [],
  });
  assert.equal(malformed.status, 'fallback');
  assert.equal(malformed.reason, 'invalid-port');
  assert.deepEqual(malformed.points, automatic.points);

  const empty = routeOrthogonalWithIntent(options, { waypoints: [] });
  assert.equal(empty.status, 'fallback');
  assert.equal(empty.reason, 'unroutable-guidance');
  assert.deepEqual(empty.points, automatic.points);
});

test('CLA-385: indexed grid blockage marks exactly what the per-obstacle predicates reject', () => {
  const EPSILON = 1e-9;
  const inside = (point: Point, rect: NodeLayout) => point.x > rect.x + EPSILON && point.x < rect.x + rect.width - EPSILON
    && point.y > rect.y + EPSILON && point.y < rect.y + rect.height - EPSILON;
  const unique = (values: number[]) => [...values].sort((a, b) => a - b).filter((value, index, sorted) => index === 0 || Math.abs(value - sorted[index - 1]!) > EPSILON);
  let seed = 385;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let trial = 0; trial < 600; trial += 1) {
    // A coarse lattice makes coincident and touching edges common; tiny offsets probe EPSILON.
    const coordinate = () => Math.floor(random() * 12) * 10 + (random() < .2 ? (random() < .5 ? 1 : -1) * EPSILON * [.5, 1, 2][Math.floor(random() * 3)]! : 0);
    const obstacles: NodeLayout[] = Array.from({ length: 1 + Math.floor(random() * 7) }, () => {
      const x = coordinate(); const y = coordinate();
      return { x, y, width: random() < .1 ? 0 : Math.max(0, coordinate() - x + 10), height: random() < .1 ? 0 : Math.max(0, coordinate() - y + 10) };
    });
    const xs = unique([0, 130, coordinate(), ...obstacles.flatMap(rect => [rect.x, rect.x + rect.width])]);
    const ys = unique([0, 130, coordinate(), ...obstacles.flatMap(rect => [rect.y, rect.y + rect.height])]);
    const blocked = orthogonalGridBlockage(xs, ys, obstacles)!;
    for (let y = 0; y < ys.length; y += 1) {
      for (let x = 0; x < xs.length; x += 1) {
        const node = y * xs.length + x;
        const at = { x: xs[x]!, y: ys[y]! };
        assert.equal(blocked.point[node] === 1, obstacles.some(rect => inside(at, rect)), `point ${trial}/${node}`);
        if (x + 1 < xs.length) assert.equal(blocked.right[node] === 1,
          obstacles.some(rect => segmentIntersectsRectInterior(at, { x: xs[x + 1]!, y: ys[y]! }, rect)), `right ${trial}/${node}`);
        if (y + 1 < ys.length) assert.equal(blocked.down[node] === 1,
          obstacles.some(rect => segmentIntersectsRectInterior(at, { x: xs[x]!, y: ys[y + 1]! }, rect)), `down ${trial}/${node}`);
      }
    }
  }
  assert.equal(orthogonalGridBlockage([0, 1], [0, 1], [{ x: Number.NaN, y: 0, width: 1, height: 1 }]), undefined);
});
