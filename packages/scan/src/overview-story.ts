import {
  STORY_AUTHORING_LIMITS,
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type EntityId,
  type StoryStep,
} from "@okie/architecture";
import { typedId } from "./ids.js";
import {
  authoredStoryStep as step,
  compareEntityId as compareId,
  withAcceptedSummary,
} from "./story-authoring.js";

const MAX_FOCUS = STORY_AUTHORING_LIMITS.maxFocusEntitiesPerStep;

/**
 * A step title within the authoring limit. Titles embed entity names (up to the
 * extraction gate's 160 characters), so a long one is cut by code point with an
 * ellipsis instead of failing story validation.
 */
function stepTitle(title: string): string {
  const codePoints = Array.from(title);
  const limit = STORY_AUTHORING_LIMITS.maxStepTitleCharacters;
  return codePoints.length <= limit ? title : `${codePoints.slice(0, limit - 1).join("")}…`;
}

function joinEnglish(items: readonly string[]): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items.slice(0, -1).join(", ")}, and ${items[items.length - 1]}`;
}

function countBy(items: readonly ArchitectureEntity[], parentId: EntityId): number {
  let count = 0;
  for (const entity of items) if (entity.parentId === parentId) count += 1;
  return count;
}

function degree(id: EntityId, relations: readonly ArchitectureRelation[]): number {
  let count = 0;
  for (const relation of relations) {
    if (relation.from === id || relation.to === id) count += 1;
  }
  return count;
}

/** Higher score first; ties break by id so the tour is order-independent. */
function rankEntities(
  entities: readonly ArchitectureEntity[],
  score: (entity: ArchitectureEntity) => number,
): ArchitectureEntity[] {
  return [...entities].sort((left, right) => score(right) - score(left) || compareId(left.id, right.id));
}

function takeFocus(entities: readonly ArchitectureEntity[], limit = MAX_FOCUS): ArchitectureEntity[] {
  return entities.slice(0, limit);
}

/**
 * Deterministic C4 overview tour for a scanned snapshot: system context, the
 * surrounding world, containers, then one evidence-backed descent to a
 * representative component and code entity. Ranks, step ids, titles, focus,
 * traces, and reveals come only from observed structure (child counts,
 * relation degree, ids). After a gated enrichment pass, step narration may
 * mention an accepted summary; the compiler is not replaced by an LLM-written
 * story.
 */
export function buildOverviewStory(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  systemId: string,
  repositorySlug: string,
  systemName: string,
): ArchitectureStory {
  const visibleEntities = new Set(view.entityIds);
  const visibleRelations = new Set(view.relationIds);
  const entities = snapshot.entities.filter(entity => visibleEntities.has(entity.id));
  const relations = snapshot.relations.filter(relation => visibleRelations.has(relation.id));
  const system = entities.find(entity => entity.id === systemId);
  if (!system) throw new Error(`Overview story is missing system ${systemId}`);

  const persons = entities.filter(entity => entity.kind === "person");
  const externals = entities.filter(entity => entity.kind === "externalSystem");
  const containers = entities.filter(entity => entity.kind === "container");
  const components = entities.filter(entity => entity.kind === "component");
  const code = entities.filter(entity => entity.kind === "code");

  const neighbors = rankEntities([...persons, ...externals], entity => degree(entity.id, relations));
  const rankedContainers = rankEntities(containers, entity =>
    countBy(components, entity.id) * 1_000 + degree(entity.id, relations));
  const featuredContainer = rankedContainers[0];
  const containerComponents = featuredContainer
    ? rankEntities(components.filter(entity => entity.parentId === featuredContainer.id), entity =>
      countBy(code, entity.id) * 1_000 + degree(entity.id, relations))
    : [];
  const featuredComponent = containerComponents[0];
  const componentCode = featuredComponent
    ? [...code.filter(entity => entity.parentId === featuredComponent.id)]
      .sort((left, right) =>
        (left.sourceRefs[0]?.startLine ?? 0) - (right.sourceRefs[0]?.startLine ?? 0)
        || compareId(left.id, right.id))
    : [];
  const featuredCode = componentCode[0];

  const contextFocus = takeFocus([system, ...neighbors]);
  const worldNames = contextFocus.filter(entity => entity.id !== system.id).map(entity => entity.name);
  const contextNarration = worldNames.length
    ? `${systemName} is a software system with ${containers.length} container${containers.length === 1 ? "" : "s"}. It meets the world through ${joinEnglish(worldNames)}.`
    : `${systemName} is a software system with ${containers.length} container${containers.length === 1 ? "" : "s"}.`;

  const steps: StoryStep[] = [
    step({
      id: "step:context",
      title: stepTitle(`Start with ${systemName}`),
      focus: contextFocus,
      relations,
      visibleRelations,
      reveal: "context",
      narration: withAcceptedSummary(contextNarration, system),
      durationMs: 1_600,
      evidenceFrom: system,
    }),
  ];

  const containerFocus = takeFocus(rankedContainers);
  if (containerFocus.length > 1) {
    steps.push(step({
      id: "step:containers",
      title: stepTitle(`Inside ${systemName}`),
      focus: containerFocus,
      relations,
      visibleRelations,
      reveal: "container",
      narration: `${systemName}'s containers include ${joinEnglish(containerFocus.map(entity => entity.name))}.`,
      durationMs: 1_800,
      ...(featuredContainer ? { evidenceFrom: featuredContainer } : {}),
    }));
  }

  if (featuredContainer) {
    const childCount = countBy(components, featuredContainer.id);
    steps.push(step({
      id: "step:container",
      title: stepTitle(`Look inside ${featuredContainer.name}`),
      focus: [featuredContainer],
      relations,
      visibleRelations,
      reveal: "container",
      narration: withAcceptedSummary(
        childCount > 0
          ? `${featuredContainer.name} holds ${childCount} component${childCount === 1 ? "" : "s"}.`
          : `${featuredContainer.name} is a container in ${systemName}.`,
        featuredContainer,
      ),
      durationMs: 1_800,
    }));
  }

  if (featuredComponent) {
    const childCount = countBy(code, featuredComponent.id);
    steps.push(step({
      id: "step:component",
      title: stepTitle(`Open ${featuredComponent.name}`),
      focus: [featuredComponent],
      relations,
      visibleRelations,
      reveal: "component",
      narration: withAcceptedSummary(
        `${featuredComponent.name} is a component in ${featuredContainer!.name}, with ${childCount} source declaration${childCount === 1 ? "" : "s"}.`,
        featuredComponent,
      ),
      durationMs: 1_800,
    }));
  }

  if (featuredCode) {
    const ref = featuredCode.sourceRefs[0];
    const location = ref?.path
      ? (ref.symbol ? `${ref.symbol} in ${ref.path}` : ref.path)
      : featuredCode.name;
    steps.push(step({
      id: "step:code",
      title: stepTitle(`Read ${featuredCode.name}`),
      focus: [featuredCode],
      relations,
      visibleRelations,
      reveal: "code",
      narration: withAcceptedSummary(
        `${location} is a source-level declaration in ${featuredComponent!.name}.`,
        featuredCode,
      ),
      durationMs: 2_000,
    }));
  }

  if (steps.length > STORY_AUTHORING_LIMITS.maxSteps) {
    steps.length = STORY_AUTHORING_LIMITS.maxSteps;
  }

  return {
    schemaVersion: 1,
    id: typedId("story", repositorySlug, "overview"),
    snapshotId: snapshot.id,
    viewId: view.id,
    title: `${systemName} overview`,
    steps,
  };
}
