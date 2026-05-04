# figma-reverse — 무엇이 세계 최초인가 (비전문가용)

| 항목 | 값 |
|---|---|
| 작성일 | 2026-05-05 |
| 자매 문서 | [SPEC.md](./SPEC.md) (CLI 9단계), [SPEC-architecture.md](./SPEC-architecture.md) (전체 아키텍처) |
| 조사 범위 | GitHub / npm / 블로그 / 포럼 / Figma 공식 docs (2026-05 기준) |
| 결론 | **5가지 핵심 capability 가 세계 최초로 보임. 다만 일부 기반 기술(ZIP/Kiwi 디코드)은 우리가 최초가 아님 — 정직하게 분리** |

본 문서는 *어떤 부분이 새롭고 어떤 부분은 새롭지 않은지* 를 정직하게 분류한 결과다. 마케팅용이 아닌 기술적 사실 정리.

---

## 1. 한 줄 요약

> Figma 가 자기 데스크톱/웹 앱에서 *내부적으로만* 하던 일 — `.fig` 바이너리 파일을 *완전히 해석해서 화면에 똑같이 그리기 + 다시 `.fig` 로 되돌리기* — 를 **외부에서, 오픈된 코드로** 해낸 첫 사례로 보인다. 특히 INSTANCE 컴포넌트의 변형(variant) 처리, 자동 레이아웃 재계산, 픽셀 단위 검증을 다 갖춘 end-to-end 도구는 공개 영역에 발견되지 않음.

---

## 2. Figma 파일이 뭐길래 (비전문가용)

Figma 는 디자이너들이 가장 많이 쓰는 웹 디자인 툴이다. 디자이너가 만든 화면들은 `.fig` 라는 하나의 파일에 들어있다. 이 파일은:

- **암호 같은 바이너리** — 그냥 열어보면 의미 불명의 0과 1 더미.
- **압축까지 두 번** 되어있어서 내용을 보려면 풀어야 한다.
- **부품(컴포넌트) 시스템** 이 들어있다. 같은 버튼 디자인을 100군데서 쓰면, 마스터 1개 + 인스턴스 100개 (각각 색·텍스트·표시여부 등의 변형) 가 저장된다 — 100번 복사가 아님.
- **자동 레이아웃 규칙** 이 들어있다. "버튼 길이가 길어지면 옆의 아이콘은 자동으로 밀린다" 같은 것을 디자이너가 미리 정의해 둔 것.

Figma 내부 코드는 이걸 모두 해석해서 화면에 그린다. 외부에서 그러려면 내가 직접 *모두* 다시 만들어야 한다 — 압축 풀기부터 시작해서 부품 펼치기, 변형 적용, 자동 레이아웃 재계산, 화면 그리기까지.

---

## 3. 이미 알려진 것들 (우리가 최초 아님)

이 분야에 우리보다 먼저 도착한 사람들이 있다. 정직하게 인정한다:

