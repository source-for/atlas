import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildC4ProjectionBundle,
  C4_BANDS,
  C4_INTRINSIC_LAYOUT,
  expandRoutingRect,
  segmentIntersectsRectInterior,
} from '@okie/architecture';
import { C4_CAMERA_LIMITS, C4_PRESENTATION_AT_FOCUS, C4_ZOOM_BANDS, compileC4Scene } from './compile-c4.js';
import { displayMetricsForFontFamily, displayTextWidth } from './display-text.js';
import { goldenSnapshot } from './golden-fixture.js';

type Bounds = { x: number; y: number; width: number; height: number };

function intersects(left: Bounds, right: Bounds, padding = 0): boolean {
  return left.x - padding < right.x + right.width
    && left.x + left.width + padding > right.x
    && left.y - padding < right.y + right.height
    && left.y + left.height + padding > right.y;
}

function isAncestor(
  possibleAncestorId: string,
  nodeId: string,
  bundle: ReturnType<typeof buildC4ProjectionBundle>,
): boolean {
  let current = bundle.visualNodeById[nodeId]?.parentVisualId;
  const visited = new Set<string>();
  while (current && !visited.has(current)) {
    if (current === possibleAncestorId) return true;
    visited.add(current);
    current = bundle.visualNodeById[current]?.parentVisualId;
  }
  return false;
}

function pointIsOnBoundary(point: { x: number; y: number }, bounds: Bounds, epsilon = 0.001): boolean {
  const withinX = point.x >= bounds.x - epsilon && point.x <= bounds.x + bounds.width + epsilon;
  const withinY = point.y >= bounds.y - epsilon && point.y <= bounds.y + bounds.height + epsilon;
  const onVertical = Math.abs(point.x - bounds.x) <= epsilon
    || Math.abs(point.x - (bounds.x + bounds.width)) <= epsilon;
  const onHorizontal = Math.abs(point.y - bounds.y) <= epsilon
    || Math.abs(point.y - (bounds.y + bounds.height)) <= epsilon;
  return (withinY && onVertical) || (withinX && onHorizontal);
}

function hash(value: unknown): string {
  let result = 2_166_136_261;
  for (const character of JSON.stringify(value)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16_777_619);
  }
  return (result >>> 0).toString(16).padStart(8, '0');
}

