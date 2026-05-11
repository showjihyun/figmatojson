# SPEC — figma-reverse current architecture (as of round-25)

| Item | Value |
|---|---|
| Document version | v1.0 |
| Written | 2026-05-05 |
| Scope | Whole system as of the end of round 25 |
| Sibling docs | [SPEC.md](./SPEC.md) (CLI 9 stages), [SDD.md](./SDD.md), [HARNESS.md](./HARNESS.md) |
| Position | This SPEC is the single source for the *current implementation state*. The Phase 0~7 migration history is absorbed into [§16 Appendix A](#16-appendix-a--phase-07-migration-history-2026-05-02--05). |

This document consolidates, in one place, the static structure + runtime pipeline + core invariants of the current system before entering round 26. It is the baseline for new round work.

---

## 1. System identity

`figma-reverse` is a **monorepo with two separate pipelines stacked on a shared domain module**.

```
                ┌──────────────────────────────────────────────────┐
                │                  src/  (shared domain)                  │
                │  loadContainer / decodeFigCanvas / buildTree      │
                │  vector / instanceOverrides / masterIndex / ...   │
                └────────────┬──────────────────────┬──────────────┘
                             │                      │
                ┌────────────▼─────────┐  ┌─────────▼───────────┐
                │   CLI pipeline       │  │   Web pipeline       │
                │ (9-stage extract +   │  │ (Hexagonal: ports +  │
                │  repack roundtrip)   │  │  application + UI)   │
                └───────────────────────┘  └──────────────────────┘
```

| Pipeline | Input | Output | Invocation |
|---|---|---|---|
| **CLI extract** | `*.fig` | `output/` (human-readable JSON + images + SVG) + `extracted/` (debug breadcrumbs) | `npx tsx src/cli.ts extract <file>` |
| **CLI repack** | `extracted/` | `*.fig` (byte / kiwi / json mode) | `npx tsx src/cli.ts repack <dir> <out>` |
| **CLI pen-export** | `*.fig` | `*.pen` (Pencil-compatible design file) + `*.pen.json` round-trip | `npx tsx src/cli.ts pen-export <file>` |
| **CLI editable-html** | `*.fig` | Single `.html` (editable dashboard) | `npx tsx src/cli.ts editable-html <file>` |
| **Web server** | (HTTP) `.fig` upload | (JSON) `Document` + asset stream + chat agent response | `npm --prefix web run dev` |
| **Web client** | `Document` JSON | Konva canvas render + Inspector patches + chat turn | (browser) |

The 9 stages of the CLI pipeline are defined in detail in [SPEC.md](./SPEC.md). This document focuses on what sits on top: the **current state of the Web pipeline**, the **domain modules shared by both pipelines**, and the **flow that reverse-engineers, analyzes, and transforms Figma binary data** ([§2](#2-figma-fig-data-reverse-engineering--binary--analysis--transformation)).

---

## 2. Figma `.fig` data reverse-engineering — binary → analysis → transformation

This section consolidates the *reverse-engineering findings + data model + transformation strategy* for the path that takes a `.fig` file to our in-memory tree (and then to a `DocumentNode`). The *how* of the CLI's 9 stages lives in [SPEC.md](./SPEC.md); this section focuses on *why those stages exist* + *what each stage decodes*.

### 2.1 The 7 key findings

The 7 core facts that surfaced while confirming the 9 hypotheses in PRD §6.3 against verification V-01~V-08:

1. **`.fig` is a ZIP container, and the inner `canvas.fig` is the real binary.** Figma Cloud exports always wrap as ZIP STORE mode (uncompressed ZIP).
2. **canvas.fig is the fig-kiwi format.** 8-byte magic `66 69 67 2D 6B 69 77 69` ("fig-kiwi") + 4-byte LE version + chunks.
3. **Two chunks**: the first chunk = **the Kiwi schema definition**; the second chunk = the **NodeChanges message** encoded with that schema.
4. **Dual compression** (the project's key finding): schema chunk = **deflate-raw**, data chunk = **zstd**. This differs from the single-deflate-raw assumption of the fig-kiwi npm package — magic-byte auto-detection branches accordingly.
5. **The NodeChanges message is a flat array.** 35,660 nodes (for the sample fig) are listed without parent-child structure. The tree is reconstructed via each node's `parentIndex.guid`, and siblings are ordered via `parentIndex.position` (a fractional-indexing string).
6. **Images are stored as raw bytes in the ZIP's `images/<sha1-hash>`.** A node's `image.hash` field acts as a cross-reference. No extension — types are determined via magic-byte sniffing.
7. **Vector paths are decoded as `vectorNetworkBlob` index → `message.blobs[]` bytes → 5 path commands (MOVE_TO/LINE_TO/CUBIC/QUAD/CLOSE).** 95% success rate (composites such as BOOLEAN_OPERATION are best-effort because their `fillGeometry` is empty).

### 2.2 Container layout (`.fig` outer shell)

```
design.fig (ZIP STORE)
├── canvas.fig          ← the real binary (fig-kiwi format)
├── meta.json           ← file_name, background_color, ...
├── thumbnail.png       ← small preview
└── images/
    ├── <sha1-hash-1>   ← raw bytes without extension (type sniffed via magic)
    └── <sha1-hash-2>   ← stored once when multiple nodes share the same image
```

`src/container.ts:loadContainer` unwraps the ZIP and returns a `ContainerResult`. It branches automatically on the ZIP magic (`50 4B 03 04`) — raw fig-kiwi is also handled as-is (rare but future-proof).

### 2.3 fig-kiwi archive format

```
[8 bytes  ] "fig-kiwi" magic
[4 bytes  ] version (LE uint32)              ← sample = 106
[4 bytes  ] chunk[0].size (LE uint32)
[N bytes  ] chunk[0].data                    ← schema chunk (deflate-raw compressed)
[4 bytes  ] chunk[1].size
[N bytes  ] chunk[1].data                    ← data chunk (zstd compressed!)
```

`src/archive.ts:parseFigArchive` validates the magic + splits chunks. Decompression is the responsibility of `src/decompress.ts`.

**Compression auto-detection** rules:
- `28 B5 2F FD` → zstd (uses `fzstd`, decode-only)
- `78 xx` → deflate-zlib (`pako.inflate`)
- otherwise → deflate-raw (`pako.inflateRaw`)

Why this auto-detection is decisive: the fig-kiwi npm package assumes deflate-raw for both schema and data, but in real `.fig` files the data chunk is zstd. We must decode it ourselves. (This finding empirically confirms the "dual compression" hypothesis in PRD §1.2.3.)

### 2.4 The Kiwi schema system

Kiwi (Evan Wallace) is a schema-based binary format — similar to Protocol Buffers but simpler. **The schema itself is delivered as a stream**, making it future-compatible.

```
schema chunk (decompressed):
  [binary encoding of 568 type definitions]
  ├── NODE_CHANGES { nodeChanges: NodeChange[], blobs: Bytes[], ... }
  ├── NodeChange   { guid: GUID, type: NodeType, ... }
  ├── GUID         { sessionID: uint32, localID: uint32 }
  ├── Vector2      { x: float, y: float }
  ├── Transform    { m00..m12: float }
  ├── Paint        { type: PaintType, color: Color, ... }
  ├── ...

data chunk (decompressed):
  [one NODE_CHANGES message encoded with the above schema]
```

Decode procedure (`src/decoder.ts:decodeFigCanvas`):

```ts
const schema   = kiwi.decodeBinarySchema(schemaBytes);   // reads 568 types
const compiled = kiwi.compileSchema(schema);             // generates decoder class
const message  = compiled.decodeMessage(dataBytes);      // root: NODE_CHANGES
```

The schema can be dumped to `output/schema.json` as a human-readable form. Even if a new Figma version adds or changes type definitions, our decoder does not break because the schema chunk is *received as data and handled dynamically*.

### 2.5 Node data model

Each item in `message.nodeChanges[]` = one node. Fields common to all nodes:

```ts
{
  guid: { sessionID: uint32, localID: uint32 },     // unique node ID
  type: 'FRAME' | 'TEXT' | 'VECTOR' | 'INSTANCE' | 'SYMBOL' | ... ,
  parentIndex: { guid: GUID, position: string },    // parent + fractional sort key
  // followed by per-type fields (defined in the kiwi schema)
  size?: { x, y },
  transform?: { m00, m01, m02, m10, m11, m12 },     // 2D affine, relative to parent
  fillPaints?: Paint[],
  strokePaints?: Paint[],
  textData?: { characters, styleOverrideTable, ... },
  symbolData?: { symbolID, symbolOverrides },        // INSTANCE only
  derivedSymbolData?: ...,                           // INSTANCE only (post-layout)
  componentPropAssignments?: ...,                    // INSTANCE only
  componentPropRefs?: ...,                           // variant-binding descendants
  componentPropDefs?: ...,                           // SYMBOL only (variant definitions)
  vectorData?: { vectorNetworkBlob: number, ... },   // VECTOR family (blobs[] index)
  fillGeometry?: [{ commandsBlob: number }],
  // auto-layout fields (FRAME)
  stackMode?, stackPrimaryAlignItems?, stackCounterAlignItems?,
  stackSpacing?, stackPaddingLeft?, stackPaddingRight?, ...
  ...
}
```

Type distribution (35,660 nodes in the sample):

| Type | Count (approx.) | Meaning |
|---|---:|---|
| `FRAME` | ~12,000 | Generic container; can be auto-layout |
| `TEXT` | ~5,800 | Text render |
| `RECTANGLE` | ~3,400 | Rectangles |
| `INSTANCE` | ~6,000 | SYMBOL instance |
| `SYMBOL` | ~600 | Component master |
| `GROUP` | ~2,500 | Group |
| `VECTOR` (+ `STAR`/`LINE`/`ELLIPSE`/`REGULAR_POLYGON`/`BOOLEAN_OPERATION`/`ROUNDED_RECTANGLE`) | ~1,700 | SVG paths |
| `DOCUMENT` / `CANVAS` | 1 + 6 | root + pages |
| `VARIABLE_SET` (6) / `BRUSH` (25) / `CODE_LIBRARY` (1) | 32 | uninterpreted, preserved raw |

### 2.6 Tree reconstruction and fractional indexing

`message.nodeChanges[]` is a flat array. `tree.buildTree`:

1. Stores all nodes in `Map<guidStr, TreeNode>`
2. For each node, looks up the parent via `parentIndex.guid` and appends to `parent.children`
3. Sorts each parent's `children` by `parentIndex.position` (string)
4. `DOCUMENT` type = root; nodes whose parent is not found = orphans

**Purpose of fractional indexing**: Figma expresses sibling order as strings, e.g. `"A1"` / `"A2"` / `"A3"`. To insert a new node between two existing ones, you only need a string between `"A1"` and `"A2"` (e.g. `"A1V"`) — no other node's position needs to be touched. It avoids conflicts in distributed environments (Figma multi-user + Operational Transform).

(Our sorting rules + edge cases live in [`parent-index-position.spec.md`](./specs/parent-index-position.spec.md).)

### 2.7 INSTANCE / SYMBOL component model (the most complex part)

Figma's *reusable component* system. Every round of the INSTANCE pipeline (4, 12, 14-25) operates on top of this model.

#### SYMBOL = master definition

```
SYMBOL "Button" (id=64:1)
└─ FRAME "buttons-container" (id=64:2)
    ├─ INSTANCE "Icon" (id=64:3, → another SYMBOL 7:208)
    └─ TEXT "Label" (id=64:4, characters="Button")
```

A SYMBOL has its own children tree and carries variant definitions (`componentPropDefs`).

#### INSTANCE = SYMBOL reference + variant data

```
INSTANCE "Confirm Button" (id=300:1) {
  symbolData: {
    symbolID: { sessionID:0, localID:64 },          // points to Button SYMBOL
    symbolOverrides: [
      { guidPath:[64:4], textData:{characters:"Confirm"} },  // change Label text
      { guidPath:[64:3], visible: false },                    // hide Icon
    ],
  },
  derivedSymbolData: [                                     // post-layout results
    { guidPath:[64:4], size:{x:30, y:16} },
  ],
  componentPropAssignments: [...],                         // variant prop bindings
  // INSTANCE has no own children (it *expands* the SYMBOL's children)
}
```

An INSTANCE node has **no children of its own** — when rendering, you must *expand* the master's children tree while applying overrides.

#### Expansion algorithm (`web/core/domain/clientNode.ts:toClientNode` INSTANCE branch)

```
1. master = symbolIndex.get(symbolData.symbolID)
2. for each child of master:
     toClientChildForRender(child, ..., overrides...)
       → recursively walk master subtree
       → at each node, look up overrides by path-key (§6)
       → apply: text / fill / visibility / prop / swap / size / transform
3. applyInstanceReflow(expansion, masterSize, instanceSize)
       → recompute child positions within the INSTANCE bbox (auto-layout simulation)
4. instance._renderChildren = expansion
```

**Master immutability**: the master TreeNode itself is never mutated. The expansion result (`_renderChildren`) is a per-instance copy. The same SYMBOL can be expanded differently by different INSTANCEs.

#### `symbolOverrides[]` vs `derivedSymbolData[]`

| Field | Meaning | Source | What we apply |
|---|---|---|---|
| `symbolOverrides` | *Input* stamped per variant by the designer | Written by Figma UI during variant editing | text / fill / visibility / propAssign / swap (overrides) |
| `derivedSymbolData` | Figma's post-layout *output* (auto-layout, text-shaping results) | Auto-computed by Figma (read-only) | size (round 22) / transform (round 24) |

Both fields point to descendants via `guidPath`. **This path is the source of the [§6 path-key contract](#6-path-key-contract-round-25-normalization--system-foundation).**

### 2.8 Vector / SVG path decode

Shape of a VECTOR-family node:

```
VECTOR (id=12:34)
├─ vectorData:    { vectorNetworkBlob: 42 }   ← message.blobs[42]
├─ fillGeometry:  [{ commandsBlob: 43 }]      ← message.blobs[43]
└─ strokeGeometry:[...]
```

`message.blobs[N]` is a byte array. Path commands are encoded within those bytes:

```
[opcode:1B] [args:variable]
  0x01 MOVE_TO + 2×float32 (x, y)
  0x02 LINE_TO + 2×float32
  0x03 CUBIC   + 6×float32 (cp1, cp2, end)
  0x04 QUAD    + 4×float32 (cp, end)
  0x05 CLOSE   (no args)
```

`src/vector.ts:parseVectorNetworkBlob` turns bytes → a command list; `vectorNetworkToPath` converts to an SVG path string.

Finding: we try decoding at two starting offsets (0, 1) and adopt the one that successfully decodes more commands — some blobs have a 1-byte prefix (an internal Figma delimiter), so auto-detection is required.

### 2.9 Image embedding

```
Inside the ZIP:
  images/01953550...256875bb6b   ← 8.7 KB raw bytes (no extension)
  images/0f14a2f9...3977d529     ← 20.2 KB raw

Inside a node:
  fillPaints: [{ type:"IMAGE", image: { hash:"01953550...256875bb6b" } }]
  ↓
  References images/<same hash> inside the ZIP
```

Extension detection (`src/assets.ts`):
```
89 50 4E 47           → PNG
FF D8 FF              → JPEG
52 49 46 46 ... WEBP  → WebP
47 49 46 38           → GIF
3C 73 76 67           → SVG (text "<svg")
25 50 44 46           → PDF
```

On the Web side, the `/api/asset/:hash` route ([`web-asset-serve.spec.md`](./specs/web-asset-serve.spec.md)) pulls bytes from the ZIP by hash, mime-sniffs, and streams.

### 2.10 Text + style runs

```
TEXT (id=88:5)
├─ textData:
│  ├─ characters: "Hello World"                  ← UTF-8 string
│  ├─ styleOverrideTable: [                       ← style lookup by index
│  │    { fontFamily:"Inter", fontWeight:600 },         // index 0 = default
│  │    { fontFamily:"Inter", color:{r:1,g:0,b:0} },    // index 1 = red
│  │  ]
│  └─ characterStyleIDs: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]   // style index per char
├─ size: { x:88, y:20 }                          ← bbox (Figma's post-shape result)
└─ transform: { ... }
```

Each character renders with the style at `styleOverrideTable[characterStyleIDs[i]]`. Our `Canvas.tsx` stacks `Konva.Text` (or the `KText` component) per segment.

Font loading: the sample uses Pretendard / Inter. On capture we wait for `document.fonts.ready` before the first frame (if the first frame is measured with a wider-glyph system fallback, the width override gets clipped — `web-canvas-text-frame-fidelity.spec.md §2.1 I-3a`).

Details: [`web-canvas-text-style-runs.spec.md`](./specs/web-canvas-text-style-runs.spec.md), [`web-canvas-text-frame-fidelity.spec.md`](./specs/web-canvas-text-frame-fidelity.spec.md), [`text-segments.spec.md`](./specs/text-segments.spec.md).

### 2.11 Layout / Auto-layout

```
FRAME container:
├─ size: { x:200, y:60 }                                       ← bbox
├─ transform: { m00:1, m01:0, m02:50, m10:0, m11:1, m12:30 }   ← parent-relative
├─ stackMode: 'HORIZONTAL' | 'VERTICAL' | 'NONE'               ← auto-layout enabled
├─ stackPrimaryAlignItems:   'CENTER' | 'MIN' | 'MAX' | 'SPACE_BETWEEN' | ...
├─ stackCounterAlignItems:   'CENTER' | 'MIN' | 'MAX' | 'STRETCH'
├─ stackSpacing: 8                                             ← gap between children (px)
├─ stackPaddingLeft/Right/Top/Bottom: 4
├─ stackPrimarySizing: 'AUTO' | 'FIXED' | 'RESIZE_TO_FIT*'     ← AUTO = grow to fit content
└─ frameMaskDisabled: false                                    ← false = clip children
```

A child's position is determined by its own `transform`. In Figma, when auto-layout is enabled the child transform is stamped as the *post-layout result*. During INSTANCE expansion we inherit the master child's transform, but if the INSTANCE size differs from the master we need a reflow simulation (§5 + reflow spec §3.1-3.10).

### 2.12 Component property system (variant binding)

Figma expresses multiple variants of the same SYMBOL via component properties:

```
SYMBOL "Button" componentPropDefs:
  [
    { defID:0, name:"Type",      type:"VARIANT", options:["Primary","Secondary"] },
    { defID:1, name:"ShowIcon",  type:"BOOL",    default:true },
    { defID:2, name:"LabelText", type:"TEXT",    default:"Button" },
  ]

Descendants inside the SYMBOL:
  Icon  → componentPropRefs: [{ defID:1, componentPropNodeField:"VISIBLE" }]
  Label → componentPropRefs: [{ defID:2, componentPropNodeField:"TEXT" }]

componentPropAssignments on INSTANCE "Confirm":
  [
    { defID:0, value:{ type:"VARIANT", value:"Primary" } },
    { defID:1, value:{ type:"BOOL",    boolValue:false } },     // hide icon
    { defID:2, value:{ type:"TEXT",    textValue:"Confirm" } },  // label text
  ]
```

Matching: when an INSTANCE's `assignment.defID` == a descendant's `ref.defID`, apply the value to that field of the descendant.

Our implementation (`src/effectiveVisibility.ts:isHiddenByPropBinding`):
- `componentPropNodeField === 'VISIBLE'` + `boolValue === false` → descendant `visible: false`
- TEXT / INSTANCE_SWAP are not yet supported in v3 (round 26 candidates)

Details: [`web-instance-render-overrides.spec.md §3.4`](./specs/web-instance-render-overrides.spec.md) (round 12 + round 15 outer-symbolOverride path-keyed assignments).

### 2.13 Transformation strategy — the `DocumentNode` output model

Differences between `src/types.ts:TreeNode` (kiwi-decoded) and `web/core/domain/entities/Document.ts:DocumentNode` (UI-friendly):

| Aspect | TreeNode | DocumentNode |
|---|---|---|
| guid | `{sessionID, localID}` object | `id: string` alias + object |
| children | TreeNode[] | DocumentNode[] |
| INSTANCE children | none (master tree is separate) | `_renderChildren` (master expansion result) |
| VECTOR path | `vectorData.vectorNetworkBlob` index | `_path` (decoded SVG path string) |
| TEXT override | (only on master) | `_renderTextOverride` (the per-variant applied result) |
| size / transform | master values verbatim | derivedSize/Transform applied during INSTANCE expansion |
| visibility | (mostly) `data.visible` | result with propBinding + outer symbolOverride both resolved |

A DocumentNode is a serializable JSON tree → React Konva renders it directly. INSTANCE expansion + override application + reflow all happen *on the server side* inside `toClientNode`, so the client receives a simple visual tree only.

All the detailed rules of this transformation are the subject of §4-§6 (clientNode + override + path-key + reflow).

---

## 3. Module catalog

### 3.1 `src/` — shared domain + CLI

| Module | Responsibility | Callers |
|---|---|---|
| `cli.ts` | CLI entrypoint + subcommand dispatcher | shell |
| `container.ts` | Stage 1: ZIP/raw auto-branch | CLI, Web (KiwiCodec) |
| `archive.ts` | Stage 2: fig-kiwi chunk split | container + decoder |
| `decompress.ts` | Stage 3: deflate-raw / zstd auto-detect | archive |
| `decoder.ts` | Stage 4: Kiwi schema + message decode | CLI, Web |
| `tree.ts` | Stage 5: parent-child tree reconstruction + `getPages` | CLI, Web |
| `assets.ts` | Stage 6: image-ref mapping + magic-based extension | CLI, Web |
| `vector.ts` | Stage 7: `commandsBlob` → SVG path decoder + Canvas-side `vectorNetworkBlob` parser | CLI, Web Canvas |
| `normalize.ts` | Stage 8: REST API-compatible aliases | CLI export |
| `export.ts` | Stage 8: write outputs | CLI |
| `intermediate.ts` | Intermediate output dumper (`extracted/*/_info.json`) | CLI |
| `verify.ts` | Stage 9: V-01~V-08 verification + report | CLI |
| `repack.ts` | Reverse pipeline (byte / kiwi / json modes) | CLI |
| `pen-export.ts` | `.fig` → `.pen` (Pencil) conversion | CLI |
| `editable-html.ts`, `editable-html-css.ts`, `html-export-templates.ts`, `html-export.ts` | Single-`.html` output (Inspector + Canvas inlined) | CLI |
| **`masterIndex.ts`** | SYMBOL master id → TreeNode index (extracted in round 18 step 1) | Web `clientNode` |
| **`effectiveVisibility.ts`** | Resolves `componentPropAssignments` ↔ `componentPropRefs[VISIBLE]` (extracted in round 18 step 2) | Web `clientNode` |
| **`instanceOverrides.ts`** | 7 override collectors + path-key utilities (extracted in round 18 step 3) | Web `clientNode` |
| `types.ts` | Shared type definitions | All modules above |

`masterIndex.ts` / `effectiveVisibility.ts` / `instanceOverrides.ts` are core helpers used by the Web side during INSTANCE expansion, but they live under `src/` — pen-export uses the same data model, so both sides can import them ([ADR 0004](./adr/0004-shared-modules-live-in-src.md)).

### 3.2 `web/core/` — domain core (framework-free)

```
web/core/
├─ domain/                     ← pure (no React / no Node fs / no SDK)
│  ├─ entities/Document.ts     DocumentNode tree + ComponentTextRef
│  ├─ entities/Session.ts      Session lifecycle types
│  ├─ tree.ts                  findById, walk, eachDescendant
│  ├─ path.ts                  tokenizePath, setPath, getPath
│  ├─ color.ts                 rgbaToHex, hexToRgb01, ...
│  ├─ image.ts                 imageHashHex, sniffImageMime
│  ├─ summary.ts               summarizeDoc (LLM context builder)
│  ├─ messageJson.ts           message JSON serialization — round-trip
│  └─ clientNode.ts ⭐         the heart of the TreeNode → DocumentNode transform.
│                              toClientNode + toClientChildForRender +
│                              applyInstanceReflow live here.
├─ ports/                      ← interfaces (defined by application)
│  ├─ SessionStore.ts          create / get / destroy / list / setDocument
│  ├─ Decoder.ts               bytes → DocumentNode
│  ├─ Repacker.ts              DocumentNode + extracted → bytes
│  ├─ AssetServer.ts           (sessionId, hash) → bytes + mime
│  ├─ ChatAdapter.ts           prompt + tools → assistantText
│  ├─ ToolDispatcher.ts        tool name + args → side effects
│  └─ EditJournal.ts           edit history append + replay
└─ application/                ← Use cases (orchestration)
   ├─ UploadFig.ts             .fig bytes → create Session + build Document
   ├─ EditNode.ts              path JSON Patch → Document mutation
   ├─ ResizeNode.ts            BBox + handle → multi-target resize
   ├─ OverrideInstanceText.ts  Write a text override on an INSTANCE
   ├─ ExportFig.ts             Current Document → repacked .fig
   ├─ LoadSnapshot.ts          Stored snapshot → recreated Session
   ├─ SaveSnapshot.ts          Current Session → snapshot save
   ├─ RunChatTurn.ts           chat prompt → tool-call sequence + response
   ├─ ServeAsset.ts            session + hash → asset bytes
   ├─ Undo.ts / Redo.ts        time travel based on EditJournal
   ├─ errors.ts                domain error types
   └─ testing/fakeSessionStore.ts  unit-test fixture
```

**Dependency direction: inward only.** `domain/` has zero deps. `application/` imports only ports + domain. `adapters/` implement ports + external libraries.

### 3.3 `web/server/adapters/` — Hexagonal outer ring

```
web/server/adapters/
├─ driving/http/                Hono routes (thin shell)
│  ├─ index.ts                  app assembly + wiring (≈100 lines)
│  ├─ deps.ts                   composition root: instantiates all adapters
│  ├─ uploadRoute.ts            POST /api/upload-fig
│  ├─ docRoute.ts               GET  /api/doc/:id
│  ├─ saveRoute.ts              POST /api/save/:id
│  ├─ overrideRoute.ts          POST /api/override-instance-text
│  ├─ resizeRoute.ts            POST /api/resize
│  ├─ chatRoute.ts              POST /api/chat
│  ├─ assetRoute.ts             GET  /api/asset/:hash
│  ├─ snapshotRoute.ts          POST /api/snapshot/:op
│  ├─ historyRoute.ts           GET  /api/history/:id (Undo/Redo)
│  └─ errors.ts                 ApplicationError → HTTP status mapping
└─ driven/                      external-dependency implementations
   ├─ FsSessionStore.ts         mkdtemp + readFile + bounded LRU (round 23 hardening)
   ├─ KiwiCodec.ts              wraps src/decoder + src/repack
   ├─ FsAssetServer.ts          serves extracted/01_container/images/
   ├─ AnthropicChat.ts          @anthropic-ai/sdk (api-key mode)
   ├─ AgentSdkChat.ts           @anthropic-ai/claude-agent-sdk (subscription)
   ├─ InProcessTools.ts         set_text / set_fill / duplicate / ...
   ├─ applyTool.ts              tool dispatcher proper
   ├─ atomicWrite.ts            safe file writes (rename atomicity)
   ├─ FsEditJournal.ts          Undo/Redo journal disk backing
   ├─ InMemoryEditJournal.ts    test fixture
   └─ *.test.ts                 unit tests
```

**Composition root**: `web/server/adapters/driving/http/deps.ts` instantiates every driven adapter and injects them into application use cases. `web/server/index.ts` is a ≈30-line entrypoint that only creates the Hono instance + calls `mountRoutes(app, deps)`.

### 3.4 `web/client/` — React UI

| File | Responsibility | LOC (approx.) |
|---|---|---|
| `App.tsx` | Layout; onUpload/onSave orchestration | ~350 |
| `Canvas.tsx` | Konva render + coordinate math + events | ~900 |
| `Inspector.tsx` | UI + patch dispatch + color/number conversion | ~950 |
| `ChatPanel.tsx` | Chat UI + fetch + auth modes | ~550 |
| `services/*` | docService / chatService / sessionService — network abstraction | ~80–150 each |
| `hooks/usePatch.ts` | debounced patch | ~80 |
| `multiResize.ts` | group resize math | ~80 |

**Konva render model**: walks the Document.children tree recursively as NodeShape (Konva.Group). An INSTANCE node renders `_renderChildren` (the master expansion result) instead of its own children. VECTOR-family nodes render `_path` (an SVG path string) as Konva.Path.

---

## 4. Core data transform: TreeNode → DocumentNode

The transformation chain from a single `.fig` file to the user's screen:

```
.fig bytes
   │
   │ container.loadContainer  (Stage 1)
   ▼
{ canvasFig, metaJson, images, ... }
   │
   │ decoder.decodeFigCanvas  (Stage 2-4)
   ▼
{ schema, message }   ← message = NODE_CHANGES (35,660-node flat array)
   │
   │ tree.buildTree           (Stage 5)
   ▼
TreeNode tree                ← children sorted by parentIndex; guidStr / type / data
   │
   │ clientNode.toClientNode  ⭐ Web-only: per-INSTANCE expansion
   ▼
DocumentNode tree            ← attaches _renderChildren / _path / _isInstanceChild etc.
   │
   │ JSON.stringify
   ▼
GET /api/doc/:id response
   │
   │ React Canvas.tsx + Konva
   ▼
screen
```

`toClientNode` is the system's **render-fidelity core function**. Rounds 17~25 all converge on this function and its helpers.

### 4.1 The role of `toClientNode`

| Input | TreeNode (kiwi-decoded; master tree + document tree mixed) |
|---|---|
| Output | DocumentNode (UI-friendly; INSTANCE expanded + paths decoded + metadata attached) |
| Key side-transforms | (1) VECTOR → SVG path, (2) INSTANCE → master expansion + override apply, (3) data field spread (textData, fillPaints, etc.) |

What happens in the INSTANCE branch:
1. Look up the master by `symbolData.symbolID` (`buildSymbolIndex` → `Map<guidStr, TreeNode>`)
2. Walk `master.children` recursively via `toClientChildForRender` → expansion result
3. Collect the 6 + 1 override maps (prop assignments at-path) to apply to the expansion
4. Pass the expansion through `applyInstanceReflow` → recompute child positions within the INSTANCE bbox
5. Attach the result to `out._renderChildren`; the master itself is not mutated (only the per-instance copy is transformed)

### 4.2 `toClientChildForRender` — the INSTANCE expansion walk

Visits each node of the master subtree, applying the outer INSTANCE's overrides. **The 13 arguments of this function are the path-keyed override delivery channel**:

```ts
toClientChildForRender(
  n: TreeNode,                       // 1. currently-visited node
  blobs: Array<{bytes: Uint8Array}>, // 2. for vectorNetworkBlob decode
  symbolIndex: Map<...>,             // 3. for nested INSTANCE handling
  textOverrides:        Map<key, string>,         // 4. round-4
  fillOverrides:        Map<key, unknown[]>,      // 5. round-12
  visibilityOverrides:  Map<key, boolean>,        // 6. round-4
  depth: number,                                  // 7. recursion-depth ceiling
  pathFromOuter: string[],                        // 8. ⭐ path-key accumulator
  propAssignments:        Map<defID, boolean>,    // 9. round-12 (at-instance)
  propAssignmentsByPath:  Map<key, Map<...>>,     // 10. round-15 (at-path)
  swapTargetsByPath:      Map<key, swapID>,       // 11. round-16
  derivedSizesByPath:     Map<key, {x,y}>,        // 12. round-22
  derivedTransformsByPath:Map<key, Transform2D>,  // 13. round-24
): DocumentNode
```

At each visit, compute `currentKey = [...pathFromOuter, n.guidStr].join('/')`, then look up the 7 maps to apply.

### 4.3 `applyInstanceReflow` — re-layout inside the INSTANCE bbox

When the INSTANCE size differs from the master, we simulate *figma's intended re-execution of layout*. Rules:
- **§3.1-3.5 CENTER+CENTER reflow** (round 14): primary/counter both CENTER; re-center children when instance < master
- **§3.6 overlap-group reflow** (round 15 phase B): distribute children stacked at the same primary position
- **§3.7 MIN/start-aligned reflow** (round 19): MIN/undefined primary + some hidden; pack only visible children
- **§3.7.5 trigger narrowing** (round 21): reflow only along axes where instance < master (preserve master coords along grown axes)
- **§3.8 stackPrimarySizing AUTO grow** (round 20): in RESIZE_TO_FIT mode, grow small hints to the master
- **§3.9 derivedSize baking** (round 22): outer INSTANCE's `derivedSymbolData[].size` → all descendants
- **§3.10 derivedTransform baking** (round 24): the same entry's `transform` → all descendants

**v1 limitation (spec §3.10 I-DT4)**: for the direct children where reflow fired, reflow wins for m02/m12 (overriding derivedTransform). For deep descendants reflow doesn't touch them, so derivedTransform is final. The two computations should agree in principle, so no visual impact has been observed.

Detailed invariants: [`web-instance-autolayout-reflow.spec.md`](./specs/web-instance-autolayout-reflow.spec.md).

---

## 5. Override system — 7 path-keyed pipelines

All 7 overrides applied during INSTANCE expansion match via a **common path-key scheme**:

| # | override | source | collector | apply site in `toClientChildForRender` | round |
|---|---|---|---|---|---|
| 1 | `_renderTextOverride` | INSTANCE.symbolData.symbolOverrides[].textData | `collectTextOverridesFromInstance` | TEXT node output | 4 |
| 2 | `out.fillPaints` | INSTANCE.symbolData.symbolOverrides[].fillPaints | `collectFillOverridesFromInstance` | right after data spread | 12 |
| 3 | `out.visible` | INSTANCE.symbolData.symbolOverrides[].visible | `collectVisibilityOverridesFromInstance` | right after data spread | 4 |
| 4 | `out.visible` (default determination) | INSTANCE.componentPropAssignments + descendant.componentPropRefs[VISIBLE] | `collectPropAssignmentsFromInstance` | when no visibility override exists | 12 |
| 4b | (the above) at-path variant | symbolOverrides[].componentPropAssignments | `collectPropAssignmentsAtPathFromInstance` | path-keyed merge | 15 |
| 5 | nested INSTANCE master swap | symbolOverrides[].overriddenSymbolID | `collectSwapTargetsAtPathFromInstance` | nested INSTANCE branch | 16 |
| 6 | `out.size` | derivedSymbolData[].size + .derivedTextData.layoutSize | `collectDerivedSizesFromInstance` | after data spread + before reflow | 22 |
| 7 | `out.transform` | derivedSymbolData[].transform | `collectDerivedTransformsFromInstance` | after data spread + before reflow | 24 |

All 7 share the *same path-key scheme* — defined in [§6 path-key contract](#6-path-key-contract-round-25-normalization--system-foundation).

Detailed invariants for each override:
- 1, 2, 3, 4, 4b: [`web-instance-render-overrides.spec.md`](./specs/web-instance-render-overrides.spec.md)
- 5: [`web-instance-variant-swap.spec.md`](./specs/web-instance-variant-swap.spec.md)
- 6, 7: [`web-instance-autolayout-reflow.spec.md`](./specs/web-instance-autolayout-reflow.spec.md) §3.9 / §3.10

---

## 6. Path-key contract (round 25 normalization — system foundation)

The single rule on which all 7 override pipelines depend. Round 25 corrected it to match Figma's wire format exactly.

### 6.1 Definition

`pathKey` = `slash-joined GUIDs` of:
- (a) within the visit chain from the outer instance master root to the target, **include only ancestors with `type === 'INSTANCE'`**
- (b) and also include **the target node itself**

**Non-INSTANCE container ancestors such as FRAME / GROUP / SECTION are skipped from the key.**

### 6.2 Example (alert SYMBOL master 64:376)

```
master 64:376 (alert SYMBOL)
  └ buttons FRAME 60:348      ← skipped from key
      ├ Button 60:341 "Cancel"   ← target → key = "60:341"
      └ Button 60:340 "Delete"   ← target → key = "60:340"
                  └ TEXT 5:45     ← target via INSTANCE 60:340 → key = "60:340/5:45"
```

INSTANCE 60:340 expands its own master, so paths into that INSTANCE's descendants get the INSTANCE-id as a prefix. If another FRAME exists inside that INSTANCE's descendants, that FRAME is also skipped.

### 6.3 Implementation (clientNode.ts)

```ts
const currentPath = n.guidStr ? [...pathFromOuter, n.guidStr] : pathFromOuter;
const currentKey = currentPath.join('/');
// only INSTANCEs contribute to the path during child recursion
const childPathFromOuter = n.type === 'INSTANCE' ? currentPath : pathFromOuter;
```

This single line (the `childPathFromOuter` determination) governs the matching consistency of all 7 override pipelines.

### 6.4 Nested INSTANCE prefix-merge

When an inner INSTANCE carries its own `symbolOverrides` / `derivedSymbolData`, prefix the inner keys with the outer's currentPath and merge into the outer override maps. This lets the outer's overrides reach grand-descendants.

```ts
// inner override key "5:45" + outer currentPath ["60:340"]
// → merged key "60:340/5:45"
```

All 7 overrides use the same `mergeOverridesForNested` (or an equivalent pattern).

### 6.5 Master immutability

Override application happens only on the *per-instance `_renderChildren` copy*. The master TreeNode's own data is not modified — the same master can be expanded with each INSTANCE's own overrides.

---

## 7. Web HTTP API

| Route | use case | spec |
|---|---|---|
| `POST /api/upload-fig` | UploadFig | `web-upload-fig.spec.md` |
| `GET  /api/doc/:id` | (LoadSnapshot internally) | — |
| `POST /api/save/:id` | SaveSnapshot | `web-snapshot.spec.md` |
| `POST /api/snapshot/:op` | LoadSnapshot | (the above spec) |
| `POST /api/override-instance-text` | OverrideInstanceText | `web-instance-override.spec.md` |
| `POST /api/resize` | ResizeNode | `web-resize-node.spec.md` |
| `POST /api/edit/:id` | EditNode (path-set) | `web-edit-node.spec.md` |
| `POST /api/chat` | RunChatTurn | `web-chat-turn.spec.md` + `web-chat-leaf-tools.spec.md` + `web-chat-duplicate.spec.md` |
| `GET  /api/asset/:hash` | ServeAsset | `web-asset-serve.spec.md` |
| `GET  /api/history/:id` | Undo/Redo state | `web-undo-redo.spec.md` |
| `POST /api/group` / `/api/ungroup` | (group helpers) | `web-group-ungroup.spec.md` |
| `POST /api/export` | ExportFig | `web-export-fig.spec.md` |

Routes are all **thin shells** — input parsing + use case invocation + response serialization. Business logic lives inside application/.

---

## 8. Round history matrix

A one-glance view of which spec / code / tests each round added.

| Round | Theme | spec | Core change | Affects |
|---|---|---|---|---|
| 1-3 | Hexagonal foundations | `web-render-fidelity-high/round2/round3` | Phase 0~5 migration | all of web/ |
| 4 | per-instance text/visibility override | `web-render-fidelity-round4` | `collectText/Visibility/FillOverridesFromInstance` | INSTANCE expansion |
| 5-9 | text style runs / segment fidelity | `web-render-fidelity-round5..9` | font / color / decoration / segment | TEXT render |
| 10 | text frame fidelity / layout size | `web-render-fidelity-round10` + `web-canvas-text-frame-fidelity` | TEXT bbox accuracy | TEXT render |
| 11 | audit harness introduction | (`docs/audit-round11/`) | sample .fig comparison baseline 753 PNG | regression guard |
| 12 | INSTANCE auto-clip + componentPropAssignments visibility | `web-canvas-instance-clip` + `render-overrides.§3.4` | modal leak fix + prop binding | render |
| 13 | round-12 visual gate | (refresh round-11 baseline) | — | regression |
| 14 | INSTANCE auto-layout reflow v1 | `web-instance-autolayout-reflow.§2-3.5` | CENTER+CENTER reflow | render |
| 15 | path-keyed prop assigns + overlap-group reflow | `render-overrides.§3.4 I-P11` + reflow §3.6 | sample Dropdown rail | render |
| 16 | variant swap | `web-instance-variant-swap` | overriddenSymbolID handling | INSTANCE expansion |
| 17 | swap target visual inheritance | (variant-swap §3.3 round-17) | inherit fill/stroke etc. on swap | render |
| 18 | cluster A extraction | (`expansion-context.spec.md` candidate) | modularize `masterIndex` / `effectiveVisibility` / `instanceOverrides` | code structure |
| 19 | MIN-pack reflow | reflow §3.7 | sidemenu visible-child packing | render |
| 20 | stackPrimarySizing AUTO grow | reflow §3.8 | Excel download button | render |
| 21 | reflow trigger narrowing | reflow §3.7.5 | protect grown axes + round-21 deferred | render |
| 22 | derivedSymbolData size baking | reflow §3.9 | size for all descendants | render |
| 23 | audit isolation v3 + e2e gate | (audit harness itself) | __setIsolateNode + refresh round-11 baseline | regression |
| 24 | derivedSymbolData transform baking | reflow §3.10 | positions for all descendants + e2e gate | render |
| **25** | **path-key normalization** | render-overrides §3.1 v3 + 4 spec cross-refs | **FRAME/GROUP ancestor skip → 7 pipelines as a whole** | **foundation correction** |

Round 25 is when the system foundation was corrected. After this, the INSTANCE pipeline is consistent with Figma's wire format.

---

## 9. Test layers

| Layer | Tool | Location | Count (at round 25) | Scope |
|---|---|---|---|---|
| **L0 Unit** | vitest | `web/core/**/*.test.ts` + `src/**/*.test.ts` (root) + `test/` | 450 web + 126 root | domain helpers, application use cases, adapters, override collectors |
| **L1 e2e** | playwright | `web/e2e/*.spec.ts` | ~30 | upload→save→edit / chat sequences / audit contract |
| **L2 Audit** | playwright + sample .fig | `web/scripts/audit-round11-screenshots.mjs` + `docs/audit-round11/` | 749 PNG (baseline) | visual regression — 4 corpora (design-setting / dash-board / mobile / web) |
| **L3 Round-trip** | vitest | `test/e2e.test.ts` | 1 | .fig → tree → repack → equality |
| **L4 Verification** | CLI `verify.ts` | `output/verification_report.md` | V-01~V-08 | extract-output consistency |

### 9.1 Audit harness

The 4 corpora under `docs/audit-round11/` cover 1,500+ INSTANCE slugs. For each slug:
- `<page>/<slug>/figma.png` — Figma REST API capture (deployed by the user in advance)
- `<page>/<slug>/ours.png` — our render (auto-captured)

After a round's work, regenerate ours.png with `node web/scripts/audit-round11-screenshots.mjs <page>`, classify wins/regressions via byte-delta analysis, then confirm visually. Commit per round (e.g. `chore(audit): round 25 — refresh WEB`).

`docs/audit-round11/GAPS.md` accumulates per-round close notes — a permanent record of which wins/regressions were found and how they were classified.

### 9.2 e2e contract gates

e2e tests that **contract-pin a specific visual win by pixel sampling**:

| File | round | contract | fixture |
|---|---|---|---|
| `audit-isolation.spec.ts` | 23 | `__setIsolateNode` 4-piece behavior | right_top, frame-2320, frame-2364 |
| `audit-transform-baking.spec.ts` | 24 | derivedTransform mobile 5th-row render | mobile/frame-2323-477_6439 |
| `audit-transform-baking.spec.ts` | 25 | path-key fix → alert Delete button visible | web/alert-364_2962 |

Each contract uses a `samplePixel({clip: 3x3 PNG})` + assertion (R<220 / b > r > 200, etc.) pattern.

---

## 10. Spec registry

Current classification of `docs/specs/*.spec.md` (39 specs):

### 10.1 Foundation
- `round-trip-invariants.spec.md` — .fig roundtrip rules
- `parent-index-position.spec.md` — fractional indexing
- `text-segments.spec.md` — TEXT segment model
- `editable-html.spec.md` / `html-to-message.spec.md` / `sidecar-meta.spec.md` — single-html export
- `json-repack-codec.spec.md` — JSON ⇄ kiwi roundtrip

### 10.2 Web use cases (application)
- `web-upload-fig` / `web-edit-node` / `web-resize-node` / `web-export-fig` / `web-snapshot`
- `web-instance-override` (write side: write text overrides via chat/HTTP)
- `web-asset-serve`
- `web-chat-turn` / `web-chat-leaf-tools` / `web-chat-duplicate`
- `web-group-ungroup`
- `web-undo-redo`

### 10.3 Render fidelity (clientNode + Canvas)
- `web-render-fidelity-high` (1-3 consolidated), `web-render-fidelity-round2..10`
- `web-canvas-instance-clip` (round 12)
- `web-canvas-text-style-runs` / `web-canvas-text-frame-fidelity` / `web-canvas-hover-tooltip`
- `web-instance-render-overrides` (read side: round 4/12/15 — **source of truth for the path-key contract**)
- `web-instance-variant-swap` (round 16/17)
- `web-instance-autolayout-reflow` (round 14/15/19/20/21/22/24)

### 10.4 Refactor planning
- `expansion-context.spec.md` — the round 18 cluster A extraction plan

### 10.5 UI / Layout
- `web-left-sidebar`

[SDD.md](./SDD.md) rule: spec is the source of truth. Iron rule — if implementation diverges from spec, update the spec first, then the test, then the code.

---

## 11. Dependencies

### 11.1 Runtime (summary)

| Area | Package | Purpose |
|---|---|---|
| CLI codec | `adm-zip`, `pako`, `fzstd`, `kiwi-schema` | ZIP / deflate / zstd / Kiwi |
| Web server | `hono`, `@hono/node-server` | HTTP |
| Chat | `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk` | LLM |
| Web client | `react`, `react-dom`, `react-konva`, `konva`, `vite` | UI |

### 11.2 Development (summary)

| Area | Package |
|---|---|
| Typecheck | `typescript` |
| Unit tests | `vitest` |
| e2e tests | `@playwright/test`, `pngjs` |
| dev execution | `tsx` |

Full list: `package.json` (root) + `web/package.json`.

---

## 12. Command cheatsheet

```bash
# Unit tests
npx vitest run                            # root: 126 tests
npm --prefix web test                     # web: 450 tests

# e2e (requires dev server)
npm --prefix web run dev                  # start in background
cd web && npx playwright test e2e/audit-transform-baking.spec.ts

# Audit baseline recapture (requires dev server)
node web/scripts/audit-round11-screenshots.mjs <page-slug>

# CLI extract / repack / pen-export
npx tsx src/cli.ts extract docs/bvp.fig
npx tsx src/cli.ts repack ./extracted ./out.fig
npx tsx src/cli.ts pen-export docs/bvp.fig out.pen
```

---

## 13. Known limitations + round-26 candidates

### 13.1 Known limitations (at round 25)

- **derivedTransform v1 limitation** (reflow §3.10 I-DT4): for the direct children where reflow fired, reflow wins for m02/m12. No visual impact observed, so punted in v1.
- **componentPropNodeField partial support**: only VISIBLE is handled; TEXT / INSTANCE_SWAP are not.
- **stroke / effects / opacity / blendMode overrides unsupported**: only fillPaints is handled. Not observed in sample cases.
- **colorVar / variable alias unresolved**: only literal colors are used. `.fig` files always stamp the literal too, so there's no visual impact.
- **Vector decode 95%**: 82 composite nodes such as BOOLEAN_OPERATION have no fillGeometry — best-effort.
- **Figma cloud import unverified**: it has not been confirmed that Figma accepts a repacked `.fig`.

### 13.2 Round-26 candidates (currently empty)

At round 25 close there were no new candidates. The round-25 verdict in GAPS.md says "no round 26 candidates; future rounds can build on top with confidence".

Subsequent work is free in the area of *new features on top of the existing system* — for example:
- New Figma design conversion corpora (beyond the sample)
- Extend componentPropNodeField TEXT / INSTANCE_SWAP support
- Add stroke/effects overrides
- Strengthen Pencil round-trip (`.pen` ↔ `.fig`) equality
- editable-html UI expansion
- Extend LLM agent tools (currently supports set_text / set_fill / duplicate / leaf operations)

---

## 14. Directory structure at a glance

```
figma_reverse/
├─ src/                               CLI + shared domain (§3.1)
│  ├─ cli.ts, container.ts, decoder.ts, tree.ts, ...
│  ├─ pen-export.ts, editable-html.ts, repack.ts
│  └─ instanceOverrides.ts ⭐ (round 18, 25)
├─ web/
│  ├─ core/                           Hexagonal domain core (§3.2)
│  │  ├─ domain/clientNode.ts ⭐
│  │  ├─ ports/, application/
│  ├─ server/adapters/                Hexagonal outer ring (§3.3)
│  │  ├─ driving/http/
│  │  └─ driven/
│  ├─ client/src/                     React UI (§3.4)
│  ├─ e2e/                            Playwright (§9)
│  └─ scripts/audit-round11-*.mjs    Audit harness
├─ docs/
│  ├─ SPEC.md                         CLI 9-stage (§1, §2)
│  ├─ SPEC-architecture.md            ⭐ this document (current snapshot + Phase 0 history)
│  ├─ SDD.md, HARNESS.md, PRD.md
│  ├─ adr/                            4 decision records
│  ├─ specs/*.spec.md                 39 specs (§10)
│  └─ audit-round11/                  Audit baseline + GAPS.md (§9.1)
├─ test/                              root vitest
└─ extracted/, output/                CLI outputs (gitignored)
```

---

## 15. References

- Per-round commit chains: `git log --oneline --grep "round 2[0-5]"`
- Audit baseline evolution: `docs/audit-round11/GAPS.md` (round 22 / 23 / 24 / 25 close sections)
- Checklist for starting a new round:
  1. Identify the nearest precedent in [§8 round matrix](#8-round-history-matrix) of this doc
  2. Identify affected specs ([§10 Spec registry](#10-spec-registry))
  3. SDD rule — spec first, then test, then code
  4. Update unit tests + the 4-corpus audit baseline
  5. e2e contract pin (if there is a visual win)
  6. Add a round-N close section in GAPS.md

---

## 16. Appendix A — Phase 0~7 migration history (2026-05-02 ~ 05)

**(Absorbed content from the former `docs/ARCHITECTURE.md` — historical reference after migration completion)**

### 16.1 Migration overview

| Item | Value |
|---|---|
| Started | 2026-05-02 (former `ARCHITECTURE.md` v0.1 — Phase 0 deliverable) |
| Ended | 2026-05-05 (round 25 cutoff — when this SPEC was written) |
| Scope | `web/` server + client (`src/` CLI was out of scope) |
| Non-goals | Feature additions / behavior changes / `src/` reshuffling |

> **Goal** (at the time): Re-arrange a single 1,234-line `server/index.ts` + a
> React client with business logic scattered across components into **Clean
> Architecture × Hexagonal (Ports & Adapters)**. Separate external dependencies
> (filesystem, Anthropic SDK, Hono, React) from the domain core → maintainability
> · testability. Apply the SPEC→TEST→IMPL cycle ([SDD.md](./SDD.md),
> [HARNESS.md](./HARNESS.md)) consistently to the web layer too.

### 16.2 Phase 0 inventory (LOC distribution right before migration)

```
server/index.ts            1234   ← monolith: routing + domain + IO + SDK
client/src/Canvas.tsx       878   ← Konva render + events + coordinate math
client/src/Inspector.tsx    948   ← UI + patches + color/number + component-text model
client/src/ChatPanel.tsx    543   ← UI + fetch + auth modes + model selection
client/src/App.tsx          344   ← layout + onUpload/onSave/onMove*
client/src/hooks/usePatch.ts 77   ← debounce (already extracted)
client/src/multiResize.ts   ~80   ← group resize (already extracted)
─────────────────────────────────
                           ≈4659  (excluding UI primitives)
```

Problems at the time:
- Route handlers handled domain logic + IO + external SDK calls in a single function → not unit-testable
- React components called `fetch()` directly → required network mocking in component tests
- The same domain concepts were duplicated between client and server

### 16.3 Phase roadmap (actual progress)

| Phase | Deliverable | Result |
|---|---|---|
| **0** | The predecessor of this document (`ARCHITECTURE.md` Phase 0 deliverable) | ✅ completed 2026-05-02 |
| **1** | 6 `web/core/ports/*.ts` interfaces | ✅ |
| **2** | Extract pure helpers to `web/core/domain/*.ts` + shim | ✅ |
| **3** | `web/server/adapters/driven/*.ts` (FsSessionStore etc.) | ✅ |
| **4** | `web/core/application/*.ts` use cases | ✅ |
| **5** | Split Hono routes into `web/server/adapters/driving/http/*.ts` | ✅ |
| **6** | `web/client/src/services/*.ts` (network/state abstraction) | ✅ |
| **7** | Settle SDD/Harness: `docs/specs/web-*.spec.md` + L0/L1 tests | ✅ (the results are §10 Spec registry + §9 test layers of this SPEC) |

All 7 phases were completed by round 25. §3 of this SPEC (module catalog) is the
single source of *the result* — `web/core/domain` has zero deps, `web/core/application`
imports only ports + domain, and `web/server/adapters/driven` connects to external
libraries.

### 16.4 Key migration decisions (at Phase 0)

| Decision | Value | Rationale |
|---|---|---|
| New code location | `web/core/` (inside the web tree) | Keep `src/` CLI-only. Revisit consolidation later |
| Port definition location | `web/core/ports/` | application owns ports |
| Domain dependencies | 0 (no React, no Node fs, no SDK) | Guarantees test isolation · reusability |
| Shim strategy | Existing import paths kept as re-exports | Phase 2 regression = 0 |
| `src/` reshuffling | Out of scope for this migration | Pursue under a separate RFC |

Consequence of the last decision ("`src/` reshuffling out of scope"): in round 18,
`masterIndex` / `effectiveVisibility` / `instanceOverrides` are kept under `src/`
while the Web side imports them — formally decided in
[ADR-0004](./adr/0004-shared-modules-live-in-src.md).

### 16.5 Regression guards (Phase 0~2 invariants at the time)

- 8 unit + 7 e2e + typecheck + production build kept passing
- No signature changes for functions like `tokenizePath` / `setPath` (re-export shim compatibility)
- No external behavior (`/api/*` responses) changes
- Dependency changes were dev-deps only; 0 new runtime deps

Behavioral equivalence for Phase 3+ is guaranteed by [HARNESS.md](./HARNESS.md) Layer 0~3.
The §9 test layers have now evolved — at round 25, L0 (450 web + 126 root
unit) + L1 (~30 e2e) + L2 (749 audit PNG) + L3 (round-trip) + L4 (CLI verify).

### 16.6 Module-move matrix (current → destination, completed)

| Source (inside the then `server/index.ts`) | Destination (current) |
|---|---|
| `tokenizePath`, `setPath` | `web/core/domain/path.ts` |
| `findById`, `findNode` | `web/core/domain/tree.ts` |
| `summarizeDoc` | `web/core/domain/summary.ts` |
| `sniffImageMime` | `web/core/domain/image.ts` |
| `repack` / `decode` calls | `web/server/adapters/driven/KiwiCodec.ts` |
| `mkdtemp` / `readFile` / save flow | `web/server/adapters/driven/FsSessionStore.ts` |
| `GET /api/asset` handler | `web/core/application/ServeAsset.ts` + `adapters/driving/http/assetRoute.ts` |
| `POST /api/chat` (subscription) | `RunChatTurn` + `AgentSdkChat` |
| `POST /api/chat` (api-key) | `RunChatTurn` + `AnthropicChat` |
| `applyTool` | `InProcessTools` (impl) + `core/ports/ToolDispatcher.ts` (contract) |
| `Inspector.tsx:rgbaToHex/hexToRgb01` | `web/core/domain/color.ts` (unified with Canvas) |
| `Canvas.tsx:imageHashHex` | `web/core/domain/image.ts` |
| `Canvas.tsx:colorOf/strokeOf/guidStr` | `web/core/domain/color.ts` + `web/core/domain/tree.ts` |
| `client/src/api.ts` (fetch wrapper) | `client/src/services/*Service.ts` |
| `client/src/hooks/usePatch.ts` | (unchanged — already in the right place) |
| `client/src/multiResize.ts` | (unchanged) |
| Hono routes (all `app.get/post/patch`) | split into `adapters/driving/http/*Route.ts` |

This matrix is *archaeology of completed work* — new code should reference the
catalog in §3 of this SPEC. The table is useful only when tracing git blame or
the migration PRs.
