# SPEC — figma-reverse: `.fig` extract pipeline deep-dive

| Item | Value |
|---|---|
| Document version | v2.0 (2026-05-08 full rewrite) |
| Package version | `figma-reverse@0.1.11` |
| Scope | **9-stage pipeline of the extract subcommand + automated verification** |
| Language/runtime | TypeScript 5.7 / Node.js ≥ 20 / ESM |
| Sibling docs | [`SPEC-architecture.md`](./SPEC-architecture.md) · [`SPEC-roundtrip.md`](./SPEC-roundtrip.md) · [`SPEC-repack.md`](./SPEC-repack.md) · [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) |
| Target PRD | [`PRD.md`](./PRD.md) |

---

## 0. Scope

**IN scope (this document)**

- 9-stage pipeline of the `extract` subcommand (`.fig` → `output/` + `extracted/`)
- Per-stage input / processing / memory · disk output
- Automated verification V-01 ~ V-08
- `src/` module ↔ stage mapping

**OUT of scope — see sibling docs**

| Topic | Document |
|---|---|
| Repack 3-mode (byte / kiwi / json) | [`SPEC-repack.md`](./SPEC-repack.md) |
| Round-trip equality tiers, lossless JSON tagging | [`SPEC-roundtrip.md`](./SPEC-roundtrip.md) · [ADR-0002](./adr/0002-roundtrip-equality-tiers.md) |
| pencil.dev `.pen` exporter (coordinates · ID · variant) | [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) |
| Web editor (Clean+Hexagonal, Konva canvas) | [`SPEC-architecture.md`](./SPEC-architecture.md) |
| Domain terminology (Kiwi Record / Tree Node / Master / Instance / Pen ID / Effective Visibility …) | [`CONTEXT.md`](../CONTEXT.md) |
| `.fig` wire format byte-level visual reference | [`fig-format/figma-fig-format.md`](./fig-format/figma-fig-format.md) |
| External audit harness (5 scripts; determinism · byte-compare · oracle) | [`specs/audit-harness.spec.md`](./specs/audit-harness.spec.md) · [`HARNESS.md`](./HARNESS.md) |
| Per-round work history (round 2 ~ 18-B) | [`specs/archive/`](./specs/archive/) |

The other 6 CLI subcommands (`repack`, `pen-export`, `editable-html`, `html-report`, `round-trip-html`, `tokens`) are indexed in one line each under §7; details are delegated to the sibling docs above.

---

## 1. Pipeline overview

```
┌────────────────┐       ┌─────────────┐       ┌──────────────────┐
│  design.fig    │ ───►  │  extract    │ ───►  │  output/  +  extracted/    │
│  (ZIP wrapper) │       │  9 stages   │       │  (human-readable JSON +  │
└────────────────┘       └─────────────┘       │   stage-by-stage outputs)│
                                                └──────────────────┘
```

**One-line summary** — Unpack the Figma `.fig` binary (ZIP → fig-kiwi archive → schema+data chunks → kiwi message → tree) in 9 stages, export lossless JSON / images / SVG, and persist per-stage outputs to disk to enable tracing, verification, and repackaging.

> 📘 **Wire-format visual reference**: [`fig-format/figma-fig-format.md`](./fig-format/figma-fig-format.md) — Stage 1~4 byte-level layout, fig-kiwi container, 568-type schema, ENUM/STRUCT/MESSAGE wire patterns, tag-matching decode.

---

## 2. 9-Stage Pipeline

> **How to read**: each stage = `[input] → processing → [output (memory) + output (disk)]`. Paths in **bold** are persisted to disk.

### 2.0 Stage IO at a glance

| # | Stage | Module | Input type | Output type | Key point |
|--:|---|---|---|---|---|
| 1 | Container unwrap | `container.ts` | `<input>.fig` path | `ContainerResult` (canvasFig + meta + thumbnail + images) | ZIP / raw auto-branch |
| 2 | fig-kiwi chunk split | `archive.ts` | `canvas.fig` bytes | `FigArchive { prelude, version, chunks[] }` | 8B magic + 4B version + length-prefixed chunks |
| 3 | Decompression | `decompress.ts` | Two compressed chunks | `Uint8Array × 2` | **schema=deflate-raw, data=zstd** auto-detect |
| 4 | Kiwi decode | `decoder.ts` | Uncompressed schema + data | `DecodedFig { schema, message }` | rootType `NODE_CHANGES`, 568 type defs |
| 5 | Tree reconstruction | `tree.ts` | `message.nodeChanges[]` | `BuildTreeResult { document, allNodes, orphans }` | parent GUID + fractional-index sorting |
| 6 | Image ref mapping | `assets.ts` | tree + `images` Map | `Map<hash, Set<ownerGuid>>` | magic byte → extension inference |
| 7 | Vector extraction | `vector.ts` | tree + `message.blobs[]` | SVG path × N | best-effort (sample 95%) |
| 8 | Normalize + Export | `normalize.ts`, `export.ts` | tree + refs + decoded | `output/<figName>/**` | REST API-compatible aliases + per-page split |
| 9 | Verification report | `verify.ts` | All prior results | `verification_report.md` | 7 active checks (V-01·02·03·04·06·07·08); V-05 reserved |

