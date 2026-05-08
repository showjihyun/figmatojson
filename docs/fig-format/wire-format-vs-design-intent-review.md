# Figma `.fig` wire format vs. 디자인 의도 — 검토 노트

> 블로그/노트 초안 ("왜 좋은 Figma → code 컨버터가 없나") 에 대한 사실 검증 보고서.
> 우리 자신의 codebase (`figma-reverse`) 를 1차 근거로 사용.

## 결론 요약

- **큰 그림 thesis (`wire format ≠ design intent`) 는 정확.**
- 그러나 본문에서 든 **8개 gap 중 절반은 사실과 다르거나 과장**되어 있음.
- 가장 큰 오해: *"wire format 의 표현력 부족"* 으로 묘사된 항목 다수가 실제로는 *"디자이너가 그 표현력을 사용하지 않은 결손"*.
- 우리 parser 가 99.47% 정확도로 풀고 있는 것이 *"wire 결손"* 의 반례 — 즉 wire 에 들어있어도 우리가 매번 파싱하는 항목들이 글에서는 "wire 에 없음" 으로 묘사됨.

---

## 검증 요약 표

| 본문 주장 | 판정 | 근거 |
|---|---|---|
| 컨버터는 많은데 만족스러운 게 없다 | ✅ 정확 | 시장 사실 |
| `.fig` 는 wire 만 있고 intent 가 없다 (전체 thesis) | 🟡 부분적으로 맞음 | wire 에 intent 가 글이 묘사하는 것보다 많이 들어있음 |
| §7.1 인용 ("vector geometry, paint, effects, prototyping 비대상") | ✅ 일치 | `docs/specs/audit-oracle.spec.md:250–263` |
| Parser 99.47% 정확도 | ✅ 정확 | round 31 baseline (commit `690e856`) |
| **#1 컴포넌트 경계가 wire 에 없다 (FRAME 뿐)** | ❌ **틀림** | wire 에 `SYMBOL` / `COMPONENT` / `COMPONENT_SET` 타입이 명시 (`src/masterIndex.ts:30`) |
| **#2 Props vs 변형 구분 불가** | 🟡 부분 사실 | `componentPropDefs` / `componentPropAssignments` / `componentPropRefs` 모두 wire 에 존재 (`src/instanceOverrides.ts:287-303`) |
| **#3 상태 (hover 등) wire 에 없음** | 🟡 반은 틀림 | Prototype reactions (hover trigger 등) 는 .fig 에 존재. 우리 §7.1 에서 "비대상" 으로 뒀을 뿐 |
| #4 반응형 룰 없음 | ✅ 정확 | breakpoint 정보는 wire 에 정말 없음 |
| **#5 디자인 토큰 매핑 어려움** | ❌ 부분 틀림 | `boundVariables` / variable alias chain wire 에 명시. `buildColorVarResolver()` 가 16-depth 추적 중 (`src/pen-export.ts:227-254`) |
| #6 데이터 vs 레이아웃 분리 | ✅ 정확 | 동적 텍스트 vs 정적 텍스트 신호 wire 에 없음 |
| #7 CSS 임피던스 미스매치 | ✅ 정확 | 단, Auto-layout 사용 시는 flex 매핑 깔끔 |
| #8 시맨틱/접근성 부재 | ✅ 정확 | semantic HTML, aria-* 정보 없음 |
| 디자이너 스타일 의존성 | ✅ 정확 | 표의 % 수치는 정성적 추정 (공개 벤치마크 없음) |
| LLM 추론이 미래 게임 체인저 | 🟡 방향은 맞음 | "99.47% 가 의도를 담고 있는 게 아니다" 라는 표현에 카테고리 에러 존재 |

---

## 1. ❌ "컴포넌트 경계가 wire 에 없다" — 가장 큰 사실 오류

**본문 주장**

> "wire 엔 그냥 FRAME 트리만 있어요. *어디까지가 한 컴포넌트인지* 가 wire 에 표시되지 않습니다."

