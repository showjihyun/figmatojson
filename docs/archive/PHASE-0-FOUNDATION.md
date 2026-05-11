# Phase 0 — Developer-tool foundation

| Item | Value |
|---|---|
| Status | Inventory + decision draft (started in round 33) |
| Goal | Define the stable surface (CLI / HTTP / library / token schema) on which Phase 1~5 of the developer-tool vision depend |
| Follow-ups | `docs/specs/tokens.spec.md` (Phase 1), `docs/api/cli.md` & `docs/api/http.md` (reference docs) |

This document is an inventory of *what has been built so far* and a first-pass proposal for the *public surface* that Phase 1~5 will expose externally. After user confirmation it will be split into specs.

## 0a. Current state of the CLI surface

### Registered subcommands

| Subcommand | Status | Input → Output | Primary use case |
|---|---|---|---|
| `extract` | 🟢 stable | `<input.fig>` → `output/<name>/{document.json, pages/*, assets/*, ...}` + `extracted/<name>/01_container/...` | .fig decode |
| `repack` | 🟢 stable | `<extracted-dir> <out.fig>` (`--mode byte\|kiwi\|json`) | edited JSON → .fig |
| `html-report` | 🟢 stable | `<extracted-dir> [out-dir]` (`--single-file`) | interactive dashboard |
| `editable-html` | 🟢 stable | `<input.fig>` → single .html (`--single-file` inlines all assets) | design preview + editing entry point |
| `pen-export` | 🟢 stable | `<input.fig> [out-dir]` → per-page `<idx>_<page>.pen.json` | for the Pencil tool |
| `round-trip-html` | 🔴 deprecated | (merged into `editable-html --single-file` above) | (legacy) |

### Missing subcommands (Phase 1+ candidates)

- `tokens` — design token extraction (Phase 1)
- `diff` — structural diff between two .fig files (Phase 3)
- `lint` — guideline validation (Phase 4)
- `convert` — `.fig` → SVG / React stub / Storybook (part of Phase 2; today `pen-export` handles one format)

### CLI option / output stability policy (proposed)

- 🟢 stable: emitted filenames (`document.json`, `pages/*.json`, `assets/...`) and JSON top-level fields. **Breaking changes require a major version bump.**
- 🟡 stable-but-internal: `extracted/<name>/01..05_*` intermediate artifacts. For debugging; external dependence discouraged.
- 🔴 unstable / experimental: `--include-raw-message` (kiwi raw), `04_decoded/message.json` schema. May change in minor versions.

## 0b. Current state of the web HTTP API

`web/server` (Hono backend, default `:5274`).

| Method | Path | Responsibility | Stability |
|---|---|---|---|
| GET | `/` | health text | 🟢 |
| POST | `/api/upload` | multipart `.fig` → `{ sessionId, origName, pageCount, nodeCount }` | 🟢 |
| GET | `/api/doc/:id` | returns the session's `documentJson` | 🟢 |
| PATCH | `/api/doc/:id` | `{nodeGuid, field, value}` → mutate node field | 🟢 |
| POST | `/api/save/:id` | repack → `application/octet-stream` (.fig download) | 🟢 |
| POST | `/api/instance-override/:id` | apply INSTANCE text override | 🟢 |
| POST | `/api/resize/:id` | apply resize | 🟢 |
| GET | `/api/asset/:id/:hash` | return image/vector blob | 🟢 |
| GET | `/api/session/:id/snapshot` | session → snapshot download | 🟢 |
| POST | `/api/session/load` | snapshot → new session | 🟢 |
| POST | `/api/undo/:id` | roll back last edit | 🟢 |
| POST | `/api/redo/:id` | reapply rolled-back edit | 🟢 |
| POST | `/api/audit/compare` | session vs Plugin/REST tree → per-field diff | 🟢 (round 30+) |
| POST | `/api/chat/:id` | Anthropic Agent SDK chat (experimental) | 🟡 internal |

### Missing endpoints (Phase 1+ candidates)

- `GET /api/tokens/:id` — session design tokens (Phase 1, same output as CLI `tokens`)
- `POST /api/diff` — structural diff between two sessions/two .fig files (Phase 3)
- `POST /api/lint/:id` — lint result (Phase 4)

### Stability policy

- 🟢 stable: the URL patterns above + top-level keys in the response JSON. Backward compatibility preserved across minor changes.
- 🟡 internal: `/api/chat/*` (experimental), the sample shape of `/api/audit/compare`.
- Session ids have a 1-hour TTL (env `SESSION_GC_AGE_MS`), so external clients must always follow a *re-upload then retry* pattern.

## 0c. Token output schema (Phase 1 input — DRAFT)

### Output shape (first draft)

