# Audit-bvp — non-metarich corpus workflow

This is the second audit corpus (round 29 onwards), built parallel to
`docs/audit-round11/` via the multi-corpus support that round 29 added
to the existing audit scripts.

| 항목 | 값 |
|---|---|
| Source `.fig` | `docs/bvp.fig` |
| Output root | `docs/audit-bvp/` |
| Total nodes | 3,155 (cf. metarich 35,660) |
| Visible pages | 2 (`example page`, `design system`) |
| Audit captures | 60 (`example page` 27 + `design system` 33) + 2 page overviews |
| Status | round-29 setup-only landing — `ours.png` captured, `figma.png` pending user fetch |

## Folder structure

```
docs/audit-bvp/
  _INVENTORY.md          ← human-readable inventory
  _INVENTORY.json        ← machine-readable
  WORKFLOW.md            ← (this file)
  example-page/
    _overview/
      ours.png           ← ✅ auto-captured
      figma.png          ← ⏳ user provides (see "Step 3" below)
    <slug>/
      ours.png
      figma.png
  design-system/
    _overview/
      ours.png
    <slug>/
      ours.png
```

## Multi-corpus environment variables

The three audit scripts now accept env-var overrides (round 29). Default
behavior preserves metarich (`docs/audit-round11/`).

| variable | meaning | default |
|---|---|---|
| `AUDIT_FIG_PATH` | repo-relative or absolute `.fig` path | `docs/메타리치 화면 UI Design.fig` |
| `AUDIT_OUT_ROOT` | output directory for inventory + per-slug folders | `docs/audit-round11` |
| `AUDIT_CORPUS_NAME` | short label used in `_INVENTORY.md` heading | `Round 11` |
| `AUDIT_FILE_KEY_ENV` | name of the `.env.local` var holding this corpus's Figma file key (used by `figma-fetch.mjs`) | `FIGMA_FILE_KEY` |

## Steps to add or refresh the bvp corpus

### Step 1. Build inventory (`_INVENTORY.{json,md}`)

Pre-req: dev server up at `:5274`.

```bash
AUDIT_FIG_PATH=docs/bvp.fig \
AUDIT_OUT_ROOT=docs/audit-bvp \
AUDIT_CORPUS_NAME="BVP" \
node web/scripts/build-audit-inventory.mjs
```

Already done as part of round-29 setup. Re-run only if `bvp.fig` content
changes.

### Step 2. Capture `ours.png` for every slug

Pre-req: dev server up at `:5273` + `:5274`.

```bash
AUDIT_FIG_PATH=docs/bvp.fig \
AUDIT_OUT_ROOT=docs/audit-bvp \
node web/scripts/audit-round11-screenshots.mjs            # all pages
node web/scripts/audit-round11-screenshots.mjs design-system   # one page only
```

Already done as part of round-29 setup. Re-run after each renderer
change to detect deltas.

### Step 3. Fetch `figma.png` for every slug (Figma REST API)

Pre-req: add to `.env.local`:

```
FIGMA_TOKEN=figd_...                                  # already present (shared)
FIGMA_FILE_KEY_BVP=<the bvp file's key from its Figma URL>
```

The file key is the `<KEY>` segment in `https://www.figma.com/file/<KEY>/...`.

```bash
AUDIT_OUT_ROOT=docs/audit-bvp \
AUDIT_FILE_KEY_ENV=FIGMA_FILE_KEY_BVP \
node web/scripts/figma-fetch.mjs                # all pages
node web/scripts/figma-fetch.mjs design-system  # one page only
```

The script batches node IDs in groups of 15 and writes
`<slug>/figma.png` for every inventory entry. Page overviews are also
fetched at scale 1 and saved as `<page>/_overview/figma.png`.

If `FIGMA_FILE_KEY_BVP` is not yet available, this step can be deferred —
`figma.png` files can be added manually later.

### Step 4. Visual diff

Compare each `<slug>/ours.png` against its `<slug>/figma.png`. Any
systematic gap discovered here can be addressed in a follow-up round
(e.g. round 30+) by extending the renderer.

For the metarich corpus, this is documented per round in
`docs/audit-round11/GAPS.md`. The bvp corpus's gap log lives in
`docs/audit-bvp/GAPS.md` (created when the first gap is filed).

## Comparison with metarich

| 항목 | metarich (`audit-round11`) | bvp (`audit-bvp`) |
|---|---:|---:|
| Total nodes | 35,660 | 3,155 |
| Visible pages | 5 | 2 |
| INSTANCEs | ~6,000 | 247 |
| SYMBOLs | ~600 | 225 |
| Audit captures | 749 | 62 |

bvp is roughly 9× smaller. First non-metarich corpus serves as a
*generalization probe* — patterns that differ from metarich's are likely
to surface unhandled wire-format / pipeline edge cases.

## Round 29 status

- ✅ Multi-corpus support added to `build-audit-inventory.mjs`,
  `audit-round11-screenshots.mjs`, `figma-fetch.mjs`.
- ✅ `_INVENTORY.{json,md}` built (60 captures).
- ✅ `ours.png` captured for all 62 entries.
- ⏳ `figma.png` pending — user adds `FIGMA_FILE_KEY_BVP` to `.env.local`
  and runs Step 3.
- ⏳ Visual diff + first gap-log entries are round 30+ work.
