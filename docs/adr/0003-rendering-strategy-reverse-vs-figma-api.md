# Rendering strategy — reverse-engineering for production, Figma REST API for dev/test only

`figma_reverse` renders `.fig` files via reverse engineering of Figma's
binary format (kiwi-encoded `Document` tree → React+Konva on the canvas).
The Figma REST API is **never** called from production code — only from
the dev/test audit harness as ground truth.

## Decision

We adopt a **strict separation**:

- **Production renderer**: 100% offline, decoded from raw `.fig` bytes,
  rendered with our own `Canvas` component. Read + edit + save round-trip.
  Never imports any Figma-API code or token.
- **Dev/test harness**: uses Figma REST API (`/v1/images/<file_key>?ids=…`)
  to download "ground truth" PNGs of nodes already in Figma's cloud.
  Used only inside `web/scripts/` and `docs/audit-round11/`. Token lives
  in `.env.local` (gitignored). No production code path reads `FIGMA_TOKEN`.

A linter rule could enforce this (forbid `api.figma.com` imports outside
`web/scripts/`); for now the rule is by convention.

## Why not Figma REST API as the production renderer?

Three failures it can't avoid:

1. **`.fig` binaries are not Figma-API-addressable.** REST API needs a
   *file already in Figma's cloud* (file key + your account access).
   Local `.fig` artifacts — including the ones designers email each other,
   the ones our `bvp.fig` test fixture is, the ones offline tooling
   produces — have no file key. To use REST API the user must first
   *upload to Figma*, requiring a Figma account and outbound network
   access. That defeats the project's premise (`figma-reverse` =
   "give me a `.fig`, I'll render it without Figma").
2. **Read-only.** The images endpoint returns rendered PNGs. There's no
   path back to a modified `.fig`. Our round-trip save (`/api/save/:id` →
   modified `.fig` download) requires keeping the source bytes and
   re-packing them — fundamentally an offline operation.
3. **Fragility at scale.** First batch fetch in round-11 audit hit
   `400: Render timeout, try requesting fewer or smaller images` on a
   50-id batch. Retry logic + smaller batches help, but a production
   user-facing render path can't afford "Figma is rate-limited right now,
   try again later" as a failure mode.

There are also subtler problems:

- **Privacy / IP.** Many corporate `.fig` files cannot be uploaded to
  Figma's cloud (NDA, regulated industries). A renderer that requires
  upload excludes those use cases.
- **Vendor coupling.** Figma raising prices, deprecating endpoints,
  changing token policy, or being acquired all become production
  outages. Reverse-engineered rendering is decoupled — kiwi schema
  changes are a known maintenance cost we already absorb.
- **Performance.** Konva + reverse-engineered render paints metarich
  (35,660 nodes) in <30s with no per-node network. REST API has per-image
  latency and rate limits.

## Why not reverse-engineering only?

Without a ground truth, every fidelity question is "well, I think it
should look like this." Round 11 stage 2 caught:

- `u:arrow-right` icon visible in `Input Box` confirm buttons (Figma
  hides it; gap had been latent for weeks until we fetched the real
  render).
- "오류문구" red / "성공문구" green text styling (we render all gray).
- Calendar dropdown text override duplication (`최근 / 최근 / 쥼월`).

Each was found in seconds once we had the matching `figma.png`. Without
it, weeks of guess-and-check.

The REST API is invaluable as **oracle** for:
- Visual regression testing in CI (PR-time `ours.png` vs `figma.png` diff).
- Spec lookup ("what's the exact hex of this fill?" → fetch from Figma).
- Audit prioritization (rank fixes by which deliver most pixel-similarity gain).

So: keep both, but ringfence them.

## Consequences

- `web/scripts/figma-fetch.mjs` and friends are **dev-only** tools. Their
  output (`docs/audit-round11/<page>/<comp>/figma.png`) is committed but
  used only by humans + future audit re-runs.
- The audit harness becomes a permanent fixture: every render-fidelity
  round (round 11, 12, …) follows the same pattern — fetch ground truth,
  diff, fix, re-fetch ours, repeat until convergence.
- `.env.local` with `FIGMA_TOKEN` is per-developer; CI runners that need
  Figma API access read the token from a secrets store. Production
  builds never see the token; production bundles never import the API
  client.
- We never claim "render fidelity equal to Figma" — we claim "high
  fidelity, audited against Figma, with known gap list." The gap list
  IS our roadmap.

## What this is *not*

- Not a partial migration to Figma's API. We will not add features by
  proxying the API in production code. New universal Figma features
  (round 9's LAYER_BLUR, round 10's variant labels, …) get their own
  spec + reverse-engineered implementation.
- Not a deprecation of any existing reverse-engineering work. Round 1–10
  stand. Round 11+ continues the same trajectory with better feedback.

## Related

- `docs/audit-round11/WORKFLOW.md` — the operational loop this ADR
  unblocks.
- `web/scripts/build-audit-inventory.mjs` + `audit-round11-screenshots.mjs`
  + `figma-fetch.mjs` — the three scripts that materialize the harness.
- `docs/specs/web-render-fidelity-round*.spec.md` — the per-round
  fixes built on top.