**검증**

`.fig` 의 노드 `type` 필드에 명시적으로 들어 있음. 우리 코드가 직접 사용 중:

```ts
// src/masterIndex.ts:30
if (n.type === 'SYMBOL' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET')
```

- `SYMBOL` — Figma 내부에서 Component 의 kiwi alias
- `COMPONENT` — Component master
- `COMPONENT_SET` — Variants 묶음
- `INSTANCE` — Component 사용처

이 4개 타입이 wire 에 explicit. 디자이너가 Component 를 *만들지 않은* 경우만 FRAME 으로 떨어짐.

**정확한 표현**

> "디자이너가 Component 를 안 만든 경우 FRAME 트리만 있고, 만든 경우 wire 에 explicit 하게 명시된다."

**의미**

결손의 위치가 *wire 의 표현력* 이 아니라 *디자이너의 사용* 임. 글 후반의 "디자이너 스타일 의존성" 표와 정합적으로 이어짐.

---

## 2. 🟡 "Props vs 디자인 변형의 구분" — 절반은 wire 가 답한다

**본문 주장**

> "같은 Card 의 두 인스턴스가 너비가 다르면 — 그게 `width` prop 인가, 그냥 다른 화면이라 다르게 그린 건가? wire 만 봐선 모릅니다."

**검증**

Figma 의 Component Properties 시스템이 wire 에 들어있음:

- `componentPropDefs[]` — Master 의 prop 정의 (이름 + 타입)
- `componentPropAssignments[]` — Instance 가 prop 에 부여한 값
- `componentPropRefs[]` — Master 의 어느 노드가 어느 prop 을 받는지 (예: visibility binding)

우리 코드가 직접 사용:

```ts
// src/instanceOverrides.ts:287-303
// effectiveVisibility.ts:37
// componentPropAssignments → componentPropRefs[VISIBLE] 매칭
```

따라서 Card master 가 `width: NUMBER` prop 을 정의했고, Instance A 가 `componentPropAssignments[width]=200`, B 가 `=400` 이면 — **그건 명백히 prop 사용**. wire 가 답해줌.

**진짜로 wire 가 답하지 못하는 경우**: 디자이너가 Component Property 를 *안 만든 채로* override 만으로 너비를 바꾼 경우. 이건 본문 주장과 일치.

**§7.1 "out of scope" 의 의미**

audit-oracle §7.1 에서 `componentPropDefs / componentPropAssignments` 를 "비대상" 으로 둔 이유는:

> "Figma plugin API 가 노출하는 형식과 우리 kiwi 필드의 정렬이 1:1 이 아니어서" (audit-oracle.spec.md:254)

→ 디코딩 문제가 아니라 **audit 비교 문제**. 글에서 §7.1 인용이 "wire 결손" 의 근거로 잘못 쓰임.

---

## 3. 🟡 "상태 정보가 wire 에 없다" — Prototype 데이터는 있음

**본문 주장**

> "정적 디자인에는 보통 default 상태만 그려져 있어요. 디자이너가 'Button/Hover' 같은 *이름* 으로 별도 frame 을 만들어두는 게 유일한 단서."

**검증**

`.fig` 에는 prototype reactions 가 명시적으로 들어있음. Figma Plugin API 의 `node.reactions` 에 대응하는 kiwi 필드:

- `trigger: { type: "ON_HOVER" | "ON_CLICK" | "ON_PRESS" | ... }`
- `action: { type: "NODE", destinationId: "...", transition: { ... } }`

디자이너가 prototype 연결선을 그려두면 *"hover 시 이 frame 으로 전환"* 같은 의도가 wire 에 그대로 들어감.

**§7.1 "prototyping / interaction / reactions 비대상" 의 의미**

