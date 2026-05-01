# figma_reverse · Tier 2 PoC web service

Browser-based viewer + minimal editor for `.fig` files, with **lossless round-trip back to `.fig`** (Figma can re-import).

## What this PoC does

1. **Upload** a `.fig` in the browser
2. Server runs the existing `figma_reverse` extraction pipeline
3. **Render** each page on a Konva canvas (frames / texts / rectangles)
4. **Click** a shape → JSON shown in the right panel
5. For TEXT nodes, **edit characters** in the form → persists to server
6. **Save** → server runs `repack --mode json` → downloads new `.fig`

The resulting `.fig` is byte-different but **semantically equivalent** to a Figma-edited version (kiwi round-trip preserves all metadata; only the edited fields change).

## What this PoC does NOT do (yet)

- Vector / image / gradient rendering (shows colored rect placeholder)
- Drag, transform, resize on the canvas
- AI assistant integration
- Multi-user / persistence (all in-memory + tmp dir, GC'd after 1h)
- True Figma import validation (manual — open the saved .fig in Figma)

## Run locally

```bash
cd web
npm install
npm run dev   # backend on 5174, client on 5173 with proxy
```

Open http://localhost:5173.

## Architecture

```
client/         Vite + React + react-konva
  src/App.tsx           top-level layout, page selector, save button
  src/Canvas.tsx        Konva renderer (frames / texts / rects)
  src/Inspector.tsx     JSON view + text-edit form
  src/api.ts            fetch wrappers

server/         Hono on Node, uses the existing src/ modules
  index.ts              POST /api/upload, GET /api/doc/:id,
                        PATCH /api/doc/:id, POST /api/save/:id
```

The server reuses the parent project's TS sources directly via relative
imports (`../../src/...`). No code duplication.
