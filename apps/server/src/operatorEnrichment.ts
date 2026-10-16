import { createHash, randomUUID } from "node:crypto";
import { scrubGithubTokens, scrubProviderIdentifiers } from "@okie/scan";
import { parseChatCompletionDocument } from "./enrichment.js";
import { classifyLlmGatewayFailure, LlmGatewayError, resolveLlmModelId, type GatewayUsage, type LlmChatCompletionResult } from "./llmGateway.js";

/**
 * CLA-134's runtime boundary.  This deliberately does not own draft storage or
 * publication: CLA-132 binds this small, durable seam to its store.
 */
export type OperatorExplanationState = "queued" | "running" | "accepted" | "failed" | "stale" | "cancelled";
/** A child passed to its parent's prompt; "not run" only appears for retries of partially enriched drafts. */
export type OperatorChildState = OperatorExplanationState | "not run";

export interface OperatorEvidenceRef { entityId?: string; path?: string; startLine?: number; endLine?: number; }
export interface OperatorExplanationTable { caption?: string; columns: string[]; rows: string[][]; }
/**
 * CLA-260 content (prompt `operator-enrichment/v3`): an area owner's short note for a new
 * teammate. `format` is stamped by the validator, never by the model; markdown-lite text only.
 */
export interface OperatorExplanationV3 {
  format: "v3";
  summary: string;
  keyPoints: string[];
  /** Mermaid source (flowchart LR/TB only), already checked by the server-side safety gate. */
  diagram?: string;
  table?: OperatorExplanationTable;
  evidence: OperatorEvidenceRef[];
  /** Why an invalid optional diagram and/or table was dropped; the prose is kept. */
  diagramError?: string;
  /**
   * CLA-145: bounded claims mapped to canonical evidence (prompt v4). Absent on legacy content, which
   * reads as "not evaluated: no claim mapping". Claim text is verbatim prose; it never replaces it.
   */
  claims?: OperatorExplanationClaim[];
  /** Why some or all model claim mappings were dropped (the explanation itself is kept unchanged). */
  claimsNote?: string;
}
/** One bounded assertion copied verbatim from the summary or equal to one key point, with its canonical evidence. */
export interface OperatorExplanationClaim { id: string; text: string; origin: "summary" | "keyPoint"; index: number; evidence: OperatorEvidenceRef[]; }
/** v1/v2 content already stored in sidecars and publications; loaded and published unchanged. */
export interface LegacyOperatorExplanation {
  format?: undefined;
  summary: string;
  roleWithinParent?: string;
  interactions?: string[];
  evidence: OperatorEvidenceRef[];
  /** Renderer turns these validated entity references into Mermaid later. */
  diagram?: { nodes: string[]; edges: Array<{ from: string; to: string; label?: string }> };
  diagramError?: string;
}
export type OperatorExplanation = OperatorExplanationV3 | LegacyOperatorExplanation;

export interface OperatorEnrichmentScope {
  scopeId: string;
  parentScopeId?: string;
  name: string;
  kind: "softwareSystem" | "container" | "component" | "code";
  /** Scanner-created, token-scrubbed bounded facts. They are never overwritten. */
  facts: unknown;
  allowedEvidence: readonly OperatorEvidenceRef[];
}

export interface OperatorEnrichmentAttempt {
  attemptId: string;
  scopeId: string;
  role: "owner";
  state: OperatorExplanationState;
  modelId: string;
  createdAt: number;
  updatedAt: number;
  usage?: GatewayUsage;
  /** Hash of the deterministic facts + accepted-child inputs used for this attempt. */
  inputHash: string;
  error?: string;
}

export interface OperatorEnrichmentStore {
  createAttempt(attempt: OperatorEnrichmentAttempt): Promise<void>;
  updateAttempt(attemptId: string, patch: Partial<Pick<OperatorEnrichmentAttempt, "state" | "updatedAt" | "usage" | "error">>): Promise<void>;
  latestAttempt(scopeId: string): Promise<OperatorEnrichmentAttempt | undefined>;
  /**
   * Write an immutable explanation version, then update the draft's current pointer.
   * A frozen publication must retain its selected version id and never dereference
   * this mutable pointer.
   */
  putAcceptedExplanation(scopeId: string, explanation: OperatorExplanation, attemptId: string, inputHash: string): Promise<{ explanationVersionId: string }>;
  getAcceptedExplanation(scopeId: string): Promise<OperatorExplanation | undefined>;
  /** Must persist so a restart cannot silently treat a parent as fresh. */
  markStale(scopeIds: readonly string[]): Promise<void>;
}

export interface OperatorEnrichmentGateway {
  readonly modelId: string;
  chatCompletions(body: Record<string, unknown>): Promise<LlmChatCompletionResult>;
}

export interface OperatorEnrichmentLimits {
  maxDepth: number;
  maxConcurrent: number;
  /** Run-level request cap; admission beyond it stops the run with `stopped = "limit"`. */
  maxScopes: number;
  maxTokens: number;
  maxDollars: number;
}

/** `estimate`: an estimated cost for a call that reported no usage but was likely billed (a response body that dropped mid-read). */
export interface OperatorAdmission { settle(usage?: GatewayUsage, estimate?: { estimatedCostUsd: number }): void | Promise<void>; }

export interface OperatorEnrichmentRunOptions {
  draftRevisionId: string;
  scopes: readonly OperatorEnrichmentScope[];
  store: OperatorEnrichmentStore;
  gateway?: OperatorEnrichmentGateway;
  /** The configured model id when there is no gateway (the runner passes its resolved config's; CLA-606). */
  modelId?: string;
  limits?: Partial<OperatorEnrichmentLimits>;
  now?: () => number;
  nextAttemptId?: () => string;
  cancelled?: () => boolean | Promise<boolean>;
  /** Deepest scope kind attempted in a full run (default "component"; "code" opts symbols in). */
  maxKind?: "component" | "code";
  /**
   * Resolved by the caller (the runner knows the provider): "off" adds
   * `reasoning: { enabled: false }` to leaf requests only (no child inputs; a
   * component with a symbol digest is still a leaf). Parents never get it.
   */
  leafReasoning?: "provider-default" | "off";
  /** Bind to CLA-38's process-wide ledger. Called even for malformed replies. */
  onUsage?: (usage: GatewayUsage) => void | Promise<void>;
  /**
   * Atomic durable/global reservation, called before the attempt row and before
   * network I/O. `false` refuses (scope stays not run, run stops at "limit"); a
   * ticket is settled exactly once after the provider call, success or failure.
   */
  admitRequest?: (request: { modelId: string; role: "owner"; scopeId: string; body: Record<string, unknown>; maxOutputTokens: number }) => OperatorAdmission | boolean | Promise<OperatorAdmission | boolean>;
  /** Retry one selected scope; successful siblings remain untouched. */
  retryScopeId?: string;
  /** Retry several selected scopes in one pass through the same pool (takes precedence over `retryScopeId`). */
  retryScopeIds?: readonly string[];
  /**
   * Batch retry (CLA-258): the unselected ancestors of the selected scopes join the pass and wait on
   * their target children. Such an ancestor re-runs only when one of its children got a new accepted
   * explanation in this pass — its prompt input changed — and none of its in-cap children is still "not run";
   * otherwise it is skipped with no admission, no row and no stale mark. An ancestor with a changed descendant
   * that did not itself get a new accepted explanation (refused, halted, failed, or skipped) is marked stale
   * if it has one.
   * Without this flag a retry marks every accepted ancestor stale up front (the CLA-134 behaviour).
   */
  reReduceAncestors?: boolean;
  /** Explicit parent refresh; normal retry only marks ancestors with an accepted explanation stale. */
  refreshStale?: boolean;
  /**
   * Estimated cost of a call whose response started but whose body dropped (no usage arrives, yet the provider may have
   * billed it), so the dollar cap is not undercounted. Default: this pass's average reported cost per call (CLA-264).
   */
  estimateDroppedCostUsd?: () => number | undefined;
  /** Pause before the one retry of a transport failure (default {@link TRANSPORT_RETRY_DELAY_MS}; tests pass 0). */
  transportRetryDelayMs?: number;
}

