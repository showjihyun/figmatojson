# spec/tokens

| Item | Value |
|---|---|
| Status | Approved (Phase 1 — round 33) |
| Implementation | `src/tokens.ts` + `src/cli.ts` (`tokens` subcommand) + `src/index.ts` (re-export) |
| Tests | (TODO) `src/tokens.test.ts` — one per Invariant in this spec |
| Siblings | `audit-oracle.spec.md` (parser correctness), Phase 0d packaging (`docs/PHASE-0-FOUNDATION.md`) |

## 1. Purpose

Extract Figma published styles as *language-neutral* design tokens. The primary
user is (me) a developer tool — on `.fig` changes in CI, the token export is
automatically refreshed, serving as the source-of-truth for design-code sync.

The style → token conversion is *data preservation*, not *interpretation*.
Figma's authored value is emitted as-is (e.g. `lineHeight: 1.33` RAW is emitted
as a multiplier as-is). The consumer (CSS / JS) converts to their own units.

## 2. Inputs / Outputs

- Input: `.fig` file (CLI) or `DecodedFig` (library API).
- Output: `Tokens` JSON (default), or CSS variables / JS / TS export.

```
$ figma-reverse tokens design.fig                          # JSON to stdout
$ figma-reverse tokens design.fig --format css --out tokens.css
$ figma-reverse tokens design.fig --format ts --out src/design-tokens.ts
```

```ts
import { decodeFigCanvas, extractTokens, loadContainer } from 'figma-reverse';

const decoded = decodeFigCanvas(loadContainer('design.fig').canvasFig);
const tokens = extractTokens(decoded, 'design.fig');
// tokens.colors["Blue-100"] === { value: "#e5f0ff" }
```

## 3. Output schema (v1)

```ts
interface Tokens {
  schemaVersion: '1';
  source: { figName: string };
  colors: Record<string, ColorToken>;
  typography: Record<string, TypographyToken>;
  effects: Record<string, EffectToken>;
}
```

### 3.1 ColorToken

- I-T1 `value` required. CSS-compatible hex: `#RRGGBB` when alpha=1, otherwise
  `#RRGGBBAA`. All lowercase.
- I-T2 `description` (optional) — passes through Figma's style description.
- I-T3 v1 extracts SOLID FILL only. Gradient / image fill styles are
  *not emitted as keys at all* (no entry in tokens.colors). A future
  v2 will add a `gradient` field.
- I-T4 For multiple fillPaints, only the first visible SOLID is used. Other
  paints are ignored.

### 3.2 TypographyToken

