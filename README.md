<div align="center">

# figma-reverse

**Reverse-engineer `.fig` files into structured JSON, Pencil `.pen`, and editable HTML.**
Fully offline. Fully reversible. No Figma API, no account, no cloud.

[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Node](https://img.shields.io/badge/Node-%E2%89%A520-43853d?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![Tests](https://img.shields.io/badge/tests-87%20passing-brightgreen?style=flat-square)](./test)
[![License](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](./LICENSE)

[Quick start](#-quick-start) ·
[Outputs](#-outputs) ·
[How it works](#-how-it-works) ·
[Round-trip](#-round-trip-guarantees) ·
[CLI](#-cli)

</div>

---

## Why this exists

Figma's `.fig` format is **closed and undocumented**. The official REST API needs cloud-hosted files and a paid plan for the good bits (Dev Mode, Variables). Existing OSS parsers assume a single binary stream — but **modern Figma exports are ZIP-wrapped** and break them.

`figma-reverse` cracks the format open locally, end to end:

- 🔓 **Decode** — ZIP container → `fig-kiwi` archive → schema → message → tree of 35,000+ nodes
- 📤 **Export** — readable JSON, Pencil-compatible `.pen` files, browsable HTML dashboards
- 🔁 **Repack** — go back to a valid `.fig` byte-for-byte, or with edits applied
- 🤖 **AI-ready** — JSON outputs slot directly into RAG / LLM workflows; sample design encodes to ~140 KB of compact JSON per page

Built for designers exporting backups, engineers migrating off Figma, RAG pipelines indexing design tokens, and anyone reverse-engineering proprietary binary formats.

---

## ✨ Features

- **🌐 Offline-first** — single `.fig` file in, structured outputs out. No network calls, no auth.
- **🔍 Full pipeline visibility** — every stage (`01_container/` → `05_tree/`) dumped to disk for debugging
- **🎨 Pencil.dev compatible** — generates valid `.pen` files for direct import (page-seeded base62 IDs, viewport-normalized, globally unique)
- **♻️ Reversible** — three repack modes: byte-identical, kiwi semantic, JSON edit-and-rebuild
- **⚡ Async I/O** — `Promise.all`-parallel reads / writes; pen export of a 35K-node file in ~1.7s
- **🔬 Type-safe** — strict TypeScript, no `any`, fully typed kiwi schema
- **🧪 Tested** — 87 unit + e2e tests, including byte-identical roundtrip, lossless JSON round-trip, ID uniqueness, visibility resolution
- **📐 Spec-driven** — every output format has a `docs/specs/*.spec.md` with invariants

---

## 🚀 Quick start

```bash
git clone https://github.com/showjihyun/figmatojson.git
cd figmatojson
npm install

# Extract a .fig file → output/ + extracted/
npx tsx src/cli.ts extract path/to/your.fig

# Convert to Pencil .pen (one per Figma page)
npx tsx src/cli.ts pen-export path/to/your.fig

# Browse the result in HTML
npx tsx src/cli.ts html-report ./extracted/your ./dashboard
open dashboard/index.html
```

That's it. No API keys, no auth, no `.env`.

---

## 📤 Outputs

A single `.fig` file produces **four complementary representations**, each suited to a different consumer:

```
your.fig (6 MB)
   │
   ├─► output/your/                       (JSON for humans & RAG)
   │   ├── document.json                  ← entire tree, 1 file
   │   ├── pages/<n>_<name>.json          ← per-page split
   │   ├── assets/{images,vectors}/       ← deduped binaries
   │   └── verification_report.md
   │
   ├─► extracted/your/                    (debugging breadcrumbs)
   │   ├── 01_container/  …  05_tree/     ← every pipeline stage on disk
   │   ├── 07_editable/figma.editable.html ← single-file HTML w/ embedded .fig
   │   └── 08_pen/<n>_<name>.pen          ← Pencil v2.11 native
   │       └── <n>_<name>.pen.json        ← + Figma round-trip metadata
   │
   ├─► dashboard/                         (browsable UI)
   │   └── index.html                     ← tabs: Overview · Pages · Pen · Tree · Schema · Verify
   │
   └─► repacked.fig                       (round-trip)
       └── via `figma-reverse repack`
```

---

## 🧬 How it works

The pipeline is **9 strict stages**, each with a single responsibility and a disk artifact you can inspect:

```
.fig file
 │
 │ ▼ Stage 1 — Container         ZIP STORE unwrap (canvas.fig + meta.json + images/)
 │ ▼ Stage 2 — Archive           fig-kiwi prelude + version + chunks
 │ ▼ Stage 3 — Decompress        deflate-raw / zstd auto-detected
 │ ▼ Stage 4 — Decode            kiwi schema (568 type defs) → message
 │ ▼ Stage 5 — Tree              35,660 Kiwi Records → linked Tree Nodes
 │ ▼ Stage 6 — Image refs        node ↔ SHA-1 hash deduplication
 │ ▼ Stage 7 — Vectors           best-effort SVG path extraction
 │ ▼ Stage 8 — Normalize/Export  document.json, pages/*, assets/*
 │ ▼ Stage 9 — Verify            invariant check → verification_report.md
 ▼
```

Need a different output? Plug into any stage:

- **Stage 5 output** → write your own exporter (see `pen-export.ts` for a 1,200-line reference)
- **Stage 4 output (`message.json`)** → edit JSON, re-encode via `repack --mode json`
- **Stage 1 output** → reroute container files into a different bundle format

The full domain glossary is in [`CONTEXT.md`](./CONTEXT.md).

---

## 🔁 Round-trip guarantees

This is the project's hill-to-die-on. **Three Repack modes, three equality strengths**, no lossy mode ever ([ADR-0002](./docs/adr/0002-roundtrip-equality-tiers.md)):

| Mode | Input | Output equality | When to use |
|---|---|---|---|
| **byte** | `extracted/01_container/` raw files | `canvas.fig` byte-identical to original | Backup / archival; safe baseline |
| **kiwi** | `extracted/03_decompressed/` binaries | Semantically equivalent (same nodes, same schema, deflate-raw recompressed) | When you want a deterministic re-encode |
| **json** | Edited `extracted/04_decoded/message.json` | Semantically equivalent after edits | The only mode that incorporates user changes |

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

Five subcommands. `--help` on any.

```bash
# Extract  — .fig → JSON + assets
npx tsx src/cli.ts extract <input.fig> [--minify] [--no-document] [--include-raw-message]

# Repack   — extracted/ → .fig
npx tsx src/cli.ts repack <extracted-dir> <out.fig> [--mode byte|kiwi|json] [--original <orig.fig>]

# Pen      — .fig → Pencil .pen + .pen.json (per page)
npx tsx src/cli.ts pen-export <input.fig>

# HTML     — extracted+output → browser dashboard
npx tsx src/cli.ts html-report <extracted-dir> <out-dir> [--single-file]

# Editable — .fig → single-file HTML with embedded .fig (downloadable!)
npx tsx src/cli.ts editable-html <input.fig> --single-file
```

`--help` on any subcommand for the full option list.

---

## 📊 Real numbers (sample 6 MB `.fig`)

| Operation | Time | Size out |
|---|---|---|
| `extract` (full pipeline)         | ~3s | 87 MB total (output + extracted) |
| `pen-export` (6 pages, 64 K nodes) | **~1.8s** | 47 MB across 12 files |
| `repack --mode byte`              | **~1.3s** | 6 MB (byte-identical) |
| `repack --mode kiwi`              | ~5.5s | 7 MB (semantically equivalent) |
| `html-report` (multi-file)        | ~3.2s | 97 MB browsable |

Decoded message: **35,660 nodes**, **568 schema types**, **archive version 106**, **6,094 binary blobs**, **1,599 vector paths** extracted as SVG.

Pencil match against reference: **99.6%** (1,392 of 1,397 nodes) — see [SPEC.md §8](./docs/SPEC.md) for the 5 known edge cases.

---

## 🗺 Project structure

```
src/
├── cli.ts                 # CLI router (5 subcommands)
├── container.ts           # Stage 1 — ZIP unwrap
├── decoder.ts             # Stage 2-4 — kiwi archive + decode
├── decompress.ts          # deflate-raw / zstd auto-detect
├── tree.ts                # Stage 5 — Kiwi Records → Tree Nodes
├── assets.ts              # Stage 6 — image ref dedup
├── vector.ts              # Stage 7 — SVG path extraction
├── export.ts              # Stage 8 — final JSON output
├── verify.ts              # Stage 9 — invariant report
├── intermediate.ts        # All `extracted/<n>_<name>/` dumps
├── repack.ts              # Reverse pipeline (byte / kiwi / json)
├── pen-export.ts          # Pencil .pen exporter (the dense one)
├── html-export.ts         # Dashboard generator
└── editable-html.ts       # Single-file HTML with embedded .fig

docs/
├── PRD.md                 # Product requirements (Korean)
├── SDD.md                 # Spec-driven dev methodology
├── SPEC.md                # Full pipeline spec
├── HARNESS.md             # Verification harness
├── adr/                   # Architecture decision records
└── specs/                 # Per-feature specs (round-trip invariants, etc.)

CONTEXT.md                 # Domain glossary (read this first)
.claude/skills/            # Project-specific Claude Code skills
```

---

## 🛠 Tech stack

- **TypeScript** strict mode + ESM
- **kiwi-schema** for binary encode/decode (Evan Wallace's spec)
- **adm-zip** for ZIP STORE (no compression, matching Figma's wire format)
- **fzstd** (decode-only) + **pako** (deflate-raw) for chunk compression
- **vitest** with single-fork pool for deterministic e2e tests
- **0 runtime deps** outside the four above

---

## 🧪 Testing

```bash
npm test                  # 87 tests
npm run typecheck         # strict TS
```

Includes:
- byte-identical round-trip (`extract → repack --mode byte → re-extract`)
- semantic equivalence (`extract → repack --mode kiwi → re-extract`)
- JSON round-trip with `Uint8Array` / `NaN` / `bigint` preservation
- visibility resolution (3 mechanisms × variants)
- ID uniqueness (within page + globally across pages)
- viewport normalization for pencil.dev import

---

## 🤝 Contributing

Bug reports, edge-case `.fig` files, and PRs welcome. Before opening a PR:

1. Run `npm test` and `npm run typecheck`
2. If you're touching the pipeline, read [`CONTEXT.md`](./CONTEXT.md) for the domain language
3. If you're proposing a new output format or repack mode, sketch a spec in `docs/specs/<feature>.spec.md` first

For Claude Code users: this repo ships with three project skills in `.claude/skills/` (`figma-cli`, `figma-pen-export`, `figma-internals`) that auto-load when you work in the relevant area.

---

## 📜 License

[MIT](./LICENSE) — use commercially, modify freely, no warranty.

---

## 🙏 Acknowledgments

- **[Evan Wallace](https://github.com/evanw/kiwi)** — kiwi binary schema
- **[Albert Sikkema](https://albertsikkema.com/)** — Figma Make `.make` container analysis (key prior art)
- **[easylogic](https://easylogic.studio/)** — fig-kiwi npm package + early reference parser
- **[Pencil](https://pencil.dev/)** — `.pen` v2.11 schema target

Built with [Claude Code](https://claude.com/claude-code) — see commit history for the AI/human collaboration trail.
