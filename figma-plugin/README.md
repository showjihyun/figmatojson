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

See `figma-plugin/code.js` `serializeNode` and `web/core/application/
AuditCompare.ts` `COMPARABLE_FIELDS` for the source of truth. Field set:

- `type`, `name`, `visible`
- `size.x`, `size.y`, `transform.m02`, `transform.m12`
- `rotation` (derived from kiwi transform matrix), `opacity`, `cornerRadius`
- `strokeWeight` — gated on figma's `strokes.length > 0`
- `fills.length`, `strokes.length` (paint bodies out of scope)
- TEXT-gated: `characters`, `fontSize`, `fontName.family`, `fontName.style`
- autolayout-gated: `stackMode`, `stackSpacing`, `stackPadding{Left,…}`,
  `stackPrimaryAlignItems`, `stackCounterAlignItems`

### Comparison rules

- Float equality uses a 0.5 px tolerance — sub-pixel differences are
  invisible.
- NaN === NaN is equal — kiwi emits NaN bit-pattern as the default for
  unset stack* spacing fields.
- Default substitution: `figma=undefined ↔ ours=<default>` is equal.
  Defaults are registered for representational-omission cases (Plugin
  emits only non-default values for some fields).
- Type aliases: `SYMBOL ↔ COMPONENT`, `ROUNDED_RECTANGLE ↔ RECTANGLE`,
  `CANVAS ↔ PAGE`. `FRAME` with `resizeToFit=true` and empty `fillPaints`
  reclassifies to `GROUP` (Figma's plugin/REST view).
- GROUP coordinate transparency: kiwi-side walk pre-adds GROUP-ancestor
  offsets to descendants' transforms, matching Plugin's "skip GROUP for
  parent reference" behavior.
- Composite IDs: nodes inside an INSTANCE arrive as
  `I<instance.guid>;<master.overrideKey>` from Plugin. Our walk
  synthesizes the same key by looking up `overrideKey` on each
  `_renderChildren` descendant — both sides end up indexed under the
  same key.

### Baseline

bvp.fig current page (round 31): 704 matched / 18,304 field comparisons /
**99.47% agreement**. 97 remaining diffs split between known noise
categories (schema enum rename, Plugin Mixed-font omission, etc.) and
~30 real signals pointing at a round-26/27 follow-up — nested-instance
text and size overrides not propagating through `_renderChildren`.

Out of scope: paint bodies (rgba, gradient stops, image hash), effect
shadows, vector geometry, prototyping, multi-page audit. See
`docs/specs/audit-oracle.spec.md` §7 for the full out-of-scope list.

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
