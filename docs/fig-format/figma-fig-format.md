# The Figma `.fig` file structure (reverse-engineered)

> A reverse-engineered picture of Figma's internal binary format, which they have not officially documented.
> It uses the [kiwi](https://github.com/evanw/kiwi) binary schema library — built by Evan Wallace (former Figma CTO) — as its container. This document walks through how a .fig file is decoded *in three stages*, from raw bytes all the way to Figma's on-screen elements.

---

## 0. At a glance

A `.fig` file requires three layers of decoding before it carries meaning:

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 1: File container                                     │
│  [magic 8B][version 4B][length-prefixed chunks ...]          │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 2: Schema chunk interpretation                        │
│  decompress → kiwi binary schema → 558 type definitions      │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: Data chunk interpretation                          │
│  decompress → decode with schema → Message + node tree       │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
       Figma UI (Layers / Canvas / Inspector)
```

**Three core principles:**

1. **Self-describing**: the schema itself is bundled in the file → forward/backward compat
2. **Linearly serializable**: every decode is a single forward scan, no look-ahead
3. **Tag-based wire format**: optional fields and new field additions are free

---

## 1. Layer 1 — File container

### Overall layout

```
offset  size    field
─────────────────────────────────────────
0x00    8       magic = "fig-kiwi" (ASCII)
0x08    4       version (uint32 LE)
0x0C    4       chunk[0] length (uint32 LE)
0x10    N0      chunk[0] bytes
0x10+N0 4       chunk[1] length
...     N1      chunk[1] bytes
        4       chunk[2] length      (may or may not be present)
        N2      chunk[2] bytes
        ...                          (repeats until EOF)
```

### Decoder pseudocode

```javascript
const magic = readBytes(8);                  // "fig-kiwi"
const version = readUint32LE();              // file format version
const chunks = [];
while (offset < bytes.length) {
  const len = readUint32LE();
  chunks.push(readBytes(len));
}
if (chunks.length < 2) throw 'invalid';
```

### Conventional chunk meanings

| index | Content | Required? |
|---|---|---|
| `chunk[0]` | Schema (kiwi binary) | required |
| `chunk[1]` | Data (Message) | required |
| `chunk[2]` | Preview thumbnail (PNG bytes) | optional |
| `chunk[3+]` | reserved for future expansion | no known usage at present |

### Compression

Each chunk is **compressed independently**. There is no header indicating the algorithm; sniffing is used:

```javascript
function decompress(chunk) {
  try { return pako.inflateRaw(chunk); }       // deflate (raw)
  catch { return zstdDecode(chunk); }           // zstd fallback
}
```

---

## 2. Layer 2 — Schema chunk interpretation

After decompression you still get **binary**. This is kiwi's self-describing schema format (same as `.bkiwi`).

### 2.1 Overall structure

```
[definitionCount : varuint]
└── for i in 0..definitionCount:
    ├── [name       : null-terminated UTF-8 string]
    ├── [kind       : 1 byte]                ─┐
    ├── [fieldCount : varuint]                │  ENUM = 0
    └── for j in 0..fieldCount:               │  STRUCT = 1
        ├── [fieldName : string]              │  MESSAGE = 2
        ├── [type      : varint]              │
        ├── [isArray   : 1 byte (low bit)]    │
        └── [value     : varuint]             │
```

### 2.2 Field meanings

| Field | Meaning |
|---|---|
| `definitionCount` | Number of types in this schema. Figma .fig typically has ~558. |
| `name` | Type name. E.g. `"GUID"`, `"NodeChange"`, `"Message"` |
| `kind` | One of `ENUM` (0), `STRUCT` (1), `MESSAGE` (2) |
| `field.type` | Negative → built-in type index, positive → index into other definitions |
| `field.isArray` | Whether this field is an array `T[]` |
| `field.value` | **MESSAGE wire tag**, or the binary value for an ENUM |

### 2.3 Built-in type table

The 8 base types that `field.type` references when negative:

| index | Type | Encoding |
|---|---|---|
| -1 | bool | 1 byte |
| -2 | byte | 1 byte |
| -3 | int | varint (zigzag) |
| -4 | uint | varuint |
| -5 | float | 4 bytes (LE, some zigzag variants) |
| -6 | string | null-terminated UTF-8 |
| -7 | int64 | varint64 |
| -8 | uint64 | varuint64 |

### 2.4 Wire differences across the three kinds (★ important)

| Kind | Wire pattern | Evolvability |
|---|---|---|
| **ENUM** | `[varuint]` | new values can be added |
| **STRUCT** | `[val][val][val]…` (no tag) | **no new fields** (struct is already in use) |
| **MESSAGE** | `[tag][val][tag][val]…[0]` | new fields can be added freely, optional |

This difference determines the decoder's branching at Layer 3.

### 2.5 Decoded result (in-memory schema object)

```javascript
{
  definitions: [
    {
      name: "GUID",
      kind: "STRUCT",
      fields: [
        { name: "sessionID", type: -4 /*uint*/, isArray: false, value: 0 },
        { name: "localID",   type: -4,         isArray: false, value: 0 },
      ]
    },
    {
      name: "NodeChange",
      kind: "MESSAGE",
      fields: [
        { name: "guid",     type: <GUID idx>,    isArray: false, value: 1  },
        { name: "type",     type: <NodeType idx>,isArray: false, value: 2  },
        { name: "name",     type: -6 /*string*/, isArray: false, value: 3  },
        { name: "transform",type: <Matrix idx>,  isArray: false, value: 4  },
        { name: "size",     type: <Vector idx>,  isArray: false, value: 5  },
        // ...
      ]
    },
    {
      name: "Message",     // ← root type, conventional name
      kind: "MESSAGE",
      fields: [
        { name: "type",         type: <MsgType idx>,    isArray: false, value: 1 },
        { name: "sessionID",    type: -4,               isArray: false, value: 2 },
        { name: "nodeChanges",  type: <NodeChange idx>, isArray: true,  value: 3 },
        // ...
      ]
    },
    // ... ~555 more
  ]
}
```

### 2.6 Schema chunk hex sample (fictional)

The byte stream of the simplest possible schema, with only a single `GUID` STRUCT defined:

```
01                          ← definitionCount = 1
47 55 49 44 00              ← name = "GUID\0"
01                          ← kind = STRUCT (1)
02                          ← fieldCount = 2
73 65 73 73 69 6F 6E 49 44 00  ← fieldName = "sessionID\0"
07                          ← type = -4 (uint, varint zigzag of -4 = 0x07)
00                          ← isArray = 0
00                          ← value = 0
6C 6F 63 61 6C 49 44 00     ← fieldName = "localID\0"
07                          ← type = -4 (uint)
00                          ← isArray = 0
00                          ← value = 0
```

26 bytes in total. A real Figma .fig schema chunk is a binary stream with ~558 such definitions concatenated.

---

## 3. Layer 3 — Data chunk interpretation

After decompression you get **a single root Message object** as a whole. Unlike the schema, there is no introductory header.

### 3.1 Entry point

The decoder finds the definition named `Message` in the schema and starts decoding using that type.

```javascript
const rootDef = schema.definitions.find(d => d.name === "Message");
const message = decodeMessage(dataBytes, rootDef, schema);
```

This convention is the only thing agreed upon outside the schema itself.

### 3.2 MESSAGE decoding algorithm

```javascript
function decodeMessage(bb, def, schema) {
  const result = {};
  while (true) {
    const tag = bb.readVarUint();
    if (tag === 0) break;                           // ★ 0 = sentinel, end of message

    const field = def.fields.find(f => f.value === tag);
    if (!field) {
      skipUnknownField(bb, schema);                 // forward compat
      continue;
    }

    result[field.name] = field.isArray
      ? decodeArray(bb, field.type, schema)
      : decodeValue(bb, field.type, schema);
  }
  return result;
}
```

### 3.3 STRUCT vs MESSAGE decoding branches

| Encountered type | Decoding behavior |
|---|---|
| STRUCT | Read `def.fields` in order (no tags, no terminator sentinel, all fields required) |
| MESSAGE | tag-based loop, until the 0 sentinel |
| ENUM | Read one `varuint`, look up the name by matching it to a schema enum value |
| array `T[]` | Read `[count : varuint]` and decode `count` elements |

### 3.4 Field tag matching (★ core)

The mechanism that decides which field a data byte belongs to:

```
data byte stream:        03 ...
                         ↑
                         │ this byte is the tag (varuint)
                         │
Schema definition:       Message {
                           ...
                           field { name: "nodeChanges", value: 3 }  ← match!
                           ...
                         }
                         │
Result:                  result["nodeChanges"] = decodeArray(...)
```

**Compatibility is preserved even if the name changes, as long as the value is the same** — this is the secret to Figma being able to evolve the schema while continuing to read old .fig files.
The `SPACE_EVENLY ↔ SPACE_BETWEEN` situation we saw in audit-oracle spec is the same mechanism.

### 3.5 What node IDs really are

Each node is identified by `GUID = { sessionID: uint, localID: uint }`:

- `sessionID`: the session number of the client that created the node
- `localID`: a sequence number within that session

When represented as a string, it is usually in the `<sessionID>:<localID>` form. The parent-child relationship is expressed through `parentIndex: { guid, position: fractional }`, using **fractional indexing for CRDT ordering** so sibling order is preserved without conflict during concurrent editing.

### 3.6 Data chunk hex sample (fictional)

The minimal data containing only `Message { type: NODE_CHANGES, sessionID: 42 }`:

```
01                          ← tag = 1 ("type" field)
00                          ← value = 0 (enum value for NODE_CHANGES)
02                          ← tag = 2 ("sessionID" field)
2A                          ← value = 42 (varuint)
00                          ← tag = 0 → end of message
```

5 bytes in total. In an actual .fig, `nodeChanges: NodeChange[]` is attached here as an array, into which tens of thousands of nodes line up.

---

## 4. Shape of the decoded result

After Layer 3 you get an in-memory JSON-like object.

### 4.1 Top-level Message

```javascript
{
  type: "NODE_CHANGES",
  sessionID: 0,
  ackID: 0,
  nodeChanges: [
    { /* DOCUMENT */ },
    { /* CANVAS (page 1) */ },
    { /* FRAME */ },
    { /* RECTANGLE */ },
    // ...
  ]
}
```

### 4.2 Example of a single node (RECTANGLE)

```javascript
{
  guid:    { sessionID: 0, localID: 12 },
  parentIndex: {
    guid: { sessionID: 0, localID: 5 },
    position: "!"          // fractional index
  },
  type:    "RECTANGLE",
  name:    "Button BG",
  visible: true,

  // visual properties
  transform: {
    m00: 1, m01: 0, m02: 100,    // 2x3 affine matrix
    m10: 0, m11: 1, m12: 200
  },
  size: { x: 120, y: 40 },
  cornerRadius: 8,
  opacity: 1,

  // fill
  fillPaints: [
    {
      type: "SOLID",
      color: { r: 0.2, g: 0.5, b: 1.0, a: 1.0 },
      opacity: 1,
      visible: true
    }
  ],
  strokePaints: [],
  strokeWeight: 1,
  // ...
}
```

### 4.3 INSTANCE node (component instance)

```javascript
{
  guid: { sessionID: 0, localID: 87 },
  type: "INSTANCE",
  name: "Button/Primary",
  componentRef: { sessionID: 0, localID: 23 },   // master GUID
  overrideKey: 12345,                             // override tracking
  // effective children derived from master
  _renderChildren: [ /* ... */ ],
  // carries only the overridden properties
  fillPaints: [ /* override */ ],
}
```

### 4.4 TEXT node

```javascript
{
  guid: { sessionID: 0, localID: 33 },
  type: "TEXT",
  textData: {
    characters: "Hello, world!",
    styleOverrideTable: [ /* per-char style runs */ ],
    layoutSize: { x: 200, y: 24 },
  },
  fontName: { family: "Inter", style: "Bold" },
  fontSize: 16,
}
```

### 4.5 VECTOR node (separate binary blob region)

```javascript
{
  guid: { sessionID: 0, localID: 99 },
  type: "VECTOR",
  vectorNetworkBlob: <Uint8Array>,   // ← beyond the schema's view, yet another binary layer
  commandsBlob: <Uint8Array>,         // ← packed binary of SVG path commands
  fillPaints: [ /* ... */ ],
}
```

The schema only knows `vectorNetworkBlob` and `commandsBlob` as byte arrays;
*the semantics inside* are a separate reverse-engineering target.

---

## 5. Mapping to the Figma UI

| Figma UI region | Source inside the data chunk |
|---|---|
| **Top Pages tab** | `CANVAS`-type nodes (each page = one sub-root) |
| **Left Layers panel** | Every node's `guid`, `name`, `type`, `visible`, parent-child relation |
| **Center Canvas** | The render result *computed at runtime* from the above properties (pixels are not stored) |
| **Right Inspector** | The selected node's `transform`, `size`, `fillPaints`, `strokePaints`, `effects`, `cornerRadius`, `opacity`, layoutMode + stack* fields, etc. |
| **Components panel** | `SYMBOL`-type nodes (master) + INSTANCE's `componentRef` |
| **Variables panel** | `VARIABLE`, `VARIABLE_SET`-type nodes |
| **Prototype tab** | `reactions`, `prototypeStartNode`, transition properties |
| **Auto-layout controls** | `layoutMode`, `stackSpacing`, `stackPadding*`, `stackAlign*` |

### 1:1 relation between Inspector and schema field

A single row in the right Inspector is nearly 1:1 with a single entry of a schema field. When the user is looking at "Corner radius: 8", what is actually being displayed is the schema field value `cornerRadius: 8` of the selected node, as-is.

### The true meaning of the canvas

The most confusing part: **canvas pixels are not stored.** What is stored is only the drawing commands, and the client renderer redraws them every time. That is why:

> `.fig` is not an "image file" — it is closer to the **"source code of a drawing program"**.

This is why the same .fig can look different depending on zoom, pan, dark mode, or which font fallback the host has.

---

## 6. What is *not* in the data chunk

| Item | Where it lives |
|---|---|
| Image pixels (PNG/JPG bytes) | Separate blob store / `images/` folder of the `.make` ZIP / Figma servers |
| Font glyphs (actual font files) | OS / Google Fonts / Figma font server. Only the name is stored |
| Resolved vector path | Inside `commandsBlob`, in yet another layer of packed binary |
| Collaboration history, comments | Figma server-side, Postgres + DynamoDB |
| Hover / selection state | Runtime-only, not stored |
| Derived values like `absoluteRenderBounds` | Computed at runtime, only exposed by the plugin API |
| Preview thumbnail | Separate chunk (chunk[2]) |

This separation overlaps exactly with the "out of scope" items in audit-oracle spec §7.1 — *they are either outside the .fig file's scope or inside binary blobs beyond the schema's view*.

---

## 7. The complete decode pipeline (recap)

```javascript
async function decodeFigFile(bytes) {
  // ─── Layer 1: container parsing ───
  const magic = readBytes(bytes, 0, 8);          // "fig-kiwi"
  if (toString(magic) !== "fig-kiwi") throw "not a .fig";
  const version = readUint32LE(bytes, 8);

  let offset = 12;
  const chunks = [];
  while (offset < bytes.length) {
    const len = readUint32LE(bytes, offset); offset += 4;
    chunks.push(bytes.slice(offset, offset + len)); offset += len;
  }

  // ─── Layer 2: schema decode ───
  const rawSchema = decompress(chunks[0]);       // pako or zstd
  const schema = decodeBinarySchema(rawSchema);  // ~558 definitions

  // ─── Layer 3: data decode ───
  const rawData = decompress(chunks[1]);
  const rootDef = schema.definitions.find(d => d.name === "Message");
  const message = decodeMessage(rawData, rootDef, schema);

  // ─── Optional: preview ───
  const preview = chunks[2];                     // PNG bytes (when present)

  return { version, schema, message, preview };
}
```

### Building the node tree from the result

```javascript
// nodeChanges is a flat array → reconstruct it into a tree
const byId = new Map();
for (const node of message.nodeChanges) {
  byId.set(`${node.guid.sessionID}:${node.guid.localID}`, node);
}

for (const node of message.nodeChanges) {
  const parentKey = node.parentIndex
    ? `${node.parentIndex.guid.sessionID}:${node.parentIndex.guid.localID}`
    : null;
  const parent = parentKey ? byId.get(parentKey) : null;
  if (parent) (parent.children ??= []).push(node);
}

// sort siblings by fractional index
for (const node of byId.values()) {
  node.children?.sort((a, b) =>
    a.parentIndex.position < b.parentIndex.position ? -1 : 1
  );
}
```

This tree is exactly what you see in the left Layers panel of Figma.

---

## Appendix A: Major node types (kiwi's `type` enum)

| kiwi name | Plugin/REST name | Notes |
|---|---|---|
| `DOCUMENT` | `DOCUMENT` | top-level root |
| `CANVAS` | `PAGE` | each page |
| `FRAME` | `FRAME` or `GROUP` | becomes GROUP when `resizeToFit=true` + empty fillPaints |
| `RECTANGLE` | `RECTANGLE` | |
| `ROUNDED_RECTANGLE` | `RECTANGLE` | variant with corner-radius |
| `ELLIPSE` | `ELLIPSE` | |
| `LINE` | `LINE` | |
| `VECTOR` | `VECTOR` | path data lives in `commandsBlob` |
| `STAR`, `REGULAR_POLYGON` | same | |
| `TEXT` | `TEXT` | characters + style in `textData` |
| `SYMBOL` | `COMPONENT` | component master |
| `INSTANCE` | `INSTANCE` | component instance |
| `BOOLEAN_OPERATION` | `BOOLEAN_OPERATION` | union/subtract/intersect/exclude |
| `SLICE` | `SLICE` | export region |
| `STICKY` | `STICKY` | FigJam sticky note |
| `VARIABLE` / `VARIABLE_SET` | (exposed outside the tree) | plugin/REST does not show them as children |

---

## Appendix B: Frequently used STRUCTs

```
STRUCT GUID         { uint sessionID; uint localID; }
STRUCT Vector       { float x; float y; }
STRUCT Color        { float r; float g; float b; float a; }
STRUCT Matrix       { float m00; float m01; float m02;
                      float m10; float m11; float m12; }
STRUCT ParentIndex  { GUID guid; string position; }   // position = fractional
```

Because **every field is always present and encoded in definition order**, these STRUCTs are the most compact region on the wire. The downside is that once a STRUCT has been used, no new fields can be added — a constraint point in schema evolution.

---

## Appendix C: References

- [evanw/kiwi](https://github.com/evanw/kiwi) — kiwi binary format home
- [evanw/kiwi/js/binary.ts](https://github.com/evanw/kiwi/blob/master/js/binary.ts) — canonical implementation of `decodeBinarySchema`
- [madebyevan.com/figma/fig-file-parser](https://madebyevan.com/figma/fig-file-parser/) — Evan's own .fig parser (browser)
- [fig-kiwi (npm)](https://www.npmjs.com/package/fig-kiwi) — `readFigFile` / `writeFigFile`
- [allan-simon/figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol) — recent reverse-engineering that goes as far as WebSocket frames

> **Note**: The kiwi schema (`~558 types`) is an internal format Figma may change at will. Even if the schema evolves, wire-level forward compatibility is preserved, but *code that depends on names* may break. The `VALUE_ALIASES` in audit-oracle is exactly that patch layer.
