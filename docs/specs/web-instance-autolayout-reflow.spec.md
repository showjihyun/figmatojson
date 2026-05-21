# spec/web-instance-autolayout-reflow

| Field | Value |
|---|---|
| Status | Draft (round 24) — the final spec item (§3.10 derivedSymbolData transform baking) added |
| Implementation | `web/core/domain/clientNode.ts` (`applyInstanceReflow` helper + `toClientChildForRender` derived* baking, invoked from the INSTANCE branch), `src/instanceOverrides.ts` (`collectDerivedSizesFromInstance` round-22, `collectDerivedTransformsFromInstance` round-24) |
| Tests | `web/core/domain/clientNode.test.ts` (hand-built fixtures, round-22 T-deriv-1..5, round-24 T-deriv-6a..e / 7a..c / 8 / 9 / 10 / 11) |
| Siblings | `web-instance-render-overrides.spec.md` (override pipeline), `web-canvas-instance-clip.spec.md` (round-12 INSTANCE clip — this spec resolves the *real* cause of the alert text clip) |

## 1. Goal

The round-12 INSTANCE auto-clip stops the obvious leaks (such as a corrupted "Defa..." label substring), but when an INSTANCE size is smaller than the master, the *layout that Figma intends* — children automatically re-positioned within the INSTANCE bbox by re-running auto-layout — does not happen on our web side. Result: the text inside the "Cancel"/"Delete" buttons of an alert dialog and inside the "Confirm" button of an input-box stays at master coordinates and gets clipped by the INSTANCE clip (confirmed by the round-13 visual gate).

`pen-export.ts:reflowMasterChildren` (lines 709-852) handles this case by only setting the `_showPos` flag and recomputing counter-axis position, leaving the actual primary-axis flow to Pencil. We have no Pencil on web, so *we* must simulate the layout ourselves. This spec simulates, in v1, only the narrow subset that the two metarich audit cases (alert + input-box) depend on — `HORIZONTAL/VERTICAL` stack + `CENTER` primary + `CENTER` counter. The rest stays as-is.

## 2. Trigger

In the INSTANCE branch of `toClientNode`, immediately after the master is expanded and `_renderChildren` is built, the reflow fires when **all of the following are true**:

- I-T1 The INSTANCE's effective size (`finalSize = instData.size`) differs from the master's size (at least one of x or y differs).
- I-T2 The master's `stackMode === 'HORIZONTAL' || stackMode === 'VERTICAL'`. (NONE / GRID / undefined → does not fire.)
- I-T3 The master's `stackPrimaryAlignItems` is a v1-supported value (`CENTER`, or undefined treated as default — Figma's default is normally MIN). v1 **handles only CENTER**; other values (MIN/MAX/SPACE_BETWEEN/SPACE_EVENLY) only trigger the §3.6 overlap-group path, otherwise reflow stays as-is.
- I-T4 The master's `stackCounterAlignItems` is a v1-supported value (`CENTER` or undefined). Other values stay as-is.

If any condition fails → `_renderChildren` is kept as-is (master coordinates, leaks prevented by INSTANCE clip). Visual defects are spelled out as non-goals in §6.

### 3.6 Overlap-group reflow (round-15 Phase B)

**A separate trigger** — independent of alignment. Fires when the master has `stackMode === 'HORIZONTAL'` or `'VERTICAL'`, and among the *visible* children of master.children, several sit at the same primary-axis position in master coordinates (i.e., *overlap*). The Figma pattern: the designer pre-stacks multiple variant slots into the same flow slot and toggles them `visible: true` at instance time, with Figma redistributing them via auto-flow.

