import type { NodeLayout, Point } from './model.js';

export type OrthogonalSide = 'top' | 'right' | 'bottom' | 'left';

export type OrthogonalObstacle = {
  id: string;
  bounds: NodeLayout;
};

export type OrthogonalRouteDiagnostic = 'grid' | 'exterior-corridor' | 'direct-fallback';

export type OrthogonalRouteResult = {
  points: Point[];
  diagnostic: OrthogonalRouteDiagnostic;
  exploredStates: number;
};

export type OrthogonalRouteOptions = {
  source: NodeLayout;
  target: NodeLayout;
  obstacles: readonly OrthogonalObstacle[];
  domain?: NodeLayout;
  clearance: number;
  laneOffset?: number;
  maxPoints?: number;
  maxGridNodes?: number;
};

export type OrthogonalRouteIntent = {
  sourcePort?: OrthogonalSide;
  targetPort?: OrthogonalSide;
  waypoints: Point[];
};

export type GuidedOrthogonalRouteReason =
  | 'invalid-port'
  | 'non-finite-waypoint'
  | 'waypoint-outside-domain'
  | 'waypoint-inside-obstacle'
  | 'unroutable-guidance';

export type GuidedOrthogonalRouteResult = OrthogonalRouteResult & {
  status: 'auto' | 'applied' | 'fallback';
  reason?: GuidedOrthogonalRouteReason;
};

const EPSILON = 1e-9;

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function expandRoutingRect(bounds: NodeLayout, padding: number): NodeLayout {
  return {
    x: bounds.x - padding,
    y: bounds.y - padding,
    width: bounds.width + padding * 2,
    height: bounds.height + padding * 2,
  };
}

export function segmentIntersectsRectInterior(from: Point, to: Point, bounds: NodeLayout): boolean {
  if (Math.abs(from.y - to.y) <= EPSILON) {
    const y = from.y;
    if (y <= bounds.y + EPSILON || y >= bounds.y + bounds.height - EPSILON) return false;
    return Math.max(from.x, to.x) > bounds.x + EPSILON
      && Math.min(from.x, to.x) < bounds.x + bounds.width - EPSILON;
  }
  if (Math.abs(from.x - to.x) <= EPSILON) {
    const x = from.x;
    if (x <= bounds.x + EPSILON || x >= bounds.x + bounds.width - EPSILON) return false;
    return Math.max(from.y, to.y) > bounds.y + EPSILON
      && Math.min(from.y, to.y) < bounds.y + bounds.height - EPSILON;
  }
  return true;
}

function pointInsideRect(point: Point, bounds: NodeLayout): boolean {
  return point.x > bounds.x + EPSILON
    && point.x < bounds.x + bounds.width - EPSILON
    && point.y > bounds.y + EPSILON
    && point.y < bounds.y + bounds.height - EPSILON;
}

function dedupeSorted(values: readonly number[]): number[] {
  return [...values].sort((left, right) => left - right).filter((value, index, sorted) => (
    index === 0 || Math.abs(value - sorted[index - 1]!) > EPSILON
  ));
}

function samePoint(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) <= EPSILON && Math.abs(left.y - right.y) <= EPSILON;
}

export function simplifyOrthogonalPoints(points: readonly Point[]): Point[] {
  const deduped = points.filter((point, index) => index === 0 || !samePoint(point, points[index - 1]!));
  const result: Point[] = [];
  for (const point of deduped) {
    while (result.length >= 2) {
      const before = result[result.length - 2]!;
      const previous = result[result.length - 1]!;
      const collinear = (Math.abs(before.x - previous.x) <= EPSILON && Math.abs(previous.x - point.x) <= EPSILON)
        || (Math.abs(before.y - previous.y) <= EPSILON && Math.abs(previous.y - point.y) <= EPSILON);
      if (!collinear) break;
      result.pop();
    }
    result.push({ ...point });
  }
  return result;
}

function sidePoint(bounds: NodeLayout, side: OrthogonalSide, offset: number): Point {
  const horizontalLimit = Math.max(0, bounds.width / 2 - EPSILON);
  const verticalLimit = Math.max(0, bounds.height / 2 - EPSILON);
  if (side === 'top' || side === 'bottom') {
    return {
      x: bounds.x + bounds.width / 2 + Math.max(-horizontalLimit, Math.min(horizontalLimit, offset)),
      y: side === 'top' ? bounds.y : bounds.y + bounds.height,
    };
  }
  return {
    x: side === 'left' ? bounds.x : bounds.x + bounds.width,
    y: bounds.y + bounds.height / 2 + Math.max(-verticalLimit, Math.min(verticalLimit, offset)),
  };
}

