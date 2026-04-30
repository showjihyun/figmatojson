# Pen IDs are page-seeded base62 5-char strings, not Figma GUIDs

`Pen Node` `id` fields in `.pen` and `.pen.json` are five-character base62 strings (`[0-9A-Za-z]{5}`) generated as `SHA-256(pageGUID + "|" + sourceFigSha256 + ":" + counter) → first 5 bytes mod 62`, deduplicated against a `globalUsedIds` Set shared across all Pages in one export run. The original `GUID` (or INSTANCE-`Expansion Path`) is preserved per-Pen-ID in `.pen.json`'s `__figma.idMap`.

We rejected three obvious alternatives:

1. **Use the Figma `GUID` directly (e.g. `11:580`).** pencil.dev rejects identifiers containing `:` or `/`. Non-starter.
2. **Sequential per-page counter (`00000`, `00001`, …).** Every `.pen` file then begins with the same id, and pencil.dev appears to use the first node's id as a file fingerprint — opening different files showed the same document. Caught by user during pencil.dev testing.
3. **Random UUIDs.** Non-deterministic; diff comparisons across export runs become useless and our regression tests can't pin expected values.

Page-seeding gives every Page a distinct ID distribution (rule against fingerprint collision). The shared `globalUsedIds` Set guarantees zero cross-Page collisions in one export run (`reassignPenIds` runs serially in Page order before parallelizing writes, so order is deterministic). The encoding itself stays inside the character set Pencil accepts.

## Consequences

- The mapping back to `GUID` lives only in `.pen.json` (`__figma.idMap`). Stripping `__figma` for pencil.dev import is intentional — Pencil's native `.pen` doesn't reserve a place for our extension.
- Changing the seed format (the string passed to SHA-256) reshuffles every ID. Don't.
- Editing `.pen.json` and round-tripping back to `.fig` is **not** supported — see the `Round-trip and Repack` section of `CONTEXT.md`. The idMap is `Provenance`, not `Round-trip`.
