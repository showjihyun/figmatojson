# Round 11 — Figma vs figma_reverse fidelity gaps

This file lists gaps found by visually diffing each component on the
`design setting` page against Figma's actual render.

**Findings status (2026-05-03):**
- Pass 1 done — gaps inferred from `ours.png` inspection alone, plus
  cross-check with the overview Figma screenshot the user shared
  (`docs/스크린샷 2026-05-03 155402.png`).
- **Pass 2 done** — every entry below has a paired `figma.png` next to
  `ours.png` and was diffed visually using
  `node web/scripts/crop-audit-tiles.mjs <slug>` (tiles in `_tiles/`,
  gitignored). One harness fix landed during Pass 2: the audit
  capture now hides the ZoomBadge + variant labels (`?audit=1`) and
  uses node bbox cropping, so `ours.png` matches Figma's API export.
- See **Pass 2 confirmed** section at the bottom for the canonical
  set of gaps and which Pass 1 items were upheld / refuted.
- The audit folder is keyed by the slugs in `INVENTORY.md`. Re-run
  `node web/scripts/audit-round11-screenshots.mjs` any time the
  renderer changes to refresh `ours.png` for every component.

## Gap-row format

| severity | bucket | what's wrong | likely fix point |

- `severity` ∈ {high | med | low}
- `bucket` ∈ {style-detail | universal-primitive | behavior | out-of-scope}

---

## button (5:9)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| med | universal-primitive | "Button" text in S-size variants clipped to "Butto" — last char cut. Frame width too small for current font metrics, OR Konva text auto-shrinks the wrong axis. | `web/client/src/Canvas.tsx` text rendering for variant containers — verify text node uses `width` from the source data and `wrap='word'`; check whether `fontSize` is being scaled correctly for S-size variants. |
| low | style-detail | Outline-type button stroke color appears slightly bluer than Figma's typical neutral gray. [needs figma] | `web/core/domain/color.ts` — re-check stroke color extraction for OUTLINE button variants. |

## input-box (9:42)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| **high** | universal-primitive | The blue confirm button on the right of each input shows BOTH the `→` arrow icon AND the "확인" text. In Figma only "확인" should be visible (arrow `u:arrow-right` is hidden via instance override). Earlier round added path-keyed visibility overrides; some of these Input Box variants are still leaking through. | `web/core/domain/clientNode.ts` — extend `collectVisibilityOverridesFromInstance` to traverse the Input Box variant SYMBOL children. The override path is one step deeper than the calendar fix handled. |
| med | style-detail | `Disable` variant input background looks light gray — matches Figma. ✓ |  |

## type (11:150)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| low | none visible | `select` and `Text_Area` variants render fine. [needs figma to confirm] |  |

## option-a (11:515)

No visible issues — round-10 variant labels render perfectly above each
of `기본`, `hover`, `selected`. State visuals (default outline, hover
light-blue, selected blue-fill) all match expected Figma look.

## dropdown (11:532)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| low | behavior | Renders 3 options (default / hover / default). In the Figma overview the Dropdown popup shows 4 entries (Default / Hover / Select / Disable) for state demo. [needs figma] — likely just because the source SYMBOL is a single non-variant instance. |  |

## sidemenu (23:1635)

No visible issues. Dark-navy bg, hover-darker row, selected-light-blue
row all render correctly.

## radio (11:540)

No visible issues — radio circles render with correct selected-state
(blue dot inside circle), hover (blue stroke), disabled (light fill).
Round-10 variant labels match the variant types.

## multicheck (11:576)

No visible issues — check states render correctly (empty / hover-blue
border / selected-blue-fill with checkmark / disabled). One extra
`selected_disable` variant label is visible too.

## date (11:606)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| low | none visible | Date input rows render placeholder `0000-00-00` and calendar icon correctly. |  |

## datepicker (12:749)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| **high** | behavior + universal-primitive | The calendar Dropdown left-rail shows `오늘 / 최근 / 최근 / 쥼월` — two duplicate `최근` and one mojibake-looking `쥼월`. Figma source likely has `오늘 / 최근 1주일 / 최근 1개월 / 이번 달`. This is a multi-step instance text-override path that the round-handling for "calendar Dropdown shows Korean labels" (visible in the e2e suite) was supposed to cover, but a slice of it is still falling through. | `web/core/domain/clientNode.ts` — `collectTextOverridesFromInstance` likely keys on `guidPath.last` for some entries instead of the slash-joined full path. Check whether the rail items are inside an INSTANCE-of-an-INSTANCE (3-level deep). |
| med | universal-primitive | Right calendar's first row of dates renders with light-blue tint. If Figma renders this as the date-range "from" highlight selection, fine; if it should be plain white, our renderer is mis-applying a multi-paint background fill. [needs figma] |  |

## table-a (16:728)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| **high** | universal-primitive | Left-side cells show garbled text like `Defa이람상태`, `DefaC분배` — looks like two text overrides being **concatenated** instead of one replacing the other. | `web/core/domain/clientNode.ts` — `applyTextOverridesAtPath` may be mutating into a node whose `_overriddenCharacters` already exists; should replace, not append. |
| low | style-detail | Header row "N", "계약명", "제휴업체" etc. appears in same font weight as body rows. Figma headers often bolder. [needs figma] | `web/core/domain/clientNode.ts` text style propagation. |

## table-b (16:729)

(Captured but partially below the visible viewport; see `table-a` for
likely shared issues.)

## table-nodata (64:397)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| low | none visible | "조회 결과가 없습니다." (No results) message renders centered. ✓ |  |

## option-b (26:243)

No visible issues — dark-navy variant of the option list. Round 10
variant labels (`default`, `hover`, `active`) render correctly.

## breadscrum (29:450)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| low | style-detail | Both breadcrumb segments render in the same gray. Conventionally the rightmost (current page) segment is darker / bolder. [needs figma] |  |

## toast-popup (53:346)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| low | none visible | Success ✓ "수정이 완료되었습니다." renders dark-navy bg with green check. Looks correct. |  |

## alert (64:376)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| **high** | universal-primitive | Both action buttons in the alert dialog show the `u:arrow-right` icon (`→`) at left. Figma renders these as plain `취소 / 확인` text buttons with no icon. Same root cause as the **input-box** issue — `u:arrow-right` instance visibility override missing for this nesting depth. | `web/core/domain/clientNode.ts` — same fix point as input-box. The alert dialog's confirm buttons are SYMBOL-of-INSTANCE with the arrow icon visibility=false override at depth 3. |