`audit-oracle.spec.md:257` 의 표현 — *"wire 에 없어서 비대상"* 이 아니라 *"이번 라운드에서 우리 parser 가 안 다룬다"* 는 의미. 글에서 이 인용을 "wire 결손" 의 근거로 쓴 것은 의미가 어긋남.

**현실적인 조정**

대부분 디자이너가 prototype 을 정성껏 그리지 않으므로 *사실상* 신호가 없는 셈. 다만 표현은 *"wire 에 없다"* 가 아니라 *"디자이너가 prototype 을 그리지 않으면 사실상 없다"* 가 정확.

---

## 4. ❌ "디자인 토큰 매핑이 추적 어려움" — 과장됨

**본문 주장**

> "`fillPaints[0].color = #3B82F6` 이 들어있는데, 이게 `var(--brand-blue-500)` 인가, `theme.colors.primary` 인가, 그냥 hard-coded 색인가 — Figma Variables 를 *체계적으로* 쓴 디자이너만 추적 가능."

**검증**

Variables 가 사용된 경우엔 wire 에 alias 가 명시적으로 들어 있음. 우리 코드가 직접 풀고 있음:

```ts
// src/pen-export.ts:227-254
function buildColorVarResolver() {
  // paint.colorVar.alias.guid (sessionID:localID)
  // → alias chain 을 16 depth 까지 따라가서 실제 색 결정
  // → cache
}
```

Recent commit `9d99959` 에서 `resolveVariableChain` helper 로 분리.

**실제 wire 분기**

| 디자이너가 Variable 사용? | wire 에 남는 정보 | 토큰 매핑 가능성 |
|---|---|---|
| ✅ 사용 | `paint.colorVar.alias.guid` (Variable 식별자) | collection / variable name 까지 추적 가능 |
| ❌ 미사용 | raw hex 만 | 완전 소실 — 흩뿌려진 색 코드 |

본문은 두 케이스를 묶어 "wire 가 침묵" 으로 표현했는데, 실제 wire 는 둘을 명확히 구분함.

---

## 5. ✅ 큰 그림 thesis 는 맞음 — 단 표현이 정밀해야

**본문 결론**

> ".fig 는 '그림' 만 들어있는 파일이지, '이것을 어떻게 코드로 만들지' 의 사양이 들어있는 파일이 아니다."

**평가**

결론 자체는 정확. 다만 #1·#2·#3·#5 의 조정을 반영하면 더 정밀한 표현은:

> ".fig 는 디자이너가 *입력한 만큼만* intent 를 담는다.
> Component / Variant / Variable / Prototype 을 적극 쓴 디자인은 wire 에 풍부한 의도가 들어있고,
> 안 쓴 디자인은 그림만 남는다.
> 즉 **wire format 의 표현력 부족이 아니라, 디자이너가 그 표현력을 사용하지 않은 게 결손의 원인**."

이게 글 후반의 *"디자이너 스타일에 따라 변환 가능성이 천차만별"* 표와 정합적. 본문 앞부분의 8-gap 묘사는 *"wire 자체의 한계"* 처럼 들리는 톤이라 후반과 미묘하게 충돌함.

---

## 6. ✅ 정확한 부분들 (그대로 유지)

다음 항목은 검증을 통과:

- **#4 반응형 transition rule 부재** — Auto-layout + Constraints 가 있어도 breakpoint 변환은 wire 에 정말 없음.
- **#6 dynamic vs static text** — `text: "John Doe"` 가 prop 인지 정적인지 wire 가 침묵.
- **#7 CSS 임피던스 미스매치** — Auto-layout 안 쓴 absolute 디자인일 때 정확. Auto-layout 디자인은 flex 매핑 비교적 깔끔.
- **#8 semantic HTML / a11y** — `<button>` 시맨틱, `aria-*`, focus order 신호 없음.
- **휴리스틱 (Anima/Locofy) vs LLM (Visual Copilot/v0) 분류** — 정확.
- **디자이너 스타일 의존성** — 정성적으로 정확. 단, 표의 *%* 수치는 공개 벤치마크 없음 (정성적 추정으로 read 해야 함).

