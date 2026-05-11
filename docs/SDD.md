# SDD — Spec-Driven Development

| Item | Value |
|---|---|
| Document version | v1.0 |
| Written | 2026-04-30 |
| Applies to | figma-reverse v2 — [SPEC-roundtrip.md](./SPEC-roundtrip.md) |
| Sibling doc | [HARNESS.md](./HARNESS.md) (verification harness) |

---

## 1. Definition

> **Spec-Driven Development (SDD)** — "the practice of writing inputs · outputs · invariants down as a spec before implementation, then using that spec as the standard for code verification."

Because this tool handles `.fig` binaries, **free-form implementation is a broken round-trip**. SDD:

1. Articulates **what to build (WHAT)** before code
2. Leaves **how to build it (HOW)** free, as long as the spec's invariants are satisfied
3. **Verifies** by automatically comparing spec ↔ code

This methodology pairs with [HARNESS.md](./HARNESS.md) — the spec defines invariants, and the harness verifies them automatically.

---

## 2. Workflow

### 2.1 Standard SDD cycle

```
┌──────────────────────────────────────────────────────┐
│  1. SPEC                                             │
│     Write docs/specs/<feature>.md                    │
│     - input / output / invariants / error cases      │
│  ▼                                                   │
│  2. TEST                                             │
│     Write test/<feature>.test.ts                     │
│     - move the spec's invariants into verification code │
│     - initially fails (no implementation yet)        │
│  ▼                                                   │
│  3. IMPL                                             │
│     Implement src/<module>.ts                        │
│     - until the test PASSes                          │
│     - no policies beyond the spec (YAGNI)            │
│  ▼                                                   │
│  4. VERIFY                                           │
│     npm test + npm run harness:*                     │
│     - confirm L0~L3 pass                             │
│  ▼                                                   │
│  5. MERGE                                            │
└──────────────────────────────────────────────────────┘
```

### 2.2 What to do when things drift

| Situation | Action |
|---|---|
| Spec is ambiguous or wrong during implementation | Fix the spec first, then the code (never bypass the spec mid-implementation) |
| New edge case discovered | Add to spec → add to test → update impl |
| Spec disagrees with user intent | Confirm with user → revise spec (spec is the source of truth, not code) |

---

## 3. Spec format

### 3.1 Directory

```
docs/
├── SPEC-roundtrip.md         (overall vision — source of this doc)
├── HARNESS.md
├── SDD.md (this document)
└── specs/                     ★ per-feature micro-specs
    ├── editable-html.spec.md
    ├── html-to-message.spec.md
    ├── node-mapping.spec.md
    └── ...
```

### 3.2 Micro-spec template

```markdown
# spec/<feature>

| Item | Value |
|---|---|
| Status | Draft / Approved / Implemented / Stable |
| Owning module | src/<module>.ts |
| Dependencies | (other specs, other modules) |
| Test | test/<feature>.test.ts |

## 1. Purpose
In one sentence: "This feature takes X and returns Y."

## 2. Input
- Format, type, constraints
- Examples

## 3. Output
- Format, type, guarantees
- Examples

## 4. Invariants (★ most important)
Statements that must not be broken across changes.

- I-1: <statement 1>
- I-2: <statement 2>
- ...

Each invariant is automatically verified in test / harness.

## 5. Error Cases
- E-1: <error condition 1> → <expected behavior>
- E-2: ...

## 6. Out of Scope (★ explicit)
What this spec does not cover:
- O-1: ...

## 7. References
- Parent spec, related modules, standards
```

### 3.3 Characteristics of a good spec

| Good ✅ | Bad ❌ |
|---|---|
| Invariants verifiable by code | Vague phrases like "user should be happy" |
| Deterministic I/O formats | "Some reasonable output" |
| Enumerated error cases | Unspecified error handling |
| Explicit out-of-scope | "Everything possible later" |

---

## 4. Concrete example — retroactive spec for existing code

Writing specs retroactively for existing modules helps prevent regressions during future changes.

### Example: `archive.ts` spec (written after the fact)

```markdown
# spec/parse-fig-archive

| Status | Stable (verified in v1) |
| Owning module | src/archive.ts (parseFigArchive) |
| Test | test/archive.test.ts (6 cases) |

## 1. Purpose
Receives the fig-kiwi container bytes and splits them into prelude · version · chunks.

## 2. Input
- `data: Uint8Array` — the fig-kiwi container (≥12 bytes)

## 3. Output
- `FigArchive { prelude, version, chunks }`
- prelude: "fig-kiwi" (8-byte ASCII)
- version: LE uint32
- chunks: variable count; each chunk is `[4 byte LE size][size bytes]`

## 4. Invariants
- I-1: throw if prelude !== "fig-kiwi"
- I-2: throw "too short" if input is < 12 bytes
- I-3: throw if chunk size exceeds the remaining bytes
- I-4: parseFigArchive is idempotent — same input → same output (sha256 equal)
- I-5: preserve empty chunks (size=0) in the chunks array
- I-6: trailing bytes (after the last chunk) emit a stderr warning only; no throw

## 5. Error Cases
- E-1: bad prelude → Error("Invalid fig-kiwi prelude: ...")
- E-2: input < 12 bytes → Error("fig archive too short")
- E-3: chunk size overflow → Error("Chunk #N size=X at offset=Y exceeds data length=Z")

## 6. Out of Scope
- O-1: decoding the chunk contents (the responsibility of decompress.ts · decoder.ts)
- O-2: detecting the compression algorithm

## 7. References
- [SPEC.md §3.2 Stage 2](../SPEC.md)
```

