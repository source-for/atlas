# Atlas performance profiling

Use the local performance panel to find startup and interaction stalls before choosing an optimization. The panel records browser timings plus atlas-search, loading and render phases. Progressive first views and persistent scene workers are now implemented in the current performance slice; remaining main-thread work and repeated agent reads are tracked under CLA-357. No speed improvement is claimed without a controlled comparison.

## Enable recording

Append `perf=1` to the page query before loading, for example `/?perf=1` or `/?fixture=stress&perf=1`. Alternatively press Shift+Alt+P to start or stop a session. Late activation cannot reconstruct the application bootstrap; reload with the query flag for that measurement. The panel appears outside the application root, including on `/new` and error pages.

Choose **Export safe timing JSON** before **Stop recording**. Stopping discards the local session and removes observers, the frame loop and refresh timer. When a page enters the browser Back/Forward cache, collectors stop; an active session resumes on restoration, while a manually stopped session stays stopped. The query does not persist a preference. Recording is disabled by default and has no network endpoint or account synchronization.

The export contains only a schema version, capability states, a dropped-sample count and at most 240 samples with fixed metric identifiers and numeric start/duration values. It does not collect resource URLs, event names/targets, question text, source excerpts, credentials, heap dumps or attribution. Review any separate DevTools trace before sharing: those traces can contain information excluded from this export.

## Interpret the measurements

Navigation duration is a browser document timing. First paint, first contentful paint and largest contentful paint are timestamps since navigation. They do not prove the atlas is usable. Bootstrap start/completion are application timestamps; completion means the bootstrap requested a render, rather than the renderer finished a frame or the inspector is ready.

Interaction durations are sampled browser Event Timing entries, not a complete INP score. Browser event durations are rounded to 8 ms, even though the export stores numbers rounded to 0.1 ms; that export formatting does not increase precision. See [PerformanceObserver options](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceObserver/observe). Long tasks are browser-reported main-thread work. Frame stalls are gaps above 50 milliseconds in visible-page animation callbacks, not renderer FPS; hidden-page time is excluded. The diagnostic panel and export themselves add work, so use the same instrumentation setting when comparing runs, then verify improvements with recording disabled too.

A capability marked unsupported or failed has no trustworthy zero result. An available capability with no samples means no matching entry was retained. Old samples roll out of the bounded buffer; inspect the dropped count and export short scenarios separately. The report has no event names, so keep a separate scenario note to identify which actions you performed.

## Repeatable browser scenarios

Use a production build for timing comparisons. Dev mode, HMR and build activity can distort results. Record the commit, browser version, operating system, machine class, renderer backend, viewport, fixture/publication pin, network/CPU throttling, cache state, run count and instrumentation setting alongside results. Keep the window visible and close unrelated workloads. Use the same environment for before/after comparisons.

Run golden, deterministic stress and a pinned published large atlas separately. For each dataset:

1. Perform a cold load with HTTP cache disabled. Record paint and bootstrap timestamps, then manually verify a rendered map and populated inspector. Time to a usable atlas remains a separate measurement until an explicit readiness hook is implemented.
2. Repeat with a warm cache. Do not combine cold and warm samples. For public data, distinguish browser HTTP cache from server/index cache.
3. Select nodes, type a symbol search, open source/evidence, pan/zoom and play a guided story while data arrives. Jump to a known story step and await the paused playback state for correctness checks; separately exercise continuous playback for responsiveness.
4. Exercise `/new`, error/recovery routes and rapid navigation between nodes/scopes. Record frame stalls, long-task durations and sampled interaction durations. Avoid live scans or model calls in automated runs.
5. Export each short scenario and repeat enough times to report run count, median and p95 with an honest sample-size limit. Do not adopt a universal device-independent budget from a single run.

Browser DevTools can provide the missing phase breakdown: fetch/transfer, decode/parse, normalize/index, compile/layout, renderer setup/upload and first usable frame. Measure worker processing and message-transfer cost explicitly when work moves off the main thread. Moving expensive work to a worker does not remove its cost or guarantee prompt cancellation.

## Agent read benchmarks

The excerpt-heavy edge fixture is a correctness test: it creates/stores a snapshot above 16 MiB with 20,000 entities and performs two complete reads. Its timeout is a runner safety bound, not an API latency target. An isolated local run took about 2 seconds before tuning; that result includes setup and cannot isolate parser performance.

Benchmark cold and repeated version-pinned reads separately under CLA-361. Record raw/projected bytes, R2 fetch duration, parse/projection CPU and wall time, query time, peak memory and concurrency. Compare bounded caches or prebuilt public indexes only after measuring those costs; preserve complete graph coverage, public-field allowlists, immutable version pins and evidence honesty.

