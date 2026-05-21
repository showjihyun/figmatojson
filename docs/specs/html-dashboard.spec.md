# spec/html-dashboard

| Field | Value |
|---|---|
| Status | Approved |
| Implementation | `src/html-export.ts` (`generateHtmlDashboard` entry point) + `src/html-export-templates.ts` (`renderHtml`, `renderStyles`, `renderApp`) |
| Tests | `test/html-export.test.ts` (within available scope) — after this spec, multi-file/single-file output schema unit tests are recommended |
| Siblings | `SPEC.md §Stage 8` (CLI `output/` artifact source), `editable-html.spec.md` (sister output: single-file + .fig embed), `vector-decode.spec.md` (vector SVG source) |

## 1. Goal

Bundle the `extracted/<n>_*/` + `output/` directory produced by `figma-reverse extract` into an HTML dashboard that can be *opened directly in a browser*. The contract for the "browsable UI" advertised in README §Outputs — invariants, embedding rules, and per-page lazy-load policy used to live only in code.

A core constraint — **it must work over the `file://` protocol**. The user must be able to double-click the dashboard or move it via USB and have it work without a web server, otherwise it has no value in archival / backup scenarios. This constraint dictates every data-injection method (`<script src>` globals instead of XHR) and image/SVG embedding strategy.

## 2. Entry point

```ts
function generateHtmlDashboard(inputs: HtmlExportInputs): HtmlExportResult;

interface HtmlExportInputs {
  extractedDir:  string;     // figma-reverse extract's extracted/<name>/
  outputDir:     string;     // figma-reverse extract's output/<name>/
  htmlOutDir:    string;     // output location (.html file path in single-file mode)
  singleFile?:   boolean;    // default false
}

interface HtmlExportResult {
  outDir:        string;     // single-file path in single-file mode
  pages:         Array<{ index, name, nodeCount, relPath }>;
  imagesCopied:  number;
  vectorsCopied: number;
  totalBytes:    number;
  singleFile:    boolean;
}
```

- I-E1 Both input directories (`extractedDir`, `outputDir`) must exist — on absence, emit a friendly error (`"Run \`figma-reverse extract\` first"`).
- I-E2 Output structure is *completely different* between modes (§3 vs §4). Only one entry point is exposed; the caller chooses the mode.
- I-E3 The meaning of `htmlOutDir` differs by mode: in multi-file mode it is a *directory path*; in single-file mode it is a *file path*. The UI / CLI must be explicit on call.

## 3. Multi-file mode (default)

### 3.1 Output directory layout

```
<htmlOutDir>/
├── index.html              ← renderHtml() output
├── styles.css              ← renderStyles() output
├── app.js                  ← renderApp() output (tab routing + renderer)
├── data/
│   ├── overview.js         ← window.OVERVIEW (overview.json + meta)
│   ├── tree.js             ← window.NODES_FLAT (extracted/05_tree/nodes-flat.json)
│   ├── schema.js           ← window.SCHEMA (extracted/04_decoded/schema.json)
│   ├── pages-index.js      ← window.PAGES_INDEX (page manifest)
│   ├── pen-index.js        ← window.PEN_INDEX (.pen page manifest)
│   ├── pages/<safeName>.js ← window.PAGE (lazy-load via <script src>)
│   └── pen-pages/<safeName>.js ← window.PEN (lazy-load via <script src>)
└── assets/
    ├── images/<hash>.<ext>
    ├── vectors/<id>.svg
    └── thumbnail.png
```

- I-M1 The three static files (`index.html`, `styles.css`, `app.js`) are produced by templates helpers — contents are byte-stable, regeneration is deterministic.
- I-M2 Every `data/<name>.js` follows a *single global assignment* form: `window.<UPPER_NAME> = <json>;` — injected via `<script src>` and referenced as a `window` global. JSON.stringify determinism is guaranteed on the source side (extract pipeline).
- I-M3 Page files use *per-file safe names* — characters `[^a-zA-Z0-9_-]` in the `<file>.json` basename are replaced with `_`. Korean page names are converted to latin-only safe filenames.
- I-M4 Page lazy-load: when the user clicks a page tab, `app.js` dynamically injects `<script src="data/pages/<safeName>.js">` → `window.PAGE` is overridden. The previously injected `PAGE` is garbage-collected.
- I-M5 Lazy-load grain: per page. Tree / schema / overview are always fully loaded — in the size distribution, page data dominates, so separation has value only at the page level.
- I-M6 Assets are *copied*. Files from the original `output/assets/` go straight to `htmlOutDir/assets/` — no re-encoding, byte-identical.

### 3.2 Index file contract

```ts
// data/pages-index.js
window.PAGES_INDEX = [
  { index: number, name: string, nodeCount: number, relPath: string }
];

// data/pen-index.js
window.PEN_INDEX = [
  { idx: number, name: string, fileName: string, nodeCount: number, relPath: string, bytes: number }
];
```

- I-M7 `relPath` is a path relative to `htmlOutDir` (`data/pages/<safe>.js`). `app.js` uses it directly in `<script src>`.
- I-M8 `name` source: `data.name ?? file` (the `.name` field of the page JSON; the filename when absent). The pen side uses `data.__figma?.pageName` (metadata stamped by page-export).
- I-M9 `nodeCount`: `countNodes(data)` or `countPenNodes(data.children ?? [])` — for the caller (UI) to display.

### 3.3 Side-data source mapping

