# spec/web-render-fidelity-round15

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/domain/colorStyleRef.ts` (new) + `web/client/src/Inspector.tsx` + `web/client/src/App.tsx` |
| Tests | `web/core/domain/colorStyleRef.test.ts` (new) |
| Sibling | round 14 (variant label UI) |

## 1. Background

The fillPaints/strokePaints in `.fig` carry the SOLID color RGBA values together with an *optional* `colorVar.value.alias.guid` — this is Figma's *color variable* (library color) reference. A TEXT node's `styleIdForText.guid` follows the same pattern — a reference to a text-style asset.

Meta-rich 5:8 SYMBOL "size=XL, State=default, Type=primary" (Button master):
```
fillPaints[0]: {
  type: 'SOLID',
  color: { r: 0.097, g: 0.441, b: 0.957, a: 1 },   // raw RGBA
  colorVar: {
    value: { alias: { guid: { sessionID: 11, localID: 434 } } },
    dataType: 'ALIAS',
    resolvedDataType: 'COLOR',
  }
}
```

GUID `11:434` → a `VARIABLE` node living in the `Internal Only Canvas` page under the DOCUMENT root, `name: "Button/Primary/Default"`.

Figma's right panel shows the library color name next to the fill color — our Inspector exposes only the raw RGBA. This round restores the label.

## 2. Domain helper — `colorStyleRef.ts`

A new module under `web/core/domain/`. All helpers are pure (no IO, no React).

### 2.1 paint → color variable name

- I-1 `colorVarName(paint, root)`:
  - Input: a `paint` object + the DOCUMENT root (= the overall tree root, including VARIABLE nodes).
  - Extract `paint.colorVar.value.alias.guid` (`{sessionID, localID}`).
  - On extraction failure (missing field / type mismatch) → `null`.
  - Look up the guid in the root tree. If the node is *missing* or `type !== 'VARIABLE'` → `null` (defensive; only Figma VARIABLEs count as library colors).
  - If the looked-up node's `name` is a string, return it; otherwise `null`.

### 2.2 node → text style asset name

- I-2 `textStyleName(node, root)`:
  - Extract `node.styleIdForText.guid` — same pattern, same defenses.
  - The looked-up node should be a *style asset* node with type `TEXT` and `styleType === 'TEXT'` (e.g. meta-rich `4:184 "Lable/L_sb"` — type is TEXT but it is a style-definition node, not body text).
  - If the node does not match → `null`. Otherwise return the style asset's name verbatim.

### 2.3 Cycle / chain policy

- I-3 Follow only one hop — a VARIABLE's `variableDataValues` may itself be another alias, but this round shows only the *outermost (= user-facing) alias name* as the label. The label is meaningful to the user (`Button/Primary/Default`); deeper chains are deferred.

## 3. Inspector UI changes

- I-4 Add a new prop on the `<Inspector>` mount in `App.tsx`: `root={doc}` — currently only `page` is passed, but VARIABLE nodes live *outside the page* (`Internal Only Canvas`), so `page` alone cannot resolve the lookup.
- I-5 `Inspector` forwards root unchanged into `FillSection` / `StrokeSection`. The two sections invoke the helper with raw paint + root.
- I-6 Label placement — a new row below the existing `<Row label="Color">`:
  ```
  <Row label="Style">
    <span className="text-xs text-muted-foreground">Button/Primary/Default</span>
  </Row>
  ```
  When the helper returns null, the row itself is not shown — ordinary SOLID colors (without a Figma library reference) display unchanged.

## 4. Invariants — one-liners

| ID | Statement | Verified by |
|---|---|---|
| I-1 | `colorVarName` looks up `paint.colorVar.alias.guid` against root and returns VARIABLE.name | unit |
| I-1a | guid missing / type mismatch / lookup miss / not a VARIABLE → null | unit |
| I-2 | `textStyleName` looks up `node.styleIdForText.guid` against root and returns the TEXT style asset's name | unit |
| I-4 | App passes `root={doc}` to Inspector | manual UI |
| I-6 | When colorVarName is null, the Style row is hidden | unit (Inspector snapshot) |

## 5. Out of scope

- ❌ Selection-colors section (a summary of selected nodes' colors). Separate round.
- ❌ Deep VARIABLE chain resolution (tracing all the way to the raw color). I-3 policy.
- ❌ effect style / fill style (whole-paint) references. Today SOLID color only.
- ❌ Library references inside paint bodies (gradient stops / image hash). Separate round.
- ❌ Editing color variables. This round is *read-only label*.
- ❌ Extending `audit-oracle`'s COMPARABLE_FIELDS. Separate round.

## 6. References

- Meta-rich fixture — 5:8 SYMBOL, 5:2 TEXT (colorVar usage examples)
- `web/core/domain/tree.ts` — reuse of the `findById` helper