```ts
interface Tokens {
  schemaVersion: '1';
  source: { figName: string; sha256: string };
  colors: Record<string, ColorToken>;
  typography: Record<string, TypographyToken>;
  spacing: Record<string, number>;       // px
  effects: Record<string, EffectToken>;
}

interface ColorToken {
  // CSS-compatible hex (#RRGGBBAA when opacity < 1, #RRGGBB otherwise).
  // For tokens that resolve to gradients we emit `gradient`, otherwise `value`.
  value?: string;
  gradient?: GradientStop[];
  description?: string;
}

interface TypographyToken {
  fontFamily: string;
  fontSize: number;       // px (Figma's authored value)
  fontWeight: number;     // 100-900
  lineHeight: number | { unit: 'PX' | 'PERCENT'; value: number };
  letterSpacing: number;  // px (default 0)
  description?: string;
}

interface EffectToken {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  // DROP_SHADOW / INNER_SHADOW
  color?: string;         // hex w/ alpha
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
  // BLUR
  blur?: number;
  description?: string;
}
```

### Input source

Figma's *published styles*: color styles, text styles, effect styles, grid styles. Based on the kiwi schema: `data.styleType` / `fillPaints` / `textData` etc.

> Note: spacing tokens are *not exposed as a first-class style* in Figma. Design systems use their own conventions (e.g., shown as components named `Spacing/4`, `Spacing/8`). v1 starts by accepting designer-agreed extraction rules via user config — or simplifies v1 by omitting spacing (color / typography / effects only) and adding it in v2.

### Output format options (CLI `--format`)

| Format | Output |
|---|---|
| `json` (default) | the `Tokens` interface above as JSON |
| `css` | CSS variables (`--color-primary-500: #...`) |
| `js` | ESM exports (`export const colors = { ... }`) |
| `ts` | TypeScript with shape (`export const tokens: Tokens = {...}`) |

### Deferred decisions

- 🟡 Variables handling — Figma's design variables system (per-mode multi-value). v1 emits *resolved values* only (default mode); v2 will emit per-mode output.
- 🟡 Spacing extraction algorithm — by component name pattern? Padding statistics?
- 🟡 Nested token references — namespace handling such as `color.primary.500`.

## 0d. npm packaging strategy

### Current structure

- Repo-root `package.json` = `figma-reverse` (CLI bin + library)
- `web/package.json` = `figma-reverse-web` (private, dev-only)
- `figma-plugin/` = not packaged (imported into Figma Desktop from manifest)

`main: "dist/cli.js"` — there is currently *no library import entry point*. If external code does `import { extractTokens } from 'figma-reverse'` it lands in CLI code.

### Option A — single package (recommended for v1)

```jsonc
{
  "name": "figma-reverse",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".":            "./dist/index.js",       // new lib entry
    "./cli":        "./dist/cli.js",         // existing CLI
    "./schema":     "./dist/schema/*.json",  // JSON schema files
    "./package.json": "./package.json"
  },
  "bin": { "figma-reverse": "dist/cli.js" }
}
```

- New: `src/index.ts` re-exports the public API only (see *Public API* in the next section).
- Existing code is untouched. CLI keeps working; library consumers reach the lib through the new entry.

Pros: users install one package; dependency management stays simple.
Cons: bundle size. Users who only need the CLI also pull in the lib code (~several MB).

### Option B — split (`@figma-reverse/{core,cli,plugin}`) — revisit in Phase 5+

A monorepo (workspace) structure. After Phase 1~4 ships, measure usage and decide. The single package is sufficient for now.

### Recommendation: Option A + an explicit `exports` map

### Public API surface (first draft — `src/index.ts`)

```ts
// Parsing
export { extractFig } from './export.js';            // .fig bytes → result object
export { decodeFigCanvas } from './decoder.js';       // .fig bytes → kiwi message
export type { DecodedFig } from './decoder.js';

// Repacking
export { repackFig } from './repack.js';

// Token (Phase 1 — new)
export { extractTokens } from './tokens.js';
export type { Tokens, ColorToken, TypographyToken, EffectToken } from './tokens.js';

// Audit (Phase 1+ — optional)
export { auditCompare } from './audit/compare.js';

// Explicitly internal: collectTextOverridesFromInstance, kiwi raw schema,
// overrideKey resolution for things like 1854:7875, etc. — not exported.
// A separate advanced API can be added later if needed.
```

### Versioning policy

- `0.x` (current): breaking changes are free.
- `1.0.0` (target after Phase 5 closes): the Public API + Token schema + HTTP API above are semver-stable.
- When a breaking change ships, the commit message *must* carry a `BREAKING:` prefix.

## Decisions needed (split into specs after user agreement)

1. **Spacing token handling** — is it OK to omit it in v1?
2. **Figma variables (modes)** — v1 default-mode-only, v2 multi-mode — OK?
3. **Split vs single package** — start with Option A (single) — OK?
4. **Public API export list** — anything missing from the `src/index.ts` draft above?
5. **CLI stability promise** — keep all 6 subcommands (excluding the 1 deprecated) through 1.0?
6. **HTTP API stability promise** — keep the 13 endpoints excluding `/api/chat/*` through 1.0?

Once the 6 items above are agreed → Phase 1 (`tokens` CLI + lib) starts.
