import {
  ARCHITECTURE_SCHEMA_VERSION,
  SOURCE_EXCERPT_LIMITS,
  type ArchitectureEntity,
  type ArchitectureRelation,
  type ArchitectureSnapshot,
  type EntityId,
  type EntityKind,
  type RelationId,
  type RelationKind,
  type SnapshotId,
  type SourceRef,
  type UntestedBehaviour,
} from "./model.js";
import { validateSnapshot, type ValidationIssue } from "./validation.js";
import { compareText } from "./text-order.js";

/** Versioned, semantic-only input accepted from architecture extraction. */
export const ARCHITECTURE_EXTRACTION_SCHEMA_VERSION = 1 as const;

export const ARCHITECTURE_EXTRACTION_LIMITS = {
  maxIdCharacters: 192,
  maxNameCharacters: 160,
  maxResponsibilityCharacters: 2_000,
  maxLabelCharacters: 240,
  maxTechnologyCharacters: 120,
  maxTagCharacters: 80,
  maxEvidenceReasonCharacters: 1_000,
  maxListItems: 64,
  maxSourceRefs: 32,
  maxEvidenceItems: 64,
  maxFingerprintCharacters: 256,
  maxRevisionCharacters: 256,
  maxUntestedBehaviours: 8,
  maxUntestedBehaviourCharacters: 240,
} as const;

/** Synthetic boundaries are derived from parentId and are not extraction facts. */
export type ArchitectureExtractionEntityKind = Exclude<EntityKind, "boundary">;

/** A repository anchor before the host pins it to a snapshot revision. */
export interface ArchitectureExtractionSourceRef {
  path: string;
  symbol?: string;
  startLine?: number;
  endLine?: number;
}

export interface ArchitectureExtractionExposure {
  kind: "moduleExport" | "publicApi" | "entryPoint";
  evidence: ArchitectureExtractionEvidence;
}

export interface ArchitectureExtractionEvidence {
  source: ArchitectureExtractionSourceRef;
  reason?: string;
}

export interface ArchitectureExtractionEntity {
  id: EntityId;
  kind: ArchitectureExtractionEntityKind;
  parentId?: EntityId;
  name: string;
  responsibility?: string;
  technology?: string[];
  tags?: string[];
  exposure?: ArchitectureExtractionExposure[];
  /**
   * Named untested behaviours grounded in observed lcov ranges on this
   * code entity (or a file-component whose child code carries those ranges).
   * Judgement — not a scan-time coverage overlay. Omit without ranges.
   */
  untestedBehaviours?: UntestedBehaviour[];
  sourceRefs: ArchitectureExtractionSourceRef[];
  confidence?: number;
}

export interface ArchitectureExtractionRelation {
  id: RelationId;
  from: EntityId;
  to: EntityId;
  kind: RelationKind;
  label?: string;
  technology?: string;
  optional?: boolean;
  evidence: ArchitectureExtractionEvidence[];
  confidence?: number;
}

/**
 * LLM-facing facts only. Snapshot identity, revisions, frozen source content,
 * view geometry, and edge routes are deliberately absent.
 */
export interface ArchitectureExtraction {
  schemaVersion: typeof ARCHITECTURE_EXTRACTION_SCHEMA_VERSION;
  entities: ArchitectureExtractionEntity[];
  relations: ArchitectureExtractionRelation[];
}

export interface ArchitectureReconciledIdentity {
  lineageId?: string;
  fingerprint?: string;
}

/** Explicit host reconciliation; this is not part of the LLM-facing payload. */
export interface ArchitectureExtractionReconciliation {
  entities?: Readonly<Record<EntityId, ArchitectureReconciledIdentity>>;
  relations?: Readonly<Record<RelationId, ArchitectureReconciledIdentity>>;
}

