import assert from "node:assert/strict";
import test from "node:test";
import {
  SOURCE_EXCERPT_LIMITS,
  STORY_AUTHORING_LIMITS,
  type ArchitectureOverrides,
  type ArchitectureSnapshot,
  type ArchitectureStory,
  type ArchitectureView,
  type SourceExcerpt,
  type StoryStep,
} from "./model.js";
import { validateOverrides, validateSnapshot, validateStory, validateStoryDocument, validateView, type ValidationIssue } from "./validation.js";

const snapshot: ArchitectureSnapshot = {
  schemaVersion: 1,
  id: "snapshot:test",
  repositoryId: "repo:test",
  commitSha: "abc123",
  generatedAt: "2026-07-14T00:00:00.000Z",
  entities: [
    { id: "system:test", kind: "softwareSystem", name: "Test", sourceRefs: [] },
    {
      id: "container:api",
      kind: "container",
      parentId: "system:test",
      name: "API",
      sourceRefs: [{ path: "src/api.ts", commitSha: "abc123", symbol: "ApiServer", startLine: 10, endLine: 40 }],
    },
  ],
  relations: [],
};

test("accepts a coherent architecture snapshot", () => {
  assert.deepEqual(validateSnapshot(snapshot), []);
});

test("accepts McCabe cyclomatic on code entities and rejects it elsewhere", () => {
  const withCode: ArchitectureSnapshot = {
    ...snapshot,
    entities: [
      ...snapshot.entities,
      {
        id: "code:api-handler",
        kind: "code",
        parentId: "container:api",
        name: "handler",
        sourceRefs: [{ path: "src/api.ts", commitSha: "abc123", symbol: "handler", startLine: 12, endLine: 20 }],
        cyclomaticComplexity: 7,
      },
    ],
  };
  assert.deepEqual(validateSnapshot(withCode), []);
  const onContainer: ArchitectureSnapshot = {
    ...snapshot,
    entities: snapshot.entities.map(entity => entity.id === "container:api"
      ? { ...entity, cyclomaticComplexity: 3 }
      : entity),
  };
  assert.ok(validateSnapshot(onContainer).some(issue => issue.path.endsWith("cyclomaticComplexity") && issue.message.includes("code entities")));
  const fractional: ArchitectureSnapshot = {
    ...withCode,
    entities: withCode.entities.map(entity => entity.id === "code:api-handler"
      ? { ...entity, cyclomaticComplexity: 1.5 }
      : entity),
  };
  assert.ok(validateSnapshot(fractional).some(issue => issue.path.endsWith("cyclomaticComplexity") && issue.message.includes("integer")));
});

test("accepts lcov coverage on code entities and rejects it elsewhere", () => {
  const withCode: ArchitectureSnapshot = {
    ...snapshot,
    entities: [
      ...snapshot.entities,
      {
        id: "code:api-handler",
        kind: "code",
        parentId: "container:api",
        name: "handler",
        sourceRefs: [{ path: "src/api.ts", commitSha: "abc123", symbol: "handler", startLine: 12, endLine: 20 }],
        coverageFileHitRate: 0.3,
        coverageUntestedRanges: [{ startLine: 14, endLine: 16 }],
      },
    ],
  };
  assert.deepEqual(validateSnapshot(withCode), []);
  const onContainer: ArchitectureSnapshot = {
    ...snapshot,
    entities: snapshot.entities.map(entity => entity.id === "container:api"
      ? { ...entity, coverageFileHitRate: 0, coverageUntestedRanges: [{ startLine: 1, endLine: 2 }] }
      : entity),
  };
  assert.ok(validateSnapshot(onContainer).some(issue => issue.path.endsWith("coverageFileHitRate") && issue.message.includes("code entities")));
  assert.ok(validateSnapshot(onContainer).some(issue => issue.path.endsWith("coverageUntestedRanges") && issue.message.includes("code entities")));
  const inverted: ArchitectureSnapshot = {
    ...withCode,
    entities: withCode.entities.map(entity => entity.id === "code:api-handler"
      ? { ...entity, coverageFileHitRate: 1.5, coverageUntestedRanges: [{ startLine: 8, endLine: 4 }] }
      : entity),
  };
  assert.ok(validateSnapshot(inverted).some(issue => issue.path.endsWith("coverageFileHitRate") && issue.message.includes("between 0 and 1")));
  assert.ok(validateSnapshot(inverted).some(issue => issue.path.endsWith("endLine") && issue.message.includes("startLine")));
});