function port(bounds: NodeLayout, side: OrthogonalSide, clearance: number, offset: number) {
  const endpoint = sidePoint(bounds, side, offset);
  const stub = {
    x: endpoint.x + (side === 'left' ? -clearance : side === 'right' ? clearance : 0),
    y: endpoint.y + (side === 'top' ? -clearance : side === 'bottom' ? clearance : 0),
  };
  return { side, endpoint, stub };
}

function preferredSides(from: NodeLayout, to: NodeLayout): OrthogonalSide[] {
  const dx = to.x + to.width / 2 - (from.x + from.width / 2);
  const dy = to.y + to.height / 2 - (from.y + from.height / 2);
  if (Math.abs(dx) >= Math.abs(dy)) {
    const primary: OrthogonalSide = dx >= 0 ? 'right' : 'left';
    return [primary, dy >= 0 ? 'bottom' : 'top', dy >= 0 ? 'top' : 'bottom', primary === 'right' ? 'left' : 'right'];
  }
  const primary: OrthogonalSide = dy >= 0 ? 'bottom' : 'top';
  return [primary, dx >= 0 ? 'right' : 'left', dx >= 0 ? 'left' : 'right', primary === 'bottom' ? 'top' : 'bottom'];
}

type HeapValue = {
  state: number;
  cost: number;
  bends: number;
  length: number;
};

class MinHeap {
  private readonly values: HeapValue[] = [];

  get size() { return this.values.length; }

  push(value: HeapValue) {
    this.values.push(value);
    let index = this.values.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareHeap(this.values[parent]!, value) <= 0) break;
      this.values[index] = this.values[parent]!;
      index = parent;
    }
    this.values[index] = value;
  }

  pop(): HeapValue | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (!first || !last || this.values.length === 0) return first;
    let index = 0;
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      if (left >= this.values.length) break;
      const child = right < this.values.length && compareHeap(this.values[right]!, this.values[left]!) < 0 ? right : left;
      if (compareHeap(last, this.values[child]!) <= 0) break;
      this.values[index] = this.values[child]!;
      index = child;
    }
    this.values[index] = last;
    return first;
  }
}

function compareHeap(left: HeapValue, right: HeapValue): number {
  return left.cost - right.cost
    || left.bends - right.bends
    || left.length - right.length
    || left.state - right.state;
}