## Delivery order

CLA-358 supplies instrumentation and reproducible scenarios. CLA-359 schedules measured expensive browser processing in cancellable workers. CLA-360 prioritizes the first useful view and selected evidence while limiting speculative background loading. CLA-361 measures and optimizes repeated server/edge reads. Each optimization needs a before/after comparison and a regression check tied to the measured behavior.

## Browser search worker (CLA-362)

Opening search lazily starts a dedicated module worker. A minimal corpus containing IDs and the existing searchable fields (name, kind, responsibility and source label) is prepared in 256-row chunks with yields, encoded and transferred as ArrayBuffers once for that scene entity array. The worker retains its index until the scene changes or the app unmounts. Closing search cancels queries but keeps the index; subsequent keystrokes send only a query and limit, and replies contain at most seven IDs. The scene, geometry, evidence and excerpts remain in the UI; this slice does not move the full atlas or renderer into a worker and does not require SharedArrayBuffer or cross-origin isolation headers.

There is at most one active query and one newest pending query. Superseded queries cancel cooperatively at worker yield boundaries, and the UI rejects results for obsolete queries or entity arrays. Worker errors, message errors and a 10-second handshake/query safety timeout switch the session to chunked main-thread fallback. The timeout is not a performance target. Changing scene or unmounting terminates the worker and cancels old preparation/fallback work. Preparation stops when its worker fails, rather than encoding an unused corpus alongside fallback search.

Record with `?perf=1` or Shift+Alt+P. Shift+Alt+D exposes the search backend/status alongside the search popover. For development-only fallback exploration, reload with `searchWorker=0` in the query before opening search; production builds ignore this flag. Diagnostics record only these fixed names and numeric durations:

| Metric | Meaning |
| --- | --- |
| `search-prepare` | UI-thread corpus preparation elapsed time, including yield waits and chunk encoding. |
| `search-startup` | Client creation to index-ready acknowledgement, including preparation, worker startup, transfer and index build; these overlap the separate phase measurements. |
| `search-index` | Worker decode, lowercase normalization and index construction elapsed time. |
| `search-query` | Worker query elapsed time, including cooperative yield waits. |
| `search-round-trip` | Dispatch to receipt on the UI thread, including worker work, message delivery and scheduling; it is not isolated transfer cost. |
| `search-fallback` | Chunked main-thread fallback query elapsed time, including yield waits. |

All search sample timestamps are receipt/recording times on the UI thread. Worker durations use that worker's own clock; clock origins are not subtracted across threads. Blank-query suggestions stay synchronous and location-aware. Search text, result IDs and corpus contents never enter the performance export; worker messages contain the query/index data needed for local search. Recording retains nothing while diagnostics are stopped.

For repeated runs, record cold first-open preparation/readiness separately from warm-index searches. Use the same golden/stress/pinned publication and query sequence, including a no-match query that scans the whole index, rapid replacements, clear/close/reopen, scene changes and selecting a result with a populated inspector. Export short sessions before the 240-sample limit rolls over. A dev fallback run exercises correctness and capability recovery; it is not a controlled comparison against the previous synchronous implementation. Use a production build and a fixed browser/environment for performance claims, and verify input/pan/zoom while background work is pending.

## Render phase attribution (CLA-357, in progress)

Active local recording now samples synchronous render-loop phases: `render-scene` (scene installation), `render-state` (camera and visual state), `render-draw` (CPU drawing/submission), and `render-publish` (camera publication to the shell). These are not GPU completion timings. Normal frames are sampled at most once per 250 ms, with all measured frames exceeding 16 ms retained; the latter is a diagnostic trigger, not an adopted performance budget. The bounded report can roll over quickly during stalls, so export short scenarios. Phase start timestamps use the UI clock. With recording stopped the hook reads no clock and allocates no frame samples. Failed/incomplete render callbacks do not emit a complete phase sample.

This instrumentation has focused unit coverage and web typechecking; browser baseline, first-usable readiness, loading/compile attribution and performance improvements remain pending. No before/after performance claim is established yet.

Loading attribution now separates `atlas-fetch` (request to response headers), `atlas-body` (response text transfer/decoding), `atlas-parse` (synchronous JSON parse), and `atlas-compile` (scoped scene compilation). Optional and required published JSON use the same phase hooks; errors retain their existing behavior. Durations include elapsed scheduling time for async phases. Numeric timings do not record paths, IDs or data. This does not yet move processing into a worker.

