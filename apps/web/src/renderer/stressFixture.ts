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

/** The portable viewer build (`vite build --mode portable`) omits the 8 MB fixture: this folds to false there, so its chunk is never emitted. */
const stressFixtureIncluded = import.meta.env.MODE !== 'portable';
const STRESS_EXCLUDED_MESSAGE = 'The renderer stress fixture is not included in the portable viewer.';

/** Copy for the stand-in scene shown while the fixture loads, or in its place where the build omits it. */
export const stressPlaceholder = stressFixtureIncluded
  ? { title: 'Loading stress fixture…', subtitle: 'deterministic · lazy renderer payload', name: 'Preparing 5k scene', responsibility: 'Loading the generated renderer stress fixture' }
  : { title: 'Stress fixture not included', subtitle: 'portable viewer · open ?fixture=stress in the dev app', name: 'Not in this viewer', responsibility: STRESS_EXCLUDED_MESSAGE };

export async function loadStressFixture(): Promise<AtlasScene> {
  if (!stressFixtureIncluded) throw new Error(STRESS_EXCLUDED_MESSAGE);
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