> Stage 6 is memory-only. Stage 8 persists the ref mapping to disk in a single batch.

### Stage 1️⃣ Container unwrap

> A Figma Cloud-exported `.fig` is actually a **ZIP file**. Only the inner `canvas.fig` is the real binary.

| | |
|---|---|
| **Module** | `src/container.ts` (107 LOC) — the sole entry point that uses `readFileSync` (§8 exception) |
| **Input** | `<input>.fig` file path |
| **Processing** | 1. Branch on the first N bytes:<br>&nbsp;&nbsp;• 4 bytes = `50 4B 03 04` (ZIP magic) → `loadZipContainer`<br>&nbsp;&nbsp;• 8 bytes = `66 69 67 2D 6B 69 77 69` (`fig-kiwi`) → handle as a raw single binary<br>&nbsp;&nbsp;• otherwise → explicit error containing the first 16-byte hex<br>2. For ZIP, iterate entries via `adm-zip`. Recognized entries: `canvas.fig`, `meta.json`, `thumbnail.png`, `images/<hash>`. **Anything else is silently skipped** (forward-compat).<br>3. If `canvas.fig` is missing, FAIL with the list of found entries. Also error explicitly on `meta.json` parse failure. |
| **Output (memory)** | `ContainerResult { isZipWrapped: boolean, canvasFig: Uint8Array, metaJson?: FigMetaJson, thumbnail?: Uint8Array, images: Map<hash, Uint8Array> }` |
| **Output (disk)** | **`extracted/<figName>/01_container/`** (details in §3.2) |
| **Invariant** | For raw fig-kiwi input, `images.size === 0` |

### Stage 2️⃣ fig-kiwi archive chunk split

> `canvas.fig` is Evan Wallace's **Kiwi serialization format** + a chunk container. Two chunks (schema + data). Additional chunks are preserved for forward-compat.

| | |
|---|---|
| **Module** | `src/archive.ts` (62 LOC) |
| **Input** | `canvas.fig` bytes (Stage 1) |
| **Processing** | 1. `data.length < 12` → fail immediately<br>2. UTF-8 decode the first 8 bytes and compare to `"fig-kiwi"`<br>3. Bytes 8~11: LE uint32 → `archive.version` (sample: 106)<br>4. Loop from `offset` 12: `[4 byte LE size][size bytes payload]` → append to `chunks[]`<br>&nbsp;&nbsp;• if `size === 0`, preserve as `Uint8Array(0)` (not skipped)<br>&nbsp;&nbsp;• if `offset + size > data.length`, fail (message includes chunk index/offset)<br>5. Trailing bytes after the last chunk emit a stderr warning only and processing continues (forward-compat) |
| **Output (memory)** | `FigArchive { prelude: "fig-kiwi", version: number, chunks: Uint8Array[] }` |
| **Output (disk)** | **`extracted/.../02_archive/chunks/00_schema.bin`** (compressed, sample: 26 KB)<br>**`extracted/.../02_archive/chunks/01_data.bin`** (compressed, sample: 3.72 MB) |
| **Invariant** | For a normal sample, `chunks.length === 2`. `chunks[0]` = schema, `chunks[1]` = data — a precondition of Stage 4. |

### Stage 3️⃣ Decompression (deflate-raw / zstd auto-branch)

> The first chunk is **deflate-raw**, the second is **zstd** — two different algorithms in one file. The project's key finding (validating the hypothesis in PRD §1.2.3).

