# Designer ↔ developer collaboration in the Figma era

> A note that reinterprets the findings of [`wire-format-vs-design-intent-review.md`](./wire-format-vs-design-intent-review.md) from a collaboration perspective.

## Implications of the review

### Core finding: the diagnosis shifts from a "tool problem" to a "process problem"

Conventional wisdom before the review: *"Figma → code conversion fails because the .fig format is insufficient."*

Accurate diagnosis after the review: *"Figma → code conversion fails because designers do not use Figma's expressiveness."*

The implications of the two framings are opposite:

| Framing | Implication | Action |
|---|---|---|
| Tool limitation | Wait for a smarter converter | Passive — a market problem |
| Designer underuse | The design file itself is the spec | Active — a problem we can change collaboration to solve |

In other words, the ceiling of conversion quality is not the *converter algorithm* but *the amount of intent the .fig file holds*. Even a stronger LLM produces poor output from poor input — in the LLM era, the gap actually widens to **good design × LLM = great code, bad design × LLM = bad code at scale**.

### Secondary finding: ".fig file quality" becomes a measurable engineering metric

Until now, "a well-made Figma file" has been an *aesthetic / subjective* judgment. But the wire signals revealed in the review (Component / Variant / Variable / Auto-layout / Property / Prototype usage rates) are all **machine-measurable**. That means design-file quality can be validated as a metric, just like code PRs.

---

## Reframing collaboration

### Era shift

| Era | Handoff unit | Designer ↔ developer interface |
|---|---|---|
| ~2015 | Static mockups (PSD, JPG) | "Is this 16px or 14px?" |
| 2015–2022 | Design tokens + Storybook | Shared tokens / component library |
| 2023~ | **The .fig file itself is the spec** | The wire feeds the code generator directly |

Today is **stage 3**. The design file is not an artifact — it is an *executable specification*. So the collaboration model is no longer "designer → handoff → developer" but more accurately **"designer and developer refine the same file together"**.

---

### Designer's responsibility (how to engrave intent in the wire)

Use the wire signals identified in the review intentionally:

1. **Always componentize repeating UI** → embedded in the wire as `COMPONENT` (#1 solved)
2. **Use Variants for state variations** → Variant set like `Button/Default`, `Button/Hover`, `Button/Disabled` (#3 solved)
3. **Use Variables for every color, spacing, radius, and typography** → `paint.colorVar.alias` lands in the wire (#5 solved)
4. **Expose mutable regions via Component Properties** → Text prop, Boolean prop, Instance swap → embedded as `componentPropDefs` (#2 solved)
5. **Lay out with Auto-layout** → flex intent goes into the wire as `stackMode`, `stackSpacing`, `stackPadding*` (#7 partially solved)
6. **Use semantic layer names** → e.g. `Card/Header/Avatar`. Preserved verbatim in the wire's `name` field and is a strong signal when an LLM infers className
7. **Prototype connectors (optional but useful)** → hover/click intent really does land in the wire (#3 reinforcement)

> **Core principle**: "Even if the visible result is the same, *how it was drawn* is recorded differently in the wire."
> A card built with Auto-layout and a card built with absolute positioning have identical pixels but different wire, and produce different code.

### Developer's responsibility (how to read the wire like a code review)

Old way: "Look at Figma and copy pixels exactly."
New way: **"Treat the Figma file like a PR review."**

1. **Design-file review** — As if the designer opened a PR, review the design file. Point out repeating UI that wasn't componentized, hard-coded colors not using Variables, overuse of absolute positioning — *like code-review comments*
2. **Define shared vocabulary** — Name Tokens (`color/brand/primary`) and Components (`Button`, `Card`) *together* with the designer. So the design's token names become the code's variable names directly
3. **Explicit mapping with Code Connect** — Bind Figma Components ↔ React/Vue components 1:1 so wire Components convert directly into code imports
4. **Design system: code is primary, Figma is a mirror** (or the opposite, made explicit) — Convertibility can only be determined once it's agreed which is the source of truth
5. **Agree on state spec up front** — Require the designer to provide the minimum state set every interactive component should have (default / hover / focus / active / disabled / loading / error). Without that, the LLM guesses and results are different every run

### Team-level agreements (recommended to document)

- **Naming convention**: Component PascalCase, instance lowercase, etc.
- **Token taxonomy**: primitive (`blue/500`) vs semantic (`brand/primary`) vs component (`button/bg`)
- **Criteria for "what becomes a Component"**: appears 2+ times? has separate states? — make the policy explicit
- **Responsive strategy**: Separate frames for desktop/mobile? Constraints? Or handled in code? — Because the wire can't express this, *external agreement* is needed (#4 solved)
- **a11y spec**: Mark semantic role in layer names (`button/Submit`), denote focus order, etc. — Fill what the wire lacks with *convention* (#8 solved)

---

## Amplification in the LLM era

Restating the conclusion of review #7 from a collaboration angle:

> **Parser output = enriched context for the LLM**
>
> One screenshot → LLM = passable code
> Screenshot + Component tree + Variable references + Auto-layout structure + Variant metadata → LLM = **code that preserves design-system consistency**

This difference comes directly from the designer's input quality. So as LLMs get stronger, *the designer's wire-usage proficiency exerts greater leverage on conversion quality*. Skip the collaboration cost and you forfeit that leverage.

---

## A measurable design-file quality metric (proposal)

Six machine-measurable wire signals. Candidates for a design-file quality score:

| Metric | How it is measured | Meaning |
|---|---|---|
| Componentization rate | # `INSTANCE` nodes / total child nodes | Reuse-intent expression rate |
| Variable usage rate | # paints with `paint.colorVar.alias` / total paints | Token traceability |
| Auto-layout rate | # frames with `stackMode != NONE` / total FRAMEs | flex-intent expression rate |
| Component Property usage | # masters with `componentPropDefs.length > 0` / total masters | Mutable-region declaration rate |
| Variant set coverage | Average children per `COMPONENT_SET` | State-spec completeness |
| Semantic naming rate | Ratio of meaningful layer names (not `Frame 123`, `Rectangle 4`) | className / role inference potential |

Running this metric like CI to score each PR (design change) shifts collaboration from "subjective comments" to "measurement-based feedback".

---

## One-line summary

> **".fig file quality is code quality. It is not solo designer work but a *shared artifact* refined by designer ↔ developer together, and its quality is measurable via wire signals."**

---

## Related documents

- [`wire-format-vs-design-intent-review.md`](./wire-format-vs-design-intent-review.md) — the primary verification report for this note
- `docs/specs/audit-oracle.spec.md` §7.1 — out-of-scope definitions
- `CONTEXT.md` — domain definitions for Component / Instance / Master / Override