test('compiled golden C4 scene is insertion-order deterministic and protocol-coherent', () => {
  const bundle = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const first = compileC4Scene(goldenSnapshot, bundle, { sceneId: 'scene:golden-c4', revision: 7 });
  const reversedSnapshot = {
    ...goldenSnapshot,
    entities: [...goldenSnapshot.entities].reverse(),
    relations: [...goldenSnapshot.relations].reverse(),
  };
  const reversedBundle = buildC4ProjectionBundle(reversedSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const second = compileC4Scene(reversedSnapshot, reversedBundle, { sceneId: 'scene:golden-c4', revision: 7 });

  assert.deepEqual(second, first);
  assert.equal(first.scene.protocolVersion, 1);
  assert.equal(first.scene.revision, 7);
  assert.equal(new Set(first.scene.objects.map(object => object.id)).size, first.scene.objects.length);
  assert.equal(new Set(first.scene.paths.map(path => path.id)).size, first.scene.paths.length);
  const objectIds = new Set(first.scene.objects.map(object => object.id));
  for (const object of first.scene.objects) {
    assert.equal(new Set(object.representations.map(representation => representation.id)).size, object.representations.length);
    if (object.parentId) assert.equal(objectIds.has(object.parentId), true, `${object.id} has a dangling visual parent`);
  }
  for (const path of first.scene.paths) {
    assert.equal(objectIds.has(path.fromObjectId), true, `${path.id} has a dangling from endpoint`);
    assert.equal(objectIds.has(path.toObjectId), true, `${path.id} has a dangling to endpoint`);
    assert.notEqual(path.fromObjectId, path.toObjectId, `${path.id} must not compile a projected self-edge`);
  }
  assert.equal(Number.isFinite(first.scene.worldBounds.x), true);
  assert.equal(Number.isFinite(first.scene.worldBounds.y), true);
  assert.ok(first.scene.worldBounds.width > 0);
  assert.ok(first.scene.worldBounds.height > 0);
});

test('zoom policy gives every rail preset one unambiguous band with overlap and hysteresis', () => {
  assert.deepEqual(C4_ZOOM_BANDS.map(band => band.detail), C4_BANDS);
  for (let index = 0; index < C4_ZOOM_BANDS.length; index += 1) {
    const band = C4_ZOOM_BANDS[index]!;
    const previous = C4_ZOOM_BANDS[index - 1];
    const next = C4_ZOOM_BANDS[index + 1];
    assert.ok(band.hysteresis > 0);
    assert.ok(band.fadeWidth > 0);
    assert.ok(band.focusZoom > band.enterZoom + band.hysteresis);
    if (band.exitZoom !== null) assert.ok(band.focusZoom < band.exitZoom - band.hysteresis);
    if (previous?.exitZoom !== null && previous?.exitZoom !== undefined) {
      assert.ok(band.enterZoom < previous.exitZoom, `${previous.detail}/${band.detail} must overlap for crossfade`);
      assert.ok(band.focusZoom >= previous.exitZoom, `${band.detail} preset must clear the previous transition window`);
    }
    if (next) assert.ok(band.focusZoom < next.enterZoom - next.hysteresis, `${band.detail} preset must not pre-enter ${next.detail}`);
  }
});

test('compiled band projections have distinct semantic hashes and exact transition-map bounds', () => {
  const bundle = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const compiled = compileC4Scene(goldenSnapshot, bundle);
  const semanticHashes = C4_BANDS.map(band => {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
    return hash({
      nodes: projection.visualNodeIds.map(id => bundle.index.entityIdByVisualNodeId[id]),
      edges: projection.visualEdgeIds.map(id => {
        const edge = bundle.visualEdgeById[id]!;
        return {
          from: bundle.index.entityIdByVisualNodeId[edge.fromVisualId],
          to: bundle.index.entityIdByVisualNodeId[edge.toVisualId],
          kind: edge.kind,
          label: edge.label,
          relations: edge.relations.map(value => value.logicalId),
        };
      }),
    });
  });
  assert.equal(new Set(semanticHashes).size, 4);
  assert.equal(compiled.transitionMaps.length, 3);

  for (const transition of compiled.transitionMaps) {
    const normalized = compiled.projections;
    const fromProjection = normalized.projectionById[normalized.family.projectionIds[transition.from]]!;
    const toProjection = normalized.projectionById[normalized.family.projectionIds[transition.to]]!;
    const fromLayout = normalized.bandLayoutById[fromProjection.layoutId]!;
    const toLayout = normalized.bandLayoutById[toProjection.layoutId]!;
    const expectedIds = [...new Set([...fromProjection.visualNodeIds, ...toProjection.visualNodeIds])].sort();
    assert.deepEqual(transition.nodes.map(node => node.visualNodeId), expectedIds);
    for (const node of transition.nodes) {
      assert.deepEqual(node.fromBounds, fromLayout.nodes[node.visualNodeId]);
      assert.deepEqual(node.toBounds, toLayout.nodes[node.visualNodeId]);
      assert.equal(node.entityId, bundle.index.entityIdByVisualNodeId[node.visualNodeId]);
    }
  }
});

test('compiler normalizes every expandable owner without mutating the authored layouts', () => {
  const authored = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const authoredRootContainer = authored.index.boundsByEntityIdAndBand['system:okie']!.container!;
  const compiled = compileC4Scene(goldenSnapshot, authored);
  const normalized = compiled.projections.index.boundsByEntityIdAndBand;
  const owners = [
    { id: 'system:okie', current: 'context' as const, next: 'container' as const },
    { id: 'container:architecture-model', current: 'container' as const, next: 'component' as const },
    { id: 'component:model-scoping', current: 'component' as const, next: 'code' as const },
  ];
  for (const owner of owners) {
    assert.deepEqual(normalized[owner.id]![owner.next], normalized[owner.id]![owner.current]);
  }
  assert.notDeepEqual(authoredRootContainer, normalized['system:okie']!.container,
    'normalization must clone rather than mutate the authored projection bundle');
  assert.deepEqual(authored.index.boundsByEntityIdAndBand['system:okie']!.container, authoredRootContainer);

  const byId = new Map(goldenSnapshot.entities.map(entity => [entity.id, entity]));
  for (const owner of owners) {
    const boundary = normalized[owner.id]![owner.next]!;
    const children = goldenSnapshot.entities.filter(entity => entity.parentId === owner.id);
    for (const child of children) {
      const bounds = normalized[child.id]?.[owner.next];
      if (!bounds) continue;
      assert.ok(bounds.x >= boundary.x && bounds.y >= boundary.y);
      assert.ok(bounds.x + bounds.width <= boundary.x + boundary.width);
      assert.ok(bounds.y + bounds.height <= boundary.y + boundary.height);
      assert.equal(byId.get(child.id)?.parentId, owner.id);
    }
  }
});

test('intrinsic hierarchy sizing preserves readable headers, cards, padding, gaps, and the context root', () => {
  const authored = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const authoredRoot = authored.index.boundsByEntityIdAndBand['system:okie']!.context!;
  const compiled = compileC4Scene(goldenSnapshot, authored);
  const normalized = compiled.projections;
  const boundsByEntity = normalized.index.boundsByEntityIdAndBand;
  const root = boundsByEntity['system:okie']!;
  // The root owns containers, so its face keeps the authored height (CLA-381 compacts leaves only).
  assert.deepEqual(root.context, authoredRoot);
  assert.deepEqual(root.context, { x: 820, y: 120, width: 480, height: 250 });
  assert.deepEqual(root.container, root.context);
  assert.deepEqual(root.component, root.context);
  assert.deepEqual(root.code, root.context, 'intrinsic descendants fit without unnecessarily enlarging L1');

  const ownerPolicies = [
    { ownerKinds: new Set(['softwareSystem']), childKinds: new Set(['container', 'dataStore', 'queue']), band: 'container' as const, zoom: C4_ZOOM_BANDS[1]!.focusZoom, header: 72 },
    { ownerKinds: new Set(['container', 'dataStore', 'queue']), childKinds: new Set(['component']), band: 'component' as const, zoom: C4_ZOOM_BANDS[2]!.focusZoom, header: 72 },
    { ownerKinds: new Set(['component']), childKinds: new Set(['code']), band: 'code' as const, zoom: C4_ZOOM_BANDS[3]!.focusZoom, header: 96 },
  ];
  const epsilon = 1e-9;
  for (const policy of ownerPolicies) {
    const sidePadding = C4_INTRINSIC_LAYOUT.sidePadding / policy.zoom;
    const bottomPadding = C4_INTRINSIC_LAYOUT.bottomPadding / policy.zoom;
    const header = policy.header / policy.zoom;
    const gap = C4_INTRINSIC_LAYOUT.gap / policy.zoom;
    for (const owner of goldenSnapshot.entities.filter(entity => policy.ownerKinds.has(entity.kind))) {
      const ownerBounds = boundsByEntity[owner.id]?.[policy.band];
      const children = goldenSnapshot.entities
        .filter(entity => entity.parentId === owner.id && policy.childKinds.has(entity.kind))
        .sort((left, right) => left.id.localeCompare(right.id));
      if (!ownerBounds || !children.length) continue;
      const childBounds = children.map(child => ({ id: child.id, bounds: boundsByEntity[child.id]![policy.band]! }));
      for (const child of childBounds) {
        assert.ok(child.bounds.x >= ownerBounds.x + sidePadding - epsilon, `${child.id} must clear ${owner.id}'s left padding`);
        assert.ok(child.bounds.x + child.bounds.width <= ownerBounds.x + ownerBounds.width - sidePadding + epsilon,
          `${child.id} must clear ${owner.id}'s right padding`);
        assert.ok(child.bounds.y >= ownerBounds.y + header - epsilon, `${child.id} must clear ${owner.id}'s header`);
        assert.ok(child.bounds.y + child.bounds.height <= ownerBounds.y + ownerBounds.height - bottomPadding + epsilon,
          `${child.id} must clear ${owner.id}'s bottom padding`);
      }
      for (let leftIndex = 0; leftIndex < childBounds.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < childBounds.length; rightIndex += 1) {
          const left = childBounds[leftIndex]!.bounds;
          const right = childBounds[rightIndex]!.bounds;
          const horizontalGap = Math.max(right.x - (left.x + left.width), left.x - (right.x + right.width));
          const verticalGap = Math.max(right.y - (left.y + left.height), left.y - (right.y + right.height));
          assert.ok(horizontalGap >= gap - epsilon || verticalGap >= gap - epsilon,
            `${childBounds[leftIndex]!.id}/${childBounds[rightIndex]!.id} must retain the ${gap}-unit sibling gap`);
        }
      }
    }
  }

  const codeFocusZoom = C4_ZOOM_BANDS[3]!.focusZoom;
  const minimumCodeWidth = C4_INTRINSIC_LAYOUT.leaf.code.width / codeFocusZoom;
  for (const code of goldenSnapshot.entities.filter(entity => entity.kind === 'code')) {
    const bounds = boundsByEntity[code.id]!.code!;
    assert.ok(bounds.width >= minimumCodeWidth, `${code.id} retains its readable fixed width`);
    const visualId = normalized.index.visualNodeIdsByEntityId[code.id]![0]!;
    const representation = compiled.scene.objects.find(object => object.id === visualId)!.representations.find(value => value.id.endsWith(':code'))!;
    const text = representation.primitives.filter(value => value.kind === 'text');
    const bottomPadding = 10 * C4_PRESENTATION_AT_FOCUS.code.geometryScale / codeFocusZoom;
    assert.ok(bounds.height >= text.at(-1)!.position.y - bounds.y + bottomPadding - 1e-9,
      `${code.id} face keeps one bottom padding below its last wrapped line`);
  }
  const threeCodeComponent = boundsByEntity['component:model-validation']!.code!;
  assert.ok(threeCodeComponent.width >= 504 / codeFocusZoom && threeCodeComponent.height >= 356 / codeFocusZoom,
    'a three-code component must reserve the full 504×356 CSS intrinsic grid');

  for (const band of C4_BANDS) {
    const projection = normalized.projectionById[normalized.family.projectionIds[band]]!;
    const layout = normalized.bandLayoutById[projection.layoutId]!;
    for (const edgeId of projection.visualEdgeIds) {
      const edge = normalized.visualEdgeById[edgeId]!;
      const points = layout.edges[edgeId]!.points;
      assert.equal(pointIsOnBoundary(points[0]!, layout.nodes[edge.fromVisualId]!), true,
        `${band} ${edgeId} must be rerouted from its resized source boundary`);
      assert.equal(pointIsOnBoundary(points.at(-1)!, layout.nodes[edge.toVisualId]!), true,
        `${band} ${edgeId} must be rerouted to its resized target boundary`);
    }
  }
});