export interface OperatorEnrichmentRunResult {
  modelId: string;
  attempts: OperatorEnrichmentAttempt[];
  staleScopes: string[];
  stopped: "complete" | "cancelled" | "limit" | "unavailable";
  /** Unselected ancestors that re-reduce mode skipped because nothing below them changed. */
  skippedScopes?: string[];
}

const DEFAULT_LIMITS: OperatorEnrichmentLimits = { maxDepth: 5, maxConcurrent: 64, maxScopes: 512, maxTokens: 4_000_000, maxDollars: 5 };
const MAX_OUTPUT_TOKENS = 4096;

function usageTotal(usage?: GatewayUsage): number { return usage?.totalTokens ?? 0; }
const addOptional = (left?: number, right?: number) => left === undefined && right === undefined ? undefined : (left ?? 0) + (right ?? 0);
/** Sum of both calls when a scope is retried once inside the same attempt. */
function addUsage(left: GatewayUsage | undefined, right: GatewayUsage | undefined): GatewayUsage | undefined {
  if (!left || !right) return left ?? right;
  const promptTokens = addOptional(left.promptTokens, right.promptTokens); const completionTokens = addOptional(left.completionTokens, right.completionTokens); const costUsd = addOptional(left.costUsd, right.costUsd);
  return { totalTokens: left.totalTokens + right.totalTokens, ...(promptTokens !== undefined ? { promptTokens } : {}), ...(completionTokens !== undefined ? { completionTokens } : {}), ...(costUsd !== undefined ? { costUsd } : {}) };
}
/** The only failures retried once: a request timeout, a dropped connection (transport, CLA-264), or an empty/missing message content. */
function isRetryOnce(error: unknown): boolean { const kind = classifyLlmGatewayFailure(error); return kind === "timeout" || kind === "transport" || (error instanceof Error && /missing message content/.test(error.message)); }
/** Default pause before retrying a transport failure: live drops came in bursts, so an immediate retry would land in the same one. */
export const TRANSPORT_RETRY_DELAY_MS = 1500;
function usageCost(usage?: GatewayUsage): number { return usage?.costUsd ?? 0; }
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isEvidence(value: unknown): value is OperatorEvidenceRef {
  return isObject(value) && (typeof value.entityId === "string" || typeof value.path === "string")
    && (value.startLine === undefined || value.startLine === null || typeof value.startLine === "number") && (value.endLine === undefined || value.endLine === null || typeof value.endLine === "number");
}
/** Canonical fields only: models decorate refs with note/quote/confidence, which are never stored; null line numbers are absent. */
function canonicalRef(ref: OperatorEvidenceRef): OperatorEvidenceRef { return { ...(ref.entityId !== undefined ? { entityId: ref.entityId } : {}), ...(ref.path !== undefined ? { path: ref.path } : {}), ...(typeof ref.startLine === "number" ? { startLine: ref.startLine } : {}), ...(typeof ref.endLine === "number" ? { endLine: ref.endLine } : {}) }; }
function evidenceKey(ref: OperatorEvidenceRef): string { return `${ref.entityId ?? ""}|${ref.path ?? ""}|${ref.startLine ?? ""}|${ref.endLine ?? ""}`; }
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`; if (isObject(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`; return JSON.stringify(value); }
function inputHash(value: unknown): string { return createHash("sha256").update(canonical(value)).digest("hex"); }

/** Contract limits (CLA-260, docs/architecture/operator-enrichment-prompt.md). Over-limit prose rejects; optional extras drop. */
export const OPERATOR_EXPLANATION_LIMITS = {
  summaryChars: 600, summaryBullets: 6, keyPointsMin: 2, keyPointsMax: 5, keyPointChars: 220,
  diagramNodes: 12, diagramLines: 40, diagramChars: 2000,
  tableCaptionChars: 120, tableColumnsMin: 2, tableColumnsMax: 4, tableColumnChars: 40, tableRowsMin: 1, tableRowsMax: 8, tableCellChars: 160,
} as const;
const L = OPERATOR_EXPLANATION_LIMITS;
/**
 * Raw HTML policy for markdown-lite text. The web renders every field as React text nodes, so this
 * is contract honesty rather than the XSS boundary. A false positive fails a whole paid scope,
 * so the rule is narrow:
 * - REJECT anything a browser would treat as active markup: comments; any tag carrying attributes
 *   (`name=value`, or a bare attribute on a known element such as `<dialog open>`; `/` separates
 *   attributes as it does in HTML, so `<svg/onload=…>` counts); and dangerous elements even when
 *   bare or closing (`<ScRiPt>`, `</SCRIPT >`, `<math>`, `<marquee>`, `<noscript>`). Case-insensitive.
 * - KEEP a bare mention of a benign element (`the <summary> field`, `uses <p> elements`): it is
 *   wrapped in backticks so it renders as code, instead of failing the scope.
 * - LEAVE generics and glued text alone (`Vec<Node>`, `Array<a>`, `x<em>y`), and ignore code spans.
 */
const HTML_KNOWN = new Set("a abbr address area article aside audio b base bdi bdo blockquote body br button canvas caption cite code col colgroup data datalist dd del details dfn dialog div dl dt em embed fieldset figcaption figure font footer form frame frameset h1 h2 h3 h4 h5 h6 head header hgroup hr html i iframe img input ins kbd label legend li link main map mark marquee math menu meta meter nav noscript object ol optgroup option output p param picture portal pre progress q rp rt ruby s samp script search section select slot small source span strong style sub summary sup svg table tbody td template textarea tfoot th thead time title tr track u ul var video wbr xmp plaintext applet".split(" "));
/** Elements that execute, load, restyle or re-parse content even with no attributes; other bare mentions (`<button>`, `<img>`) are just words. */
const HTML_DANGEROUS = new Set("script style iframe frame frameset object embed applet svg math noscript marquee template base meta portal xmp plaintext".split(" "));
const TAG = /<!--|<(\/?)([a-z][a-z0-9-]*)((?:[\s/][^<>]*)?)>/gi;
const HAS_VALUE_ATTRIBUTE = /[\s/][a-z_:][-\w:.]*\s*=/i;
/** Classifies text outside code spans: "reject", or the text with bare benign element mentions code-wrapped. */
function screenHtml(text: string): { reject: true } | { reject: false; text: string } {
  let rejected = false;
  const out = text.split(/(`[^`\n]*`)/).map((segment, index) => index % 2 === 1 ? segment : segment.replace(TAG, (match: string, _slash: string | undefined, rawName: string | undefined, attributes: string | undefined, offset: number, whole: string) => {
    if (match === "<!--") { rejected = true; return match; }
    const name = rawName!.toLowerCase(); const attrs = (attributes ?? "").replace(/\//g, " ").trim();
    if (HTML_DANGEROUS.has(name) || HAS_VALUE_ATTRIBUTE.test(` ${attributes ?? ""}`) || (HTML_KNOWN.has(name) && attrs !== "")) { rejected = true; return match; }
    const glued = offset > 0 && /\w/.test(whole[offset - 1]!);
    return HTML_KNOWN.has(name) && !glued ? `\`${match}\`` : match;
  })).join("");
  return rejected ? { reject: true } : { reject: false, text: out };
}
/** True when text (outside inline code spans) contains active HTML that the validator rejects. */
export function containsHtmlTag(text: string): boolean { return screenHtml(text).reject; }
/** Stricter, for Mermaid (whose labels can render HTML): any known element tag at all. */
function mentionsHtml(text: string): boolean { return containsHtmlTag(text) || [...text.matchAll(TAG)].some(match => match[0] === "<!--" || HTML_KNOWN.has(match[2]!.toLowerCase())); }
const collapse = (text: string) => text.replace(/\s+/g, " ").trim();

