import assert from 'node:assert/strict';
import test from 'node:test';
import { BAND_COST_HANG_GUARD_ENTITIES } from './band-cost-curve.js';
import {
  codeCardCopy,
  codeCardKicker,
} from './code-card-copy.js';
import {
  C4_PRESENTATION_AT_FOCUS,
  C4_ZOOM_BANDS,
  compileC4Scene,
} from './compile-c4.js';
import { buildC4ProjectionBundle } from '@okie/architecture';
import { goldenSnapshot } from './golden-fixture.js';
import { wrapDisplayText } from './card-content-layout.js';

test('CLA-114: hang-guard stays 2000', () => {
  assert.equal(BAND_COST_HANG_GUARD_ENTITIES, 2000);
});

test('CLA-114: golden L4 cards show kind, lines, and signature instead of the path', () => {
  const bundle = buildC4ProjectionBundle(goldenSnapshot, {
    rootEntityId: 'system:okie',
    focusEntityId: 'system:okie',
  });
  const compiled = compileC4Scene(goldenSnapshot, bundle);
  const entity = goldenSnapshot.entities.find(candidate => candidate.id === 'code:model-scoping:select-scoped-view')!;
  const nodeId = bundle.index.visualNodeIdsByEntityId[entity.id]![0]!;
  const representation = compiled.scene.objects.find(candidate => candidate.id === nodeId)!
    .representations.find(candidate => candidate.id === `${nodeId}:code`)!;
  const text = representation.primitives.filter(primitive => primitive.kind === 'text');
  const kicker = text[0]!;
  const title = text[1]!;
  const support = text.slice(2);
  const copy = codeCardCopy(entity);
  const focusZoom = C4_ZOOM_BANDS.find(candidate => candidate.detail === 'code')!.focusZoom;
  const bounds = representation.bounds!;
  const maxWidth = Math.max(1, bounds.width - 36 * (C4_PRESENTATION_AT_FOCUS.code.geometryScale / focusZoom));
  // CLA-381: the signature wraps to at most two lines; only the last may ellipsize.
  const wrappedSupport = copy.description
    ? wrapDisplayText(copy.description, maxWidth, C4_PRESENTATION_AT_FOCUS.code.descriptionFontSize / focusZoom, 2, 'mono-regular')
    : [];

  assert.equal(kicker.content, copy.kicker);
  assert.ok(kicker.content.startsWith('FN · '));
  assert.ok(title.content === entity.name || title.content.endsWith('…'));
  assert.deepEqual(support.map(line => line.content), wrappedSupport);
  assert.ok(support.length > 0 && support.length <= 2);
  assert.ok(support[0]!.content.startsWith('export function') || support[0]!.content.includes('…'));
  assert.equal(kicker.content.includes('normalized.ts'), false);
  assert.equal(support.some(line => line.content.includes('packages/')), false);
  assert.equal(support.some(line => line.content.includes('normalized.ts')), false);
  assert.equal(codeCardKicker({ name: 'App' }), 'SOURCE');
});
