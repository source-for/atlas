import {
  ARCHITECTURE_SCHEMA_VERSION,
  SOURCE_EXCERPT_LIMITS,
  STORY_AUTHORING_LIMITS,
  type ArchitectureOverrides,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type Point,
  type Rect,
  type SourceExcerpt,
  type SourceRef,
  type StoryDetail,
} from "./model.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort();
}

function isUnitInterval(value: number): boolean {
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

function validatePoint(point: Point, path: string, issues: ValidationIssue[]): void {
  if (!Number.isFinite(point.x)) issues.push({ path: `${path}.x`, message: "must be finite" });
  if (!Number.isFinite(point.y)) issues.push({ path: `${path}.y`, message: "must be finite" });
}

function validateRect(rect: Rect, path: string, issues: ValidationIssue[]): void {
  validatePoint(rect, path, issues);
  if (!Number.isFinite(rect.width) || rect.width <= 0) {
    issues.push({ path: `${path}.width`, message: "must be finite and greater than 0" });
  }
  if (!Number.isFinite(rect.height) || rect.height <= 0) {
    issues.push({ path: `${path}.height`, message: "must be finite and greater than 0" });
  }
}

function unicodeLength(value: string): number {
  return [...value].length;
}

function isRepositoryRelativePath(value: string): boolean {
  if (typeof value !== 'string' || !value || value.startsWith("/") || value.startsWith("\\")
    || /^[A-Za-z]:[\\/]/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
  if (value.includes("\\")) return false;
  const segments = value.split("/");
  return segments.every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function languageForPath(path: string): SourceExcerpt['language'] | undefined {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts') || path.endsWith('.mts') || path.endsWith('.cts')) return 'typescript';
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return 'javascript';
  if (path.endsWith('.rs')) return 'rust';
  return undefined;
}

function validateSourceRef(source: SourceRef, path: string, issues: ValidationIssue[]): void {
  if (!isRepositoryRelativePath(source.path)) {
    issues.push({ path: `${path}.path`, message: "must be a non-empty repository-relative path" });
  } else if (unicodeLength(source.path) > SOURCE_EXCERPT_LIMITS.maxPathCharacters) {
    issues.push({ path: `${path}.path`, message: `must not exceed ${SOURCE_EXCERPT_LIMITS.maxPathCharacters} characters` });
  }
  if (typeof source.commitSha !== "string" || !source.commitSha.trim()) {
    issues.push({ path: `${path}.commitSha`, message: "must pin evidence to a commit" });
  }
  if (source.symbol !== undefined && (typeof source.symbol !== "string"
    || !source.symbol.trim() || unicodeLength(source.symbol) > SOURCE_EXCERPT_LIMITS.maxSymbolCharacters)) {
    issues.push({ path: `${path}.symbol`, message: `must be non-blank and at most ${SOURCE_EXCERPT_LIMITS.maxSymbolCharacters} characters` });
  }
  if (source.startLine !== undefined && (!Number.isSafeInteger(source.startLine) || source.startLine < 1)) {
    issues.push({ path: `${path}.startLine`, message: "must be a finite positive integer" });
  }
  if (
    source.endLine !== undefined &&
    (!Number.isSafeInteger(source.endLine) || source.endLine < 1 || source.endLine < (source.startLine ?? 1))
  ) {
    issues.push({ path: `${path}.endLine`, message: "must be a finite positive integer not preceding startLine" });
  }
}

/** Bind a captured window to its declaration, or an exact legacy reference. */
export function sourceExcerptMatchesRef(excerpt: SourceExcerpt, source: SourceRef): boolean {
  if (source.path !== excerpt.path || source.commitSha !== excerpt.frozenRevision
    || (source.symbol ?? '') !== (excerpt.symbol ?? '')) return false;
  const hasOriginal = excerpt.sourceStartLine !== undefined || excerpt.sourceEndLine !== undefined;
  if (!hasOriginal) return source.startLine === excerpt.startLine && source.endLine === excerpt.endLine;
  const start = excerpt.sourceStartLine;
  const end = excerpt.sourceEndLine;
  return typeof start === 'number' && typeof end === 'number'
    && Number.isSafeInteger(start) && Number.isSafeInteger(end)
    && start >= 1 && start <= excerpt.startLine && end >= excerpt.endLine
    && source.startLine === start && source.endLine === end;
}

function validateSourceExcerpt(
  excerpt: SourceExcerpt,
  sourceRefs: readonly SourceRef[],
  snapshotRevision: string,
  path: string,
  issues: ValidationIssue[],
): void {
  if (!isRepositoryRelativePath(excerpt.path)) {
    issues.push({ path: `${path}.path`, message: "must be a non-empty repository-relative path" });
  } else if (unicodeLength(excerpt.path) > SOURCE_EXCERPT_LIMITS.maxPathCharacters) {
    issues.push({ path: `${path}.path`, message: `must not exceed ${SOURCE_EXCERPT_LIMITS.maxPathCharacters} characters` });
  }
  if (excerpt.symbol !== undefined && (!excerpt.symbol.trim() || unicodeLength(excerpt.symbol) > SOURCE_EXCERPT_LIMITS.maxSymbolCharacters)) {
    issues.push({ path: `${path}.symbol`, message: `must be non-blank and at most ${SOURCE_EXCERPT_LIMITS.maxSymbolCharacters} characters` });
  }
  if (!new Set(['typescript', 'tsx', 'javascript', 'rust']).has(excerpt.language)) {
    issues.push({ path: `${path}.language`, message: "must be a supported source language" });
  } else if (languageForPath(excerpt.path) !== excerpt.language) {
    issues.push({ path: `${path}.language`, message: "must match the repository file extension" });
  }
  if (!Number.isSafeInteger(excerpt.startLine) || excerpt.startLine < 1) {
    issues.push({ path: `${path}.startLine`, message: "must be a finite positive integer" });
  }
  if (!Number.isSafeInteger(excerpt.endLine) || excerpt.endLine < excerpt.startLine) {
    issues.push({ path: `${path}.endLine`, message: "must be a finite positive integer not preceding startLine" });
  }
  if (!Number.isSafeInteger(excerpt.highlightLine)
    || excerpt.highlightLine < excerpt.startLine
    || excerpt.highlightLine > excerpt.endLine) {
    issues.push({ path: `${path}.highlightLine`, message: "must be a finite integer inside the excerpt range" });
  }
  if (!excerpt.frozenRevision) {
    issues.push({ path: `${path}.frozenRevision`, message: "must pin the excerpt to a revision" });
  } else if (excerpt.frozenRevision !== snapshotRevision) {
    issues.push({ path: `${path}.frozenRevision`, message: "must match the containing snapshot revision" });
  }
  const lines: unknown[] = Array.isArray(excerpt.lines) ? excerpt.lines : [];
  if (lines.length < 1 || lines.length > SOURCE_EXCERPT_LIMITS.maxLines) {
    issues.push({ path: `${path}.lines`, message: `must contain between 1 and ${SOURCE_EXCERPT_LIMITS.maxLines} lines` });
  } else {
    if (Number.isSafeInteger(excerpt.startLine) && Number.isSafeInteger(excerpt.endLine)
      && lines.length !== excerpt.endLine - excerpt.startLine + 1) {
      issues.push({ path: `${path}.lines`, message: "must exactly cover the inclusive source range" });
    }
    lines.forEach((line, index) => {
      if (typeof line !== 'string') {
        issues.push({ path: `${path}.lines[${index}]`, message: "must be a source line string" });
        return;
      }
      if (line.includes("\n") || line.includes("\r")) {
        issues.push({ path: `${path}.lines[${index}]`, message: "must contain exactly one source line" });
      }
      if (unicodeLength(line) > SOURCE_EXCERPT_LIMITS.maxLineCharacters) {
        issues.push({ path: `${path}.lines[${index}]`, message: `must not exceed ${SOURCE_EXCERPT_LIMITS.maxLineCharacters} characters` });
      }
    });
  }
  const joinedLines = lines.every((line): line is string => typeof line === 'string') ? lines.join("\n") : undefined;
  if (typeof excerpt.text !== 'string' || excerpt.text !== joinedLines) {
    issues.push({ path: `${path}.text`, message: "must exactly equal lines joined with newline separators" });
  }
  if (typeof excerpt.text === 'string' && unicodeLength(excerpt.text) > SOURCE_EXCERPT_LIMITS.maxTextCharacters) {
    issues.push({ path: `${path}.text`, message: `must not exceed ${SOURCE_EXCERPT_LIMITS.maxTextCharacters} characters` });
  }
  const coherentSource = sourceRefs.some(source => sourceExcerptMatchesRef(excerpt, source));
  if (!coherentSource) {
    issues.push({ path, message: excerpt.sourceStartLine !== undefined || excerpt.sourceEndLine !== undefined
      ? "original source range must contain the excerpt and exactly match an entity sourceRef"
      : "must exactly match an entity sourceRef path, symbol, revision, and range" });
  }
}

export function validateSnapshot(snapshot: ArchitectureSnapshot): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (snapshot.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) {
    issues.push({ path: "schemaVersion", message: `expected ${ARCHITECTURE_SCHEMA_VERSION}` });
  }

  const duplicateEntityIds = duplicateValues(snapshot.entities.map((entity) => entity.id));
  for (const id of duplicateEntityIds) issues.push({ path: "entities", message: `duplicate entity id: ${id}` });
  const duplicateRelationIds = duplicateValues(snapshot.relations.map((relation) => relation.id));
  for (const id of duplicateRelationIds) issues.push({ path: "relations", message: `duplicate relation id: ${id}` });
  for (const id of duplicateValues(snapshot.entities.flatMap(entity => entity.lineageId ? [entity.lineageId] : []))) {
    issues.push({ path: "entities", message: `duplicate entity lineage id: ${id}` });
  }
  for (const id of duplicateValues(snapshot.relations.flatMap(relation => relation.lineageId ? [relation.lineageId] : []))) {
    issues.push({ path: "relations", message: `duplicate relation lineage id: ${id}` });
  }

  const entityIds = new Set(snapshot.entities.map((entity) => entity.id));
  const entityById = new Map(snapshot.entities.map((entity) => [entity.id, entity]));
  const parentById = new Map(snapshot.entities.map((entity) => [entity.id, entity.parentId]));
  snapshot.entities.forEach((entity, index) => {
    const path = `entities[${index}]`;
    if (!entity.id) issues.push({ path: `${path}.id`, message: "must not be empty" });
    if (!entity.name.trim()) issues.push({ path: `${path}.name`, message: "must not be blank" });
    if (entity.parentId !== undefined && !entityIds.has(entity.parentId)) {
      issues.push({ path: `${path}.parentId`, message: `unknown entity: ${entity.parentId}` });
    }
    if (entity.parentId === entity.id) {
      issues.push({ path: `${path}.parentId`, message: "an entity cannot contain itself" });
    }
    if (entity.confidence !== undefined && !isUnitInterval(entity.confidence)) {
      issues.push({ path: `${path}.confidence`, message: "must be finite and between 0 and 1" });
    }
    entity.sourceRefs.forEach((source, sourceIndex) => validateSourceRef(source, `${path}.sourceRefs[${sourceIndex}]`, issues));
    if (entity.owners !== undefined) {
      if (!Array.isArray(entity.owners) || entity.owners.length === 0) {
        issues.push({ path: `${path}.owners`, message: "must be a non-empty array when present" });
      } else {
        const seen = new Set<string>();
        entity.owners.forEach((owner, ownerIndex) => {
          if (typeof owner !== "string" || !owner.trim()) {
            issues.push({ path: `${path}.owners[${ownerIndex}]`, message: "must be a non-blank string" });
            return;
          }
          if (seen.has(owner)) issues.push({ path: `${path}.owners`, message: `duplicate owner: ${owner}` });
          seen.add(owner);
        });
      }
    }
    if (entity.cyclomaticComplexity !== undefined) {
      if (entity.kind !== "code") {
        issues.push({ path: `${path}.cyclomaticComplexity`, message: "is only valid on code entities" });
      }
      if (!Number.isInteger(entity.cyclomaticComplexity) || entity.cyclomaticComplexity < 1) {
        issues.push({ path: `${path}.cyclomaticComplexity`, message: "must be an integer >= 1 when present" });
      }
    }
    if (entity.coverageFileHitRate !== undefined) {
      if (entity.kind !== "code") {
        issues.push({ path: `${path}.coverageFileHitRate`, message: "is only valid on code entities" });
      }
      if (typeof entity.coverageFileHitRate !== "number"
        || !Number.isFinite(entity.coverageFileHitRate)
        || entity.coverageFileHitRate < 0
        || entity.coverageFileHitRate > 1) {
        issues.push({ path: `${path}.coverageFileHitRate`, message: "must be a finite number between 0 and 1 when present" });
      }
    }
    if (entity.coverageUntestedRanges !== undefined) {
      if (entity.kind !== "code") {
        issues.push({ path: `${path}.coverageUntestedRanges`, message: "is only valid on code entities" });
      }
      if (!Array.isArray(entity.coverageUntestedRanges) || entity.coverageUntestedRanges.length === 0) {
        issues.push({ path: `${path}.coverageUntestedRanges`, message: "must be a non-empty array when present" });
      } else {
        entity.coverageUntestedRanges.forEach((range, rangeIndex) => {
          const rangePath = `${path}.coverageUntestedRanges[${rangeIndex}]`;
          if (!range || typeof range !== "object") {
            issues.push({ path: rangePath, message: "must be a line range" });
            return;
          }
          if (!Number.isInteger(range.startLine) || range.startLine < 1) {
            issues.push({ path: `${rangePath}.startLine`, message: "must be an integer >= 1" });
          }
          if (!Number.isInteger(range.endLine) || range.endLine < 1) {
            issues.push({ path: `${rangePath}.endLine`, message: "must be an integer >= 1" });
          }
          if (Number.isInteger(range.startLine) && Number.isInteger(range.endLine) && range.endLine < range.startLine) {
            issues.push({ path: `${rangePath}.endLine`, message: "must be >= startLine" });
          }
        });
      }
    }
    if (entity.untestedBehaviours !== undefined) {
      if (entity.kind !== "code" && entity.kind !== "component") {
        issues.push({ path: `${path}.untestedBehaviours`, message: "is only valid on code or component entities" });
      }
      if (!Array.isArray(entity.untestedBehaviours) || entity.untestedBehaviours.length === 0) {
        issues.push({ path: `${path}.untestedBehaviours`, message: "must be a non-empty array when present" });
      } else {
        entity.untestedBehaviours.forEach((item, itemIndex) => {
          const itemPath = `${path}.untestedBehaviours[${itemIndex}]`;
          if (!item || typeof item !== "object") {
            issues.push({ path: itemPath, message: "must be an untested behaviour" });
            return;
          }
          if (!Number.isInteger(item.startLine) || item.startLine < 1) {
            issues.push({ path: `${itemPath}.startLine`, message: "must be an integer >= 1" });
          }
          if (!Number.isInteger(item.endLine) || item.endLine < 1) {
            issues.push({ path: `${itemPath}.endLine`, message: "must be an integer >= 1" });
          }
          if (Number.isInteger(item.startLine) && Number.isInteger(item.endLine) && item.endLine < item.startLine) {
            issues.push({ path: `${itemPath}.endLine`, message: "must be >= startLine" });
          }
          if (typeof item.behaviour !== "string" || !item.behaviour.trim()) {
            issues.push({ path: `${itemPath}.behaviour`, message: "must be a non-blank string" });
          }
        });
      }
    }
    const excerpts = entity.sourceExcerpts ?? [];
    for (const duplicate of duplicateValues(excerpts.map(excerpt => JSON.stringify([
      excerpt.frozenRevision,
      excerpt.path,
      excerpt.symbol ?? '',
      excerpt.startLine,
      excerpt.endLine,
    ])))) {
      issues.push({ path: `${path}.sourceExcerpts`, message: `duplicate source excerpt: ${duplicate}` });
    }
    excerpts.forEach((excerpt, excerptIndex) => validateSourceExcerpt(
      excerpt,
      entity.sourceRefs,
      snapshot.commitSha,
      `${path}.sourceExcerpts[${excerptIndex}]`,
      issues,
    ));
  });

  for (const entity of snapshot.entities) {
    const visited = new Set<string>([entity.id]);
    let parentId = entity.parentId;
    while (parentId !== undefined && parentById.has(parentId)) {
      if (visited.has(parentId)) {
        issues.push({ path: `entities.${entity.id}.parentId`, message: "entity hierarchy contains a cycle" });
        break;
      }
      visited.add(parentId);
      parentId = parentById.get(parentId);
    }
  }

  snapshot.relations.forEach((relation, index) => {
    const path = `relations[${index}]`;
    if (!entityIds.has(relation.from)) issues.push({ path: `${path}.from`, message: `unknown entity: ${relation.from}` });
    if (!entityIds.has(relation.to)) issues.push({ path: `${path}.to`, message: `unknown entity: ${relation.to}` });
    if (relation.kind === "duplicates") {
      const fromEntity = entityById.get(relation.from);
      const toEntity = entityById.get(relation.to);
      if (fromEntity && fromEntity.kind !== "code") {
        issues.push({ path: `${path}.from`, message: "duplicates relations must connect code entities" });
      }
      if (toEntity && toEntity.kind !== "code") {
        issues.push({ path: `${path}.to`, message: "duplicates relations must connect code entities" });
      }
    }
    if (relation.confidence !== undefined && !isUnitInterval(relation.confidence)) {
      issues.push({ path: `${path}.confidence`, message: "must be finite and between 0 and 1" });
    }
    relation.evidence.forEach((evidence, evidenceIndex) =>
      validateSourceRef(evidence.source, `${path}.evidence[${evidenceIndex}].source`, issues),
    );
  });
  return issues;
}

export function validateView(snapshot: ArchitectureSnapshot, view: ArchitectureView): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (view.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) issues.push({ path: "schemaVersion", message: `expected ${ARCHITECTURE_SCHEMA_VERSION}` });
  if (view.snapshotId !== snapshot.id) issues.push({ path: "snapshotId", message: "does not match snapshot" });
  const entityIds = new Set(snapshot.entities.map((entity) => entity.id));
  const relationById = new Map<string, ArchitectureSnapshot["relations"][number]>();
  for (const relation of snapshot.relations) {
    // Preserve find()'s first match even when an invalid snapshot repeats an ID.
    if (!relationById.has(relation.id)) relationById.set(relation.id, relation);
  }
  const visibleEntityIds = new Set(view.entityIds);
  const visibleRelationIds = new Set(view.relationIds);
  if (!entityIds.has(view.rootEntityId)) issues.push({ path: "rootEntityId", message: "is not in the snapshot" });
  if (!visibleEntityIds.has(view.rootEntityId)) issues.push({ path: "rootEntityId", message: "must be included in entityIds" });
  if (!view.entityIds.length) issues.push({ path: "entityIds", message: "must not be empty" });
  for (const id of duplicateValues(view.entityIds)) issues.push({ path: "entityIds", message: `duplicate entity id: ${id}` });
  for (const id of view.entityIds) {
    if (!entityIds.has(id)) issues.push({ path: "entityIds", message: `unknown entity: ${id}` });
    const layout = view.layout.nodes[id];
    if (!layout) issues.push({ path: `layout.nodes.${id}`, message: "missing node layout" });
  }
  for (const [id, layout] of Object.entries(view.layout.nodes)) {
    if (!visibleEntityIds.has(id)) issues.push({ path: `layout.nodes.${id}`, message: "layout entity is not in the view" });
    validateRect(layout, `layout.nodes.${id}`, issues);
  }
  for (const id of view.relationIds) {
    if (!relationById.has(id)) issues.push({ path: "relationIds", message: `unknown relation: ${id}` });
    const relation = relationById.get(id);
    if (relation && (!visibleEntityIds.has(relation.from) || !visibleEntityIds.has(relation.to))) {
      issues.push({ path: "relationIds", message: `relation endpoints must both be in the view: ${id}` });
    }
  }
  for (const [id, edge] of Object.entries(view.layout.edges ?? {})) {
    if (!visibleRelationIds.has(id)) issues.push({ path: `layout.edges.${id}`, message: "layout relation is not in the view" });
    if (edge.points.length < 2) issues.push({ path: `layout.edges.${id}.points`, message: "must contain at least two points" });
    edge.points.forEach((point, index) => validatePoint(point, `layout.edges.${id}.points[${index}]`, issues));
  }
  return issues;
}

const storyDetails: readonly StoryDetail[] = ["context", "container", "component", "code"];
const storyKeys = new Set(["schemaVersion", "id", "snapshotId", "viewId", "title", "steps"]);
const storyStepKeys = new Set([
  "id", "title", "focusEntityIds", "traceRelationIds", "reveal", "narration", "sourceRefs", "durationMs",
]);
const sourceRefKeys = new Set(["path", "commitSha", "symbol", "startLine", "endLine"]);

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
  issues: ValidationIssue[],
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) issues.push({ path: path ? `${path}.${key}` : key, message: "is not allowed" });
  }
}