test("accepts untestedBehaviours on code and rejects them on systems", () => {
  const withCode: ArchitectureSnapshot = {
    ...snapshot,
    entities: [
      ...snapshot.entities,
      {
        id: "code:api-handler",
        kind: "code",
        parentId: "container:api",
        name: "handler",
        sourceRefs: [{ path: "src/api.ts", commitSha: "abc123", symbol: "handler", startLine: 12, endLine: 20 }],
        untestedBehaviours: [{ startLine: 14, endLine: 16, behaviour: "Rejects a blank token." }],
      },
    ],
  };
  assert.deepEqual(validateSnapshot(withCode), []);
  const onSystem: ArchitectureSnapshot = {
    ...snapshot,
    entities: snapshot.entities.map(entity => entity.kind === "softwareSystem"
      ? { ...entity, untestedBehaviours: [{ startLine: 1, endLine: 1, behaviour: "Invented." }] }
      : entity),
  };
  assert.ok(validateSnapshot(onSystem).some(issue => issue.path.endsWith("untestedBehaviours") && issue.message.includes("code or component")));
});

test("accepts duplicates relations between code entities and rejects them elsewhere", () => {
  const withCode: ArchitectureSnapshot = {
    ...snapshot,
    entities: [
      ...snapshot.entities,
      {
        id: "code:api-alpha",
        kind: "code",
        parentId: "container:api",
        name: "alpha",
        sourceRefs: [{ path: "src/api.ts", commitSha: "abc123", symbol: "alpha", startLine: 12, endLine: 24 }],
      },
      {
        id: "code:api-beta",
        kind: "code",
        parentId: "container:api",
        name: "beta",
        sourceRefs: [{ path: "src/other.ts", commitSha: "abc123", symbol: "beta", startLine: 8, endLine: 20 }],
      },
    ],
    relations: [{
      id: "relation:dup:alpha-beta",
      from: "code:api-alpha",
      to: "code:api-beta",
      kind: "duplicates",
      label: "duplicates",
      evidence: [{ source: { path: "src/api.ts", commitSha: "abc123", symbol: "alpha", startLine: 12, endLine: 24 } }],
    }],
  };
  assert.deepEqual(validateSnapshot(withCode), []);
  const onContainer: ArchitectureSnapshot = {
    ...withCode,
    relations: [{
      ...withCode.relations[0]!,
      from: "container:api",
    }],
  };
  assert.ok(validateSnapshot(onContainer).some(issue => issue.message.includes("duplicates relations must connect code entities")));
});

test("accepts coherent frozen excerpts and entities without source content", () => {
  const lines = ["export const café = '🗺️';", "export default café;"];
  const excerpt: SourceExcerpt = {
    path: "src/café.ts",
    symbol: "café",
    language: "typescript",
    startLine: 10,
    endLine: 11,
    highlightLine: 10,
    frozenRevision: snapshot.commitSha,
    lines,
    text: lines.join("\n"),
  };
  const unicodeBoundaryText = "😀".repeat(SOURCE_EXCERPT_LIMITS.maxLineCharacters);
  const unicodeBoundary: SourceExcerpt = {
    path: "src/unicode.ts",
    language: "typescript",
    startLine: 1,
    endLine: 1,
    highlightLine: 1,
    frozenRevision: snapshot.commitSha,
    lines: [unicodeBoundaryText],
    text: unicodeBoundaryText,
  };
  const withExcerpt: ArchitectureSnapshot = {
    ...snapshot,
    entities: [
      ...snapshot.entities,
      {
        id: "code:café",
        kind: "code",
        parentId: "container:api",
        name: "café",
        sourceRefs: [{
          path: excerpt.path,
          ...(excerpt.symbol ? { symbol: excerpt.symbol } : {}),
          commitSha: excerpt.frozenRevision,
          startLine: excerpt.startLine,
          endLine: excerpt.endLine,
        }],
        sourceExcerpts: [excerpt],
      },
      {
        id: "code:unicode-boundary",
        kind: "code",
        parentId: "container:api",
        name: "Unicode boundary",
        sourceRefs: [{
          path: unicodeBoundary.path,
          commitSha: unicodeBoundary.frozenRevision,
          startLine: unicodeBoundary.startLine,
          endLine: unicodeBoundary.endLine,
        }],
        sourceExcerpts: [unicodeBoundary],
      },
    ],
  };
  assert.deepEqual(validateSnapshot(withExcerpt), []);
  assert.deepEqual(validateSnapshot(snapshot), [], "source-less entities must remain valid");
});

