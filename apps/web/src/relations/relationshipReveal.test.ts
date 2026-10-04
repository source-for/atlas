import { expect, it } from 'vitest';
import type { AtlasScene, SceneEntity } from '../renderer/types';
import { idleSemanticLensSession } from '../semantic/semanticLens';
import { canonicalRelationForInspection, resolveRelationshipReveal, resolveRelationshipRevealAsync } from './relationshipReveal';
import { canonicalRelationshipGroupsForEntity } from './canonicalRelationshipInventory';
import { createPreparedSceneGenerations, createSceneGenerationFence } from '../renderer/foregroundSceneRequest';

const snapshot = { entities: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], relations: [{ id: 'r', from: 'a', to: 'b', kind: 'calls', evidence: [{ explanation: 'captured' }] }] } as never;
const entity = (id: string, x: number): SceneEntity => ({ id, name: id, responsibility: '', kind: 'component', detail: 'component', x, y: 0, width: 100, height: 80 });
const scene = { entities: [entity('a', 0), entity('b', 200)], relations: [{ id: 'r', from: 'a', to: 'b', routePoints: [{ x: 100, y: 40 }, { x: 150, y: -400 }, { x: 200, y: 40 }] }] } as AtlasScene;
const input = { snapshot, scene, relationId: 'r', session: idleSemanticLensSession('component'), viewport: { width: 1000, height: 800 }, safeArea: { top: 0, bottom: 0, left: 0, right: 0 } };
it('recompiles an absent neighborhood and frames both endpoints and the route excursion without changing inspector intent', () => {
  const sessionBefore = JSON.stringify(input.session);
  const calls: string[] = [];
  const result = resolveRelationshipReveal({ ...input, scene: { ...scene, relations: [], entities: [] }, compileScope: id => { calls.push(id); return scene; } });
  expect(calls).toEqual(['a']);
  expect(result.status).toBe('ready');
  if (result.status === 'ready') {
    expect(result.representation).toBe('individual');
    expect(result.framing.bounds).toEqual({ x: 0, y: -400, width: 300, height: 480 });
    expect(result).not.toHaveProperty('selectedId');
    expect(result).not.toHaveProperty('inspectorTab');
  }
  expect(JSON.stringify(input.session)).toBe(sessionBefore);
});
it('keeps canonical inspection available and reports unsupported routes honestly', () => {
  expect(canonicalRelationForInspection(snapshot, 'r')).toMatchObject({ from: 'a', to: 'b', kindLabel: 'calls' });
  expect(resolveRelationshipReveal({ ...input, scene: { ...scene, relations: [] }, compileScope: () => ({ ...scene, relations: [] }) })).toMatchObject({ status: 'unavailable' });
});
it('distinguishes aggregate membership from individual and isolation-hidden routes', () => {
  const aggregateScene = { ...scene, entities: [entity('ownerA', 0), entity('ownerB', 200)], relations: [{ ...scene.relations[0]!, id: 'aggregate', from: 'ownerA', to: 'ownerB', semanticIds: ['r'] }] };
  const shown = canonicalRelationshipGroupsForEntity(snapshot, aggregateScene, new Set(['aggregate']), 'a', new Set(['ownerA', 'ownerB']));
  expect(shown[0]?.rows[0]?.mapStatus).toBe('aggregated');
  expect(canonicalRelationshipGroupsForEntity(snapshot, aggregateScene, new Set(['aggregate']), 'a', new Set(['ownerA']))[0]?.rows[0]?.mapStatus).toBe('hidden');
  expect(resolveRelationshipReveal({ ...input, scene: aggregateScene })).toMatchObject({ status: 'ready', representation: 'aggregate' });
});
it('keeps calls and generic uses directional, recursive once, and deduplicates identity', () => {
  const relations = [
    { id: 'out', from: 'a', to: 'b', kind: 'calls' },
    { id: 'in', from: 'b', to: 'a', kind: 'uses' },
    { id: 'self', from: 'a', to: 'a', kind: 'calls' },
    { id: 'self', from: 'a', to: 'a', kind: 'calls' },
  ];
  const groups = canonicalRelationshipGroupsForEntity({ entities: [], relations } as never, scene, new Set(), 'a');
  expect(groups.map(group => group.label)).toEqual(['Calls', 'Used by', 'Recursive relationships']);
  expect(groups.flatMap(group => group.rows).map(row => row.direction)).toEqual(['outbound', 'inbound', 'recursive']);
});

