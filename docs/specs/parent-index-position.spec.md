# spec/parent-index-position

| 항목 | 값 |
|---|---|
| 상태 | Approved (Iteration 10) |
| 책임 모듈 | `src/fractional-index.ts` (신규) |
| 의존 | (순수 함수, 의존 없음) |
| 테스트 | `test/fractional-index.test.ts` |
| 부모 SPEC | [SPEC-roundtrip §4.3](../SPEC-roundtrip.md) |

## 1. 목적

Figma의 `parentIndex.position`은 **fractional indexing** 문자열이다. 형제 정렬 안정성을 위해 lexicographic 순서로 정렬되며, 두 형제 사이에 새 형제를 끼워넣을 때 둘 사이에 lexicographic으로 들어가는 새 문자열을 생성해야 한다.

본 spec은 그 알고리즘을 정의한다. (v2 노드 추가는 비목표지만 형제 순서 변경 / 삭제 후 잔여 형제 재정렬 시 필요)

## 2. 입력 / 출력

### 2.1 `between(a, b)` — 두 위치 사이의 새 위치

```ts
function between(a: string | null, b: string | null): string;
```

- `a`: 왼쪽 형제 position (없으면 null = 맨 앞)
- `b`: 오른쪽 형제 position (없으면 null = 맨 뒤)

반환: `a < result < b` (lexicographic) 인 새 문자열.

### 2.2 `regenerate(siblings)` — 형제 전체 position 재발급

```ts
function regenerate(siblingCount: number): string[];
```

- 입력: 형제 개수 N
- 반환: lexicographically increasing 길이 N의 배열 (균등 간격)

### 2.3 `compare(a, b)` — 정렬 비교

```ts
function compare(a: string, b: string): -1 | 0 | 1;
```

표준 string lex compare로 reduce.

## 3. Invariants

### I-1 between 단조성

```
∀ a, b (a < b):
   a < between(a, b) < b
```

null 처리:
- `between(null, b)`: result < b (맨 앞)
- `between(a, null)`: a < result (맨 뒤)
- `between(null, null)`: 임의 합리적 값 (e.g. "n")

### I-2 between 결정성

같은 입력 → 같은 출력.

### I-3 between 종결성 (성능)

string 길이가 한없이 늘어나지 않도록. `between("a", "b")` 같은 매우 가까운 위치도 합리적 길이의 새 문자열 (e.g. "an" 또는 "a~"). 최대 길이 제한 (~32 chars) 후엔 `regenerate` 권장.

### I-4 regenerate 균등

```
result = regenerate(n)
∀ i, j ∈ [0, n):
   i < j ⇒ result[i] < result[j]
```

균등 간격이라 향후 `between` 호출 시 길이 증가 안 정함.

### I-5 compare 일관성

```
∀ a, b: compare(a, b) === Math.sign(a < b ? -1 : a > b ? 1 : 0)
```

### I-6 ASCII 안전 알파벳

본 spec은 ASCII printable 범위 [0x20, 0x7E] 또는 그 부분 집합으로 동작. Figma 실제 데이터에서 관찰되는 문자 (`!`, `~`, 알파넣자, 숫자) 모두 처리 가능.

## 4. 알고리즘

### 4.1 Mid-point 방식 (추천)

`between(a, b)` 알고리즘 (Figma 관행 따름):

```
const ALPHABET = " !\"#$%&'()*+,-./0123456789:;<=>?@ABCDEFGHIJKLMNOPQRSTUVWXYZ[\\]^_`abcdefghijklmnopqrstuvwxyz{|}~";
//                ^ U+0020 ~ U+007E (95 chars)

function between(a, b):
  // Step 1: 길이 정렬 (짧은 쪽 패딩 — a는 minimum char, b는 maximum char로 패딩)
  const minLen = max(a?.length ?? 1, b?.length ?? 1);
  const aPadded = (a ?? "").padEnd(minLen, ALPHABET[0]);
  const bPadded = (b ?? "").padEnd(minLen, ALPHABET[ALPHABET.length - 1]);
  
  // Step 2: char 단위로 mid 찾기
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
      // 다음 char로 — 더 정밀하게
  
  // Step 3: 모든 prefix가 동일하면 더 깊이 → append minimum char + 1
  result += String.fromCharCode(ALPHABET.charCodeAt(0) + 1);  // !
  return result;
```

### 4.2 regenerate(n)

균등 간격으로 n개 위치 생성:

```
function regenerate(n):
  if n === 0: return []
  
  // 1글자로 충분하면 ASCII range를 균등 분할
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

- E-1: `between(a, b)`에서 `a >= b` (lex order 어긋남) → throw `Error("between: a must be < b")`
- E-2: `between` 결과 길이가 64 chars 초과 → throw `"between: position length exceeded; consider regenerate"`
- E-3: 알파벳 외 문자 사용 시 (NULL, control char) → throw

## 6. Out of Scope

- O-1: 노드 추가 (D-4) — 본 함수는 v3에서 사용. v2에서는 형제 삭제 후 잔여 형제의 position 재정렬에만 사용 가능 (단, 보통 그대로 둬도 OK)
- O-2: 다국어 / non-ASCII alphabet — 본 spec은 ASCII만
- O-3: 분산 환경 (여러 client가 동시에 between 호출) — 본 도구는 단일 client

## 7. 참조 자료

- Figma engineering blog: "Realtime Editing of Ordered Sequences" (fractional indexing 도입 배경)
- 알고리즘은 본 spec 안에 self-contained — 외부 라이브러리 의존 없음

## 8. 단위 테스트 예시 (참조용)

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