test('focus presets keep human C4 labels legible and suppress dense L3/L4 relation labels by default', () => {
  const bundle = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const compiled = compileC4Scene(goldenSnapshot, bundle);
  const samples = [
    { band: 'context' as const, entityId: 'system:okie', kicker: 'SOFTWARE SYSTEM' },
    { band: 'container' as const, entityId: 'container:architecture-model', kicker: 'CONTAINER' },
    { band: 'component' as const, entityId: 'component:model-scoping', kicker: 'COMPONENT' },
    { band: 'code' as const, entityId: 'code:model-scoping:select-scoped-view', kicker: 'FN · 600–605' },
  ];

  for (const sample of samples) {
    const band = C4_ZOOM_BANDS.find(candidate => candidate.detail === sample.band)!;
    const nodeId = bundle.index.visualNodeIdsByEntityId[sample.entityId]![0]!;
    const object = compiled.scene.objects.find(candidate => candidate.id === nodeId)!;
    const representation = object.representations.find(candidate => candidate.id === `${nodeId}:${sample.band}`)!;
    const text = representation.primitives.filter(primitive => primitive.kind === 'text');
    const node = bundle.visualNodeById[nodeId]!;
    const [kicker, title, support] = text;
    const entity = goldenSnapshot.entities.find(candidate => candidate.id === sample.entityId);
    const rawSupport = sample.band === 'code'
      ? entity?.sourceExcerpts?.[0]?.lines.find(line => line.trim()) ?? ''
      : node.responsibility ?? '';
    assert.ok(rawSupport, `${sample.band} golden node must supply semantic support copy`);
    assert.ok(kicker, `${sample.band} must use the human C4 kicker ${sample.kicker}`);
    assert.equal(kicker.content, sample.kicker);
    assert.ok(title, `${sample.band} must render its primary title`);
    assert.ok(title.content && (title.content === node.name || title.content.endsWith('…')),
      `${sample.band} must preserve semantic title copy when it truncates`);
    assert.ok(support, `${sample.band} must render its responsibility/signature at the focus preset`);
    assert.ok(support.content, `${sample.band} support text cannot collapse to an empty marker`);
    if (sample.band === 'code') {
      assert.equal(kicker.content.includes('SOURCE'), false, 'L4 kicker is a kind badge, not SOURCE');
      assert.equal(support.content.includes(entity?.sourceRefs[0]?.path ?? 'normalized.ts'), false);
      assert.ok(support.content.startsWith('export function') || support.content.includes('…'),
        'L4 support is the signature excerpt, truncated with a word ellipsis when needed');
    }
    const supportCopy = text.slice(2).map(line => line.content).join(' ');
    if (supportCopy !== rawSupport) {
      assert.ok(supportCopy.includes('…'), `${sample.band} truncated support must announce omission`);
      const prefix = supportCopy.slice(0, -1);
      assert.ok(rawSupport.startsWith(prefix), `${sample.band} prose must retain a semantic prefix`);
      assert.match(rawSupport.slice(prefix.length, prefix.length + 1), /\s/u,
        `${sample.band} prose must stop at a word boundary`);
    }
    const minimum = sample.band === 'code'
      ? { kicker: 7, title: 11, support: 7 }
      : { kicker: 9, title: 12, support: 10 };
    assert.ok(kicker.fontSize * band.focusZoom >= minimum.kicker, `${sample.band} kicker must meet its focus scale floor`);
    assert.ok(title.fontSize * band.focusZoom >= minimum.title, `${sample.band} title must meet its focus scale floor`);
    assert.ok(support.fontSize * band.focusZoom >= minimum.support, `${sample.band} support text must meet its focus scale floor`);
  }

  const contextBounds = compiled.projections.index.boundsByEntityIdAndBand['system:okie']!.context!;
  assert.ok(Math.abs(contextBounds.width * C4_ZOOM_BANDS[0]!.focusZoom - 360) < 1e-9,
    'compiler-authored context focus must project the 480-unit system owner to 360 CSS px');

  const codeSample = samples.at(-1)!;
  const codeNodeId = bundle.index.visualNodeIdsByEntityId[codeSample.entityId]![0]!;
  const codeRepresentation = compiled.scene.objects.find(object => object.id === codeNodeId)!
    .representations.find(representation => representation.id === `${codeNodeId}:code`)!;
  const codeTitle = codeRepresentation.primitives.filter(primitive => primitive.kind === 'text')[1]!;
  const projectedCodeTitle = codeTitle.fontSize * C4_ZOOM_BANDS[3]!.focusZoom;
  const projectedCodeTitleAtMaximum = codeTitle.fontSize * C4_CAMERA_LIMITS.maxZoom;
  assert.equal(projectedCodeTitle, C4_PRESENTATION_AT_FOCUS.code.titleFontSize);
  assert.ok(projectedCodeTitleAtMaximum <= 33,
    'L4 title type must remain comfortable across the explicit framing runway');
  const [codeKicker, , codeSupport] = codeRepresentation.primitives.filter(primitive => primitive.kind === 'text');
  assert.ok(codeKicker!.fontSize * C4_CAMERA_LIMITS.maxZoom >= 15
    && codeKicker!.fontSize * C4_CAMERA_LIMITS.maxZoom <= 24);
  assert.ok(codeSupport!.fontSize * C4_CAMERA_LIMITS.maxZoom >= 15
    && codeSupport!.fontSize * C4_CAMERA_LIMITS.maxZoom <= 26);

  for (const object of compiled.scene.objects) {
    for (const representation of object.representations) {
      for (const primitive of representation.primitives) {
        if (primitive.kind !== 'text') continue;
        assert.ok(displayTextWidth(primitive.content, primitive.fontSize, displayMetricsForFontFamily(primitive.fontFamily)) <= primitive.maxWidth,
          `${representation.id} text must fit without renderer-side character clipping`);
      }
    }
  }

  for (const band of ['context', 'container'] as const) {
    const projection = bundle.projectionById[bundle.family.projectionIds[band]]!;
    for (const nodeId of projection.visualNodeIds) {
      const object = compiled.scene.objects.find(candidate => candidate.id === nodeId)!;
      const representation = object.representations.find(candidate => candidate.id === `${nodeId}:${band}`)!;
      const title = representation.primitives.filter(primitive => primitive.kind === 'text')[1];
      assert.equal(title?.content, bundle.visualNodeById[nodeId]!.name,
        `${band} curated primary names must remain complete at their focus zoom`);
    }
  }

  for (const band of ['component', 'code'] as const) {
    const relationLabels = compiled.scene.objects.filter(object => object.id.startsWith('relation-label:')
      && object.representations.some(representation => representation.id.endsWith(`:${band}`)));
    assert.deepEqual(relationLabels, [], `${band} must not materialize every relation label by default`);
  }
});

