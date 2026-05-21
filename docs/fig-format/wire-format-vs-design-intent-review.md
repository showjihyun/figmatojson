# Figma `.fig` wire format vs. design intent — review notes

> Fact-check report on the blog / note draft ("Why aren't there any good Figma → code converters?").
> Uses our own codebase (`figma-reverse`) as primary evidence.

## Summary

- **The big-picture thesis (`wire format ≠ design intent`) is correct.**
- However, **about half of the 8 gaps listed are factually wrong or overstated**.
- The biggest misconception: many items described as *"insufficient expressiveness in the wire format"* are actually *"the designer did not use that expressiveness"*.
- The things our parser resolves at 99.47% accuracy are a counter-example to *"wire deficits"* — i.e. items that exist in the wire and we parse every time are described in the article as *"not in the wire"*.

---

## Verification summary table

| Claim in the article | Verdict | Evidence |
|---|---|---|
| There are many converters, none are satisfactory | ✅ Accurate | Market fact |
| `.fig` only has wire, no intent (overall thesis) | 🟡 Partially right | The wire holds more intent than the article describes |
| §7.1 citation ("vector geometry, paint, effects, prototyping out of scope") | ✅ Matches | `docs/specs/audit-oracle.spec.md:250–263` |
| Parser at 99.47% accuracy | ✅ Accurate | round 31 baseline (commit `690e856`) |
| **#1 Component boundary is not in the wire (only FRAME)** | ❌ **Wrong** | The wire explicitly carries `SYMBOL` / `COMPONENT` / `COMPONENT_SET` types (`src/masterIndex.ts:30`) |
| **#2 Cannot distinguish props vs variants** | 🟡 Partially true | `componentPropDefs` / `componentPropAssignments` / `componentPropRefs` all exist in the wire (`src/instanceOverrides.ts:287-303`) |
| **#3 State (hover, etc.) is not in the wire** | 🟡 Half-wrong | Prototype reactions (hover triggers, etc.) exist in .fig. Our §7.1 simply marks them "out of scope" |
| #4 No responsive rules | ✅ Accurate | Breakpoint info really is not in the wire |
| **#5 Design token mapping is hard** | ❌ Partly wrong | `boundVariables` / variable alias chains are explicit in the wire. `buildColorVarResolver()` already traces 16 levels deep (`src/pen-export.ts:227-254`) |
| #6 Data vs layout not separated | ✅ Accurate | No dynamic-vs-static text signal in the wire |
| #7 CSS impedance mismatch | ✅ Accurate | Except: with Auto-layout, the flex mapping is clean |
| #8 No semantics / accessibility | ✅ Accurate | No semantic HTML, no aria-* info |
| Designer-style dependency | ✅ Accurate | The percentages in the table are qualitative estimates (no public benchmark) |
| LLM reasoning is the future game-changer | 🟡 Direction is right | "The 99.47% is not 99.47% of intent" contains a category error |

---

## 1. ❌ "Component boundary is not in the wire" — the biggest factual error

**Article claim**

> "The wire is just a FRAME tree. *Where one component ends and another begins* is not marked in the wire."

**Verification**

The node `type` field of `.fig` explicitly carries this. Our code uses it directly:

```ts
// src/masterIndex.ts:30
if (n.type === 'SYMBOL' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET')
```

- `SYMBOL` — Figma's internal kiwi alias for Component
- `COMPONENT` — Component master
- `COMPONENT_SET` — Variants set
- `INSTANCE` — Component usage site

These 4 types are explicit in the wire. Only when the designer *did not create* a Component does it fall back to FRAME.

**Accurate phrasing**

> "If the designer did not create a Component, the wire only has a FRAME tree. If they did, it is explicitly marked in the wire."

**Implication**

The location of the deficit is not *the wire's expressiveness* but *the designer's usage*. This connects cleanly with the "designer-style dependency" table in the latter half of the article.

---

## 2. 🟡 "Props vs design variants" — half is answered by the wire

**Article claim**

> "If two instances of the same Card differ in width — is that a `width` prop, or did the designer just draw them differently on different screens? You can't tell from the wire alone."