/** All volatile snapshot metadata must be supplied by the host. */
export interface ArchitectureExtractionSnapshotMetadata {
  snapshotId: SnapshotId;
  repositoryId: string;
  commitSha: string;
  generatedAt: string;
  reconciliation?: ArchitectureExtractionReconciliation;
}

export class ArchitectureExtractionError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(`Invalid architecture extraction:\n${issues.map(issue => `${issue.path}: ${issue.message}`).join("\n")}`);
    this.name = "ArchitectureExtractionError";
    this.issues = [...issues];
  }
}

type UnknownRecord = Record<string, unknown>;

const extractionEntityKinds = new Set<ArchitectureExtractionEntityKind>([
  "person",
  "softwareSystem",
  "container",
  "component",
  "code",
  "externalSystem",
  "dataStore",
  "queue",
]);

const extractionRelationKinds = new Set<RelationKind>([
  "uses",
  "calls",
  "reads",
  "writes",
  "publishes",
  "subscribes",
  "contains",
  "dependsOn",
  "returns",
]);

const prefixesByKind: Readonly<Record<ArchitectureExtractionEntityKind, readonly string[]>> = {
  person: ["person", "actor"],
  softwareSystem: ["system"],
  container: ["container"],
  component: ["component"],
  code: ["code"],
  externalSystem: ["external"],
  dataStore: ["data", "data-store"],
  queue: ["queue"],
};

const allowedParentKinds: Readonly<Partial<Record<ArchitectureExtractionEntityKind, readonly ArchitectureExtractionEntityKind[]>>> = {
  container: ["softwareSystem"],
  dataStore: ["softwareSystem"],
  queue: ["softwareSystem"],
  component: ["container", "dataStore", "queue"],
  code: ["component"],
};

const stableIdPattern = /^[a-z][a-z0-9]*(?::[a-z0-9]+(?:-[a-z0-9]+)*)+$/;

function record(value: unknown): UnknownRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as UnknownRecord
    : undefined;
}

function unicodeLength(value: string): number {
  return [...value].length;
}

function duplicateValues(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates].sort(compareText);
}

function unknownKeys(value: UnknownRecord, allowed: readonly string[], path: string, issues: ValidationIssue[]): void {
  const accepted = new Set(allowed);
  for (const key of Object.keys(value).sort(compareText)) {
    if (!accepted.has(key)) issues.push({ path: path ? `${path}.${key}` : key, message: "is not allowed in semantic extraction input" });
  }
}

function isRepositoryRelativePath(value: string): boolean {
  if (!value || value.startsWith("/") || value.startsWith("\\")
    || /^[A-Za-z]:[\\/]/.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)
    || value.includes("\\") || [...value].some(character => {
      const code = character.codePointAt(0)!;
      return code < 0x20 || code === 0x7f;
    })) return false;
  return value.split("/").every(segment => segment.length > 0 && segment !== "." && segment !== "..");
}

function validateRequiredText(
  value: unknown,
  path: string,
  maximum: number,
  issues: ValidationIssue[],
): value is string {
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path, message: "must be a non-blank string" });
    return false;
  }
  if (unicodeLength(value) > maximum) issues.push({ path, message: `must not exceed ${maximum} characters` });
  return true;
}

function validateOptionalText(
  value: unknown,
  path: string,
  maximum: number,
  issues: ValidationIssue[],
): void {
  if (value !== undefined) validateRequiredText(value, path, maximum, issues);
}

function validateConfidence(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)) {
    issues.push({ path, message: "must be a finite number between 0 and 1" });
  }
}

function validateStableId(value: unknown, path: string, prefixes: readonly string[], issues: ValidationIssue[]): value is string {
  if (!validateRequiredText(value, path, ARCHITECTURE_EXTRACTION_LIMITS.maxIdCharacters, issues)) return false;
  const prefix = value.split(":", 1)[0]!;
  if (!stableIdPattern.test(value) || !prefixes.includes(prefix)) {
    issues.push({ path, message: `must be a typed stable ID with prefix ${prefixes.map(item => `${item}:`).join(" or ")}` });
    return false;
  }
  return true;
}

