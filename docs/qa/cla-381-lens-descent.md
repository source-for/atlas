# CLA-381: scan component-to-code descent

## Attribution

Read-only production checks and a locally served production build use the published
`source-for/atlas` snapshot `snapshot:source-for-atlas:9831775f5bbe`, publication
`publication-fd362d5c-bc5e-4a21-92ca-ca93462dc940`. The starting URL is:

```
https://sourcefor.dev/r/source-for/atlas?nav=1&repo=repo%3Asource-for-atlas&snap=snapshot%3Asource-for-atlas%3A9831775f5bbe&view=view%3Asource-for-atlas%3Ahierarchy&root=container%3Aapps-web&sel=system%3Aokie&cx=-1051.603&cy=-805.505&z=3.17177&detail=context&lens=system%3Aokie&lens=container%3Aapps-web
```

The ordinary semantic policy does **not** produce an 11.6 enter threshold. Dev-only
`data-lens-diagnostics` records the terms from the actual targeting calculation,
plus the independent scan bridge. In the controlled BEFORE run:

| Term for `historyController.ts` | Zoom |
| --- | ---: |
| Authored minimum / representation LOD minimum | 7.1000 |
| Minimum CSS size | 4.2348 |
| Current L3 card coverage enter | 6.2805 |
| Coverage commit / full | 6.8039 / 7.3273 |
| Effective authored enter / full | 7.1000 / 7.9500 |
| Actual scan bridge start / full | **8.0640 / 13.3056** |

Coverage uses the current painted L3 face, 85.0095 × 42.5047 world units, rather
than the L4 owner's 57.8797 × 27.7937 bounds. The scan handoff bypasses ordinary
semantic targeting while loading the focused neighborhood. It previously anchored
its bridge to the camera zoom **when compilation completed**, then multiplied that
zoom by 1.65. The measured bridge is exactly 8.064000633 × 1.65 = 13.305601045.
Compilation latency and continued input therefore moved the transition later.
There was a second independent delay: the handoff trigger was 7.6 (the authored
7.1 minimum plus 0.5), so even zero compilation latency gave a completion zoom
of 7.6 × 1.65 = 12.54. Freezing completion alone would not remove that trigger.

The user's earlier production observation was first L4 near 11.59 and outward L3
near 10.04. Our remote cold pass did not establish a code onset through 13.54;
these are different observations, not a claimed reproduction of one fixed 11.6
threshold. The controlled local BEFORE pass below isolates the actual bridge.

## Fix

For scanned component-to-code transitions, freeze a window from the painted L3
face width **before** asynchronous preparation. The reference width is the smaller
of 330 CSS pixels (the existing 300-unit component face × 1.10 presentation scale)
and 42% of the measured safe map width. Divide that reference width by the painted
face's world width to get the reference zoom. Arm preparation at 1.10× reference
zoom, reveal at 1.25×, and complete at 1.50×. Shift both reverse endpoints down by
0.05× reference zoom to preserve continuous geometry and directional ownership.
Wrapped descriptions do not change this width policy.

At the historical desktop safe width of 789 CSS pixels, the reference remains
330 pixels: reveal starts at 412.5 pixels and completes at 495 pixels, with a
16.5-pixel reverse deadband. On the user's 85.0095-unit card, these are zoom
4.8524 → 5.8229 and a reverse zoom deadband of about 0.194, replacing the former
fixed 0.50. The starting L3 width was about 269.63 pixels at zoom 3.17177, so the
reveal widths are 1.53× → 1.84×. The historical desktop tables below are unchanged;
they do not establish narrow-viewport acceptance.

The compiled scan code LOD, compile-cache identity and restore policy carry the
same measured safe width. Synchronous camera input publication through
`onCameraInput` applies at every detail level. Its callers supply the composed,
rendered camera. `reconcileRenderedCamera` retains live input while the React
camera is unchanged or owned by its publication guard, preserving later pan/pinch
motion during deferred compilation. If preparation finishes at or beyond the full endpoint,
a 180ms late-publication reveal provides continuous geometry while consuming the
latest input camera rather than the request's stale camera.