function validText(raw: string, field: string, maxChars: number): string {
  const screened = screenHtml(raw);
  if (screened.reject) throw new Error(`rejected explanation: raw HTML in ${field}`);
  const value = screened.text;
  if (value.length > maxChars) throw new Error(`rejected explanation: ${field} is ${value.length} characters (limit ${maxChars})`);
  return value;
}
/** Leading list markers the model sometimes adds are removed (the renderer draws its own bullets); newlines collapse. A v4 `{ text, evidence }` item contributes its text. */
function keyPointText(item: unknown): string {
  const text = isObject(item) && typeof item.text === "string" ? item.text : item;
  if (typeof text !== "string") throw new Error("malformed explanation: keyPoints must be strings");
  return collapse(text).replace(/^(?:[-*•]|\d+[.)])\s+/, "");
}

/** CLA-145 claim-mapping caps: optional, dropped (never rejecting) when exceeded. */
export const OPERATOR_CLAIM_LIMITS = { claims: 8, evidencePerClaim: 3, claimChars: 600, minSummaryClaimChars: 12 } as const;
/**
 * A summary claim must be whole sentences of the summary: after whitespace normalisation it starts at
 * the start of the summary or right after a sentence end (`[.!?]` + space), and ends at a sentence end
 * (`[.!?]` followed by a space or the end) or at the end of the summary. A fragment such as "writes rows
 * to disk" out of "never writes rows to disk" would drop the negation, and "It" asserts nothing, so both
 * are rejected. `summary` and `text` must already be collapsed.
 */
export function isSummarySentenceSpan(summary: string, text: string): boolean {
  if (text.length < OPERATOR_CLAIM_LIMITS.minSummaryClaimChars) return false;
  for (let at = summary.indexOf(text); at !== -1; at = summary.indexOf(text, at + 1)) {
    const end = at + text.length;
    const starts = at === 0 || /[.!?] $/.test(summary.slice(Math.max(0, at - 2), at));
    const ends = end === summary.length || (/[.!?]$/.test(text) && summary[end] === " ");
    if (starts && ends) return true;
  }
  return false;
}
/** Stable claim identity: origin, verbatim text and canonical evidence. Prose position is not identity. */
export function operatorClaimId(origin: OperatorExplanationClaim["origin"], text: string, evidence: readonly OperatorEvidenceRef[]): string {
  return `c${inputHash({ origin, text, evidence: evidence.map(ref => ({ entityId: ref.entityId, path: ref.path, startLine: ref.startLine, endLine: ref.endLine })) }).slice(0, 20)}`;
}
/**
 * Maps the model's claim annotations to canonical evidence. Code checks only: a keyPoint claim IS its
 * stored key point; a summary claim must be whole, whitespace-normalised sentence(s) of the stored summary.
 * A claim's `evidence` entries are either ref objects copied from allowedEvidence (the form the prompt
 * teaches), resolved with the same canonical resolution as the reply's `evidence` and required to be
 * among the reply's own evidence, or (compatibility) zero-based indices into the reply's `evidence`
 * array. Anything else is dropped with a note. Compound sentences are never split here.
 */
function mapClaims(value: Record<string, unknown>, keyPointItems: readonly unknown[], keyPoints: readonly string[], summary: string, resolved: readonly (OperatorEvidenceRef | undefined)[], allowedEvidence: readonly OperatorEvidenceRef[]): { claims: OperatorExplanationClaim[]; notes: string[] } {
  const notes: string[] = []; const claims: OperatorExplanationClaim[] = []; const ids = new Set<string>();
  const replyKeys = new Set(resolved.filter((ref): ref is OperatorEvidenceRef => ref !== undefined).map(evidenceKey));
  const refsFor = (raw: unknown, where: string): OperatorEvidenceRef[] | undefined => {
    if (!Array.isArray(raw) || !raw.length) { notes.push(`${where}: no evidence`); return undefined; }
    if (raw.length > OPERATOR_CLAIM_LIMITS.evidencePerClaim) { notes.push(`${where}: more than ${OPERATOR_CLAIM_LIMITS.evidencePerClaim} evidence refs`); return undefined; }
    const refs: OperatorEvidenceRef[] = [];
    for (const entry of raw) {
      let ref: OperatorEvidenceRef | undefined;
      if (typeof entry === "number") {
        ref = Number.isSafeInteger(entry) && entry >= 0 ? resolved[entry] : undefined;
        if (!ref) { notes.push(`${where}: evidence index out of range`); return undefined; }
      } else if (isEvidence(entry)) {
        ref = resolveEvidence(canonicalRef(entry), allowedEvidence);
        if (!ref) { notes.push(`${where}: evidence ref is not in allowedEvidence`); return undefined; }
        if (!replyKeys.has(evidenceKey(ref))) { notes.push(`${where}: evidence ref is not in the reply's evidence`); return undefined; }
      } else { notes.push(`${where}: evidence entries must be refs from allowedEvidence`); return undefined; }
      if (!refs.some(item => evidenceKey(item) === evidenceKey(ref))) refs.push(ref);
    }
    return refs;
  };
  const add = (origin: OperatorExplanationClaim["origin"], index: number, text: string, evidence: OperatorEvidenceRef[], where: string) => {
    if (claims.length >= OPERATOR_CLAIM_LIMITS.claims) { notes.push(`${where}: over ${OPERATOR_CLAIM_LIMITS.claims} claims`); return; }
    const id = operatorClaimId(origin, text, evidence);
    if (ids.has(id)) return;
    ids.add(id); claims.push({ id, text, origin, index, evidence });
  };
  const normalizedSummary = collapse(summary);
  if (Array.isArray(value.summaryClaims)) value.summaryClaims.forEach((item, index) => {
    const where = `summaryClaims[${index}]`;
    if (!isObject(item) || typeof item.text !== "string" || !collapse(item.text)) { notes.push(`${where}: text is required`); return; }
    const text = collapse(item.text);
    if (text.length > OPERATOR_CLAIM_LIMITS.claimChars) { notes.push(`${where}: over ${OPERATOR_CLAIM_LIMITS.claimChars} characters`); return; }
    if (!isSummarySentenceSpan(normalizedSummary, text)) { notes.push(`${where}: not whole verbatim sentence(s) of the summary`); return; }
    const evidence = refsFor(item.evidence, where); if (evidence) add("summary", index, text, evidence, where);
  });
  else if (value.summaryClaims !== undefined && value.summaryClaims !== null) notes.push("summaryClaims: not a list");
  // Key point positions after empty items were filtered out, matching the stored keyPoints.
  let position = 0;
  keyPointItems.forEach((item, raw) => {
    if (keyPointText(item) === "") return;
    const index = position++;
    if (!isObject(item) || item.evidence === undefined || item.evidence === null) return;
    const where = `keyPoints[${raw}]`;
    const evidence = refsFor(item.evidence, where); if (evidence) add("keyPoint", index, keyPoints[index]!, evidence, where);
  });
  return { claims, notes };
}

