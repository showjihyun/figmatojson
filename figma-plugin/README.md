# figma_reverse — audit oracle plugin

Phase 2 MVP: a Figma plugin that compares Figma's interpretation of a `.fig`
file against `figma_reverse`'s parser output. Surfaces fields where our
parser disagrees with Figma — those are the highest-leverage parser bugs to
fix next.

## Install (Figma Desktop)

The plugin runs unbundled — no `npm install`, no build step.

1. Open **Figma Desktop** (the web app does not support local plugins).
2. `Plugins → Development → Import plugin from manifest…`
3. Pick `figma-plugin/manifest.json` from this repo.
4. The plugin is now available under `Plugins → Development → figma_reverse audit`.

## Use

Pre-req: `figma_reverse` web backend running locally on `:5274`.

```sh
cd web && npm run dev:server
```

Then in Figma Desktop:

1. Open the `.fig` file you want to audit (e.g. `docs/bvp.fig`).
2. Run the plugin (`Plugins → Development → figma_reverse audit`).
3. In the plugin UI, upload the **same** `.fig` file (the one currently open
   in Figma) via the file picker.
4. Click **Run audit**.
5. The plugin sandbox serializes Figma's view of the current page, ships it
   to the backend along with the upload's `sessionId`. Backend diffs Figma's
   tree against our parser's tree (matched by node id) and returns a
   per-field diff count.

## What gets compared

Phase 2 MVP scope — see `figma-plugin/code.js` `serializeNode` and
`web/core/application/AuditCompare.ts` `COMPARABLE_FIELDS`:

- `type`, `name`, `visible`
- `size.x`, `size.y`
- `transform.m02`, `transform.m12`
- `rotation`, `opacity`, `cornerRadius`, `strokeWeight`
- `fills.length`, `strokes.length`
- TEXT: `characters`, `fontSize`, `fontName.family`, `fontName.style`
- Auto-layout: `stackMode`, `stackSpacing`, `stackPadding{Left,Right,Top,Bottom}`,
  `stackPrimaryAlignItems`, `stackCounterAlignItems`

Float comparisons use a 0.5 px tolerance (sub-pixel differences are
invisible). NaN === NaN is treated as equal (Figma's kiwi schema emits NaN
bit-pattern as the default for unset stack* spacing fields).

Out of scope for MVP: paint colors, gradient stops, effect shadows, vector
geometry, prototyping. Add fields to the COMPARABLE_FIELDS list as we
expand coverage.

## Why a plugin

`figma_reverse` parses the binary `.fig` format. The plugin asks Figma
itself "what did *you* read from this file?" and we compare. The plugin
is read-only — it never modifies the Figma file. The end-to-end audit
loop (load → parse → repack → reload in Figma) is what gives us
confidence that an edited `.fig` will render correctly when a user opens
it in Figma.

## Troubleshooting

**Plugin fails to load**: check that `manifest.json` `networkAccess.allowedDomains`
includes the backend URL. Default is `http://localhost:5274`.

**`compare 404 session not found`**: the plugin uploads the `.fig` first (creates a
session), then asks the sandbox for the figma tree. If the backend was
restarted between upload and compare, the session is gone — re-upload.

**`onlyInFigma` count is high**: Figma may have created sub-nodes (e.g. text
glyph nodes) that our parser collapses, or vice versa. This is normal; what
matters is the `topFields` list of *matched* nodes that disagree.
