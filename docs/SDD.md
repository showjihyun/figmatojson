# SDD — Spec-Driven Development

| 항목 | 값 |
|---|---|
| 문서 버전 | v1.0 |
| 작성일 | 2026-04-30 |
| 적용 대상 | figma-reverse v2 — [SPEC-roundtrip.md](./SPEC-roundtrip.md) |
| 자매 문서 | [HARNESS.md](./HARNESS.md) (검증 하네스) |

---

## 1. 정의

> **Spec-Driven Development (SDD)** — "구현 전에 입력·출력·invariant를 spec으로 명문화하고, 그 spec을 코드 검증의 기준으로 삼는 개발 방법론."

본 도구는 .fig 바이너리를 다루기 때문에 **자유로운 구현은 곧 무너진 round-trip**이 된다. SDD는:

1. **무엇을 만들지(WHAT)** 를 코드보다 먼저 명문화
2. **어떻게 만들지(HOW)** 는 spec이 정한 invariant를 만족하는 한 자유
3. **검증** 은 spec ↔ 코드 자동 비교

이 방법론은 [HARNESS.md](./HARNESS.md)와 짝을 이룬다 — spec이 invariant를 정의하면, harness가 그것을 자동 검증한다.

---

## 2. 워크플로

### 2.1 표준 SDD 사이클

```
┌──────────────────────────────────────────────────────┐
│  1. SPEC                                             │
│     docs/specs/<feature>.md 작성                     │
│     - 입력 / 출력 / invariant / error case           │
│  ▼                                                   │
│  2. TEST                                             │
│     test/<feature>.test.ts 작성                      │
│     - spec의 invariant를 검증 코드로 옮김             │
│     - 처음에는 실패 (구현 없음)                       │
│  ▼                                                   │
│  3. IMPL                                             │
│     src/<module>.ts 구현                             │
│     - test가 PASS될 때까지                            │
│     - spec 이외 정책 추가하지 않음 (YAGNI)            │
│  ▼                                                   │
│  4. VERIFY                                           │
│     npm test + npm run harness:*                     │
│     - L0~L3 통과 확인                                 │
│  ▼                                                   │
│  5. MERGE                                            │
└──────────────────────────────────────────────────────┘
```

### 2.2 어긋날 때 처리

| 상황 | 행동 |
|---|---|
| 구현 중 spec이 모호하거나 잘못됨 | spec 먼저 수정, 그 후 코드 (구현 도중 spec 우회 금지) |
| 새로운 edge case 발견 | spec에 추가 → test에 추가 → impl 갱신 |
| spec과 사용자 의도 차이 | 사용자에게 확인 → spec 수정 (코드 보다 spec이 source of truth) |

---

## 3. Spec 형식

### 3.1 디렉토리

```
docs/
├── SPEC-roundtrip.md         (전체 비전 — 본 문서의 source)
├── HARNESS.md
├── SDD.md (본 문서)
└── specs/                     ★ 기능별 micro-specs
    ├── editable-html.spec.md
    ├── html-to-message.spec.md
    ├── node-mapping.spec.md
    └── ...
```

### 3.2 Micro-spec 템플릿

```markdown
# spec/<feature>

| 항목 | 값 |
|---|---|
| 상태 | Draft / Approved / Implemented / Stable |
| 책임 모듈 | src/<module>.ts |
| 의존 | (다른 spec, 다른 모듈) |
| 테스트 | test/<feature>.test.ts |

## 1. 목적 (Purpose)
한 문장으로: "이 기능은 X를 받아 Y를 반환한다."

## 2. 입력 (Input)
- 형식, 타입, 제약
- 예시

## 3. 출력 (Output)
- 형식, 타입, 보장
- 예시

## 4. Invariants (★ 가장 중요)
모든 변경 사이에 깨지지 않아야 할 명제들.

- I-1: <명제 1>
- I-2: <명제 2>
- ...

각 invariant는 test/harness에서 자동 검증.

## 5. Error Cases
- E-1: <오류 조건 1> → <기대 행동>
- E-2: ...

## 6. Out of Scope (★ 명시)
이 spec이 책임지지 않는 것:
- O-1: ...

## 7. 참조
- 부모 spec, 관련 모듈, 표준
```

### 3.3 좋은 Spec의 특징

