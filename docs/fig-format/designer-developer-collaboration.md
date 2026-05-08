# Figma 시대의 디자이너 ↔ 개발자 협업

> [`wire-format-vs-design-intent-review.md`](./wire-format-vs-design-intent-review.md) 의 검증 결과를 협업 관점에서 재해석한 노트.

## 검토 결과의 의의

### 핵심 발견: "도구 문제" → "프로세스 문제" 로 진단이 바뀐다

리뷰 전 막연한 통념: *"Figma → code 변환이 잘 안 되는 건 .fig 포맷이 부족해서다."*

리뷰 후 정확한 진단: *"Figma → code 변환이 잘 안 되는 건 디자이너가 Figma 의 표현력을 안 써서다."*

이 두 framing 의 함의는 정반대:

| Framing | 함의 | 행동 |
|---|---|---|
| 도구 한계 | 더 똑똑한 컨버터를 기다린다 | 수동적 — 시장이 해결할 문제 |
| 디자이너 사용 부족 | 디자인 파일 자체가 spec 이다 | 능동적 — 협업 방식을 바꿀 수 있는 문제 |

즉 변환 품질의 천장은 *컨버터 알고리즘* 이 아니라 *.fig 파일이 담은 의도의 양*. 더 강한 LLM 이 와도 빈약한 입력에선 빈약한 출력만 나옴 — 오히려 LLM 시대엔 **good design × LLM = great code, bad design × LLM = bad code at scale** 로 격차만 커진다.

### 부수 발견: ".fig 파일 품질" 이 측정 가능한 기술 지표가 된다

지금까지 "잘 만든 Figma 파일" 은 *심미적/주관적* 판단이었음. 그런데 검토에서 드러난 wire 신호 (Component / Variant / Variable / Auto-layout / Property / Prototype 사용률) 는 모두 **기계가 측정 가능**. 즉 디자인 파일 품질을 코드 PR 처럼 metric 으로 검증할 수 있게 됨.

---

## 협업 방식의 재구성

### 시대 변화

| 시대 | 핸드오프 단위 | 디자이너 ↔ 개발자 인터페이스 |
|---|---|---|
| ~2015 | 정적 mockup (PSD, JPG) | "이 16px 인가요 14px 인가요?" |
| 2015–2022 | Design tokens + Storybook | 공유 토큰 / 컴포넌트 라이브러리 |
| 2023~ | **.fig 파일 자체가 spec** | wire 가 직접 코드 생성기에 입력 |

지금은 **3단계**. 디자인 파일이 산출물이 아니라 *실행 가능한 사양*. 그래서 협업 모델도 "디자이너 → 핸드오프 → 개발자" 가 아니라 **"디자이너와 개발자가 같은 파일을 함께 다듬는다"** 가 정확.

---

### 디자이너 측 책임 (wire 에 의도를 새기는 법)

검토에서 나온 wire 신호를 의도적으로 활용:

1. **반복되는 UI 는 반드시 Component 화** → wire 에 `COMPONENT` 타입으로 박힘 (#1 해결)
2. **상태별 변형은 Variants 로** → `Button/Default`, `Button/Hover`, `Button/Disabled` 같은 Variant set (#3 해결)
3. **모든 색·간격·radius·타이포는 Variables 로** → `paint.colorVar.alias` 가 wire 에 들어감 (#5 해결)
4. **Component Properties 로 가변 영역 노출** → Text prop, Boolean prop, Instance swap → `componentPropDefs` 로 wire 에 박힘 (#2 해결)
5. **Auto-layout 으로 배치** → `stackMode`, `stackSpacing`, `stackPadding*` 으로 flex 의도가 wire 에 (#7 부분 해결)
6. **Layer 이름을 시맨틱하게** → `Card/Header/Avatar` 같이. 이건 wire 의 `name` 필드로 그대로 보존되고 LLM 이 className 추론할 때 강한 신호
7. **Prototype 연결 (선택적이지만 유용)** → hover/click 의도가 정말로 wire 에 들어감 (#3 보강)

> **핵심 원칙**: "눈에 보이는 결과가 같아도, *어떻게 그렸는지* 가 wire 에 다르게 남는다."
> Auto-layout 으로 만든 카드와 absolute 로 만든 카드는 픽셀은 같지만 wire 가 다르고, 코드 결과도 다름.

### 개발자 측 책임 (wire 를 코드 리뷰처럼 읽는 법)

기존: "Figma 보고 픽셀 그대로 옮긴다."
새 방식: **"Figma 파일을 PR 리뷰하듯 본다."**

1. **디자인 파일 리뷰** — 디자이너가 PR 올리듯 디자인 파일을 검토. Component 화 안 된 반복 UI, Variable 안 쓴 hard-coded 색, absolute 남용 등을 *코드 리뷰의 코멘트* 처럼 지적
2. **공통 어휘 정의** — Token 이름 (`color/brand/primary`), Component 이름 (`Button`, `Card`) 을 디자이너와 *함께* 명명. 디자인의 토큰 이름이 그대로 코드 변수명이 되도록
3. **Code Connect 로 명시적 매핑** — Figma Component ↔ React/Vue 컴포넌트를 1:1 로 묶어두면 wire 의 Component 가 코드 import 로 직접 변환됨
4. **디자인 시스템은 코드가 1차, Figma 가 미러** (혹은 그 반대를 명시) — 어느 쪽이 source of truth 인지 합의해야 변환이 결정 가능
5. **상태 사양을 사전에 합의** — 모든 인터랙티브 컴포넌트가 가져야 할 최소 상태 셋 (default / hover / focus / active / disabled / loading / error) 을 *디자이너에게 요구*. 안 그리면 LLM 이 추측해서 만들고 결과는 매번 다름

### 팀 차원의 합의 사항 (문서화 권장)

- **명명 규칙**: Component PascalCase, instance lowercase 등
- **토큰 분류 체계**: primitive (`blue/500`) vs semantic (`brand/primary`) vs component (`button/bg`)
- **"무엇이 Component 가 되는가" 기준**: 2회 이상 등장? 별도 상태 있음? 정책 명시
- **반응형 전략**: 데스크탑/모바일 별도 frame? Constraints? 아니면 코드에서 별도 처리? — wire 가 표현 못 하는 영역이라 *외부 합의* 필요 (#4 해결)
- **a11y 사양**: semantic role 을 layer 이름으로 표기 (`button/Submit`), focus order 표기 등 — wire 에 없는 부분을 *컨벤션* 으로 메움 (#8 해결)

---

## LLM 시대의 증폭 효과

검토 #7 에서 짚은 결론을 협업 관점으로 재진술:

> **Parser 출력 = LLM 의 enriched context**
>
> 스크린샷 한 장 → LLM = 적당한 코드
> 스크린샷 + Component 트리 + Variable 참조 + Auto-layout 구조 + Variant 메타 → LLM = **디자인 시스템 일관성을 유지하는 코드**

이 차이는 디자이너 입력 품질에서 직접 옴. 즉 LLM 이 강해질수록 *디자이너의 wire 활용 숙련도가 변환 품질에 미치는 레버리지가 커진다*. 협업 비용을 안 들이면 그 레버리지를 못 쓰는 셈.

---

## 측정 가능한 디자인 파일 품질 지표 (제안)

기계로 측정 가능한 6가지 wire 신호. 디자인 파일 품질 점수의 후보:

| 지표 | 측정 방식 | 의미 |
|---|---|---|
| Component 화 비율 | `INSTANCE` 노드 수 / 전체 자식 노드 수 | 재사용 의도 표현률 |
| Variable 사용 비율 | `paint.colorVar.alias` 가 있는 paint 수 / 전체 paint 수 | 토큰 추적 가능성 |
| Auto-layout 비율 | `stackMode != NONE` frame 수 / 전체 FRAME 수 | flex 의도 표현률 |
| Component Property 사용 | `componentPropDefs.length > 0` 인 master 수 / 전체 master 수 | 가변 영역 명시률 |
| Variant set 보유 | `COMPONENT_SET` 안의 평균 자식 수 | 상태 사양 완성도 |
| 시맨틱 명명 비율 | 의미 있는 layer 이름 (`Frame 123`, `Rectangle 4` 가 아닌) 비율 | className/role 추론 가능성 |

이 지표를 CI 처럼 돌려서 PR (디자인 변경) 마다 점수를 내면, 협업이 "감각적 코멘트" 에서 "측정 기반 피드백" 으로 바뀐다.

---

## 한 줄 요약

> **".fig 파일 품질은 곧 코드 품질이다. 이는 디자이너 단독 작업이 아니라 디자이너 ↔ 개발자가 함께 다듬어야 하는 *공유 산출물* 이며, 그 품질은 wire 신호로 측정 가능하다."**

---

## 관련 문서

- [`wire-format-vs-design-intent-review.md`](./wire-format-vs-design-intent-review.md) — 본 노트의 1차 검증 보고서
- `docs/specs/audit-oracle.spec.md` §7.1 — out-of-scope 정의
- `CONTEXT.md` — Component / Instance / Master / Override 도메인 정의