test("rejects unsafe, incoherent, non-finite, and oversized source excerpts", () => {
  const oversizedLine = "😀".repeat(SOURCE_EXCERPT_LIMITS.maxLineCharacters + 1);
  const excerpt = {
    path: "../outside.ts",
    symbol: "anchor",
    language: "python",
    startLine: Number.NaN,
    endLine: 3,
    highlightLine: Number.POSITIVE_INFINITY,
    frozenRevision: "another-revision",
    lines: [oversizedLine],
    text: "not the frozen line",
  } as unknown as SourceExcerpt;
  const invalid: ArchitectureSnapshot = {
    ...snapshot,
    entities: [{
      id: "code:unsafe",
      kind: "code",
      name: "Unsafe",
      sourceRefs: [{ path: "C:\\absolute\\source.ts", commitSha: snapshot.commitSha }],
      sourceExcerpts: [excerpt],
    }],
  };
  const issues = validateSnapshot(invalid);
  assert.ok(issues.some(issue => issue.path.endsWith("sourceRefs[0].path")));
  assert.ok(issues.some(issue => issue.path.endsWith("sourceExcerpts[0].path")));
  assert.ok(issues.some(issue => issue.path.endsWith("language")));
  assert.ok(issues.some(issue => issue.path.endsWith("startLine")));
  assert.ok(issues.some(issue => issue.path.endsWith("highlightLine")));
  assert.ok(issues.some(issue => issue.path.endsWith("frozenRevision")));
  assert.ok(issues.some(issue => issue.path.endsWith("lines[0]")));
  assert.ok(issues.some(issue => issue.path.endsWith("text")));
  assert.ok(issues.some(issue => issue.message.includes("exactly match an entity sourceRef")));
});

test("reports dangling parents and unpinned source evidence", () => {
  const invalid: ArchitectureSnapshot = {
    ...snapshot,
    entities: [
      ...snapshot.entities,
      {
        id: "component:orphan",
        kind: "component",
        parentId: "container:missing",
        name: "Orphan",
        confidence: 1.2,
        sourceRefs: [{ path: "/absolute/file.ts", commitSha: "" }],
      },
    ],
  };
  const issues = validateSnapshot(invalid);
  assert.ok(issues.some((issue) => issue.path.endsWith("parentId")));
  assert.ok(issues.some((issue) => issue.path.endsWith("confidence")));
  assert.ok(issues.some((issue) => issue.path.endsWith(".path")));
  assert.ok(issues.some((issue) => issue.path.endsWith("commitSha")));
});

test("rejects cyclic containment", () => {
  const invalid: ArchitectureSnapshot = {
    ...snapshot,
    entities: [
      { id: "component:a", kind: "component", parentId: "component:b", name: "A", sourceRefs: [] },
      { id: "component:b", kind: "component", parentId: "component:a", name: "B", sourceRefs: [] },
    ],
  };
  assert.ok(validateSnapshot(invalid).some((issue) => issue.message.includes("cycle")));
});