test('retained owner shells publish active-detail typography on persistent L2-L4 bounds', () => {
  const compiled = compileC4Scene(goldenSnapshot, buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  }));
  const projections = compiled.projections;
  const representation = (entityId: string, band: 'container' | 'component' | 'code') => {
    const visualId = projections.index.visualNodeIdsByEntityId[entityId]![0]!;
    return compiled.scene.objects.find(object => object.id === visualId)!
      .representations.find(candidate => candidate.id === `${visualId}:${band}`)!;
  };
  const text = (entityId: string, band: 'container' | 'component' | 'code') => representation(entityId, band)
    .primitives.filter(primitive => primitive.kind === 'text');

  // A sibling container becomes a ghost shell when another L2 branch owns L3/L4.
  // The compiler already publishes one representation per active semantic band;
  // projection ownership must select these rather than scaling L2 primitives.
  const ghostSiblingId = 'container:web-app';
  const container = representation(ghostSiblingId, 'container');
  const component = representation(ghostSiblingId, 'component');
  const code = representation(ghostSiblingId, 'code');
  assert.deepEqual(component.bounds, container.bounds, 'L3 ghost typography cannot move its persistent L2 shell');
  assert.deepEqual(code.bounds, container.bounds, 'L4 ghost typography cannot move its persistent L2 shell');
  assert.deepEqual(text(ghostSiblingId, 'container').map(primitive => primitive.content).slice(0, 2), ['CONTAINER', 'Atlas web app']);
  assert.deepEqual(text(ghostSiblingId, 'component').map(primitive => primitive.content), ['CONTAINER', 'Atlas web app']);
  assert.deepEqual(text(ghostSiblingId, 'code').map(primitive => primitive.content), ['CONTAINER', 'Atlas web app']);

  const titleSizes = (['container', 'component', 'code'] as const)
    .map(band => text(ghostSiblingId, band)[1]!.fontSize);
  const kickerSizes = (['container', 'component', 'code'] as const)
    .map(band => text(ghostSiblingId, band)[0]!.fontSize);
  assert.ok(titleSizes[0]! > titleSizes[1]! && titleSizes[1]! > titleSizes[2]!,
    'retained shell titles must use progressively smaller world-space type at deeper zoom bands');
  assert.ok(kickerSizes[0]! > kickerSizes[1]! && kickerSizes[1]! > kickerSizes[2]!,
    'retained shell kickers must use progressively smaller world-space type at deeper zoom bands');
  assert.deepEqual(titleSizes, [
    C4_PRESENTATION_AT_FOCUS.container.titleFontSize / C4_ZOOM_BANDS[1]!.focusZoom,
    C4_PRESENTATION_AT_FOCUS.component.titleFontSize / C4_ZOOM_BANDS[2]!.focusZoom,
    C4_PRESENTATION_AT_FOCUS.code.titleFontSize / C4_ZOOM_BANDS[3]!.focusZoom,
  ]);
  assert.deepEqual(kickerSizes, [
    C4_PRESENTATION_AT_FOCUS.container.kickerFontSize / C4_ZOOM_BANDS[1]!.focusZoom,
    C4_PRESENTATION_AT_FOCUS.component.kickerFontSize / C4_ZOOM_BANDS[2]!.focusZoom,
    C4_PRESENTATION_AT_FOCUS.code.kickerFontSize / C4_ZOOM_BANDS[3]!.focusZoom,
  ]);

  // The active primary branch still owns its full semantic copy at L3, while
  // retained ancestors keep their existing band-authored identity copy.
  assert.deepEqual(text('component:model-scoping', 'component').map(primitive => primitive.content), [
    'COMPONENT',
    'Hierarchy selectors',
    'Reconstructs snapshots and',
    'selects a view scoped to a…',
  ]);
  for (const band of ['container', 'component', 'code'] as const) {
    assert.deepEqual(text('system:okie', band).map(primitive => primitive.content), ['SOFTWARE SYSTEM', 'Okie'],
      `${band} ancestor identity copy must remain unchanged`);
  }
});

