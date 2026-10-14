import {
  type ArchitectureSnapshot,
  type ArchitectureView,
  type EntityId,
  type EntityKind,
  type RelationKind,
  type StoryDetail,
} from "./model.js";
import { compareText } from "./text-order.js";

export const C4_DIAGRAM_TYPE_LABELS = {
  context: "System context diagram",
  container: "Container diagram",
  component: "Component diagram",
  code: "Code diagram",
} as const satisfies Record<StoryDetail, string>;

export const C4_ELEMENT_TYPE_LABELS = {
  person: "Person",
  softwareSystem: "Software system",
  container: "Container",
  component: "Component",
  code: "Code element",
  externalSystem: "External system",
  dataStore: "Data store",
  queue: "Queue",
  boundary: "Boundary",
} as const satisfies Record<EntityKind, string>;

export const C4_RELATION_KIND_LABELS = {
  uses: "Uses",
  calls: "Calls",
  reads: "Reads from",
  writes: "Writes to",
  publishes: "Publishes to",
  subscribes: "Subscribes to",
  contains: "Contains",
  dependsOn: "Depends on",
  returns: "Returns to",
  duplicates: "Duplicates",
} as const satisfies Record<RelationKind, string>;

export type C4NotationCompletenessCode =
  | "diagram.title.missing"
  | "diagram.type.missing"
  | "diagram.type.unsupported"
  | "diagram.scope.missing"
  | "diagram.scope.unknown"
  | "diagram.scope.outside-view"
  | "diagram.scope.incompatible"
  | "element.type.unsupported"
  | "element.description.missing"
  | "element.technology.missing"
  | "relationship.direction.invalid"
  | "relationship.label.missing"
  | "relationship.technology.missing";

export type C4NotationSubject =
  | { kind: "diagram"; id: string }
  | { kind: "element"; id: string }
  | { kind: "relationship"; id: string };

export type C4GlossaryCategory =
  | "diagram-type"
  | "element-type"
  | "relationship-kind"
  | "technology"
  | "protocol";

/** Stable terminology metadata suitable for a future legend or glossary. */
export interface C4GlossaryTerm {
  category: C4GlossaryCategory;
  key: string;
  label: string;
}

/**
 * Advisory notation feedback. These diagnostics deliberately do not participate
 * in validateSnapshot/validateView and therefore cannot reject otherwise valid
 * architecture data.
 */
export interface C4NotationCompletenessDiagnostic {
  severity: "advisory";
  code: C4NotationCompletenessCode;
  path: string;
  message: string;
  subject: C4NotationSubject;
  glossaryTerms: C4GlossaryTerm[];
}

export interface C4NotationCompletenessInput {
  snapshot: ArchitectureSnapshot;
  view: ArchitectureView;
  /** Uses the existing semantic-detail vocabulary: context, container, component, or code. */
  diagramType?: StoryDetail;
  /** Defaults to ArchitectureView.name, the current model's diagram title. */
  title?: string;
  /** Defaults to ArchitectureView.rootEntityId, the current model's diagram scope. */
  scopeEntityId?: EntityId;
}

const diagramTypes = new Set<StoryDetail>(["context", "container", "component", "code"]);
const entityKinds = new Set<EntityKind>([
  "person",
  "softwareSystem",
  "container",
  "component",
  "code",
  "externalSystem",
  "dataStore",
  "queue",
  "boundary",
]);

const scopeKinds = {
  context: "softwareSystem",
  container: "softwareSystem",
  component: "container",
  code: "component",
} as const satisfies Record<StoryDetail, EntityKind>;

const technologyKinds = {
  context: new Set<EntityKind>(),
  container: new Set<EntityKind>(["container", "dataStore", "queue"]),
  component: new Set<EntityKind>(["component", "dataStore", "queue"]),
  code: new Set<EntityKind>(),
} as const satisfies Record<StoryDetail, ReadonlySet<EntityKind>>;

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareText);
}