test("rejects non-finite semantic numbers and invalid source line ranges", () => {
  const invalid: ArchitectureSnapshot = {
    ...snapshot,
    entities: [
      {
        id: "component:numeric",
        kind: "component",
        name: "Numeric",
        confidence: Number.NaN,
        sourceRefs: [
          {
            path: "src/numeric.ts",
            commitSha: "abc123",
            startLine: Number.POSITIVE_INFINITY,
            endLine: Number.NEGATIVE_INFINITY,
          },
        ],
      },
    ],
    relations: [
      {
        id: "relation:numeric",
        from: "component:numeric",
        to: "component:numeric",
        kind: "calls",
        confidence: Number.POSITIVE_INFINITY,
        evidence: [],
      },
    ],
  };
  const issues = validateSnapshot(invalid);
  assert.ok(issues.some((issue) => issue.path.endsWith("confidence")));
  assert.ok(issues.some((issue) => issue.path.endsWith("startLine")));
  assert.ok(issues.some((issue) => issue.path.endsWith("endLine")));
});

test("rejects non-finite view geometry and invalid dimensions", () => {
  const view: ArchitectureView = {
    schemaVersion: 1,
    id: "view:test",
    snapshotId: snapshot.id,
    name: "Test",
    rootEntityId: "system:test",
    entityIds: ["system:test", "container:api"],
    relationIds: [],
    layout: {
      nodes: {
        "system:test": { x: Number.NaN, y: Number.NEGATIVE_INFINITY, width: 0, height: Number.POSITIVE_INFINITY },
        "container:api": { x: 0, y: 0, width: 100, height: -1 },
      },
      edges: {},
    },
  };
  const issues = validateView(snapshot, view);
  assert.ok(issues.some((issue) => issue.path.endsWith(".x")));
  assert.ok(issues.some((issue) => issue.path.endsWith(".y")));
  assert.ok(issues.some((issue) => issue.path.endsWith(".width")));
  assert.ok(issues.some((issue) => issue.path.endsWith(".height")));
});

test("view relation lookup preserves first duplicate endpoints and ordered repeated issues", () => {
  const relatedSnapshot: ArchitectureSnapshot = {
    ...snapshot,
    relations: [
      { id: "relation:hidden-first", from: "system:test", to: "container:api", kind: "calls", evidence: [] },
      { id: "relation:hidden-first", from: "system:test", to: "system:test", kind: "calls", evidence: [] },
      { id: "relation:visible-first", from: "system:test", to: "system:test", kind: "calls", evidence: [] },
      { id: "relation:visible-first", from: "system:test", to: "container:api", kind: "calls", evidence: [] },
      { id: "relation:hidden-from", from: "container:api", to: "system:test", kind: "calls", evidence: [] },
      { id: "relation:hidden-both", from: "container:api", to: "entity:missing", kind: "calls", evidence: [] },
    ],
  };
  const view: ArchitectureView = {
    schemaVersion: 1, id: "view:test", snapshotId: snapshot.id, name: "Test",
    rootEntityId: "system:test", entityIds: ["system:test", "system:test"],
    relationIds: ["relation:missing", "relation:hidden-first", "relation:visible-first",
      "relation:hidden-from", "relation:hidden-first", "relation:hidden-both", "relation:missing"],
    layout: { nodes: { "system:test": { x: 0, y: 0, width: 200, height: 100 } } },
  };
  assert.deepEqual(validateView(relatedSnapshot, view), [
    { path: "entityIds", message: "duplicate entity id: system:test" },
    { path: "relationIds", message: "unknown relation: relation:missing" },
    { path: "relationIds", message: "relation endpoints must both be in the view: relation:hidden-first" },
    { path: "relationIds", message: "relation endpoints must both be in the view: relation:hidden-from" },
    { path: "relationIds", message: "relation endpoints must both be in the view: relation:hidden-first" },
    { path: "relationIds", message: "relation endpoints must both be in the view: relation:hidden-both" },
    { path: "relationIds", message: "unknown relation: relation:missing" },
  ]);
  assert.ok(validateSnapshot(relatedSnapshot).some(issue => issue.message.includes("duplicate relation id: relation:hidden-first")));
  assert.ok(validateSnapshot(relatedSnapshot).some(issue => issue.message.includes("duplicate relation id: relation:visible-first")));
});

