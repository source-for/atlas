import type { AtlasScene, SceneEntity, SceneRelation } from './types';

type ProtocolRect = { x: number; y: number; width: number; height: number };
type ProtocolObject = {
  id: string;
  bounds: ProtocolRect;
  representations?: Array<{ primitives?: Array<{ kind?: string; content?: string }> }>;
};
type ProtocolPath = { id: string; fromObjectId: string; toObjectId: string };
type ProtocolSnapshot = {
  sceneId: string;
  objects: ProtocolObject[];
  paths: ProtocolPath[];
};

function isProtocolSnapshot(value: unknown): value is ProtocolSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<ProtocolSnapshot>;
  return typeof candidate.sceneId === 'string' && Array.isArray(candidate.objects) && Array.isArray(candidate.paths);
}

function objectName(object: ProtocolObject) {
  for (const representation of object.representations ?? []) {
    const label = representation.primitives?.find(primitive => primitive.kind === 'text' && primitive.content)?.content;
    if (label) return label;
  }
  return object.id;
}

export async function loadStressFixture(): Promise<AtlasScene> {
  // The portable viewer build (`vite build --mode portable`) folds this to a throw, so the 8 MB fixture chunk is never emitted.
  if (import.meta.env.MODE === 'portable') throw new Error('The renderer stress fixture is not included in the portable viewer.');
  const module = await import('../../../../fixtures/renderer/stress-5000.json');
  const snapshot: unknown = module.default;
  if (!isProtocolSnapshot(snapshot)) throw new Error('The generated stress fixture is not a valid renderer scene snapshot.');

  const entities: SceneEntity[] = snapshot.objects.map(object => ({
    id: object.id,
    name: objectName(object),
    kind: 'component',
    responsibility: 'Deterministic synthetic renderer stress node',
    x: object.bounds.x,
    y: object.bounds.y,
    width: object.bounds.width,
    height: object.bounds.height,
    confidence: 1,
    tags: ['stress fixture'],
  }));
  const relations: SceneRelation[] = snapshot.paths.map(path => ({
    id: path.id,
    from: path.fromObjectId,
    to: path.toObjectId,
    label: 'Synthetic dependency',
    protocol: 'benchmark',
  }));

  return {
    id: snapshot.sceneId,
    title: '5k renderer stress fixture',
    subtitle: 'deterministic · 5,000 nodes / 15,000 paths',
    entities,
    relations,
    regions: [],
    protocolSnapshot: snapshot,
  };
}