- I-T5 `fontFamily`, `fontStyle`, `fontSize` are required. fontStyle is
  the label Figma already carries ("Regular", "Bold", "SemiBold" — converting
  weight to numeric is the consumer's responsibility).
- I-T6 `lineHeight: { unit, value }` —
  `PX` (PIXELS), `PERCENT` (PERCENT), `AUTO` (RAW unitless multiplier).
  The value for AUTO is the multiplier (e.g. 1.33).
- I-T7 `letterSpacing: { unit, value }` — `PX` (default) or
  `PERCENT`. PERCENT 100 = 1em.
- I-T8 `description` (optional).

### 3.3 EffectToken

- I-T9 `type` required: `DROP_SHADOW` / `INNER_SHADOW` / `LAYER_BLUR` /
  `BACKGROUND_BLUR`.
- I-T10 DROP_SHADOW / INNER_SHADOW: `color` (hex), `offset {x,y}`,
  `radius` (blur), `spread`.
- I-T11 LAYER_BLUR / BACKGROUND_BLUR: `blur` only.
- I-T12 For multiple effects, only the first visible one is used. Other effects
  are ignored.

## 4. Extraction rules

- I-T13 Only nodes where `styleType ∈ {FILL, TEXT, EFFECT}` are
  considered. Nodes without `name` are skipped.
- I-T14 The `name` key is preserved as-is (including Figma's `/` namespace). E.g.
  `colors["Heading/XL"]`. The consumer is responsible for any transformation.
- I-T15 Duplicate entries with the same `name` follow *last-emit wins*.
  Duplicate styles are not expected within a normal Figma file, but
  deterministic behavior is guaranteed.
- I-T16 Spacing tokens are *out of scope* in v1 (§7).
- I-T17 Variables (multi-mode) are only emitted with their *default mode
  resolved value* in v1. Variable references are dereferenced one level. v2
  will separate per-mode.

## 5. CLI

`figma-reverse tokens <input.fig> [options]`

- I-C1 `--format json|css|js|ts` (default `json`).
- I-C2 When `--out <path>` is not specified, output goes to stdout.
- I-C3 If the input `.fig` does not exist, exits non-zero with a stderr error.
- I-C4 Output ends with 1 trailing newline (POSIX convention).

### 5.1 Per-format output rules

- I-C5 JSON: `JSON.stringify(tokens, null, 2)` — 2-space indent.
- I-C6 CSS: `--<category>-<slug>-<field>: value;` inside `:root { ... }`.
  The slug is `name.toLowerCase().replace(/[^a-z0-9\u{AC00}-\u{D7A3}]+/gu, '-')`. Hangul is preserved.
- I-C7 JS: `export default { ... }` (ESM).
- I-C8 TS: `export const tokens: Tokens = { ... }; export default tokens;`.

## 6. Library API

Re-exported from `src/index.ts` (stable from semver 1.0+):

- `extractTokens(decoded: DecodedFig, figName: string): Tokens`
- `formatTokens(tokens: Tokens, format: TokenFormat): string`
- types: `Tokens`, `ColorToken`, `TypographyToken`, `EffectToken`, `TokenFormat`

## 7. Out of scope (v1)

- ❌ Spacing tokens — Figma does not expose these as first-class (§ 0c issue).
  v2 candidate: a config option to infer them from component name patterns (`Spacing/4`).
- ❌ Grid styles — low frequency. v2.
- ❌ Variables modes (multi-mode) — v1 covers only the default mode. v2 will add
  `Tokens.modes: Record<modeName, ResolvedTokens>`.
- ❌ Gradient / image fills — not reflected in color tokens. v2 candidate.
- ❌ Multi-effect tokens — first effect only. In a design system, 1 effect = 1
  style is the normal pattern.
- ❌ Fully-resolved values from external library references (sourceLibraryKey) —
  values not in the local .fig are left missing.

## 8. Test fixture results (round 33)

| Fixture | colors | typography | effects |
|---|---|---|---|
| `bvp.fig` | 1 | 40 | 2 |
| `MetaRich Screen UI Design.fig` | 22 | 22 | 1 |

Sample JSON output (bvp):

```json
{
  "colors": {
    "Global / Neutral Grey / 1300": { "value": "#0a090b" }
  },
  "typography": {
    "Caption/14 Regular": {
      "fontFamily": "Pretendard Variable",
      "fontStyle": "Regular",
      "fontSize": 14,
      "lineHeight": { "unit": "PX", "value": 20 },
      "letterSpacing": { "unit": "PX", "value": 0.1 }
    }
  },
  "effects": {
    "d_s": {
      "type": "DROP_SHADOW",
      "color": "#00000036",
      "offset": { "x": 0, "y": 4 },
      "radius": 12,
      "spread": 0
    }
  }
}
```

## 9. Resolved questions

- **Is Hangul preserved in slugs?** Yes. Figma designers frequently use Hangul
  style names (e.g. "Button/Default"). CSS also allows Hangul variable
  identifiers. Consumers needing ASCII-only must post-process.
- **How is lineHeight RAW unit emitted?** `{ unit: 'AUTO', value: <multiplier> }`.
  Can be used directly as a unitless line-height in CSS.
- **What about letterSpacing PERCENT?** `{ unit: 'PERCENT', value }`. When
  converting to CSS, `value/100 + 'em'`. Follows Figma's 100 = 1em convention.
- **What is the `--format css` variable prefix?** `--color-`, `--typography-`,
  `--shadow-`, `--blur-`. Consistent per-category prefixes.
