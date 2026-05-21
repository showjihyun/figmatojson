# spec/pen-export-layout-translation

| Field | Value |
|---|---|
| Status | Approved |
| Implementation | `src/pen-export.ts` (`layoutFromNode`, `omitDimensions`, `computeFillContainer`, `shouldOmitPosition`, `reflowMasterChildren`) |
| Tests | `test/pen-export.test.ts` (within available scope) — one assertion per axis-level mapping in this spec |
| Siblings | `SPEC-figma-to-pencil.md §4` (size policy *target* — pencil's TQ/uw/VZ functions), `web-instance-pipeline.spec.md §7` (web-side reflow), `CONTEXT.md §Auto-layout` (intentionally punted area — this spec fills it in) |

## 1. Goal

The area `CONTEXT.md` intentionally left undocumented — the *function-level mapping in our code* that converts Figma's stack* fields into Pencil's layout/gap/padding/sizing. Where SPEC-figma-to-pencil.md §4 narrates *Pencil's* algorithm (TQ/uw/VZ functions), this spec specifies how *our pen-export.ts* functions implement that algorithm.

`reflowMasterChildren` additionally — at INSTANCE expansion time, it is responsible for *re-placing* the master tree to match the instance size. It is a different code path from the web-side `applyInstanceReflow` (`web-instance-pipeline.spec.md §7`) but carries the same intent — this spec is the single source for the pen-export-side contract.

## 2. Function-responsibility mapping

| Function | Input | Output | SPEC-figma-to-pencil correspondence |
|---|---|---|---|
| `layoutFromNode(data)` | node.data | `{ layout, alignItems, justifyContent, gap, padding }` | §4 (size policy on the *container* side) |
| `omitDimensions(data, type, parentData)` | node + type + parent.data | `{ width: bool, height: bool }` | §4.2 `uw/VZ` (size emit/omit) |
| `computeFillContainer(data, parentData, type?)` | node + parent.data | `{ width: bool, height: bool }` | The FillContainer branch of §4.1 `TQ` |
| `shouldOmitPosition(data, parentData, parentIsInstanceReplaced, type, effectiveVisible)` | node + parent + flag + type + visibility | `bool` | §4.3 (explicit position vs omit) |
| `reflowMasterChildren(children, masterData, masterSize, instSize)` | INSTANCE expansion children + master.data + the two sizes | new children[] | (Parallel with web-instance-pipeline §7) |

## 3. `layoutFromNode` — Figma stack* → Pencil layout

### 3.1 Layout-direction mapping

- I-L1 If `data.stackMode` is absent / `'NONE'` / `'GRID'`, return `{ layout: 'none' }`. **GRID is a fallback** — Pencil does not support it, so we demote to 'none'.
- I-L2 `'HORIZONTAL'` → Pencil layout `'row'`.
- I-L3 `'VERTICAL'` → Pencil layout `'column'`.

### 3.2 Alignment mapping

- I-L4 `stackPrimaryAlignItems` (Figma) → `justifyContent` (Pencil):
  - `MIN` (or undefined default) → `flex-start`
  - `CENTER` → `center`
  - `MAX` → `flex-end`
  - `SPACE_BETWEEN` → `space-between`
  - `SPACE_EVENLY` → `space-evenly`
- I-L5 `stackCounterAlignItems` (Figma) → `alignItems` (Pencil):
  - `MIN` (or undefined) → `flex-start`
  - `CENTER` → `center`
  - `MAX` → `flex-end`
  - `BASELINE` → `baseline` (the mixed-baseline case that includes TEXT)

### 3.3 Gap and padding

- I-L6 `gap = stackSpacing` (number, default omit). Negative values are allowed (Figma's overlap layout) — Pencil carries them as-is.
- I-L7 `padding`: the `getPadding(data)` helper returns a *4-tuple*:
  - Prefer `stackPaddingLeft / Right / Top / Bottom`
  - Fall back to `stackHorizontalPadding` (shared left/right) + `stackVerticalPadding` (shared top/bottom) when per-side is absent
  - Fall back to `0` when both are absent
- I-L8 Padding serialization shapes:
  - All four sides equal → a single number
  - Two pairs equal (`top===bottom && left===right`) → `[v, h]` 2-tuple
  - Otherwise → `{ top, right, bottom, left }` object

## 4. `omitDimensions` — width/height emit decision

Decides emit (false) / omit (true) independently per axis.

### 4.1 TEXT branch (highest priority)

- I-O1 When `nodeType === 'TEXT'`, decide by `data.textAutoResize` (ignore other fields):
  - `'WIDTH_AND_HEIGHT'` (Figma's "Auto width") → `{ w: omit, h: omit }`.
  - `'HEIGHT'` (Figma's "Auto height") → `{ w: emit, h: omit }`.
  - `'NONE'` / `'TRUNCATE'` (or default) → `{ w: emit, h: emit }` — explicit sizing.

### 4.2 Auto-layout-container branch

When the node itself is a stack container (`stackMode in {HORIZONTAL, VERTICAL}`).

- I-O2 Omit rule for the *primary axis* (HORIZONTAL → width, VERTICAL → height):
  - `stackPrimarySizing === 'FIXED'` → emit (Pencil `Fixed`).
  - Otherwise (undefined / `'AUTO'` / `'RESIZE_TO_FIT_*'`) → omit (Pencil `FitContent` — size determined by children).
- I-O3 Omit rule for the *counter axis*:
  - `stackCounterSizing === 'FIXED'` or undefined → emit (Pencil `Fixed` — the default for counter is FIXED).
  - `stackCounterSizing === 'RESIZE_TO_FIT_*'` or `'AUTO'` → omit.
- I-O4 GRID stackMode is treated as *non-auto-layout* — falls through to §4.3 (Pencil does not support it).

### 4.3 Regular nodes (all cases that are not auto-layout containers)

- I-O5 *Always emit* — `{ width: false, height: false }`. Pencil convention: even children of auto-layout parents emit sizes explicitly (different from Figma, where the parent dictates layout). Conformance with the Pencil paste reference takes priority.

## 5. `computeFillContainer` — fill_container annotation decision

- I-F1 When the parent is not a stack container (`!parentStack || parentStack === 'NONE' || 'GRID'`) → `{ width: false, height: false }`.
- I-F2 Child's *layoutGrow*: when `data.stackChildPrimaryGrow ?? data.layoutGrow` is 1 → *primary axis fill* (`primaryFill = true`).
- I-F3 Child's *layoutAlign*: when `data.stackChildAlignSelf ?? data.layoutAlign` is `'STRETCH'` → *counter axis fill* (`counterFill = true`).
- I-F4 Additional verification for STRETCH: it is a true fill only when the child's counter-axis size differs from the parent's counter-available (size - padStart - padEnd) by *less than 0.01*. If the difference is larger, demote to `counterFill = false` — handles cases where Figma stamps `STRETCH` but the actual sizes do not match (the designer's intent vs the currently baked result mismatch).
- I-F5 Axis mapping:
  - `parentStack === 'HORIZONTAL'` → `{ width: primaryFill, height: counterFill }`.
  - `'VERTICAL'` → `{ width: counterFill, height: primaryFill }`.
- I-F6 Pencil serialization follows the `fill_container` / `fill_container(N)` policy of SPEC-figma-to-pencil §4.2 — the caller converts this function's boolean output via that same spec.

## 6. `shouldOmitPosition` — x/y emit decision

Decides whether to emit a child's `transform.m02 / m12` into the .pen output.

- I-S1 When the parent is not a stack container → emit (return false). Includes NONE/GRID.
- I-S2 When the child's `stackPositioning === 'ABSOLUTE'` (Figma's floating) → emit.
- I-S3 When the child is *effectively hidden* (`effectiveVisible === false`) → emit. A node removed from flow has no position-deciding mechanism, so explicit is required.
- I-S4 TEXT nodes → always omit (regardless of textAutoResize, ignoring `_showPos`) — Pencil text is auto-placed as part of layout; no explicit position.
- I-S5 `_showPos === true` marker → emit. A marker stamped by `reflowMasterChildren` (the LAST one of an overlap-group, or every child in a primary-shrunk case).
- I-S6 When the parent is an INSTANCE-replacement result (`parentIsInstanceReplaced === true`) and the child's `_showPos` is not explicit `false` → emit. Pencil behavior: an INSTANCE-replaced parent *always* annotates children positions by default.
- I-S7 Otherwise → omit (auto-layout flow decides).

## 7. `reflowMasterChildren` — master child re-placement at INSTANCE expansion

When the INSTANCE's effective size differs from the master size, *simulate* the master's stack contract in code and align child positions/sizes to the instance. Parallel to the web-side `applyInstanceReflow` (`web-instance-pipeline §7`).

### 7.1 Trigger conditions

- I-R1 master must be a stack container (`stackMode in {HORIZONTAL, VERTICAL}`). For NONE/GRID, immediately return children as-is.
- I-R2 Both `masterSize` and `instSize` must be defined. If either is absent, no reflow.
- I-R3 Axis naming: `isHorizontal = stackMode === 'HORIZONTAL'`. *primary* = the primary axis (HORIZONTAL → x, VERTICAL → y); *counter* = the opposite.

### 7.2 Counter-axis processing

- I-R4 `availCounter = instCounter - padStart - padEnd` (the available length along the counter axis).
- I-R5 STRETCH child (`stackChildAlignSelf === 'STRETCH'`): *recompute* the counter-axis size to `availCounter`. The original master size is preserved on the `_masterCounterSize` marker — used as N for Pencil's `fill_container(N)` annotation.
- I-R6 Recompute counter-axis position (when the child size changed or instance counter ≠ master counter):
  - `stackCounterAlignItems === 'CENTER'` → `padStart + (availCounter - childCounterSize) / 2`.
  - `'MAX'` → `instCounter - padEnd - childCounterSize`.
  - Otherwise (default MIN) → `padStart`.
- I-R7 Children with `_showPos === true` (explicit position) *skip counter recomputation* — preserves the exact master position.

### 7.3 Primary-axis processing

- I-R8 Compute `expectedPrimary[i]` (only for MIN alignment):
  ```
  cur = padStart;
  for each child: expectedPrimary.push(cur); cur += childPrimary + gap;
  ```
  For CENTER / MAX / SPACE_*, fill expectedPrimary with NaN (positions cannot be decided by simple accumulation — the caller computes or emits explicitly).
- I-R9 `primaryShrunk = instPrimary < masterPrimary` (the case where instance < master). In this case, mark *every child* with `_showPos = true` → auto-flow cannot decide, so explicit emission is forced.
- I-R10 *Overlap-group* detection: cases where master has *multiple children* at the same primary position. Per group, mark only the LAST one with `_showPos = true` + *re-place* it to the expected-flow position. The other overlap children are omitted (decided by auto-flow). Matches Pencil's behavior.

### 7.4 Marker emission

The *internal markers* stamped by `reflowMasterChildren` on children (used only by the Pencil output conversion stage, never appearing directly in the .pen output):

- I-R11 `_showPos: boolean` — consumed by the §I-S5 / I-S6 branches of `shouldOmitPosition` (§6). true → emit position, false → omit hint, undefined → use default logic.
- I-R12 `_masterCounterSize: number` — the *original master counter size* of a STRETCH child. Used as N in the Pencil `fill_container(N)` serialization — a fallback when the parent is pasted into a non-layout context.

### 7.5 Determinism

- I-R13 Same input → same output. Float32 truncation is enforced via `Math.fround` (compatible with Pencil's Skia-internal float32 — same policy as the "1 ULP residual error" in SPEC-figma-to-pencil §5.6).
- I-R14 No in-place mutation — the original children array is left intact and a new object array is returned (unchanged children reuse the same reference).

## 8. Call graph

```
convertNode(treeNode)                     // pen-export's main conversion
  ├ layoutFromNode(data)                  // parent side: layout/gap/padding
  ├ omitDimensions(data, type, parent)    // child side: w/h emit decision
  ├ computeFillContainer(data, parent)    // child side: fill_container annotation
  ├ shouldOmitPosition(data, parent, ...) // child side: x/y emit decision
  └ (At INSTANCE expansion:)
     reflowMasterChildren(children, ...)  // master child re-placement → returns the 4 above
```

- I-G1 The 5 functions in this spec have a *fixed call order* — during child traversal `convertNode` calls the 4 functions once per child, and additionally calls reflow on the INSTANCE branch only.
- I-G2 Other modules do not call these functions directly (`pen-export.ts`-internal helpers). The web-side equivalent contract is a separate implementation (`applyInstanceReflow` in `clientNode.ts`) — the two implementations being result-compatible is part of round-trip verification.

## 9. Non-goals

- ❌ **Accurate GRID layout translation** — unsupported by Pencil, demoted to layout='none'. Children laid out under Figma GRID fall back to explicit position.
- ❌ **Binary compatibility with the web-side `applyInstanceReflow`** — the two implementations are *result-compatible* but not guaranteed *byte-identical*. Round-trip verification (canvas-diff audit) measures the difference.
- ❌ **Position modifiers beyond stackPositioning** — unsupported additional modifiers carried by Pencil v1.1.55 (if any).
- ❌ **The 0.01 STRETCH tolerance itself** — changes to the hardcoded tolerance value of `computeFillContainer` (§I-F4) are out of scope. Measure impact with round-trip audit and split into a separate round.
- ❌ **expectedPrimary calculation for CENTER/MAX/SPACE_\*** (the NaN fallback of §I-R8). Currently the caller handles it — future work is to add accurate position calculation logic.

## 10. Resolved questions

- **Does `layoutFromNode` cover *all* of Figma's stack mappings?** Almost — some edge cases like `BASELINE` align are shared with `web/client/src/lib/textStyle.ts`. Layout itself is single-sourced in this function.
- **Why does the TEXT branch of `omitDimensions` precede the others?** TEXT sizing is *content-driven* in both Figma and Pencil — auto-layout cannot override it. textAutoResize is always the answer, so it must come before the auto-layout-container branch.
- **Is the 0.01 tolerance in `computeFillContainer` too loose?** The size Figma carries is truncated to 5 digits after `Math.fround` — 0.001-level error is the baseline. 0.01 is a safety margin. On regression, reduce to 0.001 with verification.
- **Why does `reflowMasterChildren` not *share code* with the web side?** pen-export operates on `TreeNode` (kiwi-native), while the web-side `applyInstanceReflow` operates on `DocumentNode` (post clientNode conversion). The two types differ in shape and the consumers also differ (CLI .pen output vs web canvas rendering). Building a shared layer would cost more in *type generalization* than the duplication is worth — intentional duplication.
- **What about turning `_showPos` / `_masterCounterSize` markers into direct .pen emission?** Not possible — Pencil's .pen schema has no such fields. The spec's intent is to carry them as internal hints and convert into `fill_container(N)` / explicit `x/y` in the final serialization stage.
