import { expect, it } from 'vitest';
import { createGoldenC4Scene } from './goldenC4Scene';
import { initialSceneBandsMatch } from './initialSceneCompatibility';

it('accepts deeper detail while rejecting a changed visible footprint or publication', () => {
  const first = createGoldenC4Scene('system:okie');
  const enriched = structuredClone(first);
  const codeId = enriched.projection!.entityIdsByDetail.code[0]!;
  const code = enriched.projection!.boundsByEntityIdAndDetail[codeId]!.code!;
  code.x += 10;
  expect(initialSceneBandsMatch(first, enriched)).toBe(true);
  const visibleId = enriched.projection!.entityIdsByDetail.context[0]!;
  enriched.projection!.boundsByEntityIdAndDetail[visibleId]!.context!.x += 1;
  expect(initialSceneBandsMatch(first, enriched)).toBe(false);
  expect(initialSceneBandsMatch(first, { ...first, frozenRevision: 'other' })).toBe(false);
  expect(initialSceneBandsMatch(first, { ...first, rootEntityId: 'other' })).toBe(false);
});