const ENTITY_ID_LIKE = /\b(?:system|container|component|code|external|softwareSystem|externalSystem|relation):[\w./-]+/;
/** Statements are split on newlines and `;`, so `a-->b; style a …` is caught like a line-start `style`. */
const MERMAID_FORBIDDEN: Array<[RegExp, string]> = [
  [/%%/, "comments or %%{ directives"], [/@\{/, "shape data (@{ … })"],
  [/(?:^|;)\s*click\b/im, "click"], [/(?:^|;)\s*style\b/im, "style"], [/(?:^|;)\s*classDef\b/im, "classDef"], [/(?:^|;)\s*class\b/im, "class"], [/:::/, "class shorthand"], [/(?:^|;)\s*linkStyle\b/im, "linkStyle"],
  [/javascript\s*:/i, "javascript: URL"], [/\b(?:https?|ftp|file|data)\s*:|\/\//i, "a URL"],
];
/**
 * Server-side Mermaid gate: flowchart LR/TB only (TD, its synonym, becomes TB; one ```mermaid fence
 * is unwrapped), no directives/interaction/styling/URLs/HTML, human-readable labels and bounded size.
 * Returns the cleaned source or the reason it was dropped.
 */
export function checkMermaidDiagram(value: unknown, entityIds: ReadonlySet<string> = new Set()): { diagram: string } | { error: string } {
  if (typeof value !== "string") return { error: "rejected diagram: not Mermaid source text" };
  let source = value.replace(/\r\n?/g, "\n").trim();
  const fenced = /^```(?:mermaid)?\s*\n([\s\S]*?)\n```$/.exec(source); if (fenced) source = fenced[1]!.trim();
  const lines = source.split("\n").map(line => line.replace(/\s+$/, "")).filter(line => line.trim() !== "");
  const header = /^flowchart\s+(LR|TB|TD)\s*;?$/.exec(lines[0]?.trim() ?? "");
  if (!header) return { error: "rejected diagram: must start with flowchart LR or flowchart TB" };
  lines[0] = `flowchart ${header[1] === "LR" ? "LR" : "TB"}`; source = lines.join("\n");
  if (source.length > L.diagramChars) return { error: `rejected diagram: ${source.length} characters (limit ${L.diagramChars})` };
  if (lines.length > L.diagramLines) return { error: `rejected diagram: ${lines.length} lines (limit ${L.diagramLines})` };
  for (const [pattern, name] of MERMAID_FORBIDDEN) if (pattern.test(source)) return { error: `rejected diagram: ${name} is not allowed` };
  if (lines.slice(1).some(line => /(?:^|;)\s*(?:flowchart|graph)\b/i.test(line))) return { error: "rejected diagram: only one flowchart header is allowed" };
  if (mentionsHtml(source)) return { error: "rejected diagram: raw HTML is not allowed" };
  if (ENTITY_ID_LIKE.test(source) || [...entityIds].some(id => source.includes(id))) return { error: "rejected diagram: labels must be human-readable, not entity ids" };
  const nodes = new Set<string>();
  for (const line of lines.slice(1)) {
    const statement = line.trim();
    if (/^(?:subgraph|end|direction)\b/.test(statement)) continue;
    // Labels, edge texts and shapes go first; what is left between edge operators are node ids.
    const bare = statement.replace(/"[^"]*"/g, "").replace(/\|[^|]*\|/g, " ").replace(/\[[^\]]*\]|\([^)]*\)|\{[^}]*\}/g, " ").replace(/--[^->]*?-->/g, " ").replace(/<?[-=.]{2,}>?/g, " ").replace(/[&;]/g, " ");
    for (const match of bare.matchAll(/[A-Za-z_][\w-]*/g)) nodes.add(match[0]);
  }
  if (nodes.size > L.diagramNodes) return { error: `rejected diagram: ${nodes.size} nodes (limit ${L.diagramNodes})` };
  return { diagram: source };
}

/** Optional small table: dropped (with a reason) rather than failing the scope. */
export function checkExplanationTable(value: unknown): { table: OperatorExplanationTable } | { error: string } {
  const fail = (why: string) => ({ error: `rejected table: ${why}` });
  if (!isObject(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows)) return fail("needs columns and rows");
  const caption = value.caption === undefined || value.caption === null ? undefined : typeof value.caption === "string" ? collapse(value.caption) : null;
  if (caption === null) return fail("caption must be text");
  if (caption && caption.length > L.tableCaptionChars) return fail(`caption over ${L.tableCaptionChars} characters`);
  const columns = value.columns.map(cell => typeof cell === "string" ? collapse(cell) : null);
  if (columns.length < L.tableColumnsMin || columns.length > L.tableColumnsMax) return fail(`${columns.length} columns (allowed ${L.tableColumnsMin}-${L.tableColumnsMax})`);
  if (columns.some(cell => cell === null || !cell || cell.length > L.tableColumnChars)) return fail(`column headings must be non-empty text of at most ${L.tableColumnChars} characters`);
  if (value.rows.length < L.tableRowsMin || value.rows.length > L.tableRowsMax) return fail(`${value.rows.length} rows (allowed ${L.tableRowsMin}-${L.tableRowsMax})`);
  const rows: string[][] = [];
  for (const row of value.rows) {
    if (!Array.isArray(row) || row.length !== columns.length) return fail("every row needs one cell per column");
    const cells = row.map(cell => typeof cell === "string" ? collapse(cell) : typeof cell === "number" ? String(cell) : null);
    if (cells.some(cell => cell === null || cell.length > L.tableCellChars)) return fail(`cells must be text of at most ${L.tableCellChars} characters`);
    rows.push(cells as string[]);
  }
  if ([caption ?? "", ...(columns as string[]), ...rows.flat()].some(containsHtmlTag)) return fail("raw HTML is not allowed");
  const clean = (text: string) => (screenHtml(text) as { text: string }).text;
  return { table: { ...(caption ? { caption: clean(caption) } : {}), columns: (columns as string[]).map(clean), rows: rows.map(row => row.map(clean)) } };
}

/** `-` and `_` compare equal in paths: the only rewrite models were seen to make (`flow_story.ts` for `flow-story.ts`). */
const foldPath = (path: string) => path.replace(/_/g, "-");
/**
 * Resolves one cited ref against the scope's allowed evidence (CLA-264). The entityId is the identity: a ref whose entityId
 * is allowed, whose lines are absent or equal to that allowed ref's, and whose path is absent or equal to it up to `-`/`_`
 * resolves to the ALLOWED ref, so the stored path is always the scanner's. An entity with several refs is disambiguated by
 * lines, then by exact path. Unknown entityIds, different lines, any other path, or an ambiguous match resolve to nothing
 * (rejected); a ref without an entityId must match an allowed ref exactly, as before.
 */
function resolveEvidence(ref: OperatorEvidenceRef, allowedEvidence: readonly OperatorEvidenceRef[]): OperatorEvidenceRef | undefined {
  const exact = allowedEvidence.find(item => evidenceKey(item) === evidenceKey(ref));
  if (exact || ref.entityId === undefined) return exact;
  const fits = (item: OperatorEvidenceRef) => (ref.startLine === undefined || ref.startLine === item.startLine) && (ref.endLine === undefined || ref.endLine === item.endLine) && (ref.path === undefined || (typeof ref.path === "string" && item.path !== undefined && foldPath(ref.path) === foldPath(item.path)));
  const candidates = allowedEvidence.filter(item => item.entityId === ref.entityId && fits(item));
  if (candidates.length <= 1) return candidates[0];
  for (const narrowed of [candidates.filter(item => item.startLine === ref.startLine && item.endLine === ref.endLine), candidates.filter(item => item.path === ref.path)]) if (narrowed.length === 1) return narrowed[0];
  return undefined;
}
/** `entityId path:start-end` for a rejection message; model-supplied parts are shown only when identifier-shaped (never free text). */
function describeEvidence(ref: OperatorEvidenceRef): string {
  const safe = (text: string | undefined) => text === undefined ? undefined : /^[\w.:/+-]{1,160}$/.test(text) ? text : "(invalid)";
  const lines = ref.startLine !== undefined || ref.endLine !== undefined ? `:${ref.startLine ?? "?"}-${ref.endLine ?? "?"}` : "";
  return scrubProviderIdentifiers([safe(ref.entityId) ?? "(no entity)", `${safe(ref.path) ?? "(no path)"}${lines}`].join(" "));
}
/**
 * Backticked spans that are exactly a path spelling this reply cited as evidence and that resolved to a different allowed
 * path (a corrected `-`/`_` spelling) become the allowed path (CLA-264). Any other mention, including a real file whose
 * name differs only by `-`/`_`, is left as written.
 */
function canonicalPathSpans(text: string, corrections: ReadonlyMap<string, string>): string {
  if (!corrections.size) return text;
  return text.replace(/`([^`\n]+)`/g, (span, token: string) => { const path = corrections.get(token); return path ? `\`${path}\`` : span; });
}

