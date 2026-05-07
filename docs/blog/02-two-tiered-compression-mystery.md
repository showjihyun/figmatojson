# The two-tiered compression mystery in Figma's `.fig` format

*Why one chunk is deflate-raw and the other is zstd, and how a one-byte sniff fixes a lot of broken parsers.*

---

I was deep into reverse-engineering a Figma `.fig` file (the back-story is in [article 1 of this series](./01-how-figma-stores-your-design-files.md)) when I hit a wall. I'd unwrapped the ZIP, found `canvas.fig` inside, parsed the `fig-kiwi` header, split out the two compressed chunks. The first one decompressed cleanly. The second one decompressed to garbage. Always.

This is the story of why, what to do about it, and why it matters more than it looks.

> **TL;DR** — Modern Figma exports compress the schema chunk with **deflate-raw** and the data chunk with **zstd**. Same file. Two algorithms. Auto-detect from the magic byte; don't trust libraries that hardcode either one.

## The setup

`canvas.fig` (the binary inside Figma's ZIP-wrapped `.fig`) is in a format called fig-kiwi. After the header, there are exactly two chunks, in this order:

```
[8 bytes  ] "fig-kiwi" magic
[4 bytes  ] version (LE uint32)
[4 bytes  ] chunk[0].size              ← schema chunk size
[N bytes  ] chunk[0].data              ← compressed schema
[4 bytes  ] chunk[1].size              ← data chunk size
[N bytes  ] chunk[1].data              ← compressed message
```

The schema chunk holds 568 binary [Kiwi](https://github.com/evanw/kiwi) type definitions. The data chunk holds the actual message — your design — encoded against those definitions.

If you grab the [`fig-kiwi`](https://www.npmjs.com/package/fig-kiwi) npm package, plug both chunks through `pako.inflateRaw`, and decode through Kiwi, you get… well, sometimes you get a tree, sometimes you get nothing, depending on which `.fig` you tested with. That inconsistency is what cost me an evening.

## The byte that solves it

The fix is hilariously simple once you see it. The first four bytes of each compressed chunk give the algorithm away:

| Magic bytes | Algorithm |
|---|---|
| `28 B5 2F FD` | **zstd** (Facebook's modern compressor) |
| `78 01` / `78 9C` / `78 DA` | **deflate-zlib** (zlib-wrapped deflate) |
| anything else | **deflate-raw** (RFC 1951, no wrapper) |

Run that on a real export:

```bash
$ xxd -l 4 chunks/00_schema.bin
00000000: 78 da 4c c7 ...                          x.L...      # deflate-zlib

$ xxd -l 4 chunks/01_data.bin
00000000: 28 b5 2f fd ...                          (./...      # zstd
```

There it is. Schema and data are **compressed by different algorithms** in the same file. In the figma-reverse codebase, the dispatcher fits in eight lines:

```ts
function detectCompression(buf: Uint8Array): Compression {
  if (startsWith(buf, [0x28, 0xB5, 0x2F, 0xFD])) return 'zstd';
  if (buf[0] === 0x78) return 'deflate-zlib';
  return 'deflate-raw';
}

function decompress(buf: Uint8Array): Uint8Array {
  const algo = detectCompression(buf);
  if (algo === 'zstd')          return fzstd.decompress(buf);
  if (algo === 'deflate-zlib')  return pako.inflate(buf);
  return pako.inflateRaw(buf);
}
```

For the schema chunk this almost always falls into the `deflate-zlib` (`78 xx`) branch. For the data chunk it almost always falls into `zstd`. But hardcoding either side breaks on outliers — older `.fig` files I've tested have both chunks in deflate-raw with no zlib prefix. Auto-detect or break.

## Why two algorithms?

I'd love to say "Figma did this on purpose," but I think it's an artifact of **how the format evolved**. A few signals:

**The schema is small (~26 KB compressed) and rarely changes.** A schema chunk is just type definitions — `NodeChange { guid: GUID, ... }`, etc. Old-school deflate gives you the best ratio per byte for tiny static data, especially when zlib's own dictionary preamble already contains the right Huffman tables.

**The data chunk is huge (~3.8 MB compressed → ~20 MB raw).** Real designs hit megabytes fast — a typical mid-sized file in my fixtures has 35,660 nodes. zstd gives roughly 30% better compression than deflate at the same speed, and 5–10× the *decompression* speed. For Figma's cloud — where every team load means decompressing the saved canvas — that 5–10× decode speed is real money on the bandwidth and CPU bills.

**Why mix and not just zstd everything?** I suspect backwards compatibility. Older Figma versions could only decode deflate. The schema chunk is what tells the client "here's what node types this file uses" — if that doesn't decode, nothing else does. So the schema chunk stays on the lowest-common-denominator algorithm. The data chunk got upgraded to zstd at some point (probably when Figma adopted zstd internally — `28 B5 2F FD` shows up around 2020 in Facebook's ecosystem), and old clients that can't decode it just refuse to open the file. Forward-compatible by version-bump, not by mixed-algorithm fallback.

It's not the cleanest design. But it makes sense if you assume a 10-year-old format that's been incrementally extended in a backwards-compatible-ish way.

## Why this breaks existing parsers

Most of the OSS `.fig` parsers I found assume **single-algorithm**. They pick deflate (because that's what the Kiwi reference implementations use) or they pick zstd (because that's what Figma ships now), and they get half the file right and half wrong.

The `fig-kiwi` npm package picks deflate-raw for both chunks. Plug in a 2024 `.fig` and the data chunk explodes:

```
Error: incorrect header check
  at module.exports.Inflate.push (pako/lib/inflate.js:201)
  at inflate (fig-kiwi/dist/kiwi.cjs.js:42)
```

Other parsers I tested fall back to *trying both algorithms* — start with deflate, if that throws, try zstd. That works but it's slow (you wait for a zstd magic-byte mismatch to bubble up as an exception) and it hides bugs (a corrupted deflate stream might decode to *some* bytes before zstd would have caught it as a magic mismatch).

Magic-byte detection is the right answer. Five-line function. Zero ambiguity.

## Verification

Here's the kind of round-trip check you want, and what it looks like in figma-reverse's `verify.ts`:

```ts
// V-07 — Kiwi schema sanity
{
  const schemaBytes = decompress(archive.chunks[0]);
  const schema      = kiwi.decodeBinarySchema(schemaBytes);
  const reEncoded   = kiwi.encodeBinarySchema(schema);
  assert(bytesEqual(schemaBytes, reEncoded));   // schema decode is byte-stable
  assert(schema.definitions.length === 568);    // 568 types in modern exports
}

// V-02 — full data round-trip
{
  const dataBytes = decompress(archive.chunks[1]);
  const message   = compiled.decodeMessage(dataBytes);
  const reEncoded = compiled.encodeMessage(message);
  assert(bytesEqual(dataBytes, reEncoded));     // decoder is reversible
}
```

After fixing the compression auto-detect, the assertions hold every time. 35,660 nodes round-trip byte-perfect through `decompress → decodeMessage → encodeMessage → original bytes`.

For verification run output:

```
🟢 V-07 Kiwi 스키마 sanity: definitions: 568, root type: ColorStopVar, archive v106,
                            compression: schema=deflate-zlib, data=zstd
🟢 V-02 디코딩 round-trip: schema bytes match: true (66133 vs 66133).
                           re-encoded message: 9282747 bytes (orig data 9282747).
```

This single check is the hill that round-trip safety dies on. If the bytes don't match here, every downstream guarantee (byte-identical repack, JSON edit-and-rebuild, …) collapses.

## What this means for a parser

If you're writing one — for the love of bytes, **don't hardcode the algorithm**. Three rules:

1. **Read the magic byte before decompressing.** It costs nothing.
2. **Treat both algorithms as first-class.** Don't make zstd a "fallback when deflate fails." Branch cleanly on the magic.
3. **Carry the detected algorithm in your stage-3 output.** When you re-encode (round-trip), you want the *original* algorithm back, not whatever your library defaults to. figma-reverse stores `schemaCompression` and `dataCompression` strings on its `DecodedFig` object precisely so the reverse direction can match.

In figma-reverse, all of this lives in 50 lines of `src/decompress.ts`. Five line dispatcher, one line per algorithm, plus the `Compression` type that propagates through every stage.

## What this *doesn't* explain

The two-algorithm split is the most visible weirdness, but `.fig` has a few more lurking quirks I won't get into here:

- **Vector path geometry** has its own opcode set with a 0x03=QUAD / 0x04=CUBIC mapping that's reversed from what a few public reverse-engineering writeups say. I verified it via round-trip; opcodes 3 and 4 in the wire are confirmed quadratic / cubic (not the other way around).
- **The flat node array uses fractional-index strings** (CRDT-style) for sibling order — covered in [article 1](./01-how-figma-stores-your-design-files.md).
- **Two raw-bytes-vs-Uint8Array gotchas** in `JSON.stringify` — covered in [article 3](./03-round-trip-safe-parser.md).

But the compression mystery is the one most likely to silently destroy your weekend. Hopefully now it won't.

## Try it

```bash
git clone https://github.com/showjihyun/figmatojson.git
cd figmatojson && npm install
npx tsx src/cli.ts extract docs/bvp.fig
ls output/extracted/bvp/02_archive/chunks/    # both compressed chunks
ls output/extracted/bvp/03_decompressed/      # both decompressed
```

The decompression details (algorithm per chunk + sizes) end up in the `verification_report.md` next to the output. Diff against your own real `.fig` to confirm the mix.

⭐ Star [the repo](https://github.com/showjihyun/figmatojson) if this saved you a debugging afternoon. The two-tiered compression alone took me a day to chase down.

## Up next

[Article 3 — Building a round-trip-safe parser: byte vs semantic vs JSON modes](./03-round-trip-safe-parser.md) — once you can decode the file, can you write it back? Three answers, three equality strengths, and the JSON tags that keep `Uint8Array` from disappearing on the way through.
