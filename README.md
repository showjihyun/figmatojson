<div align="center">

# figma-reverse

**Reverse-engineer `.fig` files into structured JSON, pencil.dev `.pen`, editable HTML — and edit them in a Konva canvas, all offline.**
No Figma API. No account. No cloud.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-43853d?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-784%20passing-brightgreen?style=flat-square)](./test)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-blueviolet?style=flat-square)](#-contributing)

[Quick start](#-quick-start) ·
[Outputs](#-outputs) ·
[Web editor](#-web-editor) ·
[How it works](#-how-it-works) ·
[Round-trip](#-round-trip-guarantees) ·
[CLI](#-cli) ·
[Dev guide](#-developer-guide)

⭐ **If this saved you a Figma API headache, please give it a star** — it's the only signal we have to keep the
unsupported edge-cases (variants, instance overrides, vector path geometry) covered.

</div>

---

## Why this exists

Figma's `.fig` format is **closed and undocumented**. The official REST API needs cloud-hosted files and a paid plan for the good bits (Dev Mode, Variables). Existing OSS parsers assume a single deflate-raw stream — but **modern Figma exports are ZIP-wrapped with a zstd-compressed data chunk**, so they break.

`figma-reverse` cracks the format open locally, end to end:

- 🔓 **Decode** — ZIP container → `fig-kiwi` archive → schema → message → tree of 35,000+ nodes
- 📤 **Export** — readable JSON, pencil.dev-compatible `.pen`, browsable HTML dashboards, embedded design tokens
- 🔁 **Repack** — go back to a valid `.fig` byte-identical, semantically equivalent, or with edits applied
- 🖥 **Edit** — React + Konva web editor: select / move / resize / patch any node, save back to `.fig`
- 🤖 **LLM-friendly** — JSON is shaped for RAG and tool calls; ships with an Anthropic Messages API tool-loop chat agent
- 🧪 **Spec-driven** — 60+ feature `.spec.md` files; every output format has invariants enforced by tests

Built for designers exporting backups, engineers migrating off Figma, RAG pipelines indexing design tokens, and anyone reverse-engineering proprietary binary formats.

---

## ✨ Features

| Capability | Notes |
|---|---|
| 🌐 Offline-first | Single `.fig` file in, structured outputs out. No network calls, no auth. |
| 🔍 Full pipeline visibility | Every stage (`01_container/` → `05_tree/`) dumped to disk for debugging |
| 🎨 pencil.dev compatible | Generates valid `.pen` files for direct import (page-seeded base62 IDs, viewport-normalized, globally unique) |
| ♻️ Three repack modes | Byte-identical, kiwi semantic, JSON edit-and-rebuild — all lossless |
| ⚡ Async I/O | `Promise.all`-parallel reads / writes; pen export of a 35K-node file in ~1.7 s |
| 🔬 Type-safe | Strict TypeScript, no `any`, fully typed kiwi schema |
| 🧪 784 tests | 162 main (unit + integration) + 622 web (component + helpers) + Playwright e2e |
| 🖥 Web editor | React 19 + Konva canvas + Inspector panel + chat agent (Anthropic Messages API tool loop) |
| 📐 Spec-driven | 60+ `docs/specs/*.spec.md` with invariants; every round of work documented |
| 🌍 Bilingual docs | Single-file `docs/dev-guide.html` (Korean / English toggle, 8 mermaid diagrams) |

---

## 🚀 Quick start

```bash
git clone https://github.com/showjihyun/figmatojson.git
cd figmatojson
npm install

# 1️⃣ Decode any .fig
npx tsx src/cli.ts extract docs/bvp.fig

# 2️⃣ See the verification report (per-stage byte counts, schema sanity, asset cross-check)
cat output/bvp/verification_report.md

# 3️⃣ (Optional) browse it in your editor of choice
cd web && npm install && npm run dev      # → http://localhost:5273
```

That's it. No API keys, no auth, no `.env`.

> **Try the bundled fixture** — `docs/bvp.fig` is a small public design (3,155 nodes, 3 pages) that ships with the repo.

---

## 📤 Outputs

A single `.fig` file produces **four CLI output formats + a Web editor**, each suited to a different consumer:

```
your.fig (6 MB)
   │
   ├─► output/your/                       (JSON for humans & RAG)
   │   ├── document.json                  ← entire tree, 1 file
   │   ├── pages/<n>_<name>.json          ← per-page split
   │   ├── assets/{images,vectors}/       ← deduped binaries
   │   └── verification_report.md
   │
   ├─► output/extracted/your/             (debugging breadcrumbs)
   │   ├── 01_container/  …  05_tree/     ← every pipeline stage on disk
   │   ├── 06_report/                     ← round-trip HTML viewer
   │   ├── 07_editable/figma.editable.html ← single-file HTML w/ embedded .fig
   │   └── 08_pen/<n>_<name>.pen          ← pencil.dev v2.11 native
   │       └── <n>_<name>.pen.json        ← + Figma round-trip metadata
   │
   ├─► dashboard/                         (browsable UI)
   │   └── index.html                     ← tabs: Overview · Pages · Pen · Tree · Schema · Verify
   │
   ├─► tokens.json                        (design tokens for design systems)
   │   └── colors / typography / spacing  ← ready-to-import shape
   │
   └─► repacked.fig                       (round-trip)
       └── via `figma-reverse repack`
```

A separate **Web editor** opens the document on a Konva canvas and patches it in memory; download as `.fig` from the browser.

---

## 🖥 Web editor

```bash
cd web && npm install && npm run dev      # client :5273 + backend :5274
```

What you get:

| Panel | What it does |
|---|---|
| **Konva canvas** | Renders pages with vector paths, INSTANCE expansion, fills/strokes, drop shadows, blur effects, auto-layout |
| **Layer tree** | Hierarchical sidebar (variant labels stripped to `XL, default, primary` — Figma-native UX) |
| **Inspector** | Position / Size / Auto-layout / Fill / Stroke / Text editing with library color trail (`Button/Primary/Default → Color/Blue/600`) |
| **Asset list** | All masters at a glance — click to navigate |
| **Chat agent** | Natural-language editing via Anthropic Messages API tool loop (resize, recolor, swap variants, …) |
| **Save** | One-click `.fig` download — JSON Repack mode round-trip-safe |

Built on the same `src/` domain modules the CLI uses, so a parser change in CLI propagates to the editor automatically.

---

## 🧬 How it works

The CLI pipeline is **9 strict stages**, each with a single responsibility and a disk artifact you can inspect:

```
.fig file
 │
 │ ▼ Stage 1 — Container         ZIP STORE unwrap (canvas.fig + meta.json + images/)
 │ ▼ Stage 2 — Archive           fig-kiwi prelude + version + chunks
 │ ▼ Stage 3 — Decompress        deflate-raw / zstd auto-detected (the project's core finding)
 │ ▼ Stage 4 — Decode            kiwi schema (568 type defs) → message
 │ ▼ Stage 5 — Tree              35,660 Kiwi Records → linked Tree Nodes
 │ ▼ Stage 6 — Image refs        node ↔ SHA-1 hash deduplication
 │ ▼ Stage 7 — Vectors           best-effort SVG path extraction (95% success)
 │ ▼ Stage 8 — Normalize/Export  document.json, pages/*, assets/*
 │ ▼ Stage 9 — Verify            invariant check → verification_report.md
 ▼
output/  +  output/extracted/
```

Need a different output? Plug into any stage:

- **Stage 5 output** → write your own exporter (see `pen-export.ts` for a ~1,500-line reference)
- **Stage 4 output (`message.json`)** → edit JSON, re-encode via `repack --mode json`
- **Stage 1 output** → reroute container files into a different bundle format

For the data-shape glossary (Kiwi Record / Tree Node / Pen Node / Master / Instance / Override / Expansion / GUID / Pen ID / Direct vs Effective Visibility / …), see [`CONTEXT.md`](./CONTEXT.md).

For diagrams of all of the above plus the Web editor, the SDD methodology, and the Round 11~18-B history, see **[`docs/dev-guide.html`](./docs/dev-guide.html)** (Korean / English toggle, 8 mermaid diagrams).

---

## 🔁 Round-trip guarantees

This is the project's hill-to-die-on. **Three Repack modes, three equality strengths**, no lossy mode ever ([ADR-0002](./docs/adr/0002-roundtrip-equality-tiers.md)):

| Mode | Input | Output equality | When to use |
|---|---|---|---|
| **byte** | `extracted/01_container/` raw files | `canvas.fig` byte-identical to original | Backup / archival; safe baseline |
| **kiwi** | `extracted/03_decompressed/` binaries | Semantically equivalent (same nodes, same schema, deflate-raw recompressed) | Deterministic re-encode |
| **json** | Edited `extracted/04_decoded/message.json` | Semantically equivalent after edits | The only mode that picks up user edits |

JSON roundtrip is **lossless** (special encoding for `Uint8Array`, `NaN`/`Infinity`, `bigint`):

```ts
// What plain JSON drops:                What we tag and restore:
new Uint8Array([1,2,3])  →  null    ✗   { __bytes: "AQID" }              ✓
NaN                      →  null    ✗   { __num: "NaN" }                 ✓
Infinity                 →  null    ✗   { __num: "Infinity" }            ✓
123n                     →  TypeError✗  { __bigint: "123" }              ✓
```

---

## 💻 CLI

**Seven** subcommands. `--help` on any.

```bash
# 1️⃣  extract — .fig → JSON + assets
npx tsx src/cli.ts extract <input.fig> [output-dir] \
       [--minify] [--no-document] [--no-vector] [--no-intermediate] \
       [--include-raw-message] [--extracted-dir <path>]

# 2️⃣  repack — extracted/ → .fig (3 modes)
npx tsx src/cli.ts repack <extracted-dir> <out.fig> \
       [--mode byte|kiwi|json] [--original <orig.fig>]

# 3️⃣  pen-export — .fig → pencil.dev .pen + .pen.json (per page)
npx tsx src/cli.ts pen-export <input.fig> [--out <path>]

# 4️⃣  editable-html — .fig → single-file HTML with embedded .fig (downloadable!)
npx tsx src/cli.ts editable-html <input.fig> --out <path> [--single-file]

# 5️⃣  html-report — extracted+output → browser dashboard
npx tsx src/cli.ts html-report <extracted-dir> <out-path> [--single-file]

# 6️⃣  round-trip-html — extracted/ → 06_report/figma-round-trip.html viewer
npx tsx src/cli.ts round-trip-html <extracted-dir>

# 7️⃣  tokens — .fig → tokens JSON (colors / typography / spacing)
npx tsx src/cli.ts tokens <input.fig>
```

`--help` on any subcommand for the full option list.

---

## 📊 Real numbers (sample 6 MB `.fig`, 35,660 nodes)

| Operation | Time | Size out |
|---|---|---|
| `extract` (full pipeline)         | ~3 s | 87 MB total (output + extracted) |
| `pen-export` (6 pages, 64 K nodes) | **~1.8 s** | 47 MB across 12 files |
| `repack --mode byte`              | **~1.3 s** | 6 MB (byte-identical) |
| `repack --mode kiwi`              | ~5.5 s | 7 MB (semantically equivalent) |
| `html-report` (multi-file)        | ~3.2 s | 97 MB browsable |

**Decoded message**: 35,660 nodes · 568 schema types · archive version 106 · 6,094 binary blobs · 1,599 vector paths extracted as SVG.

**Pen-export accuracy** vs pencil.dev reference: **99.6%** node match (1,392 / 1,397) and **98.98%** CSS coverage across 1,865 property comparisons — see [`docs/SPEC.md`](./docs/SPEC.md) for the few known edge cases.

**Audit harness** (round 17, see `docs/specs/audit-oracle.spec.md`): 17,283 / 18,301 Figma nodes matched on a real fixture (HPAI), **204 field-level diffs** (97.3% reduction from a pre-fix 7,562 baseline). 0 silent field drops, 0 JSON serialization failures, 0 broken `componentPropAssignments`.

---

## 🗺 Project structure

```
src/                              # shared domain — used by both CLI and Web
├── cli.ts                        # 7-subcommand router
├── container.ts                  # Stage 1 — ZIP unwrap
├── archive.ts decompress.ts      # Stage 2-3 — fig-kiwi + deflate/zstd
├── decoder.ts                    # Stage 4 — kiwi decode
├── tree.ts                       # Stage 5 — Kiwi Records → Tree Nodes
├── assets.ts vector.ts           # Stage 6-7 — image dedup, SVG path extract
├── normalize.ts export.ts        # Stage 8 — final JSON output
├── verify.ts                     # Stage 9 — invariant report
├── intermediate.ts               # All `extracted/<n>_<name>/` dumps
├── repack.ts                     # Reverse pipeline (byte / kiwi / json)
├── pen-export.ts                 # pencil.dev .pen exporter
├── html-export.ts                # Multi-file dashboard generator
├── editable-html.ts              # Single-file HTML with embedded .fig
├── tokens.ts                     # Design-tokens dump
├── instanceOverrides.ts          # Master ↔ Instance reduction
├── masterIndex.ts expansion.ts   # Component-Set + variant expansion
└── effectiveVisibility.ts        # 3-mechanism visibility composition

web/                              # editor (Clean + Hexagonal layering)
├── core/
│   ├── domain/                   # entities, pure helpers (no IO, no React)
│   ├── ports/                    # SessionStore, FsLike, …
│   └── application/              # EditNode, ResizeNode, RunChatTurn, AuditCompare, …
├── server/adapters/
│   ├── driven/                   # FsSessionStore, KiwiCodec, …
│   └── driving/http/             # Hono routes (uploadRoute, docRoute, saveRoute, …)
├── client/src/                   # React 19 + Konva
│   ├── Canvas.tsx                # plan-driven NodeShape (vector / text / paint-stack)
│   ├── Inspector.tsx             # right panel with Fill / Stroke / Text / Auto-layout
│   ├── components/sidebar/       # LayerTree + AssetList + PagesSection
│   ├── render/nodeRender.ts      # pure plan generator
│   └── lib/                      # blendMode, gradient, shadow, textStyle, …
└── scripts/                      # audit-* harness (5 scripts)

test/                             # CLI vitest (162 tests)
docs/
├── dev-guide.html                # ★ single-file bilingual developer guide
├── PRD.md                        # product requirements
├── SDD.md                        # spec-driven dev methodology
├── HARNESS.md                    # 5-layer verification harness
├── SPEC.md                       # 9-stage pipeline spec
├── SPEC-architecture.md          # current architecture
├── SPEC-roundtrip.md             # round-trip vision + 3-mode detail
├── SPEC-figma-to-pencil.md       # pen-export contract
├── SPEC-repack.md                # repack 3-mode detail
├── adr/                          # architecture decision records
└── specs/                        # 60+ per-feature .spec.md

CONTEXT.md                        # ★ domain glossary (read this first)
```

---

## 🛠 Tech stack

**CLI / domain (`src/`)** — 4 runtime deps:

- **TypeScript** strict mode + ESM
- **kiwi-schema** for binary encode/decode (Evan Wallace's spec)
- **adm-zip** for ZIP STORE
- **fzstd** (decode-only) + **pako** (deflate-raw) for chunk compression

**Web editor (`web/`)** — adds:

- **React 19** + **Konva** for the canvas
- **Vite 7** + **Hono** (backend)
- **Anthropic SDK** for the chat agent
- **Playwright** for end-to-end browser tests

**Test**: vitest with single-fork pool for deterministic e2e + Playwright headless.

---

## 🧪 Testing

```bash
npm test                         # CLI: 162 tests
cd web && npm test               # Web: 622 tests
cd web && npm run test:e2e       # Playwright e2e
npm run typecheck                # strict TS, baseline 0 errors
```

Coverage of note:

- **byte-identical round-trip** (`extract → repack --mode byte → re-extract`)
- **semantic equivalence** (`extract → repack --mode kiwi → re-extract`)
- **JSON round-trip** with `Uint8Array` / `NaN` / `bigint` preservation
- **Visibility resolution** (3 mechanisms × variants)
- **ID uniqueness** (within page + globally across pages)
- **Viewport normalization** for pencil.dev import
- **CSS coverage regression guard** — diffs the produced `.pen` against pencil.dev's reference, asserts text styling 100% match and per-type mismatch counts under calibrated thresholds
- **Audit harness** (5 scripts) — round-trip ZIP byte compare, kiwi field-walk diff, REST oracle, raw coverage, properties coverage

---

## 📚 Developer guide

- **First read**: [`CONTEXT.md`](./CONTEXT.md) — domain glossary (Kiwi Record / Tree Node / Pen Node / …)
- **Then**: [`docs/dev-guide.html`](./docs/dev-guide.html) — single-file bilingual guide with 8 mermaid diagrams
- **Per stage**: [`docs/SPEC.md`](./docs/SPEC.md), [`docs/SPEC-architecture.md`](./docs/SPEC-architecture.md), [`docs/SPEC-roundtrip.md`](./docs/SPEC-roundtrip.md)
- **Methodology**: [`docs/SDD.md`](./docs/SDD.md) — spec-driven dev. Iron rule: *no merge without a spec*.
- **Per feature**: 60+ files under [`docs/specs/`](./docs/specs/) — each round of work documented

---

## 🗒 Recent rounds (highlights)

| Round | Theme |
|---|---|
| **18-B** | Inspector alias trail "A → B → C" with cycle / dead-end / depth-cap markers |
| 18-A | `resolveVariableChain` domain helper + 11 unit tests |
| 17 | Audit raw-field + properties coverage harness (97% noise reduction) |
| 16 + 16.1 | `styleIdForText` effective typography (+ scope-leak hotfix) |
| 15 | Inspector library color / text-style names |
| 14 | Strip variant `prop=` prefixes ("size=XL" → "XL") |
| 11–13 | Vector render fidelity (path inset / scale / INSIDE strokeAlign) |

Full PR history: see GitHub releases or `git log --oneline main`.

---

## 🤝 Contributing

Bug reports, edge-case `.fig` files, and PRs welcome. Before opening a PR:

1. Run `npm test` (CLI) and `cd web && npm test` (Web)
2. Run `npm run typecheck` — both projects must stay at baseline 0 new errors
3. If you're touching the pipeline, read [`CONTEXT.md`](./CONTEXT.md) for the domain language
4. If you're proposing a new output format / repack mode / Inspector field, sketch a spec in `docs/specs/<feature>.spec.md` first (SDD iron rule)
5. Sample fixtures live in `docs/` (`bvp.fig` 6 MB, a 35K-node design file). For other reproductions please attach the `.fig` to the issue.

For Claude Code users: this repo ships with three project skills in `.claude/skills/` (`figma-cli`, `figma-pen-export`, `figma-internals`) that auto-load when you work in the relevant area.

---

## 📜 License

[MIT](./LICENSE) — use commercially, modify freely, no warranty.

---

## 🙏 Acknowledgments

- **[Evan Wallace](https://github.com/evanw/kiwi)** — kiwi binary schema
- **[Albert Sikkema](https://albertsikkema.com/)** — Figma Make `.make` container analysis (key prior art)
- **[easylogic](https://easylogic.studio/)** — `fig-kiwi` npm package + early reference parser
- **[pencil.dev](https://pencil.dev/)** — `.pen` v2.11 schema target
- **[Anthropic](https://anthropic.com)** — Messages API powers the web editor's chat agent

Built with [Claude Code](https://claude.com/claude-code) — see commit history for the AI/human collaboration trail.

---

<div align="center">

**⭐ If this saved you time or unblocked a stuck migration, please give it a star.**
**Issues, edge-case `.fig`s, and PRs all welcome.**

</div>