**Verification**

Figma's Component Properties system is in the wire:

- `componentPropDefs[]` — Master's prop definitions (name + type)
- `componentPropAssignments[]` — Values the Instance assigned to props
- `componentPropRefs[]` — Which node in the Master receives which prop (e.g. visibility binding)

Our code uses these directly:

```ts
// src/instanceOverrides.ts:287-303
// effectiveVisibility.ts:37
// componentPropAssignments → componentPropRefs[VISIBLE] match
```

So when the Card master defines a `width: NUMBER` prop and Instance A has `componentPropAssignments[width]=200`, B has `=400` — that is **clearly prop usage**. The wire answers.

**Where the wire genuinely cannot answer**: the designer *did not create* a Component Property and changed width via overrides only. This matches the article's claim.

**What §7.1 "out of scope" means**

audit-oracle §7.1 lists `componentPropDefs / componentPropAssignments` as "out of scope" because:

> "The shape exposed by Figma's plugin API is not 1:1-aligned with our kiwi fields" (audit-oracle.spec.md:254)

→ This is an **audit comparison issue**, not a decoding issue. The article cites §7.1 as evidence of "wire deficit", which is incorrect.

---

## 3. 🟡 "State info is not in the wire" — prototype data is there

**Article claim**

> "Static designs usually only draw the default state. The only signal is the designer giving a separate frame a *name* like 'Button/Hover'."

**Verification**

`.fig` explicitly contains prototype reactions. Kiwi fields corresponding to Figma Plugin API's `node.reactions`:

- `trigger: { type: "ON_HOVER" | "ON_CLICK" | "ON_PRESS" | ... }`
- `action: { type: "NODE", destinationId: "...", transition: { ... } }`

When the designer draws a prototype connector, the intent — *"on hover, transition to this frame"* — is in the wire as-is.

**What §7.1 "prototyping / interaction / reactions out of scope" means**

The phrasing at `audit-oracle.spec.md:257` — *"out of scope because it is not in the wire"* — is not what it means; it means *"our parser does not handle it this round"*. The article citing this as evidence of "wire deficit" is a mismatch.

**Realistic adjustment**

Most designers do not carefully draw prototypes, so the signal is *effectively* absent. The accurate phrasing is *"if the designer does not draw a prototype, it is effectively absent"* — not *"it is not in the wire"*.

---

## 4. ❌ "Design token mapping is hard to trace" — overstated

**Article claim**

> "`fillPaints[0].color = #3B82F6` is in the wire — but is that `var(--brand-blue-500)`, `theme.colors.primary`, or just a hard-coded color? Only designers who use Figma Variables *systematically* can be traced."

**Verification**

When Variables are used, the wire explicitly carries the alias. Our code resolves it directly:

```ts
// src/pen-export.ts:227-254
function buildColorVarResolver() {
  // paint.colorVar.alias.guid (sessionID:localID)
  // → follow alias chain up to 16 levels deep to determine the actual color
  // → cache
}
```

Recent commit `9d99959` factored this out as the `resolveVariableChain` helper.

**Actual wire branches**

| Designer used Variables? | Information left in the wire | Token mapping possibility |
|---|---|---|
| ✅ Used | `paint.colorVar.alias.guid` (Variable identifier) | Can be traced down to collection / variable name |
| ❌ Not used | Raw hex only | Completely lost — scattered color codes |

The article lumps the two cases as "the wire is silent", but the wire actually distinguishes them clearly.

---

## 5. ✅ The big-picture thesis is right — but the phrasing should be precise

**Article conclusion**

> ".fig is a file that only contains 'the picture', not a spec for 'how to turn this into code'."

**Assessment**

The conclusion itself is accurate. Reflecting the adjustments to #1·#2·#3·#5, a more precise phrasing is:

> ".fig contains as much intent as the designer *typed in*.
> Designs that aggressively use Component / Variant / Variable / Prototype hold rich intent in the wire;
> designs that do not just leave the picture.
> In other words, **the cause of the deficit is not the wire format's lack of expressiveness, but the designer not using that expressiveness**."

