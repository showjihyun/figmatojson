---
name: figma-cli
description: Run the figma-reverse CLI commands to extract, repack, export .pen, generate HTML dashboards, and produce single-file editable HTML from .fig files. Use when invoking extract / repack / pen-export / html-report / editable-html, or when user asks how to convert a .fig file into JSON, .pen, or browsable HTML.
---

# figma-reverse CLI

## Quick start

```bash
# Full extract — produces output/<name>/ + extracted/<name>/
npx tsx src/cli.ts extract docs/design.fig

# Round-trip back to .fig
npx tsx src/cli.ts repack ./extracted/<name> ./out.fig --mode byte

# Pencil .pen + .pen.json (per Figma page)
npx tsx src/cli.ts pen-export docs/design.fig

# Browser dashboard (multi-file or single .html)
npx tsx src/cli.ts html-report ./extracted/<name> ./dashboard
npx tsx src/cli.ts html-report ./extracted/<name> ./out.html --single-file

# Editable HTML with embedded .fig (auto-runs extract if needed)
npx tsx src/cli.ts editable-html docs/design.fig --single-file
```

`-h` / `--help` on any subcommand for full options.

## Subcommand cheat sheet

| Command | Reads | Writes | Notes |
|---|---|---|---|
| `extract` | `<input.fig>` | `output/<name>/`, `extracted/<name>/` | `--no-document`, `--minify`, `--include-raw-message` (huge, needed for `repack --mode json`) |
| `repack` | `extracted/<name>/` | `<out.fig>` | `--mode byte\|kiwi\|json`, optional `--original <orig.fig>` for diff |
| `pen-export` | `<input.fig>` | `extracted/<name>/08_pen/*.pen{,.json}` | each Figma page → 2 files |
| `html-report` | `extracted/<name>/` + `output/<name>/` | `dashboard/` or `dashboard.html` | `--single-file` inlines all data, ~17–22 MB |
| `editable-html` | `<input.fig>` | `extracted/<name>/07_editable/figma.editable.html` | auto-extracts if needed; `--single-file` embeds .fig as base64 |

## Repack modes

- **byte** (default, safest): repacks `01_container/` files 1:1 into a ZIP STORE — canvas.fig is byte-identical to original. Use this unless you've edited something.
- **kiwi**: decode kiwi binary from `03_decompressed/` then re-encode (deflate-raw). Semantically equivalent, ~18 % size delta.
- **json**: read `04_decoded/message.json` (must extract with `--include-raw-message`), JSON-edit, re-encode. Lossless via `__bytes` / `__num` / `__bigint` tags. See `figma-pen-export` skill for the wider edit story.

## Output layout

```
output/<name>/        # PRD-shaped JSON (consumer-friendly)
  document.json       (omit with --no-document)
  pages/<n>_<name>.json
  assets/{images,vectors}/
  manifest.json, metadata.json, schema.json, verification_report.md

extracted/<name>/     # Stage-by-stage breadcrumbs (debugging / repack input)
  01_container/  02_archive/  03_decompressed/  04_decoded/  05_tree/
  07_editable/   08_pen/                                  (created on demand)
```

## Common gotchas

- Sample path `docs/메타리치 화면 UI Design.fig` contains spaces and Korean — quote it.
- `repack --mode json` needs `extract --include-raw-message` to have run; otherwise `04_decoded/message.json` is missing and the command errors.
- `html-report` requires both `extracted/` AND `output/`. Run `extract` first.
- Verification exit codes: 0 PASS / 2 FAIL. Useful for CI gates.

## Related skills

- `.pen` output details, ID rules, viewport normalization → **figma-pen-export**
- Internal module APIs (writing new subcommands) → **figma-internals**
