# Round 11 — Figma vs figma_reverse fidelity gaps

This file lists gaps found by visually diffing each component on the
`design setting` page against Figma's actual render.

**Findings status (2026-05-03):**
- Pass 1 done — gaps inferred from `ours.png` inspection alone, plus
  cross-check with the overview Figma screenshot the user shared
  (`docs/스크린샷 2026-05-03 155402.png`).
- Items marked `[needs figma]` are uncertain; please drop a
  `figma.png` into the matching folder for confirmation.
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

## Backlog (ranked)

### High priority — universal-primitive bugs that recur across components

| # | title | components affected | bucket |
|---|---|---|---|
| 1 | **Instance visibility overrides leak at depth ≥ 3** — `u:arrow-right` is left visible inside Input Box and Alert action buttons; should be hidden by the source instance's per-path override. | input-box, alert, possibly toast-popup buttons | universal-primitive |
| 2 | **Calendar-rail text overrides fall through for some path slices** — `최근 1주일 / 1개월` etc. become duplicated `최근 / 최근 / 쥼월`. | datepicker (and likely any deeper INSTANCE-of-INSTANCE) | universal-primitive |
| 3 | **Text override append vs replace** — `Defa이람상태` table-cell text suggests overrides concatenate when both old and new are present. | table-a (and likely table-b) | universal-primitive |
| 4 | **Variant text width clipping** — "Button" text in S-size variants cuts to "Butto". | button | universal-primitive |

### Medium priority — style details that would improve fidelity

| # | title | components affected | bucket |
|---|---|---|---|
| 5 | Right calendar first-row light-blue tint — verify against Figma whether this is intentional range-highlight or stray multi-paint. | datepicker | style-detail |
| 6 | Outline button stroke hue — verify it's neutral gray, not slightly blue. | button | style-detail |

### Low / nice-to-have

| # | title | components affected | bucket |
|---|---|---|---|
| 7 | Breadcrumb current-page bolder/darker. | breadscrum | style-detail |
| 8 | Table header row bolder than body. | table-a, table-b | style-detail |

---

## Recommended round 12 scope

Pick the four `High priority` items — they share two underlying bugs:

- **#1 + #2**: both are about instance-override path resolution at depth ≥ 3.
  One fix in `web/core/domain/clientNode.ts` (depth-aware path keys for both
  visibility AND text overrides) likely resolves both, plus latent dupes
  elsewhere.
- **#3**: text-override append-vs-replace — small targeted fix.
- **#4**: variant text clip — separate fix.

A single round 12 spec covering "instance override correctness at depth
≥ 3 + text-override replace semantics + variant text clip" is a good
shippable unit. Style-detail items can wait for round 13.
