import { describe, expect, it } from 'vitest';
import snapshot from '../../../../fixtures/architecture/demo-snapshot.json';
import view from '../../../../fixtures/architecture/demo-view.json';
import story from '../../../../fixtures/architecture/demo-story.json';
import { createGoldenC4Scene } from '../renderer/goldenC4Scene';
import { compileScanFixture } from '../renderer/scanFixture';
import type { AtlasScene, SceneEntity, SemanticDetail } from '../renderer/types';
import { ghostEntitiesForEntries, silhouetteEntitiesForEntries, type SemanticLensPathEntry } from './semanticLens';
import { descendantsInDetail, sceneEntityIndex } from './sceneEntityIndex';

// The pre-index scans (main a5737b7), kept verbatim as the reference the index must match.
function scanDescendantsInDetail(scene: AtlasScene, targetId: string, detail: SemanticDetail) {
  const visible = new Set(scene.projection?.entityIdsByDetail[detail] ?? []);
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  return scene.entities.filter(entity => {
    if (!visible.has(entity.id)) return false;
    let current: SceneEntity | undefined = entity;
    const visited = new Set<string>();
    while (current && !visited.has(current.id)) {
      if (current.id === targetId) return true;
      visited.add(current.id);
      current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return false;
  });
}
const GHOST_SIBLING_OPACITY = [.24, .13, .07] as const;
function scanGhosts(scene: AtlasScene, entries: readonly SemanticLensPathEntry[]) {
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  const primary = entries.at(-1)
    ? new Set(scanDescendantsInDetail(scene, entries.at(-1)!.targetId, entries.at(-1)!.nextDetail).map(entity => entity.id).sort())
    : new Set<string>();
  const ancestors = new Set(entries.map(entry => entry.targetId));
  const ghosts = new Map<string, { id: string; depth: number; detail: SemanticDetail; opacity: number }>();
  const firstDepth = Math.max(0, entries.length - GHOST_SIBLING_OPACITY.length);
  for (let depth = firstDepth; depth < entries.length; depth += 1) {
    const entry = entries[depth]!;
    const target = byId.get(entry.targetId);
    if (!target) continue;
    const opacity = GHOST_SIBLING_OPACITY[entries.length - 1 - depth] ?? GHOST_SIBLING_OPACITY.at(-1)!;
    const siblings = scene.entities
      .filter(entity => entity.id !== target.id
        && entity.detail === entry.currentDetail
        && entity.parentId === target.parentId
        && Boolean(scene.projection?.boundsByEntityIdAndDetail[entity.id]?.[entry.currentDetail]))
      .sort((left, right) => left.id.localeCompare(right.id));
    for (const sibling of siblings) {
      if (primary.has(sibling.id) || ancestors.has(sibling.id) || ghosts.has(sibling.id)) continue;
      ghosts.set(sibling.id, { id: sibling.id, depth, detail: entry.currentDetail, opacity });
      if (ghosts.size >= 128) return [...ghosts.values()];
    }
  }
  return [...ghosts.values()];
}
function scanSilhouettes(scene: AtlasScene, entries: readonly SemanticLensPathEntry[]) {
  const ghosts = scanGhosts(scene, entries);
  const silhouettes: Array<{ id: string; parentGhostId: string; depth: number; detail: SemanticDetail; opacity: number }> = [];
  const excluded = new Set([...entries.map(entry => entry.targetId), ...ghosts.map(ghost => ghost.id)]);
  for (const ghost of ghosts.filter(candidate => candidate.opacity === .24).sort((left, right) => left.id.localeCompare(right.id))) {
    const detail = entries[ghost.depth]?.nextDetail;
    if (!detail) continue;
    const children = scene.entities
      .filter(entity => entity.parentId === ghost.id
        && entity.detail === detail
        && !excluded.has(entity.id)
        && Boolean(scene.projection?.boundsByEntityIdAndDetail[entity.id]?.[detail]))
      .sort((left, right) => left.id.localeCompare(right.id))
      .slice(0, 8);
    for (const child of children) {
      silhouettes.push({ id: child.id, parentGhostId: ghost.id, depth: ghost.depth, detail, opacity: .14 });
      excluded.add(child.id);
      if (silhouettes.length >= 48) return silhouettes;
    }
  }
  return silhouettes;
}

const details: SemanticDetail[] = ['context', 'container', 'component', 'code'];
/** Every root→entity lens path in the scene, one entry per expanded ancestor. */
function lensPaths(scene: AtlasScene): SemanticLensPathEntry[][] {
  const byId = new Map(scene.entities.map(entity => [entity.id, entity]));
  return scene.entities.filter(entity => entity.detail && entity.detail !== 'code').map(entity => {
    const chain: SceneEntity[] = [];
    for (let current: SceneEntity | undefined = entity; current && !chain.includes(current); current = current.parentId ? byId.get(current.parentId) : undefined) chain.unshift(current);
    return chain.filter(link => link.detail && link.detail !== 'code').map(link => ({
      targetId: link.id,
      currentDetail: link.detail!,
      nextDetail: details[details.indexOf(link.detail!) + 1] as SemanticLensPathEntry['nextDetail'],
    }));
  });
}

/** A seeded 1 + 24 + 480 + 5,760 entity tree; about 1 in 9 entities lacks bounds at its detail. */
function generatedScene(): AtlasScene {
  let seed = 581;
  const random = () => { seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648; return seed / 2_147_483_648; };
  const entities: SceneEntity[] = [];
  const bounds: NonNullable<AtlasScene['projection']>['boundsByEntityIdAndDetail'] = {};
  const byDetail: Record<SemanticDetail, string[]> = { context: [], container: [], component: [], code: [] };
  const add = (id: string, detail: SemanticDetail, parentId?: string) => {
    entities.push({ id, name: id, kind: detail === 'context' ? 'softwareSystem' : detail, detail, ...(parentId ? { parentId } : {}) } as SceneEntity);
    if (random() < 8 / 9) {
      bounds[id] = { [detail]: { x: random() * 1000, y: random() * 1000, width: 10, height: 10 } };
      byDetail[detail].push(id);
    }
  };
  add('system', 'context');
  for (let container = 0; container < 24; container += 1) {
    const containerId = `container:${container}`;
    add(containerId, 'container', 'system');
    for (let component = 0; component < 20; component += 1) {
      const componentId = `component:${container}:${component}`;
      add(componentId, 'component', containerId);
      for (let code = 0; code < 12; code += 1) add(`code:${container}:${component}:${code}`, 'code', componentId);
    }
  }
  // Scene order is not tree order in real compiles.
  for (let index = entities.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    [entities[index], entities[swap]] = [entities[swap]!, entities[index]!];
  }
  return { entities, relations: [], projection: { boundsByEntityIdAndDetail: bounds, entityIdsByDetail: byDetail } } as unknown as AtlasScene;
}

const fixture = compileScanFixture({ snapshot: structuredClone(snapshot), view: structuredClone(view), story: structuredClone(story) }, { targetAspect: 1440 / 900 });
// [name, scene, stride]: the old scans are quadratic, so the generated scene checks every 9th target/path.
const scenes: Array<[string, AtlasScene, number]> = [
  ['golden demo scene', createGoldenC4Scene(), 1],
  ['demo scan scene', fixture.createScene('container:web-app'), 1],
  ['generated 6,265-entity scene', generatedScene(), 9],
];

describe('per-scene entity index', () => {
  it.each(scenes)('returns exactly the old scans on the %s', (_name, scene, stride) => {
    const paths = lensPaths(scene).filter((_path, index) => index % stride === 0);
    expect(paths.length).toBeGreaterThan(3);
    for (const entity of scene.entities.filter((_entity, index) => index % stride === 0)) {
      for (const detail of details) expect(descendantsInDetail(scene, entity.id, detail)).toEqual(scanDescendantsInDetail(scene, entity.id, detail));
    }
    let ghostCount = 0;
    for (const entries of paths) {
      const ghosts = ghostEntitiesForEntries(scene, entries);
      ghostCount += ghosts.length;
      expect(JSON.stringify(ghosts)).toBe(JSON.stringify(scanGhosts(scene, entries)));
      expect(JSON.stringify(silhouetteEntitiesForEntries(scene, entries))).toBe(JSON.stringify(scanSilhouettes(scene, entries)));
    }
    expect(ghostCount).toBeGreaterThan(0);
  }, 60_000);

  it('builds once per entities array and rebuilds when the entities change', () => {
    const scene = createGoldenC4Scene();
    const index = sceneEntityIndex(scene);
    expect(sceneEntityIndex({ ...scene, title: 'moved camera' })).toBe(index);
    expect(sceneEntityIndex({ ...scene, entities: [...scene.entities] })).not.toBe(index);
  });
});