test('settled C4 presets have collision-free peers and labels, with every edge clipped to node boundaries', () => {
  const bundle = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const compiled = compileC4Scene(goldenSnapshot, bundle);
  const normalizedBundle = compiled.projections;
  const allLabelNodeIntersections: string[] = [];
  const allLabelIntersections: string[] = [];

  for (const band of C4_BANDS) {
    const policy = C4_ZOOM_BANDS.find(candidate => candidate.detail === band)!;
    const projection = normalizedBundle.projectionById[normalizedBundle.family.projectionIds[band]]!;
    const layout = normalizedBundle.bandLayoutById[projection.layoutId]!;
    const peerIntersections: string[] = [];
    for (let leftIndex = 0; leftIndex < projection.visualNodeIds.length; leftIndex += 1) {
      const leftId = projection.visualNodeIds[leftIndex]!;
      for (let rightIndex = leftIndex + 1; rightIndex < projection.visualNodeIds.length; rightIndex += 1) {
        const rightId = projection.visualNodeIds[rightIndex]!;
        if (isAncestor(leftId, rightId, bundle) || isAncestor(rightId, leftId, bundle)) continue;
        if (intersects(layout.nodes[leftId]!, layout.nodes[rightId]!)) {
          peerIntersections.push(`${leftId} × ${rightId}`);
        }
      }
    }
    assert.deepEqual(peerIntersections, [], `${band} peer nodes must not intersect at the settled preset`);

    for (const edgeId of projection.visualEdgeIds) {
      const edge = normalizedBundle.visualEdgeById[edgeId]!;
      const points = layout.edges[edgeId]!.points;
      assert.equal(pointIsOnBoundary(points[0]!, layout.nodes[edge.fromVisualId]!), true,
        `${band} ${edgeId} must leave the source boundary`);
      assert.equal(pointIsOnBoundary(points.at(-1)!, layout.nodes[edge.toVisualId]!), true,
        `${band} ${edgeId} must arrive at the target boundary`);
    }

    const labels = compiled.scene.objects.filter(object => object.id.startsWith('relation-label:'))
      .flatMap(object => object.representations
        .filter(representation => representation.id.endsWith(`:${band}`))
        .map(representation => ({ id: object.id, bounds: representation.bounds ?? object.bounds })));
    const boundaryNodeIds = new Set(projection.visualNodeIds.filter(nodeId => projection.visualNodeIds.some(candidateId => (
      normalizedBundle.visualNodeById[candidateId]?.parentVisualId === nodeId
    ))));
    const padding = 8 / policy.focusZoom;
    const labelNodeIntersections: string[] = [];
    for (const label of labels) {
      for (const nodeId of projection.visualNodeIds) {
        if (boundaryNodeIds.has(nodeId)) continue;
        if (intersects(label.bounds, layout.nodes[nodeId]!, padding)) {
          labelNodeIntersections.push(`${band}: ${label.id} × ${nodeId}`);
        }
      }
    }
    allLabelNodeIntersections.push(...labelNodeIntersections);

    const labelIntersections: string[] = [];
    for (let leftIndex = 0; leftIndex < labels.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < labels.length; rightIndex += 1) {
        if (intersects(labels[leftIndex]!.bounds, labels[rightIndex]!.bounds, padding)) {
          labelIntersections.push(`${band}: ${labels[leftIndex]!.id} × ${labels[rightIndex]!.id}`);
        }
      }
    }
    allLabelIntersections.push(...labelIntersections);
    assert.ok(labels.length <= projection.visualEdgeIds.length,
      `${band} may deterministically suppress low-priority labels but cannot invent labels`);
  }
  assert.deepEqual({
    labelNodeIntersections: allLabelNodeIntersections,
    labelLabelIntersections: allLabelIntersections,
  }, {
    labelNodeIntersections: [],
    labelLabelIntersections: [],
  }, 'visible priority labels need 8 CSS px clearance from cards and each other');
});

