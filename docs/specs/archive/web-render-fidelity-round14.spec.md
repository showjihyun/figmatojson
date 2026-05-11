# spec/web-render-fidelity-round14

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/Inspector.tsx`, `web/client/src/components/sidebar/LayerTree.tsx`, `web/client/src/components/sidebar/AssetList.tsx` |
| Tests | (existing) `web/client/src/lib/variantLabel.test.ts` is reused — the helper body is unchanged |
| Parent | round 10 (Canvas variant label) |

## 1. Background

The `variantLabelText` introduced in round 10 was applied only to the variant label drawn on the *Canvas* (the small pill of text above the purple dotted box). In other UI areas that expose the same node's name — the Inspector's selected-node header, the LayerTree node label on the left, and the AssetList INSTANCE card — the raw name is still shown.

Both HPAI and meta-rich carry Figma's component-set variant naming convention (`prop=value, prop=value, …`) verbatim — examples:

| Node | raw name | Figma UI display |
|---|---|---|
| `5:8` (meta-rich SYMBOL) | `size=XL, State=default, Type=primary` | `XL, default, primary` |
| `5:20` | `size=L, State=default, Type=primary` | `L, default, primary` |

The label conversion reuses round 10's helper body unchanged — same meaning as on the Canvas, and the heuristic (raw names without `=` are returned unchanged) keeps generic node names untouched.

## 2. Scope

- I-1 `web/client/src/Inspector.tsx` — selected-node header (the `node.name` render point). Apply `variantLabelText(node.name) ?? ''` instead of raw `node.name`. The existing `(unnamed)` placeholder fallback for empty names is preserved.
- I-2 `web/client/src/components/sidebar/LayerTree.tsx` — apply `variantLabelText` while computing `displayName`. Keep the existing fallback logic for empty names (`(node type)` etc.).
- I-3 `web/client/src/components/sidebar/AssetList.tsx` — apply to the INSTANCE card's `name` field. This was another area exposing the raw name.
- I-4 The *editable* name field in `Inspector.tsx` (`TextInput value={node.name}`) does *not* receive the conversion. Users need to edit the raw name directly — inside a variant container the `prop=value` form is the wire-format source-of-truth.

## 3. Out of scope

- ❌ Name-edit UX: a separate widget that disables editing inside a variant, or shows both representations (raw vs pretty) at once. Today only the raw name is exposed for editing.
- ❌ Other UI areas such as ChatPanel / search results. Apply the same heuristic when encountered.
- ❌ Changing the behavior of the variantLabelText body. Follow the round 10 spec as-is.

## 4. Invariants

| ID | Statement | Verified by |
|---|---|---|
| I-1 | Inspector header renders a variant-shaped name in stripped form | unit (existing variantLabel.test.ts coverage) + manual UI |
| I-2 | LayerTree row renders a variant-shaped name in stripped form | manual UI |
| I-3 | AssetList card renders a variant-shaped name in stripped form | manual UI |
| I-4 | Name-edit input still carries the raw name | manual UI |
| I-5 | Zero behavior regression on non-variant generic names (e.g. "Frame 2262") | unit (existing) |

## 5. References

- `docs/specs/archive/web-render-fidelity-round10.spec.md` — variant label spec (Canvas)
- `web/client/src/lib/variantLabel.ts` — helper body (no changes)
