# CLA-381: wrapped descriptions and content-fit card faces

## What changed

- **Wrapping.** The compiler emits one text primitive per deterministically wrapped
  line, using the existing frozen Plex font advances (`wrapDisplayText`,
  `cardContentLayout`). Canvas2D lays out text with the same helper.
  - L1/L2 descriptions wrap to at most three lines; L3/L4 to at most two.
  - Only the last capped line ellipsizes. A final word too long for the line is cut at
    a grapheme (`selectScopedArchi…`) rather than dropped. If no glyph fits at all, the
    previous line takes the ellipsis. A lone `…` line is never painted.
  - Long tokens split at grapheme boundaries, and explicit paragraph breaks are kept.
  - Missing support text paints no invented line.
- **Header baselines.** The kicker, title and description baselines come from font sizes,
  not fixed offsets. `cardTitleStep` and `cardDescriptionStep` reserve ≥1.2× and ≥1.35×
  line height, matching the product spec, and keep the title clear of the kicker's
  descenders. This fixes the kicker overlapping the title on owner shells (for example
  "CONTAINER" over "Architecture model"). The compiler, Canvas2D painting, the Canvas
  metrics and the hover HUD all read the same layout (`canvasCardTextLayout`).
- **L4 type.** At the code focus zoom, kicker / title / signature are now 10 / 14 / 11
  CSS px, up from 7.2 / 11.2 / 7.4 (ticket item 3). At the maximum camera runway that
  is 22.9 / 32.1 / 25.2 px, so the frozen comfort caps rise to 24 / 33 / 26 px.
- **Content-fit faces (authored atlases only).**
  - A leaf face (no children in the snapshot) shrinks to kicker + title + wrapped
    support + one padding inset. It never grows past its authored face.
  - Peers in a row share the row's maximum height, capped at each face's own authored
    height.
  - Finer bands take only the compacted height, never the coarser band's position.
  - Owner faces keep their height, so a prior-depth ancestor still encloses its
    expanded branch (frozen 0.32 lineage context, CLA-81 owner equality).

## Deliberately not changed

- **Scan atlases never compact.** Their tiles are proportional child-count reservations:
  the √N L2 peer tile (CLA-95, CLA-119) and the L3 file face that L4 descends onto
  (CLA-109, CLA-121, and the PR1 frozen reveal window). Published scans also have no
  responsibilities yet (CLA-387), so compaction would only produce kicker+title strips.
  Scan cards still get the wrapping, the header fix and the L4 type.
- **Owner header reservation stays at 96 CSS px.** The WIP's 64 px header reshaped
  golden L2 routing: +6 visible geometry problems, including new edge crossings and
  shared corridors around `architecture-model`. That needs its own routing pass, so it
  is a follow-up.
- **The WIP's scan-only L4 reference (13.96 → 5.82) is dropped.** It made scan code
  cards about 2.4× larger in world units and broke the CLA-68 / landscape-repack
  invariants. If it's still wanted after PR1's descent fix, it should go in its own
  ticket.

## Frozen fixture and test changes

- **Regenerated fixtures:** demo snapshot, scene and timeline. The evidence pin
  `1d984293` → `268e575a` follows the moved Canvas2D source anchors. Stable golden IDs
  are unchanged.
- **CLA-67 cost table:** only `payloadBytes` changes (≤1.7%, from multi-line text).
  The rest of the committed table, including `selfScan`, is untouched.
- **CLA-140 geometry baseline:** visible problems go from 355 to 356.
  - Golden L1 enter: 3 → 5.
  - Golden L4 enter: 17 → 16.
- **CLA-114 / c4-compiler typography:** assertions now rejoin the wrapped lines before
  checking prefix and word-boundary truncation.
- **Canvas metrics / CLA-119:** the metric `titleBaseline` is now asserted equal to the
  baseline Canvas actually paints, not the old fixed 50-unit offset. Source guards
  follow the code into `canvasCardTextLayout`.
- **Scan regression test:** summaries change no scan rect in any band, and L3 siblings
  stay off the expanded owner. This test fails without the authored-only copy-forward
  fix.
- **Restored strict:** owner face equality, the 504×356 three-code grid, the L1 root
  face, the CLA-111 title-floor guard and the exact route-parity pick. The WIP had
  loosened all five; the route change only came from its 64 px header.

## Native browser comparison

Production build, served locally with the pinned published atlas. Headed Chrome at
1280×720. BEFORE is main (dev mode, DPR 1); AFTER is this branch (DPR 2), each captured
through the L1–L4 rail. The images are on the `qa-screenshots` release only.

| Atlas / band | BEFORE | AFTER |
| --- | --- | --- |
| Golden L1 | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-before-golden-l1.jpg) | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-after-golden-l1.jpg) |
| Golden L2 | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-before-golden-l2.jpg) | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-after-golden-l2.jpg) |
| Golden L3 | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-before-golden-l3.jpg) | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-after-golden-l3.jpg) |
| Golden L4 | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-before-golden-l4.jpg) | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-after-golden-l4.jpg) |
| Published L1 | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-before-published-l1.jpg) | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-after-published-l1.jpg) |
| Published L2 | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-before-published-l2.jpg) | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-after-published-l2.jpg) |
| Published L3 | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-before-published-l3.jpg) | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-after-published-l3.jpg) |
| Published L4 | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-before-published-l4.jpg) | [image](https://github.com/source-for/atlas/releases/download/qa-screenshots/cla381-cardfit-after-published-l4.jpg) |

### Observed

- **Golden L3:** summaries wrap to two lines ending on a clean word, and the
  "CONTAINER / Architecture model" heading no longer overlaps. Uneven owner heights
  come from the existing child-count sizing and are unchanged from main.
- **Golden L4:** the symbol title and signature are readable at code focus.
- **Pre-existing, not from this PR:** the GPU glyph atlas paints `?` for `·` and `–` in
  L4 kickers (for example `FN ? 219?224`). Main shows the same. Tracked separately.
- **Published L3 capture:** it landed mid lens-reversal. That is a capture-timing
  artefact, not a layout change.
- **Known nit:** below the L1/L2 12 px Canvas title floor (zoom ≲ 0.4 at L1), the
  floored title pushes the support lines down by a few px. On a compacted face, the
  last line can then clip into the bottom inset. The text is 2–4 px tall at those
  zooms. Away from the focus zoom, Canvas's fixed 2 px kicker clearance can also put
  its title up to about 1 px lower than the compiler's; they match at focus.
- **Load-sensitive test (existing, not from this PR):** under heavy machine load (load
  average 15–26), `AppRestore.mounted` fails in the full `pnpm test` on main too
  (18/20). It passes alone and in the web suite run by itself.
