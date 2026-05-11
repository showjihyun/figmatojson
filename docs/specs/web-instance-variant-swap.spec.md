# spec/web-instance-variant-swap

| Item | Value |
|---|---|
| Status | Draft (round 16) |
| Implementation | `web/core/domain/clientNode.ts` (`collectSwapTargetsAtPathFromInstance` + INSTANCE expansion branch) |
| Tests | `web/core/domain/clientNode.test.ts` (hand-built fixtures) |
| Siblings | `web-instance-render-overrides.spec.md` §6 out-of-scope item ("Variant swap"); this spec retires that item. |

## 1. Goal

Figma's "swap component instance" mechanism. When an outer INSTANCE's `symbolOverrides[]` entry carries `overriddenSymbolID`, the master of the INSTANCE descendant referenced by that path is swapped for a different master. The 6th option of the meta-rich Dropdown (the "custom select" label) uses this mechanism — the default option master (11:514, "state=default") is swapped for the selected-state master (15:287, "state=selected"), and the swap target's child TEXT (15:288) is overridden with the "custom select" string.

`pen-export.ts:convertNode` (lines 1064-1080) already handles swap via `instData.overriddenSymbolID ?? sd.overriddenSymbolID` — after the outer override has been patched into the inner instance's data by `applySymbolOverrides`. Our web side does not use `applySymbolOverrides` but instead a path-keyed override Map; therefore swap targets must be collected separately into a path-keyed Map.

## 2. Data shape

```ts
// one entry inside the outer INSTANCE's symbolOverrides[]:
{
  guidPath: { guids: [{ sessionID, localID }, ...] },  // which inner INSTANCE is the target
  overriddenSymbolID: { sessionID, localID },          // which master to swap to
  componentPropAssignments: [...],                     // (optional) prop assignments after swap
  // the visible field is usually absent — swap itself signals visibility intent (see §3.3)
}
```

The "custom select" case in the meta-rich Dropdown:
- Outer Dropdown (15:279) symbolOverride entry: `guidPath: [15:300]`, `overriddenSymbolID: 15:287`
- Master 11:514 (default option) → swap → master 15:287 (selected option)
- Same outer's text override: `guidPath: [15:300, 15:288]`, `textData.characters: <Korean "custom select" label>` (15:288 is a child of 15:287)

## 3. Invariants

### 3.1 Collection

- I-C1 `collectSwapTargetsAtPathFromInstance(symbolOverrides) → Map<pathKey, swapTargetGuid>`. `pathKey` follows the outer's path-key scheme exactly — defined in `web-instance-render-overrides.spec.md §3.1 I-C1` (FRAME/GROUP ancestor skip introduced in round-25). `swapTargetGuid` has the form `${sessionID}:${localID}`.
- I-C2 If an entry's `overriddenSymbolID` is not a `{sessionID, localID}` integer pair, the entry is ignored (silent skip).
- I-C3 Multiple swap entries on the same path → last wins.

### 3.2 Propagation

- I-P1 In the INSTANCE branch of `toClientNode`, call `collectSwapTargetsAtPathFromInstance` and pass the resulting map to `toClientChildForRender` via a new argument `swapTargetsByPath: Map<string, string>`.
- I-P2 When `toClientChildForRender` visits an INSTANCE node (nested-INSTANCE branch, just before descending into expansion):
  1. If `swapTargetsByPath.get(currentKey)` matches, use that guid as the master lookup key (ignore the default `sd.symbolID`).
  2. Otherwise use the default `sd.symbolID` (existing behavior).
- I-P3 After swap, the inner INSTANCE's descendant expansion proceeds against the swap target master's children tree. Text/fill/visibility/prop overrides are matched automatically because the outer has already registered the swap target's GUID in its paths (meta-rich case: text override `[15:300, 15:288]` correctly references 15:288, the child of swap target 15:287).
- I-P4 Inner-swap-targets collected from a nested-INSTANCE's own `symbolOverrides` merge with the outer using the same prefix rule (all path-keyed Maps follow the same pattern).

### 3.3 Implicit visibility

- I-V1 An INSTANCE under an active swap is treated as **implicit visible:true** — even if the INSTANCE's own master data has `visible: false`, an active swap renders it visible. **However**, if an explicit `visibilityOverrides` (Symbol Visibility Override) specifies a different value, that value wins (consistent with the precedence in round-12 §3.4 I-P8). Meta-rich Dropdown "custom select" case: 15:300 master data has `visible: false`, the outer does not set an explicit `visible` override, swap is active → implicit visible:true → render.
- I-V2 An INSTANCE *without* swap is unaffected by this spec — existing visibility rules apply.

### 3.4 Visual property inheritance from swap target (round 17)

