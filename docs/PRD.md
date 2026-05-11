# PRD — `.fig` file reverse-engineering → structured Export pipeline

| Item | Value |
|---|---|
| Document version | **v0.2** (reflects measured analysis) |
| Written | 2026-04-29 |
| Authors | Choi Ji + Claude (Planner/Executor/Verifier collaboration) |
| Target file | a sample design `.fig` (6,053,077 bytes) |
| Reference design | a Figma Cloud design file |
| Status | Draft → enter Plan-Execute-Verify loop after user approval |

---

## 1. Background

### 1.1 Problem statement

Figma's `.fig` file is an **internal binary format with no official spec**. The public REST API requires a separate file key + token, and some data (Dev Mode, Variables) is tied to paid plans. As a result, the value of a **lossless pipeline that converts a local `.fig` file into structured data on its own** is high — for backup / archival, automated design-token extraction, RAG / LLM input, migration to other tools, design-system governance, and so on.

### 1.2 Measured analysis (performed 2026-04-29, pre-reconnaissance)

This PRD is grounded in **facts verified by binary inspection of the attached real file**.

#### 1.2.1 Outer container layer

```
$ file sample.fig
→ Zip archive data, at least v2.0 to extract, compression method=store

$ unzip -l sample.fig
  3,924,602  canvas.fig
     18,122  thumbnail.png
        340  meta.json
  (images/  13 PNGs, total ~2.1 MB)
```

This shape is **not the single-binary format assumed by every existing public `.fig` parser (Evan Wallace, Grida, fig-kiwi npm)**. It matches the container structure Albert Sikkema (2026-01) analyzed for Figma Make `.make` files. That is, **the latest export format downloaded from Figma Cloud is likely a ZIP-wrapped `.fig`.** ← **This is the first point that requires new reverse engineering in this project.**

#### 1.2.2 `meta.json` (clear-text JSON, 340 B)

```json
{
  "client_meta": {
    "background_color": { "r": 0.0689, "g": 0.0465, "b": 0.0465, "a": 1 },
    "thumbnail_size":   { "width": 399, "height": 400 },
    "render_coordinates": { "x": 213, "y": -273, "width": 3090, "height": 3100 }
  },
  "file_name": "Sample Design UI",
  "developer_related_links": [],
  "exported_at": "2026-04-20T02:33:06.552Z"
}
```

#### 1.2.3 Inner `canvas.fig` (3.92 MB, the actual Kiwi binary)

```
First 32 bytes (hex):
6669 672d 6b69 7769  6a00 0000 a665 0000  b5bd 0998 6457 5930  7cce bdb7 969e 9e3d
└── fig-kiwi ──┘    └ length? ┘ └ ?    ─ compressed data ─ ...
```

- Magic header `fig-kiwi` confirmed → **standard format of the Design type** (distinct from FigJam: `fig-jam.`, Slides: `fig-deck`, Make: `fig-makee`)
- After the 8-byte magic, a dual-chunk structure (schema chunk + data chunk) is hypothesized. **The exact length-prefix format and compression algorithm (deflate vs zstd) for each chunk are pinned down during the measurement stage.**

#### 1.2.4 `images/` directory

13 files. Filenames are SHA-1 hashes (40 hex), no extension. A first-8-byte magic check shows **all PNG** (`89 50 4E 47 0D 0A 1A 0A`). Since JPEG/WebP/GIF may show up later, magic-based extension inference is required.

### 1.3 Scope of reverse engineering in this project

**Already known** (using prior work):
- The Kiwi binary serialization algorithm (Evan Wallace, public)
- General theory of chunk structure + dual compression (deflate + zstd) (easylogic, albertsikkema)
- A few RootTypes that public reference parsers can handle (`NodeChanges`, etc.)