| | |
|---|---|
| **Module** | `src/decompress.ts` (67 LOC) |
| **Input** | Compressed chunk bytes (Stage 2's `chunks[i]`, called twice) |
| **Processing** | 1. `detectCompression(buf)` — exact branch rules:<br>&nbsp;&nbsp;• first 4 bytes = `28 B5 2F FD` → `zstd`<br>&nbsp;&nbsp;• `buf[0] === 0x78` *and* `((buf[0] << 8) \| buf[1]) % 31 === 0` (zlib FCHECK validation) → `deflate-zlib`<br>&nbsp;&nbsp;• otherwise → `deflate-raw`<br>2. Fallback order is determined by the detection result:<br>&nbsp;&nbsp;• zstd → `[zstd, deflate-raw, deflate-zlib]`<br>&nbsp;&nbsp;• deflate-zlib → `[deflate-zlib, deflate-raw, zstd]`<br>&nbsp;&nbsp;• deflate-raw → `[deflate-raw, deflate-zlib, zstd]`<br>3. If all algorithms fail, throw explicitly with the last error. Empty buffers are returned as-is. |
| **Output (memory)** | `Uint8Array` × 2 (uncompressed schema + data). The detection label is preserved on `DecodedFig.schemaCompression` and `dataCompression` |
| **Output (disk)** | **`extracted/.../03_decompressed/schema.kiwi.bin`** (sample: 64 KB, `deflate-raw` decompressed)<br>**`extracted/.../03_decompressed/data.kiwi.bin`** (sample: 20 MB, **`zstd`** decompressed) |
| **Invariant** | For the sample (v106) schema=`deflate-raw`, data=`zstd` — V-07 verifies the labels |

### Stage 4️⃣ Kiwi decode (schema → message)

> The first chunk is the **schema definition itself** (568 types in the sample); the second is the **NodeChanges message** encoded with that schema. v106 fig only requires 2 chunks, but any additional chunks are preserved in `extraChunks`.

| | |
|---|---|
| **Module** | `src/decoder.ts` (85 LOC) |
| **Input** | `archive.chunks` (Stage 2). Precondition: `chunks.length >= 2` — throws on violation |
| **Processing** | 1. Decompress `chunks[0]` → `rawSchemaBytes`<br>2. `kiwi.decodeBinarySchema(rawSchemaBytes)` → `Schema` object<br>3. `kiwi.compileSchema(schema)` → `compiled` (carries encode/decode methods, reused by V-02)<br>4. Decompress `chunks[1]` → `rawDataBytes`<br>5. `compiled.decodeMessage(rawDataBytes)` → message<br>6. **rootType is extracted heuristically** — use `schema.rootType` if present, else the `name` of the first `MESSAGE` kind in `definitions[]` (the sample result: `NODE_CHANGES`) |
| **Output (memory)** | `DecodedFig { archiveVersion, archive, schema, compiled, message, rawSchemaBytes, rawDataBytes, schemaCompression, dataCompression, extraChunks, schemaStats: { definitionCount, rootType? } }` |
| **Output (disk)** | **`extracted/.../04_decoded/schema.json`** (sample 812 KB, `definitions[]`)<br>`extracted/.../04_decoded/message.json` (sample ~150 MB, **only with `--include-raw-message`**) |
| **Invariant** | `rawSchemaBytes` and `compiled` are reused for the V-02 schema round-trip + message re-encode |

### Stage 5️⃣ Node tree reconstruction

> The message's `nodeChanges[]` is a flat array. **Tree reconstruction** uses parent GUID + position strings for **sibling ordering**.

| | |
|---|---|
| **Module** | `src/tree.ts` (90 LOC) |
| **Input** | `message.nodeChanges[]` (sample: 35,660 nodes) |
| **Processing** | Exactly 3 passes:<br>**Pass 1** — store each nodeChange in a Map keyed by `guidKey(sessionID:localID)`. Skip if `guid` is missing or the key is empty.<br>**Pass 2** — look up parents via `parentIndex.guid`. Branches:<br>&nbsp;&nbsp;• no parent guid / empty key + `type === 'DOCUMENT'` → the first such node becomes `document`; subsequent DOCUMENTs go to `orphans`<br>&nbsp;&nbsp;• no parent guid / empty key + other type → `orphans`<br>&nbsp;&nbsp;• parent guid present and lookup succeeds → append to the parent's `children` array<br>&nbsp;&nbsp;• parent guid present but lookup fails → `orphans`<br>**Pass 3** — sort siblings by lexicographic comparison of the `position` string (Figma's fractional indexing). Sort both the document tree and orphans recursively. Detailed spec: [`specs/parent-index-position.spec.md`](./specs/parent-index-position.spec.md). |
| **Output (memory)** | `BuildTreeResult { document: TreeNode \| null, allNodes: Map<string, TreeNode>, orphans: TreeNode[] }`. Each `TreeNode` carries `{ guid, guidStr, type, name?, parentGuid?, position?, children, data }`, where `data` is the original nodeChange (raw preserved). |
| **Output (disk)** | **`extracted/.../05_tree/nodes-flat.json`** (sample 3.6 MB, flat table for grepping)<br>`extracted/.../05_tree/orphans.json` (only when orphans.length > 0) |
| **Invariant** | If `document` is null, V-03 FAILs. Dangling parent / cycle is a V-03 FAIL. Orphans do not trigger WARN/FAIL. |

### Stage 6️⃣ Image reference mapping

> Walk the tree → collect image hashes → cross-check against `images/` extracted from the ZIP.

| | |
|---|---|
| **Module** | `src/assets.ts` (131 LOC) |
| **Input** | Tree root + the `images` Map from Stage 1 |
| **Processing** | 1. `collectImageRefs(root)` — recursive walk of the node tree. From each object collect **3 patterns** (spec: [`specs/asset-walk.spec.md`](./specs/asset-walk.spec.md)):<br>&nbsp;&nbsp;• `obj.image.hash` (Uint8Array \| string)<br>&nbsp;&nbsp;• its own `obj.hash` (when an Image message appears directly)<br>&nbsp;&nbsp;• `obj.imageRef` (REST API-compatible field)<br>2. If the hash is `Uint8Array`, convert to hex via `Buffer.from(...).toString('hex')`. If a string, `toLowerCase()`.<br>3. Build a `Map<hash, Set<owner-guid>>`. Identical hashes accumulate in the set.<br>4. `detectImageExt(buf)` — called by Stage 8. Magic patterns: |

