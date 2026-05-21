# spec/parent-index-position

| Item | Value |
|---|---|
| Status | Approved (Iteration 10) |
| Responsible module | `src/fractional-index.ts` (new) |
| Dependencies | (pure function, no dependencies) |
| Tests | `test/fractional-index.test.ts` |
| Parent SPEC | [SPEC-roundtrip §4.3](../SPEC-roundtrip.md) |

## 1. Purpose

Figma's `parentIndex.position` is a **fractional indexing** string. Siblings are sorted in lexicographic order for stable ordering, and when inserting a new sibling between two existing siblings, a new string that fits lexicographically between them must be generated.

This spec defines that algorithm. (Adding v2 nodes is a non-goal, but the algorithm is required when reordering siblings or rebalancing remaining siblings after deletion.)

## 2. Inputs / Outputs

### 2.1 `between(a, b)` — a new position between two positions

```ts
function between(a: string | null, b: string | null): string;
```

- `a`: left sibling position (null = at the front)
- `b`: right sibling position (null = at the back)

Returns: a new string such that `a < result < b` (lexicographic).

### 2.2 `regenerate(siblings)` — reissue positions for all siblings

```ts
function regenerate(siblingCount: number): string[];
```

- Input: sibling count N
- Returns: a lexicographically increasing array of length N (evenly spaced)

### 2.3 `compare(a, b)` — sort comparison

```ts
function compare(a: string, b: string): -1 | 0 | 1;
```

Reduces to standard string lex compare.

## 3. Invariants

### I-1 between monotonicity

```
∀ a, b (a < b):
   a < between(a, b) < b
```

null handling:
- `between(null, b)`: result < b (front)
- `between(a, null)`: a < result (back)
- `between(null, null)`: any reasonable value (e.g. "n")

### I-2 between determinism

Same input → same output.

### I-3 between termination (performance)

String length must not grow unbounded. Even for very close positions like `between("a", "b")`, the result should be a reasonable length (e.g. "an" or "a~"). After hitting the maximum length cap (~32 chars), `regenerate` is recommended.

### I-4 regenerate uniformity

```
result = regenerate(n)
∀ i, j ∈ [0, n):
   i < j ⇒ result[i] < result[j]
```

Even spacing keeps future `between` calls from inflating length.

### I-5 compare consistency

```
∀ a, b: compare(a, b) === Math.sign(a < b ? -1 : a > b ? 1 : 0)
```

### I-6 ASCII-safe alphabet

This spec operates on ASCII printable range [0x20, 0x7E] or a subset. All characters observed in actual Figma data (`!`, `~`, letters, digits) are handled.

## 4. Algorithm

### 4.1 Mid-point approach (recommended)

`between(a, b)` algorithm (follows Figma's convention):

```
const ALPHABET = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
//                ^ U+0020 ~ U+007E (95 chars)

function between(a, b):
  // Step 1: align lengths (pad shorter side — a with minimum char, b with maximum char)
  const minLen = max(a?.length ?? 1, b?.length ?? 1);
  const aPadded = (a ?? "").padEnd(minLen, ALPHABET[0]);
  const bPadded = (b ?? "").padEnd(minLen, ALPHABET[ALPHABET.length - 1]);
  
  // Step 2: find mid char-by-char
  let result = "";
  for (let i = 0; i < minLen; i++):
    const aChar = aPadded.charCodeAt(i);
    const bChar = bPadded.charCodeAt(i);
    const midChar = floor((aChar + bChar) / 2);
    
    if (midChar > aChar):
      result += String.fromCharCode(midChar);
      return result;
    else:
      result += String.fromCharCode(aChar);
      // continue to the next char — go deeper
  
  // Step 3: if all prefixes are equal, go deeper → append minimum char + 1
  result += String.fromCharCode(ALPHABET.charCodeAt(0) + 1);  // !
  return result;
```

### 4.2 regenerate(n)

Produce n evenly spaced positions:

```
function regenerate(n):
  if n === 0: return []
  
  // If 1 character is enough, divide the ASCII range evenly
  const aStart = ALPHABET.charCodeAt(0);   // 0x20 (space)
  const aEnd = ALPHABET.charCodeAt(ALPHABET.length - 1); // 0x7E (~)
  const range = aEnd - aStart;
  const step = range / (n + 1);
  
  return Array.from({length: n}, (_, i) => 
    String.fromCharCode(aStart + Math.round(step * (i + 1)))
  );
```

### 4.3 compare

```
function compare(a, b):
  return a < b ? -1 : a > b ? 1 : 0;
```

## 5. Error Cases

- E-1: `between(a, b)` where `a >= b` (lex order violated) → throw `Error("between: a must be < b")`
- E-2: `between` result length exceeds 64 chars → throw `"between: position length exceeded; consider regenerate"`
- E-3: characters outside the alphabet (NULL, control char) → throw

## 6. Out of Scope

- O-1: Node addition (D-4) — these functions are used in v3. In v2, they can only be used for rebalancing remaining siblings after deletion (although leaving them as-is is usually fine).
- O-2: Multilingual / non-ASCII alphabet — this spec is ASCII only
- O-3: Distributed environments (multiple clients calling between concurrently) — this tool is single-client

## 7. References

- Figma engineering blog: "Realtime Editing of Ordered Sequences" (background on fractional indexing adoption)
- The algorithm is self-contained within this spec — no external library dependency

## 8. Unit test examples (for reference)

```ts
describe('between', () => {
  it('between(null, null) returns a stable middle', () => {
    const r = between(null, null);
    expect(r.length).toBeGreaterThan(0);
  });

  it('between(a, b) for adjacent chars produces a longer string', () => {
    const r = between('a', 'b');
    expect(r > 'a').toBe(true);
    expect(r < 'b').toBe(true);
    expect(r.length).toBeGreaterThanOrEqual(2);
  });

  it('between is deterministic', () => {
    expect(between('a', 'c')).toBe(between('a', 'c'));
  });

  it('between is monotonic over many inserts', () => {
    let positions = ['a', 'z'];
    for (let i = 0; i < 100; i++) {
      const mid = between(positions[0], positions[1]);
      positions.splice(1, 0, mid);
    }
    for (let i = 0; i + 1 < positions.length; i++) {
      expect(positions[i] < positions[i + 1]).toBe(true);
    }
  });

  it('regenerate produces increasing sequence', () => {
    const r = regenerate(10);
    for (let i = 0; i + 1 < r.length; i++) {
      expect(r[i] < r[i + 1]).toBe(true);
    }
  });
});
```
