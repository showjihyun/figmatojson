# HARNESS — Test Harness Engineering

| 항목 | 값 |
|---|---|
| 문서 버전 | v1.0 |
| 작성일 | 2026-04-30 |
| 적용 대상 | figma-reverse v2 (양방향 round-trip — [SPEC-roundtrip.md](./SPEC-roundtrip.md)) |
| 자매 문서 | [SDD.md](./SDD.md) (개발 방법론) |

---

## 1. 정의

> **Test Harness Engineering** = "사람이 손으로 검증할 일을 점진적으로 자동화 하네스로 옮기는 엔지니어링 활동."

본 도구는 양방향 round-trip이 핵심 기능이라 **검증을 자동화하지 않으면 변경마다 회귀 발생 위험**이 매우 높다. 모든 변경은:

```
변경 → 하네스 통과 → merge
       ▲
       │ 하네스가 자동으로:
       │  ① 35,660 노드 GUID 보존 확인
       │  ② 페이지 6개 트리 구조 동등 확인
       │  ③ 1599 SVG 모두 round-trip
       │  ④ 12 이미지 sha256 동등
       │  ⑤ V-01~V-12 자동 검증
       └───────────────────────
```

**Iron Law**: "하네스를 우회한 변경은 어떤 이유로도 merge하지 않는다."

---

## 2. 왜 하네스가 필요한가

| 우려 | 빈도 | 손실 |
|---|---|---|
| repack 모드에서 노드 1개 빠짐 (35,659 → 35,660) | 변경 시 흔함 | 사용자가 1개 노드 사라진 디자인 받음, 재현 어려움 |
| HTML → message 변환에서 raw 필드 일부 손실 | 변경 시 흔함 | Figma import 후 효과(blur 등) 사라짐 |
| 새 Figma archive version에서 schema 일부 변경 | 드뭄 | 도구 자체 동작 안 함 |
| 사용자 편집 후 GUID 충돌 | 종종 | 잘못된 노드가 사라지거나 중복 |
| zstd 디코드 결과 byte-level 미세 차이 | 매우 드뭄 | 디코드 후 의미는 같지만 sha 차이 |

수동 검증으로는:
- "Figma에서 열어보니 이상해"라는 막연한 보고만 가능
- 어느 단계에서 깨졌는지 추적 불가
- 변경자에게 "당신 변경이 깨뜨렸다"고 명확히 말하지 못함

하네스로:
- 깨지면 **CI에서 정확히 어느 검증 항목에서 실패**했는지 표시
- 변경자가 PR 머지 전에 **자기 변경이 어떤 invariant 깨는지** 알 수 있음
- 새 변경자도 **하네스만 통과하면 안전**하다고 신뢰 가능

---

## 3. 하네스 구조 (5 레이어)

### Layer 0 — Pure Unit Tests (즉시·1초 미만)

**목적**: 함수 단위 입력→출력 매핑 검증 (의존성 없음)

| 모듈 | 테스트 파일 | 검증 항목 |
|---|---|---|
| `archive.ts` | `test/archive.test.ts` | fig-kiwi prelude 검증, 청크 분해, 손상 감지 |
| `decompress.ts` | `test/decompress.test.ts` | deflate-raw / deflate-zlib / zstd 자동 분기, fallback chain |
| `tree.ts` | `test/tree.test.ts` | parent-child 트리 빌드, position 정렬, orphan 처리 |
| `assets.ts` | `test/assets.test.ts` | magic 기반 확장자, hashToHex 정확성 |
| `vector.ts` | `test/vector.test.ts` | commandsBlob 디코드 (MOVE/LINE/CUBIC/QUAD/CLOSE) |
| `container.ts` | `test/container.test.ts` | ZIP/raw 자동 분기 |
| `editable-html.ts` ★v2 | `test/editable-html.test.ts` | 노드 → HTML element 매핑 |
| `html-to-message.ts` ★v2 | `test/html-to-message.test.ts` | HTML element → message patch |

**기준**: 100% 통과, 8초 미만 실행, 모든 분기 커버.

### Layer 1 — Module Integration (10초 이내)

**목적**: 모듈 간 데이터 흐름 검증

| 통합 시나리오 | 검증 |
|---|---|
| `loadContainer` → `parseFigArchive` → `decodeFigCanvas` | 35,660 노드 디코드 |
| `decodeFigCanvas` → `buildTree` → `getPages` | 6 페이지 (CANVAS) 식별 |
| `buildTree` → `extractVectors` (with blobs) | 1599 SVG 생성 |
| `decodeFigCanvas` → `buildByteLevelFigBuffer` → `decodeFigCanvas` (round-trip) | 노드 수·schema 동등 |
| `editable-html.ts` → `html-to-message.ts` (편집 없이) ★v2 | 메시지 동등 |