**`detectImageExt` magic table:**

| Extension | Byte pattern |
|---|---|
| `png` | `89 50 4E 47 0D 0A 1A 0A` (8 bytes) |
| `jpg` | `FF D8 FF` (3 bytes) |
| `gif` | `47 49 46 38` (`GIF8`, 4 bytes) |
| `pdf` | `25 50 44 46` (`%PDF`, 4 bytes) |
| `webp` | `RIFF` (0~3) + `WEBP` (8~11) |
| `svg` | ASCII-decode the first 16 bytes and match `^\s*<\?xml` or `^\s*<svg` (case-insensitive) |
| `bin` | None of the above match, or `length < 4` |

| | |
|---|---|
| **Output (memory)** | `Map<hash, Set<owner-guid>>` |
| **Output (disk)** | This stage has none — Stage 8 writes `output/<figName>/assets/images/<hash>.<ext>` in a single batch |

### Stage 7️⃣ Vector extraction (best-effort)

> A VECTOR node's `fillGeometry[*].commandsBlob` → `message.blobs[]` index → byte decode → SVG path. Detailed spec: [`specs/vector-decode.spec.md`](./specs/vector-decode.spec.md).

| | |
|---|---|
| **Module** | `src/vector.ts` (480 LOC) |
| **Input** | Tree + `message.blobs[]` (each blob: `{ bytes: Uint8Array }`) |
| **Processing** | 1. Iterate 7 vector types: `VECTOR`, `STAR`, `LINE`, `ELLIPSE`, `REGULAR_POLYGON`, `BOOLEAN_OPERATION`, `ROUNDED_RECTANGLE`<br>2. Collect blob index candidates from the node data:<br>&nbsp;&nbsp;• `vectorData.vectorNetworkBlob` (entire path)<br>&nbsp;&nbsp;• `fillGeometry[*].commandsBlob` (fill regions)<br>&nbsp;&nbsp;• `strokeGeometry[*].commandsBlob` (stroke regions)<br>3. Decode blob bytes → path commands (LE float32):<br>&nbsp;&nbsp;• `0x01` MOVE_TO + 2 × f32 (x, y)<br>&nbsp;&nbsp;• `0x02` LINE_TO + 2 × f32<br>&nbsp;&nbsp;• `0x03` CUBIC + 6 × f32 (c1x, c1y, c2x, c2y, x, y)<br>&nbsp;&nbsp;• `0x04` QUAD + 4 × f32 (cx, cy, x, y)<br>&nbsp;&nbsp;• `0x05` CLOSE (no args)<br>4. **Try both starting offsets 0 and 1**, picking the side that successfully decodes more commands. When byte 0 is a winding flag (0x00), offset 1 wins — this heuristic decodes 95% of the sample.<br>5. The `windingRule` + `styleID` from fillGeometry / strokeGeometry are also reflected into the SVG fill/stroke colors |
| **Output (memory)** | `VectorExtractionResult[] { nodeId, nodeName?, svg?, error?, blobIndices }` |
| **Output (disk)** | **`output/<figName>/assets/vectors/<node-id>.svg`** (sample: 1,599 / 1,681 ≈ 95% success). Nodes that fail to decode produce no SVG file and retain only the `error` field |
| **Invariant** | On encountering an unknown cmd byte, decode halts and the raw bytes are preserved as metadata (in the sample 95% of all cmds are 0x01~0x05) |

### Stage 8️⃣ Normalize + Export

> Preserves the original Kiwi keys + adds REST API-compatible aliases (the "pragmatic (b)" policy — both grep-able). Splits per page. REST normalization spec: [`specs/rest-api-normalize.spec.md`](./specs/rest-api-normalize.spec.md).

