# spec/web-render-fidelity-round10

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/Canvas.tsx` (variant label render points) + `web/client/src/lib/variantLabel.ts` + `web/client/src/components/canvas/VariantLabel.tsx` |
| Tests | `web/client/src/lib/variantLabel.test.ts` + `web/client/src/components/canvas/VariantLabel.test.tsx` |
| Parent | round 9 |

## 1. Purpose

Render, on our canvas, the **variant property labels** that the Figma editor automatically draws above each variant child of a Component Set / state group. In user screenshots, the variant names like `default` or `component2` that appear inside the purple dotted box of a pagination component are exactly this feature.

These labels do **not** exist as text nodes in the .fig data — they are a runtime UI overlay drawn by the Figma editor to visually distinguish the children of a COMPONENT_SET / `isStateGroup === true` container. We implement the same "drawn but not present in the data" overlay.

## 2. Variant container detection

- I-V1 A node N is a "variant container" when either:
  - `N.type === 'COMPONENT_SET'` (newer Figma)
  - `N.isStateGroup === true` (legacy / meta-rich format)
- I-V2 Among the direct children of a variant container, nodes with `type === 'SYMBOL' || 'COMPONENT'` are variant children. If the name matches a `prop=value, prop=value, …` pattern (`/^[\wÀ-￿ ]+=/`, covering CJK and other non-ASCII identifiers), show the label. Other children get no label.

## 3. Label text extraction

- I-V3 `variantLabelText(name)`:
  - Input `"size=L, State=hover, Type=primary"` → `"L, hover, primary"`
  - Input `"Property 1=default"` → `"default"`
  - Input `"plain name"` (no `=`) → `"plain name"` (unchanged)
  - Empty / null → `null` (label is not drawn)
  - Trim and join only the value portion of each `key=value` token. A single-prop variant yields just that one value. A multi-prop variant joins with ", ".

## 4. Render — VariantLabel component

- I-V4 `<VariantLabel x y text />` draws:
  - A rounded-rect background (Konva.Rect): `cornerRadius=4`, `fill='#E5E5E5'`, no stroke. Width = `text` width + 8 px padding on each side; height 18 px.
  - The label text (Konva.Text): `fontSize=11`, `fontFamily='Inter, sans-serif'`, `fill='#1f1f1f'`, left/right padding 8, top/bottom padding 3.
  - Text width is approximated as `text.length * 6.2` (Konva picks exact metrics at runtime, but the background size must be set up-front, so we use a conservative approximation. One CJK character ≈ 1.5 Latin characters.)
- I-V5 The label is drawn inside the container, so clipping / rotation / opacity propagate from the parent automatically. `listening={false}` keeps the label from intercepting selection / drag / hover events.

## 5. Canvas integration

- I-V6 When a `NodeShape` renders its children and it is itself a variant container, it emits the label of each variant child right before that child. Position:
  - `labelX = childTransform.m02`
  - `labelY = childTransform.m12 - 18 - 4` (label height 18 + 4 top margin)
  - I.e. aligned just above the top-left corner of the variant child.
- I-V7 The label lies inside the container's clipFunc. If the container has top padding (e.g. meta-rich's pagination), the label is visible; in a container without padding it can be clipped. v1 limitation.

## 6. Out of scope (v1)

- Clicking the label to toggle a variant — our app is a .fig viewer, not a variant editor.
- Multi-line labels — always single line.
- Auto-correcting label position for other containers (when top padding is missing) — Figma also draws outside the container in that case, but v1 keeps the label inside.
- The COMPONENT_SET's own top-right "Properties" panel display — separate round.

## 7. Resolved questions

- **Label background color**: the Figma editor uses a light gray (close to #E5E5E5). A white background would clash with white variants, so we standardize on gray.
- **Label position**: top vs. left. Figma's vertically stacked variants get the label on top, horizontally stacked ones on the left, but v1 standardizes on "top" for all. Pagination / Button etc. in meta-rich are all vertical stacks, so there is no visual difference.
- **Omit the prop name when there is a single prop**: `"Property 1=default"` → `"default"` (value only). Multi-prop variants also keep only values. Matches Figma.