function validateStringList(
  value: unknown,
  path: string,
  maximumItemLength: number,
  issues: ValidationIssue[],
): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (value.length > ARCHITECTURE_EXTRACTION_LIMITS.maxListItems) {
    issues.push({ path, message: `must not contain more than ${ARCHITECTURE_EXTRACTION_LIMITS.maxListItems} items` });
  }
  value.forEach((item, index) => validateRequiredText(item, `${path}[${index}]`, maximumItemLength, issues));
}

function validateUntestedBehaviours(
  value: unknown,
  kind: ArchitectureExtractionEntityKind | undefined,
  path: string,
  issues: ValidationIssue[],
): void {
  if (value === undefined) return;
  if (kind !== "code" && kind !== "component") {
    issues.push({ path, message: "is only valid on code or component entities" });
  }
  if (!Array.isArray(value) || value.length === 0) {
    issues.push({ path, message: "must be a non-empty array when present" });
    return;
  }
  if (value.length > ARCHITECTURE_EXTRACTION_LIMITS.maxUntestedBehaviours) {
    issues.push({ path, message: `must not contain more than ${ARCHITECTURE_EXTRACTION_LIMITS.maxUntestedBehaviours} items` });
  }
  value.forEach((item, index) => {
    const itemPath = `${path}[${index}]`;
    const row = record(item);
    if (!row) {
      issues.push({ path: itemPath, message: "must be an untested behaviour object" });
      return;
    }
    unknownKeys(row, ["startLine", "endLine", "behaviour"], itemPath, issues);
    if (!Number.isSafeInteger(row.startLine) || (row.startLine as number) < 1) {
      issues.push({ path: `${itemPath}.startLine`, message: "must be a positive safe integer" });
    }
    if (!Number.isSafeInteger(row.endLine) || (row.endLine as number) < 1
      || (typeof row.startLine === "number" && (row.endLine as number) < (row.startLine as number))) {
      issues.push({ path: `${itemPath}.endLine`, message: "must be a positive safe integer not preceding startLine" });
    }
    validateRequiredText(row.behaviour, `${itemPath}.behaviour`, ARCHITECTURE_EXTRACTION_LIMITS.maxUntestedBehaviourCharacters, issues);
  });
}

function validateSourceAnchor(value: unknown, path: string, issues: ValidationIssue[]): void {
  const source = record(value);
  if (!source) {
    issues.push({ path, message: "must be a source anchor object" });
    return;
  }
  unknownKeys(source, ["path", "symbol", "startLine", "endLine"], path, issues);
  if (typeof source.path !== "string" || !isRepositoryRelativePath(source.path)) {
    issues.push({ path: `${path}.path`, message: "must be a safe non-empty repository-relative path" });
  } else if (unicodeLength(source.path) > SOURCE_EXCERPT_LIMITS.maxPathCharacters) {
    issues.push({ path: `${path}.path`, message: `must not exceed ${SOURCE_EXCERPT_LIMITS.maxPathCharacters} characters` });
  }
  validateOptionalText(source.symbol, `${path}.symbol`, SOURCE_EXCERPT_LIMITS.maxSymbolCharacters, issues);
  if (source.startLine !== undefined && (!Number.isSafeInteger(source.startLine) || (source.startLine as number) < 1)) {
    issues.push({ path: `${path}.startLine`, message: "must be a positive safe integer" });
  }
  if (source.endLine !== undefined) {
    if (source.startLine === undefined) issues.push({ path: `${path}.endLine`, message: "requires startLine" });
    if (!Number.isSafeInteger(source.endLine) || (source.endLine as number) < 1
      || (typeof source.startLine === "number" && (source.endLine as number) < source.startLine)) {
      issues.push({ path: `${path}.endLine`, message: "must be a positive safe integer not preceding startLine" });
    }
  }
}