| | |
|---|---|
| **Module** | `src/normalize.ts` (134 LOC), `src/export.ts` (352 LOC) |
| **Input** | Tree + image refs + `DecodedFig` |
| **Processing** | 1. Recursive `normalizeNode()` — `TreeNode` → `NormalizedNode`:<br>&nbsp;&nbsp;• `id` = `guidStr` (the `S:L` string); `guid` is also preserved<br>&nbsp;&nbsp;• `parentId` = the parent's `guidKey`<br>&nbsp;&nbsp;• Copy `data.visible` directly if it is a boolean<br>&nbsp;&nbsp;• Add aliases (only when present): `fillPaints` → `fills`, `strokePaints` → `strokes`, `effects` → `effects` (as-is)<br>&nbsp;&nbsp;• `absoluteBoundingBox` (best-effort): if `size` is present, `{ x: transform.m02 ?? 0, y: transform.m12 ?? 0, width: size.x, height: size.y }`. **The rotation/scale components of transform are ignored** — only the translation components (m02/m12) are used.<br>&nbsp;&nbsp;• Preserve original data in `raw` — `Uint8Array` → hex string (via `hashToHex`), `BigInt` → `.toString()`. Everything else is deep-copied.<br>2. Split pages by CANVAS node (sample: 6 CANVAS)<br>3. For each hash in the Stage 6 ref Map, call `detectImageExt(buf)` and persist to disk<br>4. Generate a SHA-256 manifest of all outputs |
| **Output (disk)** | `output/<figName>/document.json` (entire tree; omitted with `--no-document`)<br>**`output/<figName>/pages/<idx>_<name>.json`** (one per CANVAS)<br>**`output/<figName>/assets/images/<hash>.<ext>`**<br>**`output/<figName>/assets/vectors/<id>.svg`**<br>**`output/<figName>/assets/thumbnail.png`**<br>**`output/<figName>/schema.json`** (sample 812 KB)<br>**`output/<figName>/metadata.json`**<br>**`output/<figName>/manifest.json`** (output index + sha256) |
| **Invariant** | bbox does not exactly represent the visual bounding box of a rotated node — consumers must inspect `raw.transform` directly |

### Stage 9️⃣ Verification report

> Automated V-01 ~ V-08 checks + statistics + Markdown report. Detailed contract: [`specs/verification-report.spec.md`](./specs/verification-report.spec.md).

| | |
|---|---|
| **Module** | `src/verify.ts` |
| **Input** | All prior stage results |
| **Processing** | Run the 7 active checks from §4 (V-01·02·03·04·06·07·08) sequentially, then write the markdown report. V-05 (determinism) is excluded from `runChecks()` — see the §4 footnote |
| **Output (disk)** | **`output/<figName>/verification_report.md`** |

---

## 3. Output directory structure (measured)

`<figName>` = the input `.fig` basename with the `.fig` extension stripped (any characters allowed, including spaces).

### 3.1 `output/<figName>/` — for user consumption

> Shaped for human reading and grep. Includes REST API-compatible aliases.
> The sizes below are based on a sample (a 6-page · 35,660-node fig, `--no-document --minify`) ≈ 87 MB.

```
output/<figName>/
├── pages/                                   # per-page tree (split by CANVAS)
│   ├── 00_design setting.json     2.5 MB    # ← sample page sizes. Real figures vary by input.
│   ├── 01_Internal Only Canvas.json 258 KB
│   ├── 02_WEB.json                67.5 MB
│   ├── 03_MOBILE.json              3.6 MB
│   ├── 04_dash board.json          2.4 MB
│   └── 05_icons.json               1.4 MB
├── assets/
│   ├── images/                              # SHA-1 hash + magic-based extension
│   │   ├── 01953550...256875bb6b.png
│   │   ├── ... (sample: 12 PNGs)
│   │   └── ce4146cf...62e7736dd.png
│   ├── vectors/                             # commandsBlob → SVG path
│   │   └── <node-id>.svg × 1,599
│   └── thumbnail.png
├── schema.json                              # Kiwi schema 568 defs (~812 KB)
├── metadata.json                            # meta.json + extraction stats
├── manifest.json                            # output index + SHA-256 (~204 KB)
└── verification_report.md                   # V-01 ~ V-08 results (~120 KB)
```

> `document.json` (the whole tree in one file) can be omitted via `--no-document` (since it duplicates the page files).

### 3.2 `extracted/<figName>/` — for debug/repack

> Stage-by-stage pipeline breadcrumbs. Each folder has an `_info.json` metadata file.
> The sizes below are based on the same sample ≈ 34 MB.

```
extracted/<figName>/
├── 01_container/                            # Stage 1
│   ├── canvas.fig                3.74 MB    # fig-kiwi binary inside the ZIP
│   ├── meta.json                 341 B      # file_name, background_color, etc.
│   ├── thumbnail.png             17.7 KB
│   ├── images/                              # hash filename, raw bytes
│   └── _info.json                           # sha256, byteLength, magic bytes
│
├── 02_archive/                              # Stage 2 (compressed state)
│   ├── chunks/
│   │   ├── 00_schema.bin         26 KB      # firstBytes: b5 bd 09 98...
│   │   └── 01_data.bin           3.72 MB    # firstBytes: 28 b5 2f fd... (zstd)
│   └── _info.json                           # version=106, chunkCount=2
│
├── 03_decompressed/                         # Stage 3 (decompressed)
│   ├── schema.kiwi.bin           64 KB      # Kiwi schema binary
│   ├── data.kiwi.bin             20 MB      # NodeChanges message binary
│   └── _info.json                           # algorithm (deflate-raw / zstd)
│
├── 04_decoded/                              # Stage 4 (JSON)
│   ├── schema.json               812 KB     # 568 type definitions
│   └── _info.json                           # rootMessageType, nodeChangesCount
│   # message.json (~150 MB) — generated only with `--include-raw-message`
│
└── 05_tree/                                 # Stage 5
    ├── nodes-flat.json           3.6 MB     # (id, type, name, parentId, childCount)
    └── _info.json                           # totalNodes, pageCount, typeDistribution
```