| 좋음 ✅ | 나쁨 ❌ |
|---|---|
| Invariant가 코드로 검증 가능 | "사용자가 만족해야 함" 같은 모호한 표현 |
| 입출력 형식이 결정적 | "적당히 합리적인 결과" |
| Error case가 enumerated | error 처리 미명시 |
| Out of scope가 명시 | "나중에 다 가능" |

---

## 4. 실제 예시 — 기존 코드의 사후 spec

기존 모듈의 spec을 사후적으로 작성해 놓으면, 향후 변경 시 회귀 방지에 도움.

### 예시: `archive.ts`의 spec (사후 작성)

```markdown
# spec/parse-fig-archive

| 상태 | Stable (v1에서 검증됨) |
| 책임 모듈 | src/archive.ts (parseFigArchive) |
| 테스트 | test/archive.test.ts (6 cases) |

## 1. 목적
fig-kiwi 컨테이너 byte를 받아 prelude·version·chunks로 분해.

## 2. 입력
- `data: Uint8Array` — fig-kiwi 컨테이너 (≥12 bytes)

## 3. 출력
- `FigArchive { prelude, version, chunks }`
- prelude: "fig-kiwi" (8 byte ASCII)
- version: LE uint32
- chunks: 가변 개수, 각 chunk는 `[4 byte LE size][size bytes]`

## 4. Invariants
- I-1: prelude !== "fig-kiwi"이면 throw
- I-2: 입력이 12 byte 미만이면 throw "too short"
- I-3: chunk size가 남은 bytes를 초과하면 throw
- I-4: parseFigArchive는 idempotent — 같은 입력 → 같은 출력 (sha256 동등)
- I-5: chunks 배열에 빈 chunk (size=0) 보존
- I-6: trailing bytes (마지막 chunk 이후 남은 byte)는 stderr에 경고만, throw 안 함

## 5. Error Cases
- E-1: 잘못된 prelude → Error("Invalid fig-kiwi prelude: ...")
- E-2: 입력 < 12 bytes → Error("fig archive too short")
- E-3: chunk size overflow → Error("Chunk #N size=X at offset=Y exceeds data length=Z")

## 6. Out of Scope
- O-1: chunk 내용 디코드 (decompress.ts·decoder.ts 책임)
- O-2: 압축 알고리즘 감지

## 7. 참조
- [SPEC.md §3.2 Stage 2](../SPEC.md)
```

이런 사후 spec이 있으면, 미래에 누가 `parseFigArchive`를 변경할 때 **무엇을 깨면 안 되는지 즉시 안다**.

---

## 5. v2 신규 작업의 spec (사전 작성)

본 SPEC v2는 새 모듈 두 개를 도입한다. SDD에 따라 **구현 전에** spec 작성:

### 5.1 `editable-html.ts` spec (작성 예정)

대상: `docs/specs/editable-html.spec.md`

핵심 invariants (예고):

- I-1: 모든 노드의 GUID가 HTML element의 `data-figma-id`로 등장
- I-2: 노드 트리의 parent-child 관계가 HTML DOM의 부모-자식 관계와 일치
- I-3: 편집 가능 필드는 `data-figma-editable` 속성에 명시됨
- I-4: 편집 불가 raw 필드는 sidecar `figma.editable.meta.js`에 보존
- I-5: 사용자가 HTML을 변경하지 않았다면 → 다시 message로 변환 시 원본과 동등 (round-trip identity)

### 5.2 `html-to-message.ts` spec (작성 예정)

대상: `docs/specs/html-to-message.spec.md`

핵심 invariants:

- I-1: HTML 입력에 `data-figma-id`가 있는 모든 element는 출력 message의 nodeChanges에 포함
- I-2: HTML에서 삭제된 element (sidecar에 있었으나 DOM에 없음) → phase = REMOVED
- I-3: HTML에서 추가된 element (data-figma-id 없음) → 새 GUID + phase = CREATED
- I-4: 편집 가능 CSS 속성이 변경되면 해당 raw 필드만 갱신, 다른 raw 필드는 보존
- I-5: 출력 message는 `kiwi.compileSchema(schema).encodeMessage(msg)`에 입력 가능

---

## 6. spec과 코드의 동기화

### 6.1 spec 변경 시

```
1. spec 수정 (PR title: "spec: <feature> — <change>")
2. test 변경 (또는 invariant 추가)
3. test 실행 → 실패 (의도적)
4. impl 변경
5. test 통과
6. PR 머지
```

### 6.2 spec 없이 코드 추가 금지