This connects cleanly with the *"convertibility varies wildly by designer style"* table later in the article. The 8-gap framing in the early part has a tone that sounds like *"limitations of the wire itself"*, which subtly conflicts with the later half.

---

## 6. ✅ The accurate parts (keep as is)

The following items pass verification:

- **#4 No responsive transition rules** — Even with Auto-layout + Constraints, breakpoint translation really is not in the wire.
- **#6 Dynamic vs static text** — Whether `text: "John Doe"` is a prop or static is silent in the wire.
- **#7 CSS impedance mismatch** — Accurate for absolute-positioned designs without Auto-layout. Auto-layout designs map relatively cleanly to flex.
- **#8 Semantic HTML / a11y** — No `<button>` semantics, no `aria-*`, no focus-order signal.
- **Heuristic (Anima/Locofy) vs LLM (Visual Copilot/v0) categorization** — Accurate.
- **Designer-style dependency** — Qualitatively accurate. The *%* numbers in the table have no public benchmark (read them as qualitative estimates).

---

## 7. 🟡 A subtle leap in the "LLM future" conclusion

**Article claim**

> "Even if our parser resolves the wire at 99.47% accuracy, that 99.47% doesn't capture 99.47% of the code *intent* — it might be less than 50%."

**Verification**

The precise meaning of 99.47%: *"the ratio at which our round-trip result matches Figma plugin API's dump"* (audit-oracle baseline round 31). It is *not* the *"designer-intent capture rate"*.

The two numbers are not on the same axis, so the comparison *"99.47% holds intent"* is itself a category error. The *"might be less than 50%"* is an intuitive rebuttal, but the logic structure does not line up.

**More accurate framing**

> "99.47% is wire-format decoding accuracy, not designer-intent capture rate.
> Intent-capture rate is a separate axis and varies dramatically with the designer's working style."

**The LLM-utility conclusion is reasonable**

> "Giving the LLM the node tree + Auto-layout + Variable references together produces more accurate code."

→ Framing our parser's output as *enriched context* for LLM code generation as its largest value is accurate and forward-looking.

---

## Recommended edits

If publishing as a blog / note, fixing these 3 strengthens the thesis's consistency:

1. **#1 (component boundary)**:
   - Before: "the wire is only FRAME"
   - After: "if the designer did not create a Component, it falls back to FRAME. If they did, it is explicit in the wire as `SYMBOL` / `COMPONENT` / `COMPONENT_SET`"

2. **#3 (state)**:
   - Remove the §7.1 citation
   - Adjust the tone to: "if the designer did not draw a hover connector via prototype, it really is absent. Since this case is rare, it is effectively absent in practice"

3. **#5 (tokens)**:
   - Distinguish the two cases clearly: "if Variables are used, the wire contains the alias chain explicitly and can be traced. If not, only hex remains"

The strength of the overall thesis is not reduced — on the contrary, framing it as **"not a limit of the wire, but the designer not using its expressiveness"** flows cleanly into the later designer-style dependency table and strengthens the article's consistency.

---

## Appendix: primary verification sources

- `docs/specs/audit-oracle.spec.md` §7.1 (lines 250–263) — explicit out-of-scope
- `src/masterIndex.ts:30` — Component type indexing
- `src/instanceOverrides.ts:243–245, 287–303` — auto-layout fields + componentPropAssignments handling
- `src/pen-export.ts:227–254` — `buildColorVarResolver` (Variable alias chain)
- `src/pen-export.ts:396–430` — auto-layout decoding (`stackMode`, `stackSpacing`, `stackPadding*`, `stackPrimaryAlignItems`)
- `docs/PRD.md:18, 37` — Dev Mode / Variables paid-plan dependency, Figma Make `.make` container
- `docs/adr/0002-roundtrip-equality-tiers.md:3–8` — lossless promise
- `docs/adr/0003-rendering-strategy-reverse-vs-figma-api.md:18–43` — REST API limitations → offline parsing justification
- Recent commit `9d99959` — `resolveVariableChain` helper extraction
- Baseline: round 31, commit `690e856`, 704 / 18,304 = 99.47%