**To be newly verified / reverse-engineered by this project**:
1. ⚠ **Outer ZIP container wrapping** — compensates for public parsers being limited to single binaries
2. ⚠ **Current (2026-04) distribution of Figma schema types** — Figma changes the schema without notice. We must base our work on the schema chunk extracted from the attached file
3. ⚠ **Length-prefix format right after the canvas.fig header** — measure whether the 4-byte LE uint32 after the 8-byte magic is the first chunk length, or some other format
4. ⚠ **Image hash ↔ node reference mapping** — where in the node tree the `imageRef` field (SHA-1 hash etc.) appears
5. ⚠ **VectorNetwork blob → SVG path conversion** — decoding `commandsBlob` / `vectorNetworkBlob`
6. ⚠ **Component / Instance / Variants relationship model** — present in the REST API, but the in-`.fig` representation can differ

---

## 2. Goals and Non-Goals

### 2.1 Goals

| # | Goal | Metric (success criterion) |
|---|---|---|
| G1 | **Near-lossless** node tree extraction | Page · frame · node counts within ±1% of what the Figma client displays |
| G2 | Output is **human-readable structure** | Single JSON, grep-able, with per-page split files |
| G3 | **Lossless asset extraction** | All 13 images extracted as proper files + reverse-referenceable by node ID |
| G4 | Output is **compatible with the Figma REST API response schema** | Where possible, use identical naming (`children`, `fills`, `absoluteBoundingBox`, etc.) |
| G5 | **Reproducible + verifiable** pipeline | Same input → same output. Auto-generate verification report |
| G6 | **Represents the same information as the reference Figma URL** | meta.json's file_name · background_color · render_coordinates match the cloud design |

### 2.2 Non-Goals (v1)

- ❌ `.fig` write-back (edit · repack) — read-only
- ❌ FigJam / Slides / Make file support (v2)
- ❌ Direct fetch from Figma cloud URL (user supplies the file)
- ❌ Auto-generation of HTML/React code from designs (separate project)
- ❌ Precise CSS conversion of gradients · blur · compound effects (best-effort only)
- ❌ Real-time WebSocket protocol decoding

---

## 3. Users and use scenarios

**Primary**: Choi Ji — Korean public-sector/enterprise AI systems developer; context spans KAHIS · HPAI · design-system automation.

**Three representative scenarios**:

1. **Archival**: regular backups against subscription expiry · service changes (cron downloads `.fig` → convert to JSON+assets → upload to S3)
2. **Automated design token extraction**: extract color · typography · spacing tokens from `document.json` via regex · AST and emit `tokens.json`, sync to Storybook · Tailwind config
3. **RAG input**: embed the design node tree with a Korean re-ranker + bge-m3 and build a semantic search system for designers

---

## 4. Functional requirements

### 4.1 Input

- **F-IN-01** ZIP-wrapped `.fig` (the current attached file format) — **required v1**
- **F-IN-02** Raw `fig-kiwi` binary (Evan Wallace tool–compatible) — **required v1** (auto-branch by header sniffing)
- **F-IN-03** Input file integrity check (CRC, ZIP structure validation, magic header validation)

### 4.2 Processing stages

- **F-PROC-01** Separate the container layer (ZIP → canvas.fig + meta.json + assets)
- **F-PROC-02** Extract Kiwi schema chunk + decompression (deflate/zstd auto-detect)
- **F-PROC-03** Decode the schema → type-definition table (separately exported as `schema.json`)
- **F-PROC-04** Decompress + Kiwi-decode the data chunk (root type: `NodeChanges`)
- **F-PROC-05** Node tree reconstruction (restore parent-child links, normalize GUIDs)
- **F-PROC-06** Page separation (per Canvas node)
- **F-PROC-07** Image hash ↔ `imageRef` mapping + magic-based extension inference
- **F-PROC-08** VectorNetwork blob → SVG path conversion (best-effort)
- **F-PROC-09** REST API-compatible normalization (field-name mapping)

### 4.3 Output (`output/` directory)