Lens cancellation (window Escape, breadcrumbs, Mermaid import) now also ends the
canvas's pending gesture (zoom assist, settle glide, wheel and pinch settle timers),
drops the pending scan adopt camera, cancels in-flight gesture handoffs and clears
the scan bridge morph. These run only when there is a lens to cancel. Previously a queued assist frame or the
next settle sample could restore the cancelled lens path from the live morph; the
mounted Escape regression now uses a clock that keeps the queued assist frame live,
and fails if the assist cancel is removed.

Idle callbacks respect the scan window rather than the global code-band floor.
Global semantic constants, authored golden runways, and L1/L2 transitions are
unchanged. Dev-only diagnostics sample repeated records of the same stage at most
once per 32ms; the production path returns before diagnostic sampling.

## BEFORE observations

| Run / transition | Zoom | Detail and lens path |
| --- | ---: | --- |
| Production L1→L2 | 0.853 | revealing container; system target |
| Production L1→L2 | 1.20516 | settled container; `system:okie` |
| Production L2→L3 | 1.56175 | container; `system:okie` |
| Production L2→L3 | 2.62271 | revealing component; `system:okie → container:apps-web` |
| Production L3→L2 outward | 2.40563 | container; `system:okie` |
| Local L3→L4 | 3.17177 | settled component; `system:okie → container:apps-web` |
| Local L3→L4 | 8.06400 | bridge begins, full endpoint 13.30560 |
| Local L3→L4 | 9.58510 | component, progress 0.3451 |
| Local L3→L4 | 10.45008 | code, progress 0.5176; history component appended |
| Local L3→L4 | 13.31019 | settled code, six code children |
| Local L4→L3 outward | 10.27106 | component, progress 0.4831 |
| Local L4→L3 outward | 7.92585 | settled component; history component removed |

Pointer repositioning makes the production L1/L2 rows observations rather than
precise boundary estimates. Local BEFORE map viewport was 904×588, safe viewport
789×370.765625; production had a cookie notice and a 904×544 map viewport. Native
headed Chrome, 1280×720 window viewport, DPR 2, WebGPU; Apple M1 Pro, 10 logical
cores, 32 GiB RAM, Darwin 25.3 arm64. CPU throttle was not applied.

BEFORE evidence: [local cold bridge](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-before-local-cold-code.jpg),
[production descent](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-before-history-descent.jpg).
Raw samples and pinned response data remain outside git.

## AFTER and validation

Native static-build AFTER samples use the same pinned atlas, 1280×720 viewport,
904×588 map and WebGPU. A development-server pass that overlapped source hot
reload is excluded. The table records observed samples, not interpolation of
unobserved boundaries:

| Transition | BEFORE observation | AFTER observation / lens path |
| --- | --- | --- |
| L1→L2 | prod .853 revealing → 1.20516 settled | local .89825 revealing → 1.06768 container → 1.16403 settled; `system:okie` |
| L2→L3 | prod 1.56175 container → 2.62271 component revealing | local 1.95481 container → 2.32354 revealing → 2.76183 component; `system:okie → container:apps-web` |
| L3→L2 | prod 2.40563 container | local 2.53322 container revealing, web lens removed |
| L2→L1 | not precisely measured | local .97931 container reversing → .75570 context, empty lens |
| L3→L4 | local start 8.06400 / full 13.30560 | frozen start 4.85240 / full 5.82288 |
| L3→L4 ownership | local 10.45008 code, progress .5176 | local 5.41932 code, progress .606; history component appended |
| L3→L4 completion | local 13.31019 settled code | local 6.01135 settled code, six children |
| L4→L3 ownership | local 10.27106 component, progress .4831 | local 5.10126 component, progress .480; history component removed |
| L4→L3 completion | local 7.92585 settled component | local 4.55930 settled component |

L1/L2 sampling used different pointer positions and production cookie chrome;
those rows do not establish a changed threshold. Their implementation and the
frozen band/cinematic acceptance contracts remain unchanged. For the code bridge,
logical ownership crosses at geometric midpoint 5.3155 inward / 5.1207 outward.
A forward sample 5.41931→5.37269→5.41931 retained code and progress .606; an outward
sample 5.10126→5.14553→5.10126 retained component. The reverse deadband prevents
repeated ownership toggles. Code-title readability at these early zooms is addressed
in the separate card-fit PR.