**기준**: real sample (`docs/메타리치...fig`)으로 실행, 10초 이내, 변경 없는 경우 PASS.

### Layer 2 — Round-trip Harness (★ 핵심, 30초 이내)

**목적**: 양방향 변환의 invariant 검증

```
원본 .fig
  ↓ extract
extracted/ (5+1 단계 산출물)
  ↓ editable-html
figma.editable.html
  ↓ html-to-message (편집 없이)
새 message
  ↓ kiwi.encodeMessage + 압축 + ZIP
새 .fig
  ↓ extract (다시)
extracted'/

비교: extracted vs extracted'
  - 01_container/canvas.fig 동등성 ✅ (byte mode면 sha256 일치)
  - 04_decoded message.type 동등 (NODE_CHANGES)
  - 05_tree/nodes-flat.json: GUID 집합 동등, 노드 수 일치
  - 04_decoded/schema.json: 568 정의 동등
  - assets/images/* 동등
  - assets/vectors/* 개수 동등
```

**Invariants** (코드로 표현):

```typescript
// test/harness/roundtrip.harness.test.ts
describe('round-trip harness', () => {
  it('GUID set is identical after extract→html→fig→extract', () => {
    const a = guidsOf(extract(SAMPLE));
    const b = guidsOf(extract(htmlToFig(editableHtml(extract(SAMPLE)))));
    expect(symmetricDiff(a, b)).toEqual([]);
  });

  it('node tree shape preserved (parentGuid relationships)', () => {
    const a = treeShape(extract(SAMPLE));
    const b = treeShape(extract(htmlToFig(editableHtml(extract(SAMPLE)))));
    expect(b).toEqual(a);
  });

  it('image hashes preserved', () => {
    const a = imageHashes(extract(SAMPLE));
    const b = imageHashes(extract(htmlToFig(editableHtml(extract(SAMPLE)))));
    expect(b.sort()).toEqual(a.sort());
  });

  it('schema definitions preserved (568 types)', () => {
    expect(schemaDefCount(extract(htmlToFig(...)))).toBe(568);
  });
});
```

**기준**: 모든 invariant 통과. 어느 하나라도 실패면 변경 reject.

### Layer 3 — Edit Simulation Harness (★ 의도된 변형, 30초 이내)

**목적**: "사용자가 편집했을 때" 시나리오를 자동화

| 편집 시나리오 | 자동 변형 룰 | 검증 |
|---|---|---|
| **E1. 텍스트 일괄 교체** | 모든 TEXT 노드의 `innerText`를 "TRANSLATED" prefix 붙임 | 새 .fig 추출 시 모든 TEXT 노드의 characters에 prefix 있음 |
| **E2. 색상 swap** | 모든 SOLID fill의 R·B 채널 swap | 새 .fig 추출 시 모든 fill의 r·b 값이 swap됨 |
| **E3. 위치 평행 이동** | 모든 top-level frame의 left+100px | bbox.x가 +100 |
| **E4. 사이즈 2배** | 특정 노드의 width/height 2배 | size.x/y가 2배 |
| **E5. opacity 일괄 0.5** | 모든 노드 opacity 0.5 | raw.opacity = 0.5 |
| **E6. 노드 삭제** | 임의 leaf 노드 1개 DOM에서 제거 | message에 phase=REMOVED 등장 |
| **E7. 노드 추가** ★v2 후반 | 새 RECTANGLE 추가 | 새 GUID 생성, parentIndex.position 자동 |

**구조** (예시):

```typescript
// test/harness/edit-sim.harness.test.ts
async function simulate(
  scenario: 'E1' | 'E2' | ...,
  applyEdit: (html: string) => string,
  invariant: (newExtract: ExtractResult) => void,
) {
  const original = extract(SAMPLE);
  const html = editableHtml(original);
  const editedHtml = applyEdit(html);
  const newFig = htmlToFig(editedHtml);
  const newExtract = extract(newFig);
  invariant(newExtract);
}

it('E1: 텍스트 일괄 교체', async () => {
  await simulate('E1',
    (html) => html.replace(/<p class="fig-text"([^>]*)>([^<]+)<\/p>/g, '<p$1>TRANSLATED $2</p>'),
    (e) => {
      const texts = textNodes(e);
      expect(texts.every((t) => t.characters.startsWith('TRANSLATED'))).toBe(true);
    });
});
```

### Layer 4 — Figma Compatibility (수동, 분 단위)

**목적**: 실제 Figma가 우리가 만든 .fig를 받는지

자동화 어려움 (Figma는 GUI 앱이고 import API 미공개). **수동 체크리스트**:

