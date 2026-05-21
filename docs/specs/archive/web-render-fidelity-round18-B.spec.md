# spec/web-render-fidelity-round18-B

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/domain/colorStyleRef.ts` (`colorVarTrail`) + `web/client/src/Inspector.tsx` (FillSection / StrokeSection Style row) |
| Tests | `web/core/domain/colorStyleRef.test.ts` (trail case set) |
| Siblings | round 15 (`colorVarName` single-hop), round 18-A (`resolveVariableChain` chain walker) |

## 1. Background

Round 15's Inspector Style row only shows the first hop name — meta-rich 5:8 fill's `colorVar` alias `11:434` → `"Button/Primary/Default"`. What users often want to see is *where the variable comes from* — the trail walked all the way to the leaf of the alias chain. Example:

```
Button/Primary/Default  →  Color/Blue/600
                                 ↑ the original color's name
```

This round lays a thin *trail formatter* on top of round 18-A's `resolveVariableChain`, so the Inspector can display "A → B → C". Round 15's single-hop label behavior is *preserved* — its helper is not changed; round 18-B is an *additional option*.

## 2. New helper — `colorVarTrail`

```ts
// web/core/domain/colorStyleRef.ts (round 18-B addition)

export interface ColorVarTrailEntry {
  /** GUID of the chain node (always set). */
  id: string;
  /** Display name. null when the node has no string `name` (rare). */
  name: string | null;
}

export interface ColorVarTrailResult {
  /** Chain entries from the immediate alias to the leaf (or break-point). */
  entries: ColorVarTrailEntry[];
  /**
   * End-state from the underlying `resolveVariableChain` walk. Used by
   * the Inspector to append a small marker on cycle / dead-end / cap.
   */
  end: VariableChainEnd;
}

export function colorVarTrail(paint: unknown, root: unknown): ColorVarTrailResult | null;
```

### 2.1 Invariants

- I-1 If the input paint is falsy / `colorVar.alias.guid` cannot be extracted → return `null` (same gate as round 15).
- I-2 If the alias guid lookup fails, or the looked-up node's `type !== 'VARIABLE'` → in round 18-A this is a non-variable leaf, but this round is colorVar-specific and returns `null` (consistent with round 15's `colorVarName` rule).
- I-3 Call `resolveVariableChain` starting from the input VARIABLE. Build `entries[]` from the result's chain[]. Each entry is a chain GUID + that node's `name`.
- I-4 The first entry is the same node returned by round 15's `colorVarName`. That is: the label round 15 users saw is the *first item* of the trail, and round 18-B *continues from there*.
- I-5 `entries.length` is always ≥ 1 (the input VARIABLE itself) — even a VARIABLE with a raw entry only has chain length 1.
- I-6 `name` is the node's `name` field if string, else `null`. The Inspector falls back to a placeholder (e.g. GUID literal) when `null`.

## 3. Inspector UI changes

- I-7 The round 15 `Style` row in `FillSection` / `StrokeSection` is updated to show *trail* text:
  ```
  <Row label="Style">
    <span>{trail formatted}</span>
  </Row>
  ```
- I-8 Trail format rules (a single helper `formatTrail(result)` — either inline in Inspector or a small util):
  - `entries.length === 1` → that single name (or "<unnamed>") — same as round 15.
  - `entries.length ≥ 2` → `entries.map(e => e.name ?? '<unnamed>').join(' → ')`.
  - When end is `cycle`, append ` ⟲`. `dead-end` → ` ⚠`. `depth-cap` → ` …`.
    `non-variable` never reaches here because colorVarTrail itself returns null (I-2).
- I-9 The text may be long, so the `<span>` carries `title={fullText}` alongside `class="text-xs text-muted-foreground"` — hover shows the full text in a tooltip.

## 4. Test cases

| ID | Input | Expected |
|---|---|---|
| TR-1 | paint has no colorVar | `null` |
| TR-2 | colorVar present but the guid lookup misses | `null` |
| TR-3 | 1-hop (raw VARIABLE) | entries.length=1, end=leaf |
| TR-4 | 2-hop chain | entries.length=2, end=leaf, names in the right order |
| TR-5 | 3-hop with depth-cap=2 | entries.length=2, end=depth-cap |
| TR-6 | cycle | end=cycle, entries preserved |
| TR-7 | dead-end | end=dead-end |
| TR-8 | non-variable target | `null` (I-2) |
| TR-9 | chain contains a node with null/undefined name | entry.name=null carried through |

## 5. Out of scope

- ❌ Trail for textStyleName in TextSection. Text-style assets are a single node with no chain. No change needed.
- ❌ Multi-mode (2nd+ entries in entries[N]) — same single-mode constraint as round 18-A.
- ❌ Clickable trail navigation (selecting chain nodes). Separate round.
- ❌ Integrating the helper into the audit script (.mjs) — round 18-C candidate.
- ❌ Changing round 15's `colorVarName`. This round is *an additive helper* and has no impact on round 15's call sites (if any).

## 6. References

- `docs/specs/archive/web-render-fidelity-round15.spec.md` — single-hop label policy
- `docs/specs/archive/web-render-fidelity-round18-A.spec.md` — `resolveVariableChain` API