it('async scope search preserves synchronous ordering and individual-over-aggregate preference', async () => {
  const nestedSnapshot = { entities: [{ id: 'a', parentId: 'parent' }, { id: 'b', parentId: 'parent' }, { id: 'parent' }], relations: [{ id: 'r', from: 'a', to: 'b', kind: 'calls', evidence: [] }] } as never;
  const aggregate = { ...scene, entities: [entity('ownerA', 0), entity('ownerB', 200)], relations: [{ ...scene.relations[0]!, id: 'aggregate', from: 'ownerA', to: 'ownerB', semanticIds: ['r'] }] };
  const empty = { ...scene, relations: [], entities: [] };
  const calls: string[] = [];
  let active = 0;
  const result = await resolveRelationshipRevealAsync({ ...input, snapshot: nestedSnapshot, scene: empty,
    compileScope: async scope => {
      expect(active++).toBe(0);
      calls.push(scope); await Promise.resolve(); active--;
      return scope === 'parent' ? scene : aggregate;
    },
  });
  expect(calls).toEqual(['a', 'parent']);
  const sync = resolveRelationshipReveal({ ...input, snapshot: nestedSnapshot, scene: empty, compileScope: scope => scope === 'parent' ? scene : aggregate });
  expect(result).toEqual(sync);
  expect(result).toMatchObject({ status: 'ready', representation: 'individual' });
  const fallback = await resolveRelationshipRevealAsync({ ...input, snapshot: nestedSnapshot, scene: empty, compileScope: async () => aggregate });
  expect(fallback).toMatchObject({ status: 'ready', representation: 'aggregate' });
});
it('aborts async scope search before inspecting a late compile or dispatching another scope', async () => {
  const controller = new AbortController();
  let calls = 0;
  await expect(resolveRelationshipRevealAsync({ ...input, scene: { ...scene, relations: [] }, signal: controller.signal,
    compileScope: async () => { calls++; controller.abort(); return scene; },
  })).rejects.toMatchObject({ name: 'AbortError' });
  expect(calls).toBe(1);
});
it('rejects an early aggregate fallback after later scope merges advance its snapshot', async () => {
  let generation = 1;
  const fence = createSceneGenerationFence(() => generation);
  const candidates = createPreparedSceneGenerations<AtlasScene>(() => generation);
  const aggregate = { ...scene, entities: [entity('ownerA', 0), entity('ownerB', 200)], relations: [{ ...scene.relations[0]!, id: 'aggregate', from: 'ownerA', to: 'ownerB', semanticIds: ['r'] }] };
  candidates.record(aggregate);
  const calls: string[] = [];
  const prepared = await resolveRelationshipRevealAsync({ ...input, scene: aggregate,
    compileScope: async scope => {
      calls.push(scope);
      generation++;
      const empty = { ...scene, relations: [] };
      candidates.record(empty);
      fence.capture(generation);
      return empty;
    },
  });
  expect(calls).toEqual(['a', 'b']);
  expect(prepared).toMatchObject({ status: 'ready', representation: 'aggregate' });
  if (prepared.status !== 'ready') throw new Error('Expected aggregate fallback');
  expect(prepared.scene).toBe(aggregate);
  expect(fence.owns()).toBe(true); // Last compile alone would incorrectly permit publication.
  fence.capture(candidates.generationOf(prepared.scene)!);
  expect(fence.owns()).toBe(false);
});
