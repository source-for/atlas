import {
  ARCHITECTURE_EXTRACTION_LIMITS,
  validateArchitectureExtraction,
  type ArchitectureExtraction,
  type ArchitectureExtractionEntity,
  type ArchitectureExtractionEvidence,
  type ArchitectureExtractionRelation,
  type ArchitectureExtractionSourceRef,
  type CoverageLineRange,
  type RelationKind,
  type UntestedBehaviour,
  compareText,
} from "@okie/architecture";
import { ENRICHMENT_PROMPT_VERSION, ENRICHMENT_PROMPT_VERSION_V3 } from "./packet.js";
import { containerScopes, type ContainerScope } from "./scope.js";
import { resolveCollisions, typedId } from "./ids.js";
import type { EntityCoverageOverlay } from "./lcov.js";
import {
  isObservedLanguageTag,
  languageTagForScanPath,
  mergeObservedLanguageTechnology,
} from "./extract.js";

// Preserve the strongest trail when many file→file edges collapse into one
// logical→logical edge: union their evidence up to the schema's per-relation limit.
const MAX_EVIDENCE_PER_RELATION = ARCHITECTURE_EXTRACTION_LIMITS.maxEvidenceItems;
const MAX_COMPONENT_SOURCE_REFS = 24;

export interface EnrichmentDocResult {
  containerId: string;
  accepted: boolean;
  reasons: string[];
  components?: number;
  /** Intra-container file→file edges that collapsed onto a single logical component (dropped). */
  collapsedSelfEdges?: number;
}

/** Outcome of the one repo-wide system-scope proposal (top-level actors). */
export interface SystemScopeResult {
  accepted: boolean;
  reasons: string[];
  /** Person entities added on acceptance. */
  persons: number;
  /** Person-touching relations added on acceptance. */
  relations: number;
}

export interface EnrichmentReport {
  promptVersion: string;
  enrichedContainers: string[];
  /** Total intra-container edges dropped as self-loops after logical regrouping. */
  collapsedSelfEdges: number;
  results: EnrichmentDocResult[];
  /** Present when a system-scope document was supplied (keyed by the system id). */
  systemScope?: SystemScopeResult;
}

export interface EnrichmentOutcome {
  extraction: ArchitectureExtraction;
  report: EnrichmentReport;
}

export interface MergeEnrichmentOptions {
  /** Observed lcov untested ranges keyed by code id. Absent → any untestedBehaviours is invented. */
  coverageByCodeId?: ReadonlyMap<string, EntityCoverageOverlay>;
}

/** True when `cited` equals or sits inside an observed untested range. */
export function rangeGroundedInObserved(
  cited: Pick<CoverageLineRange, "startLine" | "endLine">,
  observed: readonly Pick<CoverageLineRange, "startLine" | "endLine">[],
): boolean {
  return observed.some(range => cited.startLine >= range.startLine && cited.endLine <= range.endLine);
}

function cloneUntestedBehaviours(items: readonly UntestedBehaviour[]): UntestedBehaviour[] {
  return items.map(item => ({
    startLine: item.startLine,
    endLine: item.endLine,
    behaviour: item.behaviour,
  }));
}

function observedRangesFor(
  codeId: string,
  coverageByCodeId: ReadonlyMap<string, EntityCoverageOverlay> | undefined,
): CoverageLineRange[] {
  return [...(coverageByCodeId?.get(codeId)?.untestedRanges ?? [])];
}

function reportPromptVersion(
  coverageByCodeId: ReadonlyMap<string, EntityCoverageOverlay> | undefined,
): string {
  if (coverageByCodeId && [...coverageByCodeId.values()].some(overlay => overlay.untestedRanges?.length)) {
    return ENRICHMENT_PROMPT_VERSION_V3;
  }
  return ENRICHMENT_PROMPT_VERSION;
}

/** LLM-authored judgement on one code entity — additive prose, never observed fact. */
interface CodeJudgement {
  responsibility?: NonNullable<ArchitectureExtractionEntity["responsibility"]>;
  technology?: NonNullable<ArchitectureExtractionEntity["technology"]>;
  tags?: NonNullable<ArchitectureExtractionEntity["tags"]>;
  untestedBehaviours?: UntestedBehaviour[];
}

interface AcceptedProposal {
  /** `regroup` replaces file-components; `summaries` only attaches judgement prose. */
  mode: "regroup" | "summaries";
  logicalComponents: ArchitectureExtractionEntity[];
  reparent: Map<string, string>;
  codeJudgements: Map<string, CodeJudgement>;
  /** Judgement prose on scanner-scoped file-components (summaries mode). */
  componentJudgements: Map<string, CodeJudgement>;
  /** Judgement prose on the restated container itself (id/parent stay base-owned). */
  containerJudgement?: CodeJudgement;
}