test('final C4 routes avoid unrelated hierarchy interiors with stable parallel lanes', () => {
  const authored = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const compiled = compileC4Scene(goldenSnapshot, authored);
  const normalized = compiled.projections;
  const violations: string[] = [];

  for (const band of C4_BANDS) {
    const projection = normalized.projectionById[normalized.family.projectionIds[band]]!;
    const layout = normalized.bandLayoutById[projection.layoutId]!;
    const clearance = 8 / C4_ZOOM_BANDS.find(candidate => candidate.detail === band)!.focusZoom;
    const routesByPair = new Map<string, Array<{ id: string; points: typeof layout.edges[string]['points'] }>>();
    for (const edgeId of projection.visualEdgeIds) {
      const edge = normalized.visualEdgeById[edgeId]!;
      const points = layout.edges[edgeId]!.points;
      assert.ok(points.length >= 2 && points.length <= 16, `${band} ${edgeId} must honor the route point cap`);
      assert.equal(pointIsOnBoundary(points[0]!, layout.nodes[edge.fromVisualId]!), true,
        `${band} ${edgeId} must start on the exact source boundary`);
      assert.equal(pointIsOnBoundary(points.at(-1)!, layout.nodes[edge.toVisualId]!), true,
        `${band} ${edgeId} must end on the exact target boundary`);
      for (let segmentIndex = 0; segmentIndex < points.length - 1; segmentIndex += 1) {
        const from = points[segmentIndex]!;
        const to = points[segmentIndex + 1]!;
        assert.ok(Math.abs(from.x - to.x) <= 0.001 || Math.abs(from.y - to.y) <= 0.001,
          `${band} ${edgeId} segment ${segmentIndex} must be orthogonal`);
        for (const nodeId of projection.visualNodeIds) {
          if (nodeId === edge.fromVisualId || nodeId === edge.toVisualId) continue;
          if (isAncestor(nodeId, edge.fromVisualId, normalized) || isAncestor(nodeId, edge.toVisualId, normalized)) continue;
          if (segmentIntersectsRectInterior(from, to, expandRoutingRect(layout.nodes[nodeId]!, clearance))) {
            violations.push(`${band}: ${edgeId} segment ${segmentIndex} × ${nodeId}`);
          }
        }
      }
      const pair = [edge.fromVisualId, edge.toVisualId].sort().join('\u0000');
      const routes = routesByPair.get(pair) ?? [];
      routes.push({ id: edgeId, points });
      routesByPair.set(pair, routes);
    }
    for (const routes of routesByPair.values()) {
      for (let index = 0; index < routes.length; index += 1) {
        for (let otherIndex = index + 1; otherIndex < routes.length; otherIndex += 1) {
          assert.notDeepEqual(routes[index]!.points, routes[otherIndex]!.points,
            `${band} parallel edges ${routes[index]!.id}/${routes[otherIndex]!.id} need stable separate lanes`);
        }
      }
    }
  }
  assert.deepEqual(violations, [], 'routes cannot enter the padded interior of unrelated visible nodes');

  const regressionCases = [
    { band: 'container' as const, relation: 'relation:model-to-compiler', obstacle: 'container:rust-renderer' },
    { band: 'code' as const, relation: 'relation:code-validation-view-snapshot', obstacle: 'code:model-validation:snapshot' },
  ];
  for (const sample of regressionCases) {
    const projection = normalized.projectionById[normalized.family.projectionIds[sample.band]]!;
    const layout = normalized.bandLayoutById[projection.layoutId]!;
    const edgeId = projection.visualEdgeIds.find(id => normalized.visualEdgeById[id]!.relations
      .some(relation => relation.logicalId === sample.relation));
    const obstacleId = normalized.index.visualNodeIdsByEntityId[sample.obstacle]?.[0];
    assert.ok(edgeId && obstacleId, `${sample.relation} regression entities must remain in the golden fixture`);
    const clearance = 8 / C4_ZOOM_BANDS.find(candidate => candidate.detail === sample.band)!.focusZoom;
    const points = layout.edges[edgeId]!.points;
    assert.ok(points.slice(0, -1).every((point, index) => !segmentIntersectsRectInterior(
      point,
      points[index + 1]!,
      expandRoutingRect(layout.nodes[obstacleId]!, clearance),
    )), `${sample.relation} must detour around ${sample.obstacle}`);
  }
});

