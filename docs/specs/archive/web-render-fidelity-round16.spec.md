# spec/web-render-fidelity-round16

| Item | Value |
|---|---|
| Status | Approved |
| Implementation | `web/core/domain/colorStyleRef.ts` (`effectiveTextStyle`) + `web/client/src/render/nodeRender.ts` (text-simple / text-styled plans) + `web/client/src/Inspector.tsx` (TextSection display) |
| Tests | `web/core/domain/colorStyleRef.test.ts` (effectiveTextStyle cases added) + existing nodeRender regressions |
| Siblings | round 15 (Inspector library color / text-style label), round 26 (textStyleRuns — per-character overrides) |

## 1. Background — root-cause analysis

A `.fig` TEXT node carries typography information at two layers:

1. **Node-level raw fields** — `fontName`, `fontSize`, `lineHeight`, `letterSpacing`, `textCase`, `textDecoration` etc. are set directly on the node.
2. **Style-asset reference** — when `node.styleIdForText.guid` is present, a separate node (type=`TEXT` + `styleType='TEXT'`) carries the *style definition*.

Figma's behavior — **when `styleIdForText` is present, the style asset's typography is the *effective* value** and the node's raw fields are stale leftovers, *ignored* (unless a per-character override applies). That is:

```
effective_fontName  = styleAsset.fontName  ?? node.fontName
effective_fontSize  = styleAsset.fontSize  ?? node.fontSize
... (and so on)
```

### 1.1 Meta-rich toast popup case (reported by user)

| Node | raw fontName | raw fontSize | styleIdForText | Effective |
|---|---|---|---|---|
| `53:303` ("Edit complete.") | Inter Regular | 12 | `16:727` | Pretendard SemiBold 16 (effective) |
| `53:349` ("Save failed.") | Pretendard SemiBold | 18 | `16:727` | Pretendard SemiBold 16 (effective) |

→ `16:727` = `Body/L_sb` (Pretendard SemiBold 16). Figma renders the two nodes identically. Our client uses raw only → renders as Inter 12 vs Pretendard 18. That is the direct cause of the visual gap.

### 1.2 Difference from round 15

Round 15 displays only the style name *as a label* (`Style: Body/L_sb`). This round actually *applies the typography* — the Canvas + Inspector both operate on effective values.

### 1.3 Relationship to round 26 (textStyleRuns)

Round 26 handles *per-character* overrides (a different style applied to a sub-range inside a single node). This round handles the *node-level base*. The two are orthogonal — character overrides stack on top of the base:

```
char_effective_fontSize = override.fontSize ?? base_effective_fontSize
                                              ↑
                                     (defined by round 16)
```

## 2. Approach

### 2.1 Effective text-style resolver

A new helper `effectiveTextStyle(node, root) → EffectiveTextStyle` — collocated in `web/core/domain/colorStyleRef.ts` (it walks the same alias path that `textStyleName` already does, so it belongs in the same module).

```ts
interface EffectiveTextStyle {
  fontName?: { family?: string; style?: string; postscript?: string };
  fontSize?: number;
  lineHeight?: { value?: number; units?: string };
  letterSpacing?: { value?: number; units?: string };
  textCase?: string;          // ORIGINAL / UPPER / LOWER / TITLE
  textDecoration?: string;    // NONE / UNDERLINE / STRIKETHROUGH
  paragraphSpacing?: number;
  paragraphIndent?: number;
}
```

Rules:

- I-1 When `node.styleIdForText.guid` is present and the lookup succeeds and the target's `type === 'TEXT'` + `styleType === 'TEXT'` → adopt the above fields from the target node verbatim. If any field is *missing* on the target, fall back to the node's raw field *per field*. (Style asset defines fontSize only and not textCase → fontSize from the asset, textCase from the node raw.)
- I-2 styleIdForText missing / lookup failed / target is not a style asset → every field comes from the node raw. Same behavior as before round 16.
- I-3 If root is null/undefined → lookup impossible → fall back as in I-2. (Inspector callers always pass root, but defend regardless.)
- I-4 The helper is *pure* — no IO, no React. Used by both the Canvas plan and the Inspector.

### 2.2 Canvas render (nodeRender)

- I-5 Add a new field `documentRoot?: unknown` to `RenderContext` in `nodeRender.ts`. `App.tsx` passes `doc` through ctx at the call site of `nodeRender(node, ctx)`.
- I-6 `planTextSimple` / `planTextStyled` use the result of `effectiveTextStyle(node, ctx.documentRoot)` instead of raw fields to populate fontFamily / fontSize / fontStyle / lineHeight / letterSpacing / textCase / textDecoration. Every direct access to a raw field now goes through the helper.
- I-7 Round 26's character-level overrides stack on top of the `effectiveTextStyle` base — round 26's `splitTextRuns` is updated to accept the base as input (if not, a separate round will follow; round 16 only locks in the base). Round 26's per-run fontSize/fontFamily is out of scope in v1 (per the `Canvas.tsx` comment), so getting the base right is sufficient for visuals close enough to Figma at this point.

### 2.3 Inspector — Text section

- I-8 The *display* in the Inspector Text section uses effective values. The `Family` / `Weight` / `Size` / `L Height` / `Letter` etc. inputs the user sees read their *value* prop from effective.
- I-9 *Editing* (the onCommit of TextInput / NumberInput) patches raw fields. Known v1 limitation: editing a styled node may change raw without affecting effective (which still comes from the asset), so nothing visible changes — Inspector's Style row (added in round 15) signals "style is applied" to the user. Detach (auto-remove styleIdForText on edit + switch to raw) is a *separate-round candidate*. Round 16 documents this scenario as a *known limitation*.
- I-10 Inspector already receives the `root` prop (round 15) — the Text section passes the same root into the helper.

### 2.4 Audit harness impact

- I-11 `audit-oracle.spec.md`'s COMPARABLE_FIELDS `fontSize`, `fontName.family`, `fontName.style` read *node raw* (`pickOurs`). After this round the audit still compares raw — but the figma plugin/REST emits resolved effective, so existing *audit* mismatches may appear in places. Switching audit pickOurs to effective is recommended in a separate round. Round 16 itself does not change audit comparison rules.

## 3. Invariants — one-liners

| ID | Statement | Verified by |
|---|---|---|
| I-1 | styleIdForText present and asset valid → style fields take precedence, missing fields fall back to node raw | unit |
| I-2 | styleIdForText missing / target invalid → everything from node raw | unit |
| I-3 | root null → everything from node raw | unit |
| I-6 | nodeRender text plans use effective values | unit (nodeRender.test.ts) |
| I-8 | Inspector Text section displayed value = effective | manual UI |
| I-9 | Inspector edit onCommit patches raw fields | manual UI |

## 4. Out of scope

- ❌ Inspector edit-detach policy (auto-remove styleIdForText on edit). Round 17 candidate.
- ❌ Switching audit pickOurs to effective. Round 17 candidate.
- ❌ Per-character `styleOverrideTable` fontSize/fontFamily overrides (round 26 v1 out-of-scope). Round 17/18 candidate.
- ❌ Nested resolution of style assets applied to a component (style asset → another style-asset alias). Single hop.
- ❌ *Editing* the style asset itself. This round is read-only application.

## 5. References

- Round 15: `colorVarName` / `textStyleName` (label display)
- Round 26: `textStyleRuns` (per-character overrides)
- Meta-rich fixture: `53:303`, `53:349`, `16:727 "Body/L_sb"`
