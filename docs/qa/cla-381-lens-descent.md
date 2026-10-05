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

The user's earlier production observation was first L4 near 11.59 and outward L3
near 10.04. Our remote cold pass did not establish a code onset through 13.54;
these are different observations, not a claimed reproduction of one fixed 11.6
threshold. The controlled local BEFORE pass below isolates the actual bridge.

## Fix

For scanned component-to-code transitions, freeze a window from the painted L3
face width **before** asynchronous preparation. The existing 300-unit component
face and 1.10 presentation scale define a 330 CSS-pixel reference width. Reveal
starts at 412.5 CSS pixels and completes at 495 CSS pixels; a 16.5-pixel reverse
deadband preserves continuous geometry and ownership. On the user's card these
are zoom 4.8524 → 5.8229, versus its good L3 width of about 269.63 pixels at zoom
3.17177: 1.53× → 1.84×. Wrapped descriptions do not change this width policy.

The compiled scan code LOD and restore policy use the same window. Synchronous
camera input publication protects later pan/pinch motion during deferred compile.
Idle callbacks also respect the scan window rather than the global code-band
floor. Global semantic constants, authored golden runways, and L1/L2 transitions
are unchanged.

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
| L3→L4 | local start8.06400 / full13.30560 | frozen start4.85240 / full5.82288 |
| L3→L4 ownership | local 10.45008 code, progress .5176 | local 5.41932 code, progress .606; history component appended |
| L3→L4 completion | local 13.31019 settled code | local 6.01135 settled code, six children |
| L4→L3 ownership | local 10.27106 component, progress .4831 | local 5.10126 component, progress .480; history component removed |
| L4→L3 completion | local 7.92585 settled component | local 4.55930 settled component |

L1/L2 sampling used different pointer positions and production cookie chrome;
those rows do not establish a changed threshold. Their implementation and the
frozen band/cinematic acceptance contracts remain unchanged. For the code bridge,
logical ownership crosses at geometric midpoint 5.3155 inward / 5.1207 outward.
A forward sample5.41931→5.37269→5.41931 retained code and progress .606; an outward
sample5.10126→5.14553→5.10126 retained component. The reverse deadband prevents
repeated ownership toggles. Code-title readability at these early zooms is addressed
in the separate card-fit PR.

Final publication-memory build (`App-CtB9GmMw.js`, evidence pin`b05b0424`) adds an
explicit mounted regression: a deferred compile publishes progress .9 and the
first outward pinch retains .9 before any idle callback. Tests also cover latest
mouse/pinch pan input, real publisher/settle timers, abandonment and cold reload.
Reverting early measured eligibility or synchronous camera input fails the relevant
mounted cases; the progress-initialization assertion was red before its fix. Merely
removing the explicit frozen-window argument does not fail because the same source
face fallback independently derives that window; no stronger mutation claim is made.

The final immutable build passed a clean native replay:4.97075 reveal/.132,
5.41932 code/.606,5.80715/.985,6.01135 settled code with six children; saved-code
reload retained all three lens IDs, code detail and a populated inspector. Outward
5.14553 remained code/.526,5.10127 became component/.480 and retained component
through ±.005 wheel jitter;4.52008 reached the settled source endpoint.
`App-CtB9GmMw.js` was confirmed by the module-preload link; the immutable served
bundle SHA-256 is`ee2b9ec3d40532ef381e0797c1e0b1358d5c05dfb04b7c9f2b009ed76fcfe438`.
Golden step3 waited for the actual paused state with Hierarchy selectors overview
prose; selecting a canvas node populated the inspector, and `/new`→home returned
to the golden atlas. Native pan/wheel and mounted ctrl-wheel pinch were exercised;
the native UI driver does not expose a pinch gesture.

All gates pass: `pnpm check`, `pnpm test` (1,833 web tests),
`cargo test --workspace`, `pnpm build`. The test shell selected installed Git2.45
instead of legacy Git2.23 because scanner fixture creation needs `git init -b`.
No repository changes were needed for that environment issue.

The same final build was deployed to staging version
`aa4ab126-2b16-4a88-9016-2aa097249977`. Production remained read-only. Screenshots
are uploaded only to the existing qa-screenshots release; no raw traces or images
are committed.

Component summaries are already absent in the pinned published data (134 apps-web
components, zero nonempty responsibilities), including a fresh version-pinned
history neighborhood response. That separate publication issue is tracked as
[CLA-387](https://linear.app/source-for/issue/CLA-387).
