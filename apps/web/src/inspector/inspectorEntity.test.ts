import { expect, it } from 'vitest';
import { goldenSnapshot } from '@okie/scene-compiler';
import { entityForScene } from '../renderer/goldenC4Scene';
import { inspectorEntityForFraming, resolveInspectorEntity, retainResidentInspectorEntity } from './inspectorEntity';

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

it('relationship scope changes cannot promote canonical-only inspection into rendered geometry', () => {
  const { snapshot, container, residents } = fixture();
  const canonical = resolveInspectorEntity(snapshot, residents, container.id);
  const next = { entities: [...residents] };
  expect(retainResidentInspectorEntity(next, residents, canonical)).toBe(next);
  expect(next.entities.some(entity => entity.id === container.id)).toBe(false);
});

it('relationship scope changes retain only the actual authored resident and do not duplicate an existing target', () => {
  const { container, residents } = fixture();
  const resident = { ...entityForScene(container, {}), name: 'Authored resident', x: 200, y: 300, width: 900, height: 400 };
  const inspected = { ...resident, x: 0, y: 0, width: 1, height: 1 };
  residents.push(resident);
  const next = { entities: [residents[0]!], protocolPatch: { revision: 3 }, protocolSnapshot: { revision: 4 }, projection: { id: 'retained' } };
  const retained = retainResidentInspectorEntity(next, residents, inspected);
  expect(retained.entities.at(-1)).toBe(resident);
  expect(retained.protocolPatch).toBe(next.protocolPatch);
  expect(retained.protocolSnapshot).toBe(next.protocolSnapshot);
  expect(retained.projection).toBe(next.projection);
  expect(next.entities).toHaveLength(1);
  expect(retainResidentInspectorEntity(retained, residents, inspected)).toBe(retained);
});