```
output/
├── document.json          # entire node tree (REST API-compatible structure)
├── pages/
│   ├── 0_<page-name>.json
│   └── ...
├── assets/
│   ├── images/
│   │   ├── <hash>.png       # extension inferred
│   │   └── ...
│   ├── vectors/
│   │   └── <node-id>.svg
│   └── thumbnail.png
├── schema.json            # extracted Kiwi schema (reverse-engineering deliverable)
├── metadata.json          # meta.json + additional extraction metadata
├── manifest.json          # index of every output + SHA-256 checksum
└── verification_report.md # verification result (V deliverable of the 4-stage Plan-Execute-Verify)
```

### 4.4 Non-functional requirements

| ID | Item | Criterion |
|---|---|---|
| NF-01 | Processing time | < 30 s for a 6 MB file (single thread, M-class CPU) |
| NF-02 | Memory usage | ≤ 5 × input file size |
| NF-03 | Determinism | Same input → same output (excluding timestamp fields) |
| NF-04 | Dependencies | Node.js v20+, npm packages only (avoid native builds) |
| NF-05 | Resilience | Graceful degradation on Figma schema changes — unknown types preserved as raw bytes + warning log |

---

## 5. Technical architecture

```
┌─────────────────┐
│  .fig (ZIP)     │
└────────┬────────┘
         │ unzip
         ▼
┌─────────────────────────────────────────────────────┐
│  canvas.fig (fig-kiwi)  +  meta.json  +  images/    │
└────────┬────────────────────────────────────────────┘
         │ parseHeader() → chunks[]
         ▼
┌─────────────────┐     ┌─────────────────┐
│ Schema Chunk    │     │ Data Chunk      │
│ (deflate)       │     │ (deflate or zstd)│
└────────┬────────┘     └────────┬────────┘
         │                       │
   pako.inflate              auto-detect
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌─────────────────┐
│ Kiwi Schema     │────▶│ Kiwi Decoder    │
│ (~534 types)    │     │ (NodeChanges)   │
└─────────────────┘     └────────┬────────┘
                                 │
                                 ▼
                       ┌─────────────────┐
                       │  Raw Node Array  │
                       └────────┬────────┘
                                │ tree-builder
                                ▼
                       ┌─────────────────┐
                       │  Node Tree (DAG) │
                       └────────┬────────┘
                                │ normalize + map assets
                                ▼
                       ┌─────────────────┐
                       │  output/*.json   │
                       │  output/assets/  │
                       └─────────────────┘
```

### 5.1 Core dependencies

| Package | Purpose | Note |
|---|---|---|
| `adm-zip` | ZIP container unwrap | No streaming (file is small) |
| `pako` | deflate / zlib decompression | Use inflate**Raw** (no header) |
| `fzstd` | Zstandard decompression | When magic `28 B5 2F FD` detected |
| `kiwi-schema` | Auto-generate the Kiwi decoder | schema.json → decoder.js |
| `fig-kiwi` (optional) | For reference comparison | Verification only |

### 5.2 Module structure

```
src/
├── container.ts        # ZIP unwrap / auto-branch for single binary
├── header.ts           # magic + chunk-length parsing
├── decompress.ts       # deflate/zstd auto-detect
├── kiwi.ts             # schema parser + decoder factory
├── tree.ts             # raw nodes → parent-child tree
├── normalize.ts        # REST API-compatible field mapping
├── assets.ts           # imageRef → hash mapping, magic-based ext
├── vector.ts           # commandsBlob → SVG path
├── verify.ts           # verification logic (measure G1~G6)
└── cli.ts              # entry point
```

---

## 6. Plan-Execute-Verify loop (sub-agent driven workflow)

The project advances as a **3-persona loop**. Each step's outputs are persisted under `plans/`, `logs/`, `output/`, so the next persona can restore context just by reading those files — making this directly reusable when migrating to real Claude Code sub-agents.

### 6.1 Persona definitions

