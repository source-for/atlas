import { inspectorAcceptedSummary } from './inspectorPanel';
import type { ArchitectureSnapshot } from '@okie/architecture';

export interface ContextualOverviewLink { id: string; name: string; relationship: string; }
export interface ContextualOverview {
  entity: { id: string; name: string; kind: string; summary?: string };
  parent?: { id: string; name: string; kind: string };
  children: ContextualOverviewLink[];
  dependencies: ContextualOverviewLink[];
  dependents: ContextualOverviewLink[];
  componentBasis?: 'authored' | 'file';
  implementationFiles?: Array<{ path: string; code: ContextualOverviewLink[] }>;
}

/** A tour's logical selection owns its overview even when a guarded scene's
 * semantic lens can represent only the root. Idle exploration follows context.
 */
export function contextualOverviewEntityId(input: {
  selectedId: string;
  storyStep: number;
  explicitSelection: boolean;
  lensEntityId?: string;
  rootEntityId: string;
}): string {
  return input.storyStep >= 0 || input.explicitSelection
    ? input.selectedId : input.lensEntityId ?? input.rootEntityId;
}

export function buildContextualOverview(snapshot: ArchitectureSnapshot, entityId: string): ContextualOverview | undefined {
  const entity = snapshot.entities.find((candidate) => candidate.id === entityId);
  if (!entity) return undefined;
  const entities = new Map(snapshot.entities.map((candidate) => [candidate.id, candidate]));
  const link = (id: string, relationship: string): ContextualOverviewLink => ({ id, name: entities.get(id)?.name ?? id, relationship });
  const order = (items: ContextualOverviewLink[]) => Array.from(new Map(items.map(item => [`${item.id}:${item.relationship}`, item])).values()).sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));
  const parent = entity.parentId ? entities.get(entity.parentId) : undefined;
  const authoredComponent = entity.kind === 'component' && entity.tags?.includes('okie:component-mapping');
  const paths = [...new Set(entity.sourceRefs.map(ref => ref.path))].sort();
  const fileComponent = entity.kind === 'component' && paths.length === 1
    && (paths[0] === entity.name || paths[0]?.endsWith(`/${entity.name}`));
  return {
    entity: { id: entity.id, name: entity.name, kind: entity.kind, summary: inspectorAcceptedSummary(entity) },
    parent: parent ? { id: parent.id, name: parent.name, kind: parent.kind } : undefined,
    ...(authoredComponent || fileComponent ? { componentBasis: authoredComponent ? 'authored' as const : 'file' as const } : {}),
    ...(authoredComponent ? { implementationFiles: paths.map(path => ({ path, code: order(snapshot.entities
      .filter(candidate => candidate.kind === 'code' && candidate.parentId === entityId && candidate.sourceRefs.some(ref => ref.path === path))
      .map(candidate => link(candidate.id, 'code'))) })) } : {}),
    children: order(snapshot.entities.filter((candidate) => candidate.parentId === entityId).map((candidate) => link(candidate.id, candidate.kind))),
    dependencies: order(snapshot.relations.filter((relation) => relation.from === entityId && relation.to !== entityId).map((relation) => link(relation.to, relation.label ?? relation.kind))),
    dependents: order(snapshot.relations.filter((relation) => relation.to === entityId && relation.from !== entityId).map((relation) => link(relation.from, relation.label ?? relation.kind))),
  };
}