- I-O1 Among visible children, if `transform.m02` (HORIZONTAL) or `transform.m12` (VERTICAL) of the master is identical to that of another visible child, that group is an "overlap group". (Invisible children are ignored.)
- I-O2 The first child of an overlap group keeps its master coordinate as-is. Subsequent children are *cumulatively distributed along the primary axis* in master stack order — first child's primary position + the sum of (previous visible children's primary size + spacing).
- I-O3 The counter-axis position is the master value as-is (overlap reflow does not touch counter).
- I-O4 In the non-overlapping case (every visible child's primary position is unique), fall back to the general reflow in I-T1..T4; if neither applies, master coordinates are kept.
- I-O5 When overlap reflow and the general CENTER reflow must both apply, the general reflow wins (it recomputes positions for all visible children); overlap is resolved naturally inside it.

Metarich Dropdown rail case: master 11:532 (VERTICAL, primary alignment undefined = MIN) has children 15:292/15:296/15:300 all stacked at master y=127. The outer Dropdown INSTANCE shows 15:292 + 15:296 with `visible:true`. Overlap-group reflow keeps the first child (15:292) at y=127 and moves the second (15:296) to y=127+40+1(spacing)=168. Result: 5 rows visible (today / last 1 week / last 30 days / this month / prev month). The "manual select" row (15:300) stays `visible:false` (separate variant-swap spec).

### 3.7 MIN/start-aligned reflow with visibility filtering (round-19)

**Trigger:** master has `stackMode === 'HORIZONTAL'` or `'VERTICAL'`, **`stackPrimaryAlignItems === undefined` or `'MIN'`** (Figma's default = start), AND some master children are hidden by outer overrides (i.e., visible children count < total children count).

WEB lnb-400_4266 sidemenu (master 23:1635) case: VERTICAL, primary undefined (= MIN), 9 master children of which 5 are hidden by the outer Dropdown's symbolOverrides → 4 remain visible. Figma packs the 4 visibles via auto-layout (y=4, 53, 102, 151). We kept master coordinates (y=102, 298, 347, 396) → 3 of them overflow outside the section → clipped by INSTANCE auto-clip → the three DB-management menu rows (Contract / Manage / Distribute) are not shown.

- I-O6 If the visible-child count equals the expanded-child count (= all visible), do not fire — master coordinates are already packed.
- I-O7 On fire, the anchor is `startPrimary = expanded[0].transform.m02 (HORIZONTAL) or .m12 (VERTICAL)` — the master's first child position (regardless of visibility). Preserves the designer's hard-coded padding-style offset.
- I-O8 Walk visible children in master order and compute cumulative positions: `cursor = startPrimary; for each visible: assign cursor; cursor += childPrimary + spacing`.
- I-O9 Invisible children's transforms are not changed (Canvas does not draw them anyway).
- I-O10 Counter axis: apply the §3.4 rule when counter alignment is `CENTER`; otherwise keep the master value.
- I-O11 If §3.1-3.5 (CENTER+CENTER reflow) already fired, skip this rule — CENTER reflow already recomputed all visible-child positions. §3.6 overlap-group similarly; trigger priority is (CENTER+CENTER) > (overlap-group) > (MIN-pack).

This rule is a generalization of the §3.6 overlap-group reflow — what previously fired only when the overlap was at *exactly identical* primary positions is now also corrected for *gaps* caused by hidden children. The two rules have different trigger conditions but share similar packing logic.

## 3. Layout simulation

### 3.1 Input

- `expanded`: `_renderChildren` (already with overrides + visibility resolved; transforms still at master coordinates)
- `masterData`: the master TreeNode's data (used to read stackMode, alignments, padding)
- `masterSize`: `{x, y}`
- `instSize`: `{x, y}` (final INSTANCE size after overrides)

### 3.2 Effective visible children

I-S1 Layout calculation runs only over *visible* children. A child with `child.visible === false` (hidden by visibility override or prop-binding) is excluded from layout — its position is not recomputed and it stays at master coordinates (Canvas does not draw it anyway).

### 3.3 Primary axis (CENTER)

I-S2 HORIZONTAL → primary = x. VERTICAL → primary = y.
I-S3 Sum of visible-child primary sizes = `Σ child.size[primary] + (count-1) × stackSpacing`.
I-S4 Starting position = `(instSize[primary] - sum) / 2`. (CENTER alignment, padding ignored — v1 simplification. The metarich cases only have R/B padding, which conflicts with CENTER — keeping it as-is yields a closer result.)
I-S5 Visible children are laid out in the master's *original order* from the start position, separated by spacing.

### 3.4 Counter axis (CENTER)

I-S6 HORIZONTAL → counter = y. VERTICAL → counter = x.
I-S7 Each visible child's counter position = `(instSize[counter] - child.size[counter]) / 2`.

### 3.5 Mutation

I-S8 *Replace* the `transform.m02` (x) and `transform.m12` (y) of visible children with the computed values. Other transform fields (m00/m01/m10/m11 = rotation/scale) are preserved.
I-S9 Child with no transform → create a new transform `{m00:1, m01:0, m02:newX, m10:0, m11:1, m12:newY}`.
I-S10 The child itself is a fresh object (no mutation of the master tree — round-12 §3.3 I-M1).
I-S11 Invisible children are not changed.

## 4. Error cases

- I-E1 If master or instance size is undefined / malformed → skip reflow (return expanded as-is). Safe fallback.
- I-E2 Zero visible children → return expanded as-is (no-op).
- I-E3 Sum of visible-child sizes exceeds the instance primary axis → the start position becomes negative and leaks to the left. Still applied (a natural consequence of CENTER — Figma behaves the same). Visually handled by round-12 INSTANCE clip.

## 5. Tests

A new describe block `applyInstanceReflow` in `web/core/domain/clientNode.test.ts`. Hand-built fixtures:

- T-1: HORIZONTAL master with 1 visible TEXT child (icon hidden via visibility override). INSTANCE size shrunk. Assert TEXT transform.m02 = expected center.
- T-2: HORIZONTAL master with 2 visible children. INSTANCE size unchanged. No reflow expected (transform unchanged).
- T-3: VERTICAL master with 1 visible child. INSTANCE size shrunk on y axis. Assert child transform.m12 = expected center.
- T-4: master with stackMode === 'NONE'. No reflow expected.
- T-5: master with stackPrimaryAlignItems === 'MIN'. No reflow (v1 doesn't support MIN).
- T-6: invisible children (visible:false) excluded from primary-sum calculation but their own transforms unchanged.
- T-7: INSTANCE size override only on counter axis (primary unchanged) → counter recompute, primary keeps master values.
- T-8: missing transform on a visible child → new transform generated with computed (x, y).
- T-9: integration via `toClientNode`: alert button INSTANCE fixture (master 88×32 HORIZONTAL CENTER, instance size 48×32, prop-binding hides icon, text override "Delete") — assert resolved TEXT transform centers in 48×32.
- T-deriv-1: `collectDerivedSizesFromInstance` picks up `entry.size` (existing v1 behavior).
- T-deriv-2: `collectDerivedSizesFromInstance` picks up `entry.derivedTextData.layoutSize` when no `entry.size`.
- T-deriv-3: `entry.size` wins over `entry.derivedTextData.layoutSize` when both present (size is more general).
- T-deriv-4: `toClientChildForRender` overrides `out.size` from `derivedSizesByPath` for matching descendant currentKey.
- T-deriv-5: integration via `toClientNode` — outer INSTANCE has `derivedSymbolData` with size delta for a child; expanded child renders at derived size, and CENTER reflow uses the new size for spacing.

### 3.7.5 CENTER reflow trigger narrowing (round-21)

Round-14 spec §3.2 I-T1 originally said "fire CENTER+CENTER reflow when sizes differ". Round-20 wired CENTER reflow into nested-INSTANCE expansion as well. Combined, this fired CENTER for ANY size mismatch — including the case where INSTANCE is *bigger* than master (e.g. WEB Dropdown rail's option-row INSTANCEs are 233 wide vs master 117 — designer intentionally extended). CENTER-recentering pushed text past the parent Dropdown's clip.

Trigger narrowed to **`instance.primary < master.primary` OR `instance.counter < master.counter`** (any axis shrunk). Grown instances keep master positions — they reflect the designer's intent to extend.

### 3.8 stackPrimarySizing AUTO/RESIZE_TO_FIT_* support (round-20)

Figma's `stackPrimarySizing: "RESIZE_TO_FIT*"` is a mode in which the INSTANCE auto-grows along the primary axis to fit its children's content. Designers leave *hints* or *minSize* in the size override, but the actual render size is determined by content length.

- I-AG1 If the INSTANCE root override (path = [masterID]) sets `stackPrimarySizing` to `RESIZE_TO_FIT_WITH_IMPLICIT_SIZE` or any other `RESIZE_TO_FIT*`, AUTO-grow mode is active.
- I-AG2 v1 fallback: lacking infrastructure for precise text natural-width measurement, when `instance.size.primary < master.size.primary`, use the master size. Prevents the leading clip in the case where a small hint (e.g. 44px) is smaller than master (101px).
- I-AG3 `instance.size.primary >= master.size.primary` (already grown) is unaffected by this rule — even if the content is longer than the master we cannot know. Candidate for round-21 spec (text-measurement-based reflow).
- I-AG4 Update `out.size` to the grown size (so the INSTANCE auto-clip in `Canvas` also uses the grown bbox).

Source case: metarich dashboard's Excel-download button INSTANCE 587:7495 with size override 44 + RESIZE_TO_FIT → grow to master 101 → avoids the leading clip.

### 3.9 derivedSymbolData size baking (round-22)

Figma's INSTANCE nodes ship *post-layout delta for every descendant* via the `derivedSymbolData: Array<{guidPath, size?, transform?, derivedTextData?, fillGeometry?, ...}>` field — entries appear only where there is a delta from the master, and those entries are the authoritative size/position/glyph layout.

Round-21's attempt (applying derivedSize to TEXT only) failed because it was a *partial application* — the outer Dropdown's size override should shrink children INSTANCEs as well (e.g. 233→103), but we applied only the master child size (233) + the smaller derived TEXT size → text misaligned inside the wide container. This rule applies to *every* descendant.

- I-DS1 Walk the outer INSTANCE's `derivedSymbolData`, collect each entry that has `entry.size` into a path-key (slash-joined GUIDs) → `{x, y}` map. `derivedTextData.layoutSize` is also registered in the same map (the natural width of TEXT descendants). **The path-key scheme is defined in `web-instance-render-overrides.spec.md §3.1 I-C1` (since round-25, FRAME/GROUP ancestors are skipped).**
- I-DS2 At descendant-emit time in `toClientChildForRender`, if `derivedSizesByPath.get(currentKey)` exists, *override* `out.size` with it. Not master-size-wins but derived-wins (Figma's post-layout value is more accurate).
- I-DS3 Nested INSTANCE own size uses the same rule — the priority for `nestedInstSize` is `nestedGrownSize (round-20) > derivedSize (round-22) > nestedOrigInstSize (data.size) > master`. When both AUTO-grow and derived are present, AUTO-grow wins (round-20 is more explicit).
- I-DS4 The nested INSTANCE's `derivedSymbolData` is also inner-prefix-merged with the outer's (reusing the round-21 plumbing — if the outer knows the derived data of a deeper descendant, it wins over inner overrides).
- I-DS5 Once applied, `applyInstanceReflow` (§3.1-3.7.5) re-flows based on the *modified child sizes* → spacing/center calculations across the INSTANCE boundary become accurate. In the common case where derivedSymbolData does not contain transforms (0 of the 35 entries in the sidemenu have transforms), our reflow rule fills positions in.
- ~~I-DS6 Cases with a single-entry INSTANCE `transform` (e.g. derivedSymbolData[0].transform on the u:sign-out-alt 7:208 icon) are not applied in v1 — this round only applies size. Transform application is a round-23 candidate (no observable visual impact in current cases).~~ **(Resolved in round-24 §3.10 — `entry.transform` is also baked into every descendant.)**

Source case: the middle calendar labels (Wed/Thu/Fri/Sat) of the metarich design-setting datepicker 12:749 get clipped — when the outer dropdown rail's derived sizes shrink children INSTANCEs, the text fits precisely inside the narrower container and the clip area disappears.

### 3.10 derivedSymbolData transform baking (round-24)

After §3.9 baked `entry.size` (and `entry.derivedTextData.layoutSize`), the last remaining item — `entry.transform` (the *post-layout 6-field 2D affine* stamped by Figma) — is also authoritative data. In the metarich audit corpus, 1,570 INSTANCEs have a transform on at least one entry (most of these are cases where reflow does not fire — designers left the INSTANCE at the master size and Figma baked only placement). This round extends the §3.9 size-baking plumbing to transforms.

- I-DT1 `collectDerivedTransformsFromInstance(instData)` walks the outer INSTANCE's `derivedSymbolData` and collects only entries with `entry.transform` into a path-key → `Transform2D` map. `Transform2D` = `{m00, m01, m02, m10, m11, m12}` and all 6 fields must be numbers; if any is malformed, silent skip (same policy as §3.9 I-DS1). **The path-key scheme is defined in `web-instance-render-overrides.spec.md §3.1 I-C1` (since round-25, FRAME/GROUP ancestors are skipped — a fix for the mismatch surfaced as the alert-modal regression in round-24).**
- I-DT2 At descendant-emit time in `toClientChildForRender`, if `derivedTransformsByPath.get(currentKey)` exists, *replace `out.transform` wholesale* (not just patching m02/m12 — all 6 fields including rotation/scale). The application point is right after the §3.9 `out.size` application — entries with both size and transform at the same currentKey apply independently.
- I-DT3 The nested INSTANCE's `derivedSymbolData` is inner-prefix-merged with the outer's (reusing the §3.9 I-DS4 plumbing — same path-key scheme). If the outer knows a deeper descendant's derivedTransform, it wins over inner own data.
- I-DT4 **Conflict with reflow — v1 punt**: `applyInstanceReflow` mutates only the *direct children* (m02/m12) of the INSTANCE. When reflow fires (instance < master), even if a direct child's path is registered in derivedTransform, reflow wins — it *overwrites* Figma's derivedTransform. Reflow does not touch deep descendants, so derivedTransform is always the final answer there. Justification for the v1 punt: (a) most of the 1,570-INSTANCE corpus does not satisfy the reflow trigger (since the round-21 narrowing, reflow fires only for instance < master), and (b) in the shrunk case where reflow does fire, derivedTransform and the reflow calculation should *agree by construction* (Figma's post-layout = the target of our simulation). If they differ visibly, a separate round will align the reflow rule to derivedTransform.
- I-DT5 Master immutability — derivedTransform application happens only to the per-instance copy under `_renderChildren` (§3.3 I-M1). Other INSTANCEs referencing the same master transform only their own descendants with their own derivedTransform.

Source case: among the 1,570 INSTANCEs in the metarich audit corpus, the reflow-not-firing cases dominate — designers left button/icon INSTANCEs at the master size and Figma baked the glyph widths / icon positions of children post-layout. With round-22 sizes only, children stay at master positions and a clip area appears; once transform baking lands, we render pixel-identical to Figma.

Tests: the round-24 block in `web/core/domain/clientNode.test.ts` (T-deriv-6a..e: collector, T-deriv-7a..c: walk application, T-deriv-8: deep descendant, T-deriv-9: nested prefix-merge, T-deriv-10: v1 punt verification for the conflict-with-reflow case, T-deriv-11: direct child + reflow not firing = derivedTransform survives).

## 6. Non-goals

- **Primary alignment ≠ CENTER** (MIN, MAX, SPACE_BETWEEN, SPACE_EVENLY) — unsupported in v1. Master coordinates kept + INSTANCE clip. Unnecessary because all metarich cases are CENTER.
- **Counter alignment ≠ CENTER** (MIN, MAX, STRETCH) — unsupported in v1. STRETCH deserves a separate spec (child size changes).
- **Padding handling** — v1 ignores padding. The R=12, B=10 padding on the metarich Button master conflicts with CENTER — accurate Figma behavior is more complex when padding is applied. Status quo (ignored) is visually closer.
- **Reflow inside nested INSTANCEs** — not added in v1 to the INSTANCE branch of `toClientChildForRender` (the inner INSTANCE keeps its own master coordinates). The metarich cases only require reflow on the outer INSTANCE.
- **Auto-layout proportional sizing** (e.g., `stackPrimarySizing: AUTO` for child size auto-grow) — unsupported in v1.
- **Proportional scale when master has `stackMode === 'NONE'`** — the `scaleNode` logic of `pen-export.ts`. This spec covers only the stackMode cases. Whether NONE cases exist in metarich is evaluated by a separate audit.
- **(round-24) Preservation of derivedTransform on direct children when reflow fires** — the v1 punt of §3.10 I-DT4. The CENTER/MIN-pack simulation of reflow overwrites Figma's derivedTransform. Occurs only in shrunk-INSTANCE cases, and since the two calculations should agree by construction, visual impact is likely not observable; if a conflict case is found in audit, separate a round that makes reflow use the m02/m12 of derivedTransform as an *anchor*.
- **(round-24) `entry.fillGeometry` / `entry.strokeGeometry` baking** — Figma also stamps the post-tessellation outline of vectors, but this round only covers transform/size. Lower priority because vector descendants are sufficiently covered by the master's `vectorData`.

This spec is a web-only implementation — *not the same behavior* as `pen-export.ts:reflowMasterChildren` (the CLI delegates to the Pencil flow). The two implementations tackle the same problem (INSTANCE size override) from *different angles*. Combining them would be natural once cluster A (Expansion extraction) triggers in the future, but this spec resolves the visual defects in the metarich audit *without* that extraction.