/**
 * Strictly accepts v3 explanation-shaped output; it cannot alter scanner facts. Required prose
 * (summary, keyPoints) over the contract limits or containing raw HTML rejects the attempt, so
 * it is reported as a failed scope and can be retried. An invalid optional diagram or table is
 * dropped with a `diagramError` note instead. Evidence must name `allowedEvidence` (see resolveEvidence); the
 * stored refs are always the allowed copies.
 * `null` optionals are absent (a live MiMo habit); v2-only fields (interactions, roleWithinParent)
 * are ignored, never stored.
 */
export function validateOperatorExplanation(value: unknown, allowedEvidence: readonly OperatorEvidenceRef[]): OperatorExplanationV3 {
  if (!isObject(value) || typeof value.summary !== "string" || !value.summary.trim()) throw new Error("malformed explanation: summary is required");
  const summary = validText(value.summary.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim(), "summary", L.summaryChars);
  if (summary.split("\n").filter(line => /^\s*[-*]\s+/.test(line)).length > L.summaryBullets) throw new Error(`rejected explanation: summary has more than ${L.summaryBullets} bullets`);
  if (!Array.isArray(value.keyPoints)) throw new Error("malformed explanation: keyPoints is required");
  const keyPoints = value.keyPoints.map(keyPointText).filter(item => item !== "").map((item, index) => validText(item, `keyPoints[${index}]`, L.keyPointChars));
  if (keyPoints.length < L.keyPointsMin || keyPoints.length > L.keyPointsMax) throw new Error(`rejected explanation: ${keyPoints.length} keyPoints (allowed ${L.keyPointsMin}-${L.keyPointsMax})`);
  if (!Array.isArray(value.evidence) || !value.evidence.length || !value.evidence.every(isEvidence)) throw new Error("malformed explanation: evidence is required");
  // Canonical fields only: models decorate refs with note/quote/confidence, which must not be stored as evidence; null line numbers (a MiMo habit) are absent.
  const cited = (value.evidence as OperatorEvidenceRef[]).map(canonicalRef);
  const resolved = cited.map(ref => resolveEvidence(ref, allowedEvidence));
  const unknown = cited.filter((_ref, index) => resolved[index] === undefined);
  if (unknown.length) throw new Error(`rejected explanation: unknown evidence reference(s): ${unknown.slice(0, 3).map(describeEvidence).join(", ")}${unknown.length > 3 ? ` (+${unknown.length - 3} more)` : ""}`);
  const seen = new Set<string>(); const evidence = (resolved as OperatorEvidenceRef[]).filter(ref => { const key = evidenceKey(ref); if (seen.has(key)) return false; seen.add(key); return true; });
  const dropped: string[] = []; let diagram: string | undefined; let table: OperatorExplanationTable | undefined;
  if (value.diagram !== undefined && value.diagram !== null && value.diagram !== "") {
    const checked = checkMermaidDiagram(value.diagram, new Set(allowedEvidence.map(ref => ref.entityId).filter((id): id is string => id !== undefined)));
    if ("diagram" in checked) diagram = checked.diagram; else dropped.push(checked.error);
  }
  if (value.table !== undefined && value.table !== null) {
    const checked = checkExplanationTable(value.table);
    if ("table" in checked) table = checked.table; else dropped.push(checked.error);
  }
  const corrections = new Map<string, string>(); cited.forEach((ref, index) => { const path = resolved[index]!.path; if (typeof ref.path === "string" && path !== undefined && ref.path !== path) corrections.set(ref.path, path); });
  const finalSummary = canonicalPathSpans(summary, corrections); const finalKeyPoints = keyPoints.map(item => canonicalPathSpans(item, corrections));
  const summaryClaims = Array.isArray(value.summaryClaims) ? value.summaryClaims.map(item => isObject(item) && typeof item.text === "string" ? { ...item, text: canonicalPathSpans(item.text, corrections) } : item) : value.summaryClaims;
  const mapped = mapClaims({ ...value, summaryClaims }, value.keyPoints as unknown[], finalKeyPoints, finalSummary, resolved, allowedEvidence);
  const claimsNote = mapped.notes.length ? scrubProviderIdentifiers(`dropped claim mapping: ${mapped.notes.slice(0, 4).join("; ")}${mapped.notes.length > 4 ? ` (+${mapped.notes.length - 4} more)` : ""}`) : undefined;
  return { format: "v3", summary: finalSummary, keyPoints: finalKeyPoints, ...(diagram ? { diagram } : {}), ...(table ? { table } : {}), evidence, ...(dropped.length ? { diagramError: dropped.join("; ") } : {}), ...(mapped.claims.length ? { claims: mapped.claims } : {}), ...(claimsNote ? { claimsNote } : {}) };
}

/**
 * A sidecar explanation row as judgments and section profiles embed it (both within the inherited
 * 24 KB judgment body limit). A v3 row leaves out its optional diagram and table: they can add
 * ~9 KB at the contract caps, and a judgment needs the claims (summary, key points, evidence),
 * not presentation. Legacy rows pass unchanged, so their cached judgment input hashes stay valid.
 */
export function explanationRowForJudgment(row: unknown): unknown {
  if (!isObject(row) || !isObject(row.content) || row.content.format !== "v3") return row;
  // Claim mappings duplicate prose already in summary/keyPoints; rows without them hash exactly as before.
  const { diagram: _diagram, table: _table, claims: _claims, claimsNote: _claimsNote, ...content } = row.content;
  return { ...row, content };
}

function completionText(result: LlmChatCompletionResult): unknown { return parseChatCompletionDocument(result.json); }
/**
 * v4 (CLA-145) asks the model to map bounded claims to its own evidence entries. Stored content
 * keeps `format: "v3"` (renderers are unchanged); the version bump invalidates v3 input hashes
 * because the prompt changed.
 */
export const OPERATOR_PROMPT_VERSION = "operator-enrichment/v4";
const PROMPT_VERSION = OPERATOR_PROMPT_VERSION;
/**
 * v3 voice (CLA-260): the owner of this area briefing a new teammate. The output shape and the
 * limits are spelled out verbatim (live probes showed invented shapes and refs without it). Lengths
 * are asked for in words and well under the validator's character limits: in the CLA-260 variant
 * experiment MiMo overshot character-only limits in 5 of 15 replies. The worked example is about an
 * unrelated service so its facts cannot leak into a real explanation.
 */