Final publication-memory build (`App-CtB9GmMw.js`, evidence pin `b05b0424`) adds an
explicit mounted regression: a deferred compile publishes progress .9 and the
first outward pinch retains .9 before any idle callback. Tests also cover latest
mouse/pinch pan input, real publisher/settle timers, abandonment and cold reload.
Reverting early measured eligibility or synchronous camera input fails the relevant
mounted cases; the progress-initialization assertion was red before its fix. Merely
removing the explicit frozen-window argument does not fail because the same source
face fallback independently derives that window; no stronger mutation claim is made.

The final immutable build passed a clean native replay: 4.97075 reveal/.132,
5.41932 code/.606, 5.80715/.985, 6.01135 settled code with six children; saved-code
reload retained all three lens IDs, code detail and a populated inspector. Outward
5.14553 remained code/.526, 5.10127 became component/.480 and retained component
through ±.005 wheel jitter; 4.52008 reached the settled source endpoint.
`App-CtB9GmMw.js` was confirmed by the module-preload link; the immutable served
bundle SHA-256 is `ee2b9ec3d40532ef381e0797c1e0b1358d5c05dfb04b7c9f2b009ed76fcfe438`.
Golden step 3 waited for the actual paused state with Hierarchy selectors overview
prose; selecting a canvas node populated the inspector, and `/new`→home returned
to the golden atlas. Native pan/wheel and mounted ctrl-wheel pinch were exercised;
the native UI driver does not expose a pinch gesture.

All gates pass: `pnpm check`, `pnpm test` (1,833 web tests),
`cargo test --workspace`, `pnpm build`. The test shell selected installed Git 2.45
instead of legacy Git 2.23 because scanner fixture creation needs `git init -b`.
No repository changes were needed for that environment issue.

The same final build was deployed to staging version
`aa4ab126-2b16-4a88-9016-2aa097249977`. Production remained read-only. Screenshots
are uploaded only to the existing qa-screenshots release; no raw traces or images
are committed.

Component summaries are already absent in the pinned published data (134 apps-web
components, zero nonempty responsibilities), including a fresh version-pinned
history neighborhood response. That separate publication issue is tracked as
[CLA-387](https://linear.app/source-for/issue/CLA-387).

## Review-fix browser checks

Production build (`vite build`) served with the pinned published atlas by
`scripts/performance/server.mjs`, Playwright Chromium, wheel steps of 60 (30 on the
narrow re-entry), cursor over `src/navigation/historyController.ts`, starting from
the user's z=3.17177 URL. Observed samples, not interpolated boundaries:

| Viewport | L4 entered | L4 left (outward) | Notes |
| --- | ---: | ---: | --- |
| 1280×720 | 5.642 (5.250 still L3) | 4.886 (5.250 still L4) | Production at the same URL: 11.59 in, 10.04 out. |
| 390×844 (map 390×720) | 1.986 (1.916 still L3) | 1.783 (1.916 still L4) | Root switches to the file at 1.848 (preparation arms before reveal). Card ≈170 CSS px, 44% of the map width, at entry. |

Escape with focus outside the canvas, 1280×720, at L4:

| Gap between last wheel event and Escape | Result |
| --- | --- |
| settled (2 s) | lens cleared and stays cleared; next wheel re-enters L4 |
| 100 ms | lens cleared and stays cleared |
| 0–30 ms (4 runs) | lens cleared and stays cleared; next wheel re-enters L4 |

Before the second review round, Escape within ~60 ms of the last wheel event was
undone by the burst's pending 120 ms wheel-settle callback, which re-ran the zoom
handoff. This also reproduces intermittently on production (one of two runs at the
same URL did not clear the lens). The cancel now clears that timer; a mounted
regression fails without it.

Delayed publication beyond the window is covered by the mounted regressions
(`animates a late code publication…`, `stops an owned late reveal…`,
`does not publish a cancelled late code branch…`); it was not forced in the browser.