> Folders added by other subcommands — `06_report/` (round-trip viewer), `07_editable/` (single-file HTML), `08_pen/` (pencil.dev .pen) — are covered in §7 and the sibling docs.

### 3.3 `_info.json` example (`02_archive/_info.json`)

```json
{
  "stage": "02_archive",
  "description": "fig-kiwi chunk split (compressed state). First chunk = Kiwi schema, second = data message.",
  "prelude": "fig-kiwi",
  "version": 106,
  "chunkCount": 2,
  "chunks": [
    {
      "index": 0, "role": "schema", "compressedBytes": 26022,
      "firstBytesHex": "b5 bd 09 98 64 57 59 30",
      "sha256": "5a27244b6e0b375d69d4762499224b357d5fe3df132021f2ee42774ec02257f1"
    },
    {
      "index": 1, "role": "data", "compressedBytes": 3898560,
      "firstBytesHex": "28 b5 2f fd 80 58 fc ce",
      "sha256": "35ce8522934ab134cdae64910c703ab0d0cbbf1e3cc65be38222cd70440363a4"
    }
  ]
}
```

---

## 4. Automated verification — 7 active checks (V-05 reserved)

> Implementation: `src/verify.ts`. Executed in a batch at Stage 9; produces `output/<figName>/verification_report.md`.
> V-01·02·03·04·06·07·08 run on every extract. V-05 (determinism) is defined in the spec but excluded from `runChecks()`'s call list — determinism is the responsibility of the external audit harness.

