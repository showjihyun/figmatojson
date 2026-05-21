# spec/expansion-context

| Item | Value |
|---|---|
| Status | Draft — awaiting trigger (no active bug, excluded from round-13 scope) |
| Trigger | (a) A second design system audit surfaces another "the CLI knows, but the web doesn't" drift, or (b) we actually implement a new Override mechanism beyond prop-binding (variant swap, layout override, etc.). The first step of that PR is the extraction described in this spec. |
| Implementation | `src/expansion.ts` (entry), `src/masterIndex.ts` (private), `src/effectiveVisibility.ts` (private) |
| Tests | `src/expansion.test.ts` (vitest, hand-built TreeNode fixtures — the override-pipeline tests currently in `web/core/domain/clientNode.test.ts` reshape into here) |
| Siblings | `web-instance-render-overrides.spec.md` (round 12 v3 — prop-binding); `CONTEXT.md` "Expansion", "Expansion Context", "Master Index" |
| ADR | `docs/adr/0004-shared-modules-live-in-src.md` (placement) |

## 1. Goal

Today the **Resolve** step of Master/Instance Expansion (`Master + Instance + Overrides → resolved Tree Node subtree`) is implemented independently in two places:

- `src/pen-export.ts` — `applySymbolOverrides` + `buildPropAssignmentMap` + `isHiddenByPropAssignment` + nested INSTANCE recursion (~line 600-1080)
- `web/core/domain/clientNode.ts` — `toClientChildForRender` + assorted `collect*FromInstance` + `mergeOverridesForNested` (line 234-321)

The round-12 audit exposed the cost of this duplication directly: `pen-export.ts` had handled the `componentPropAssignments → componentPropRefs[VISIBLE]` binding for years, but the web side did not, and as a result an arrow-icon leak across 4 components went unnoticed until the audit. This spec **extracts Resolve into a single module so that both pipelines are guaranteed to produce the same answer**.

`Reduce-to-Pen` (Pen Node 4-type reduction, auto-layout reflow, Pen ID issuance) is a Pencil-output-specific responsibility and remains in `pen-export.ts` — out of scope here.

## 2. Interface

```ts
import { createExpansionContext, type ExpansionContext } from './expansion';

const ctx = createExpansionContext(allNodes);   // once per .fig
const resolved = ctx.expandInstance(instance);  // N instances → N calls
```

Shape of `ResolvedSubtree` (the exact type name is decided at implementation time):

```ts
{
  // Same shape as Tree Node — guid, type, name, children, data
  // + the following fields are stamped per-node:
  parentInstancePath: string[];   // outer instance master root → parent of current node
  effectiveVisibility: boolean;   // composed result of Direct ⊕ PropertyToggle ⊕ SymbolOverride
  resolvedFillPaints?: Paint[];   // override-applied fillPaints (if any)
  resolvedText?: string;          // override-applied characters (TEXT nodes only)
}
```

A caller only needs to know about the two functions `createExpansionContext` and `expandInstance`, plus the 4 fields of `ResolvedSubtree`. Everything else (override-collection helpers, path-keyed map merge, nested INSTANCE recursion, prop-binding resolution, MasterIndex build) is implementation internal.

## 3. Invariants

### 3.1 Expansion Context

- I-CT1 `createExpansionContext(allNodes)` walks `allNodes` once to build a **Master Index** (`Map<GUID, Master>`). Only nodes with `node.type ∈ {SYMBOL, COMPONENT, COMPONENT_SET}` enter the index — generic Tree Nodes are not indexed. (Fixes the unconditional-set bug currently at `web/core/domain/clientNode.ts:456-465`.)
- I-CT2 ExpansionContext is read-only — calling the same instance multiple times with the same context always yields the same result. If `allNodes` changes, build a new context.
- I-CT3 Context build cost is O(allNodes); per `expandInstance` call cost is O(master subtree size). Reusing the context amortizes N instances to 1 × buildIndex + N × walk rather than N × buildIndex.

### 3.2 Resolve walk

