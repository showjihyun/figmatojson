# spec/web-render-fidelity-round18-A

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/domain/colorStyleRef.ts` (new function `resolveVariableChain`) |
| Tests | `web/core/domain/colorStyleRef.test.ts` (new case set) |
| Siblings | round 15 (`colorVarName` / `textStyleName` single-hop), round 17 (audit-properties-coverage broken-chain measurement) |

## 1. Background

Round 15's `colorVarName` is **single hop** — it returns the `name` of the VARIABLE node pointed to by `paint.colorVar.alias.guid` (matching Figma editor's "closest alias" display). But in Figma design systems, **alias chains** in which one VARIABLE carries another VARIABLE as alias are common:

```
paint.colorVar  →  VARIABLE A "Button/Primary/Default"
                   variableDataValues.entries[0].variableData (ALIAS)
                   →  VARIABLE B "Color/Blue/600"
                      variableDataValues.entries[0].variableData (COLOR raw)
                      →  { r, g, b, a }   ← leaf
```

When round 17's `audit-properties-coverage.mjs` measured chain reachability, it found 50+ broken cases in bvp and 6 in meta-rich (dead-end / cycle). The audit script is in .mjs and web/core/domain is TypeScript, so sharing helpers was awkward — the verification had to live inline.

This round:

1. **Adds a new domain helper** `resolveVariableChain(node, root)` — pure, returns the leaf of a single `entries[0]` chain plus the list of nodes it walked through.
2. **Classifies chain end states** — 4 categories: leaf reached / cycle / dead-end / depth-cap.

The audit script is not changed in this round (separate-round candidate — design the build path so the .mjs consumes the web/core dist, or mirror the helper as an ESM-export-able .js).

## 2. Helper signature

```ts
// web/core/domain/colorStyleRef.ts (round 18-A addition)

export type VariableChainEnd =
  | { kind: 'leaf' }                         // reached a non-ALIAS entry
  | { kind: 'non-variable' }                 // alias points to a node whose type !== 'VARIABLE'
  | { kind: 'cycle'; cycledAt: string }      // re-visited a previously seen GUID
  | { kind: 'dead-end' }                     // alias guid lookup failed
  | { kind: 'depth-cap'; cap: number };       // hop count exceeded

export interface VariableChainResult {
  /** the last *resolved* VARIABLE node of the chain. On cycle/dead-end, the last node reached. */
  leaf: unknown | null;
  /** array of GUIDs walked through — from the input VARIABLE to the leaf or break-point. */
  chain: string[];
  /** the reason the chain ended. */
  end: VariableChainEnd;
}

export function resolveVariableChain(
  node: unknown,
  root: unknown,
  options?: { maxDepth?: number },
): VariableChainResult | null;
```

## 3. Invariants

- I-1 If the input `node` is falsy / not an object / `type !== 'VARIABLE'` → return `null`.
- I-2 `maxDepth` default = 8 (matches the audit script). Overridable via options.
- I-3 If the input VARIABLE itself carries a raw value (`variableDataValues.entries[0].variableData.dataType !== 'ALIAS'`) → `{ leaf: node, chain: [node.id], end: { kind: 'leaf' } }`. Chain length 1.
- I-4 Chain walk rule (each hop):
  1. If the current node has no `variableDataValues.entries[0]` or `variableData.dataType !== 'ALIAS'` → leaf, end = `{ kind: 'leaf' }`. Current node is the leaf.
  2. If `entries[0].variableData.value.alias.guid` cannot be extracted → end = `{ kind: 'dead-end' }`. leaf = current node (the last cleanly reached one).
  3. If the guid is already in the chain → end = `{ kind: 'cycle', cycledAt: id }`. leaf = current node.
  4. If the root lookup fails → end = `{ kind: 'dead-end' }`. leaf = current node.
  5. If the looked-up node's `type !== 'VARIABLE'` → end = `{ kind: 'non-variable' }`. leaf = that non-VARIABLE node (interesting case: some schemas carry raw color in a different type).
  6. Otherwise — advance to the next hop.
- I-5 If the hop count reaches `maxDepth` → end = `{ kind: 'depth-cap', cap: maxDepth }`. leaf = the node at the depth-cap point.
- I-6 When `entries` is multi-mode (light / dark etc.), this round only follows the **first entry**. Multi-mode handling is a separate round.

## 4. Usage example

```ts
import { resolveVariableChain } from '@core/domain/colorStyleRef';

const node = findById(root, '11:434');             // "Button/Primary/Default"
const result = resolveVariableChain(node, root);

if (result?.end.kind === 'leaf') {
  const leaf = result.leaf;                         // "Color/Blue/600"
  console.log(`chain: ${result.chain.join(' → ')}`); // "11:434 → 2:69"
  console.log(`leaf name: ${leaf.name}`);
}
```

## 5. Test cases (Invariants → assertions)

| ID | Input | Expected |
|---|---|---|
| T-1 | `node = null` | returns `null` |
| T-2 | type=FRAME node | returns `null` |
| T-3 | VARIABLE whose first entry is raw COLOR | leaf=node, chain=[id], end=leaf |
| T-4 | 2-hop chain (A → B raw) | leaf=B, chain=[A.id, B.id], end=leaf |
| T-5 | 3-hop chain (A → B → C raw) | leaf=C, chain length 3, end=leaf |
| T-6 | dead-end (A → missing guid) | leaf=A, end=dead-end |
| T-7 | cycle (A → B → A) | leaf=B, end=cycle, cycledAt=A.id |
| T-8 | depth-cap (10-hop chain, maxDepth=3) | end=depth-cap, cap=3 |
| T-9 | non-VARIABLE leaf (A → FRAME) | leaf=FRAME, end=non-variable |
| T-10 | no entries at all | leaf=node, end=leaf, chain=[id] |

## 6. Out of scope

- ❌ Integrating the helper into audit-properties-coverage.mjs (separate round — the .mjs ↔ ts build path).
- ❌ Multi-mode chains (the 2nd+ entries of `entries[]`). First entry only.
- ❌ Inspector UI changes — this round adds the domain helper only. Round 15's single-hop label display remains.
- ❌ Converting the leaf's raw color (e.g. to an rgba CSS string). Returns the leaf node itself only.

## 7. References

- `docs/specs/archive/web-render-fidelity-round15.spec.md` §I-3 (single hop policy)
- `docs/specs/audit-raw-coverage.spec.md` §4.2 I-P6 (audit broken-chain definition)