function validateExtractionEvidence(value: unknown, path: string, issues: ValidationIssue[]): void {
  const evidence = record(value);
  if (!evidence) {
    issues.push({ path, message: "must be an evidence object" });
    return;
  }
  unknownKeys(evidence, ["source", "reason"], path, issues);
  validateSourceAnchor(evidence.source, `${path}.source`, issues);
  validateOptionalText(evidence.reason, `${path}.reason`, ARCHITECTURE_EXTRACTION_LIMITS.maxResponsibilityCharacters, issues);
}

function validateSourceAnchorList(value: unknown, path: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value)) {
    issues.push({ path, message: "must be an array" });
    return;
  }
  if (value.length > ARCHITECTURE_EXTRACTION_LIMITS.maxSourceRefs) {
    issues.push({ path, message: `must not contain more than ${ARCHITECTURE_EXTRACTION_LIMITS.maxSourceRefs} source anchors` });
  }
  value.forEach((source, index) => validateSourceAnchor(source, `${path}[${index}]`, issues));
}

/** Strictly validates unknown JSON as semantic extraction input. */
export function validateArchitectureExtraction(value: unknown): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const extraction = record(value);
  if (!extraction) return [{ path: "", message: "must be an architecture extraction object" }];
  unknownKeys(extraction, ["schemaVersion", "entities", "relations"], "", issues);
  if (extraction.schemaVersion !== ARCHITECTURE_EXTRACTION_SCHEMA_VERSION) {
    issues.push({ path: "schemaVersion", message: `expected ${ARCHITECTURE_EXTRACTION_SCHEMA_VERSION}` });
  }

  const entityRows = Array.isArray(extraction.entities) ? extraction.entities : [];
  if (!Array.isArray(extraction.entities)) issues.push({ path: "entities", message: "must be an array" });
  const entityRecords: Array<{ row: UnknownRecord; index: number }> = [];
  entityRows.forEach((value, index) => {
    const entity = record(value);
    const path = `entities[${index}]`;
    if (!entity) {
      issues.push({ path, message: "must be an entity object" });
      return;
    }
    entityRecords.push({ row: entity, index });
    unknownKeys(entity, ["id", "kind", "parentId", "name", "responsibility", "technology", "tags", "exposure", "untestedBehaviours", "sourceRefs", "confidence"], path, issues);
    const kind = typeof entity.kind === "string" && extractionEntityKinds.has(entity.kind as ArchitectureExtractionEntityKind)
      ? entity.kind as ArchitectureExtractionEntityKind
      : undefined;
    if (!kind) issues.push({ path: `${path}.kind`, message: `must be one of ${[...extractionEntityKinds].join(", ")}` });
    if (kind) validateStableId(entity.id, `${path}.id`, prefixesByKind[kind], issues);
    else validateRequiredText(entity.id, `${path}.id`, ARCHITECTURE_EXTRACTION_LIMITS.maxIdCharacters, issues);
    if (entity.parentId !== undefined) validateRequiredText(entity.parentId, `${path}.parentId`, ARCHITECTURE_EXTRACTION_LIMITS.maxIdCharacters, issues);
    validateRequiredText(entity.name, `${path}.name`, ARCHITECTURE_EXTRACTION_LIMITS.maxNameCharacters, issues);
    validateOptionalText(entity.responsibility, `${path}.responsibility`, ARCHITECTURE_EXTRACTION_LIMITS.maxResponsibilityCharacters, issues);
    validateStringList(entity.technology, `${path}.technology`, ARCHITECTURE_EXTRACTION_LIMITS.maxTechnologyCharacters, issues);
    validateStringList(entity.tags, `${path}.tags`, ARCHITECTURE_EXTRACTION_LIMITS.maxTagCharacters, issues);
    if (entity.exposure !== undefined) {
      if (!Array.isArray(entity.exposure)) issues.push({ path: `${path}.exposure`, message: "must be an array" });
      else entity.exposure.forEach((value, exposureIndex) => {
        const exposure = record(value);
        const exposurePath = `${path}.exposure[${exposureIndex}]`;
        if (!exposure) { issues.push({ path: exposurePath, message: "must be an exposure object" }); return; }
        unknownKeys(exposure, ["kind", "evidence"], exposurePath, issues);
        if (exposure.kind !== "moduleExport" && exposure.kind !== "publicApi" && exposure.kind !== "entryPoint") {
          issues.push({ path: `${exposurePath}.kind`, message: "unsupported exposure kind" });
        }
        validateExtractionEvidence(exposure.evidence, `${exposurePath}.evidence`, issues);
      });
    }
    validateUntestedBehaviours(entity.untestedBehaviours, kind, `${path}.untestedBehaviours`, issues);
    validateSourceAnchorList(entity.sourceRefs, `${path}.sourceRefs`, issues);
    validateConfidence(entity.confidence, `${path}.confidence`, issues);
  });

  const entityIds = entityRecords.flatMap(({ row }) => typeof row.id === "string" ? [row.id] : []);
  for (const duplicate of duplicateValues(entityIds)) issues.push({ path: "entities", message: `duplicate entity id: ${duplicate}` });
  const entityById = new Map(entityRecords.flatMap(({ row }) => typeof row.id === "string" ? [[row.id, row] as const] : []));
  for (const { row: entity, index } of entityRecords) {
    const path = `entities[${index}]`;
    if (typeof entity.id !== "string" || typeof entity.kind !== "string" || !extractionEntityKinds.has(entity.kind as ArchitectureExtractionEntityKind)) continue;
    const kind = entity.kind as ArchitectureExtractionEntityKind;
    const parentId = typeof entity.parentId === "string" ? entity.parentId : undefined;
    const allowedParents = allowedParentKinds[kind];
    if (allowedParents) {
      if (!parentId) {
        issues.push({ path: `${path}.parentId`, message: `${kind} requires a parent in the C4 hierarchy` });
      } else {
        const parent = entityById.get(parentId);
        if (!parent) issues.push({ path: `${path}.parentId`, message: `unknown entity: ${parentId}` });
        else if (typeof parent.kind !== "string" || !allowedParents.includes(parent.kind as ArchitectureExtractionEntityKind)) {
          issues.push({ path: `${path}.parentId`, message: `${kind} must be contained by ${allowedParents.join(" or ")}` });
        }
      }
    } else if (parentId) {
      if (!entityById.has(parentId)) issues.push({ path: `${path}.parentId`, message: `unknown entity: ${parentId}` });
      issues.push({ path: `${path}.parentId`, message: `${kind} must be top-level` });
    }
    if (parentId === entity.id) issues.push({ path: `${path}.parentId`, message: "an entity cannot contain itself" });
  }

  for (const { row: entity, index } of entityRecords) {
    if (typeof entity.id !== "string") continue;
    const visited = new Set<string>([entity.id]);
    let parentId = typeof entity.parentId === "string" ? entity.parentId : undefined;
    while (parentId && entityById.has(parentId)) {
      if (visited.has(parentId)) {
        issues.push({ path: `entities[${index}].parentId`, message: "entity hierarchy contains a cycle" });
        break;
      }
      visited.add(parentId);
      const parent = entityById.get(parentId)!;
      parentId = typeof parent.parentId === "string" ? parent.parentId : undefined;
    }
  }

  const relationRows = Array.isArray(extraction.relations) ? extraction.relations : [];
  if (!Array.isArray(extraction.relations)) issues.push({ path: "relations", message: "must be an array" });
  const relationRecords: Array<{ row: UnknownRecord; index: number }> = [];
  relationRows.forEach((value, index) => {
    const relation = record(value);
    const path = `relations[${index}]`;
    if (!relation) {
      issues.push({ path, message: "must be a relation object" });
      return;
    }
    relationRecords.push({ row: relation, index });
    unknownKeys(relation, ["id", "from", "to", "kind", "label", "technology", "optional", "evidence", "confidence"], path, issues);
    validateStableId(relation.id, `${path}.id`, ["relation"], issues);
    validateRequiredText(relation.from, `${path}.from`, ARCHITECTURE_EXTRACTION_LIMITS.maxIdCharacters, issues);
    validateRequiredText(relation.to, `${path}.to`, ARCHITECTURE_EXTRACTION_LIMITS.maxIdCharacters, issues);
    if (typeof relation.kind !== "string" || !extractionRelationKinds.has(relation.kind as RelationKind)) {
      issues.push({ path: `${path}.kind`, message: `must be one of ${[...extractionRelationKinds].join(", ")}` });
    }
    validateOptionalText(relation.label, `${path}.label`, ARCHITECTURE_EXTRACTION_LIMITS.maxLabelCharacters, issues);
    validateOptionalText(relation.technology, `${path}.technology`, ARCHITECTURE_EXTRACTION_LIMITS.maxTechnologyCharacters, issues);
    if (relation.optional !== undefined && typeof relation.optional !== "boolean") {
      issues.push({ path: `${path}.optional`, message: "must be a boolean" });
    }
    validateConfidence(relation.confidence, `${path}.confidence`, issues);
    if (!Array.isArray(relation.evidence) || relation.evidence.length === 0) {
      issues.push({ path: `${path}.evidence`, message: "must contain at least one evidence item" });
    } else {
      if (relation.evidence.length > ARCHITECTURE_EXTRACTION_LIMITS.maxEvidenceItems) {
        issues.push({ path: `${path}.evidence`, message: `must not contain more than ${ARCHITECTURE_EXTRACTION_LIMITS.maxEvidenceItems} items` });
      }
      relation.evidence.forEach((value, evidenceIndex) => {
        const evidence = record(value);
        const evidencePath = `${path}.evidence[${evidenceIndex}]`;
        if (!evidence) {
          issues.push({ path: evidencePath, message: "must be an evidence object" });
          return;
        }
        unknownKeys(evidence, ["source", "reason"], evidencePath, issues);
        validateSourceAnchor(evidence.source, `${evidencePath}.source`, issues);
        validateOptionalText(evidence.reason, `${evidencePath}.reason`, ARCHITECTURE_EXTRACTION_LIMITS.maxEvidenceReasonCharacters, issues);
      });
    }
    const from = typeof relation.from === "string" ? relation.from : undefined;
    const to = typeof relation.to === "string" ? relation.to : undefined;
    if (from && !entityById.has(from)) issues.push({ path: `${path}.from`, message: `unknown entity: ${from}` });
    if (to && !entityById.has(to)) issues.push({ path: `${path}.to`, message: `unknown entity: ${to}` });
    // A direct recursive invocation is meaningful L4 evidence. Other self-relations
    // remain invalid because they cannot be rendered as a directional architecture edge.
    if (from && to && from === to && relation.kind !== "calls") {
      issues.push({ path, message: "relation endpoints must be different entities unless the relation is a call" });
    }
    if (relation.kind === "contains" && from && to) {
      const fromParent = entityById.get(from)?.parentId;
      const toParent = entityById.get(to)?.parentId;
      if (toParent === from || fromParent === to) {
        issues.push({ path: `${path}.kind`, message: "contains must not duplicate hierarchy already expressed by parentId" });
      }
    }
  });
  const relationIds = relationRecords.flatMap(({ row }) => typeof row.id === "string" ? [row.id] : []);
  for (const duplicate of duplicateValues(relationIds)) issues.push({ path: "relations", message: `duplicate relation id: ${duplicate}` });

  return issues;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const row = value as UnknownRecord;
  return `{${Object.keys(row).sort(compareText).map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(",")}}`;
}