---

## 7. 🟡 "LLM 미래" 결론의 미묘한 비약

**본문 주장**

> "우리 parser 가 99.47% 정확도로 wire 를 풀어도, 그 99.47% 가 코드의 *의도* 를 99.47% 담고 있는 게 아닙니다 — 50% 도 안 될 수 있어요."

**검증**

99.47% 의 정확한 의미: *"우리 round-trip 결과가 Figma plugin API 의 dump 와 일치하는 비율"* (audit-oracle baseline round 31). *"디자이너 의도 capture 율"* 이 아님.

두 숫자는 같은 축이 아니므로 *"99.47% 가 의도를 담고 있다"* 라는 비교 자체가 카테고리 에러. *"50% 도 안 될 수 있다"* 는 직관적인 반박이지만 논리 구조가 어긋남.

**더 정확한 framing**

> "99.47% 는 wire format decode 정확도이지, 디자이너 의도 capture 율이 아니다.
> 의도 capture 율은 별개 축이고, 디자이너의 작업 스타일에 따라 매우 가변적이다."

**LLM 활용 결론은 합리적**

> "노드 트리 + Auto-layout + Variable 참조까지 함께 LLM 에 주면 더 정확해진다."

→ 우리 parser 의 출력이 LLM 코드 생성의 *enriched context* 로 쓰이는 게 가장 큰 가치라는 framing 은 정확하고 발전적.

---

## 권장 수정사항

블로그/노트로 발행 시 다음 3개를 고치면 thesis 일관성이 강해짐:

1. **#1 (컴포넌트 경계)**:
   - Before: "wire 엔 FRAME 만 있다"
   - After: "디자이너가 Component 를 안 만든 경우 FRAME 으로 떨어진다. 만든 경우 `SYMBOL` / `COMPONENT` / `COMPONENT_SET` 으로 wire 에 명시"

2. **#3 (상태)**:
   - §7.1 인용을 빼고
   - "디자이너가 prototype 으로 hover 연결선을 안 그린 경우 정말 없다. 그리는 케이스가 드물어서 사실상 없는 셈" 으로 톤 조정

3. **#5 (토큰)**:
   - "Variables 를 쓴 경우엔 wire 에 alias chain 이 명시적이라 추적 가능. 안 쓴 경우엔 hex 만 남는다" 로 양자 구분 명확화

전체 thesis 의 강도는 줄지 않음 — 오히려 **"wire 의 한계가 아니라 디자이너가 표현력을 쓰지 않은 결손"** 으로 framing 하면 후반 디자이너 스타일 의존성 표와 깔끔하게 이어지고 글의 일관성이 강해짐.

---

## 부록: 1차 검증 출처

- `docs/specs/audit-oracle.spec.md` §7.1 (lines 250–263) — out-of-scope 명시
- `src/masterIndex.ts:30` — Component 타입 indexing
- `src/instanceOverrides.ts:243–245, 287–303` — auto-layout 필드 + componentPropAssignments 처리
- `src/pen-export.ts:227–254` — `buildColorVarResolver` (Variable alias chain)
- `src/pen-export.ts:396–430` — auto-layout 디코딩 (`stackMode`, `stackSpacing`, `stackPadding*`, `stackPrimaryAlignItems`)
- `docs/PRD.md:18, 37` — Dev Mode / Variables 유료 플랜 의존성, Figma Make `.make` 컨테이너
- `docs/adr/0002-roundtrip-equality-tiers.md:3–8` — lossless 약속
- `docs/adr/0003-rendering-strategy-reverse-vs-figma-api.md:18–43` — REST API 한계 → 오프라인 파싱 정당화
- Recent commit `9d99959` — `resolveVariableChain` helper 분리
- Baseline: round 31, commit `690e856`, 704 / 18,304 = 99.47%