/** First index whose value satisfies a predicate that is false then true along sorted values. */
function firstIndex(values: readonly number[], test: (value: number) => boolean): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (test(values[middle]!)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/**
 * Grid points strictly inside an obstacle, and grid edges crossing an obstacle's
 * interior, marked once per route instead of testing every obstacle on every A*
 * expansion. xs and ys are strictly ascending (dedupeSorted), so the grid lines
 * strictly inside an obstacle form one contiguous index range; the bounds use the same strict EPSILON comparisons as
 * pointInsideRect and segmentIntersectsRectInterior, so the marks are identical.
 * Non-finite obstacles return undefined and keep the direct per-test path.
 * Exported for the equivalence test against those predicates.
 */
export function orthogonalGridBlockage(xs: readonly number[], ys: readonly number[], obstacles: readonly NodeLayout[]) {
  if (!obstacles.every(value => Number.isFinite(value.x) && Number.isFinite(value.y) && Number.isFinite(value.width) && Number.isFinite(value.height))) return undefined;
  const width = xs.length;
  const height = ys.length;
  const point = new Uint8Array(width * height);
  // right[n]: edge n -> n + 1 (same row); down[n]: edge n -> n + width (same column).
  const right = new Uint8Array(width * height);
  const down = new Uint8Array(width * height);
  for (const obstacle of obstacles) {
    const left = obstacle.x + EPSILON;
    const rightEdge = obstacle.x + obstacle.width - EPSILON;
    const top = obstacle.y + EPSILON;
    const bottom = obstacle.y + obstacle.height - EPSILON;
    // Columns/rows strictly inside (left, rightEdge) / (top, bottom).
    const insideX0 = firstIndex(xs, value => value > left);
    const insideX1 = firstIndex(xs, value => value >= rightEdge);
    const insideY0 = firstIndex(ys, value => value > top);
    const insideY1 = firstIndex(ys, value => value >= bottom);
    // Spans [i, i + 1] with xs[i + 1] > left and xs[i] < rightEdge (likewise ys).
    const spanX0 = Math.max(0, insideX0 - 1);
    const spanX1 = Math.min(width - 1, insideX1);
    const spanY0 = Math.max(0, insideY0 - 1);
    const spanY1 = Math.min(height - 1, insideY1);
    for (let y = insideY0; y < insideY1; y += 1) {
      const row = y * width;
      for (let x = insideX0; x < insideX1; x += 1) point[row + x] = 1;
      for (let x = spanX0; x < spanX1; x += 1) right[row + x] = 1;
    }
    for (let y = spanY0; y < spanY1; y += 1) {
      const row = y * width;
      for (let x = insideX0; x < insideX1; x += 1) down[row + x] = 1;
    }
  }
  return { point, right, down };
}

type GridPath = { points: Point[]; cost: number; bends: number; length: number; explored: number };

function pathMetrics(points: readonly Point[], bendPenalty: number): Pick<GridPath, 'cost' | 'bends' | 'length'> {
  let bends = 0;
  let length = 0;
  let previousDirection = 0;
  for (let index = 0; index < points.length - 1; index += 1) {
    const from = points[index]!;
    const to = points[index + 1]!;
    const direction = Math.abs(from.y - to.y) <= EPSILON ? 1 : 2;
    if (previousDirection !== 0 && previousDirection !== direction) bends += 1;
    previousDirection = direction;
    length += Math.abs(to.x - from.x) + Math.abs(to.y - from.y);
  }
  return { bends, length, cost: length + bends * bendPenalty };
}

function findGridPath(
  start: Point,
  end: Point,
  obstacles: readonly NodeLayout[],
  domain: NodeLayout,
  maxGridNodes: number,
  bendPenalty: number,
): GridPath | undefined {
  const xs = dedupeSorted([
    domain.x,
    domain.x + domain.width,
    start.x,
    end.x,
    ...obstacles.flatMap(value => [value.x, value.x + value.width]),
  ]).filter(value => value >= domain.x - EPSILON && value <= domain.x + domain.width + EPSILON);
  const ys = dedupeSorted([
    domain.y,
    domain.y + domain.height,
    start.y,
    end.y,
    ...obstacles.flatMap(value => [value.y, value.y + value.height]),
  ]).filter(value => value >= domain.y - EPSILON && value <= domain.y + domain.height + EPSILON);
  const gridSize = xs.length * ys.length;
  if (gridSize === 0 || gridSize > maxGridNodes) return undefined;
  const pointFor = (index: number): Point => ({ x: xs[index % xs.length]!, y: ys[Math.floor(index / xs.length)]! });
  const indexFor = (point: Point) => {
    const x = xs.findIndex(value => Math.abs(value - point.x) <= EPSILON);
    const y = ys.findIndex(value => Math.abs(value - point.y) <= EPSILON);
    return x < 0 || y < 0 ? -1 : y * xs.length + x;
  };
  const blocked = orthogonalGridBlockage(xs, ys, obstacles);
  const valid = new Uint8Array(gridSize);
  for (let index = 0; index < gridSize; index += 1) {
    valid[index] = blocked ? 1 - blocked.point[index]! : obstacles.some(obstacle => pointInsideRect(pointFor(index), obstacle)) ? 0 : 1;
  }
  const edgeBlocked = (node: number, next: number) => {
    if (!blocked) return obstacles.some(obstacle => segmentIntersectsRectInterior(pointFor(node), pointFor(next), obstacle));
    // Same row is a horizontal step; compare rows, since in a one-column grid node ± 1 is vertical.
    if (Math.floor(node / xs.length) === Math.floor(next / xs.length)) return blocked.right[Math.min(node, next)] === 1;
    return blocked.down[Math.min(node, next)] === 1;
  };
  const startIndex = indexFor(start);
  const endIndex = indexFor(end);
  if (startIndex < 0 || endIndex < 0 || !valid[startIndex] || !valid[endIndex]) return undefined;
  const stateCount = gridSize * 3;
  const distances = new Float64Array(stateCount).fill(Number.POSITIVE_INFINITY);
  const bendsByState = new Uint16Array(stateCount);
  const lengths = new Float64Array(stateCount);
  const previous = new Int32Array(stateCount).fill(-1);
  const heap = new MinHeap();
  const startState = startIndex * 3;
  distances[startState] = 0;
  heap.push({ state: startState, cost: 0, bends: 0, length: 0 });
  let explored = 0;
  let resultState = -1;
  while (heap.size) {
    const current = heap.pop()!;
    if (Math.abs(current.cost - distances[current.state]!) > EPSILON) continue;
    explored += 1;
    const node = Math.floor(current.state / 3);
    const direction = current.state % 3;
    if (node === endIndex) {
      resultState = current.state;
      break;
    }
    const xIndex = node % xs.length;
    const yIndex = Math.floor(node / xs.length);
    const fromX = xs[xIndex]!;
    const fromY = ys[yIndex]!;
    // Neighbours in the fixed order left, right, up, down.
    for (let candidate = 0; candidate < 4; candidate += 1) {
      const next = candidate === 0 ? (xIndex > 0 ? node - 1 : -1)
        : candidate === 1 ? (xIndex + 1 < xs.length ? node + 1 : -1)
          : candidate === 2 ? (yIndex > 0 ? node - xs.length : -1)
            : (yIndex + 1 < ys.length ? node + xs.length : -1);
      if (next < 0 || !valid[next]) continue;
      if (edgeBlocked(node, next)) continue;
      const toX = xs[next % xs.length]!;
      const toY = ys[Math.floor(next / xs.length)]!;
      const nextDirection = Math.abs(fromY - toY) <= EPSILON ? 1 : 2;
      const bend = direction !== 0 && direction !== nextDirection ? 1 : 0;
      const segmentLength = Math.abs(toX - fromX) + Math.abs(toY - fromY);
      const nextLength = current.length + segmentLength;
      const nextBends = current.bends + bend;
      const nextCost = nextLength + nextBends * bendPenalty;
      const nextState = next * 3 + nextDirection;
      const improves = nextCost < distances[nextState]! - EPSILON
        || (Math.abs(nextCost - distances[nextState]!) <= EPSILON
          && (nextBends < bendsByState[nextState]!
            || (nextBends === bendsByState[nextState]! && nextLength < lengths[nextState]! - EPSILON)));
      if (!improves) continue;
      distances[nextState] = nextCost;
      bendsByState[nextState] = nextBends;
      lengths[nextState] = nextLength;
      previous[nextState] = current.state;
      heap.push({ state: nextState, cost: nextCost, bends: nextBends, length: nextLength });
    }
  }
  if (resultState < 0) return undefined;
  const points: Point[] = [];
  for (let state = resultState; state >= 0; state = previous[state]!) {
    points.push(pointFor(Math.floor(state / 3)));
    if (state === startState) break;
  }
  points.reverse();
  return {
    points: simplifyOrthogonalPoints(points),
    cost: distances[resultState]!,
    bends: bendsByState[resultState]!,
    length: lengths[resultState]!,
    explored,
  };
}

function unionRects(rects: readonly NodeLayout[], margin: number): NodeLayout {
  const left = Math.min(...rects.map(value => value.x)) - margin;
  const top = Math.min(...rects.map(value => value.y)) - margin;
  const right = Math.max(...rects.map(value => value.x + value.width)) + margin;
  const bottom = Math.max(...rects.map(value => value.y + value.height)) + margin;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function perimeterScalar(point: Point, side: OrthogonalSide, domain: NodeLayout): number {
  const right = domain.x + domain.width;
  const bottom = domain.y + domain.height;
  if (side === 'top') return point.x - domain.x;
  if (side === 'right') return domain.width + point.y - domain.y;
  if (side === 'bottom') return domain.width + domain.height + right - point.x;
  return domain.width * 2 + domain.height + bottom - point.y;
}

function perimeterPoint(portValue: ReturnType<typeof port>, domain: NodeLayout): Point {
  if (portValue.side === 'top') return { x: portValue.stub.x, y: domain.y };
  if (portValue.side === 'right') return { x: domain.x + domain.width, y: portValue.stub.y };
  if (portValue.side === 'bottom') return { x: portValue.stub.x, y: domain.y + domain.height };
  return { x: domain.x, y: portValue.stub.y };
}

function clockwisePerimeter(from: Point, fromSide: OrthogonalSide, to: Point, toSide: OrthogonalSide, domain: NodeLayout): Point[] {
  const perimeter = (domain.width + domain.height) * 2;
  const start = perimeterScalar(from, fromSide, domain);
  let finish = perimeterScalar(to, toSide, domain);
  if (finish < start - EPSILON) finish += perimeter;
  const corners = [
    { scalar: domain.width, point: { x: domain.x + domain.width, y: domain.y } },
    { scalar: domain.width + domain.height, point: { x: domain.x + domain.width, y: domain.y + domain.height } },
    { scalar: domain.width * 2 + domain.height, point: { x: domain.x, y: domain.y + domain.height } },
    { scalar: perimeter, point: { x: domain.x, y: domain.y } },
    { scalar: perimeter + domain.width, point: { x: domain.x + domain.width, y: domain.y } },
    { scalar: perimeter + domain.width + domain.height, point: { x: domain.x + domain.width, y: domain.y + domain.height } },
    { scalar: perimeter + domain.width * 2 + domain.height, point: { x: domain.x, y: domain.y + domain.height } },
  ];
  return [from, ...corners.filter(value => value.scalar > start + EPSILON && value.scalar < finish - EPSILON).map(value => value.point), to];
}

function validRoute(
  points: readonly Point[],
  obstacles: readonly NodeLayout[],
  sourceObstacle: NodeLayout,
  targetObstacle: NodeLayout,
): boolean {
  return points.slice(0, -1).every((point, index) => {
    const next = points[index + 1]!;
    if (Math.abs(point.x - next.x) > EPSILON && Math.abs(point.y - next.y) > EPSILON) return false;
    return !obstacles.some(obstacle => {
      if (index === 0 && obstacle === sourceObstacle) return false;
      if (index === points.length - 2 && obstacle === targetObstacle) return false;
      return segmentIntersectsRectInterior(point, next, obstacle);
    });
  });
}

function exteriorRoute(
  sourcePorts: readonly ReturnType<typeof port>[],
  targetPorts: readonly ReturnType<typeof port>[],
  obstacles: readonly NodeLayout[],
  sourceObstacle: NodeLayout,
  targetObstacle: NodeLayout,
  domain: NodeLayout,
  clearance: number,
  maxPoints: number,
): Point[] | undefined {
  const exterior = expandRoutingRect(domain, clearance * 2 + 1);
  const candidates: Point[][] = [];
  for (const sourcePort of sourcePorts) {
    for (const targetPort of targetPorts) {
      const sourcePerimeter = perimeterPoint(sourcePort, exterior);
      const targetPerimeter = perimeterPoint(targetPort, exterior);
      const clockwise = clockwisePerimeter(sourcePerimeter, sourcePort.side, targetPerimeter, targetPort.side, exterior);
      const counterclockwise = [...clockwisePerimeter(targetPerimeter, targetPort.side, sourcePerimeter, sourcePort.side, exterior)].reverse();
      for (const perimeter of [clockwise, counterclockwise]) {
        const points = simplifyOrthogonalPoints([
          sourcePort.endpoint,
          sourcePort.stub,
          ...perimeter,
          targetPort.stub,
          targetPort.endpoint,
        ]);
        if (points.length <= maxPoints && validRoute(points, obstacles, sourceObstacle, targetObstacle)) candidates.push(points);
      }
    }
  }
  return candidates.sort((left, right) => {
    const length = (points: readonly Point[]) => points.slice(0, -1).reduce((sum, point, index) => (
      sum + Math.abs(points[index + 1]!.x - point.x) + Math.abs(points[index + 1]!.y - point.y)
    ), 0);
    return length(left) - length(right) || compareText(JSON.stringify(left), JSON.stringify(right));
  })[0];
}

export function routeOrthogonal(options: OrthogonalRouteOptions): OrthogonalRouteResult {
  const clearance = Math.max(EPSILON, options.clearance);
  const maxPoints = Math.max(4, options.maxPoints ?? 16);
  const maxGridNodes = Math.max(64, options.maxGridNodes ?? 20_000);
  const laneOffset = options.laneOffset ?? 0;
  const obstacleBounds = [...options.obstacles]
    .sort((left, right) => compareText(left.id, right.id))
    .map(value => expandRoutingRect(value.bounds, clearance));
  const sourceObstacle = expandRoutingRect(options.source, clearance);
  const targetObstacle = expandRoutingRect(options.target, clearance);
  const searchObstacles = [sourceObstacle, targetObstacle, ...obstacleBounds];
  const sourcePorts = preferredSides(options.source, options.target).map(side => port(options.source, side, clearance, laneOffset));
  const targetPorts = preferredSides(options.target, options.source).map(side => port(options.target, side, clearance, -laneOffset));
  const baseDomain = options.domain ?? unionRects([options.source, options.target, ...obstacleBounds], clearance * 2 + 1);
  const domain = unionRects([baseDomain, options.source, options.target], 0);
  const candidates: Array<GridPath & { points: Point[]; portRank: number }> = [];
  let exploredStates = 0;
  for (let sourceRank = 0; sourceRank < sourcePorts.length; sourceRank += 1) {
    const sourcePort = sourcePorts[sourceRank]!;
    for (let targetRank = 0; targetRank < targetPorts.length; targetRank += 1) {
      const targetPort = targetPorts[targetRank]!;
      if (pointInsideRect(sourcePort.stub, targetObstacle) || pointInsideRect(targetPort.stub, sourceObstacle)) continue;
      const result = findGridPath(
        sourcePort.stub,
        targetPort.stub,
        searchObstacles,
        domain,
        maxGridNodes,
        clearance * 4,
      );
      if (!result) continue;
      exploredStates += result.explored;
      const points = simplifyOrthogonalPoints([sourcePort.endpoint, ...result.points, targetPort.endpoint]);
      if (points.length > maxPoints || !validRoute(points, searchObstacles, sourceObstacle, targetObstacle)) continue;
      candidates.push({ ...result, points, portRank: sourceRank * 4 + targetRank });
    }
  }
  const best = candidates.sort((left, right) => left.cost - right.cost
    || left.bends - right.bends
    || left.length - right.length
    || left.portRank - right.portRank
    || compareText(JSON.stringify(left.points), JSON.stringify(right.points)))[0];
  if (best) return { points: best.points, diagnostic: 'grid', exploredStates };
  const exterior = exteriorRoute(
    sourcePorts,
    targetPorts,
    searchObstacles,
    sourceObstacle,
    targetObstacle,
    domain,
    clearance,
    maxPoints,
  );
  if (exterior) return { points: exterior, diagnostic: 'exterior-corridor', exploredStates };
  // Graceful degradation: when a tight grid budget prevents an obstacle-safe route,
  // emit a deterministic direct L (may cross obstacles) instead of throwing, so a
  // scoped compile with a capped grid always terminates. At the default budget this
  // path is unreachable (grid/exterior always succeed), so it never alters output.
  const sourcePort = sourcePorts[0]!;
  const targetPort = targetPorts[0]!;
  const direct = simplifyOrthogonalPoints([
    sourcePort.endpoint,
    sourcePort.stub,
    { x: targetPort.stub.x, y: sourcePort.stub.y },
    targetPort.stub,
    targetPort.endpoint,
  ]);
  return { points: direct, diagnostic: 'direct-fallback', exploredStates };
}

/**
 * Applies preferred ports and ordered world-space guides when they remain safe.
 * Stale or impossible guidance always degrades to the deterministic auto-route.
 */
export function routeOrthogonalWithIntent(
  options: OrthogonalRouteOptions,
  intent?: OrthogonalRouteIntent,
): GuidedOrthogonalRouteResult {
  if (!intent) {
    return { ...routeOrthogonal(options), status: 'auto' };
  }
  if ((!intent.sourcePort && !intent.targetPort && intent.waypoints.length === 0) || intent.waypoints.length > 8) {
    return { ...routeOrthogonal(options), status: 'fallback', reason: 'unroutable-guidance' };
  }
  const validPorts = new Set<OrthogonalSide>(['top', 'right', 'bottom', 'left']);
  if ((intent.sourcePort !== undefined && !validPorts.has(intent.sourcePort))
    || (intent.targetPort !== undefined && !validPorts.has(intent.targetPort))) {
    return { ...routeOrthogonal(options), status: 'fallback', reason: 'invalid-port' };
  }
  if (intent.waypoints.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) {
    return { ...routeOrthogonal(options), status: 'fallback', reason: 'non-finite-waypoint' };
  }

  const clearance = Math.max(EPSILON, options.clearance);
  const maxPoints = Math.max(4, options.maxPoints ?? 16);
  const maxGridNodes = Math.max(64, options.maxGridNodes ?? 20_000);
  const laneOffset = options.laneOffset ?? 0;
  const obstacleBounds = [...options.obstacles]
    .sort((left, right) => compareText(left.id, right.id))
    .map(value => expandRoutingRect(value.bounds, clearance));
  const sourceObstacle = expandRoutingRect(options.source, clearance);
  const targetObstacle = expandRoutingRect(options.target, clearance);
  const searchObstacles = [sourceObstacle, targetObstacle, ...obstacleBounds];
  const baseDomain = options.domain ?? unionRects([options.source, options.target, ...obstacleBounds], clearance * 2 + 1);
  const domain = unionRects([baseDomain, options.source, options.target], 0);
  const insideDomain = (point: Point) => point.x >= domain.x - EPSILON
    && point.x <= domain.x + domain.width + EPSILON
    && point.y >= domain.y - EPSILON
    && point.y <= domain.y + domain.height + EPSILON;
  if (intent.waypoints.some(point => !insideDomain(point))) {
    return { ...routeOrthogonal(options), status: 'fallback', reason: 'waypoint-outside-domain' };
  }
  if (intent.waypoints.some(point => searchObstacles.some(obstacle => pointInsideRect(point, obstacle)))) {
    return { ...routeOrthogonal(options), status: 'fallback', reason: 'waypoint-inside-obstacle' };
  }

  const sourceSides = intent.sourcePort ? [intent.sourcePort] : preferredSides(options.source, options.target);
  const targetSides = intent.targetPort ? [intent.targetPort] : preferredSides(options.target, options.source);
  const sourcePorts = sourceSides.map(side => port(options.source, side, clearance, laneOffset));
  const targetPorts = targetSides.map(side => port(options.target, side, clearance, -laneOffset));
  const candidates: Array<GridPath & { points: Point[]; portRank: number }> = [];
  let exploredStates = 0;
  for (let sourceRank = 0; sourceRank < sourcePorts.length; sourceRank += 1) {
    const sourcePort = sourcePorts[sourceRank]!;
    for (let targetRank = 0; targetRank < targetPorts.length; targetRank += 1) {
      const targetPort = targetPorts[targetRank]!;
      const anchors = [sourcePort.stub, ...intent.waypoints, targetPort.stub];
      let failed = false;
      let explored = 0;
      const joined: Point[] = [];
      for (let index = 0; index < anchors.length - 1; index += 1) {
        const leg = findGridPath(
          anchors[index]!,
          anchors[index + 1]!,
          searchObstacles,
          domain,
          maxGridNodes,
          clearance * 4,
        );
        if (!leg) {
          failed = true;
          break;
        }
        explored += leg.explored;
        joined.push(...(index === 0 ? leg.points : leg.points.slice(1)));
      }
      exploredStates += explored;
      if (failed) continue;
      const points = simplifyOrthogonalPoints([sourcePort.endpoint, ...joined, targetPort.endpoint]);
      if (points.length > maxPoints || !validRoute(points, searchObstacles, sourceObstacle, targetObstacle)) continue;
      candidates.push({
        points,
        ...pathMetrics(points, clearance * 4),
        explored,
        portRank: sourceRank * 4 + targetRank,
      });
    }
  }
  const best = candidates.sort((left, right) => left.cost - right.cost
    || left.bends - right.bends
    || left.length - right.length
    || left.portRank - right.portRank
    || compareText(JSON.stringify(left.points), JSON.stringify(right.points)))[0];
  if (best) {
    return {
      points: best.points,
      diagnostic: 'grid',
      exploredStates,
      status: 'applied',
    };
  }
  return {
    ...routeOrthogonal(options),
    status: 'fallback',
    reason: 'unroutable-guidance',
  };
}