Initial browser exploration on loopback preview port 4316 used a production build, golden fixture, automatic backend, active local diagnostics and the existing Chrome viewport. Zoom-in/out and a Containers-level change kept a populated inspector and displayed render phases. The visible report included a 150 ms startup long task and latest draw phase 0.4 ms. This single exploratory run has no controlled cache/network/hardware baseline, does not identify the long task's cause and is not a p50/p95 or improvement claim. The browser download observer timed out while attempting export; no exported report is asserted. First-usable readiness and repeated golden/stress/published comparisons remain required.

## Published Atlas investigation and worker prototype (2026-10-03)

The public Source For Atlas publication `publication-fd362d5c-bc5e-4a21-92ca-ca93462dc940` (`9831775f5bbed310b771900225501be42b6d159e`) supplied a 16,062,951-byte neighborhood with 5,507 entities and 13,003 relations. A production-build browser exploration through a loopback proxy recorded JSON parse 75.2 ms, repeated root compiles 1803.4/1755.6/1759.5 ms, a 3641 ms long task, and first draw submission 112.6 ms. Safe DOM-visible timing JSON is retained privately at `/tmp/atlas-perf-published-baseline.json`; no raw DevTools trace is published. This is one exploratory run, not a repeatable p50/p95 baseline.

Startup now reuses the initial scene for same-root lens validation and initialize restoration; popstate and different roots retain compilation. The initial published scene compiles in a dedicated module worker, terminated after reply/error/abort/20-second safety timeout. Unsupported/error fallback retains the existing synchronous compiler. Snapshot generation rejects a prepared scene if a neighborhood merged during its preparation, and merges invalidate the cached initial scene. The prototype still clones the initial graph once, parses/validates on the UI thread and compiles later navigation on the UI thread; this is not a persistent worker-owned full pipeline. A loading message is added while preparing the published map.

The cold-cache worker trial completed with a populated inspector and no UI root-compile samples, but took 12448.2 ms worker compile / 13061 ms round trip. This startup elapsed time is worse than the initial uncontrolled-cache run, so no startup speed improvement is claimed. Cache mode, worker cold execution and runtime load differ; investigate before adoption. Selecting Containers still recorded 4564.2 ms synchronous compile and a 4633 ms long task. This confirms navigation compilation remains a required target. Artifacts: `/tmp/atlas-perf-published-worker-first.json`, `/tmp/atlas-perf-worker-browser.png`. Temporary browser cache disabling was restored.

Neighborhood view-ID membership used repeated array scans (including a relation `some` inside a relation filter). Replacing those memberships with local Sets preserves order and duplicates. An isolated Node 22.23.1 / Apple M1 Pro exploratory compile of this exact publication took about 2079 ms before and 1503 ms after; serialized scene SHA-256 is identical (`cb6f1f7311baccce9b582a0a60454bb6bf0c4bd10060a50ced82baf77ec65399`). This single comparison motivates a browser rerun and repeatable sampling, not a claimed p95 improvement. All 12 neighborhood tests pass. Worker lifecycle tests cover completion, late reply after abort, unsupported worker, wrong scope, failure and timeout. Full gates and browser validation of the latest loading/membership changes remain pending.

## Progressive first view and navigation workers (in progress)

CPU profiling of the pinned published graph found repeated visible-parent-set construction in `objectForNode`, in addition to neighborhood membership scans. Compiler-local entity and per-band parent indexes now replace that repeated work. The exploratory Node compile fell from ~2079 ms to ~1187 ms with exactly the same serialized scene SHA-256; 15 C4 compiler/authoring acceptance tests passed. The profile remains private at `/tmp/atlas-perf-compile.cpuprofile` and is not safe-export telemetry.

For neighborhood boots above 128 entities (a provisional delivery trigger, not a device performance budget), initial preparation compiles a context/container packet first. The complete original snapshot and publication remain the fixture's source of truth. Deeper root detail prepares as a separate optional background job, with visible loading copy. The existing first map is kept if that job fails or becomes stale. Automatic enrichment requires unchanged scene ownership, context/container lens detail and identical visible entity IDs/bounds at the same frozen revision. Selecting a level cancels speculative enrichment; scope/selection changes cancel pending jobs. Initialization and popstate remain distinct. The current workers still clone input data and use one worker per job; persistent graph ownership and worker fetch/parse are outstanding.

Level buttons now compile asynchronously, retain the current map during preparation, cancel superseded level jobs and reject replies for an obsolete fixture/scene/selection or merged snapshot generation. Worker failure falls back to the original compiler. Later zoom handoffs, story and Open inside paths still have synchronous compilation and require further work.

`atlas-first-frame` is the first successful real-scene draw submission, excluding the stress loading placeholder and unsupported renderer. It is not GPU presentation, inspector readiness or a complete usability score. Late recording cannot reconstruct it. First-frame tests cover single emission and late activation.