| 상황 | 정책 |
|---|---|
| 새 함수 추가 | 해당 모듈의 spec에 invariant 추가 (또는 새 spec 생성) |
| 기존 함수 시그니처 변경 | spec 먼저 수정 |
| 버그 수정 | spec에 누락된 invariant 발견 → spec 보강 → test 추가 → fix |
| 리팩토링 | spec 변경 0, test 변경 0, 모든 test PASS 유지 |

### 6.3 spec drift 감지

월 1회 (또는 매 마일스톤) 점검:

```
점검 항목:
  1. docs/specs/*.md 의 모든 invariant가 test로 표현되는가?
  2. 모든 src/*.ts 파일이 spec 1개 이상으로 커버되는가?
  3. test에는 있지만 spec에 없는 invariant 있는가? (있으면 spec에 backport)
```

자동화 후보 (v2 후반): spec 안의 `I-N` 라벨을 test 안 주석에 매칭해 cross-reference 보고서 생성.

---

## 7. SDD vs TDD 차이

| 측면 | TDD (Test-Driven) | SDD (Spec-Driven) |
|---|---|---|
| 시작점 | 실패하는 test | spec (markdown) |
| 코드와의 거리 | 가까움 (test가 implementation 거의 결정) | 멀음 (spec은 implementation에 자유 부여) |
| 변경 시점 | refactor가 자연스러움 | spec 수정이 무거움 (일종의 contract 변경) |
| 신규 vs 유지 | 유지 보수에 매우 유용 | 신규 개발에 매우 유용 |
| 본 도구 적합성 | 부분 적용 (이미 vitest로) | 매우 적합 (round-trip 도메인이라 invariant 명시 필수) |

본 프로젝트에선 **SDD를 메인, TDD를 보조**로 채택. spec이 invariant를 정의하면 test가 그것을 코드로 표현하고, refactor 시 test가 스펙 안전 가드.

---

## 8. 본 프로젝트에서 spec 우선 적용 영역

### 8.1 강한 SDD 적용 (spec 필수)

- 모든 byte-level 변환 (encode/decode)
- Round-trip 보장이 필요한 모듈 (repack, html-to-message)
- 외부 포맷 정의 (editable.html 형식)

### 8.2 약한 SDD 적용 (spec 권장)

- 헬퍼 함수
- 출력 포맷 (manifest, verification report) — 기존 SPEC.md로 갈음

### 8.3 SDD 미적용

- 1회용 스크립트
- 디버그 출력
- 개발 도중 임시 코드 (`_tmp_*.cjs` 등)

---

## 9. 협업 규칙

### 9.1 새 기여자 onboarding

```
1. README → SPEC-roundtrip.md → HARNESS.md → SDD.md (이 문서) 순서로 읽기
2. docs/specs/<feature>.md 1개 골라 읽기
3. 그 spec의 test/<feature>.test.ts 읽기
4. 그 spec의 src/<module>.ts 읽기
5. 작은 변경 시도 → 하네스 통과 확인
```

이 onboarding flow가 **spec ⇄ test ⇄ impl 삼각형**을 자연스럽게 보여줌.

### 9.2 PR 체크리스트

- [ ] 변경에 해당하는 spec 업데이트 했는가? (또는 신규 spec 작성)
- [ ] spec의 새 invariant가 test로 표현되는가?
- [ ] `npm test` PASS
- [ ] `npm run harness:roundtrip` PASS (코드 변경이 round-trip 영향 시)
- [ ] `npm run typecheck` PASS
- [ ] CHANGELOG 갱신 (사용자 영향 시)

---

## 10. 부록 — 빠른 참조

```
SDD 사이클
─────────────────────────────────────
1. docs/specs/<feature>.md 작성
2. test/<feature>.test.ts 작성 (실패)
3. src/<module>.ts 구현 (test 통과)
4. npm test + harness 통과
5. PR

Spec 형식
─────────────────────────────────────
1. 목적 (한 문장)
2. 입력 (형식·제약)
3. 출력 (형식·보장)
4. Invariants (I-1, I-2, ...) ★
5. Error cases (E-1, E-2, ...)
6. Out of scope (O-1, ...)

Iron Law
─────────────────────────────────────
"spec 없는 코드는 merge하지 않는다."
"spec과 test의 invariant는 1:1 대응한다."
"하네스가 통과해야 spec이 만족된 것이다."
```

---

Generated by figma-reverse · v2 SDD methodology
