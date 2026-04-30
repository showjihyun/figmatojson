---
name: figma-internals
description: Internal module APIs of figma-reverse for building new subcommands or pipelines that consume .fig data — the standard load/decode/tree sequence, intermediate dump options, async I/O conventions, and lossless JSON serialization tags. Use when adding a new CLI subcommand, writing a new exporter that needs the parsed Figma tree, modifying repack/extract internals, or designing JSON formats that must round-trip through .fig.
---

# figma-reverse internals

## Standard load → tree sequence

Every command that reads a `.fig` does this exact 3-step sequence. Reuse it:

```ts
import { loadContainer } from './container.js';
import { decodeFigCanvas } from './decoder.js';
import { buildTree } from './tree.js';
import { collectImageRefs } from './assets.js';   // optional, only if you need image deduplication

const container = loadContainer(inputFigPath);     // ZIP unwrap → canvas.fig + sidecars + images
const decoded   = decodeFigCanvas(container.canvasFig);  // fig-kiwi archive → schema + decoded message
const tree      = buildTree(decoded.message);      // KiwiNode[] → TreeNode tree (parent/child links)
const imageRefs = collectImageRefs(tree.document); // optional
```

Returns: `tree.document` (root TreeNode), `tree.allNodes` (Map<guidStr, TreeNode>), `tree.orphans`.

## Intermediate dumps (debugging breadcrumb trail)

`src/intermediate.ts` writes stages 01–05 to `extracted/<name>/`:

```ts
const intOpts = {
  enabled: true,
  dir: extractedDir,
  includeFullMessage: false,  // true → 04_decoded/message.json (~150 MB; needed for repack json mode)
  minify: true,
};
dumpStage1Container(intOpts, container);
dumpStage2Archive(intOpts, decoded.archive);
dumpStage3Decompressed(intOpts, decoded);
dumpStage4Decoded(intOpts, decoded);
dumpStage5Tree(intOpts, tree);
```

## Async I/O conventions (SPEC.md §7.5)

- Multi-file reads/writes go through `Promise.all` with `fs/promises.readFile / writeFile` — see `buildByteLevelFigBuffer` and `repackFromJson` for the pattern.
- CPU-heavy work (kiwi encode, pen tree convert, JSON.stringify) runs **synchronously** but should be sandwiched between awaits so I/O can interleave.
- For per-page work, prefer two phases: **(1) serial CPU pass** when ordering matters (e.g., shared `globalUsedIds` Set in pen-export), **(2) parallel I/O pass** via `Promise.all`.
- Never `readFileSync` / `writeFileSync` in new code unless inside synchronous helpers shared with old code.

## Lossless JSON ↔ kiwi round-trip tags

`intermediate.ts:roundTripReplacer` and `repack.ts:reviveBinary` are paired. Tags written by stringify, restored by parse:

| JS value | JSON form |
|---|---|
| `Uint8Array` | `{__bytes: "<base64>"}` |
| `bigint` | `{__bigint: "123"}` |
| `NaN` | `{__num: "NaN"}` |
| `±Infinity` | `{__num: "Infinity"}` / `{__num: "-Infinity"}` |

If you write a new JSON path that must round-trip through `kiwi.encodeMessage`, use these tags — plain `JSON.stringify` silently drops `NaN`/`Infinity` (→ `null`) and turns `Uint8Array` into a useless object map. The `repack --mode json` test (`test/e2e.test.ts`) is the regression guard.

## CLI plumbing patterns

`src/cli.ts` patterns to copy when adding a subcommand:

- Subcommand routing in `main()` checks `argv[0]`; backwards-compat falls through to `runExtract` if first arg ends in `.fig`.
- `figFileSlug(path)` produces a filesystem-safe name from a `.fig` path (Korean/spaces OK, control chars stripped).
- Every subcommand has its own `parseXxxArgs(args)` that handles `-h`/`--help`, validates positionals, then collects flags. Use `fatal(msg)` on errors.
- `formatBytes(n)` and `badge(status)` for consistent log output.

## Type roots

| File | What it defines |
|---|---|
| `src/types.ts` | `ContainerResult`, `FigArchive`, `TreeNode`, `BuildTreeResult`, `KiwiMessage`, `KiwiNode`, `GUID` |
| `src/decoder.ts` | `DecodedFig` (archive + schema + compiled + message + raw bytes + compression metadata) |
| `src/repack.ts` | `RepackMode = 'byte' \| 'kiwi' \| 'json'`, `RepackResult` |

## Test conventions

- `vitest run` — default; `pool: 'forks'`, `singleFork: true`, 60 s timeout (sample.fig is large).
- Synthetic trees for unit tests: `test/pen-export.test.ts` has `makeNode` / `buildTreeFrom` / `fakeDecoded` / `fakeContainer` helpers — reuse them for new exporter tests.
- E2E uses the real `docs/메타리치 화면 UI Design.fig` sample — stable expected counts: 35 660 nodes, 568 schema defs, archive v106, 6094 blobs.

## Related skills

- CLI usage → **figma-cli**
- `.pen` output specifics (Pencil ID rules, viewport, idMap) → **figma-pen-export**