An explicitly unthrottled, cache-disabled browser trial of the full initial-worker build recorded first submission at 11658.7 ms; the subsequent progressive trial recorded 3667.3 ms. In the latter, initial worker compile was 871.8 ms and optional enrichment 4389.4 ms. Main-thread loading still included a 942 ms long task, and background result installation included a 373 ms task. These single trials are leads, not p50/p95 claims or completion of the benchmark matrix. The visible map/inspector remained populated during level-button requests and rapid Code→Context replacement. Local artifacts: `/tmp/atlas-perf-progressive-cold-1.json`, `/tmp/atlas-perf-progressive-levels.json`, `/tmp/atlas-perf-progressive-browser.png`. Temporary cache disabling was restored; profiling explicitly set CPU throttling rate to 1 for the agent tab.

Full check/test/Rust/build gates passed an intermediate revision. Latest progressive/source edits have web typechecking and 46 focused tests, plus the five lifecycle/first-frame checks. Regenerate anchors and rerun the full gates before opening a PR. Cold/warm repeated comparisons, golden/stress/published pan/zoom/story/search/Ask correctness, worker fetch/parse and persistent scheduling remain required; CLA-357/359/360 stay open.

Persistent worker integration now retains one graph generation and at most two compiled scenes. Level requests use selected priority; initial enrichment uses speculative priority. Aborting active CPU work terminates the worker, so the next request reloads the graph. Full snapshots and bootstrap slices have separate monotonic generation numbers; merged neighborhoods advance the full generation. Fixture replacement and App cleanup dispose worker ownership, with lazy recreation for StrictMode remounts. The timing JSON disclosure captures a snapshot when opened to avoid repeated large DOM updates during recording.

The first full-suite run after this integration found one source-contract assertion expecting the old synchronous level callback. The assertion now checks that both neighborhood fetches precede async compilation and that cancellation/fixture ownership guard the prepared-scene installation. Final suite results and repeatable performance comparisons remain pending.

Three further exploratory cold trials of the persistent-worker build (HTTP cache disabled, CPU rate 1, visible 1270×969 viewport, same published revision) recorded first draw submissions at 3903.9, 2638.4 and 3221.8 ms (median 3221.8 ms). Initial worker compile durations were 684.5, 642.8 and 692.5 ms. These are small-sample exploratory repeats with local agent activity not isolated, not an SLO/p95 or a matched before/after comparison. The production build remained unchanged across the trials. Reports are in private `/tmp/atlas-perf-persistent-cold-{1,2,3}.json`; the raw JSON disclosure was closed during loading. Reloading the rewritten navigation URL drops `perf=1`, so each recorded trial used explicit navigation back to the instrumented URL.

Added `atlas-validate`, `atlas-story` and `atlas-slice` phases to separate loading validation/story preparation/bootstrap slicing from JSON parse and worker compilation. These phases are inactive without a timing subscriber and export only scalar timing values. Focused phase/fixture tests: 42 passed. Broader final checks must be rerun after the gesture changes.

The gesture worker slice moves viewport refresh and inward scan zoom handoff compilation off the UI thread. Async publication verifies fixture/scene/session/selection ownership, uses the latest camera, and does not reset the camera for pan results. Viewport jobs defer to pending foreground handoffs. The reusable scene cache is an eight-entry LRU, invalidated by fixture identity and snapshot generation; synchronous speculative compile prefetch is removed (fetch-only). Evidence attachment also advances generation. Focused gesture coverage passed; the integrated check/test/Rust/build gates passed before the final evidence-invalidation regression, whose focused fixture test and typecheck also passed. Browser wheel input entered the @okie/web scope with the same atlas pin; further repeat comparisons and diagnostics-off gesture verification remain pending.

The added attribution trial recorded parsing at 24.2 ms, validation at 775.1 ms, story preparation at 17.4 ms total across four stories, and bootstrap slicing at 21.1 ms. First draw submission was 3665.7 ms. Validation is the next worker candidate; moving fetch/parse alone would not address this measured largest loading phase. This remains one exploratory run.

Final verification for the first integrated performance slice: `pnpm check`, `pnpm test` (1663 web tests, all workspaces green), `cargo test --workspace` and `pnpm build` passed after the evidence-invalidation regression. Final golden browser exploration started the story, jumped to step 3, awaited `[data-playback-state="paused"]`, and confirmed the Hierarchy selectors inspector. `/new` completed its public/operator state. Published exploration exercised Containers selection, pan and inward wheel handoff into @okie/web while retaining the same publication. Diagnostics were stopped and panning exercised again. The goal remains active; these functional checks do not establish frame/latency percentiles. No local scan fixture was present for `?fixture=scan`.