export const OPERATOR_OUTPUT_SCHEMA_PROMPT = [
  "You own this part of the codebase. A new teammate is about to open it for the first time: write the short note you would give them. Plain, short sentences. Say what it is and why it matters first. No filler, no marketing, no hedging.",
  "Use only the supplied deterministic facts and evidence; do not guess beyond them. Never mention enrichment or documentation status, failures or coverage; describe the code only. Never list or restate dependencies, dependents, imports or relationships (the atlas already draws those edges). Name specific files, symbols and behaviours instead of generic descriptions.",
  "Return one JSON object only, exactly this shape (omit an optional field rather than returning null):",
  "{\"summary\": string (2-3 short sentences, at most 60 words: what it is and why it matters),",
  " \"keyPoints\": (string | {\"text\": string, \"evidence\": EvidenceRef[]})[] (2-4 items, each ONE idea in at most 20 words; each points at something worth looking into: a file or symbol to open first, a gotcha, or a design decision and why; never a dependency list),",
  " \"evidence\": [{\"entityId\": string, \"path\": string, \"startLine\"?: number, \"endLine\"?: number}] (copy entries verbatim from allowedEvidence; no other fields; at least one),",
  " \"summaryClaims\"?: [{\"text\": string, \"evidence\": EvidenceRef[]}] (at most 4),",
  " \"diagram\"?: string (Mermaid source, only when a picture explains a flow better than words; most scopes omit it),",
  " \"table\"?: {\"caption\"?: string, \"columns\": string[] (2-4 short headings), \"rows\": string[][] (1-8 rows, one cell per column)} (only when a side-by-side comparison genuinely helps; usually omit)}",
  "Claim mapping: write a key point as {\"text\", \"evidence\"} when specific evidence entries show it. A claim's \"evidence\" lists 1-3 EvidenceRef objects, each copied verbatim from allowedEvidence (the same {\"entityId\", \"path\", \"startLine\"?, \"endLine\"?} object) and also listed in your top-level evidence array; never numbers. summaryClaims marks whole sentences of the summary the same way; each text is copied verbatim from the summary. One claim = one assertion, copied verbatim: never split, shorten or reword it to fit evidence, and leave a statement unmapped rather than cite an entry that does not show it.",
  "Claim mapping example (unrelated service): {\"text\": \"Start with `handleEvent()` in `webhooks/stripe.ts`; every event type fans out from its switch.\", \"evidence\": [{\"entityId\": \"code:webhooks-stripe-ts:handle-event\", \"path\": \"webhooks/stripe.ts\", \"startLine\": 12, \"endLine\": 58}]}",
  "Text uses inline markdown only: **bold** for one or two key terms, `code` for paths and symbols, *italics* sparingly. No headings, links, images, HTML or code blocks.",
  "Diagram rules: first line `flowchart LR` or `flowchart TB`; at most 10 nodes; short human-readable labels in quotes, e.g. scan[\"Repository scan\"] --> model[\"C4 model\"]; never raw entity ids such as component:foo; no style, classDef, class, linkStyle, click or %% lines.",
  "Example of the tone wanted (about an unrelated billing service, not this scope):",
  "{\"summary\": \"**Webhook intake** turns Stripe events into ledger entries. It is the only place money state changes, so it is small and very defensive.\", \"keyPoints\": [\"Start with `handleEvent()` in `webhooks/stripe.ts`; every event type fans out from its switch.\", \"Gotcha: events can arrive twice. `seen_events` makes replays a no-op, so never bypass it.\", \"Amounts stay in integer cents end to end; formatting happens only in the UI.\"], \"evidence\": [...]}",
].join("\n");
const PARENT_PROMPT = "\nThis scope has children; children[] carries each child's name, kind, summary (and keyPoints when present); refer to children by name, never by scopeId. Explain how the pieces fit together: what this scope does as a whole, which child to read first, and where the interesting seams and hand-offs are. Do not walk through the children one by one.";
/** System message for one scope: the v3 schema prompt, plus the synthesis instruction for a parent. */
export function operatorSystemPrompt(isParent: boolean): string { return OPERATOR_OUTPUT_SCHEMA_PROMPT + (isParent ? PARENT_PROMPT : ""); }
/** JSON-character budget for a component's below-cap symbol digest. */
export const SYMBOL_DIGEST_BUDGET = 6000;
/** Per-line cap on digest heads, so one minified line cannot consume the budget. */
export const DIGEST_LINE_CHARS = 160;
/** One child as its parent sees it: the human name and C4 kind let the parent name it the way the code does, not by scope id. */
export interface OperatorChildInput { scopeId: string; name?: string; kind?: OperatorEnrichmentScope["kind"]; explanation?: OperatorExplanation; state: OperatorChildState; }
/**
 * Parents cannot cite child evidence or reuse child diagrams/tables, so only the prose travels up
 * (live probe: evidence+diagram were ~61% of a 354KB container prompt). v3 children carry
 * name, kind, summary + keyPoints; a legacy (v1/v2) child carries its summary only.
 * Enrichment state never reaches the prompt: a child without an explanation (failed, not run) is
 * left out and no `state` is sent, because a parent that reads "failed" writes it into its prose
 * and that line goes stale on the next retry (CLA-260 live run). The input hash still covers every
 * child with its state, so stale and re-reduce behaviour is unchanged.
 */
export function childPromptInput(child: OperatorChildInput): Record<string, unknown> | undefined {
  const explanation = child.explanation;
  if (!explanation) return undefined;
  return { scopeId: child.scopeId, ...(child.name ? { name: child.name } : {}), ...(child.kind ? { kind: child.kind } : {}), summary: explanation.summary, ...(explanation.format === "v3" ? { keyPoints: explanation.keyPoints } : {}) };
}
/** The exact chat-completions body the operator sends for one scope (exported for prompt experiments and tests). */
export function operatorRequestBody(model: string, scope: OperatorEnrichmentScope, children: readonly OperatorChildInput[], reasoningOff = false): Record<string, unknown> {
  const promptChildren = children.map(childPromptInput).filter((child): child is Record<string, unknown> => child !== undefined);
  return { model, max_tokens: MAX_OUTPUT_TOKENS, ...(reasoningOff ? { reasoning: { enabled: false } } : {}), messages: [{ role: "system", content: operatorSystemPrompt(promptChildren.length > 0) }, { role: "user", content: scrubGithubTokens(JSON.stringify({ promptVersion: PROMPT_VERSION, scope: { scopeId: scope.scopeId, name: scope.name, kind: scope.kind, facts: scope.facts, allowedEvidence: scope.allowedEvidence }, children: promptChildren })) }], response_format: { type: "json_object" } };
}
function firstExcerpt(facts: unknown): { sourceStartLine?: unknown; sourceEndLine?: unknown; startLine?: unknown; endLine?: unknown; text?: unknown; lines?: unknown } | undefined {
  const excerpts = isObject(facts) ? facts.sourceExcerpts : undefined;
  return Array.isArray(excerpts) && isObject(excerpts[0]) ? excerpts[0] : undefined;
}
/**
 * Deterministic digest of a scope's below-cap (code) children: sorted by first
 * source line then scopeId, cut at {@link SYMBOL_DIGEST_BUDGET} JSON chars.
 * Included children's refs become allowed evidence for the parent.
 */
export function symbolDigest(symbols: readonly OperatorEnrichmentScope[]): { symbols: Array<{ name: string; exported: boolean; lines?: string; head?: string }>; symbolCount: number; evidence: OperatorEvidenceRef[] } {
  const line = (scope: OperatorEnrichmentScope) => scope.allowedEvidence[0]?.startLine ?? Number.MAX_SAFE_INTEGER;
  const ordered = [...symbols].sort((left, right) => line(left) - line(right) || (left.scopeId < right.scopeId ? -1 : left.scopeId > right.scopeId ? 1 : 0));
  const digest: Array<{ name: string; exported: boolean; lines?: string; head?: string }> = []; const evidence: OperatorEvidenceRef[] = []; let used = 2;
  for (const symbol of ordered) {
    const excerpt = firstExcerpt(symbol.facts); const exposure = isObject(symbol.facts) && Array.isArray(symbol.facts.exposure) ? symbol.facts.exposure : [];
    const start = typeof excerpt?.sourceStartLine === "number" ? excerpt.sourceStartLine : excerpt?.startLine; const end = typeof excerpt?.sourceEndLine === "number" ? excerpt.sourceEndLine : excerpt?.endLine;
    const text = typeof excerpt?.text === "string" ? excerpt.text : Array.isArray(excerpt?.lines) ? excerpt.lines.filter(item => typeof item === "string").join("\n") : undefined;
    const entry = { name: symbol.name, exported: exposure.some(item => isObject(item) && item.kind === "moduleExport"), ...(typeof start === "number" && typeof end === "number" ? { lines: `${start}-${end}` } : {}), ...(text !== undefined ? { head: text.split("\n").slice(0, 4).map(value => value.length > DIGEST_LINE_CHARS ? `${value.slice(0, DIGEST_LINE_CHARS)}…` : value).join("\n") } : {}) };
    const size = JSON.stringify(entry).length + 1;
    if (used + size > SYMBOL_DIGEST_BUDGET) continue; // one oversized entry must not starve the smaller symbols after it
    used += size; digest.push(entry); evidence.push(...symbol.allowedEvidence.map(ref => ({ ...ref, entityId: symbol.scopeId })));
  }
  return { symbols: digest, symbolCount: symbols.length, evidence };
}
/** The scope as its prompt sees it: a scope with below-cap (code) children carries their symbol digest and evidence. */
export function preparedOperatorScope(definition: OperatorEnrichmentScope, belowCapChildren: readonly OperatorEnrichmentScope[]): OperatorEnrichmentScope {
  const digest = belowCapChildren.length ? symbolDigest(belowCapChildren) : undefined;
  return digest ? { ...definition, facts: { ...(isObject(definition.facts) ? definition.facts : { observed: definition.facts }), symbols: digest.symbols, symbolCount: digest.symbolCount }, allowedEvidence: [...definition.allowedEvidence, ...digest.evidence] } : definition;
}
/**
 * One attempt's input hash: prompt version, model, leaf reasoning, the prepared scope's facts and allowed evidence, and every
 * in-cap child with its state and explanation. Exported so an incremental run can cross-check a reused explanation (CLA-271).
 */