function requiredString(
  value: unknown,
  path: string,
  issues: ValidationIssue[],
  maximumCharacters?: number,
): string | undefined {
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path, message: "must be a non-blank string" });
    return undefined;
  }
  if (maximumCharacters !== undefined && unicodeLength(value) > maximumCharacters) {
    issues.push({ path, message: `must not exceed ${maximumCharacters} characters` });
  }
  return value;
}

function stringList(value: unknown, path: string, issues: ValidationIssue[]): string[] | undefined {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array of strings" });
    return undefined;
  }
  const strings: string[] = [];
  value.forEach((item, index) => {
    if (typeof item !== "string" || !item.trim()) {
      issues.push({ path: `${path}[${index}]`, message: "must be a non-blank string" });
    } else strings.push(item);
  });
  return strings;
}

function storyDetailForKind(kind: ArchitectureSnapshot["entities"][number]["kind"]): StoryDetail {
  if (kind === "code") return "code";
  if (kind === "component") return "component";
  if (kind === "container" || kind === "dataStore" || kind === "queue") return "container";
  return "context";
}

type EvidenceLocator = {
  path: string;
  commitSha: string;
  symbol?: string | undefined;
  startLine?: number | undefined;
  endLine?: number | undefined;
};

/**
 * Union of every source location the snapshot itself observes: each entity sourceRef,
 * each frozen entity sourceExcerpt (keyed by its frozenRevision), and each relation
 * evidence source. A story step may only cite locations found here.
 */