| 항목 | 절차 | 합격 기준 |
|---|---|---|
| F1. 원본 byte-level repack 결과 import | Figma 데스크톱에서 Import → repacked.fig 선택 | 원본과 시각 동일하게 열림 |
| F2. kiwi 재인코드 결과 import | 동일 | 노드 수·내용 동일 |
| F3. 편집 안 한 editable.html → .fig import | 동일 | 원본과 의미 동등 |
| F4. E1 시나리오 (텍스트 교체) → .fig import | 동일 | 모든 텍스트가 "TRANSLATED" prefix |
| F5. 노드 추가 → .fig import | 동일 | 새 노드 보임 |

**문서화**: `.gstack/qa-reports/figma-import-{date}.md` 에 화면 캡처 + PASS/FAIL.

CI 자동화는 v3 (Figma plugin/headless 환경) 후보.

---

## 4. 메트릭 (Metrics)

하네스 결과를 정량화. 낮은 메트릭 → 변경 reject.

### 4.1 GUID 보존율 (Identity Preservation)

```
identityRate = |원본 GUID ∩ 결과 GUID| / |원본 GUID|
```

| 임계 | 정책 |
|---|---|
| `1.0` | merge 가능 |
| `[0.99, 1.0)` | warning, 사라진 GUID 명시 필요 (의도적 deletion 케이스만 허용) |
| `< 0.99` | reject |

### 4.2 트리 형태 동등성 (Tree Shape Equality)

```
shapeEqual = parent-child 관계 집합 동등
```

각 GUID에 대해 `(self, parentGuid)` 쌍의 집합이 같으면 동등. 100% 동등이 정상.

### 4.3 시각 fidelity (Pixel Diff, optional)

`thumbnail.png` 또는 페이지별 렌더 이미지 비교 (브라우저 렌더 vs 원본). v2에선 best-effort.

```
pixelDiffRate = (다른 픽셀 수) / (전체 픽셀 수)
```

| 임계 | 정책 |
|---|---|
| `< 0.01` (99% 동일) | PASS |
| `[0.01, 0.05)` | WARN |
| `>= 0.05` | INVESTIGATE |

### 4.4 메타 보존율 (Raw Field Preservation)

각 노드의 raw 필드 키 집합 비교.

```
metaRate = avg(|원본 raw 키 ∩ 결과 raw 키| / |원본 raw 키|, over all nodes)
```

| 임계 | 정책 |
|---|---|
| `>= 0.99` | merge 가능 |
| `[0.95, 0.99)` | warning |
| `< 0.95` | reject |

### 4.5 Schema 보존

```
schemaDefCount(결과) === schemaDefCount(원본)  // 568
schemaDefSet(결과) === schemaDefSet(원본)      // 정의 이름 집합
```

100% 일치 필수.

---

## 5. 테스트 데이터셋 (Fixtures)

### 5.1 기존 (v1)

- `docs/메타리치 화면 UI Design.fig` (5.77 MB, 35,660 노드, 6 페이지)

### 5.2 추가 권장 (v2)

상황별 fixture 추가하면 하네스 신뢰도 향상:

| Fixture | 목적 | 우선순위 |
|---|---|---|
| `fixtures/minimal.fig` | DOCUMENT + 1 CANVAS + 1 RECTANGLE만 | 🟢 high (디버깅 빠름) |
| `fixtures/text-heavy.fig` | TEXT 노드 100개+ (다국어 시나리오) | 🟢 high |
| `fixtures/vector-heavy.fig` | VECTOR + commandsBlob 다양 | 🟡 medium |
| `fixtures/components.fig` | SYMBOL + INSTANCE | 🟡 medium |
| `fixtures/effects.fig` | drop-shadow / blur / gradient | 🟢 high (편집 시 손실 가능 영역) |

각 fixture는 **무료 또는 자체 작성 디자인**이어야 함 (라이선스).

### 5.3 외부 의존 없는 합성 fixture

테스트 안에서 합성 가능한 최소 .fig:

```typescript
// test/fixtures/synth.ts
export function synthMinimalFig(): Uint8Array {
  // 코드로 .fig 합성
  // - schema는 sample에서 차용
  // - DOCUMENT + 1 CANVAS + 1 RECTANGLE만
  // - 모든 GUID 결정적 (재현 가능)
}
```

이렇게 하면 Layer 0 단위 테스트에서도 진짜 .fig 생성·디코드 가능.

---

## 6. CI 통합

### 6.1 GitHub Actions 워크플로 (제안)

```yaml
# .github/workflows/test.yml
name: Test
on: [push, pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - run: npm ci
      - name: Type check
        run: npm run typecheck
      - name: Layer 0 unit
        run: npm test
      - name: Layer 2 round-trip
        run: npm run harness:roundtrip
      - name: Layer 3 edit simulation
        run: npm run harness:edit-sim
      - name: Coverage
        run: npm run coverage
        if: always()
```