export function operatorInputHash(input: { modelId: string; reasoning: "off" | "provider-default"; scope: OperatorEnrichmentScope; children: readonly OperatorChildInput[] }): string {
  return inputHash({ promptVersion: PROMPT_VERSION, modelId: input.modelId, reasoning: input.reasoning, facts: input.scope.facts, allowedEvidence: input.scope.allowedEvidence, children: input.children.map(child => ({ scopeId: child.scopeId, name: child.name, kind: child.kind, state: child.state, explanation: child.explanation })) });
}
/**
 * Fan out, then reduce (CLA-254). Every in-cap leaf is queued at once; a parent
 * is queued only when all of its in-cap children have settled (accepted or
 * failed), so a container can run while unrelated subtrees are still in flight.
 * Whenever several scopes are ready, parents dispatch before leaves, then by
 * scopeId, so upper levels complete as early as possible. Completion order
 * still depends on provider latency. Component prompts carry a bounded,
 * deterministic digest of their below-cap code symbols (see symbolDigest).
 *
 * Incomplete-parent policy: "not run". A failed child counts as settled and is
 * passed to its parent with state "failed" and no explanation. A child that was
 * never run (budget stop, cancellation) leaves its parent not run as well.
 * Budget admission happens before an attempt row exists: a refused admission
 * records nothing, sets `stopped = "limit"`, and admits no further scopes while
 * in-flight scopes finish and are stored. Scopes below `maxKind` are never
 * attempted; an explicit retry target bypasses that depth cap.
 *
 * Retry-once: a request timeout, a transport failure (after a short delay) or an
 * empty/missing message content gets exactly one more request inside the same attempt row (usage summed). The retry is
 * admitted like any request (run cap + admitRequest, after the first ticket is
 * settled); if refused, the attempt fails with the original error and the run
 * stops at "limit". Nothing else is retried here (429s live in the limiter).
 */