test('diagram typography uses IBM Plex Sans, with IBM Plex Mono reserved for L4 source identifiers and paths', () => {
  const bundle = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const compiled = compileC4Scene(goldenSnapshot, bundle);

  for (const object of compiled.scene.objects) {
    for (const representation of object.representations) {
      const band = C4_BANDS.find(candidate => representation.id.endsWith(`:${candidate}`));
      assert.ok(band, `${representation.id} must identify its semantic band`);
      const text = representation.primitives.filter(primitive => primitive.kind === 'text');
      if (object.id.startsWith('relation-label:')) {
        assert.ok(text.every(primitive => primitive.fontFamily.startsWith('IBM Plex Sans')),
          `${representation.id} relationship labels must use the diagram sans face`);
        continue;
      }
      assert.ok(text[0]?.fontFamily.startsWith('IBM Plex Sans'), `${representation.id} kind kicker must use IBM Plex Sans`);
      if (band === 'code') {
        assert.ok(text.slice(1).every(primitive => primitive.fontFamily.startsWith('IBM Plex Mono')),
          `${representation.id} L4 source identifier/path must use IBM Plex Mono`);
      } else {
        assert.ok(text.every(primitive => primitive.fontFamily.startsWith('IBM Plex Sans')),
          `${representation.id} non-code diagram text must use IBM Plex Sans`);
      }
    }
  }
});