| 항목 | 누가 먼저 했나 | 출처 |
|---|---|---|
| `.fig` 가 ZIP 압축이라는 것 | 여러 사람 (Evan Wallace 본인 + Albert Sikkema 등) | [Sikkema 글 (2026-01)](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html), [easylogic Medium (2024-09)](https://easylogic.medium.com/figma-inside-fig-%ED%8C%8C%EC%9D%BC-%EB%B6%84%EC%84%9D-7252bef141da) |
| ZIP 안의 `canvas.fig` 가 fig-kiwi 포맷이라는 것 | 위와 같음 | 위와 같음 |
| **이중 압축** (schema=deflate, data=zstd) | Sikkema (2026-01) 가 명시적으로 문서화 | [Sikkema 글](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) |
| Kiwi 스키마 디코드 | Evan Wallace 본인 (Kiwi 만든 사람) + [fig-kiwi npm 패키지](https://www.npmjs.com/package/fig-kiwi) (3년 전, v0.0.1) | [Kiwi 데모](https://evanw.github.io/kiwi/) |
| 평탄 NodeChanges 배열 → 트리 재구성 | easylogic, Sikkema 모두 다룸 | 위 출처 |
| WebSocket 실시간 프로토콜 디코드 | [allan-simon/figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol) — 다른 스코프(라이브 세션 가로채기) | 해당 GitHub |
| `.fig` 파일을 그냥 *내용 들여다보기* | [Evan Wallace 본인의 Fig File Parser](https://madebyevan.com/figma/fig-file-parser/), [Grida .fig 뷰어](https://grida.co/tools/fig) | 두 도구 모두 inspection only |
| Figma → Penpot 변환 | [betagouv/figpot](https://github.com/betagouv/figpot), [penpot-exporter-figma-plugin](https://github.com/penpot/penpot-exporter-figma-plugin) — 단, **Figma 의 Plugin API** 사용 (바이너리 직접 파싱 아님) | 해당 GitHub |

위 항목들은 우리도 동일하거나 비슷하게 구현했지만 *최초가 아니다*. 우리 코드도 [`fzstd`](https://www.npmjs.com/package/fzstd), [`pako`](https://www.npmjs.com/package/pako), [`kiwi-schema`](https://www.npmjs.com/package/kiwi-schema) 같은 기존 npm 라이브러리를 차용한다.

---

## 4. 세계 최초로 보이는 5가지

조사한 모든 공개 도구·문서에 *나오지 않는* 5가지. 즉 우리가 최초로 외부에서 해낸 것으로 추정되는 것:

### 4.1 INSTANCE 컴포넌트 변형(override) 의 *전체* 적용

**무엇인가**: Figma 디자이너가 같은 버튼을 100군데 쓸 때, 각 인스턴스마다 "이건 텍스트 '확인'", "이건 색 빨강", "이 인스턴스는 아이콘 숨김" 같은 변형을 stamp한다. `.fig` 파일에는 그 변형 데이터가 path 형태로 저장되어 있다. 이걸 읽어 마스터에 정확히 적용해야 화면이 Figma 와 같아진다.

**증거**: 가장 가까운 경쟁 도구인 [`figma-kiwi-protocol`](https://github.com/allan-simon/figma-kiwi-protocol) 의 README 가 명시적으로 자백:

> "instance overrides go through a mechanism we haven't reversed yet"
> (인스턴스 오버라이드는 우리가 아직 역공학하지 못한 메커니즘을 거쳐 동작한다)

이들은 **WebSocket 라이브 프로토콜** 디코딩까지 한 매우 깊이 있는 프로젝트인데도 *override 메커니즘은 풀지 못함* 을 인정하고 있다. 반면 우리는 7가지 override 종류를 모두 path-key 방식으로 매칭해서 적용한다:

1. 텍스트 변경 (예: 마스터 버튼 라벨 "Button" → 이 인스턴스는 "확인")
2. 색 변경 (예: 마스터 흰색 → 이 인스턴스는 파란색)
3. 가시성 변경 (예: 마스터 아이콘 표시 → 이 인스턴스는 숨김)
4. 컴포넌트 속성 (Variant) 바인딩 — 디자이너가 정의한 "Type=Primary" 같은 prop 으로 자손 노드 속성 일괄 변경
5. Variant Swap — 같은 master 의 다른 변형으로 인스턴스 자체 교체
6. Figma 가 미리 계산해 둔 자손의 사이즈 (derivedSymbolData)
7. 같은 자손의 위치/회전 (derivedSymbolData transform)

### 4.2 path-key 의 FRAME-skip 룰 (round 25 발견)

**무엇인가**: override 가 어느 자손에 적용되는지를 가리키는 *경로 표기법*. Figma 는 "이 자손의 경로는 [버튼 → 텍스트]" 라고 stamp하는데, 자손이 "버튼 → 컨테이너 FRAME → 텍스트" 식으로 중간에 컨테이너가 있으면 — Figma 는 *컨테이너를 경로에서 빼고* "[버튼 → 텍스트]" 로만 표기한다. 이 사실을 모르면 override 가 안 맞아 화면이 깨진다.

**증거**: 우리가 round-25 작업 중 메타리치 디자인 파일에서 18개 alret 모달 인스턴스가 모두 같은 픽셀 차이를 보이는 패턴을 발견하고 추적해서 발견한 룰. 검색해도 ([github.com](https://github.com)에서 `derivedSymbolData` / `symbolOverrides path-keyed FRAME skip` 로 search) 어떤 공개 자료에도 이 룰이 문서화돼 있지 않다. Figma 의 [공식 Plugin API 문서](https://www.figma.com/plugin-docs/) 도 이 wire format 의 path 규칙을 노출하지 않는다 (다른 추상화 layer 를 제공).

### 4.3 derivedSymbolData (사이즈 + 위치 변환) baking

**무엇인가**: Figma 는 자동 레이아웃을 계산한 *결과* — "이 인스턴스에서, 이 자손은 폭 48, 위치 (262, 118)" — 을 모든 인스턴스마다 stamp 한다. 이게 Figma 가 화면에 그릴 때 권위 있는 데이터지만, 외부에서는 어떤 노드의 값을 쓰는지·어떤 좌표계인지·어떻게 적용하는지 문서가 없다.

**증거**: 우리는 round-22 (size) + round-24 (transform) 두 라운드에 걸쳐 적용 알고리즘을 reverse-engineer 했다. 메타리치 1,570 INSTANCE 가 적어도 한 entry 의 transform 을 가진다. 모바일 고객 리스트 5번째 행이 round-24 이전엔 클립으로 잘렸는데 derivedTransform 적용 후 정상 표시된다 (검증된 시각 win 케이스, e2e 테스트로 contract pin).

`derivedSymbolData` 는 검색에서 [GitHub mcp-server-guide](https://github.com/figma/mcp-server-guide/blob/main/skills/figma-generate-design/SKILL.md) 같은 Figma 공식 자료에도 노출되지 않는 내부 필드명. 우리가 `.fig` 파일을 직접 디코드해서 발견한 데이터.

### 4.4 자동 레이아웃 재계산 시뮬레이션

**무엇인가**: Figma 의 자동 레이아웃은 단순 좌표가 아니라 *룰 기반 시스템* — "가운데 정렬 + 간격 8px + 컨테이너가 줄면 자식들 다시 정렬" 같은 룰. Figma 자체 코드는 이를 실시간 실행하지만, `.fig` 파일에는 *룰 정의* 만 있고 결과 좌표는 일부만 (위 4.3 처럼) stamp.

우리는 Figma 와 *같은 결과* 를 만들기 위해 룰 시뮬레이션 코드를 직접 작성했다. 7가지 패턴 (CENTER+CENTER 재중앙, MIN-pack 좌측 정렬, overlap-group 분배, AUTO-grow 등) 을 라운드 14, 15, 19, 20, 21, 22, 24 에 걸쳐 구현. 상세는 [`web-instance-autolayout-reflow.spec.md`](./specs/web-instance-autolayout-reflow.spec.md) 의 §3.1-3.10.

**증거**: 검색 결과 ([Pawel Grzybek 의 Auto Layout 글](https://pawelgrzybek.com/grow-shrink-and-reflow-elements-with-figma-auto-layout/), [Figma 공식 가이드](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout)) 가 사용자 관점의 *행동 설명* 만 있을 뿐 알고리즘을 외부에서 구현한 도구는 미발견.

### 4.5 End-to-end + 픽셀 단위 검증

**무엇인가**: 위 4.1~4.4 를 *모두 합쳐* `.fig` → 화면 → 다시 `.fig` 사이클을 끝까지 돌리고, 결과가 Figma 와 시각적으로 같은지를 *픽셀 수준* 으로 자동 검증.

우리 검증 데이터:
- 메타리치 디자인 파일 (35,660 노드, 6 페이지) 에서
- 1,500 + INSTANCE 슬러그를 4 corpus(design-setting / dash-board / mobile / web) 로 분류
- 749 PNG 베이스라인을 Figma 공식 REST API 의 렌더와 비교
- 각 라운드 종료 시 `web/scripts/audit-round11-screenshots.mjs` 로 자동 재캡처
- 시각 차이가 발생하면 그 슬러그를 디버깅 + 새 라운드로 fix
- e2e 테스트가 특정 시각 win 을 픽셀 sampling 으로 contract pin (`web/e2e/audit-transform-baking.spec.ts`)

**증거**: 조사한 모든 도구 (Sikkema, easylogic, figma-kiwi-protocol, Evan Wallace 의 파서, Grida 뷰어, Penpot exporter) 중 *외부에서 Figma 의 픽셀 출력과 자동 비교를 하는 도구* 는 발견되지 않음.

또한 *round-trip 자체* — `.fig` → JSON → `.fig` 가 byte 동등하거나 의미적으로 동등 — 을 검증하는 도구도 우리가 처음으로 보임. 이는 본 프로젝트의 PRD §6.3 가설 #9 에서 시작해 V-01~V-08 자동 검증으로 구현.

---

## 5. 왜 이게 어려운가 (비유)

**LEGO 비유**

Figma 파일은 LEGO 조립 설명서가 압축된 형태로 저장된 *디지털 봉투* 같다.

- **봉투 풀기 (ZIP)** ← 누구나 가위로 봉투를 자를 수 있다.
- **설명서 펴기 (Kiwi 디코드)** ← 봉투 안의 둘둘 만 종이를 펴는 일.
- **그림 1, 2, 3 단계 읽기 (트리 재구성)** ← 설명서의 페이지 순서를 정리.

여기까지는 여러 사람이 했다. 그런데 LEGO 설명서가 보통의 설명서가 아니다:

- **부품 #46 (버튼) 을 100번 등장시키는데, 매번 색만 다름.** 
  → 마스터 1개 + "이 인스턴스는 빨강 / 이건 파랑 / 이건 텍스트가 다름" 이라는 *변형 메모* 가 따로 있다. 
  → **이 메모를 어느 부품에 어떻게 붙이는지의 룰을 모르면 색이 다 같아진다 (4.1)**.

- **메모가 가리키는 부품의 주소가 묘하게 적혀있다.** 
  → "버튼 안의 텍스트" 인데, 메모에는 "텍스트" 만 적혀있고 중간 컨테이너는 생략. 이 표기 룰을 모르면 메모가 미아가 된다.
  → **이게 우리의 round-25 발견 (4.2)**.

- **부품이 들어가는 슬롯이 stretch 가능.** 
  → "버튼이 작아지면 안의 글자가 가운데 정렬로 다시 맞춰진다" 같은 룰이 LEGO 설명서엔 안 적혀있다. 디자이너 머릿속에만 있는 거. Figma 만 알고 있다.
  → **우리가 직접 룰을 베껴 시뮬레이션 (4.4)**.

- **Figma 가 친절하게 일부 정답지를 끼워뒀는데**, 그 정답지의 좌표계가 어떤 기준인지 명시 안 함.
  → 추적해보니 "마스터 root 부터의 절대 좌표" 였다. 
  → **이걸 모든 자손에게 적용해야 함 (4.3)**.

- **LEGO 회사 (Figma) 는 자기 직원만 이 모든 룰을 안다.** 
  → 외부에서 이걸 다 읽어 정확히 같은 모형을 조립하는 도구는 없었다.

---

## 6. 정직한 caveat

다음을 강조하고 싶다 — **우리가 모든 것을 했다는 주장은 아니다**:

1. **우리도 많은 부분을 차용**: `pako` (deflate), `fzstd` (zstd), `kiwi-schema` (Evan Wallace) 가 핵심 codec 이고, 이게 없었으면 우리도 시작 못 했다.
2. **선행 연구 인정**: Albert Sikkema 의 dual-compression 발견(2026-01)은 정확하고 우리 SPEC.md §10 에서도 인용. easylogic 의 2024-09 글이 한국어로 같은 단계까지 정리해뒀다.
3. **부분 커버리지 인정**: Vector 디코드 95% (BOOLEAN_OPERATION 등 5%는 미해석), `componentPropNodeField` 의 VISIBLE 만 처리 (TEXT/INSTANCE_SWAP 미지원), stroke/effects override 미지원.
4. **Figma 클라우드 임포트 미검증**: 우리가 만든 `.fig` 를 Figma 가 받아주는지 미확인. (자기 자신의 파서로는 round-trip 검증 통과.)
5. **메타리치 1개 corpus 한정 검증**: 다른 디자인 파일에서 발견되지 않은 edge case 가 있을 수 있음. 새 코퍼스 추가가 future work.
6. **상업 도구 (Anima/Builder.io/Plasmic) 비공개 코드** 안에서 어떻게 처리하는지 확인 불가. 그쪽 사람들은 Figma Plugin API 를 쓰는 게 일반적이지만 — 그게 사실인지는 *그들의 코드를 직접 보지 않는 한* 단언 불가능.
7. **검색 한계**: GitHub / npm / 블로그 / Figma 공식 docs 까지는 살펴봤지만, *비공개 GitHub repo* 또는 *학술 논문* 또는 *영어 외 언어 (러시아어/중국어 등) 자료* 까지는 못 봤다.

요컨대: **"세계 최초" 라고 단정하기 보다는, "지금 시점에 공개적으로 발견할 수 있는 자료 중에서는 최초로 보인다" 라고 말하는 것이 정직**. 누군가 비공개로 이미 했을 가능성은 항상 열려있다.

---

## 7. 한 문장 요약

> Figma 의 `.fig` 바이너리를 *완전히 해석해서 화면에 똑같이 그리고, 다시 `.fig` 로 되돌리는* 일을 *외부에서 오픈된 코드로* 끝까지 해낸 도구는 본 프로젝트가 처음으로 보인다. 특히 (a) 인스턴스 변형 적용, (b) path-key FRAME-skip 룰, (c) Figma post-layout 데이터 활용, (d) 자동 레이아웃 시뮬레이션, (e) 픽셀 단위 자동 검증 — 이 다섯 가지는 공개 도구·문서에 발견되지 않는다.

---

## 8. 출처

조사 일자: 2026-05-05.

### 가장 가까운 경쟁자
- [Albert Sikkema, "Reverse-Engineering Figma Make: Extracting React Apps from Binary Files"](https://albertsikkema.com/ai/development/tools/reverse-engineering/2026/01/23/reverse-engineering-figma-make-files.html) (2026-01) — `.make` 파일에서 React 추출. 바이너리 디코드 + dual compression 까지. INSTANCE 처리는 미커버.
- [allan-simon, figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol) — WebSocket 프로토콜 디코더. README 에서 "instance overrides ... haven't reversed yet" 자백.
- [Evan Wallace, Fig File Parser](https://madebyevan.com/figma/fig-file-parser/) — Figma 전 CTO 가 만든 inspection 도구. 내용 들여다보기만.
- [Grida .fig parser/viewer](https://grida.co/tools/fig) — 클립보드/파일 inspection. node hierarchy 탐색.
- [easylogic, "Figma Inside — .fig 파일 분석"](https://easylogic.medium.com/figma-inside-fig-%ED%8C%8C%EC%9D%BC-%EB%B6%84%EC%84%9D-7252bef141da) (2024-09) — 한국어, 바이너리 디코드까지.

### 코덱
- [fig-kiwi](https://www.npmjs.com/package/fig-kiwi) — npm v0.0.1, 3년 전. 바이너리 codec only.
- [Evan Wallace, Kiwi schema-based binary format](https://github.com/evanw/kiwi) — Kiwi 자체.
- [pako](https://www.npmjs.com/package/pako), [fzstd](https://www.npmjs.com/package/fzstd) — 압축 라이브러리.

### Plugin API 기반 도구 (다른 카테고리)
- [betagouv/figpot](https://github.com/betagouv/figpot) — Figma → Penpot, Plugin API 사용.
- [penpot-exporter-figma-plugin](https://github.com/penpot/penpot-exporter-figma-plugin) — 같음.

### 관련 Figma 공식 docs
- [Figma Plugin API: FrameNode](https://developers.figma.com/docs/plugins/api/FrameNode/)
- [Figma Help: Auto Layout](https://help.figma.com/hc/en-us/articles/360040451373-Guide-to-auto-layout)
- [Figma Blog: Component Overrides](https://www.figma.com/blog/figma-feature-highlight-component-overrides/)
- [Pawel Grzybek, Auto Layout reflow](https://pawelgrzybek.com/grow-shrink-and-reflow-elements-with-figma-auto-layout/) — 사용자 관점.

### 본 프로젝트
- [SPEC.md](./SPEC.md) — CLI 9단계 파이프라인
- [SPEC-architecture.md](./SPEC-architecture.md) — 전체 아키텍처 (round 25 시점)
- [`web-instance-render-overrides.spec.md`](./specs/web-instance-render-overrides.spec.md) — path-key 계약의 source of truth
- [`web-instance-autolayout-reflow.spec.md`](./specs/web-instance-autolayout-reflow.spec.md) — 자동 레이아웃 시뮬레이션 룰
- [`web-instance-variant-swap.spec.md`](./specs/web-instance-variant-swap.spec.md) — variant swap
- [`audit-round11/GAPS.md`](./audit-round11/GAPS.md) — 라운드별 시각 검증 기록