| ID | Item | What it checks | Status rule | Sample result |
|---|---|---|---|---|
| **V-01** | Input integrity | Re-check that `canvasFig`'s first 8 bytes = the `fig-kiwi` magic | match → PASS, else FAIL | 🟢 `fig-kiwi` (✓), `isZipWrapped=true`, 3,924,602 bytes |
| **V-02** | Decode round-trip | (a) schema: `decoded.schema` → `kiwi.encodeBinarySchema()` → byte-level diff with `rawSchemaBytes`. (b) message: attempt `compiled.encodeMessage(decoded.message)` (report success + size) | (a)+(b) both OK → PASS; only one fails → WARN; both fail → WARN | 🟢 schema bytes match (sample: 64,341 bytes). Reports message re-encode size |
| **V-03** | Tree consistency | (a) `document` exists, (b) dangling parent count (a child's parent guid is not present in the Map), (c) cycle count via DFS | dangling=0 ∧ cycles=0 ∧ document present → PASS. dangling=0 ∧ cycles=0 but no document → WARN. Otherwise → FAIL. **The orphan count does not affect status** (informational) | 🟢 nodes=35,660, document=✓, dangling=0, cycles=0, orphans=0 |
| **V-04** | Asset consistency | Hash compare (after lowercase normalization): missing = imageRefs ∖ images, unused = images ∖ imageRefs | Both 0 → PASS; missing>0 OR unused>0 → WARN. If both sides are empty → SKIP | 🟢 12/12 matched, missing=0, unused=0 |
| **V-05** | Determinism (reserved) | Spec: same input processed twice → output SHA-256 identical | Not invoked by `runChecks()` — handled by the external audit harness | — |
| **V-06** | meta.json agreement | meta.json's `file_name` / `background_color` ↔ document root metadata comparison | Match → PASS, mismatch → WARN | 🟢 match |
| **V-07** | Kiwi schema sanity | (a) `schema.definitions.length`, (b) `Compression` labels of both chunks | definitions ≥ 100 → PASS, else WARN | 🟢 568 defs, schema=`deflate-raw`, data=**`zstd`** |
| **V-08** | Export outputs | Each manifest entry → file exists on disk + recomputed sha256 matches | All match → PASS, 1+ missing/mismatch → FAIL | 🟢 1,621 files, 83 MB |

Determinism verification (the V-05 slot) is handled by external round-trip scripts: [`specs/audit-harness.spec.md`](./specs/audit-harness.spec.md), [`HARNESS.md`](./HARNESS.md).

---

## 5. Module mapping (`src/`)

### 5.1 Modules covered by this SPEC (Stage 1~9)

| File | Role | LOC† |
|---|---|---:|
| `src/cli.ts` | CLI entry point + 7-subcommand dispatcher | 961 |
| `src/container.ts` | Stage 1 — ZIP / raw auto-branch | 107 |
| `src/archive.ts` | Stage 2 — fig-kiwi chunk split | 62 |
| `src/decompress.ts` | Stage 3 — deflate-raw / deflate-zlib / zstd auto-detect | 67 |
| `src/decoder.ts` | Stage 4 — Kiwi schema + message decode | 85 |
| `src/tree.ts` | Stage 5 — parent-child tree reconstruction | 90 |
| `src/assets.ts` | Stage 6 — image ref mapping + magic-based extensions | 131 |
| `src/vector.ts` | Stage 7 — `commandsBlob` → SVG path decoder | 480 |
| `src/normalize.ts` | Stage 8 — REST API-compatible aliases | 134 |
| `src/export.ts` | Stage 8 — disk export of outputs | 352 |
| `src/intermediate.ts` | Intermediate dumper (`extracted/.../_info.json` etc.) | 385 |
| `src/verify.ts` | Stage 9 — automated verification + report writer | 339 |
| `src/types.ts` | Shared type definitions (`ContainerResult`, `FigArchive`, `BuildTreeResult`, etc.) | — |

† LOC is a snapshot at the time of v2.0 (2026-05-08). Verify exact numbers with `wc -l`.

### 5.2 Modules covered by sibling docs (cross-ref)

| File | Sibling doc |
|---|---|
| `src/repack.ts` | [`SPEC-repack.md`](./SPEC-repack.md) — byte / kiwi / json 3 modes |
| `src/pen-export.ts` | [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) — pencil.dev coordinates · ID · variant |
| `src/instanceOverrides.ts`, `src/masterIndex.ts` | [`specs/expansion-context.spec.md`](./specs/expansion-context.spec.md) — INSTANCE expansion |
| `src/effectiveVisibility.ts` | [`CONTEXT.md`](../CONTEXT.md) — 3-mechanism visibility composition |
| `src/fractional-index.ts` | [`specs/parent-index-position.spec.md`](./specs/parent-index-position.spec.md) |
| `src/html-export.ts`, `src/html-export-templates.ts` | [`specs/html-dashboard.spec.md`](./specs/html-dashboard.spec.md) |
| `src/editable-html.ts`, `src/editable-html-css.ts` | [`specs/editable-html.spec.md`](./specs/editable-html.spec.md) |
| `src/tokens.ts` | [`specs/tokens.spec.md`](./specs/tokens.spec.md) |
| `web/**` (Web editor — Clean+Hexagonal) | [`SPEC-architecture.md`](./SPEC-architecture.md) |

---

## 6. Dependencies

Runtime deps — just 4:

| Package | Purpose | Version |
|---|---|---|
| `adm-zip` | ZIP container read/write | ^0.5.17 |
| `pako` | deflate / inflate | ^2.1.0 |
| `fzstd` | zstd decompression (decode-only) | ^0.1.1 |
| `kiwi-schema` | Kiwi serialization codec (Evan Wallace) | ^0.5.0 |

> `fig-kiwi@0.0.1` (npm) is installed via `optionalDependencies` but is not used at runtime. That package handles both schema and data via `inflateRaw`, but **in our measurements the data chunk is zstd** — hence the custom `decompress.ts` with auto-branching.

---

## 7. CLI

### 7.1 `extract` (the subcommand defined by this document)

```bash
# Default
figma-reverse extract <input.fig> [output-dir]
figma-reverse <input.fig> [output-dir]    # 'extract' is optional (backwards-compat)

# Recommended (saves ~30% output size)
figma-reverse extract design.fig --no-document --minify

# npm scripts
npm run extract -- design.fig ./out
npm run extract:sample          # docs/sample fig
npm run extract:bvp             # docs/bvp.fig
```

| Option | Effect |
|---|---|
| `--minify` | Strips JSON indentation (~30% reduction) |
| `--no-document` | Skip `output/<figName>/document.json` (avoid duplicating page files) |
| `--include-raw-message` | Include `extracted/.../04_decoded/message.json` (~150 MB) |
| `--no-vector` | Skip vector SVG extraction |
| `--no-intermediate` | Do not generate `extracted/` |
| `--extracted-dir <path>` | Change the extracted location (default: `./extracted`) |
| `--verbose` | Stage-by-stage progress logs |

### 7.2 The other 6 subcommands (index only)

| Subcommand | Role | Details |
|---|---|---|
| `repack` | Regenerate `.fig` from `extracted/` (byte / kiwi / json — 3 modes) | [`SPEC-repack.md`](./SPEC-repack.md) |
| `pen-export` | `.fig` → pencil.dev `.pen` + `.pen.json` (per page) | [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) |
| `editable-html` | `.fig` → single HTML (with embedded `.fig`) | [`specs/editable-html.spec.md`](./specs/editable-html.spec.md) |
| `html-report` | `extracted/` + `output/` → browser dashboard | [`specs/html-dashboard.spec.md`](./specs/html-dashboard.spec.md) |
| `round-trip-html` | `extracted/06_report/figma-round-trip.html` viewer | [`SPEC-roundtrip.md`](./SPEC-roundtrip.md) |
| `tokens` | `.fig` → design tokens JSON (colors / typography / spacing) | [`specs/tokens.spec.md`](./specs/tokens.spec.md) |

Full options live in each subcommand's `--help`.

### 7.3 First run through

```bash
npm install                                          # 1. dependencies
npm run typecheck                                    # 2. typecheck (baseline 0)
npm run extract:sample                               # 3. extract sample fig
#  → output/<figName>/, extracted/<figName>/
#  → verify verification_report.md PASS
npx tsx src/cli.ts extract /path/to/your.fig ./out   # 4. arbitrary file
```

Tests: `npm test` (CLI) + `cd web && npm test` (Web). For counts / coverage, see [`README.md`](../README.md).

---

## 8. Non-functional: async / performance

The extract pipeline runs as asynchronously and non-blocking as possible. This is a core non-functional requirement: it determines not just the single-`.fig` processing time but also the throughput when running multiple `.fig`s concurrently. The rules in this section apply across `src/`, but the verification criteria target the extract pipeline (see sibling SPECs for the performance SLAs of other subcommands).

### 8.1 Required rules (MUST)

| Rule | Targets | Implementation |
|---|---|---|
| **File I/O must be async** | `.fig` reads, JSON writes, image · vector extraction | `fs/promises` (`readFile` / `writeFile`) — `*Sync` only in single-file guaranteed contexts |
| **Parallelize pages · images · vectors** | Stage 7 SVG extraction, Stage 8 page split, asset writes | `Promise.all` to process pages · resources concurrently |
| **Concurrency limit for CPU-heavy work** | Stage 4 kiwi decode, Stage 5 tree build | Page-level splits to avoid event-loop block; `worker_threads` as needed |
| **Pool-parallel for multiple `.fig`s** | `npm run extract:all`, round-trip verification | `Promise.all` + per-file workers. Cap with `os.availableParallelism()` under memory pressure |
| **Blocking hash · encode via streams** | manifest sha256, deflate-raw encoding | Prefer `crypto.createHash` / `zlib.createDeflateRaw` stream APIs; batch hash only for < 10 MB |

### 8.2 Anti-patterns (MUST NOT)

- `readFileSync` / `writeFileSync` inside per-page · per-image loops
- Promise chaining without `await` followed by fire-and-forget — errors are lost
- Unbounded nested `Promise.all` outside of per-page · per-`.fig` granularity — risks file descriptor exhaustion
- `JSON.stringify` on huge objects → blocks the main thread; for large payloads use stream JSON or a worker

### 8.3 Verification criteria (extract pipeline)

- Single `.fig` end-to-end ≤ 1 s (35,660-node sample baseline)
- Multiple `.fig`s wall-clock ≤ **1.5 N times** (parallel gain, not flat N× serial)
- No stage in 1~9 runs a per-page · per-image sync I/O loop

---

## 9. Known limitations (extract pipeline only)

| Limitation | Stage | Impact | Disposition |
|---|---|---|---|
| Vector decode is best-effort | Stage 7 | Of the sample's 1,681 vectors, 82 (≈ 5%) — typically `BOOLEAN_OPERATION` and other composites — lack `fillGeometry` → no SVG output | Documented as a v1 limitation. The `commandsBlob` decoder itself is deterministic (95% are byte-level identical) |
| 3 unknown node types | Stage 5 | `VARIABLE_SET` (sample 6), `BRUSH` (25), `CODE_LIBRARY` (1) | Included in the tree but raw-preserved in normalization. Lossless as JSON |
| `--include-raw-message` ~150 MB memory | Stage 4 | OOM possible on large figs | Off by default. Enable only when debugging |
| Stage 7 fallback offset(0/1) heuristic | Stage 7 | If a new fig-kiwi version introduces a different prefix, both attempts may fail | For the sample (v106) trying 0/1 is sufficient. Update `vector-decode.spec.md` on violation |

**Cross-domain limitations (repack / pen-export / cloud import)** are delegated to sibling SPECs:
- `fzstd@0.1.1` decode-only → repack size impact: [`SPEC-repack.md`](./SPEC-repack.md)
- `.pen` match 99.6% (5 mismatches): [`SPEC-figma-to-pencil.md`](./SPEC-figma-to-pencil.md) · [`specs/audit-oracle.spec.md`](./specs/audit-oracle.spec.md)
- Figma Cloud import verification of repacked `.fig`: [`SPEC-roundtrip.md`](./SPEC-roundtrip.md)

---

## 10. References (external · supplementary)

The OUT-of-scope table in §0 carries all cross-refs to sibling SPECs · CONTEXT · fig-format · HARNESS · archive. This section only collects external · supplementary material not covered there.

- [`adr/`](./adr/) — 0001 pen ID format · 0002 round-trip equality tiers · 0003 rendering strategy · 0004 shared modules
- [`dev-guide.html`](./dev-guide.html) — single-file developer guide (Korean · English, 8 mermaid diagrams)
- [`PRD.md`](./PRD.md) — original requirements
- Evan Wallace, [Kiwi schema-based binary format](https://github.com/evanw/kiwi)
- Albert Sikkema (2026-01), [Reverse-Engineering Figma Make Files](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html)
- npm, [`fig-kiwi`](https://www.npmjs.com/package/fig-kiwi) — reference only (unused at runtime)
