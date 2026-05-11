# spec/web-render-fidelity-round5

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/client/src/Canvas.tsx` (TEXT branch + default Rect branch) + `web/client/src/lib/cornerRadii.ts`, `web/client/src/lib/textTransform.ts` |
| Tests | `web/client/src/lib/cornerRadii.test.ts`, `web/client/src/lib/textTransform.test.ts` |
| Parents | rounds 1~4 |

## 1. Purpose

Three universal Figma features — **per-corner radii** (asymmetric rounded corners), **textCase** (UPPERCASE / lowercase / Title Case), and **textDecoration** (underline / strikethrough). All are standard fields in Figma's data model. No file-specific heuristics.

## 2. Per-corner radii

### 2.1 Field shape

```ts
node.cornerRadius?: number              // uniform fallback (already handled)
node.rectangleTopLeftCornerRadius?: number
node.rectangleTopRightCornerRadius?: number
node.rectangleBottomRightCornerRadius?: number
node.rectangleBottomLeftCornerRadius?: number
```

A Figma rectangle with different per-corner roundings serializes as the four individual fields above. When all four are equal, `cornerRadius` alone is sufficient (existing behavior). Otherwise Konva.Rect accepts the array form `cornerRadius={[tl, tr, br, bl]}`.

### 2.2 Resolution

- I-CR1 `cornerRadiusForKonva(node, defaultR)`:
  - All four per-corner fields missing → return `defaultR` (uniform).
  - All four equal (`tl === tr === br === bl`) → return that value (uniform; no array).
  - Otherwise return `[tl ?? defaultR, tr ?? defaultR, br ?? defaultR, bl ?? defaultR]`.
- I-CR2 The return of cornerRadiusForKonva is passed straight through as Konva.Rect's `cornerRadius` prop (number or array — both accepted).

### 2.3 Interaction with strokeAlign

- I-CR3 Round 2's strokeAlign INSIDE/OUTSIDE transform offsets cornerRadius by `±strokeWeight/2`. For the per-corner array form, the same offset is applied to all 4 entries (clamp negatives to 0).
- I-CR4 The strokeAlign transform runs inside `applyStrokeAlign` — its signature is extended so it works when cornerRadius is an array too.

## 3. textCase

### 3.1 Field shape

```ts
node.textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE'
```

Figma's textCase is a *render-time* case transform — `textData.characters` is stored verbatim and the transform is applied only at display. Our code follows the same model.

### 3.2 Transform

- I-TC1 `applyTextCase(chars, textCase)`:
  - `'UPPER'` → `chars.toUpperCase()`
  - `'LOWER'` → `chars.toLowerCase()`
  - `'TITLE'` → capitalize the first letter of each word, lowercase the rest. Words are split on `\s+`.
  - `'ORIGINAL'` or missing → `chars` unchanged.
- I-TC2 Korean / CJK characters have no case, so the transform is a no-op (JavaScript `toUpperCase()` passes them through).
- I-TC3 Only the transformed result is passed as KText's `text` prop. The original `characters` in message.json is preserved (same as Figma).

## 4. textDecoration

### 4.1 Field shape

```ts
node.textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH'
```

### 4.2 Konva mapping

- I-TD1 `konvaTextDecoration(figma)`:
  - `'UNDERLINE'` → `'underline'`
  - `'STRIKETHROUGH'` → `'line-through'`
  - `'NONE'` or missing or unknown → `undefined` (omit prop).
- I-TD2 Konva.Text's `textDecoration` prop accepts a CSS-like string; passed through unchanged.
- I-TD3 Simultaneous underline + strikethrough is unused in meta-rich / typical Figma data. v1 supports only a single decoration.

## 5. Out of scope (v1)

- **rectangleCornerRadiiData (array form)** — 0 nodes in meta-rich. Some other .fig files store corner info as an array; a future round candidate.
- **CJK tokenization for TITLE case** — only English-style splitting on `\s+`. Case conversion is meaningless for Korean anyway.
- **textDecoration override inside an INSTANCE** — the current path-keyed override applies only to `characters`; textDecoration overrides are not supported. The distribution shows 0 — will be handled in a separate round if encountered.
- **Double textDecoration** (underline + strikethrough simultaneously).

## 6. Resolved questions

- **When all 4 per-corner values are equal, do not send an array** — Konva accepts arrays, but a number is lighter and short-circuits at cornerRadius=0. A number is cleaner when values are equal.
- **How does the strokeAlign offset apply to an array?** — Apply the same `±strokeWeight/2` offset to all 4 entries. Clamp negatives to 0. Same logic, a simple array map.
- **Relationship between textCase and INSTANCE override on `characters`** — when the instance overrides `characters`, that override applies first and textCase converts the result. So master textCase=UPPER + instance characters="hello" renders "HELLO". Natural semantics.
