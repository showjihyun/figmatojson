# Shared conversion modules live in `src/`, not in a new `core/` package

When a transformation is needed by both the CLI pipeline (`src/`) and the
web editor (`web/`), it lives in `src/`. The web imports it across the
existing one-way boundary (`web/ → src/`). We do **not** introduce a new
top-level `core/` or `shared/` package, and we do **not** invert the
direction (`src/ → web/`).

The first instances of this rule are `src/expansion.ts` (the Master/Instance
**Resolve** pass — see `CONTEXT.md` → "Expansion") with its private helpers
`src/masterIndex.ts` and `src/effectiveVisibility.ts`. Both
`src/pen-export.ts` and `web/core/domain/clientNode.ts` consume them.

## Why not invert (live in `web/core/`)?

The CLI predates the web tree by years and contains the older, fuller
implementation of every conversion. Making `src/` depend on a subdirectory
called `web/` would read backwards to anyone navigating the repo cold —
the CLI is the more general consumer; the web is the newer specialised one.

## Why not a new top-level `core/` package?

Considered. Rejected because of mental model:

- `src/` already contains 18 conversion modules and 1 CLI entrypoint
  (`src/cli.ts`). The mental model the rest of `src/` lives by is
  **"src/ is the conversion engine; the CLI is one of its callers"** —
  not "src/ is the CLI". Adding `expansion.ts` to that directory extends
  a pattern that's already there.
- A new `core/` package would require moving `tree.ts`, `decoder.ts`,
  `vector.ts`, and `types.ts` (which the web already imports from `src/`)
  to keep the rule consistent — a much larger lift for no leverage gain.
- pencil.dev / npm-package distribution is not on the roadmap. If it
  becomes one, *that* PR is the right time to revisit naming — not now.

## Consequences

- New shared conversion modules go directly in `src/`. Don't create
  `src/shared/` or `src/core/` subdirectories — flat is fine until the
  count makes it unmanageable.
- The web's `web/core/domain/` continues to hold web-specific data shapes
  (`DocumentNode`) and adapters between `Tree Node` and the renderer's
  needs. It does not grow general conversion logic.
- A future PR that wants to move a `src/` module to a new `core/` package
  must justify it against this ADR, citing a concrete second non-web
  consumer or a packaging requirement that didn't exist before.
- The reverse direction (`src/ → web/`) remains forbidden. If the CLI
  ever needs something currently only in `web/core/`, that something
  moves *into* `src/` first.