| Persona | Role | Deliverables |
|---|---|---|
| 🧭 **Planner** | Defines · decomposes the next task unit; states the hypothesis | `plans/<n>_<topic>.md` |
| 🔧 **Executor** | Writes · runs code per the Plan; records results | `src/*`, `output/*`, `logs/<n>_run.log` |
| ✅ **Verifier** | Independently verifies Executor's output; accepts/rejects the hypothesis | `logs/<n>_verify.md` |

### 6.2 Loop cycle

```
┌──────────────────────────────────────────────────────────┐
│  Iteration N                                             │
│                                                          │
│  Planner ──▶ plans/N_*.md                                │
│      │                                                   │
│      ▼                                                   │
│  Executor ──▶ src/*, output/*, logs/N_run.log            │
│      │                                                   │
│      ▼                                                   │
│  Verifier ──▶ logs/N_verify.md (PASS / FAIL / PIVOT)     │
│      │                                                   │
│      ▼                                                   │
│  ┌──────────────┐    ┌──────────────┐    ┌────────────┐ │
│  │ PASS         │    │ FAIL         │    │ PIVOT      │ │
│  │ → next stage │    │ → re-run     │    │ → revise   │ │
│  │              │    │   same stage │    │   plan     │ │
│  └──────────────┘    └──────────────┘    └────────────┘ │
└──────────────────────────────────────────────────────────┘
```

### 6.3 Iteration roadmap

| # | Topic | Core hypothesis / verification question | Success criterion |
|---|---|---|---|
| **0** | Environment + dependencies | Node.js v20+, npm install works | `npm install` with no errors |
| **1** | ZIP container split | Attached file is ZIP with an inner canvas.fig | `extracted/canvas.fig` generated, magic = `fig-kiwi` ✅ (already verified) |
| **2** | canvas.fig chunk split | 8B magic + (4B LE length + chunk bytes) × N structure | Extract 2 chunks; each chunk's magic is zlib (`78 9C`) or zstd (`28 B5 2F FD`) |
| **3** | Schema chunk decode | Chunk 1 = Kiwi schema definition (~534 types) | Generate `schema.json`; print type count |
| **4** | Data chunk decode | Decoding chunk 2 with the schema yields the NodeChanges tree | Generate `raw_nodes.json`; identify root type |
| **5** | Node tree reconstruction | Tree can be built from parent IDs | Confirm DOCUMENT → CANVAS (page) → ... hierarchy |
| **6** | Image ↔ imageRef mapping | The `imageRef` field of the node tree matches all 13 hashes | Every image is referenced by at least one node |
| **7** | REST API-compatible normalization | Field names · hierarchy compatible with Figma REST responses | Convert a sample node to REST shape and verify |
| **8** | Vector extraction | commandsBlob → SVG path | Generate the SVG of at least one vector node |
| **9** | Final export + verification report | G1~G6 all satisfied | `verification_report.md` PASS |

Each Iteration **depends only on prior step outputs**, so a mid-run failure allows restart from that point.

### 6.4 Failure policy

- **FAIL (plain bug)** → Executor re-runs the same task, up to 3 times. The 4th attempt auto-PIVOTs.
- **PIVOT (hypothesis error)** → Planner revises the hypothesis. New hypotheses must follow only from the latest finding (no over-inference).
- **BLOCK (insufficient information)** → ask the user (e.g. "ignore this node type or preserve as raw bytes?").

---

## 7. Verification strategy

### 7.1 Automated verification (run by the Verifier)

| ID | Check | Method |
|---|---|---|
| V-01 | Input file integrity | ZIP CRC + canvas.fig magic re-confirmed |
| V-02 | Decoding losslessness | Kiwi-decode → Kiwi-encode → byte-level diff |
| V-03 | Tree consistency | Every child has an existing parent; no cycles |
| V-04 | Asset consistency | Every imageRef resolves into images/; every image is referenced at least once |
| V-05 | Determinism | Same input processed twice → identical SHA-256 |
| V-06 | meta.json agreement | meta.json values match the extracted document root metadata |

