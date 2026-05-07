# Building a round-trip-safe parser: byte vs semantic vs JSON modes

*The four ways a parser can lie to you, and how to build one that doesn't.*

---

A parser that only goes one way is a black hole for data. Decode a `.fig`, edit a value, want to send it back to a designer? You can't. Most format parsers I've used — including a few in the Figma OSS ecosystem — quietly drop fields, coerce types, or mangle precision and only tell you in a stack trace six months later.

This is the third in a series on reverse-engineering Figma's `.fig` format ([article 1: the format](./01-how-figma-stores-your-design-files.md), [article 2: the compression mix-up](./02-two-tiered-compression-mystery.md)). It's the one I've been wanting to write the most: how to build a parser that's *honest* about what it can and can't promise on the way back.

> **TL;DR** — There are three useful modes for going `.fig → … → .fig` and one trap. **Byte** repack returns the original bytes verbatim (great for backup). **Kiwi** repack re-encodes the binary (great for deterministic rebuilds). **JSON** repack picks up your edits (the only mode that does). The trap: a normal `JSON.stringify` round-trip silently drops `Uint8Array`, `NaN`, `Infinity`, and `BigInt` — you have to tag them or lose them.

## The four ways a parser can lie

Before talking about *how* to build a round-trip-safe parser, let's enumerate what *unsafe* looks like. There are exactly four:

**1. Silent type coercion.** `JSON.stringify(NaN)` returns `"null"`. `JSON.stringify(new Uint8Array([1,2,3]))` returns `"{}"`. Your edit went out, no exception was thrown, but the value is **gone**.

**2. Field drop.** Your parser doesn't know about `componentPropDefs` or `derivedSymbolData` or some new field Figma added last quarter, so it doesn't include them in its `NodeChange` type. Encode time: those fields are missing from the output.

**3. Schema mismatch.** Figma ships the schema *inside* the file. Your parser used the schema from a six-month-old fixture. New file has 580 types, your hardcoded enum has 568. New enum value comes back as `null`.

**4. Precision drift.** Your `.toFixed(5)` looked harmless. Then a designer's vector node had a control point at `123.45678901`. Now their curve is subtly different.