function collectSnapshotEvidence(snapshot: ArchitectureSnapshot): EvidenceLocator[] {
  const evidence: EvidenceLocator[] = [];
  for (const entity of snapshot.entities) {
    for (const ref of entity.sourceRefs) {
      evidence.push({ path: ref.path, commitSha: ref.commitSha, symbol: ref.symbol, startLine: ref.startLine, endLine: ref.endLine });
    }
    for (const excerpt of entity.sourceExcerpts ?? []) {
      evidence.push({ path: excerpt.path, commitSha: excerpt.frozenRevision, symbol: excerpt.symbol, startLine: excerpt.startLine, endLine: excerpt.endLine });
    }
  }
  for (const relation of snapshot.relations) {
    for (const { source } of relation.evidence) {
      evidence.push({ path: source.path, commitSha: source.commitSha, symbol: source.symbol, startLine: source.startLine, endLine: source.endLine });
    }
  }
  return evidence;
}

/**
 * Interim host-side resolution: a story step's sourceRef "cites" snapshot evidence only
 * if some evidence location shares its path and commit, has the same symbol when the ref
 * names one, and — when the ref names a line range — encloses that range (a range-less ref
 * resolves to any path/commit/symbol match). This is deliberately strict so an LLM cannot
 * present invented references as "Evidence" until first-class claims land
 * (see docs/roadmap/structured-data-schema.md).
 */
