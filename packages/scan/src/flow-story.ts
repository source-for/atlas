import {
  STORY_AUTHORING_LIMITS,
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type EntityKind,
  type RelationId,
  type StoryDetail,
  compareText,
} from "@okie/architecture";
import { typedId } from "./ids.js";
import { authoredStoryStep, kindLabel, withAcceptedSummary } from "./story-authoring.js";

/**
 * Documented user-flow templates (CLA-77). Each step matches a snapshot entity
 * by repo-relative path (and optional symbol). Flows emit only when every
 * required step resolves to an id that exists after scan — generic repos
 * without these surfaces keep the C4 overview alone. Copy is structural
 * (name / kind / role); accepted `responsibility` is appended when present.
 */
export const USER_FLOW_TEMPLATES = [
  {
    id: "paste-a-repo",
    title: "Paste a repository",
    steps: [
      {
        id: "step:paste-web",
        role: "the web app that serves /new",
        path: "apps/web/src/scanLanding.tsx",
        kind: "container",
        reveal: "container",
        durationMs: 1_600,
        required: false,
      },
      {
        id: "step:paste-landing",
        role: "the /new paste-a-repo landing",
        path: "apps/web/src/scanLanding.tsx",
        kind: "component",
        reveal: "component",
        durationMs: 1_800,
      },
      {
        id: "step:paste-scan",
        role: "the scan job that publishes the atlas",
        path: "apps/server/src/scanService.ts",
        symbol: "createScanJobRunner",
        kind: "code",
        reveal: "code",
        durationMs: 1_800,
      },
      {
        id: "step:paste-atlas",
        role: "the hosted atlas the scan opens",
        path: "apps/web/src/App.tsx",
        kind: "component",
        reveal: "component",
        durationMs: 2_000,
      },
    ],
  },
  {
    id: "ask",
    title: "Ask the atlas",
    steps: [
      {
        id: "step:ask-client",
        role: "the Ask client that packs the visible scope",
        path: "apps/web/src/ask/askAtlas.ts",
        kind: "component",
        reveal: "component",
        durationMs: 1_800,
      },
      {
        id: "step:ask-server",
        role: "the Ask endpoint that answers from those packets",
        path: "apps/server/src/ask.ts",
        symbol: "answerAskQuestion",
        kind: "code",
        reveal: "code",
        durationMs: 2_000,
      },
    ],
  },
  {
    id: "embed",
    title: "Embed the atlas",
    steps: [
      {
        id: "step:embed-oembed",
        role: "the oEmbed endpoint docs sites call",
        path: "apps/web/src/oembed.ts",
        kind: "component",
        reveal: "component",
        durationMs: 1_800,
      },
      {
        id: "step:embed-frame",
        role: "the framed atlas GPU path",
        path: "apps/web/src/embedCanvas.ts",
        symbol: "autoGpuAttemptOrder",
        kind: "code",
        reveal: "code",
        durationMs: 1_800,
      },
      {
        id: "step:embed-atlas",
        role: "the atlas rendered inside the embed",
        path: "apps/web/src/App.tsx",
        kind: "component",
        reveal: "component",
        durationMs: 2_000,
      },
    ],
  },
] as const satisfies readonly UserFlowTemplate[];

export const STORY_CATALOG_SCHEMA_VERSION = 1 as const;

export type PublishedStoryCatalog = {
  schemaVersion: typeof STORY_CATALOG_SCHEMA_VERSION;
  /** Overview first, then any emitted user-flow stories. */
  stories: ArchitectureStory[];
};

type UserFlowStepTemplate = {
  id: string;
  role: string;
  path: string;
  symbol?: string;
  kind: EntityKind;
  reveal: StoryDetail;
  durationMs: number;
  required?: boolean;
};

type UserFlowTemplate = {
  id: string;
  title: string;
  steps: readonly UserFlowStepTemplate[];
};

export type FlowEntityMatch = {
  path: string;
  symbol?: string;
  kind?: EntityKind;
};

function pathMatches(entity: ArchitectureEntity, match: FlowEntityMatch): boolean {
  return entity.sourceRefs.some(ref => {
    if (ref.path !== match.path) return false;
    if (match.symbol !== undefined && ref.symbol !== match.symbol) return false;
    return true;
  });
}