test('authored zoom bands are overlapping eligibility ranges with fixed forced presets', () => {
  assert.deepEqual(C4_ZOOM_BANDS, [
    { detail: 'context', enterZoom: 0, exitZoom: 1.30, focusZoom: 0.75, fadeWidth: 0.14, hysteresis: 0.04 },
    { detail: 'container', enterZoom: 1.16, exitZoom: 3.75, focusZoom: 1.99, fadeWidth: 0.14, hysteresis: 0.08 },
    { detail: 'component', enterZoom: 3.35, exitZoom: 7.95, focusZoom: 5.27, fadeWidth: 0.40, hysteresis: 0.23 },
    { detail: 'code', enterZoom: 7.10, exitZoom: null, focusZoom: 13.96, fadeWidth: 0.85, hysteresis: 0.50 },
  ]);
  const ratios = C4_ZOOM_BANDS.slice(1).map((band, index) => band.focusZoom / C4_ZOOM_BANDS[index]!.focusZoom);
  assert.ok(ratios.every(ratio => Math.abs(ratio - 2.65) < 0.01), 'rail presets must follow one approximately 2.65x scale');
  assert.deepEqual(C4_CAMERA_LIMITS, { minZoom: 0.32, maxZoom: 32 });
  for (let index = 0; index < C4_ZOOM_BANDS.length; index += 1) {
    const band = C4_ZOOM_BANDS[index]!;
    assert.ok(band.focusZoom > band.enterZoom, `${band.detail} rail preset must clear its eligibility floor`);
    if (band.exitZoom !== null) {
      assert.ok(band.focusZoom < band.exitZoom, `${band.detail} rail preset must remain inside its eligible range`);
    }
    const next = C4_ZOOM_BANDS[index + 1];
    if (next && band.exitZoom !== null) {
      assert.ok(next.enterZoom < band.exitZoom,
        `${band.detail}/${next.detail} eligibility must overlap instead of defining a global cutover`);
    }
  }
});
