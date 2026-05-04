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
   When set, the canvas walks the page tree, collects every ancestor id
   of the target, and any `NodeShape` whose own id is in that set
   suppresses its `fillPaints` (passes `undefined` to `paintLayers`).
   Net effect: only the target node + its descendants paint visible
   pixels in the captured area — same scope as Figma REST API's render.
   `audit-round11-screenshots.mjs` now calls `__setIsolateNode(c.id)`
   before each per-component shot and clears it between pages.

   Verified A/B on `right_top-401_7181`: NOISO crop shows the dark-navy
   page-FRAME bg bleeding through the NO_FILL right_top → ISO crop
   shows white bg (matches figma.png). All 9 `web/right_top-*` slugs
   are expected to resolve the same way on next audit re-capture. The
   change suppresses fills only — strokes, effects, descendants of
   ancestors are untouched, so unrelated visual properties don't shift.

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