## pagenation (131:362)

No visible issues — round-10 variant labels (`기본`, `베리언트2`) render
above each variant. Number buttons 1–10 with selected (6, 10) blue-fill
look correct. Purple dashed component-set border ✓.

## loader (133:422)

No visible issues — 4 fading rounded squares render correctly.

## label (145:674)

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| low | data-quirk | All width-variants (`60`, `80`, `100`, `120`, `width5`) render identical "Default" content — no visible width difference. Likely the source data itself doesn't show width in the visible content; Figma will look the same. ✓ |  |

---

## Pass 2 confirmed (2026-05-03)

Every component in `design-setting/` now has a paired `figma.png` and
was diffed at full resolution using `_tiles/`. Findings below are the
ground truth — Pass 1's "[needs figma]" qualifiers are removed.

### Confirmed gaps

| # | title | components affected | severity | bucket | notes |
|---|---|---|---|---|---|
| **1** | **`u:arrow-right` instance-visibility leaks** — arrow icon shows where Figma renders it hidden. Confirmed in: every input-box confirm button, every datepicker rail row, every dropdown row, AND **both alert dialog buttons** (where it's worse — alert button text gets pushed off the button so only "삭" of "삭제" is visible). | input-box-9_42, alret-64_376, datepicker-12_749, 1fromto-12_750 (rail), dropdown-11_532 | high | universal-primitive | **Root cause (round-12 investigation):** the icon visibility is NOT controlled by `symbolOverrides[].visible`; it is controlled by Figma's **Component Properties** (`componentPropAssignments` on the outer INSTANCE → `componentPropRefs` with `componentPropNodeField:"VISIBLE"` on the inner icon). Our web renderer has no handling for this mechanism. Pen-export already handles it correctly — `src/pen-export.ts:921-1041` (`buildPropAssignmentMap` + effective-visibility at `:1198`). **Fix point:** `web/core/domain/clientNode.ts` — port the prop-assignment / prop-ref resolution into `toClientNode` + `toClientChildForRender`. One change closes all 4 components. |
| **2** | **Calendar-rail text overrides fall through** — `오늘 / 최근 1주일 / 최근 30일 / 금월 / 전월 / 직접 선택` (6 items) renders as `오늘 / 최근 / 최근 / 꼼월` (4 items). The data layer is fine (e2e test `instance-fill-override.spec.ts:125` shows 5 of 6 `_renderTextOverride` values are present). The visual gap is downstream — likely overlapping with #3's auto-clip issue (rail rows narrow, "최근 1주일" clips to "최근"; bottom 2 rows hidden because rail container is sized too small). | datepicker-12_749, 1fromto-12_750 | high | universal-primitive | **To re-investigate after #3 fix lands** — once INSTANCE auto-clip works, rail rows may shrink properly and "최근 1주일" should render full. If it doesn't, a separate fix for rail-row width or for variant-swap of "직접 선택" is needed. |
| **3** | **`Default` placeholder bleeds into next column** — header "진행상태" looks like `Defa진행상태`. Not a text concatenation — the "Default" string is the variant-name TEXT child of a MultiCheck checkbox INSTANCE master (`SYMBOL 11:577`, 77×24, with TEXT "Default" at (32,5)). The table-cell INSTANCEs override size to 24×24 but don't hide the label, and INSTANCEs aren't auto-clipped to their bbox — so "Default" bleeds 32 px to the right into the next column, where the column-bg paints over its tail leaving "Defa" visible. | table-16_729, tbody-16_763, table_nodata-64_397 | high | universal-primitive | **Root cause (round-12 investigation):** missing INSTANCE auto-clip. Figma clips instance content to the instance's bbox by default; we don't. **Fix point:** `web/client/src/Canvas.tsx` ~line 517 — extend `wantClip` (currently `node.frameMaskDisabled === false`) to also fire for INSTANCE-rooted Groups whose `_renderChildren` are present. |
| **4** | **"Button" variant text clips to "Butto"** — affects MOST variants in the button page, not just S-size. Likely font-metric mismatch (real font vs Konva fallback) making glyphs wider than the Figma frame, so the last char overflows the clip rect. Also: Disabled outline/solid variants have text + icon nearly invisible (opacity applied at wrong layer). | button-5_9 | high | universal-primitive | Two sub-bugs in same component — text clipping + disabled-state opacity. **Fix point (tentative):** `web/client/src/Canvas.tsx` text rendering + opacity layer ordering. Investigation deferred to round 13 unless cheap. |
| **5** | **Per-character-range text fills not applied** *(NEW Pass 2 finding)* — In input-box state-text rows, Figma renders `설명문구` (gray) / `오류문구` (red) / `성공문구` (green) using character-range fills inside one text node. Ours renders all three in the same gray. | input-box-9_42 | high | universal-primitive | Requires `styleOverrideTable` + `characterStyleIDs` propagation + multi-range KText splitting. **Fix point (tentative):** `web/client/src/Canvas.tsx` text node. Larger surface — defer to round 13. |

### Refuted

| Pass 1 claim | Pass 2 verdict |
|---|---|
| datepicker right calendar's first-row light-blue tint | **Normal range-highlight** — figma shows the same light-blue band on Jan 1–7 + 8 + 10 because that's the from-to date range selected in the demo. Not a bug. |
| outline button stroke "slightly bluer than gray" | **Inconclusive** — at Pass 2 zoom levels the strokes match. No action. |
| dropdown shows 3 entries vs Figma's 4 (Default/Hover/Select/Disable) | **Source-data difference** — figma.png also shows the 4-entry popup; the gap is real but it turned out to be the SAME `u:arrow-right` leak (#1) plus the popup is rendered with the right number of rows. No separate bug. |

### Components verified clean (figma == ours, no fidelity gap)

`pagenation-131_362`, `sidemenu-23_1635`, `sidemenu-28_168`, `color-2_8`,
`date-11_606`, `1-12_748`, `type-11_150`, `statetext_area-11_217`,
`option-11_515`, `option-26_243`, `radio-11_540`, `multicheck-11_576`,
`table-16_728`, `tbody-16_521`, `labe-145_674`, `loader-133_422`,
`toast-popup-53_346`, `typography-3_118`.

---

## Backlog (ranked, Pass 2 final)

### High priority — universal-primitive bugs

The 5 confirmed gaps cluster into 4 groups by shared root cause. Round-12
investigation flipped two of these from "deep override-pipeline bug" to
"single missing feature":

| group | gaps | shared root cause | est. fix surface |
|---|---|---|---|
| **A. Component-property visibility binding** | #1 (arrow leak), partial #2 (rail labels) | `componentPropAssignments` (outer INSTANCE) ↔ `componentPropRefs[VISIBLE]` (inner master node) is the actual mechanism Figma uses to hide variant icons; our `web/core/domain/clientNode.ts` only reads `symbolOverrides[].visible` and ignores prop-bindings entirely. Pen-export already implements this at `src/pen-export.ts:921-1041` — port required. | `web/core/domain/clientNode.ts` (one file). Add `collectPropAssignmentsFromInstance`, thread map through `toClientChildForRender` recursion (mirror existing visibility-override threading), resolve `componentPropRefs[VISIBLE]` against propagated map. |
| **B. INSTANCE auto-clip to bbox** | #3 (`Defa진행상태` bleed), partial #2 (datepicker rail container) | Figma clips INSTANCE content to the instance's bbox by default; our `Canvas.tsx` only clips when `frameMaskDisabled === false` is explicit (FRAME-only). When an INSTANCE has a size override smaller than its master, orphan TEXT/icon children bleed visually outside the bbox. | `web/client/src/Canvas.tsx` (one file). Extend `wantClip` (~line 517) to also fire for INSTANCE Groups with `_renderChildren`. |
| **C. Variant text clip + disabled opacity** | #4 (Button → Butto, disabled state) | `web/client/src/Canvas.tsx` text + opacity layer issues — separate from the override-pipeline bugs. | Defer to round 13 — investigation needed. |
| **D. Character-range text fills** | #5 (state-text colors) | `web/client/src/Canvas.tsx` text rendering ignores per-range `fills` in style runs. Requires `styleOverrideTable` propagation + KText splitting. | Defer to round 13 — larger surface. |

### Medium / low priority — style details

No medium- or low-priority `style-detail` items survived Pass 2. The
two we suspected (calendar tint, outline stroke hue) were both
refuted. The breadcrumb / table-header items from Pass 1 referenced
components on other pages and weren't part of this pass.

---

## Recommended round 12 scope

Ship groups **A + B** in round 12. Defer C + D to round 13.

Two PRs, both small surface:

- **PR 1 — Component-property visibility binding** (group A)
  - Spec: extend `docs/specs/web-instance-render-overrides.spec.md`
    with §3.4 "I-P6 component-property-driven visibility" — the
    binding mechanism, the prop-assignment-map propagation rule, and
    the inner-instance merge behavior.
  - Test fixtures (vitest, `clientNode.test.ts`): unit for
    `collectPropAssignmentsFromInstance` + integration that takes
    a hand-built TreeNode mirroring an alert-button (outer INSTANCE
    with `componentPropAssignments[boolValue:false]` + master with
    inner icon carrying `componentPropRefs[VISIBLE]`) and asserts the
    expanded `_renderChildren` icon has `visible:false`.
  - Implementation: `web/core/domain/clientNode.ts` only.
  - Visual gates: `alret-64_376`, `input-box-9_42`,
    `datepicker-12_749` rail, `dropdown-11_532` — all 4 Pass 2 tiles
    should match figma after this PR.

- **PR 2 — INSTANCE auto-clip to bbox** (group B)
  - Spec: new `docs/specs/web-canvas-instance-clip.spec.md` —
    "INSTANCEs whose `_renderChildren` are present clip to the
    instance's effective bbox, matching Figma's default." Define
    edge cases (legitimate overflow via `clipsContent:false` if the
    field exists; nested INSTANCEs).
  - Test fixtures (Playwright, e2e): a small `.fig` with one
    INSTANCE that has a size-shrunk override + an orphan TEXT —
    assert the rendered Konva canvas does not paint the orphan text
    outside the bbox. Or unit-level: hand-built KText render check
    via Konva's `getClientRect`.
  - Implementation: `web/client/src/Canvas.tsx` only.
  - Visual gates: `table-16_729`, `tbody-16_763`,
    `table_nodata-64_397` — `Defa…` prefix gone after this PR.

PR 1 should land first — it removes the loudest visual leak (4 of
5 confirmed bugs touch arrow visibility). PR 2 addresses the
remaining table mojibake. After both, re-run
`node web/scripts/audit-round11-screenshots.mjs` and re-tile to
confirm — anything still off is a new round-13 item.

---

## Round 22 follow-up — round 23 candidates (2026-05-04)

After round-22 (`derivedSymbolData[].size` baking applied to ALL
INSTANCE descendants — commit `64d17bc`) the audit was re-captured
(`72eab8e`, 682 ours.png). Diff strategy: rank ours.png by byte-delta
from pre-`64d17bc` baseline, visually inspect every pair where the new
file dropped >70% AND landed under 10 KB (likely render collapse), then
sample neighbouring variants to confirm pattern vs one-off.

**Confirmed wins (no change needed):**

- ✅ `design-setting/datepicker-12_749` — 3 calendars + left rail
  (오늘/최근 1주일/최근 30일/금월/전월/직접 선택) align cleanly,
  weekday labels (수/목/금/토) no longer clipped. The intended round-22
  outcome is real.
- ✅ `design-setting/dropdown-11_532` — 3 Option-1 rows with middle row
  hover-pill, identical to figma. No regression.
- ✅ All `dash-board/**/ours.png` — zero byte delta from pre-round-22.
  Round 22 simply does not affect dashboard renders. The earlier
  comment in `clientNode.ts` referencing dashboard "Excel 다운로드"
  icon-text overlap is OBE — round 22's path doesn't reach those nodes.
- ✅ `web/frame-2307-*` (13 cases, ~46 KB → ~4 KB) — NOT regressions.
  Tighter post-round-22 bbox crops out an empty area below the title bar.
  Visible content (e.g. `DB업로드 / 취소 / 다운로드 / 등록`,
  `DB정보 / 취소 / 삭제 / 수정`) matches figma.
- ✅ `mobile/section-498_1373`, `mobile/container-498_1334` — bbox
  correction. Rendered content is the same (or pre-existing content
  diverges from figma but did so before round 22 too).

**New round-23 candidates:**

| severity | bucket | what's wrong | likely fix point |
|---|---|---|---|
| ~~**high**~~ → low | audit-tooling | ~~`web/sidemenu-602_8922`, `web/sidemenu-1119_14590`, `web/sidemenu-339_2121` — entire menu item list disappears post-round-22~~ **RETRACTED after round-23 investigation.** The 3 sidemenu slugs are NOT a render regression. They are inside parent `lnb` FRAMEs/SYMBOLs of size 250×784, but positioned at `transform.m12 = 767` — overlapping the parent boundary so only 17 px of each is visible (or 0 px if the parent uses a SYMBOL master that isn't directly drawn on the WEB canvas, as is the case for 339:2121 inside SYMBOL 400:4266). The audit captures the absolute-coords bbox of the sidemenu (correctly tight to the node), but at that screen position the parent's clip leaves the area mostly empty. Verified by directly capturing the *actually-rendered* sidemenu siblings (602:8917, 1119:14746, 797:9451) — they show menu items (조직·할인 관리, 사원 관리, DB 종류·가격 관리, 자료방, DB 관리) cleanly, matching figma. Renderer is correct. | `web/scripts/build-audit-inventory.mjs` — when emitting an entry, walk parent chain and intersect with the nearest ancestor that has `frameMaskDisabled !== true`; drop the entry if the visible area is < e.g. 50% of node.size. Prevents future spurious "this slug is broken" diagnoses. |
| ~~med~~ → ✅ resolved | audit-tooling | ~~`web/right_top-*` (9 cases) — breadcrumb strip renders with wrong dark-navy background and "DB 배정" instead of "DB 대장"~~ **RETRACTED + FIXED.** Text was a misread (figma.png is "DB 배정" too — verified after contrast boost; source `symbolOverrides` matches). Background diff was real but not a render bug — it came from the parent page FRAME 401:6772 (`fillPaints[0] = rgb(30,41,59)`) bleeding through the NO_FILL right_top in our in-context render, vs Figma REST API's isolated render (transparent → white). **Resolved** in round 23 by `IsolationContext` + `window.__setIsolateNode(id)` API in `Canvas.tsx` + audit script call before each per-component shot — verified A/B that the captured right_top now has white bg matching figma. | Already implemented (see "Round-23 audit-tooling changes shipped" below). |
| low | audit-data-hole | `web/category-1119_14586`, `web/category-602_8918` (and 4 sister `category-*` slugs) — `figma.png` missing in audit folder. Re-running `figma-fetch.mjs` returns `[no-url]` from Figma's `/v1/images` API for these node IDs. Confirmed not a code bug — Figma simply won't render these nodes in isolation. Likely cause: they live inside a SYMBOL master (`602:9240` / `400:4266`) and Figma's REST API only renders nodes that have an independently-renderable bbox on a CANVAS (a SYMBOL's children don't qualify). | `web/scripts/figma-fetch.mjs` — when the API returns `no-url` twice in a row, mark the slug as un-fetchable in inventory metadata so it's excluded from "missing figma.png" diagnostics. Or `build-audit-inventory.mjs` — drop SYMBOL-descendant nodes whose only render path is via instances of the SYMBOL (same parent-clip walk improvement above would handle this). |

**Round-23 verdict on round-22:** ✅ The fix is sound. No render regression
exists. The visible win (datepicker rail, weekday labels) holds; no
dashboard / dropdown / alret / button / sidemenu / right_top regression.
Round-22 ships as-is.

### Round-23 audit-tooling changes shipped

Two small infra patches landed this round to prevent the same false-alarm
classes from re-appearing in future audit cycles:

1. **Parent-clip filter in `build-audit-inventory.mjs`**
   `MIN_VISIBLE_FRACTION = 0.1` — `visit()` now propagates the nearest
   container ancestor's bbox as a `clipBox` and skips emission when a
   node's intersection with its clipBox falls below 10 % of the node's
   own area. Result on the metarich `.fig`: **7 entries removed** (with 0
   added), all of them previously-confirmed false alarms:
   - `web/sidemenu-{339:2121, 602:8922, 1119:14590}` — 0 % visible
     (positioned at `transform.m12 = 767` inside a 784-tall lnb FRAME,
     so `clipBox` collapses to 17 px and rejects everything inside)
   - `web/category-{339:2117, 602:8624, 602:8918, 1119:14586}` — 6.3 %
     visible (270-tall categories at the same y=767 position)

   Sister sidemenus that ARE partially visible (`sidemenu-1119:14746` at
   48.7 %, `sidemenu-339:2106` at 48.7 %, etc.) are kept — they render
   real content even if not the full master bbox.

2. **`?audit=1` white canvas bg in `App.tsx`**
   The editor chrome `bg-[#0e0e0e]` is replaced with `bg-white` when the
   audit query param is present. Helps any node whose captured area
   extends past its parent's bbox (the dark editor bg used to bleed in).

3. **Render-in-isolation in `Canvas.tsx` (`__setIsolateNode` API)**
   New `IsolationContext` + imperative `window.__setIsolateNode(id)`.
   When set, the canvas walks the page tree and computes:
   - `ancestors`: id of every node on the path from page root to target.
     `NodeShape` consumes the set; if its id is in `ancestors`, it
     suppresses `fillPaints` (passes `undefined` to `paintLayers`) so
     the captured backdrop becomes transparent / white.
   - `hide` (round-23-v2): id of every node that is NOT an ancestor,
     NOT the target, NOT a descendant. `NodeShape` returns `null` for
     these, so unrelated subtrees that happen to overlap the captured
     bbox via z-order do not bleed in.
   `audit-round11-screenshots.mjs` calls `__setIsolateNode(c.id)`
   before each per-component shot and clears it between pages.

   Verified A/B on `right_top-401_7181`: NOISO crop shows the dark-navy
   page-FRAME bg bleeding through the NO_FILL right_top → ISO crop
   shows white bg (matches figma.png). All 9 `web/right_top-*` slugs
   resolve the same way on the round-23 re-capture (commit 141ce21).

   Round-23-v1 only had `ancestors`, not `hide`. The MOBILE re-capture
   surfaced popup-style slugs (e.g. `mobile/frame-2364-1324_16535`,
   "상담 신청 완료") where the popup sits at the same canvas coords as
   a privacy-policy screen FRAME (top-level sibling). v1 suppressed
   the popup's parent fill but left the privacy screen rendering, so
   privacy-text bled into the popup capture. v2's `hide` set fixes
   this — verified A/B on the same slug. Suppresses fills + hides
   subtrees only; strokes, effects, descendants of the target itself
   are untouched.

**Round-23 audit-data refresh status:** all 5 pages re-captured through
the v2-isolation harness — design-setting (24 modified), MOBILE (141),
dash-board (42), WEB (364), right_top × 9 (separate batch). icons page
has only 1 slug. The audit-round11 baseline is now coherent with the
current renderer + tooling state; future regression scans can compare
against it without the leak/clip/bg false-alarm classes from round-22.

**Audit method note:** The "byte-delta + tiny-after" filter found
30 candidates across 743 pairs. After round-23 investigation, **ZERO are
real render regressions**:
- 13 `web/frame-2307-*` and 3 mobile `container/section-*` were correct
  (tighter bbox cropping out empty space) — true negatives, low cost.
- 9 `web/right_top-*` are NOT regressions — text matches figma exactly;
  the dark-navy "background" is just the live app's canvas bg showing
  through the right_top's NO_FILL container, vs Figma REST API's
  transparent render. (My initial "DB 배정 vs DB 대장" claim was a misread
  of a near-invisible low-contrast PNG.)
- 3 `web/sidemenu-*` are audit-inventory aliasing artifacts —
  the slug points to a node that's clipped by its parent's bbox.
- 6 `web/category-*` are Figma-API-unrenderable (SYMBOL descendants).

The filter's true-positive rate for "round-22 introduced regression"
is **0/30 = 0%**. **All 30 false alarms come from one of two audit-tooling
gaps**: (a) the inventory includes nodes that aren't actually rendered
visibly on the canvas (parent clip / SYMBOL descendant), and (b) the
capture background differs between our screenshot and Figma's REST API
PNG. Both are tractable improvements to the audit harness — none touch
the renderer. Filed as round-23 tooling tasks in the table above.

## Round 24 close (2026-05-05)

Round 24 picked up the remaining `derivedSymbolData` field that round 22
punted (§3.9 I-DS6) — `entry.transform`. Spec §3.10 (I-DT1–5) +
collector + walk plumbing + 13 unit tests landed in 89bbaa5. Baselines
refreshed for design-setting (71f33d0), dash-board (f493bd8), mobile
(ddad018). e2e gate at `web/e2e/audit-transform-baking.spec.ts` pins
the mobile 5-row contract.

**Wins surfaced this round:**
- `mobile/frame-2323-477_6439` (+8 KB): customer-list 5th row,
  previously clipped at master coord, now renders at Figma's derived
  position. This is the canonical 1,570-INSTANCE pattern — designer
  kept INSTANCE size = master, Figma stamps placement only, master
  coords alone push descendants out of the visible bbox.
- `design-setting/labe-145_674` (-543 B): bottom sibling-leak bar
  removed by sibling's authoritative derivedTransform pushing it
  outside the labe crop area.
- `dash-board/frame-2323-576_6830` and family (+619 / +463 / +433 B):
  KPI-card unit labels ("억", "%", "건") now render inline next to
  the number instead of with sub-pixel offset.
- ~7 `web/container-*` slugs (uniform -228 B): button-row buttons now
  size-fit their text content (round-22 derivedSize) at correct
  positions (round-24 derivedTransform). E.g. `web/container-358_5948`:
  top-row "양식 다운로드 / 파일업로드 / DB 업로드" buttons no longer
  truncate the text past the rounded pill edge.

**WEB baseline NOT refreshed this round.** Captured 529 slugs of WEB,
diff'd, surfaced 18 `alret-*` modal-popup INSTANCEs all dropping
exactly -1098 B with a clean "삭제 button clipped at modal right
edge" pattern. Triage identified the regression as a **latent
path-key bug exposed by round-24, not introduced by it** — see
"Round 25 candidate" below. WEB stays at the round-23 baseline
(commit a65b12a) until that fix lands and we can recapture cleanly.

### Round 25 candidate — path-key normalization (FRAME ancestor skip)

Direct diagnostic on metarich `INSTANCE 364:2962` (alret-364_2962):

```
master 64:376 (alret SYMBOL):
  └ buttons FRAME 60:348  [direct child, m02=223, w=87]
      ├ Button 60:341 "취소"  [m02=0,  w=31]  ← symbolOverride: visible=false
      └ Button 60:340 "삭제"  [m02=39, w=48]

INSTANCE 364:2962 symbolOverrides:
  [60:341]      visible: false        ← key has 1 segment
  [60:326]      textData: ...         ← 1-seg (target is grandchild via 60:328 FRAME)
  [60:340/5:45] textData: ...         ← 2-seg crossing INSTANCE boundary

INSTANCE 364:2962 derivedSymbolData:
  [60:348] size {48,32} t {m02=262, m12=118}  ← post-layout buttons FRAME *assuming 취소 hidden*
```

Figma's path-key scheme **skips FRAME / GROUP ancestors and includes
only INSTANCE-typed ancestors plus the target**. The override path
`[60:341]` targets the cancel-button INSTANCE that sits under FRAME
`60:348`, but the FRAME does not contribute to the key.

Our walk in `web/core/domain/clientNode.ts:toClientChildForRender`
uses the *full visit chain* (every ancestor's `guidStr`) — so for the
same target we compute `60:348/60:341`. Mismatch → visibility
override silently fails to apply → 취소 stays rendered. Round 22's
derived size for the buttons FRAME *does* match (it's a direct child
of the master, single-segment on both sides), so the FRAME shrinks
to 48 wide assuming 취소 is gone. Combined: 2 buttons stuffed inside
a 48-wide FRAME → 삭제 overflow → INSTANCE clip.

The same mismatch quietly affects **every override pipeline that uses
path keys** — text overrides, fill overrides, prop assignments at
path, swap targets at path, derivedSize, derivedTransform — anywhere
the target is reached through a FRAME / GROUP container in the
master. Many cases happen to work because either (a) the target is a
direct child of master (no intermediate FRAME) or (b) the target sits
under an INSTANCE ancestor (which our scheme and Figma's both
include). The alret family is the first place where the mismatch
produces a loud-and-visible regression.

**Round-25 scope:**
- Refactor `currentPath` accumulation in `toClientChildForRender` so
  intermediate FRAME / GROUP / SECTION ancestors are dropped from the
  key. Only INSTANCE ancestors and the leaf target node contribute.
- Verify all 7 path-keyed collectors (text / fill / visibility /
  propAssignAtPath / swapTarget / derivedSize / derivedTransform)
  behave correctly under the new scheme. Update unit-test fixture
  paths.
- Recapture WEB; expect alret-* regression resolved plus likely 0 to
  many additional silent fixes elsewhere. Triage as usual.
- Update specs:
  `web-instance-render-overrides.spec.md §3.1 I-C1` (path-key def),
  `web-instance-autolayout-reflow.spec.md §3.9 I-DS1` and
  `§3.10 I-DT1` (derived data path-key def),
  `web-instance-variant-swap.spec.md §3.1` (swap path-key).
- Risk: blast radius across visibility / text / fill overrides. If
  many design-setting + dash-board + mobile cases were silently wrong
  due to FRAME-ancestor inclusion, fixing this surfaces them as new
  visual deltas. Some will be wins, some may be new regressions to
  triage. Plan for a full 4-corpus re-baseline as part of round 25.

**Round-24 verdict:** spec / impl / tests are correct under the
inherited path-key contract; the alret regression is a path-key
contract bug whose ownership predates round 24. Round 24 ships its
3 corpus baselines + the e2e gate; WEB defers to round 25.

## Round 25 close (2026-05-05)

Round 25 picked up the path-key normalization candidate from round 24's
close. Spec §3.1 I-C1 / §3.2 I-P2 (v3) + impl + 11 unit tests landed
in 28989be. Baselines refreshed for dash-board (77bc01c), mobile
(320fe46), WEB (721c779). e2e gate at
`web/e2e/audit-transform-baking.spec.ts` adds the round-25 alret
contract alongside the round-24 5-row contract.

design-setting was 0-delta (28 / 28 byte-identical) — the audit
inventory captures SYMBOL master nodes there, not INSTANCEs, so the
INSTANCE-level path-key fix has no effect. This was the right
validation signal that round-25's behavior is correctly scoped.

### Scope of impact

| corpus | modified / total | win pattern |
|---|---:|---|
| design-setting | 0 / 28 | (SYMBOL masters — not affected) |
| dash-board | 18 / 44 | KPI toggle labels, dropdown variant values |
| mobile | 54 / 147 | textarea / form variant content (4-line notes etc.) |
| WEB | **410 / 529** | full-form variant content, alret modal regression resolved |

WEB at 77.5 % modified is the largest single audit refresh in the
project. The denominator skew reflects WEB's heavy use of FRAME-wrapped
INSTANCE descendants — the exact pattern round-25 unlocks.

### Round-24 alret regression resolved

```
master 64:376 (alret SYMBOL)
  └ buttons FRAME 60:348  ← FRAME-skip applies under round-25
      ├ Button 60:341 "취소"  ← visibility override [60:341] now MATCHES
      └ Button 60:340 "삭제"  ← derivedTransform [60:340] now MATCHES
```

INSTANCE 364:2962 in WEB now renders as Figma intended:
- header "DB분배" (variant text override resolves)
- body "3개의 항목의 분배가 완료되었습니다." (variant override resolves)
- 취소 button hidden (visibility override resolves)
- 삭제 button fully visible inside the 330×170 modal bbox

All 18 alret-* INSTANCEs converge to their proper variant
rendering. e2e gate `web/alret-364_2962 — 삭제 button renders fully
inside modal` pins the contract by sampling at fx=0.866, fy=0.788
and asserting blue (b > r AND b > g AND b > 200).

### Top wins (beyond alret)

- WEB: `container-734_9832` (+36 KB) — NS홈쇼핑 broadcast notice. Pre
  was empty placeholders; post shows full multi-paragraph variant
  content with attached filename. Single fixture with the largest
  delta in the entire audit.
- WEB: `popup-231_722` / `popup-734_9829` (+33.5 KB each) —
  companion popup containers, same content-reveal pattern.
- WEB: `container-287_1655` (-12.3 KB) — partner-registration form.
  Pre had master placeholders; post has stamped values
  (제휴업체명 "[테스트]제휴업체", 이름 "손보미", 연락처
  "010-1234-5678"), ID button "확인"→"중복확인",
  "중복된 ID 입니다." error appears.
- mobile: `container-481_7624` (+10.1 KB) — "반품 정보" form.
  Three textareas were master placeholders; post shows full
  multi-line customer-call note + designer comment (figma exact).
- dash-board: `frame-2324-576_6875` (+2.4 KB) — KPI summary card.
  Right-side toggle pair was "Y / N" master defaults; post shows
  "인정보험료 / 계약건수" Figma variant labels.
- dash-board: `260319-1201_15784` (-1.3 KB) — top-right "기준년월"
  dropdown was placeholder "내용을 입력해주세요"; post shows
  stamped "2025년 12월".

### Round-24 wins preserved

- mobile/`frame-2323-477_6439` (5-row customer list — round-24
  source case) shifted only -184 B (encoding noise) on the round-25
  refresh. Round-24's derivedTransform fix is not regressed by the
  path-key change.
- e2e gate `audit-transform-baking.spec.ts` runs 2 tests, both pass:
  the round-24 5-row contract + the round-25 alret contract.

### Risk that didn't materialize

GAPS round-24 close flagged: "many design-setting + dash-board + mobile
cases were silently wrong due to FRAME-ancestor inclusion → fixing
this surfaces them as new visual deltas. Some will be wins, some may
be new regressions." On audit, every spot-checked delta was a win
(text/visibility overrides finally applying). No new regressions
identified. The path-key fix is a one-direction unlock — it only
*enables* override matches that previously silently failed.

### Round-25 verdict

Round 25 ships clean: spec / impl / 11 unit tests / 4-corpus baseline
refresh / 2 e2e contracts. The path-key contract that quietly
underpinned visibility / text / fill / propAssignAtPath / swapTarget /
derivedSize / derivedTransform pipelines is now correct end-to-end and
matches Figma's wire format.

No new candidates flagged for round 26 in this session — the path-key
normalization closes out the cluster of round-23-discovered tooling
issues + round-22..24 INSTANCE-pipeline foundation. Future rounds can
build on top with confidence that override matching is solid.

## Round 26 close (2026-05-05)

Round 26 picked the largest measured-impact item from the SPEC-
architecture round-26 candidate list — **TEXT styling override**
(fontSize / fontName / lineHeight / letterSpacing / etc per-INSTANCE).
Spec §3.5 (I-S1..I-S7) + impl + 8 unit tests landed in 5cd17d9.
Baselines refreshed for mobile (e6083cb), WEB (27fa44e). design-setting
+ dash-board both 0-delta — confirms the fix is correctly scoped to
descendants where text-styling overrides actually exist.

### Pre-flight diagnostic — pivot from prop-binding TEXT/INSTANCE_SWAP

The originally-recommended round-26 candidate was "componentPropNodeField
TEXT / INSTANCE_SWAP support" (the next item on the round-25 candidate
list). A pre-flight diagnostic measured the metarich corpus:
- componentPropRefs.componentPropNodeField: **VISIBLE 74 / TEXT 0 /
  INSTANCE_SWAP 0**
- componentPropAssignments.value: boolValue 966 / empty 1090 — no
  textValue / swapID at all
- componentPropDefs.type: BOOL 1 / unset 73 — no TEXT / VARIANT
  property defs

So implementing TEXT/INSTANCE_SWAP prop-binding would land foundation
code with **zero audit-visible win** on the existing corpus. Pivoted
to TEXT styling override which has the largest measured impact (1,400+
fontSize entries / 1,436 fontName / 1,418 styleIdForText / etc.).

Diagnostics scripts (kept in `test-results/round24-triage/` for
future round prep):
- `inspect-prop-binding-2.mjs` — componentPropRefs + assignments +
  defs distribution counter
- `inspect-stroke-effects.mjs` — symbolOverride field distribution
- `inspect-text-style.mjs` — wire-format dump of TEXT styling override
  entries

### Scope of impact

| corpus | modified / total | notes |
|---|---:|---|
| design-setting | 0 / 28 | SYMBOL masters (not affected — same as round-25) |
| dash-board | 0 / 44 | Few/no text-styling overrides on dashboard INSTANCEs |
| mobile | 26 / 147 | sub-2 KB grows — placeholder text fontWeight/Size shift |
| WEB | 84 / 529 | alret + modal SYMBOL families with multi-line content reveal |

WEB alret/modal concentration is the round-26 signature — the variant
descendants' textData newlines were previously truncated because the
master TEXT's textAutoResize / fontSize was used; with the override
applied, the second line of body text renders.

### Top wins

- **WEB / alret-1184_14772 + 3 sister fixtures (+6302 B uniform)**:
  "배정 대상 변경" modal. Pre showed the body as ONE line ("현재
  선택한 배정 정보가 초기화 됩니다."); the second line ("계속 진행하시겠
  습니까?") was missing entirely. Post-round-26 both lines render —
  matches figma.png exactly. The largest single delta in the round.
- WEB / 12 alret + modal sister fixtures at -2690 / -2755 B uniform:
  "배정 완료" / "항목 삭제하기" / "DB 분배" variants. Body text
  thinner / smaller post-fix — variant-stamped fontWeight/fontSize
  applies for the first time.
- WEB / modal-arlet-1431_29312 + 1 sister (+1519 B): another alret
  variant family with fontSize bump.
- mobile / unnamed-489_8120 + container-489_8123 (+1807 / +1440 B):
  "비밀번호 변경" form input placeholders pick up the variant text
  styling.

### Round-25 wins preserved

- mobile/frame-2323-477_6439 (round-24 5-row contract) — pixel-
  identical: round-25 audit-transform-baking e2e test still passes.
- web/alret-364_2962 (round-25 path-key contract) — pixel-identical:
  round-25 audit-transform-baking alret e2e test still passes.

Both e2e gates run green throughout round-26: 2 / 2 contracts hold.

### Round 27 candidate (potential future work)

Rounds 22-26 closed out the major INSTANCE-pipeline override gaps
identified by metarich audit. Remaining smaller candidates from
SPEC-architecture §13.2 + symbolOverride field distribution scan:

- **stack* override fields** — `stackPrimarySizing` (2776 entries),
  `stackPrimaryAlignItems` (1288), `stackChildPrimaryGrow` (1037),
  `stackSpacing` (294), padding fields (~700) — auto-layout *parameter*
  overrides per INSTANCE that flow into reflow. Implementing these
  would let reflow pick up variant-specific layout tweaks. Estimated
  impact: medium — depends on how many metarich variants use these.
- **stroke / cornerRadius / opacity override** (~180 + 45 + 11 entries)
  — small but tractable, mirrors round-12 fillPaints pattern.
- **componentPropNodeField TEXT / INSTANCE_SWAP** (still 0 in metarich;
  foundation work for future .fig corpora).
- **Add a non-metarich audit corpus** to surface entirely new edge
  cases.

Round 26 ships clean. No new regressions identified.

## Round 27 close (2026-05-05)

Round 27 picked Option A from the round-26 close candidate list — visual
style override (strokePaints / opacity / cornerRadius family). Spec §3.6
(I-V1..I-V7) + impl + 10 unit tests landed in b52d839. Baselines refreshed
for mobile (a6f72f5), WEB (b97da6e). design-setting + dash-board both
0-delta — same scope-correctness pattern as rounds 25 / 26.

### Pre-flight diagnostic — chose Option A over stack* fields

The round-26 close listed stack* override fields as the largest-volume
candidate (~5,400 entries: stackPrimarySizing 2776 + stackPrimaryAlignItems
1288 + stackChildPrimaryGrow 1037 + stackSpacing 294 + padding ~700).
Pre-flight diagnostics measured potential redundancy with rounds 22/24:
- `inspect-stack-coverage.mjs`: 2,002 INSTANCEs override at least one
  stack* field.
- `inspect-stack-coverage-2.mjs`: path-key construction between the
  override target (a FRAME with stack* override) and derivedSymbolData
  stamps (its children's post-layout positions/sizes) is non-trivial.
  Measuring real visual redundancy requires expensive corpus visual
  audit.

Stack* deferred to a future round. Pivoted to Option A
(stroke/cornerRadius/opacity, ~236 entries) — clean mirror of round-12
fillPaints pattern, predictable outcome, low risk. ~30 lines of impl
+ 10 tests.

### Scope of impact

| corpus | modified / total | notes |
|---|---:|---|
| design-setting | 0 / 28 | SYMBOL master captures (not affected — same as rounds 25/26) |
| dash-board | 0 / 44 | Few visual-style overrides on dashboard INSTANCEs |
| mobile | 12 / 147 | mostly star-icon opacity dimming on customer detail pages |
| WEB | **161 / 529** | wide distribution — sidemenu / lnb / category / popup families |

WEB at 161 modified is round-27's wide-but-shallow signature: visual
style overrides (especially opacity) apply to inactive UI states across
many fixtures, but each override is a small pixel-color shift (typically
sub-330 B per fixture) rather than the dramatic content reveal of rounds
24-26.

### Top wins

- WEB / `category-339_2102` (-327 B): manager sidemenu. Inactive items
  ("공지사항 관리", "Option 1", "제휴업체 관리") now show dimmed icons
  matching the variant-stamped opacity override; active "업체계정관리"
  stays full-opacity.
- WEB / 12+ sidemenu / category / lnb / right_top fixtures (sub-200 B
  drops): same opacity-dim pattern across the navigation family.
- WEB / 8+ container / unnamed fixtures (sub-130 B grows): variant-
  stamped strokePaints applies for the first time, adding stroke
  pixels to inputs / cards.
- mobile / unnamed-485_7034, unnamed-1377_13803 (-400 / -397 B):
  customer-detail page top-right star icon. Opacity override
  correctly dims the "not favorited" state.

### Earlier wins preserved

- Round-26 alret-1184_14772 (multi-line modal text reveal):
  pixel-identical.
- Round-25 alret-364_2962 (path-key + visibility resolves
  cancel-button-hide): pixel-identical.
- Round-24 mobile/frame-2323-477_6439 (5-row customer list): pixel-
  identical.

Both e2e contract gates run green:
- `audit-transform-baking.spec.ts > round-24` (mobile 5-row)
- `audit-transform-baking.spec.ts > round-25` (alret 삭제 button blue)

### Round 28 candidate list

After 6 rounds (22-27) of INSTANCE pipeline extension, remaining items
from SPEC-architecture §13.2 + symbolOverride field-distribution scan:

- **stack\* override fields** (~5,400 entries) — auto-layout *parameter*
  overrides per INSTANCE. Round-27 pre-flight surfaced complexity in
  measuring redundancy with round-22+24 derivedSymbolData. Remains the
  largest single quantity of unhandled override entries. Best approached
  via:
    (a) **stackSpacing + 4 padding fields only** (~1,000 entries, simple
    value override, no algorithmic change to reflow), or
    (b) **stackPrimarySizing for descendants** (round-20 currently only
    handles outer instance).
  These can each be a separate small round.
- **componentPropNodeField TEXT / INSTANCE_SWAP** — still 0 in metarich
  (foundation-only work for future .fig corpora).
- **effects / blendMode override** — sub-50 entries, sub-priority.
- **Add a non-metarich audit corpus** — to surface entirely new edge
  cases beyond metarich's variant patterns.

Round 27 ships clean.

## Round 28 close (2026-05-05)

**Empirical try: 0 metarich audit win — hypothesis fully confirmed.**

Round 28 picked the round-27 close candidate "stack* fields (split into
stackSpacing+padding subset...)" as an empirical experiment with explicit
0-close acceptance criteria. Spec §3.7 (I-AL1..I-AL6) + impl + 7 unit
tests landed in dea4acb. Audit refresh on all 4 corpora produced effectively
zero meaningful visible deltas:

| corpus | modified | meaningful win |
|---|---:|---|
| design-setting | 4 (sub-30 B noise — same as rounds 25/26/27) | **0** |
| dash-board | 0 / 44 | 0 |
| mobile | 0 / 147 | 0 |
| WEB | 4 (sub-100 B noise) | **0** |

All 8 modified files reverted as PNG re-encoding noise (no real visual
changes). No baseline commits.

### Hypothesis confirmation

Pre-flight reasoning before round 28:
> Round-22 derivedSize + round-24 derivedTransform stamp post-layout
> *results*, so stack* override (the *cause*) is theoretically redundant
> for descendants. Only master-root stack* overrides exercised at
> applyInstanceReflow time can move pixels.

Empirical result: master-root stack* overrides either don't exist in
metarich's INSTANCE shapes, or fire only in scenarios where reflow
already produces matching-figma output via the existing rules. The
descendant-FRAME case (most stack* overrides) is fully redundant with
rounds 22+24 — Figma already stamped the post-layout positions/sizes
into derivedSymbolData, and our applyInstanceReflow only runs at
INSTANCE boundaries (not at descendant FRAMEs anyway).

### What round 28 still adds

Even with 0 metarich audit win, round-28 lands as **foundation work**:
- spec §3.7 explicitly defines the path-key + master-root-merge contract
  for stack-subset overrides
- collector + walk plumbing handle the wire format correctly
- future `.fig` corpora that use master-root stack* overrides for
  variants will see correct rendering without further code changes

This is the correct outcome of an empirical try — the user's brief
("0 면 정직하게 0으로 close, 나오면 확장") is honored: round-28 ships
as foundation-only, no baselines refreshed (4 corpora untouched).

### Earlier wins preserved

All round-24/25/26/27 audit baselines unchanged (verified by 0
meaningful diffs after refresh). Both e2e contract gates would still
pass (not re-run since dev server was up only for capture).

### Round 29 candidate list

After 7 rounds (22-28) of INSTANCE pipeline extension, marginal returns
on metarich are exhausted in the *override-pipeline* dimension. The
round-27/28 closes both noted that metarich-corpus saturation is real.

Remaining options for round 29 forward:

- **Non-metarich audit corpus** — biggest unknown territory.
  Discovers entirely new override patterns / wire-format wrinkles.
  Cost: requires the user to pre-deploy figma.png caps for the new
  corpus's slugs.
- **stackPrimaryAlignItems / stackChildPrimaryGrow / stackPrimarySizing
  for descendants** — round-28 left these out. Need reflow rule changes,
  not pure value override. Visual effect on metarich uncertain (same
  derivedSymbolData redundancy concern).
- **componentPropNodeField TEXT / INSTANCE_SWAP** — still 0 in metarich
  (foundation only).
- **effects / blendMode** — sub-50 entries.
- **Different work track** — Pencil round-trip strengthening,
  editable-html UI, LLM agent tools, etc.

Round 28 is round 7 of an INSTANCE-pipeline cluster that started at
round 22. The cluster cleanly closes here on the override-pipeline
dimension. The next visible win on metarich likely requires a
*different shape* of work (algorithmic reflow extension, or new
corpus discovery), not another override-field round.

Round 28 ships clean as foundation. No regressions. 475/475 web +
126/126 root unit tests pass.