A retroactive spec like this tells future modifiers of `parseFigArchive` **what they must not break, immediately**.

---

## 5. Specs for v2 new work (written upfront)

This SPEC v2 introduces two new modules. Per SDD, write specs **before** implementing:

### 5.1 `editable-html.ts` spec (to be written)

Target: `docs/specs/editable-html.spec.md`

Core invariants (preview):

- I-1: Every node's GUID appears as `data-figma-id` on an HTML element
- I-2: The node tree's parent-child relations match the HTML DOM's parent-child relations
- I-3: Editable fields are declared in the `data-figma-editable` attribute
- I-4: Non-editable raw fields are preserved in the sidecar `figma.editable.meta.js`
- I-5: If the user does not modify the HTML → conversion back to message equals the original (round-trip identity)

### 5.2 `html-to-message.ts` spec (to be written)

Target: `docs/specs/html-to-message.spec.md`

Core invariants:

- I-1: Every element with `data-figma-id` in the HTML input is included in the output message's nodeChanges
- I-2: Elements deleted from HTML (present in sidecar but not in DOM) → phase = REMOVED
- I-3: Elements added in HTML (no data-figma-id) → new GUID + phase = CREATED
- I-4: When an editable CSS property changes, update only the corresponding raw field; preserve every other raw field
- I-5: The output message can be fed into `kiwi.compileSchema(schema).encodeMessage(msg)`

---

## 6. Keeping spec and code in sync

### 6.1 When the spec changes

```
1. Edit the spec (PR title: "spec: <feature> — <change>")
2. Edit the test (or add an invariant)
3. Run the test → fails (intentional)
4. Update the impl
5. Test passes
6. Merge the PR
```

### 6.2 No code without a spec

| Situation | Policy |
|---|---|
| Add a new function | Add an invariant to the owning module's spec (or create a new spec) |
| Change the signature of an existing function | Update the spec first |
| Bug fix | Discover the missing invariant → augment the spec → add test → fix |
| Refactor | 0 spec changes, 0 test changes; all tests must keep passing |

### 6.3 Detect spec drift

Once a month (or per milestone) check:

```
Audit items:
  1. Is every invariant in docs/specs/*.md expressed as a test?
  2. Is every src/*.ts file covered by at least one spec?
  3. Any invariants in tests not in specs? (If so, backport to specs)
```

Automation candidate (v2 later): match `I-N` labels in specs to test-file comments to generate a cross-reference report.

---

## 7. SDD vs TDD differences

| Aspect | TDD (Test-Driven) | SDD (Spec-Driven) |
|---|---|---|
| Starting point | A failing test | A spec (markdown) |
| Distance to code | Close (the test largely determines the implementation) | Far (the spec leaves implementation free) |
| When to change | Refactor naturally | Spec edits are heavy (contract-level changes) |
| New vs. maintenance | Very useful for maintenance | Very useful for new development |
| Fit for this tool | Partial (already covered by vitest) | A very strong fit (round-trip domain demands explicit invariants) |

This project adopts **SDD as primary, TDD as secondary**. The spec defines invariants, tests express them in code, and during refactors tests act as guardrails.

---

## 8. Where to apply spec-first in this project

### 8.1 Strong SDD (spec required)

- Every byte-level conversion (encode/decode)
- Modules that need round-trip guarantees (repack, html-to-message)
- External format definitions (editable.html format)

### 8.2 Weak SDD (spec recommended)

- Helper functions
- Output formats (manifest, verification report) — already covered by existing SPEC.md

### 8.3 SDD not applied

- One-off scripts
- Debug output
- Temporary code during development (`_tmp_*.cjs`, etc.)

---

## 9. Collaboration rules

### 9.1 Onboarding new contributors

```
1. Read in this order: README → SPEC-roundtrip.md → HARNESS.md → SDD.md (this doc)
2. Pick one docs/specs/<feature>.md and read it
3. Read that spec's test/<feature>.test.ts
4. Read that spec's src/<module>.ts
5. Attempt a small change → confirm the harness passes
```

This onboarding flow naturally surfaces the **spec ⇄ test ⇄ impl triangle**.

### 9.2 PR checklist

- [ ] Did you update the spec corresponding to the change? (Or write a new spec)
- [ ] Are new invariants in the spec expressed as tests?
- [ ] `npm test` PASSes
- [ ] `npm run harness:roundtrip` PASSes (when the change affects round-trip)
- [ ] `npm run typecheck` PASSes
- [ ] CHANGELOG updated (when user-visible)

---

## 10. Appendix — quick reference

```
SDD cycle
─────────────────────────────────────
1. Write docs/specs/<feature>.md
2. Write test/<feature>.test.ts (fails)
3. Implement src/<module>.ts (test passes)
4. npm test + harness pass
5. PR

Spec format
─────────────────────────────────────
1. Purpose (one sentence)
2. Input (format · constraints)
3. Output (format · guarantees)
4. Invariants (I-1, I-2, ...) ★
5. Error cases (E-1, E-2, ...)
6. Out of scope (O-1, ...)

Iron Law
─────────────────────────────────────
"No code is merged without a spec."
"Spec invariants and tests are 1:1."
"The spec is satisfied only if the harness passes."
```

---

Generated by figma-reverse · v2 SDD methodology
