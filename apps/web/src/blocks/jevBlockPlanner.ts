import { useRef, useSyncExternalStore } from 'react';
import { localStore } from '../browserStorage';
import { BLOCK_PLANNER_STORAGE_KEY, blockPlannerQueryFlag, getBlockPlannerScan, type BlockPlanScan } from './blockPlannerScan';
import { resolveBlockPlanner, type BlockPlan, type BlockPlanInput, type BlockPlanner } from './blockPlanner';

/**
 * CLA-149 phase 2: the Jev block planner client. `plan()` stays synchronous: it answers from a cache
 * keyed by publication version + node + candidate id/type set, returns `undefined` on a miss (so the
 * default order shows at once) and starts one background `POST /api/block-plan`. The request carries
 * only ids and types; the server derives node size and block previews from the publication. A plan that
 * arrives after a node's Overview has painted is kept for the NEXT visit (no reorder under the reader).
 * `runBlockPlanner` still validates every plan. The server holds JEV_API. Off unless `?planner=jev`
 * (captured at boot) or localStorage `okie.blockPlanner=jev`.
 */
export const BLOCK_PLAN_ENDPOINT = '/api/block-plan';
export { BLOCK_PLANNER_STORAGE_KEY };

export type JevPlanStatus = { state: 'off' } | { state: 'pending' } | { state: 'planned' } | { state: 'deferred' } | { state: 'unavailable'; reason: string };
type Entry =
  | { state: 'pending'; attempts: number }
  | { state: 'planned'; plan: BlockPlan }
  | { state: 'unavailable'; reason: string; terminal: boolean; attempts: number; retryAt: number };

export interface JevBlockPlanner extends BlockPlanner {
  subscribe(listener: () => void): () => void;
  /** Increments whenever an answer arrives. */
  version(): number;
  /** The cache key for this input (undefined without a published scan or outside the Overview). */
  keyOf(input: BlockPlanInput): string | undefined;
  status(input: BlockPlanInput): JevPlanStatus;
}