test("rejects non-finite edge points and story timing/source lines", () => {
  const relatedSnapshot: ArchitectureSnapshot = {
    ...snapshot,
    relations: [{ id: "relation:test", from: "system:test", to: "container:api", kind: "calls", evidence: [] }],
  };
  const view: ArchitectureView = {
    schemaVersion: 1,
    id: "view:test",
    snapshotId: snapshot.id,
    name: "Test",
    rootEntityId: "system:test",
    entityIds: ["system:test", "container:api"],
    relationIds: ["relation:test"],
    layout: {
      nodes: {
        "system:test": { x: 0, y: 0, width: 200, height: 100 },
        "container:api": { x: 300, y: 0, width: 200, height: 100 },
      },
      edges: {
        "relation:test": {
          points: [
            { x: 200, y: 50 },
            { x: Number.POSITIVE_INFINITY, y: Number.NaN },
          ],
        },
      },
    },
  };
  const viewIssues = validateView(relatedSnapshot, view);
  assert.ok(viewIssues.some((issue) => issue.path.endsWith(".x")));
  assert.ok(viewIssues.some((issue) => issue.path.endsWith(".y")));

  const story: ArchitectureStory = {
    schemaVersion: 1,
    id: "story:test",
    snapshotId: snapshot.id,
    viewId: view.id,
    title: "Test",
    steps: [
      {
        id: "step:test",
        title: "Test step",
        focusEntityIds: ["system:test"],
        narration: "Test",
        durationMs: Number.POSITIVE_INFINITY,
        sourceRefs: [{ path: "src/test.ts", commitSha: "abc123", startLine: Number.NaN }],
      },
    ],
  };
  const storyIssues = validateStory(relatedSnapshot, view, story);
  assert.ok(storyIssues.some((issue) => issue.path.endsWith("durationMs")));
  assert.ok(storyIssues.some((issue) => issue.path.endsWith("startLine")));
});

test("rejects non-finite locked override layouts", () => {
  const overrides: ArchitectureOverrides = {
    schemaVersion: 1,
    repositoryId: "repo:test",
    entityPatches: {},
    hiddenEntityIds: [],
    lockedLayout: {
      "view:test": {
        "container:api": { x: Number.NEGATIVE_INFINITY, y: 0, width: Number.NaN, height: 100 },
      },
    },
  };
  const issues = validateOverrides(overrides);
  assert.ok(issues.some((issue) => issue.path.endsWith(".x")));
  assert.ok(issues.some((issue) => issue.path.endsWith(".width")));
});

test("strictly validates untrusted LLM story documents and semantic catalog references", () => {
  const view: ArchitectureView = {
    schemaVersion: 1,
    id: "view:test",
    snapshotId: snapshot.id,
    name: "Test",
    rootEntityId: "system:test",
    entityIds: ["system:test", "container:api"],
    relationIds: [],
    layout: {
      nodes: {
        "system:test": { x: 0, y: 0, width: 200, height: 100 },
        "container:api": { x: 20, y: 20, width: 100, height: 60 },
      },
    },
  };
  const valid: ArchitectureStory = {
    schemaVersion: 1,
    id: "story:test",
    snapshotId: snapshot.id,
    viewId: view.id,
    title: "Test story",
    steps: [{
      id: "step:api",
      title: "Open the API",
      focusEntityIds: ["container:api"],
      reveal: "container",
      narration: "The API owns the request boundary.",
      sourceRefs: [
        // Cites evidence container:api owns: a range-less path/commit match, and a symbol + contained range.
        { path: "src/api.ts", commitSha: snapshot.commitSha },
        { path: "src/api.ts", commitSha: snapshot.commitSha, symbol: "ApiServer", startLine: 15, endLine: 20 },
      ],
    }],
  };
  assert.deepEqual(validateStoryDocument(snapshot, view, valid), []);

  const invalid = {
    ...valid,
    unexpected: true,
    steps: [{
      ...valid.steps[0],
      title: " ",
      focusEntityIds: ["container:api", "container:api"],
      reveal: "context",
      sourceRefs: [{ path: "../api.ts", commitSha: "invented" }],
      camera: { zoom: 99 },
    }, { ...valid.steps[0] }],
  };
  const issues = validateStoryDocument(snapshot, view, invalid);
  assert.ok(issues.some(issue => issue.path === "unexpected" && issue.message === "is not allowed"));
  assert.ok(issues.some(issue => issue.path.endsWith(".camera") && issue.message === "is not allowed"));
  assert.ok(issues.some(issue => issue.path.endsWith(".title") && issue.message.includes("non-blank")));
  assert.ok(issues.some(issue => issue.path.endsWith(".focusEntityIds") && issue.message.includes("duplicate")));
  assert.ok(issues.some(issue => issue.path.endsWith(".reveal") && issue.message.includes("shallower")));
  assert.ok(issues.some(issue => issue.path.endsWith(".commitSha") && issue.message.includes("snapshot")));
  assert.ok(issues.some(issue => issue.path === "steps" && issue.message.includes("duplicate step")));
});

