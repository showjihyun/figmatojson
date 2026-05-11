# figma-reverse — What is a world first (non-expert audience)

| Item | Value |
|---|---|
| Date | 2026-05-05 |
| Sibling docs | [SPEC.md](./SPEC.md) (CLI 9 stages), [SPEC-architecture.md](./SPEC-architecture.md) (full architecture) |
| Survey scope | GitHub / npm / blogs / forums / Figma official docs (as of 2026-05) |
| Conclusion | **5 core capabilities appear to be world firsts. But some foundational pieces (ZIP / Kiwi decode) are not ours first — separated honestly** |

This document is an honest classification of *what is new and what is not*. It is a technical fact-collection, not marketing.

---

## 1. One-line summary

> What Figma does *only internally* in its desktop / web app — *fully decoding the `.fig` binary, drawing it identically on screen, and going back to `.fig`* — appears to be done here by **the first external open-source codebase**. In particular, no public end-to-end tool was found that handles INSTANCE component variant overrides, auto-layout recomputation, and pixel-level verification together.

---

## 2. What is a Figma file, anyway (non-expert)

Figma is the design tool most designers use. The screens a designer creates live inside a single `.fig` file. This file is:

- **A cipher-like binary** — opening it raw shows meaningless 0s and 1s.
- **Compressed twice**, so you must decompress to see its contents.
- **A component system**. If you reuse the same button design in 100 places, it stores 1 master + 100 instances (each with overrides for color / text / visibility) — not 100 copies.
- **Auto-layout rules**. Things like "if the button gets longer, the icon next to it gets pushed automatically" — defined by the designer up front.

Figma's internal code interprets all of this and draws it on screen. Doing the same from outside means rebuilding *everything* yourself — from decompression to component expansion to override application to auto-layout recomputation to drawing.

---

## 3. Already known (not ours first)

People arrived here before us. We acknowledge this honestly:

| Item | Who did it first | Source |
|---|---|---|
| That `.fig` is a ZIP container | Multiple (Evan Wallace himself + Albert Sikkema and others) | [Sikkema (2026-01)](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html), [easylogic Medium (2024-09)](https://easylogic.medium.com/figma-inside-fig-%ED%8C%8C%EC%9D%BC-%EB%B6%84%EC%84%9D-7252bef141da) |
| That `canvas.fig` inside the ZIP is fig-kiwi format | Same as above | Same as above |
| **Dual compression** (schema=deflate, data=zstd) | Sikkema (2026-01) documented it explicitly | [Sikkema](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) |
| Kiwi schema decode | Evan Wallace (Kiwi's author) + [fig-kiwi npm package](https://www.npmjs.com/package/fig-kiwi) (3 years ago, v0.0.1) | [Kiwi demo](https://evanw.github.io/kiwi/) |
| Flat NodeChanges → tree reconstruction | Both easylogic and Sikkema cover this | Sources above |
| WebSocket realtime protocol decode | [allan-simon/figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol) — different scope (live session interception) | GitHub link |
| Just *peeking inside* a `.fig` | [Evan Wallace's own Fig File Parser](https://madebyevan.com/figma/fig-file-parser/), [Grida `.fig` viewer](https://grida.co/tools/fig) | Both are inspection-only |
| Figma → Penpot conversion | [betagouv/figpot](https://github.com/betagouv/figpot), [penpot-exporter-figma-plugin](https://github.com/penpot/penpot-exporter-figma-plugin) — but they use **Figma's Plugin API** (not direct binary parsing) | GitHub links |

We implement the items above the same way or similarly, but *we are not the first*. Our code also borrows existing npm libraries like [`fzstd`](https://www.npmjs.com/package/fzstd), [`pako`](https://www.npmjs.com/package/pako), and [`kiwi-schema`](https://www.npmjs.com/package/kiwi-schema).

---

## 4. Five things that appear to be world firsts

Five things *not present* in any public tool or document surveyed. That is, things we appear to be the first external party to have done:

### 4.1 *Full* application of INSTANCE component variant overrides

**What it is**: When a Figma designer reuses the same button in 100 places, each instance can be stamped with overrides like "text 'OK'", "color red", "this instance hides the icon". The `.fig` file stores those overrides as path-keyed data. Reading and correctly applying them onto the master is the only way the rendered screen matches Figma.

**Evidence**: The closest competing tool, [`figma-kiwi-protocol`](https://github.com/allan-simon/figma-kiwi-protocol), explicitly admits in its README:

> "instance overrides go through a mechanism we haven't reversed yet"

They went very deep — they decoded the **WebSocket live protocol** — yet they acknowledge they could not crack the override mechanism. We handle all 7 override kinds via path-key matching:

1. Text changes (e.g., master button label "Button" → this instance is "OK")
2. Color changes (e.g., master white → this instance is blue)
3. Visibility changes (e.g., master icon shown → this instance hides it)
4. Component property (Variant) binding — designer-defined props like "Type=Primary" that batch-change descendant node properties
5. Variant Swap — replace the instance with a different variant of the same master
6. Pre-computed descendant size (derivedSymbolData)
7. Pre-computed descendant position / rotation (derivedSymbolData transform)

### 4.2 Path-key FRAME-skip rule (round 25 discovery)

**What it is**: A *path notation* identifying which descendant an override applies to. Figma stamps the path as "[Button → Text]", but when the descendant is "Button → container FRAME → Text" with a container in between, Figma *omits the container from the path* and writes "[Button → Text]" only. Miss this rule and overrides land in the wrong place, breaking the rendered screen.

**Evidence**: We discovered this rule in round-25 work after noticing 18 alert-modal instances in a fixture all showed the same pixel diff pattern. Searching ([github.com](https://github.com) for `derivedSymbolData` / `symbolOverrides path-keyed FRAME skip`), no public material documents this rule. Figma's [official Plugin API docs](https://www.figma.com/plugin-docs/) also do not expose the wire-format path rule (they expose a different abstraction layer).

### 4.3 derivedSymbolData (size + position transform) baking

**What it is**: Figma stamps onto every instance the *result* of auto-layout computation — "in this instance, this descendant has width 48 and position (262, 118)". This is the authoritative data Figma uses when rendering, but externally there is no documentation on which node's value to use, what coordinate system it lives in, or how to apply it.

**Evidence**: We reverse-engineered the application algorithm across two rounds — round-22 (size) + round-24 (transform). 1,570 INSTANCEs in the fixture carry at least one transform entry. Before round-24, the 5th row of the mobile customer list was clipped; after applying derivedTransform, it displays correctly (verified visual win case, pinned by contract via e2e tests).

`derivedSymbolData` does not surface in search — it is not exposed even in Figma official material like [GitHub mcp-server-guide](https://github.com/figma/mcp-server-guide/blob/main/skills/figma-generate-design/SKILL.md). It is an internal field name we discovered by decoding `.fig` files directly.

### 4.4 Auto-layout recomputation simulation

**What it is**: Figma's auto-layout is not raw coordinates but a *rule-based system* — rules like "center-align + 8 px gap + reposition children when the container shrinks". Figma's own code runs these in real time, but the `.fig` file only contains *rule definitions* with some pre-computed coordinates (as in §4.3 above) stamped on.

We wrote rule-simulation code so we could produce the *same result* as Figma. Seven patterns (CENTER+CENTER re-center, MIN-pack left align, overlap-group distribute, AUTO-grow, etc.) implemented across rounds 14, 15, 19, 20, 21, 22, 24. Details in [`web-instance-autolayout-reflow.spec.md`](./specs/web-instance-autolayout-reflow.spec.md) §3.1-3.10.

**Evidence**: Search results ([Pawel Grzybek's Auto Layout article](https://pawelgrzybek.com/grow-shrink-and-reflow-elements-with-figma-auto-layout/), [Figma's official guide](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout)) only describe behavior from a user perspective. No tool was found that re-implements the algorithm externally.

### 4.5 End-to-end + pixel-level verification

**What it is**: Combining §4.1~4.4 to run the full `.fig` → screen → `.fig` cycle and automatically verify that the result is visually identical to Figma at the *pixel level*.

Our verification data:
- Fixture design file (35,660 nodes, 6 pages)
- 1,500+ INSTANCE slugs classified into 4 corpora (design-setting / dash-board / mobile / web)
- 749 PNG baselines compared against renders from Figma's official REST API
- Each round ends with automatic re-capture via `web/scripts/audit-round11-screenshots.mjs`
- When a visual diff appears, debug that slug and fix it in a new round
- e2e tests contract-pin specific visual wins via pixel sampling (`web/e2e/audit-transform-baking.spec.ts`)

**Evidence**: Across all surveyed tools (Sikkema, easylogic, figma-kiwi-protocol, Evan Wallace's parser, Grida viewer, Penpot exporter), none performs *automatic comparison against Figma's pixel output externally*.

Likewise, *round-trip verification itself* — `.fig` → JSON → `.fig` being byte-equal or semantically equal — is something we appear to be the first to verify. This started from PRD §6.3 hypothesis #9 and is implemented as V-01~V-08 automated verification.

---

## 5. Why this is hard (analogy)

**LEGO analogy**

A Figma file is like a *digital envelope* containing a compressed LEGO instruction manual.

- **Open the envelope (ZIP)** ← anyone can cut the envelope with scissors.
- **Unroll the manual (Kiwi decode)** ← unrolling the rolled-up paper inside the envelope.
- **Read steps 1, 2, 3 (tree reconstruction)** ← ordering the pages of the manual.

Many people have gotten this far. But this is no ordinary LEGO manual:

- **Part #46 (a button) appears 100 times, with different colors each time.**
  → It stores 1 master + a separate *override memo* saying "this instance is red / this is blue / this has different text".
  → **Miss the rule for which memo binds to which part and they all come out the same color (§4.1).**

- **The memo addresses its target part oddly.**
  → "Text inside Button" — but the memo only says "Text" and the intermediate container is omitted. Miss this notation rule and the memo orphans.
  → **This is our round-25 discovery (§4.2).**

- **The slot a part goes into is stretchy.**
  → Rules like "when the button shrinks, the text inside re-centers" are not written in the LEGO manual. They live only in the designer's head. Only Figma knows.
  → **We copied the rules ourselves and simulated them (§4.4).**

- **Figma kindly tucks in some answer keys**, but never spells out the coordinate system.
  → After tracing, we found it is "absolute coordinates from the master root".
  → **You have to apply this to every descendant (§4.3).**

- **The LEGO company (Figma) keeps all these rules to its own employees.**
  → No external tool exists that reads them all and assembles the exact same model.

---

## 6. Honest caveats

We want to emphasize — **we do not claim to have done everything**:

1. **We also borrow heavily**: `pako` (deflate), `fzstd` (zstd), and `kiwi-schema` (Evan Wallace) are the core codecs. Without them we could not have started.
2. **Prior art acknowledged**: Albert Sikkema's dual-compression discovery (2026-01) is correct and cited in our SPEC.md §10. easylogic's 2024-09 Korean article reaches the same steps.
3. **Partial coverage acknowledged**: Vector decode 95% (BOOLEAN_OPERATION etc. — 5% — unparsed); `componentPropNodeField` handles VISIBLE + TEXT_DATA (the latter added in round 33 — Material 3 Date Picker day cells, action button labels, dropdown labels all flow through it); INSTANCE_SWAP still unsupported; stroke / effects override unsupported.
4. **Figma cloud import unverified**: We have not confirmed that Figma accepts the `.fig` we produce. (Round-trip verification passes through our own parser.)
5. **Verified on a single corpus only**: Edge cases not present in our fixture may exist in other design files. Adding new corpora is future work.
6. **Commercial tools (Anima / Builder.io / Plasmic) are closed source**, so we cannot verify how they handle this. People in that space typically use Figma's Plugin API, but we cannot assert that *without seeing their code directly*.
7. **Search limits**: We surveyed GitHub / npm / blogs / Figma official docs, but did not cover *private GitHub repos*, *academic papers*, or *non-English material (Russian / Chinese / etc.)*.

In short: **rather than claiming "world first", it is more honest to say "appears first among publicly discoverable material at this point in time"**. The possibility that someone has done this privately is always open.

---

## 7. One-sentence summary

> This project appears to be the first tool to take *fully decoding the Figma `.fig` binary, drawing it identically on screen, and going back to `.fig`* end-to-end *externally in open source*. In particular (a) instance override application, (b) the path-key FRAME-skip rule, (c) leveraging Figma's post-layout data, (d) auto-layout simulation, and (e) pixel-level automatic verification — these five do not appear in any public tool or document.

---

## 8. Sources

Survey date: 2026-05-05.

### Closest competitors
- [Albert Sikkema, "Reverse-Engineering Figma Make: Extracting React Apps from Binary Files"](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) (2026-01) — React extraction from `.make` files. Binary decode + dual compression. INSTANCE handling not covered.
- [allan-simon, figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol) — WebSocket protocol decoder. README admits "instance overrides ... haven't reversed yet".
- [Evan Wallace, Fig File Parser](https://madebyevan.com/figma/fig-file-parser/) — Inspection tool by Figma's former CTO. View-only.
- [Grida `.fig` parser / viewer](https://grida.co/tools/fig) — Clipboard / file inspection. Node hierarchy explorer.
- [easylogic, "Figma Inside — analyzing the `.fig` file"](https://easylogic.medium.com/figma-inside-fig-%ED%8C%8C%EC%9D%BC-%EB%B6%84%EC%84%9D-7252bef141da) (2024-09) — Korean-language article; covers up to binary decode.

### Codecs
- [fig-kiwi](https://www.npmjs.com/package/fig-kiwi) — npm v0.0.1, 3 years ago. Binary codec only.
- [Evan Wallace, Kiwi schema-based binary format](https://github.com/evanw/kiwi) — Kiwi itself.
- [pako](https://www.npmjs.com/package/pako), [fzstd](https://www.npmjs.com/package/fzstd) — Compression libraries.

### Plugin API-based tools (different category)
- [betagouv/figpot](https://github.com/betagouv/figpot) — Figma → Penpot via Plugin API.
- [penpot-exporter-figma-plugin](https://github.com/penpot/penpot-exporter-figma-plugin) — Same.

### Related Figma official docs
- [Figma Plugin API: FrameNode](https://developers.figma.com/docs/plugins/api/FrameNode/)
- [Figma Help: Auto Layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout)
- [Figma Blog: Component Overrides](https://www.figma.com/blog/figma-feature-highlight-component-overrides/)
- [Pawel Grzybek, Auto Layout reflow](https://pawelgrzybek.com/grow-shrink-and-reflow-elements-with-figma-auto-layout/) — User perspective.

### This project
- [SPEC.md](./SPEC.md) — CLI 9-stage pipeline
- [SPEC-architecture.md](./SPEC-architecture.md) — Full architecture (round 25 snapshot)
- [`web-instance-render-overrides.spec.md`](./specs/web-instance-render-overrides.spec.md) — Source of truth for the path-key contract
- [`web-instance-autolayout-reflow.spec.md`](./specs/web-instance-autolayout-reflow.spec.md) — Auto-layout simulation rules
- [`web-instance-variant-swap.spec.md`](./specs/web-instance-variant-swap.spec.md) — Variant swap
- [`audit-round11/GAPS.md`](./audit-round11/GAPS.md) — Per-round visual verification record