/** Reasons worth asking again later this session; everything else (disabled, no-planner-ledger, invalid-*, budget, 4xx) is final. */
const TRANSIENT = new Set(['busy', 'rate-limited', 'timeout', 'provider-failure', 'network', 'http 5xx']);
/** At most 2 retries per key per session, after 2 s and then 8 s. */
export const JEV_PLAN_RETRY_DELAYS_MS = [2_000, 8_000] as const;
const CACHE_ENTRIES = 128;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function createJevBlockPlanner(options: { scan: () => BlockPlanScan | undefined; fetchImpl?: typeof fetch; endpoint?: string; now?: () => number }): JevBlockPlanner {
  const cache = new Map<string, Entry>();
  const listeners = new Set<() => void>();
  const now = options.now ?? (() => Date.now());
  let version = 0;
  const keyOf = (input: BlockPlanInput): string | undefined => {
    if (input.context.mode !== 'overview') return undefined;
    const scan = options.scan();
    if (!scan) return undefined;
    return [scan.slug, scan.versionId, input.node.id, ...input.candidates.map(candidate => `${candidate.id}:${candidate.type}`).sort()].join('\u0000');
  };
  const settle = (key: string, entry: Entry) => {
    cache.delete(key); cache.set(key, entry);
    while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
    version += 1;
    for (const listener of [...listeners]) listener();
  };
  const fail = (key: string, reason: string, attempts: number) => {
    const terminal = !TRANSIENT.has(reason) || attempts > JEV_PLAN_RETRY_DELAYS_MS.length;
    settle(key, { state: 'unavailable', reason, terminal, attempts, retryAt: terminal ? Number.POSITIVE_INFINITY : now() + JEV_PLAN_RETRY_DELAYS_MS[attempts - 1]! });
  };
  const request = (key: string, input: BlockPlanInput, scan: BlockPlanScan, attempts: number) => {
    cache.set(key, { state: 'pending', attempts });
    const body = { scan, nodeId: input.node.id, node: { kind: input.node.kind }, context: 'overview', budget: { maxBlocks: input.budget.maxBlocks }, candidates: input.candidates.map(({ id, type }) => ({ id, type })) };
    const fetchImpl = options.fetchImpl ?? fetch;
    void Promise.resolve()
      .then(() => fetchImpl(options.endpoint ?? BLOCK_PLAN_ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
      .then(async response => {
        const value: unknown = await response.json().catch(() => undefined);
        if (!response.ok || !record(value)) return fail(key, response.status >= 500 ? 'http 5xx' : `http ${response.status}`, attempts);
        if (value.state === 'planned' && Array.isArray(value.order)) {
          return settle(key, { state: 'planned', plan: { order: value.order as string[], ...(record(value.reasons) ? { reasons: value.reasons as Record<string, string> } : {}), source: 'planner' } });
        }
        fail(key, typeof value.reason === 'string' ? value.reason.slice(0, 40) : 'unavailable', attempts);
      })
      .catch(() => fail(key, 'network', attempts));
  };
  return {
    name: 'jev',
    keyOf,
    plan(input) {
      // Overview only: Ask (CLA-265) keeps the default recipe until it has its own question.
      const key = keyOf(input); const scan = options.scan();
      if (!key || !scan) return undefined;
      const entry = cache.get(key);
      if (!entry) { request(key, input, scan, 1); return undefined; }
      if (entry.state === 'unavailable' && !entry.terminal && now() >= entry.retryAt) request(key, input, scan, entry.attempts + 1);
      return entry.state === 'planned' ? entry.plan : undefined;
    },
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    version: () => version,
    status(input) {
      const key = keyOf(input);
      if (!key) return { state: 'unavailable', reason: 'no published scan' };
      const entry = cache.get(key);
      return !entry || entry.state === 'pending' ? { state: 'pending' } : entry.state === 'planned' ? { state: 'planned' } : { state: 'unavailable', reason: entry.reason };
    },
  };
}

export const jevBlockPlanner = createJevBlockPlanner({ scan: getBlockPlannerScan });

/** `?planner=jev` (captured at boot, before the URL rewrite) or localStorage `okie.blockPlanner=jev`. Default off. */
export function blockPlannerFlagEnabled(queryFlag = blockPlannerQueryFlag(), storage: Pick<Storage, 'getItem'> | undefined = localStore): boolean {
  if (queryFlag) return true;
  try { return storage?.getItem(BLOCK_PLANNER_STORAGE_KEY) === 'jev'; } catch { return false; }
}

const noopSubscribe = () => () => {};

/**
 * One Overview view's planner. A candidate set whose plan was not cached at its first composition in this
 * view stays in the default order for the rest of the view, even when the plan arrives meanwhile: it
 * applies on the next visit (a new view). No reorder under the reader.
 */
export function createViewPlanner(planner: JevBlockPlanner): { planner: BlockPlanner; deferred(input: BlockPlanInput): boolean } {
  const missed = new Set<string>();
  return {
    planner: {
      name: planner.name,
      plan(input) {
        const key = planner.keyOf(input);
        // Still ask (a transient failure may retry), but never apply mid-view.
        if (key && missed.has(key)) { planner.plan(input); return undefined; }
        const plan = planner.plan(input);
        if (!plan && key) missed.add(key);
        return plan;
      },
    },
    deferred: input => { const key = planner.keyOf(input); return Boolean(key && missed.has(key) && planner.status(input).state === 'planned'); },
  };
}

/**
 * The planner the Overview for `viewKey` (the node shown) uses; see `createViewPlanner`. `version` changes
 * when an answer arrives so the dev note can say "plan cached for next visit".
 */
export function useOverviewBlockPlanner(viewKey: string | undefined, planner: JevBlockPlanner = jevBlockPlanner, enabled = blockPlannerFlagEnabled()): { planner: BlockPlanner; version: number; deferred(input: BlockPlanInput): boolean } {
  const version = useSyncExternalStore(enabled ? planner.subscribe : noopSubscribe, enabled ? planner.version : () => 0, () => 0);
  const view = useRef<{ key: string | undefined; view: ReturnType<typeof createViewPlanner> }>(undefined);
  if (!view.current || view.current.key !== viewKey) view.current = { key: viewKey, view: createViewPlanner(planner) };
  const current = view.current.view;
  return {
    planner: enabled ? resolveBlockPlanner({ remotePlanner: true }, current.planner) : resolveBlockPlanner({ remotePlanner: false }),
    version,
    deferred: input => enabled && current.deferred(input),
  };
}

/** Dev-mode note text: which planner ordered the blocks, and why the default applied when it did. */
export function plannerNote(plan: BlockPlan, status: JevPlanStatus | undefined): string {
  if (plan.source === 'planner') return 'Order: Jev planner';
  if (!status || status.state === 'off') return 'Order: default';
  if (status.state === 'pending') return 'Order: default (Jev plan pending)';
  if (status.state === 'deferred') return 'Order: default (Jev plan cached for next visit)';
  if (status.state === 'unavailable') return `Order: default (Jev ${status.reason})`;
  return `Order: default (${plan.fallback ?? 'planner unavailable'})`;
}

/** Reads the app shell's `data-dev-mode` (Shift+Alt+D) without touching the pinned App: observed, not owned. */
function readDevMode(): boolean { return typeof document !== 'undefined' && document.querySelector('[data-dev-mode]')?.getAttribute('data-dev-mode') === 'true'; }
function subscribeDevMode(listener: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => {};
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-dev-mode'], subtree: true });
  return () => observer.disconnect();
}
export function useAtlasDevMode(): boolean { return useSyncExternalStore(subscribeDevMode, readDevMode, () => false); }