### 6.2 실패 시 출력 형식

```
🔴 Round-trip harness FAILED

Invariant: GUID set is identical
  Expected: 35,660 GUIDs
  Got:      35,659 GUIDs (1 missing)

Missing GUIDs:
  - 627:8805 (VECTOR, "icon-arrow")

This means a node was lost during the round-trip.
Likely cause: html-to-message.ts skipped fig-vector elements without commandsBlob fallback.

Steps to reproduce:
  npm run harness:roundtrip

Last known PASS: commit abc123 (2026-04-29)
Bisect candidates: commits def456..ghi789 changed src/html-to-message.ts
```

이런 메시지가 나와야 변경자가 즉시 어디 봤는지 안다.

### 6.3 성능 추적

각 하네스 실행 시간을 기록:

```
hardness/perf-history.jsonl
{"ts":"2026-04-30T...", "layer":"L2", "duration_ms":18200, "pass":true}
{"ts":"2026-05-01T...", "layer":"L2", "duration_ms":24500, "pass":true} ← 회귀 감지!
```

10% 이상 느려지면 PR에 경고 코멘트.

---

## 7. 회귀 방지 정책 (Iron Law)

| 상황 | 행동 |
|---|---|
| 하네스 한 개라도 FAIL | merge 금지 |
| 변경자가 invariant를 의도적으로 변경 (e.g. 노드 트리 구조 의도적 변경) | invariant 자체 업데이트 + 명시적 reviewer 승인 + CHANGELOG 기록 |
| 새 기능 추가 시 새 하네스 안 만듦 | merge 금지 (SDD 정책) |
| 시간이 오래 걸려서 하네스 skip | 절대 금지 (대신 fixture 줄여 빠르게) |

**예외 처리**: 정말 긴급한 보안 패치 등 — 사용자 직접 확인 후 `--bypass-harness` 플래그 사용 (CI에선 별도 알림).

---

## 8. 운영 (Daily Workflow)

### 8.1 개발자 흐름

```
1. 변경 작성
2. 로컬: npm test (L0+L1, ~10s)
3. 로컬: npm run harness:roundtrip (L2, ~20s)
4. 통과 → PR 생성
5. CI: L0~L3 자동 실행
6. 모두 통과 → review → merge
7. 정기 (월 1회): L4 (Figma 수동 import) 실행, 보고서 갱신
```

### 8.2 신규 기능 추가 흐름 (SDD와 결합 — [SDD.md](./SDD.md) 참조)

```
1. spec 작성 (docs/specs/<feature>.md)
2. spec에 invariant 명시
3. invariant를 코드로 표현 (test/harness/<feature>.harness.test.ts)
4. test 실행 → 실패 (당연, 미구현)
5. 구현
6. test 다시 → 통과
7. PR
```

---

## 9. 기존 vitest 활용

이미 [SPEC.md](./SPEC.md) v1에서 vitest 도입됨 (`test/` 8 파일, 62 tests). 본 하네스는 **vitest 위에 구축**:

- L0 단위 → 기존 `test/*.test.ts` (확장)
- L1 통합 → 기존 `test/e2e.test.ts` (확장)
- L2 round-trip → 신규 `test/harness/roundtrip.harness.test.ts`
- L3 edit sim → 신규 `test/harness/edit-sim.harness.test.ts`
- L4 Figma → 수동 (`.gstack/qa-reports/figma-import-*.md`)

`vitest.config.ts`에 harness 디렉토리 패턴 추가:

```typescript
test: {
  include: ['test/**/*.test.ts', 'test/harness/**/*.harness.test.ts'],
  testTimeout: 60_000,
  ...
}
```

`package.json` 스크립트:

```json
{
  "test": "vitest run test",
  "test:unit": "vitest run test --exclude 'test/harness/**'",
  "harness:roundtrip": "vitest run test/harness/roundtrip.harness.test.ts",
  "harness:edit-sim": "vitest run test/harness/edit-sim.harness.test.ts",
  "harness:all": "vitest run test/harness"
}
```

---

## 10. 부록 — 빠른 참조

```
하네스 명령 요약
─────────────────────────────────────
npm run test:unit         L0 단위 (8s)
npm test                  L0 + L1 (10s)
npm run harness:roundtrip L2 (20s)
npm run harness:edit-sim  L3 (30s)
npm run harness:all       L2 + L3 (50s)

수동 (월 1회)
.gstack/qa-reports/figma-import-{date}.md 작성
```

---

Generated by figma-reverse · v2 harness specification