export async function runOperatorEnrichment(options: OperatorEnrichmentRunOptions): Promise<OperatorEnrichmentRunResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const now = options.now ?? Date.now;
  const modelId = options.gateway?.modelId ?? options.modelId ?? resolveLlmModelId();
  const maxKind = options.maxKind ?? "component";
  const inCap = (scope: OperatorEnrichmentScope): boolean => maxKind === "code" || scope.kind !== "code";
  const byId = new Map(options.scopes.map(scope => [scope.scopeId, scope]));
  if (byId.size !== options.scopes.length) throw new Error("duplicate enrichment scope");
  const children = new Map<string, string[]>();
  for (const scope of options.scopes) if (scope.parentScopeId) {
    if (!byId.has(scope.parentScopeId) || scope.parentScopeId === scope.scopeId) throw new Error("invalid enrichment containment");
    const list = children.get(scope.parentScopeId) ?? []; list.push(scope.scopeId); children.set(scope.parentScopeId, list);
  }
  for (const list of children.values()) list.sort();
  const ancestors = (scopeId: string): string[] => { const result: string[] = []; let cursor = byId.get(scopeId)?.parentScopeId; const seen = new Set<string>(); while (cursor) { if (seen.has(cursor)) throw new Error("enrichment containment cycle"); seen.add(cursor); result.push(cursor); cursor = byId.get(cursor)?.parentScopeId; } return result; };
  for (const scope of options.scopes) if (ancestors(scope.scopeId).length > limits.maxDepth) throw new Error("enrichment depth limit exceeded");
  const retryIds = options.retryScopeIds ? [...new Set(options.retryScopeIds)] : options.retryScopeId ? [options.retryScopeId] : undefined;
  if (retryIds && !retryIds.length) throw new Error("empty retry selection");
  if (retryIds?.some(scopeId => !byId.has(scopeId))) throw new Error("unknown retry scope");
  const selected = new Set(retryIds ?? []);
  const reReduce = Boolean(retryIds && options.reReduceAncestors);
  /** Unselected ancestors of the selection, nearest first per selected scope. */
  const selectionAncestors = [...new Set((retryIds ?? []).flatMap(ancestors))].filter(scopeId => !selected.has(scopeId));
  const target = retryIds ? new Set([...retryIds, ...(options.refreshStale || reReduce ? selectionAncestors : [])]) : new Set(options.scopes.filter(inCap).map(scope => scope.scopeId));
  // Nothing can run without a gateway: every scope stays "not run" and no row or stale mark is written.
  if (!options.gateway) return { modelId, attempts: [], staleScopes: [], stopped: "unavailable" };
  const gateway = options.gateway;
  // Only an ancestor with a pinned explanation can go stale; a not-run ancestor stays not run.
  const staleScopes = retryIds && !reReduce ? (await Promise.all(selectionAncestors.map(async scopeId => (await options.store.getAcceptedExplanation(scopeId)) ? scopeId : undefined))).filter((scopeId): scopeId is string => scopeId !== undefined) : [];
  if (staleScopes.length) await options.store.markStale(staleScopes);
  /** Re-reduce mode: `dirty` = a child got a new accepted explanation (input changed); `changedBelow` = any descendant did. */
  const dirty = new Set<string>(); const changedBelow = new Set<string>(); const acceptedNow = new Set<string>(); const skippedScopes: string[] = [];
  const attempts: OperatorEnrichmentAttempt[] = []; let tokens = 0; let dollars = 0; let costCalls = 0; let requests = 0; let stopped: OperatorEnrichmentRunResult["stopped"] = "complete";
  let halted = false;
  const halt = (reason: "cancelled" | "limit") => { if (stopped !== "cancelled") stopped = reason; halted = true; };
  const finish = async (attempt: OperatorEnrichmentAttempt, patch: Partial<Pick<OperatorEnrichmentAttempt, "state" | "updatedAt" | "usage" | "error">>) => { await options.store.updateAttempt(attempt.attemptId, patch); Object.assign(attempt, patch); };
  const errorText = (error: unknown) => scrubProviderIdentifiers(error instanceof Error ? error.message : String(error));
  /** "settled" = accepted or failed; "skipped" = re-reduce found nothing to do (parents may proceed); "unrun" = not run. */
  const execute = async (definition: OperatorEnrichmentScope): Promise<"settled" | "skipped" | "unrun"> => {
    if (halted) return "unrun";
    const reReduceOnly = reReduce && !selected.has(definition.scopeId);
    if (reReduceOnly && !dirty.has(definition.scopeId)) { skippedScopes.push(definition.scopeId); return "skipped"; }
    if (await options.cancelled?.()) { halt("cancelled"); return "unrun"; }
    // Below-cap children are omitted unless they already carry a known state (retry of a code-level scope's parent).
    const scope = preparedOperatorScope(definition, (children.get(definition.scopeId) ?? []).map(scopeId => byId.get(scopeId)!).filter(child => !inCap(child)));
    const childInputs = (await Promise.all((children.get(scope.scopeId) ?? []).map(async scopeId => { const latest = await options.store.latestAttempt(scopeId); const explanation = await options.store.getAcceptedExplanation(scopeId); if (!latest && !explanation && !inCap(byId.get(scopeId)!)) return undefined; const state: OperatorChildState = latest?.state ?? (explanation ? "accepted" : "not run"); const child = byId.get(scopeId)!; return { scopeId, name: child.name, kind: child.kind, state, ...(explanation ? { explanation } : {}) }; }))).filter((input): input is NonNullable<typeof input> => input !== undefined);
    // Incomplete-parent policy also holds for a re-reduce: a parent with a not-run child is not re-run.
    if (reReduceOnly && childInputs.some(input => input.state === "not run")) { skippedScopes.push(definition.scopeId); return "skipped"; }
    const reasoning = options.leafReasoning === "off" && childInputs.length === 0 ? "off" : "provider-default";
    const hash = operatorInputHash({ modelId, reasoning, scope, children: childInputs });
    const body = operatorRequestBody(modelId, scope, childInputs, reasoning === "off");
    // Admission before the attempt row: the run-level check and increment are synchronous so concurrent scopes cannot over-admit.
    // Admission errors propagate (the runner records a run error); only an explicit refusal is a limit stop.
    const admit = async (): Promise<OperatorAdmission | boolean> => {
      if (requests >= limits.maxScopes || tokens >= limits.maxTokens || dollars >= limits.maxDollars) return false;
      requests += 1;
      const granted = await (options.admitRequest?.({ modelId, role: "owner", scopeId: scope.scopeId, body, maxOutputTokens: MAX_OUTPUT_TOKENS }) ?? true);
      if (!granted) requests -= 1;
      return granted;
    };
    const first = await admit();
    if (!first) { halt("limit"); return "unrun"; }
    let current: OperatorAdmission | boolean | undefined = first; let usage: GatewayUsage | undefined;
    const settleCurrent = async (callUsage?: GatewayUsage, estimate?: { estimatedCostUsd: number }) => { const ticket = current; current = undefined; if (ticket && typeof ticket === "object") await ticket.settle(callUsage, estimate); };
    /** A transport failure after the response started (status set): settle with an estimated cost, never as free. */
    const droppedEstimate = (error: unknown): { estimatedCostUsd: number } | undefined => {
      if (!(error instanceof LlmGatewayError) || error.kind !== "transport" || error.status === undefined) return undefined;
      const estimate = options.estimateDroppedCostUsd ? options.estimateDroppedCostUsd() : costCalls ? dollars / costCalls : undefined;
      return estimate !== undefined && Number.isFinite(estimate) && estimate > 0 ? { estimatedCostUsd: estimate } : undefined;
    };
    const attempt: OperatorEnrichmentAttempt = { attemptId: options.nextAttemptId?.() ?? randomUUID(), scopeId: scope.scopeId, role: "owner", state: "running", modelId, inputHash: hash, createdAt: now(), updatedAt: now() };
    try { await options.store.createAttempt(attempt); } catch (error) { await settleCurrent(); throw error; }
    attempts.push(attempt);
    /** One provider call under the current ticket; settles it with that call's usage. */
    const send = async (): Promise<{ parsed: unknown } | { retry: unknown }> => {
      let reply: LlmChatCompletionResult;
      try { reply = await gateway.chatCompletions(body); } catch (error) { const estimate = droppedEstimate(error); if (estimate) dollars += estimate.estimatedCostUsd; await settleCurrent(undefined, estimate); if (isRetryOnce(error)) return { retry: error }; throw error; }
      if (reply.usage) { tokens += usageTotal(reply.usage); dollars += usageCost(reply.usage); if (reply.usage.costUsd !== undefined) costCalls += 1; await options.onUsage?.(reply.usage); const summed = addUsage(usage, reply.usage)!; usage = summed; attempt.usage = summed; }
      await settleCurrent(reply.usage);
      try { return { parsed: completionText(reply) }; } catch (error) { if (isRetryOnce(error)) return { retry: error }; throw error; }
    };
    let admissionError: { error: unknown } | undefined;
    try {
      let outcome = await send();
      if ("retry" in outcome) {
        // Exactly one more request, admitted (and counted) like any other; a refusal fails the attempt with the original error.
        const original = outcome.retry;
        // A dropped connection waits briefly (no ticket is held) so the retry does not land in the same provider/edge burst.
        if (classifyLlmGatewayFailure(original) === "transport") { const delay = options.transportRetryDelayMs ?? TRANSPORT_RETRY_DELAY_MS; if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay)); if (await options.cancelled?.()) { halt("cancelled"); await finish(attempt, { state: "cancelled", updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}) }); return "unrun"; } }
        let second: OperatorAdmission | boolean;
        try { second = await admit(); } catch (error) { admissionError = { error }; throw error; }
        if (!second) { halt("limit"); throw original; }
        current = second;
        outcome = await send();
        if ("retry" in outcome) throw outcome.retry;
      }
      if (await options.cancelled?.()) { halt("cancelled"); await finish(attempt, { state: "cancelled", updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}) }); return "unrun"; }
      const explanation = validateOperatorExplanation(outcome.parsed, scope.allowedEvidence);
      await options.store.putAcceptedExplanation(scope.scopeId, explanation, attempt.attemptId, hash);
      await finish(attempt, { state: "accepted", updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}) });
      acceptedNow.add(scope.scopeId); if (reReduce) { if (scope.parentScopeId) dirty.add(scope.parentScopeId); for (const ancestorId of ancestors(scope.scopeId)) changedBelow.add(ancestorId); }
    } catch (error) {
      await settleCurrent();
      await finish(attempt, { state: "failed", updatedAt: now(), ...(attempt.usage ? { usage: attempt.usage } : {}), error: errorText(error) });
      if (admissionError) throw admissionError.error;
    }
    return "settled";
  };
  // Dependency-driven pool: a target scope waits only on its target children.
  const waitingOn = new Map<string, number>();
  for (const scopeId of target) waitingOn.set(scopeId, (children.get(scopeId) ?? []).filter(child => target.has(child)).length);
  // Ready order: parents before leaves so upper levels finish as early as possible, then scopeId.
  const isParent = new Set([...waitingOn].filter(([, count]) => count > 0).map(([scopeId]) => scopeId));
  const byPriority = (left: string, right: string) => Number(isParent.has(right)) - Number(isParent.has(left)) || (left < right ? -1 : left > right ? 1 : 0);
  const ready = [...target].filter(scopeId => waitingOn.get(scopeId) === 0).sort(byPriority);
  const cap = Math.max(1, Math.floor(limits.maxConcurrent));
  let poolFailure: { error: unknown } | undefined;
  try { await new Promise<void>((resolve, reject) => {
    let active = 0; let failure: { error: unknown } | undefined;
    const pump = () => {
      while (!halted && active < cap && ready.length) {
        const scopeId = ready.shift()!; active += 1;
        execute(byId.get(scopeId)!).then(outcome => {
          active -= 1;
          const parentId = byId.get(scopeId)!.parentScopeId;
          if (outcome !== "unrun" && parentId && target.has(parentId)) { const remaining = waitingOn.get(parentId)! - 1; waitingOn.set(parentId, remaining); if (remaining === 0) { ready.push(parentId); ready.sort(byPriority); } }
          pump();
        }, error => { active -= 1; failure ??= { error }; halted = true; pump(); });
      }
      // A thrown scope halts admission; in-flight scopes drain (and settle their tickets) before the run rejects.
      if (active === 0 && (halted || !ready.length)) { if (failure) reject(failure.error); else resolve(); }
    };
    pump();
  }); } catch (error) { poolFailure = { error }; }
  // Honest staleness: any scope (selected or a re-reduce ancestor) with a changed descendant that has no new accepted
  // explanation of its own keeps its old one and is marked stale. Runs even when a scope threw mid-pass.
  const markChangedStale = async () => {
    const unrefreshed = [...changedBelow].filter(scopeId => !acceptedNow.has(scopeId));
    const stale = (await Promise.all(unrefreshed.map(async scopeId => (await options.store.getAcceptedExplanation(scopeId)) ? scopeId : undefined))).filter((scopeId): scopeId is string => scopeId !== undefined);
    if (stale.length) await options.store.markStale(stale);
    staleScopes.push(...stale);
  };
  if (reReduce) { if (poolFailure) await markChangedStale().catch(() => undefined); else await markChangedStale(); }
  if (poolFailure) throw poolFailure.error;
  return { modelId, attempts, staleScopes, stopped, ...(reReduce ? { skippedScopes } : {}) };
}