- I-R1 `expandInstance(instance)` looks up `instance.symbolData.symbolID` in the Master Index → walks a per-instance clone of the master's children. The master's own nodes are not mutated (I-M1, round-12 spec §3.3).
- I-R2 At each node visited, the walk stamps:
  - `parentInstancePath`: guidStr array from outer instance master root → parent of current node (equivalent to today's web `pathFromOuter`)
  - `effectiveVisibility`: boolean composed from (Direct, PropertyToggle, SymbolOverride) by the EffectiveVisibility module of §3.4
  - `resolvedFillPaints`: replaced with the SymbolOverride's fillPaints value when it matches
  - `resolvedText`: for TEXT nodes, the SymbolOverride's textData.characters value when it matches
- I-R3 Override matching is **path-keyed**: the key is the full guidStr chain from the outer instance master root. Same rules as round-12 spec §3.1 I-C1 / §3.2 I-P3.
- I-R4 Outer overrides also reach descendants inside a nested INSTANCE automatically (round-12 §3.2 I-P5). If an inner instance carries its own overrides, they are merged with the outer set after path-prefixing. An inner instance's own `componentPropAssignments` performs a defID-keyed flat merge (round-12 §3.4 I-P9).

### 3.3 Effective Visibility

`src/effectiveVisibility.ts` (private to expansion):

- I-V1 Inputs: `(node.data, propAssignments: Map<defID, boolean>, currentPath, visibilityOverrides)` — every mechanism is composed in one place.
- I-V2 Composition rule — **OR-of-hidden**, except that a SymbolOverride with `visible: true` overrides every other mechanism:
  1. SymbolOverride matches with `visible: true` → return `true` (force visible)
  2. SymbolOverride matches with `visible: false` → return `false`
  3. PropertyToggle (componentPropRefs[VISIBLE] + propAssignments[defID]=false) → return `false`
  4. Direct Visibility (`data.visible === false`) → return `false`
  5. Otherwise → return `true` (default visible)
- I-V3 Single function, single test surface. New visibility mechanisms (e.g. layer blend mode hiding) add another case to this function.

### 3.4 Master Index

`src/masterIndex.ts` (private to expansion):

- I-MI1 `buildMasterIndex(allNodes): Map<GUID, Master>` — indexes only nodes with `node.type ∈ {SYMBOL, COMPONENT, COMPONENT_SET}`. Other types are not indexed (fixes the unconditional-set bug at today's `clientNode.ts:462`).
- I-MI2 If the same GUID appears under multiple master types, last-wins — preserves current behavior (Figma assigning the same GUID to two masters is a spec violation, so this is a fallback).

## 4. Caller changes

### 4.1 `web/core/domain/clientNode.ts`

- The 4 `collect*FromInstance` functions + `mergeOverridesForNested` + `visibleFromPropRefs` + `pathKeyFromGuids` + `buildSymbolIndex` → **all removed** (moved into expansion, no longer exported)
- `toClientChildForRender` → reduced to a thin wrapper that calls `expansion.expandInstance`. Takes ResolvedSubtree and stamps web-side DocumentNode fields such as `_renderChildren` / `_renderTextOverride` / `visible` / `fillPaints`.
- `toClientNode` → on the INSTANCE branch, builds an `expansion.ctx` and calls `expandInstance`. The ctx is cached for the duration of one `toClientNode` invocation.
- `collectTexts` → kept as-is (different use case — Component Texts UI).

### 4.2 `src/pen-export.ts`

- `applySymbolOverrides` + `buildPropAssignmentMap` + `isHiddenByPropAssignment` + `mergeOverrideMaps`, etc. → **removed**. Moved into expansion.
- Master tree walk site — when Pen Node `convertNode` encounters an INSTANCE, it calls `expansion.expandInstance`. The resulting ResolvedSubtree is then run through its own Pen Node 4-type reduction (Reduce-to-Pen).
- `vectorPathMap` lookup key — today's `Expansion Path` string (`outerInstanceGuid/.../masterGuid`) is assembled *at the call site* from ResolvedSubtree's `parentInstancePath` array (§3.2 I-R2). The format itself is unchanged.

## 5. Tests

### 5.1 New location

`src/expansion.test.ts` is the primary test surface for expansion. Test fixtures are hand-built TreeNodes (reusing the `makeNode` pattern currently in `web/core/domain/clientNode.test.ts`).

Of the 31 tests currently in `web/core/domain/clientNode.test.ts`:

- 22 tests (`collect*` helpers, the path-related cases of `toClientChildForRender`, prop-binding cases) → reshaped into `expansion.test.ts`. The new surface is the inputs/outputs of `expandInstance`. No internal helper is called.
- 9 tests (the web-side wrapper aspects of `toClientNode`, DocumentNode-shape validations like `_renderTextOverride`) → kept in `clientNode.test.ts`. The expansion call is mocked or invoked for real.

### 5.2 Regression guards

- The existing e2e `web/e2e/instance-fill-override.spec.ts` must pass unchanged — interfaces change but external behavior is identical.
- Pen-export-related fixtures in `test/e2e.test.ts` likewise.

## 6. Migration order

1. Extract `src/masterIndex.ts` first + tests + update `pen-export.ts` and `clientNode.ts` to import it. The smallest PR.
2. Extract `src/effectiveVisibility.ts` + tests. Update both `pen-export.ts`'s `isHiddenByPropAssignment` and `clientNode.ts`'s `visibleFromPropRefs` to call it.
3. Extract `src/expansion.ts` — integrate Resolve walk + calls to the two modules above. Switch both callers (pen-export, clientNode) to use `expansion.expandInstance`. The largest PR.
4. Delete dead helpers from today's `web/core/domain/clientNode.ts`.

After each step confirm `npm test` (vitest) + existing e2e pass. Spot-check visual regression with the round-11 audit harness.

## 7. Out of scope

- **Reduce-to-Pen** (Pen Node 4-type reduction, auto-layout reflow, Pen ID issuance) — Pencil-specific responsibility, stays in `pen-export.ts`.
- **Variant swap** (the "direct selection" case in round-12 spec §6) — the case where the master is replaced via `symbolOverrides[].symbolID` or `componentPropNodeField === "INSTANCE_SWAP"`. In v1 of this spec we still expand the original master. Separate round.
- **componentPropNodeField !== "VISIBLE"** (other prop types like TEXT / INSTANCE_SWAP) — same out-of-scope as round-12 spec §6.
- **Cases where the CLI must know the web's DocumentNode shape** — none. Expansion returns ResolvedSubtree (a Tree Node extension); each caller adapts to its own shape.