function ancestorOfKind(
  entity: ArchitectureEntity,
  kind: EntityKind,
  byId: ReadonlyMap<string, ArchitectureEntity>,
): ArchitectureEntity | undefined {
  let current: ArchitectureEntity | undefined = entity;
  const seen = new Set<string>();
  while (current) {
    if (seen.has(current.id)) return undefined;
    seen.add(current.id);
    if (current.kind === kind) return current;
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return undefined;
}

/** Snapshot entity for a template match. Ties break by id so emission is order-independent. */
export function findFlowEntity(
  entities: readonly ArchitectureEntity[],
  match: FlowEntityMatch,
): ArchitectureEntity | undefined {
  const byId = new Map(entities.map(entity => [entity.id, entity]));
  const direct = entities.filter(entity => {
    if (match.kind && entity.kind !== match.kind) return false;
    return pathMatches(entity, match);
  });
  direct.sort((left, right) => compareText(left.id, right.id));
  if (direct[0]) return direct[0];
  if (!match.kind || match.kind === "code") return undefined;
  const leafMatch: FlowEntityMatch = match.symbol
    ? { path: match.path, symbol: match.symbol }
    : { path: match.path };
  const leaves = entities.filter(entity => pathMatches(entity, leafMatch));
  leaves.sort((left, right) => compareText(left.id, right.id));
  for (const leaf of leaves) {
    const ancestor = ancestorOfKind(leaf, match.kind, byId);
    if (ancestor) return ancestor;
  }
  return undefined;
}

function structuralTitle(entity: ArchitectureEntity, role: string): string {
  const title = `${entity.name} · ${role}`;
  return title.length <= STORY_AUTHORING_LIMITS.maxStepTitleCharacters
    ? title
    : entity.name.slice(0, STORY_AUTHORING_LIMITS.maxStepTitleCharacters);
}

function structuralNarration(entity: ArchitectureEntity, role: string): string {
  return withAcceptedSummary(
    `${entity.name} is a ${kindLabel(entity.kind)} in this flow (${role}).`,
    entity,
  );
}

function resolveFlowStep(
  template: UserFlowStepTemplate,
  snapshot: ArchitectureSnapshot,
  relations: readonly ArchitectureRelation[],
  visibleRelations: ReadonlySet<RelationId>,
): ReturnType<typeof authoredStoryStep> | undefined {
  const entity = findFlowEntity(snapshot.entities, {
    path: template.path,
    ...(template.symbol ? { symbol: template.symbol } : {}),
    kind: template.kind,
  });
  if (!entity) return undefined;
  return authoredStoryStep({
    id: template.id,
    title: structuralTitle(entity, template.role),
    focus: [entity],
    relations,
    visibleRelations,
    reveal: template.reveal,
    narration: structuralNarration(entity, template.role),
    durationMs: template.durationMs,
  });
}

/**
 * Deterministic user-flow stories whose steps are real snapshot ids. Missing
 * surfaces omit that flow; they never invent entities or prose.
 */
export function buildUserFlowStories(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  repositorySlug: string,
  systemName: string,
): ArchitectureStory[] {
  const visibleEntities = new Set(view.entityIds);
  const visibleRelations = new Set(view.relationIds);
  const entities = snapshot.entities.filter(entity => visibleEntities.has(entity.id));
  const relations = snapshot.relations.filter(relation => visibleRelations.has(relation.id));
  const scoped: ArchitectureSnapshot = { ...snapshot, entities, relations };
  const stories: ArchitectureStory[] = [];

  for (const template of USER_FLOW_TEMPLATES) {
    const steps = [];
    let missingRequired = false;
    for (const stepTemplate of template.steps) {
      const resolved = resolveFlowStep(stepTemplate, scoped, relations, visibleRelations);
      if (resolved) {
        steps.push(resolved);
        continue;
      }
      if ("required" in stepTemplate && stepTemplate.required === false) continue;
      missingRequired = true;
      break;
    }
    if (missingRequired || steps.length < 2) continue;
    if (steps.length > STORY_AUTHORING_LIMITS.maxSteps) steps.length = STORY_AUTHORING_LIMITS.maxSteps;
    stories.push({
      schemaVersion: 1,
      id: typedId("story", repositorySlug, template.id),
      snapshotId: snapshot.id,
      viewId: view.id,
      title: `${systemName}: ${template.title}`,
      steps,
    });
  }
  return stories;
}

export function publishedStoryCatalog(stories: readonly ArchitectureStory[]): PublishedStoryCatalog {
  return { schemaVersion: STORY_CATALOG_SCHEMA_VERSION, stories: [...stories] };
}