Figma's swap semantic is "use this variant's appearance" — not just replacing children, but **applying the swap target's visual properties to the INSTANCE itself**. Meta-rich "custom select" case: the default master 11:514 has no fillPaints, the swap target 15:287 has fillPaints `{r:0.097, g:0.441, b:0.957}` (BLUE) + cornerRadius 12 + white text. If the post-swap INSTANCE does not inherit the swap target's fillPaints, white text is drawn on a white container and visually disappears.

- I-V3 When swap is active, merge the swap target's `data` field into the instance's `data` (before the spread, before reads). Merge rule: **instance's own field wins** — if instance.data already has a value, keep it; only fill from the swap target when missing.
- I-V4 Fields excluded from the merge: `guid`, `type`, `name` (identity), `children`, `symbolData` (instance-specific), `transform` (instance position), `parentIndex`, `phase` (tree-structure). Everything else is an inheritance candidate.
- I-V5 Visual fields (fillPaints, strokePaints, cornerRadius, rectangle*CornerRadius, opacity, etc.) are inherited so the visual outcome matches the swap target.

This produces the same effect as the `merged` object construction at `pen-export.ts:1146-1158`, where `{ ...masterData, ...rootOverrideFields, ... }` puts master values at the base and override on top. I-V3 of this spec mirrors the same direction: swap target as the base, instance own on top.

### 3.4 Master immutability

- I-M1 The swap target master's own data is not mutated — same rule as round-12 spec §3.3 master immutability. Swap results are applied only to the per-instance `_renderChildren` clone.

## 4. Error cases

- I-E1 `swapTargetsByPath.get(currentKey)` matches but the swap target is missing from `symbolIndex` (master not present, corrupt data) → swap falls back to the default `sd.symbolID`. Safe fallback.
- I-E2 The swap target master is a *completely different tree* from the INSTANCE's default master (different child GUIDs) → if outer text/fill etc. path-keyed overrides do not match the swap target tree's GUIDs, those overrides are inert (default value exposed). The meta-rich case is fine because the outer already knows the swap target's GUIDs and matches.
- I-E3 If both swap and visibility override exist for the same path, visibility override wins (stated in I-V1).

## 5. Tests

New describe blocks in `web/core/domain/clientNode.test.ts`: `collectSwapTargetsAtPathFromInstance` + `toClientChildForRender — variant swap`:

- Unit tests (`collectSwapTargetsAtPathFromInstance`): empty/undefined/corrupt entries handled; multi-step path keys; last-wins on duplicate path.
- Integration: outer INSTANCE with one nested INSTANCE child, outer override has `overriddenSymbolID` pointing to a different SYMBOL with different child TEXT. Assert resolved `_renderChildren` use swap target's children.
- Implicit visibility: nested INSTANCE has `visible: false` in master data, swap entry doesn't explicitly set visible — assert resolved node has `visible !== false`.
- Explicit visibility override wins: same as above but outer also has `visible: false` for the same path → swap still uses swap target master, but resolved node is `visible: false`.
- Meta-rich Dropdown rail "custom select" fixture: full path-keyed text override on swap target's child resolves to overridden text.

## 6. Out of scope

- **Component property INSTANCE_SWAP** — `componentPropRefs` with `componentPropNodeField === 'INSTANCE_SWAP'`. Not supported in v1. The meta-rich Dropdown rail case uses `overriddenSymbolID` directly, so prop-binding pass-through is unnecessary.
- **Recursive variant swap** — the swap target is itself an INSTANCE. v1 assumes the swap target is a SYMBOL/COMPONENT.
- **Swap target visibility is false** — the case where the swap target master itself has `visible: false`. v1 assumes the swap target is visible: true (the meta-rich case satisfies this).
- **Outer overrides processing after the swap target's master tree changed** — v1 applies the outer's *remaining* overrides to the swap target's children. If another path-keyed override targets the default master's children, it will not match (different GUID tree) and is inert. Meta-rich does not hit this because the outer already knows the swap target's GUIDs.

## 7. Round 17 visual fix history (resolved)

Right after the round-16 draft commit, the data layer worked correctly but the 6th row was invisible in the audit screenshot. The initial hypothesis was an audit-harness bbox mismatch, but a direct Konva tree dump showed the "custom select" TEXT was `fill: rgba(255,255,255,1)` (white) with no background Rect — white text on a white container, visually invisible. Unrelated to the audit harness.

The real cause: when swap is active, the swap target master's fillPaints (blue background) must be inherited by the INSTANCE, but round-16 code replaced children only and did not inherit visual properties. Round 17 added visual property inheritance via §3.4 I-V3~V5. After the fix, the 6th row renders correctly with the BLUE background + WHITE text, matching Figma.