function judgementOf(entity: ArchitectureExtractionEntity): CodeJudgement | undefined {
  if (
    entity.responsibility === undefined
    && entity.technology === undefined
    && entity.tags === undefined
    && entity.untestedBehaviours === undefined
  ) return undefined;
  return {
    ...(entity.responsibility !== undefined ? { responsibility: entity.responsibility } : {}),
    ...(entity.technology !== undefined ? { technology: entity.technology } : {}),
    ...(entity.tags !== undefined ? { tags: entity.tags } : {}),
    ...(entity.untestedBehaviours?.length ? { untestedBehaviours: cloneUntestedBehaviours(entity.untestedBehaviours) } : {}),
  };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function sourceRefKey(ref: ArchitectureExtractionSourceRef): string {
  return `${ref.path}\u0000${ref.symbol ?? ""}\u0000${ref.startLine ?? ""}\u0000${ref.endLine ?? ""}`;
}

function sourceRefsEqual(left: readonly ArchitectureExtractionSourceRef[], right: readonly ArchitectureExtractionSourceRef[]): boolean {
  if (left.length !== right.length) return false;
  const a = left.map(sourceRefKey).sort();
  const b = right.map(sourceRefKey).sort();
  return a.every((value, index) => value === b[index]);
}

/** Observed language tags (CLA-102) survive enrichment that omits or replaces `technology`. */
function preserveObservedLanguageTechnology(
  base: ArchitectureExtractionEntity,
  next: ArchitectureExtractionEntity,
): ArchitectureExtractionEntity {
  const languages = (base.technology ?? []).filter(isObservedLanguageTag);
  const merged = mergeObservedLanguageTechnology(languages, next.technology);
  if (!merged) return next;
  const current = next.technology;
  if (current && current.length === merged.length && current.every((value, index) => value === merged[index])) {
    return next;
  }
  return { ...next, technology: merged };
}

function localOf(id: string): string {
  const index = id.indexOf(":");
  return index >= 0 ? id.slice(index + 1) : id;
}

/** Atomically validates one enrichment doc against a container's deterministic scope. */
function validateDoc(
  rawDoc: unknown,
  scope: ContainerScope,
  baseSystemId: string,
  baseEntityIds: ReadonlySet<string>,
  coverageByCodeId: ReadonlyMap<string, EntityCoverageOverlay> | undefined,
): { proposal?: AcceptedProposal; reasons: string[] } {
  const reasons: string[] = [];
  const doc = record(rawDoc);
  if (!doc) return { reasons: ["document is not a JSON object"] };
  const gate = validateArchitectureExtraction(doc);
  if (gate.length) return { reasons: gate.map(issue => `gate: ${issue.path || "<root>"} ${issue.message}`) };
  const extraction = doc as unknown as ArchitectureExtraction;

  if (extraction.relations.length > 0) reasons.push("must not propose relations (they are deterministic)");
  const systems = extraction.entities.filter(entity => entity.kind === "softwareSystem");
  const containers = extraction.entities.filter(entity => entity.kind === "container");
  const components = extraction.entities.filter(entity => entity.kind === "component");
  const codes = extraction.entities.filter(entity => entity.kind === "code");
  const others = extraction.entities.filter(entity => !["softwareSystem", "container", "component", "code"].includes(entity.kind));
  if (others.length) reasons.push(`unexpected entity kinds: ${[...new Set(others.map(entity => entity.kind))].sort().join(", ")}`);
  if (systems.length !== 1 || systems[0]!.id !== baseSystemId) reasons.push(`must restate exactly the base system ${baseSystemId}`);
  if (containers.length !== 1 || containers[0]!.id !== scope.container.id) reasons.push(`must restate exactly the container ${scope.container.id}`);
  else if (containers[0]!.parentId !== baseSystemId) reasons.push("container must be parented to the system");

  const scopeComponentIds = new Set(scope.components.map(component => component.id));
  const restatedExisting: ArchitectureExtractionEntity[] = [];
  const proposedNew: ArchitectureExtractionEntity[] = [];
  for (const component of components) {
    if (scopeComponentIds.has(component.id)) restatedExisting.push(component);
    else proposedNew.push(component);
  }
  if (restatedExisting.length > 0 && proposedNew.length > 0) {
    reasons.push("must not mix scanner-scoped component summaries with new logical components");
    return { reasons };
  }

  if (proposedNew.length > 0) {
    return validateRegroupDoc(reasons, scope, baseEntityIds, proposedNew, codes, containers, coverageByCodeId);
  }
  return validateSummaryDoc(reasons, scope, restatedExisting, codes, containers, coverageByCodeId);
}

function validateGroundedUntestedBehaviours(
  entity: ArchitectureExtractionEntity,
  observed: readonly CoverageLineRange[],
  reasons: string[],
): void {
  if (!entity.untestedBehaviours?.length) return;
  if (observed.length === 0) {
    reasons.push(`${entity.kind} ${entity.id} must not invent untested behaviours without observed untested ranges`);
    return;
  }
  for (const item of entity.untestedBehaviours) {
    if (!rangeGroundedInObserved(item, observed)) {
      reasons.push(
        `${entity.kind} ${entity.id} untested behaviour L${item.startLine}–${item.endLine} is not grounded in observed untested ranges`,
      );
    }
  }
}

function validateRegroupDoc(
  reasons: string[],
  scope: ContainerScope,
  baseEntityIds: ReadonlySet<string>,
  components: ArchitectureExtractionEntity[],
  codes: ArchitectureExtractionEntity[],
  containers: ArchitectureExtractionEntity[],
  coverageByCodeId: ReadonlyMap<string, EntityCoverageOverlay> | undefined,
): { proposal?: AcceptedProposal; reasons: string[] } {
  const namespacePrefix = `component:${localOf(scope.container.id)}-`;
  const proposedIds = new Set(components.map(component => component.id));
  for (const component of components) {
    if (component.parentId !== scope.container.id) reasons.push(`component ${component.id} must be parented to ${scope.container.id}`);
    if (!component.id.startsWith(namespacePrefix)) reasons.push(`component ${component.id} must be namespaced under ${namespacePrefix}*`);
    if (baseEntityIds.has(component.id)) reasons.push(`component ${component.id} collides with an existing entity id`);
    for (const ref of component.sourceRefs) {
      if (!scope.scopePaths.includes(ref.path)) reasons.push(`component ${component.id} cites out-of-scope path ${ref.path}`);
    }
    const childObserved = codes
      .filter(code => code.parentId === component.id)
      .flatMap(code => observedRangesFor(code.id, coverageByCodeId));
    validateGroundedUntestedBehaviours(component, childObserved, reasons);
  }

  const baseCodeById = new Map(scope.code.map(code => [code.id, code]));
  const reparent = new Map<string, string>();
  const codeJudgements = new Map<string, CodeJudgement>();
  const parentByPath = new Map<string, string>();
  for (const code of codes) {
    const base = baseCodeById.get(code.id);
    if (!base) { reasons.push(`code ${code.id} is outside this scope`); continue; }
    if (code.name !== base.name || code.kind !== "code" || !sourceRefsEqual(code.sourceRefs, base.sourceRefs)) {
      reasons.push(`code ${code.id} mutates an observed field`);
    }
    if (code.parentId === undefined || !proposedIds.has(code.parentId)) {
      reasons.push(`code ${code.id} must be re-parented into a proposed component`);
      continue;
    }
    reparent.set(code.id, code.parentId);
    // Judgement fields are ADDITIVE prose on top of the immutable observed facts —
    // the same contract logical components already enjoy.
    const judgement = judgementOf(code);
    if (judgement) codeJudgements.set(code.id, judgement);
    validateGroundedUntestedBehaviours(code, observedRangesFor(code.id, coverageByCodeId), reasons);
    const path = code.sourceRefs[0]?.path ?? "";
    const existing = parentByPath.get(path);
    if (existing !== undefined && existing !== code.parentId) reasons.push(`file ${path} is split across components (violates file cohesion)`);
    else parentByPath.set(path, code.parentId);
  }
  const docCodeIds = new Set(codes.map(code => code.id));
  for (const id of baseCodeById.keys()) {
    if (!docCodeIds.has(id)) reasons.push(`code ${id} is not assigned to any component (incomplete coverage)`);
  }

  if (reasons.length) return { reasons };
  const containerJudgement = containers[0] ? judgementOf(containers[0]) : undefined;
  return {
    proposal: {
      mode: "regroup",
      logicalComponents: components,
      reparent,
      codeJudgements,
      componentJudgements: new Map(),
      ...(containerJudgement ? { containerJudgement } : {}),
    },
    reasons: [],
  };
}

/**
 * Section-summary documents restate scanner-scoped containers/components (and
 * optionally a code entity) with `responsibility`. They must not invent ids,
 * regroup files, or cite out-of-scope paths. Rejection is atomic.
 */
function validateSummaryDoc(
  reasons: string[],
  scope: ContainerScope,
  restatedExisting: ArchitectureExtractionEntity[],
  codes: ArchitectureExtractionEntity[],
  containers: ArchitectureExtractionEntity[],
  coverageByCodeId: ReadonlyMap<string, EntityCoverageOverlay> | undefined,
): { proposal?: AcceptedProposal; reasons: string[] } {
  const componentJudgements = new Map<string, CodeJudgement>();
  for (const component of restatedExisting) {
    if (component.parentId !== scope.container.id) {
      reasons.push(`component ${component.id} must be parented to ${scope.container.id}`);
    }
    for (const ref of component.sourceRefs) {
      if (!scope.scopePaths.includes(ref.path)) {
        reasons.push(`component ${component.id} cites out-of-scope path ${ref.path}`);
      }
    }
    const childObserved = scope.code
      .filter(code => code.parentId === component.id)
      .flatMap(code => observedRangesFor(code.id, coverageByCodeId));
    validateGroundedUntestedBehaviours(component, childObserved, reasons);
    const judgement = judgementOf(component);
    if (judgement) componentJudgements.set(component.id, judgement);
  }

  const baseCodeById = new Map(scope.code.map(code => [code.id, code]));
  const codeJudgements = new Map<string, CodeJudgement>();
  for (const code of codes) {
    const base = baseCodeById.get(code.id);
    if (!base) { reasons.push(`code ${code.id} is outside this scope`); continue; }
    if (code.name !== base.name || code.kind !== "code" || !sourceRefsEqual(code.sourceRefs, base.sourceRefs)) {
      reasons.push(`code ${code.id} mutates an observed field`);
    }
    if (code.parentId !== base.parentId) {
      reasons.push(`code ${code.id} must keep its scanner parent ${base.parentId ?? "<none>"}`);
    }
    validateGroundedUntestedBehaviours(code, observedRangesFor(code.id, coverageByCodeId), reasons);
    const judgement = judgementOf(code);
    if (judgement) codeJudgements.set(code.id, judgement);
  }

  const containerJudgement = containers[0] ? judgementOf(containers[0]) : undefined;
  if (!containerJudgement && componentJudgements.size === 0) {
    reasons.push("must include a section summary (responsibility) on the container or an in-scope component");
  }
  if (reasons.length) return { reasons };
  return {
    proposal: {
      mode: "summaries",
      logicalComponents: [],
      reparent: new Map(),
      codeJudgements,
      componentJudgements,
      ...(containerJudgement ? { containerJudgement } : {}),
    },
    reasons: [],
  };
}

interface AcceptedSystemProposal {
  persons: ArchitectureExtractionEntity[];
  relations: ArchitectureExtractionRelation[];
  /** Judgement prose on restated container anchors — the only channel that can
   *  describe code-less containers (a crate with no outlined `.rs` still has no packet). */
  containerJudgements: Map<string, CodeJudgement>;
  /** Optional one-line summary of the software system itself. */
  systemJudgement?: CodeJudgement;
}

/** Kinds an accepted system-scope proposal may relate a person to (never components/code). */
const SYSTEM_RELATION_ANCHOR_KINDS = new Set(["softwareSystem", "container", "externalSystem"]);

/**
 * Atomically validates the one repo-wide system-scope document. It may ADD person entities and
 * relations that connect a person to the system / a container / an external system — nothing
 * else. Any attempt to add or mutate a container, component, or code entity (or to author a
 * relation that does not touch a proposed person) rejects the WHOLE document, leaving the
 * deterministic base untouched. Structural entities restated for relation endpoints are
 * id-matched anchors whose content is ignored (the base always wins).
 */
function validateSystemDoc(
  rawDoc: unknown,
  baseSystemId: string,
  baseById: ReadonlyMap<string, ArchitectureExtractionEntity>,
  systemScopePaths: ReadonlySet<string>,
): { proposal?: AcceptedSystemProposal; reasons: string[] } {
  const reasons: string[] = [];
  const doc = record(rawDoc);
  if (!doc) return { reasons: ["document is not a JSON object"] };
  const gate = validateArchitectureExtraction(doc);
  if (gate.length) return { reasons: gate.map(issue => `gate: ${issue.path || "<root>"} ${issue.message}`) };
  const extraction = doc as unknown as ArchitectureExtraction;

  const systems = extraction.entities.filter(entity => entity.kind === "softwareSystem");
  if (systems.length !== 1 || systems[0]!.id !== baseSystemId) reasons.push(`must restate exactly the base system ${baseSystemId}`);

  const persons: ArchitectureExtractionEntity[] = [];
  const containerJudgements = new Map<string, CodeJudgement>();
  let systemJudgement: CodeJudgement | undefined;
  for (const entity of extraction.entities) {
    if (entity.kind === "softwareSystem") {
      systemJudgement = judgementOf(entity);
      continue; // anchor ids stay base-owned; judgement prose is additive
    }
    if (entity.kind === "component" || entity.kind === "code") {
      reasons.push(`must not add ${entity.kind} entities (system scope may only add persons)`);
    } else if (entity.kind === "person") {
      if (baseById.has(entity.id)) reasons.push(`person ${entity.id} collides with an existing entity id`);
      for (const ref of entity.sourceRefs) {
        if (!systemScopePaths.has(ref.path)) reasons.push(`person ${entity.id} cites out-of-scope path ${ref.path}`);
      }
      persons.push(entity);
    } else {
      // container / externalSystem / dataStore / queue: must be an existing base
      // anchor. Structure stays base-owned, but judgement prose on a restated
      // CONTAINER is carried — this is how a code-less container gets its
      // "what is this for" description.
      const base = baseById.get(entity.id);
      if (!base || base.kind !== entity.kind) {
        reasons.push(`${entity.kind} ${entity.id} must restate an existing base ${entity.kind}`);
      } else if (entity.kind === "container") {
        const judgement = judgementOf(entity);
        if (judgement) containerJudgements.set(entity.id, judgement);
      }
    }
  }
  if (persons.length === 0 && containerJudgements.size === 0 && systemJudgement === undefined) {
    reasons.push("must propose at least one person or a section summary");
  }

  const personIds = new Set(persons.map(person => person.id));
  const relations: ArchitectureExtractionRelation[] = [];
  for (const relation of extraction.relations) {
    if (!personIds.has(relation.from) && !personIds.has(relation.to)) {
      reasons.push(`relation ${relation.id} must connect a proposed person`);
      continue;
    }
    for (const endpoint of [relation.from, relation.to]) {
      if (personIds.has(endpoint)) continue;
      const base = baseById.get(endpoint);
      if (!base || !SYSTEM_RELATION_ANCHOR_KINDS.has(base.kind)) {
        reasons.push(`relation ${relation.id} endpoint ${endpoint} must be the system, a container, or an external system`);
      }
    }
    for (const item of relation.evidence) {
      if (!systemScopePaths.has(item.source.path)) reasons.push(`relation ${relation.id} cites out-of-scope evidence ${item.source.path}`);
    }
    relations.push(relation);
  }

  if (reasons.length) return { reasons };
  return {
    proposal: {
      persons,
      relations,
      containerJudgements,
      ...(systemJudgement ? { systemJudgement } : {}),
    },
    reasons: [],
  };
}

function mergeEvidence(evidence: readonly ArchitectureExtractionEvidence[]): ArchitectureExtractionEvidence[] {
  const byKey = new Map<string, ArchitectureExtractionEvidence>();
  for (const item of evidence) {
    const key = sourceRefKey(item.source);
    if (!byKey.has(key)) byKey.set(key, item);
  }
  return [...byKey.values()]
    .sort((left, right) => compareText(sourceRefKey(left.source), sourceRefKey(right.source)))
    .slice(0, MAX_EVIDENCE_PER_RELATION);
}

function asDocList(value: unknown): unknown[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/** Union remainder-packet summary docs. Later docs overwrite overlapping ids (canonical file order). */
function unionSummaryProposals(proposals: readonly AcceptedProposal[]): AcceptedProposal | undefined {
  if (proposals.length === 0) return undefined;
  const codeJudgements = new Map<string, CodeJudgement>();
  const componentJudgements = new Map<string, CodeJudgement>();
  let containerJudgement: CodeJudgement | undefined;
  for (const proposal of proposals) {
    for (const [id, judgement] of proposal.codeJudgements) codeJudgements.set(id, judgement);
    for (const [id, judgement] of proposal.componentJudgements) componentJudgements.set(id, judgement);
    if (proposal.containerJudgement) containerJudgement = proposal.containerJudgement;
  }
  return {
    mode: "summaries",
    logicalComponents: [],
    reparent: new Map(),
    codeJudgements,
    componentJudgements,
    ...(containerJudgement ? { containerJudgement } : {}),
  };
}

function distributeComponentBehaviours(
  judgementByCode: Map<string, CodeJudgement>,
  judgementByComponent: Map<string, CodeJudgement>,
  base: ArchitectureExtraction,
  coverageByCodeId: ReadonlyMap<string, EntityCoverageOverlay> | undefined,
): void {
  const children = new Map<string, string[]>();
  for (const entity of base.entities) {
    if (entity.kind !== "code" || !entity.parentId) continue;
    const list = children.get(entity.parentId) ?? [];
    list.push(entity.id);
    children.set(entity.parentId, list);
  }
  for (const [componentId, judgement] of judgementByComponent) {
    const items = judgement.untestedBehaviours;
    if (!items?.length) continue;
    for (const item of items) {
      const match = (children.get(componentId) ?? []).find(id =>
        rangeGroundedInObserved(item, coverageByCodeId?.get(id)?.untestedRanges ?? []));
      if (!match) continue;
      const existing = judgementByCode.get(match);
      if (existing?.untestedBehaviours?.length) continue;
      judgementByCode.set(match, {
        ...(existing ?? {}),
        untestedBehaviours: [...(existing?.untestedBehaviours ?? []), item],
      });
    }
  }
}

/**
 * Merges accepted enrichment proposals into the deterministic base. Rejected or absent
 * scopes stay on their file-component base. Accepted regroup docs replace file-components;
 * accepted section summaries only attach judgement prose (`responsibility`) to scanner-scoped
 * entities. Multiple remainder-packet docs for one container union their summaries (each
 * document is still atomically rejected). Deterministic: same base + docs → byte-identical
 * output, independent of doc order.
 */
export function mergeEnrichment(
  base: ArchitectureExtraction,
  docsByContainer: ReadonlyMap<string, unknown>,
  options: MergeEnrichmentOptions = {},
): EnrichmentOutcome {
  const scopes = containerScopes(base);
  const coverageByCodeId = options.coverageByCodeId;
  const promptVersion = reportPromptVersion(coverageByCodeId);
  const baseSystemId = base.entities.find(entity => entity.kind === "softwareSystem")?.id ?? "";
  const baseEntityIds = new Set(base.entities.map(entity => entity.id));
  const baseById = new Map(base.entities.map(entity => [entity.id, entity]));

  const results: EnrichmentDocResult[] = [];
  const accepted = new Map<string, AcceptedProposal>();
  for (const containerId of [...docsByContainer.keys()].sort()) {
    if (containerId === baseSystemId) continue; // the system id routes to the system-scope path below
    const scope = scopes.get(containerId);
    if (!scope) { results.push({ containerId, accepted: false, reasons: [`no such container in the base (${containerId})`] }); continue; }
    if (scope.codeBearing.length === 0) { results.push({ containerId, accepted: false, reasons: ["container has no code-bearing components to enrich"] }); continue; }
    const summaryProposals: AcceptedProposal[] = [];
    let regroupProposal: AcceptedProposal | undefined;
    const rejectedReasons: string[] = [];
    for (const rawDoc of asDocList(docsByContainer.get(containerId))) {
      const { proposal, reasons } = validateDoc(rawDoc, scope, baseSystemId, baseEntityIds, coverageByCodeId);
      if (!proposal) {
        rejectedReasons.push(...reasons);
        continue;
      }
      if (proposal.mode === "regroup") regroupProposal = proposal;
      else summaryProposals.push(proposal);
    }
    const proposal = regroupProposal ?? unionSummaryProposals(summaryProposals);
    if (proposal) {
      results.push({
        containerId,
        accepted: true,
        reasons: [],
        components: proposal.mode === "summaries" ? proposal.componentJudgements.size : proposal.logicalComponents.length,
      });
      accepted.set(containerId, proposal);
    } else results.push({ containerId, accepted: false, reasons: rejectedReasons });
  }

  // System-scope proposal (top-level actors): keyed by the system id. May only ADD persons +
  // person-touching relations; citable paths are the system + container evidence anchors.
  const systemScopePaths = new Set<string>();
  for (const entity of base.entities) {
    if (entity.kind === "softwareSystem" || entity.kind === "container") {
      for (const ref of entity.sourceRefs) systemScopePaths.add(ref.path);
    }
  }
  let acceptedSystem: AcceptedSystemProposal | undefined;
  let systemScopeResult: SystemScopeResult | undefined;
  if (baseSystemId && docsByContainer.has(baseSystemId)) {
    const { proposal, reasons } = validateSystemDoc(docsByContainer.get(baseSystemId), baseSystemId, baseById, systemScopePaths);
    if (proposal) {
      acceptedSystem = proposal;
      systemScopeResult = { accepted: true, reasons: [], persons: proposal.persons.length, relations: proposal.relations.length };
    } else {
      systemScopeResult = { accepted: false, reasons, persons: 0, relations: 0 };
    }
  }

  if (accepted.size === 0 && acceptedSystem === undefined) {
    return {
      extraction: base,
      report: {
        promptVersion,
        enrichedContainers: [],
        collapsedSelfEdges: 0,
        results: results.sort((left, right) => compareText(left.containerId, right.containerId)),
        ...(systemScopeResult ? { systemScope: systemScopeResult } : {}),
      },
    };
  }

  const summariesOnly = [...accepted.values()].every(proposal => proposal.mode === "summaries")
    && (acceptedSystem === undefined
      || (acceptedSystem.persons.length === 0 && acceptedSystem.relations.length === 0));
  if (summariesOnly) {
    const judgementByCode = new Map<string, CodeJudgement>();
    const judgementByComponent = new Map<string, CodeJudgement>();
    const judgementByContainer = new Map<string, CodeJudgement>(acceptedSystem?.containerJudgements ?? []);
    const systemJudgement = acceptedSystem?.systemJudgement;
    for (const containerId of [...accepted.keys()].sort()) {
      const proposal = accepted.get(containerId)!;
      for (const [codeId, judgement] of proposal.codeJudgements) judgementByCode.set(codeId, judgement);
      if (proposal.containerJudgement) judgementByContainer.set(containerId, proposal.containerJudgement);
      for (const [componentId, judgement] of proposal.componentJudgements) {
        judgementByComponent.set(componentId, judgement);
      }
    }
    distributeComponentBehaviours(judgementByCode, judgementByComponent, base, coverageByCodeId);
    const mergedEntities = base.entities.map(entity => {
      let next = entity;
      if (entity.kind === "code" && judgementByCode.has(entity.id)) {
        next = { ...entity, ...judgementByCode.get(entity.id)! };
      } else if (entity.kind === "component" && judgementByComponent.has(entity.id)) {
        next = { ...entity, ...judgementByComponent.get(entity.id)! };
      } else if (entity.kind === "container" && judgementByContainer.has(entity.id)) {
        next = { ...entity, ...judgementByContainer.get(entity.id)! };
      } else if (entity.kind === "softwareSystem" && systemJudgement) {
        next = { ...entity, ...systemJudgement };
      }
      return preserveObservedLanguageTechnology(entity, next);
    });
    return {
      extraction: { schemaVersion: 1, entities: mergedEntities, relations: base.relations },
      report: {
        promptVersion,
        enrichedContainers: [...accepted.keys()].sort(),
        collapsedSelfEdges: 0,
        results: results.sort((left, right) => compareText(left.containerId, right.containerId)),
        ...(systemScopeResult ? { systemScope: systemScopeResult } : {}),
      },
    };
  }


  const reparentByCode = new Map<string, string>();
  const judgementByCode = new Map<string, CodeJudgement>();
  const judgementByComponent = new Map<string, CodeJudgement>();
  const systemJudgement = acceptedSystem?.systemJudgement;
  // Container prose from the system doc first, per-container docs overriding —
  // a container's own scope has more context than the repo-wide sweep.
  const judgementByContainer = new Map<string, CodeJudgement>(acceptedSystem?.containerJudgements ?? []);
  const removedToLogical = new Map<string, string>();
  const removedCodeBearing = new Set<string>();
  const logicalComponentsFinal: ArchitectureExtractionEntity[] = [];
  for (const containerId of [...accepted.keys()].sort()) {
    const proposal = accepted.get(containerId)!;
    for (const [codeId, judgement] of proposal.codeJudgements) judgementByCode.set(codeId, judgement);
    if (proposal.containerJudgement) judgementByContainer.set(containerId, proposal.containerJudgement);
    for (const [componentId, judgement] of proposal.componentJudgements) judgementByComponent.set(componentId, judgement);
    if (proposal.mode === "summaries") continue;
    const scope = scopes.get(containerId)!;
    const pathsByLogical = new Map<string, Set<string>>();
    for (const code of scope.code) {
      const logicalId = proposal.reparent.get(code.id)!;
      reparentByCode.set(code.id, logicalId);
      const path = code.sourceRefs[0]?.path;
      if (path) { const set = pathsByLogical.get(logicalId) ?? new Set<string>(); set.add(path); pathsByLogical.set(logicalId, set); }
    }
    const logicalByPath = new Map<string, string>();
    for (const [logicalId, paths] of pathsByLogical) for (const path of paths) logicalByPath.set(path, logicalId);
    for (const component of scope.codeBearing) {
      removedCodeBearing.add(component.id);
      const path = scope.pathByComponentId.get(component.id);
      const logicalId = path ? logicalByPath.get(path) : undefined;
      if (logicalId) removedToLogical.set(component.id, logicalId);
    }
    for (const component of proposal.logicalComponents) {
      const paths = [...(pathsByLogical.get(component.id) ?? new Set<string>())].sort().slice(0, MAX_COMPONENT_SOURCE_REFS);
      const languages = paths.flatMap(path => {
        const tag = languageTagForScanPath(path);
        return tag ? [tag] : [];
      });
      const technology = mergeObservedLanguageTechnology(languages, component.technology);
      logicalComponentsFinal.push({
        id: component.id,
        kind: "component",
        parentId: containerId,
        name: component.name,
        ...(component.responsibility !== undefined ? { responsibility: component.responsibility } : {}),
        ...(technology ? { technology } : {}),
        ...(component.tags !== undefined ? { tags: component.tags } : {}),
        ...(component.untestedBehaviours?.length ? { untestedBehaviours: cloneUntestedBehaviours(component.untestedBehaviours) } : {}),
        sourceRefs: paths.map(path => ({ path })),
      });
    }
  }

  distributeComponentBehaviours(judgementByCode, judgementByComponent, base, coverageByCodeId);

  const mergedEntities: ArchitectureExtractionEntity[] = [];
  for (const entity of base.entities) {
    if (entity.kind === "component" && removedCodeBearing.has(entity.id)) continue;
    let next: ArchitectureExtractionEntity;
    if (entity.kind === "code" && reparentByCode.has(entity.id)) {
      next = { ...entity, parentId: reparentByCode.get(entity.id)!, ...(judgementByCode.get(entity.id) ?? {}) };
    } else if (entity.kind === "code" && judgementByCode.has(entity.id)) {
      next = { ...entity, ...judgementByCode.get(entity.id)! };
    } else if (entity.kind === "component" && judgementByComponent.has(entity.id)) {
      next = { ...entity, ...judgementByComponent.get(entity.id)! };
    } else if (entity.kind === "container" && judgementByContainer.has(entity.id)) {
      next = { ...entity, ...judgementByContainer.get(entity.id)! };
    } else if (entity.kind === "softwareSystem" && systemJudgement) {
      next = { ...entity, ...systemJudgement };
    } else {
      next = entity;
    }
    mergedEntities.push(preserveObservedLanguageTechnology(entity, next));
  }
  mergedEntities.push(...logicalComponentsFinal);
  // Accepted top-level actors — normalized to the fact fields, always top-level (no parentId).
  for (const person of acceptedSystem?.persons ?? []) {
    mergedEntities.push({
      id: person.id,
      kind: "person",
      name: person.name,
      ...(person.responsibility !== undefined ? { responsibility: person.responsibility } : {}),
      ...(person.technology !== undefined ? { technology: person.technology } : {}),
      ...(person.tags !== undefined ? { tags: person.tags } : {}),
      sourceRefs: person.sourceRefs.map(ref => ({ ...ref })),
    });
  }
  mergedEntities.sort((left, right) => compareText(left.id, right.id));

  const remap = (id: string): string => removedToLogical.get(id) ?? id;
  const logicalToContainer = new Map(logicalComponentsFinal.map(component => [component.id, component.parentId!]));
  const selfEdgesByContainer = new Map<string, number>();
  const collapsed = new Map<string, { from: string; to: string; kind: RelationKind; evidence: ArchitectureExtractionEvidence[] }>();
  for (const relation of base.relations) {
    const from = remap(relation.from);
    const to = remap(relation.to);
    if (from === to && relation.kind !== "calls") {
      // Both endpoints regrouped into the same logical component — record the drop, don't hide it.
      const container = logicalToContainer.get(from);
      if (container) selfEdgesByContainer.set(container, (selfEdgesByContainer.get(container) ?? 0) + 1);
      continue;
    }
    const key = `${from}\u0000${to}\u0000${relation.kind}`;
    const entry = collapsed.get(key) ?? { from, to, kind: relation.kind, evidence: [] };
    entry.evidence.push(...relation.evidence);
    collapsed.set(key, entry);
  }
  // Person-touching relations flow through the same collapse/dedup/id pipeline. Their endpoints
  // (persons, containers, the system, externals) are never remapped, so they pass through as-is.
  for (const relation of acceptedSystem?.relations ?? []) {
    const key = `${relation.from}::${relation.to}::${relation.kind}`;
    const entry = collapsed.get(key) ?? { from: relation.from, to: relation.to, kind: relation.kind, evidence: [] };
    entry.evidence.push(...relation.evidence);
    collapsed.set(key, entry);
  }
  const collapsedList = [...collapsed.values()].sort((left, right) =>
    compareText(left.from, right.from) || compareText(left.to, right.to) || compareText(left.kind, right.kind));
  const relationIds = resolveCollisions(collapsedList.map(relation => typedId("relation", localOf(relation.from), localOf(relation.to))));
  const mergedRelations: ArchitectureExtractionRelation[] = collapsedList.map((relation, index) => ({
    id: relationIds[index]!,
    from: relation.from,
    to: relation.to,
    kind: relation.kind,
    evidence: mergeEvidence(relation.evidence),
  }));

  const totalSelfEdges = [...selfEdgesByContainer.values()].reduce((sum, count) => sum + count, 0);
  return {
    extraction: { schemaVersion: 1, entities: mergedEntities, relations: mergedRelations },
    report: {
      promptVersion,
      enrichedContainers: [...accepted.keys()].sort(),
      collapsedSelfEdges: totalSelfEdges,
      results: results
        .map(result => (accepted.has(result.containerId)
          ? { ...result, collapsedSelfEdges: selfEdgesByContainer.get(result.containerId) ?? 0 }
          : result))
        .sort((left, right) => compareText(left.containerId, right.containerId)),
      ...(systemScopeResult ? { systemScope: systemScopeResult } : {}),
    },
  };
}