function citesSnapshotEvidence(ref: SourceRef, evidence: readonly EvidenceLocator[]): boolean {
  const refHasRange = ref.startLine !== undefined || ref.endLine !== undefined;
  const refStart = ref.startLine ?? ref.endLine;
  const refEnd = ref.endLine ?? ref.startLine;
  return evidence.some(entry => {
    if (entry.path !== ref.path || entry.commitSha !== ref.commitSha) return false;
    if (ref.symbol !== undefined && entry.symbol !== ref.symbol) return false;
    if (!refHasRange) return true;
    const entryStart = entry.startLine ?? entry.endLine;
    const entryEnd = entry.endLine ?? entry.startLine;
    if (entryStart === undefined || entryEnd === undefined) return false;
    return entryStart <= (refStart as number) && (refEnd as number) <= entryEnd;
  });
}

/** Strict runtime validation for untrusted/LLM-authored story JSON. */
export function validateStoryDocument(
  snapshot: ArchitectureSnapshot,
  view: ArchitectureView,
  input: unknown,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const story = recordValue(input);
  if (!story) return [{ path: "", message: "must be an object" }];
  validateKnownKeys(story, storyKeys, "", issues);
  if (story.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) issues.push({ path: "schemaVersion", message: `expected ${ARCHITECTURE_SCHEMA_VERSION}` });
  requiredString(story.id, "id", issues);
  if (typeof story.snapshotId !== "string" || story.snapshotId !== snapshot.id) issues.push({ path: "snapshotId", message: "does not match snapshot" });
  if (typeof story.viewId !== "string" || story.viewId !== view.id) issues.push({ path: "viewId", message: "does not match view" });
  requiredString(story.title, "title", issues, STORY_AUTHORING_LIMITS.maxTitleCharacters);
  const visibleEntities = new Set(view.entityIds);
  const visibleRelations = new Set(view.relationIds);
  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const relationById = new Map(snapshot.relations.map(relation => [relation.id, relation]));
  const snapshotEvidence = collectSnapshotEvidence(snapshot);
  if (!Array.isArray(story.steps)) {
    issues.push({ path: "steps", message: "must be an array" });
    return issues;
  }
  if (!story.steps.length) issues.push({ path: "steps", message: "must not be empty" });
  if (story.steps.length > STORY_AUTHORING_LIMITS.maxSteps) {
    issues.push({ path: "steps", message: `must contain at most ${STORY_AUTHORING_LIMITS.maxSteps} steps` });
  }
  const stepIds: string[] = [];
  story.steps.forEach((rawStep, index) => {
    const path = `steps[${index}]`;
    const step = recordValue(rawStep);
    if (!step) {
      issues.push({ path, message: "must be an object" });
      return;
    }
    validateKnownKeys(step, storyStepKeys, path, issues);
    const stepId = requiredString(step.id, `${path}.id`, issues);
    if (stepId) stepIds.push(stepId);
    requiredString(step.title, `${path}.title`, issues, STORY_AUTHORING_LIMITS.maxStepTitleCharacters);
    requiredString(step.narration, `${path}.narration`, issues, STORY_AUTHORING_LIMITS.maxNarrationCharacters);
    const focusEntityIds = stringList(step.focusEntityIds, `${path}.focusEntityIds`, issues) ?? [];
    if (!focusEntityIds.length) issues.push({ path: `${path}.focusEntityIds`, message: "must not be empty" });
    if (focusEntityIds.length > STORY_AUTHORING_LIMITS.maxFocusEntitiesPerStep) {
      issues.push({ path: `${path}.focusEntityIds`, message: `must contain at most ${STORY_AUTHORING_LIMITS.maxFocusEntitiesPerStep} entities` });
    }
    for (const id of duplicateValues(focusEntityIds)) issues.push({ path: `${path}.focusEntityIds`, message: `duplicate entity id: ${id}` });
    for (const id of focusEntityIds) {
      if (!visibleEntities.has(id)) issues.push({ path: `${path}.focusEntityIds`, message: `entity is not in view: ${id}` });
    }
    const traceRelationIds = step.traceRelationIds === undefined
      ? []
      : stringList(step.traceRelationIds, `${path}.traceRelationIds`, issues) ?? [];
    if (traceRelationIds.length > STORY_AUTHORING_LIMITS.maxTraceRelationsPerStep) {
      issues.push({ path: `${path}.traceRelationIds`, message: `must contain at most ${STORY_AUTHORING_LIMITS.maxTraceRelationsPerStep} relations` });
    }
    for (const id of duplicateValues(traceRelationIds)) issues.push({ path: `${path}.traceRelationIds`, message: `duplicate relation id: ${id}` });
    for (const id of traceRelationIds) {
      if (!visibleRelations.has(id)) issues.push({ path: `${path}.traceRelationIds`, message: `relation is not in view: ${id}` });
      const relation = relationById.get(id);
      if (relation && focusEntityIds.length > 0
        && !focusEntityIds.includes(relation.from) && !focusEntityIds.includes(relation.to)) {
        issues.push({ path: `${path}.traceRelationIds`, message: `relation is not connected to a focused entity: ${id}` });
      }
    }
    const reveal = step.reveal;
    if (reveal !== undefined && (typeof reveal !== "string" || !storyDetails.includes(reveal as StoryDetail))) {
      issues.push({ path: `${path}.reveal`, message: `must be one of ${storyDetails.join(", ")}` });
    } else if (typeof reveal === "string") {
      const revealRank = storyDetails.indexOf(reveal as StoryDetail);
      const deepestFocusRank = Math.max(0, ...focusEntityIds.map(id => {
        const entity = entityById.get(id);
        return entity ? storyDetails.indexOf(storyDetailForKind(entity.kind)) : 0;
      }));
      if (deepestFocusRank > revealRank) {
        issues.push({ path: `${path}.reveal`, message: "is shallower than a focused entity" });
      }
    }
    if (step.durationMs !== undefined) {
      if (!Number.isSafeInteger(step.durationMs) || (step.durationMs as number) <= 0) {
        issues.push({ path: `${path}.durationMs`, message: "must be a finite positive integer" });
      } else if ((step.durationMs as number) > STORY_AUTHORING_LIMITS.maxStepDurationMs) {
        issues.push({ path: `${path}.durationMs`, message: `must not exceed ${STORY_AUTHORING_LIMITS.maxStepDurationMs} milliseconds` });
      }
    }
    if (step.sourceRefs !== undefined) {
      if (!Array.isArray(step.sourceRefs)) {
        issues.push({ path: `${path}.sourceRefs`, message: "must be an array" });
      } else {
        if (step.sourceRefs.length > STORY_AUTHORING_LIMITS.maxSourceRefsPerStep) {
          issues.push({ path: `${path}.sourceRefs`, message: `must contain at most ${STORY_AUTHORING_LIMITS.maxSourceRefsPerStep} references` });
        }
        const sourceKeys: string[] = [];
        step.sourceRefs.forEach((rawSource, sourceIndex) => {
          const sourcePath = `${path}.sourceRefs[${sourceIndex}]`;
          const source = recordValue(rawSource);
          if (!source) {
            issues.push({ path: sourcePath, message: "must be an object" });
            return;
          }
          validateKnownKeys(source, sourceRefKeys, sourcePath, issues);
          const typed = source as unknown as SourceRef;
          validateSourceRef(typed, sourcePath, issues);
          if (source.commitSha !== snapshot.commitSha) {
            issues.push({ path: `${sourcePath}.commitSha`, message: "does not match snapshot commit" });
          }
          if (!citesSnapshotEvidence(typed, snapshotEvidence)) {
            issues.push({ path: sourcePath, message: "does not cite snapshot evidence" });
          }
          sourceKeys.push([source.path, source.symbol, source.startLine, source.endLine, source.commitSha].join("\u0000"));
        });
        for (const duplicate of duplicateValues(sourceKeys)) {
          issues.push({ path: `${path}.sourceRefs`, message: `duplicate source reference: ${duplicate.split("\u0000")[0]}` });
        }
      }
    }
  });
  for (const id of duplicateValues(stepIds)) issues.push({ path: "steps", message: `duplicate step id: ${id}` });
  return issues;
}

export function validateStory(snapshot: ArchitectureSnapshot, view: ArchitectureView, story: ArchitectureStory): ValidationIssue[] {
  return validateStoryDocument(snapshot, view, story);
}

export function validateOverrides(overrides: ArchitectureOverrides): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (overrides.schemaVersion !== ARCHITECTURE_SCHEMA_VERSION) {
    issues.push({ path: "schemaVersion", message: `expected ${ARCHITECTURE_SCHEMA_VERSION}` });
  }
  if (!overrides.repositoryId) issues.push({ path: "repositoryId", message: "must not be empty" });
  for (const id of duplicateValues(overrides.hiddenEntityIds)) {
    issues.push({ path: "hiddenEntityIds", message: `duplicate entity id: ${id}` });
  }
  for (const [viewId, nodes] of Object.entries(overrides.lockedLayout)) {
    for (const [entityId, layout] of Object.entries(nodes)) {
      validateRect(layout, `lockedLayout.${viewId}.${entityId}`, issues);
    }
  }
  return issues;
}
