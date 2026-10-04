import { expect, it } from 'vitest';
import { goldenSnapshot } from '@okie/scene-compiler';
import { entityForScene } from '../renderer/goldenC4Scene';
import { inspectorEntityForFraming, resolveInspectorEntity } from './inspectorEntity';

function fixture() {
  const snapshot = structuredClone(goldenSnapshot);
  const container = snapshot.entities.find(entity => entity.kind === 'container')!;
  const root = snapshot.entities.find(entity => entity.kind === 'softwareSystem')!;
  return { snapshot, container, residents: [entityForScene(root, { context: { x: 20, y: 30, width: 400, height: 200 } })] };
}

it('inspects a known story selection omitted by a guarded scene without borrowing its root or camera geometry', () => {
  const { snapshot, container, residents } = fixture();
  const before = structuredClone(residents);
  const selected = resolveInspectorEntity(snapshot, residents, container.id);
  expect(selected.id).toBe(container.id);
  expect(selected.name).toBe(container.name);
  expect(selected.kindLabel).toBe('Container');
  expect(selected.responsibility).toBe(container.responsibility);
  expect(inspectorEntityForFraming(residents, selected)).toBeUndefined();
  expect(residents).toEqual(before);
});

it('reads in-place canonical enrichment for a selection outside scene residency', () => {
  const { snapshot, container, residents } = fixture();
  const initial = resolveInspectorEntity(snapshot, residents, container.id);
  container.responsibility = 'Accepted enriched description';
  container.owners = ['frontend-team'];
  const enriched = resolveInspectorEntity(snapshot, residents, container.id);
  expect(enriched.responsibility).toBe('Accepted enriched description');
  expect(enriched.owners).toEqual(['frontend-team']);
  expect(initial.responsibility).not.toBe(enriched.responsibility);
  expect(inspectorEntityForFraming(residents, enriched)).toBeUndefined();
});

it('preserves authored resident presentations and their real geometry; unknown selections keep the existing fallback', () => {
  const { snapshot, container, residents } = fixture();
  const authored = { ...entityForScene(container, {}), name: 'Authored name', x: 90, y: 80, width: 300, height: 170 };
  residents.push(authored);
  const selected = resolveInspectorEntity(snapshot, residents, container.id);
  expect(selected).toBe(authored);
  expect(inspectorEntityForFraming(residents, selected)).toBe(authored);
  expect(resolveInspectorEntity(snapshot, residents, 'unknown')).toBe(residents[0]);
});