### 7.2 User-confirmed verification (requires user cooperation)

| ID | Check | Method |
|---|---|---|
| U-01 | Page count | User-visible page count in Figma cloud vs file count under `pages/` |
| U-02 | Frame name match | Grep major frame names in document.json |
| U-03 | Color accuracy | meta.json `background_color` (RGB ~0.069, 0.046, 0.046) ↔ Figma cloud BG |
| U-04 | Visual image comparison | Extracted PNG vs Figma cloud render |

---

## 8. Risks and mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Figma schema differs from reference-tool assumptions | Medium | High | Extract the schema chunk every time → generate the decoder dynamically |
| Compression algorithm switches to zstd | Medium | Medium | Try both algorithms; auto-branch by magic |
| commandsBlob format changes | Medium | Low | On failure, preserve raw bytes + warning log; best-effort in v1 |
| Unknown RootType | Low | Medium | Try NodeChanges first; on failure brute-force all RootTypes |
| Memory exhaustion on large files (>500 MB) | Low | Medium | Streaming is v2; v1 assumes in-RAM processing |
| Attached file contains paid components · licensed assets | - | - | Assumed to be the user's own assets. The user is responsible for external sharing |

---

## 9. Milestones

| Milestone | Deliverable |
|---|---|
| **M0** (current) | PRD v0.2 + measurement report |
| **M1** | Iteration 1~2 complete; chunk structure pinned |
| **M2** | Iteration 3~4 complete; schema + raw nodes JSON |
| **M3** | Iteration 5~7 complete; normalized document.json |
| **M4** | Iteration 8~9 complete; full output + verification report |

---

## 10. User decisions required (before entering M1)

Before approving this PRD, please make the following 4 decisions.

1. **Output detail level** — (a) Full REST API compatibility (100% field-name match, high conversion cost) / (b) Pragmatic (preserve Kiwi originals + add some aliases) / (c) Raw + minimal (prefer originals for debugging)
2. **Vector extraction priority** — Include in v1 or defer to v2? (Inclusion adds +1 iteration)
3. **Container-variant support scope** — v1 supports (a) ZIP-wrapped only / (b) Both ZIP + raw fig-kiwi (recommended)
4. **Language / runtime** — Node.js (TypeScript, recommended) / Python (kiwi library is immature) / Both

After your answers we enter the Plan-Execute-Verify loop starting from Iteration 0 (environment setup).

---

## Appendix A. References

- Evan Wallace, [Figma .fig file parser online](https://madebyevan.com/figma/fig-file-parser/)
- evanw, [kiwi: schema-based binary format](https://github.com/evanw/kiwi)
- Albert Sikkema (2026-01), [Reverse-Engineering Figma Make Files](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html)
- easylogic (2024-10), [Figma Inside — `.fig` file analysis](https://medium.com/@easylogic/figma-inside-fig-%ED%8C%8C%EC%9D%BC-%EB%B6%84%EC%84%9D-7252bef141da)
- allan-simon, [figma-kiwi-protocol (WebSocket frame decoder)](https://github.com/allan-simon/figma-kiwi-protocol)
- Grida Tools, [.fig File Parser and Viewer](https://grida.co/tools/fig)
- npm, [`fig-kiwi`](https://www.npmjs.com/package/fig-kiwi)

## Appendix B. Measured command log (for reproduction)

```bash
file sample.fig
# → Zip archive data, at least v2.0 to extract, compression method=store

unzip -l sample.fig
# → canvas.fig (3.92MB), thumbnail.png, meta.json, images/ (13 PNGs)

python3 -c "open('canvas.fig','rb').read(8)"
# → b'fig-kiwi'

python3 -c "print(open('images/<hash>','rb').read(8).hex())"
# → 89504e470d0a1a0a (PNG signature)
```
