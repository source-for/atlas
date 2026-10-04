import type { ArchitectureSnapshot } from '@okie/architecture';
import type { AtlasScene, SceneRelation, SemanticDetail } from '../renderer/types';
import type { SafeArea, ViewportSize } from '../storyFraming';
import { semanticLensSessionDetail, semanticLensSessionVisibleEntityIds, semanticLensSessionVisibleRelationIds, type SemanticLensSession } from '../semantic/semanticLens';
import { semanticLevelSession } from '../semantic/semanticLensEngine';
import { relationFramingPlan, type RelationFramingPlan } from './relationFraming';

/** Evidence selection must not depend on the current compiled neighborhood. */
export function canonicalRelationForInspection(snapshot: ArchitectureSnapshot, relationId: string): SceneRelation | undefined {
  const relation = snapshot.relations.find(candidate => candidate.id === relationId);
  return relation && { id: relation.id, from: relation.from, to: relation.to, label: relation.label ?? relation.kind, kindLabel: relation.kind, semanticIds: [relation.id] };
}

type RevealInput = {
  snapshot: ArchitectureSnapshot;
  scene: AtlasScene;
  relationId: string;
  session: SemanticLensSession;
  viewport: ViewportSize;
  safeArea: SafeArea;
  /** Use App's composeScene(focusId, currentScene, authoringHistoryRef.current.present) seam. */
  compileScope?: (focusId: string) => AtlasScene;
};
export type RelationshipRevealResult = { status: 'ready'; scene: AtlasScene; session: SemanticLensSession; relation: SceneRelation; framing: RelationFramingPlan; representation: 'individual' | 'aggregate' }
  | { status: 'unavailable'; reason: string };

/** Resolve a real retained route, trying guarded scoped compilation before reporting failure.
 * This plan contains no entity selection, inspector tab, expansion, or navigation mutation.
 */
function relationshipRevealSearch(input: Omit<RevealInput, 'compileScope'>) {
  const canonical = canonicalRelationForInspection(input.snapshot, input.relationId);
  if (!canonical) return { inspect: (_scene: AtlasScene) => undefined as Extract<RelationshipRevealResult, { status: 'ready' }> | undefined,
    scopes: [] as string[], finish: (): RelationshipRevealResult => ({ status: 'unavailable', reason: 'This relationship was not captured in the snapshot.' }) };
  const details: SemanticDetail[] = ['code', 'component', 'container', 'context'];
  let aggregate: Extract<RelationshipRevealResult, { status: 'ready' }> | undefined;
  function inspect(scene: AtlasScene): Extract<RelationshipRevealResult, { status: 'ready' }> | undefined {
    for (const detail of details) {
      const routes = scene.projection?.projectedRelationsByDetail[detail] ?? scene.relations;
      for (const route of routes) {
        if (route.id !== canonical!.id && !route.semanticIds?.includes(canonical!.id)) continue;
        if (!route.routePoints || route.routePoints.length < 2) continue;
        const sessions = [input.session, semanticLevelSession(scene, detail, [route.from, route.to])];
        for (const session of sessions) {
          if (scene.projection && semanticLensSessionDetail(session) !== detail) continue;
          const entities = new Set(semanticLensSessionVisibleEntityIds(scene, session));
          const relations = new Set(semanticLensSessionVisibleRelationIds(scene, session));
          if (!entities.has(route.from) || !entities.has(route.to) || !relations.has(route.id)) continue;
          const framing = relationFramingPlan(scene, route, detail, input.viewport, input.safeArea);
          if (!framing) continue;
          const availableWidth = input.viewport.width - input.safeArea.left - input.safeArea.right;
          const availableHeight = input.viewport.height - input.safeArea.top - input.safeArea.bottom;
          if (framing.bounds.width * framing.camera.zoom > availableWidth
            || framing.bounds.height * framing.camera.zoom > availableHeight) continue;
          const representation: 'individual' | 'aggregate' = route.from === canonical!.from && route.to === canonical!.to && (route.semanticIds?.length ?? 1) <= 1 ? 'individual' : 'aggregate';
          const result = { status: 'ready' as const, scene, session, relation: route, framing, representation };
          if (representation === 'individual') return result;
          aggregate ??= result;
        }
      }
    }
    return undefined;
  }
  const byId = new Map(input.snapshot.entities.map(entity => [entity.id, entity]));
  const scopes = new Set<string>();
  for (const endpoint of [canonical.from, canonical.to]) {
    let entity = byId.get(endpoint);
    const visited = new Set<string>();
    while (entity && !visited.has(entity.id)) {
      visited.add(entity.id);
      scopes.add(entity.id);
      entity = entity.parentId ? byId.get(entity.parentId) : undefined;
    }
  }
  return { inspect, scopes: [...scopes], finish: (): RelationshipRevealResult => aggregate
    ?? { status: 'unavailable', reason: 'This relationship is captured, but no supported connecting route is available in its scoped maps. Its evidence remains available.' } };
}

export function resolveRelationshipReveal(input: RevealInput): RelationshipRevealResult {
  const search = relationshipRevealSearch(input);
  const resident = search.inspect(input.scene);
  if (resident) return resident;
  if (input.compileScope) {
    for (const scope of search.scopes) {
      const result = search.inspect(input.compileScope(scope));
      if (result) return result;
    }
  }
  return search.finish();
}

/** Same deterministic scope search and aggregate fallback, with one bounded
 * compile at a time. Callers retain publication ownership across each await. */
export async function resolveRelationshipRevealAsync(input: Omit<RevealInput, 'compileScope'> & {
  compileScope?: (focusId: string) => Promise<AtlasScene>;
  signal?: AbortSignal;
}): Promise<RelationshipRevealResult> {
  const checkAbort = () => {
    if (input.signal?.aborted) throw input.signal.reason ?? new DOMException('Aborted', 'AbortError');
  };
  checkAbort();
  const search = relationshipRevealSearch(input);
  const resident = search.inspect(input.scene);
  if (resident) return resident;
  if (input.compileScope) {
    for (const scope of search.scopes) {
      checkAbort();
      const scene = await input.compileScope(scope);
      checkAbort();
      const result = search.inspect(scene);
      if (result) return result;
    }
  }
  return search.finish();
}