function semanticFingerprint(kind: "entity" | "relation", value: unknown): string {
  let hash = 0xcbf29ce484222325n;
  for (const character of canonical(value)) {
    hash ^= BigInt(character.codePointAt(0)!);
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return `extraction:v1:${kind}:${hash.toString(16).padStart(16, "0")}`;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function sourceAnchorKey(source: ArchitectureExtractionSourceRef): string {
  return canonical([source.path, source.symbol ?? "", source.startLine ?? 0, source.endLine ?? 0]);
}

function sortedSourceAnchors(values: readonly ArchitectureExtractionSourceRef[]): ArchitectureExtractionSourceRef[] {
  const byKey = new Map(values.map(value => [sourceAnchorKey(value), value]));
  return [...byKey.entries()].sort(([left], [right]) => compareText(left, right)).map(([, value]) => ({
    path: value.path,
    ...(value.symbol !== undefined ? { symbol: value.symbol } : {}),
    ...(value.startLine !== undefined ? { startLine: value.startLine } : {}),
    ...(value.endLine !== undefined ? { endLine: value.endLine } : {}),
  }));
}

function pinSource(source: ArchitectureExtractionSourceRef, commitSha: string): SourceRef {
  return {
    path: source.path,
    commitSha,
    ...(source.symbol !== undefined ? { symbol: source.symbol } : {}),
    ...(source.startLine !== undefined ? { startLine: source.startLine } : {}),
    ...(source.endLine !== undefined ? { endLine: source.endLine } : {}),
  };
}

function reconciliationIssues(
  extraction: ArchitectureExtraction,
  metadata: ArchitectureExtractionSnapshotMetadata,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  validateStableId(metadata.snapshotId, "metadata.snapshotId", ["snapshot"], issues);
  validateStableId(metadata.repositoryId, "metadata.repositoryId", ["repo"], issues);
  validateRequiredText(metadata.commitSha, "metadata.commitSha", ARCHITECTURE_EXTRACTION_LIMITS.maxRevisionCharacters, issues);
  if (typeof metadata.generatedAt !== "string" || !metadata.generatedAt.trim() || !Number.isFinite(Date.parse(metadata.generatedAt))) {
    issues.push({ path: "metadata.generatedAt", message: "must be a valid explicit timestamp" });
  }
  const ids = {
    entities: new Set(extraction.entities.map(entity => entity.id)),
    relations: new Set(extraction.relations.map(relation => relation.id)),
  };
  for (const domain of ["entities", "relations"] as const) {
    const reconciled = metadata.reconciliation?.[domain] ?? {};
    for (const [id, identity] of Object.entries(reconciled).sort(([left], [right]) => compareText(left, right))) {
      const path = `metadata.reconciliation.${domain}.${id}`;
      if (!ids[domain].has(id)) issues.push({ path, message: "references an unknown extraction ID" });
      if (identity.lineageId !== undefined) {
        if (!validateRequiredText(identity.lineageId, `${path}.lineageId`, ARCHITECTURE_EXTRACTION_LIMITS.maxIdCharacters, issues)
          || !stableIdPattern.test(identity.lineageId)) {
          issues.push({ path: `${path}.lineageId`, message: "must be a stable typed lineage ID" });
        }
      }
      validateOptionalText(identity.fingerprint, `${path}.fingerprint`, ARCHITECTURE_EXTRACTION_LIMITS.maxFingerprintCharacters, issues);
    }
  }
  return issues;
}

/**
 * Deterministically materializes semantic facts as the existing snapshot model.
 * The host supplies all volatile metadata and may explicitly reconcile identity.
 */
export function adaptArchitectureExtraction(
  extraction: ArchitectureExtraction,
  metadata: ArchitectureExtractionSnapshotMetadata,
): ArchitectureSnapshot {
  const issues = [
    ...validateArchitectureExtraction(extraction),
    ...reconciliationIssues(extraction, metadata),
  ];
  if (issues.length) throw new ArchitectureExtractionError(issues);

  const entities: ArchitectureEntity[] = [...extraction.entities].sort((left, right) => compareText(left.id, right.id)).map(entity => {
    const sourceAnchors = sortedSourceAnchors(entity.sourceRefs);
    const facts = {
      id: entity.id,
      kind: entity.kind,
      ...(entity.parentId !== undefined ? { parentId: entity.parentId } : {}),
      name: entity.name,
      ...(entity.responsibility !== undefined ? { responsibility: entity.responsibility } : {}),
      ...(entity.technology !== undefined ? { technology: sortedUnique(entity.technology) } : {}),
      ...(entity.tags !== undefined ? { tags: sortedUnique(entity.tags) } : {}),
      ...(entity.exposure?.length ? { exposure: entity.exposure.map(exposure => ({
        kind: exposure.kind,
        evidence: { source: pinSource(exposure.evidence.source, metadata.commitSha), ...(exposure.evidence.reason ? { reason: exposure.evidence.reason } : {}) },
      })) } : {}),
      ...(entity.untestedBehaviours?.length ? {
        untestedBehaviours: entity.untestedBehaviours.map(item => ({
          startLine: item.startLine,
          endLine: item.endLine,
          behaviour: item.behaviour,
        })),
      } : {}),
      sourceRefs: sourceAnchors,
      ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
    };
    const reconciled = metadata.reconciliation?.entities?.[entity.id];
    return {
      ...facts,
      lineageId: reconciled?.lineageId ?? entity.id,
      fingerprint: reconciled?.fingerprint ?? semanticFingerprint("entity", facts),
      sourceRefs: sourceAnchors.map(source => pinSource(source, metadata.commitSha)),
    };
  });

  const relations: ArchitectureRelation[] = [...extraction.relations].sort((left, right) => compareText(left.id, right.id)).map(relation => {
    const evidenceByKey = new Map(relation.evidence.map(value => {
      const semanticEvidence = {
        source: sortedSourceAnchors([value.source])[0]!,
        ...(value.reason !== undefined ? { reason: value.reason } : {}),
      };
      return [canonical(semanticEvidence), semanticEvidence] as const;
    }));
    const semanticEvidence = [...evidenceByKey.entries()]
      .sort(([left], [right]) => compareText(left, right))
      .map(([, value]) => value);
    const evidence = semanticEvidence.map(value => ({
      source: pinSource(value.source, metadata.commitSha),
      ...(value.reason !== undefined ? { reason: value.reason } : {}),
    }));
    const facts = {
      id: relation.id,
      from: relation.from,
      to: relation.to,
      kind: relation.kind,
      ...(relation.label !== undefined ? { label: relation.label } : {}),
      ...(relation.technology !== undefined ? { technology: relation.technology } : {}),
      ...(relation.optional !== undefined ? { optional: relation.optional } : {}),
      evidence: semanticEvidence,
      ...(relation.confidence !== undefined ? { confidence: relation.confidence } : {}),
    };
    const reconciled = metadata.reconciliation?.relations?.[relation.id];
    return {
      ...facts,
      lineageId: reconciled?.lineageId ?? relation.id,
      fingerprint: reconciled?.fingerprint ?? semanticFingerprint("relation", facts),
      evidence,
    };
  });

  const snapshot: ArchitectureSnapshot = {
    schemaVersion: ARCHITECTURE_SCHEMA_VERSION,
    id: metadata.snapshotId,
    repositoryId: metadata.repositoryId,
    commitSha: metadata.commitSha,
    generatedAt: metadata.generatedAt,
    entities,
    relations,
  };
  const snapshotIssues = validateSnapshot(snapshot);
  if (snapshotIssues.length) throw new ArchitectureExtractionError(snapshotIssues);
  return snapshot;
}