A round-trip-safe parser has explicit defenses against all four. The first three are about **architecture** (where the schema lives, how strict your types are). The fourth is about **discipline** (don't truncate floats, ever).

## Three equality strengths

When a parser claims "round-trip," the next question must be "round-trip *equal under what definition*." [figma-reverse](https://github.com/showjihyun/figmatojson) commits to three (and only three) equality tiers:

| Tier | Meaning | Repack mode |
|---|---|---|
| **byte-identical** | Output bytes equal input bytes, hash for hash | Byte Repack |
| **semantically equivalent** | Same node count, same schema, same archive version, same effective tree | Kiwi Repack, JSON Repack |
| **lossy** | Fields silently dropped or reshaped | **No mode allowed** |

That third row is a contract, not a description. If a future change to the parser would introduce a lossy mode, the merge gets blocked. The reasoning is in the project's [ADR-0002](https://github.com/showjihyun/figmatojson/blob/main/docs/adr/0002-roundtrip-equality-tiers.md): *some lies are worse than others, but a parser that lies about round-trip is not a parser, it's a converter.*

Let me walk through each mode.

## Byte Repack — for backups

The simplest and the strongest. Take the unzipped container files (`canvas.fig`, `meta.json`, `images/<hash>`, `thumbnail.png`), put them back in a ZIP STORE archive, you're done. The output is **byte-identical** to the input. Hash them, they match.

```ts
// Simplified — see src/repack.ts
function repackByteLevel(extractedDir: string, outFile: string) {
  const zip = new AdmZip();
  zip.addLocalFile(`${extractedDir}/01_container/canvas.fig`);
  zip.addLocalFile(`${extractedDir}/01_container/meta.json`);
  zip.addLocalFile(`${extractedDir}/01_container/thumbnail.png`);
  for (const img of readdirSync(`${extractedDir}/01_container/images/`)) {
    zip.addLocalFile(`${extractedDir}/01_container/images/${img}`);
  }
  // STORE mode (no compression) — Figma's wire format
  zip.writeZip(outFile, { compressionMethod: 0 });
}
```

When does this matter? **Backups, archival, and git-LFS-style versioning**. You want to know that the artifact you're storing is exactly what came out of Figma — no parser drift, no schema upgrade rewriting fields. Byte Repack lets you assert that with `sha256sum`.

It cannot, by definition, incorporate edits. The bytes don't change. If you want edits, you need…

## Kiwi Repack — for deterministic re-encoding

Take the *decompressed* schema and data buffers (`extracted/03_decompressed/`), kiwi-decode them, kiwi-re-encode them, deflate-raw the result, write a fig-kiwi archive, ZIP STORE wrap.

```ts
function repackKiwi(extractedDir: string, outFile: string) {
  const schemaBytes = readFileSync(`${extractedDir}/03_decompressed/schema.kiwi.bin`);
  const dataBytes   = readFileSync(`${extractedDir}/03_decompressed/data.kiwi.bin`);

  const schema   = kiwi.decodeBinarySchema(schemaBytes);
  const compiled = kiwi.compileSchema(schema);
  const message  = compiled.decodeMessage(dataBytes);

  // Re-encode through the same compiled schema (proves codec is round-trip-stable)
  const reEncoded = compiled.encodeMessage(message);
  assert(bytesEqual(reEncoded, dataBytes));   // V-02 invariant

  // Build a fresh archive with the same chunks, both deflate-raw
  const archive = makeFigArchive(version, [
    pako.deflateRaw(schemaBytes),
    pako.deflateRaw(reEncoded),
  ]);
  writeZipStore(outFile, archive);
}
```

The output is **not** byte-identical (we lost the original zstd compression on the data chunk — `fzstd` is decode-only, see [article 2](./02-two-tiered-compression-mystery.md)) but it's **semantically equivalent**: same 568 type definitions, same 35,660 nodes, same archive version, same effective tree.

When does this matter? **As a sanity check.** If Kiwi Repack ever produces a different node count, or a different schema definition count, or breaks the `compiled.decodeMessage(reEncoded)` invariant, your parser has a bug *somewhere upstream*. It's a circular check that catches drift early.

It also cannot incorporate edits — the input is the binary blob, not a JSON tree. For that you need…

## JSON Repack — the only mode that picks up edits

Edit `extracted/04_decoded/message.json` with anything you like — `jq`, `vim`, an LLM. Pipe it back through Kiwi via the same compiled schema, and out comes a fresh `data.kiwi.bin`. ZIP it up.

```ts
function repackFromJson(messageJsonPath: string, schemaBytes: Uint8Array, outFile: string) {
  const message  = parseJsonWithTags(readFileSync(messageJsonPath));    // ← see below
  const schema   = kiwi.decodeBinarySchema(schemaBytes);
  const compiled = kiwi.compileSchema(schema);
  const dataBytes = compiled.encodeMessage(message);
  // …deflate-raw → ZIP STORE
}
```

The catch is `parseJsonWithTags`. Plain `JSON.parse` followed by `kiwi.encodeMessage` will fail or silently mangle several types. Specifically four:

```ts
new Uint8Array([1,2,3])  →  JSON.stringify  →  "{}"            ✗ data lost
NaN                      →  JSON.stringify  →  "null"          ✗ NaN lost
Infinity                 →  JSON.stringify  →  "null"          ✗ Infinity lost
123n                     →  JSON.stringify  →  TypeError       ✗ throw
```

Each shows up in real `.fig` data:

- **`Uint8Array`** is how Kiwi encodes the `bytes` field — used for image hashes, raw blob references, and (notably) the per-page `commandsBlob` for vector paths.
- **`NaN`** is *deliberately* used by Kiwi as the unset-default for some `float` fields (e.g. `stackSpacing` when auto-layout is off). Replacing it with `null` makes the encoder reject the message.
- **`Infinity`** is used as `paragraphSpacing` for "no limit" in some text setups.
- **`bigint`** appears in numeric IDs that exceed 2^53.

The fix is to **tag** them at serialize time and **untag** at parse time:

```ts
const TAG = (kind: string, value: string) => ({ [`__${kind}`]: value });

function replacer(key: string, value: any) {
  if (value instanceof Uint8Array)  return TAG('bytes', toBase64(value));
  if (typeof value === 'bigint')    return TAG('bigint', value.toString());
  if (typeof value === 'number') {
    if (Number.isNaN(value))        return TAG('num', 'NaN');
    if (!Number.isFinite(value))    return TAG('num', value > 0 ? 'Infinity' : '-Infinity');
  }
  return value;
}

function reviver(key: string, value: any) {
  if (value && typeof value === 'object') {
    if ('__bytes' in value)  return fromBase64(value.__bytes);
    if ('__bigint' in value) return BigInt(value.__bigint);
    if ('__num' in value) {
      if (value.__num === 'NaN')        return NaN;
      if (value.__num === 'Infinity')   return Infinity;
      if (value.__num === '-Infinity')  return -Infinity;
    }
  }
  return value;
}

const json    = JSON.stringify(message, replacer, 2);
const restore = JSON.parse(json, reviver);
```

Round-trip is now lossless. The tags are unobtrusive — readable JSON, no impact on grep, no breaking jq:

```jsonc
{
  "blobs": [{ "bytes": { "__bytes": "iVBORw0KGgoAAAA..." } }],
  "stackSpacing": { "__num": "NaN" },
  "publishID": { "__bigint": "9223372036854775807" }
}
```

Edit anything else freely. The encoder will reject your changes if you violate the schema (e.g. set `type` to a string the schema doesn't define), which is the right behavior — better a hard failure than silent corruption.

## The verification harness

A parser that *claims* round-trip safety is worth nothing without a regression test that *enforces* it. figma-reverse's V-02 invariant runs on every test:

```ts
test('byte round-trip: extract → repack --mode byte → re-extract', async () => {
  const orig = readFileSync('docs/bvp.fig');
  await extract('docs/bvp.fig', 'output/bvp');
  await repack('output/extracted/bvp', 'tmp/round-trip.fig', { mode: 'byte' });
  const re = readFileSync('tmp/round-trip.fig');
  // Inner canvas.fig must be byte-identical (the outer ZIP order may differ)
  expect(extractCanvas(re)).toEqual(extractCanvas(orig));
});

test('json round-trip: tags survive', async () => {
  const message = await decodeFig('docs/bvp.fig');
  const json    = JSON.stringify(message, replacer);
  const restore = JSON.parse(json, reviver);
  expect(deepEqual(message, restore)).toBe(true);
});
```

162 tests in the main project, 622 in the web editor, all running on every commit. The harness is documented in [`docs/HARNESS.md`](https://github.com/showjihyun/figmatojson/blob/main/docs/HARNESS.md) — five layers from per-module units up to manual Figma desktop import.

## When each mode is the right answer

The choice is mostly about *what your input is*:

- You have a `.fig` file you want to preserve unchanged → **Byte Repack**
- You have an `extracted/03_decompressed/` directory and want to confirm your codec is reversible → **Kiwi Repack**
- You have an `extracted/04_decoded/message.json` that you (or a script, or an LLM) edited → **JSON Repack**

A common mistake I made early: trying to use Kiwi Repack to incorporate edits. It can't — the input is the binary, edits don't propagate. JSON Repack is the only mode wired to user changes. If your workflow involves editing, your pipeline needs to fork at decode time:

```
.fig
 ↓ (extract --include-raw-message)
04_decoded/message.json   ← edit here
 ↓ (repack --mode json)
out.fig
```

The `--include-raw-message` flag is opt-in because the JSON is large (~150 MB on a 35K-node file). Edits don't need the whole tree — most of the time, you can extract specific fields, edit them, and patch them back via a smaller diff. The web editor's PATCH endpoint (`web/server/adapters/driving/http/docRoute.ts`) does exactly this: a single field change → in-memory message patch → `compiled.encodeMessage(patched)` → ZIP STORE.

## What's left

There are two open round-trip questions I haven't fully answered:

**1. Image bytes survive but image *encoding* doesn't.** If your edit involves replacing an image, the new bytes go in the `images/<sha1>` ZIP entry. But Figma's optimizer might re-encode them on next open (PNG → WebP, JPEG quality bump). I haven't tested whether Figma desktop accepts a JSON-Repacked file with a swapped image without complaining. If you have, please [file an issue](https://github.com/showjihyun/figmatojson/issues).

**2. Vector geometry edits.** The `commandsBlob` for vector paths is a separate binary blob referenced by index. Editing the JSON-decoded blob list is easy; getting Figma to *use* the new geometry on import requires the right blob alignment. There's a v1 limitation logged in [`docs/specs/vector-decode.spec.md`](https://github.com/showjihyun/figmatojson/blob/main/docs/specs/vector-decode.spec.md) about this.

Both are open work. Both are good places for a contributor to dive in.

## Try it

```bash
git clone https://github.com/showjihyun/figmatojson.git
cd figmatojson && npm install

# Byte round-trip
npx tsx src/cli.ts extract docs/bvp.fig
npx tsx src/cli.ts repack output/extracted/bvp /tmp/byte.fig --mode byte
sha256sum docs/bvp.fig /tmp/byte.fig    # match (inner canvas.fig)

# JSON round-trip — edit a value
npx tsx src/cli.ts extract docs/bvp.fig --include-raw-message
# … edit output/extracted/bvp/04_decoded/message.json …
npx tsx src/cli.ts repack output/extracted/bvp /tmp/edited.fig --mode json
```

That's the full loop. Decode, edit, encode, validate, repeat.

## Wrapping up the series

This series traced one closed binary format from the bytes on disk ([article 1](./01-how-figma-stores-your-design-files.md)) to a working round-trip parser ([this article](#)) — including the one-byte sniff that makes [the compression auto-detect](./02-two-tiered-compression-mystery.md) cleanly handle modern files. The whole codebase is on GitHub:

**[github.com/showjihyun/figmatojson](https://github.com/showjihyun/figmatojson)** — TypeScript, MIT, 784 tests, 60+ specs, single-file bilingual developer guide at [`docs/dev-guide.html`](https://github.com/showjihyun/figmatojson/blob/main/docs/dev-guide.html).

⭐ If you read all three articles and any of it was useful, please give the repo a star. It's the only signal I have that the time-on-edge-cases (variants, instance overrides, vector geometry) is worth more.

Comments / questions / `.fig` files that break the parser → [issues welcome](https://github.com/showjihyun/figmatojson/issues).
