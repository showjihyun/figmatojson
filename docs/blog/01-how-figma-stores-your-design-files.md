# How Figma stores your design files (and how to read them offline)

*A 5-minute tour from the bytes on disk to the 35,660-node tree your designer never sees.*

---

You hit **File → Save as `.fig`** in Figma. You drop the result on your desktop. Open it in your text editor and you get… a wall of garbage. Not even a recognizable header.

What's actually in there?

I spent a few weeks taking one apart, byte by byte, and built an open-source parser around it ([figma-reverse](https://github.com/showjihyun/figmatojson) — TypeScript, MIT, no Figma API). This post is the tour I wish someone had handed me when I started.

> **TL;DR** — A `.fig` file is a ZIP. Inside it lives `canvas.fig`, the actual binary, in a format called **fig-kiwi**. Decode it and you get 568 type definitions plus a flat array of 35,660 nodes. Walk the parents and you get the tree your designer was looking at.

Five layers, each with its own format:

```
.fig (ZIP)
  └── canvas.fig (fig-kiwi)
       └── chunks[0] = compressed schema
       └── chunks[1] = compressed message
                       (35,660 flat nodes)
                          ↓ link by parent GUID
                       Tree of pages → frames → leaves
```

Let's walk down.

## Layer 1 — The outer file is a ZIP

The first 4 bytes give it away:

```bash
$ xxd -l 4 design.fig
00000000: 504b 0304                                PK..
```

`50 4B 03 04` is the **PKZIP local file header** — every ZIP starts with it. Figma's `.fig` is, prosaically, a ZIP archive in **STORE mode** (no compression) with four entries:

```
design.fig (ZIP STORE)
├── canvas.fig          ← the real binary, more on this below
├── meta.json           ← file_name, background_color, exported_at
├── thumbnail.png       ← small preview
└── images/
    ├── <sha1-hash-1>   ← raw bytes, no extension
    ├── <sha1-hash-2>
    └── …
```

A surprise: the images have no file extension. They're keyed by SHA-1 hash because the same image (a PNG icon, say) might be referenced 50 times across your design. Deduplication for free. To recover the type, you sniff the magic byte: `89 50 4E 47` is PNG, `FF D8 FF` is JPEG, etc.

So far, nothing exotic. Standard ZIP, standard PNG.

## Layer 2 — `canvas.fig` is in fig-kiwi format

Open `canvas.fig` and you see an 8-byte ASCII string at offset 0:

```
00000000: 6669 672d 6b69 7769 6a00 0000 ...        fig-kiwij....
```

`fig-kiwi` is the magic. After it comes a 4-byte little-endian uint32 — the format version (`0x6a` = 106 in modern exports). Then come the chunks.

The structure is dead simple — like TLV without the T:

```
[8 bytes  ] "fig-kiwi" magic
[4 bytes  ] version (LE uint32)              ← 106
[4 bytes  ] chunk[0].size (LE uint32)
[N bytes  ] chunk[0].data
[4 bytes  ] chunk[1].size
[N bytes  ] chunk[1].data
```

Just two chunks. You'd think the first would be a header and the second the payload. Half right.

## Layer 3 — Two compressed blocks, two algorithms

This is where it got weird.

I assumed both chunks were compressed the same way. The existing OSS [`fig-kiwi`](https://www.npmjs.com/package/fig-kiwi) npm package assumes `deflate-raw`. I plugged it in, decoded chunk 0 — got something. Decoded chunk 1 — silent garbage.

Looked at the magic bytes:

```bash
$ xxd -l 4 chunk0.bin   # chunk 0
00000000: 78 da xx xx                           x...     # zlib's standard prefix

$ xxd -l 4 chunk1.bin   # chunk 1
00000000: 28 b5 2f fd                           (./.    # zstd's magic
```

**Chunk 1 is zstd.** Not deflate. Not gzip. Facebook's modern `zstd`. Most existing `.fig` parsers don't know.

I'll come back to *why* in [the next article](./02-two-tiered-compression-mystery.md), but for now: auto-detect the algorithm from the magic byte and fork. In figma-reverse:

```ts
function detectCompression(buf: Uint8Array): 'zstd' | 'deflate-zlib' | 'deflate-raw' {
  if (startsWith(buf, [0x28, 0xB5, 0x2F, 0xFD])) return 'zstd';
  if (buf[0] === 0x78) return 'deflate-zlib';
  return 'deflate-raw';
}
```

After decompression, chunk 0 is **64 KB of binary type definitions**. Chunk 1 is **20 MB of binary message data**, encoded against those definitions.

## Layer 4 — Kiwi: a self-describing binary schema

[Kiwi](https://github.com/evanw/kiwi) is a binary serialization format by Evan Wallace (one of Figma's founders). It's like Protocol Buffers, but the schema definitions ship inside the same stream as the data — perfect for clients that get pushed schema updates.

Decoded, chunk 0 contains **568 type definitions**:

```
NODE_CHANGES { nodeChanges: NodeChange[], blobs: Bytes[], ... }
NodeChange   { guid: GUID, type: NodeType, ... }
GUID         { sessionID: uint32, localID: uint32 }
Vector2      { x: float, y: float }
Transform    { m00, m01, m02, m10, m11, m12: float }
Paint        { type: PaintType, color: Color, opacity: float, ... }
... 562 more
```

In TypeScript, decoding a `.fig` is three lines once you've got the schema and data buffers:

```ts
const schema   = kiwi.decodeBinarySchema(schemaBytes);   // 568 type defs
const compiled = kiwi.compileSchema(schema);             // generate decoder class
const message  = compiled.decodeMessage(dataBytes);      // root: NODE_CHANGES
```

`message` is now a JavaScript object. Specifically, it has a `nodeChanges` property — an array. And here's the next surprise.

## Layer 5 — The "tree" is a flat array

`message.nodeChanges` is **flat**. For my test fixture (a real, mid-sized Figma file): **35,660 entries**. Not a tree. A list.

Each entry has a `parentIndex.guid` pointing at another node and a `parentIndex.position` string. Reconstruction is two passes:

```ts
// Pass 1: index every node by GUID
const allNodes = new Map();
for (const nc of message.nodeChanges) {
  allNodes.set(`${nc.guid.sessionID}:${nc.guid.localID}`, {
    ...nc, children: []
  });
}

// Pass 2: link children → parents, then sort siblings
let document = null;
for (const node of allNodes.values()) {
  const parent = allNodes.get(`${node.parentGuid.sessionID}:${node.parentGuid.localID}`);
  if (parent) parent.children.push(node);
  else if (node.type === 'DOCUMENT') document = node;
}

// Sort by parentIndex.position string (Figma's fractional indexing)
function sortChildren(n) {
  n.children.sort((a, b) => a.position < b.position ? -1 : 1);
  for (const c of n.children) sortChildren(c);
}
sortChildren(document);
```

Two oddities here:

**1. Why a flat array?** Because Figma's wire format is built for *streaming edits*. Every change a designer makes is a `NodeChange` record appended to a multiplayer message. The "saved file" is just the materialized end state of that stream.

**2. The sort key is a string.** `parentIndex.position` looks like `'~)Wxs'`, `'~)Wxs#'`, `'~)Wxs#0'`. That's [fractional indexing](https://news.ycombinator.com/item?id=16635440) — a string-based ordering that lets two clients insert between any two siblings without conflict. It's a CRDT trick, and it shows up because Figma is collaborative-first.

After sorting you finally have a tree:

```
DOCUMENT
├── CANVAS "Page 1"
│   ├── FRAME "Header"
│   │   ├── TEXT "logo"
│   │   └── …
│   └── FRAME "Body"
│       └── …
└── CANVAS "Page 2"
    └── …
```

The shape every designer recognizes. Six pages, hundreds of frames, thousands of leaves.

## What you can do with this

Once you have the tree in memory, you can:

- **Export to JSON** — `JSON.stringify(documentTree)` and you're done. Caveat: `Uint8Array` and `BigInt` need special encoding (see [article 3](./03-round-trip-safe-parser.md)).
- **Generate Pencil `.pen`** — Pencil.dev is an OSS Figma alternative; their `.pen` format is JSON-shaped, and the conversion is mostly a 1:1 type mapping plus visibility composition. figma-reverse ships a `pen-export` subcommand that does this in ~1.8 s for 35K nodes.
- **Build a RAG index** — flatten to per-page JSON (~140 KB per page in the sample), embed each page or each frame, and you can ask questions like "where does this button get its primary color from?" with grounded retrieval.
- **Edit and re-encode** — change a value in JSON, then re-pack via the kiwi codec → ZIP STORE → and you have a new `.fig` Figma will open. ([Article 3](./03-round-trip-safe-parser.md) has the details on what makes this round-trip-safe vs lossy.)

## Try it yourself

```bash
git clone https://github.com/showjihyun/figmatojson.git
cd figmatojson && npm install
npx tsx src/cli.ts extract docs/bvp.fig
cat output/bvp/verification_report.md
```

The repo has 162 unit tests covering every stage and a 5-layer harness ([`docs/HARNESS.md`](https://github.com/showjihyun/figmatojson/blob/main/docs/HARNESS.md)) that proves the round-trip equality. There's a single-file bilingual developer guide at [`docs/dev-guide.html`](https://github.com/showjihyun/figmatojson/blob/main/docs/dev-guide.html) with eight mermaid diagrams.

## Up next

This was the *what*. [Article 2 — The two-tiered compression mystery in Figma's `.fig` format](./02-two-tiered-compression-mystery.md) digs into *why* one of the two chunks is zstd and the other is deflate. (Hint: it's not a mistake.)

[Article 3 — Building a round-trip-safe parser](./03-round-trip-safe-parser.md) covers what it takes to go *back*: from a JSON tree to a byte-identical `.fig`, and what `Uint8Array` / `NaN` / `BigInt` do to your `JSON.stringify`.

---

⭐ If this saved you a Figma API headache or a few hours of binary archaeology, [give the repo a star](https://github.com/showjihyun/figmatojson). It's how I'll know whether to keep covering edge cases.