| `data/*.js` | Source | Nullable |
|---|---|---|
| `overview.js` | `collectOverview(extractedDir, outputDir)` (each stage's `_info.json` + `verification_report.md` consolidated) | Always emit |
| `tree.js` | `extracted/05_tree/nodes-flat.json` | Emit `[]` when absent |
| `schema.js` | `extracted/04_decoded/schema.json` | Emit `null` when absent |
| `pages/*.js` | `output/pages/<n>_<name>.json` | Empty index when the page directory is absent |
| `pen-pages/*.js` | `extracted/08_pen/<n>.pen.json` | Empty index when the pen directory is absent |

- I-M10 The reason missing sources *fall back rather than throw*: the dashboard must visualize *partial pipeline outputs*. Extraction with `--no-vector` must not stop the dashboard.

## 4. Single-file mode

`htmlOutDir` is a `.html` file path. All data + assets + JS/CSS are inlined into *a single file*.

- I-S1 Page data preserves *only the fields the renderer uses* (`stripPageForRenderer`) — size is significantly smaller than the schema-unprotected raw page json. Multi-file mode keeps raw; only single-file strips.
- I-S2 Image embedding: `data:<mime>;base64,<...>` URI. Mime is decided by the file extension (`f.slice(dot+1)`) via `mimeFromExt` mapping (png/jpg/webp/gif/svg/pdf).
- I-S3 SVG embedding: the raw string (no data URI) — Konva can use it directly when parsing paths.
- I-S4 Thumbnail: a single `data:image/png;base64,...` string.
- I-S5 The output of single-file mode is assumed to be *under ~100MB*. The metarich baseline is ~30MB. Beyond that, multi-file is recommended (the browser's string-parse cost grows).
- I-S6 file:// compatibility: every `<script>` is inline (no `src`), every image is a data URI — works under origin-isolated environments.

## 5. JS module form

`writeJsModule(path, name, value)` emits every `data/*.js` file.

- I-J1 Form: `window.${name} = ${JSON.stringify(value)};\n`. No minification (browser dev tools can still debug).
- I-J2 `name` is `[A-Z_][A-Z0-9_]*` SCREAMING_SNAKE — avoids collisions.
- I-J3 JSON serialization determinism: `JSON.stringify(value)` (no indent). The property order of `value` must be preserved to avoid git diff noise.
- I-J4 Returned bytes (utf-8 byte count of the string length) are returned to the caller — used to compute `totalBytes`.

## 6. Static templates (`html-export-templates.ts`)

- I-T1 `renderHtml()`: `<!DOCTYPE html>` + `<head>` (styles.css link, viewport meta, title) + `<body>` (root container) + the data scripts injected in a *fixed order* (overview → tree → schema → pages-index → pen-index → app.js).
- I-T2 `renderStyles()`: a single CSS string. No external CSS dependencies (no Tailwind / styled-components — file:// deployment compatibility).
- I-T3 `renderApp()`: a single string of vanilla JS — tab routing (`Overview`, `Pages`, `Pen`, `Tree`, `Schema`, `Verify`), page lazy loader, search. A single-page application but no framework.
- I-T4 Single-file mode uses `renderSingleFileHtml(...)` to combine templates and inline data into a single string.

## 7. Error policy

- I-E2 Missing input directories → friendly error (the CLI tells the user the next command to run).
- I-E3 Missing source JSON (e.g., `nodes-flat.json` absent) → emit an empty fallback (§I-M10). No throw.
- I-E4 Missing image / vector → emit zero entries in that category; the dashboard shows *only that tab* empty. Other tabs work as usual.
- I-E5 In single-file mode, if `mimeFromExt` encounters an unknown extension, skip the image — safer than a broken `<img src>`.

## 8. Non-goals

- ❌ **Interactive editing** — the dashboard is a *read-only viewer*. Node mutation / repack triggering / .fig export are separate features (`editable-html.spec.md`).
- ❌ **CDN / web server dependency** — must work without internet (file:// guarantee). No external font, CSS, or JS dependencies.
- ❌ **Server-side rendering** — every render is client-side. SEO / accessibility levels are outside the dashboard scope.
- ❌ **Full WCAG compliance** — color contrast / aria-label / keyboard navigation are best-effort. Not verified by this spec.
- ❌ **i18n** — UI text is a mix of Korean + English (source as-is). The dashboard is an internal tool.
- ❌ **Persisted view state** — tab / search / expansion state is reset on reload. localStorage is not used.
- ❌ **Incremental rebuild** — when only part of `extractedDir` changes, no partial rebuild. Full regeneration.

## 9. Resolved questions

- **Why `<script src>` global injection instead of cleaner JSON file + fetch?** Under the `file://` protocol, `fetch('data/...')` fails because of CORS / scheme restrictions. `<script src>` works because of an exception to the same-origin policy (legacy compat). USB / local-filesystem deployment without an external web server is the core of the dashboard's value.
- **Single-file mode size limit?** ~100MB. The browser must parse it as a single string, so memory pressure + parse time scale up. Beyond that, multi-file.
- **Could page lazy-load go to sub-page granularity (e.g., parts of a large page)?** Currently per-page only. Page-level lazy-load is sufficient on the metarich distribution of 6 pages / 65K nodes — revisit if users start noticing perceived wait during inspection.
- **Where is asset dedup?** Not in the dashboard but *upstream* (CLI Stage 6, `assets.ts`) using sha1 hashing — already deduped. The dashboard just copies — `imagesCopied` counts unique images after dedup.
- **Why does `stripPageForRenderer` apply only to single-file mode?** Multi-file page json is split into `data/pages/<n>.js` for lazy-load — keeping rich raw info improves inspection. Single-file keeps everything in memory, so trimming is high value-vs-cost.