function isNonBlank(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isDiagramType(value: unknown): value is StoryDetail {
  return typeof value === "string" && diagramTypes.has(value as StoryDetail);
}

function isEntityKind(value: unknown): value is EntityKind {
  return typeof value === "string" && entityKinds.has(value as EntityKind);
}

function diagramTerm(type: StoryDetail): C4GlossaryTerm {
  return { category: "diagram-type", key: type, label: C4_DIAGRAM_TYPE_LABELS[type] };
}

function elementTerm(kind: EntityKind): C4GlossaryTerm {
  return { category: "element-type", key: kind, label: C4_ELEMENT_TYPE_LABELS[kind] };
}

function relationshipTerm(kind: RelationKind): C4GlossaryTerm {
  return { category: "relationship-kind", key: kind, label: C4_RELATION_KIND_LABELS[kind] };
}

function diagnostic(
  code: C4NotationCompletenessCode,
  path: string,
  message: string,
  subject: C4NotationSubject,
  glossaryTerms: C4GlossaryTerm[] = [],
): C4NotationCompletenessDiagnostic {
  return { severity: "advisory", code, path, message, subject, glossaryTerms };
}

/**
 * Reports C4 notation omissions without changing structural validation.
 *
 * Diagnostics use stable semantic IDs in their paths and are sorted by path,
 * code, and subject ID so input insertion order cannot affect the result.
 */
export function validateC4NotationCompleteness({
  snapshot,
  view,
  diagramType: rawDiagramType,
  title: inputTitle,
  scopeEntityId: inputScopeEntityId,
}: C4NotationCompletenessInput): C4NotationCompletenessDiagnostic[] {
  const diagnostics: C4NotationCompletenessDiagnostic[] = [];
  const diagramSubject = { kind: "diagram", id: view.id } as const;
  const title: unknown = inputTitle ?? view.name;
  if (!isNonBlank(title)) {
    diagnostics.push(diagnostic(
      "diagram.title.missing",
      "diagram.title",
      "C4 diagrams should have a non-blank title.",
      diagramSubject,
    ));
  }

  const rawDiagramTypeValue: unknown = rawDiagramType;
  const diagramType: StoryDetail | undefined = isDiagramType(rawDiagramTypeValue) ? rawDiagramTypeValue : undefined;
  if (rawDiagramTypeValue === undefined || rawDiagramTypeValue === null || rawDiagramTypeValue === "") {
    diagnostics.push(diagnostic(
      "diagram.type.missing",
      "diagram.type",
      "C4 diagrams should declare context, container, component, or code type.",
      diagramSubject,
    ));
  } else if (!diagramType) {
    diagnostics.push(diagnostic(
      "diagram.type.unsupported",
      "diagram.type",
      `Unsupported C4 diagram type: ${String(rawDiagramTypeValue)}.`,
      diagramSubject,
    ));
  }

  const scopeEntityId: unknown = inputScopeEntityId ?? view.rootEntityId;
  const entityById = new Map(snapshot.entities.map(entity => [entity.id, entity]));
  const visibleEntityIds = new Set(view.entityIds);
  if (!isNonBlank(scopeEntityId)) {
    diagnostics.push(diagnostic(
      "diagram.scope.missing",
      "diagram.scopeEntityId",
      "C4 diagrams should identify a scope entity.",
      diagramSubject,
      diagramType ? [diagramTerm(diagramType)] : [],
    ));
  } else {
    const scope = entityById.get(scopeEntityId);
    if (!scope) {
      diagnostics.push(diagnostic(
        "diagram.scope.unknown",
        "diagram.scopeEntityId",
        `C4 diagram scope is not in the snapshot: ${scopeEntityId}.`,
        diagramSubject,
        diagramType ? [diagramTerm(diagramType)] : [],
      ));
    } else {
      if (!visibleEntityIds.has(scopeEntityId)) {
        diagnostics.push(diagnostic(
          "diagram.scope.outside-view",
          "diagram.scopeEntityId",
          `C4 diagram scope is not included in view ${view.id}: ${scopeEntityId}.`,
          diagramSubject,
          diagramType ? [diagramTerm(diagramType)] : [],
        ));
      }
      if (diagramType && scope.kind !== scopeKinds[diagramType]) {
        const expected = scopeKinds[diagramType];
        diagnostics.push(diagnostic(
          "diagram.scope.incompatible",
          "diagram.scopeEntityId",
          `${C4_DIAGRAM_TYPE_LABELS[diagramType]} scope should be a ${C4_ELEMENT_TYPE_LABELS[expected]}; ${scopeEntityId} is a ${isEntityKind(scope.kind) ? C4_ELEMENT_TYPE_LABELS[scope.kind] : String(scope.kind)}.`,
          diagramSubject,
          [diagramTerm(diagramType), elementTerm(expected)],
        ));
      }
    }
  }

  for (const entityId of uniqueSorted(view.entityIds)) {
    const entity = entityById.get(entityId);
    if (!entity) continue;
    const entitySubject = { kind: "element", id: entity.id } as const;
    const kind = isEntityKind(entity.kind) ? entity.kind : undefined;
    const glossaryTerms = kind ? [elementTerm(kind)] : [];
    if (!kind) {
      diagnostics.push(diagnostic(
        "element.type.unsupported",
        `entities.${entity.id}.kind`,
        `C4 element ${entity.id} has an unsupported type: ${String(entity.kind)}.`,
        entitySubject,
      ));
    }
    if (!isNonBlank(entity.responsibility)) {
      diagnostics.push(diagnostic(
        "element.description.missing",
        `entities.${entity.id}.responsibility`,
        `C4 element ${entity.id} should have a description.`,
        entitySubject,
        glossaryTerms,
      ));
    }
    if (diagramType && kind && technologyKinds[diagramType].has(kind)
      && !(entity.technology ?? []).some(isNonBlank)) {
      diagnostics.push(diagnostic(
        "element.technology.missing",
        `entities.${entity.id}.technology`,
        `${C4_ELEMENT_TYPE_LABELS[kind]} ${entity.id} should name its technology on a ${C4_DIAGRAM_TYPE_LABELS[diagramType].toLowerCase()}.`,
        entitySubject,
        glossaryTerms,
      ));
    }
  }

  const relationById = new Map(snapshot.relations.map(relation => [relation.id, relation]));
  for (const relationId of uniqueSorted(view.relationIds)) {
    const relation = relationById.get(relationId);
    if (!relation) continue;
    const relationSubject = { kind: "relationship", id: relation.id } as const;
    const glossaryTerms = [relationshipTerm(relation.kind)];
    if (!isNonBlank(relation.from) || !isNonBlank(relation.to) || (relation.from === relation.to && relation.kind !== "calls")) {
      diagnostics.push(diagnostic(
        "relationship.direction.invalid",
        `relations.${relation.id}.direction`,
        `C4 relationship ${relation.id} should have nonblank directional endpoints; only calls may be recursive.`,
        relationSubject,
        glossaryTerms,
      ));
    }
    if (!isNonBlank(relation.label)) {
      diagnostics.push(diagnostic(
        "relationship.label.missing",
        `relations.${relation.id}.label`,
        `C4 relationship ${relation.id} should have a directional label.`,
        relationSubject,
        glossaryTerms,
      ));
    }
    if (diagramType === "container" && !isNonBlank(relation.technology)) {
      diagnostics.push(diagnostic(
        "relationship.technology.missing",
        `relations.${relation.id}.technology`,
        `L2 relationship ${relation.id} should name its protocol or technology.`,
        relationSubject,
        glossaryTerms,
      ));
    }
  }

  return diagnostics.sort((left, right) => compareText(left.path, right.path)
    || compareText(left.code, right.code)
    || compareText(left.subject.id, right.subject.id));
}
