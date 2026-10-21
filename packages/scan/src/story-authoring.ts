import {
  STORY_AUTHORING_LIMITS,
  type ArchitectureEntity,
  type ArchitectureRelation,
  type EntityId,
  type RelationId,
  type SourceRef,
  type StoryDetail,
  type StoryStep,
  compareText,
} from "@okie/architecture";

const MAX_TRACES = STORY_AUTHORING_LIMITS.maxTraceRelationsPerStep;
const MAX_SOURCE_REFS = STORY_AUTHORING_LIMITS.maxSourceRefsPerStep;

export function compareEntityId(left: string, right: string): number {
  return compareText(left, right);
}

/**
 * Story display text (a title, a narration) within an authoring limit. Repository
 * names (a package name may be 214 characters) and entity names (up to 160) are
 * interpolated into prose, so text over `limit` code points is cut, never splitting a
 * surrogate pair, and ends with an ellipsis instead of failing story validation.
 * Display only: ids, entity names and source refs are never derived from it.
 */
export function boundedDisplayText(text: string, limit: number): string {
  const codePoints = Array.from(text);
  return codePoints.length <= limit ? text : `${codePoints.slice(0, limit - 1).join("")}…`;
}

export function citedRefs(entity: ArchitectureEntity | undefined): SourceRef[] | undefined {
  if (!entity?.sourceRefs.length) return undefined;
  return entity.sourceRefs.slice(0, MAX_SOURCE_REFS).map(ref => ({ ...ref }));
}

/**
 * Optional CLA-28 polish: after a gated enrichment pass, accepted section
 * summaries land on `responsibility`. Mention them in narration when they fit
 * the authoring cap; otherwise keep the deterministic copy (enrichment off
 * and gate reject take this path because the field is absent).
 */
export function withAcceptedSummary(deterministic: string, entity: ArchitectureEntity | undefined): string {
  const summary = entity?.responsibility?.trim();
  if (!summary || deterministic.includes(summary)) return deterministic;
  const glue = /[.!?]$/u.test(deterministic) ? " " : ". ";
  const combined = `${deterministic}${glue}${summary}`;
  return combined.length <= STORY_AUTHORING_LIMITS.maxNarrationCharacters
    ? combined
    : deterministic;
}

export function connectedTraces(
  focusIds: readonly EntityId[],
  relations: readonly ArchitectureRelation[],
  visible: ReadonlySet<RelationId>,
): RelationId[] | undefined {
  const focused = new Set(focusIds);
  const ids = relations
    .filter(relation => visible.has(relation.id) && (focused.has(relation.from) || focused.has(relation.to)))
    .map(relation => relation.id)
    .sort(compareEntityId)
    .slice(0, MAX_TRACES);
  return ids.length ? ids : undefined;
}

export function authoredStoryStep(params: {
  id: string;
  title: string;
  focus: readonly ArchitectureEntity[];
  relations: readonly ArchitectureRelation[];
  visibleRelations: ReadonlySet<RelationId>;
  reveal: StoryDetail;
  narration: string;
  durationMs: number;
  evidenceFrom?: ArchitectureEntity;
}): StoryStep {
  const focusEntityIds = params.focus.map(entity => entity.id);
  const traceRelationIds = connectedTraces(focusEntityIds, params.relations, params.visibleRelations);
  const sourceRefs = citedRefs(params.evidenceFrom ?? params.focus[0]);
  return {
    id: params.id,
    title: boundedDisplayText(params.title, STORY_AUTHORING_LIMITS.maxStepTitleCharacters),
    focusEntityIds,
    ...(traceRelationIds ? { traceRelationIds } : {}),
    reveal: params.reveal,
    narration: boundedDisplayText(params.narration, STORY_AUTHORING_LIMITS.maxNarrationCharacters),
    ...(sourceRefs ? { sourceRefs } : {}),
    durationMs: params.durationMs,
  };
}

export function kindLabel(kind: ArchitectureEntity["kind"]): string {
  if (kind === "softwareSystem") return "software system";
  if (kind === "externalSystem") return "external system";
  if (kind === "dataStore") return "data store";
  return kind;
}