test("resolves story source references to snapshot evidence and caps authored hold duration", () => {
  const view: ArchitectureView = {
    schemaVersion: 1,
    id: "view:test",
    snapshotId: snapshot.id,
    name: "Test",
    rootEntityId: "system:test",
    entityIds: ["system:test", "container:api"],
    relationIds: [],
    layout: {
      nodes: {
        "system:test": { x: 0, y: 0, width: 200, height: 100 },
        "container:api": { x: 20, y: 20, width: 100, height: 60 },
      },
    },
  };
  const base: ArchitectureStory = {
    schemaVersion: 1,
    id: "story:test",
    snapshotId: snapshot.id,
    viewId: view.id,
    title: "Evidence story",
    steps: [{
      id: "step:api",
      title: "Open the API",
      focusEntityIds: ["container:api"],
      reveal: "container",
      narration: "The API owns the request boundary.",
    }],
  };
  const withStep = (patch: Partial<StoryStep>): ArchitectureStory => ({ ...base, steps: [{ ...base.steps[0]!, ...patch }] });
  const citesEvidenceIssue = (found: ValidationIssue[]): boolean =>
    found.some(issue => issue.path === "steps[0].sourceRefs[0]" && issue.message.includes("does not cite snapshot evidence"));

  // FIX 1 — a well-formed ref that the snapshot does not own must NOT pass as evidence.
  assert.ok(citesEvidenceIssue(validateStoryDocument(snapshot, view, withStep({ sourceRefs: [{ path: "src/ghost.ts", commitSha: snapshot.commitSha }] }))), "unowned file");
  assert.ok(citesEvidenceIssue(validateStoryDocument(snapshot, view, withStep({ sourceRefs: [{ path: "src/api.ts", commitSha: snapshot.commitSha, symbol: "GhostSymbol" }] }))), "symbol mismatch");
  assert.ok(citesEvidenceIssue(validateStoryDocument(snapshot, view, withStep({ sourceRefs: [{ path: "src/api.ts", commitSha: snapshot.commitSha, startLine: 100, endLine: 200 }] }))), "out-of-range lines");
  // ...but a symbol match with a contained line range resolves cleanly.
  assert.deepEqual(validateStoryDocument(snapshot, view, withStep({ sourceRefs: [{ path: "src/api.ts", commitSha: snapshot.commitSha, symbol: "ApiServer", startLine: 12, endLine: 40 }] })), []);

  // FIX 4 — authored holds are capped to the compiler's narration ceiling.
  assert.deepEqual(validateStoryDocument(snapshot, view, withStep({ durationMs: STORY_AUTHORING_LIMITS.maxStepDurationMs })), []);
  assert.ok(
    validateStoryDocument(snapshot, view, withStep({ durationMs: STORY_AUTHORING_LIMITS.maxStepDurationMs + 1 }))
      .some(issue => issue.path === "steps[0].durationMs" && issue.message.includes("exceed")),
    "over-limit hold is rejected",
  );
});
