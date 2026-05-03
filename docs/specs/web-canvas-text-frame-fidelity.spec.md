# spec/web-canvas-text-frame-fidelity

| 항목 | 값 |
|---|---|
| 상태 | Draft (round 13) |
| 구현 | `web/client/src/Canvas.tsx` (TEXT 분기, ~line 344-407) |
| 테스트 | `web/core/domain/clientNode.test.ts` (가능하면 unit 가능한 부분), Pass 3 visual gate (button-5_9, alret-64_376) |
| 형제 | `web-canvas-instance-clip.spec.md` (round 12 INSTANCE clip) |

## 1. 목적

Round-11 audit 의 design-setting `button-5_9`, `alret-64_376` 에서 두
클래스의 text-rendering 결함이 확인됨. round 12 PR2 (INSTANCE auto-clip)
는 의도된 결과 — 당시에는 clip 이 없어서 leak 된 텍스트가 보였지만,
clip 적용 후엔 *잘려* 보인다 ("Button" → "Butto", "삭제" → "삭"). 본
spec 은 *왜 잘리느냐* 를 다루고, Figma 의 실제 동작과 정렬한다.

두 결함:

- **C1 — 변종 (variant) 텍스트 폭 클리핑**: button-5_9 의 거의 모든 variant 에서 "Button" 이 "Butto" 로 잘림. Figma 는 동일 frame 폭에서 글자 전체를 표시. 원인 가설: 폰트 메트릭 차이 (실제 폰트 vs Konva 폴백) 로 우리 글리프 너비가 더 넓어, frame 의 clip rect 안으로 마지막 글자가 들어가지 못함.
- **C2 — 비활성 (disabled) 변종 opacity 적층**: button-5_9 의 disabled outline / solid variant 에서 텍스트와 아이콘이 거의 안 보임. Figma 는 흐리지만 또렷이 표시. 원인 가설: opacity 가 *frame* 레이어 + *child text* 레이어 양쪽에 적용되어 multiplicative 로 죽음 (0.4 × 0.4 = 0.16).

## 2. Invariants

### 2.1 텍스트 폭 처리 (C1)

- I-1 KText 의 `width` prop 은 frame 의 `w` 를 그대로 전달하지 않는다 — Figma 의 실제 데이터에서 텍스트 노드는 자기 자신의 `size.x`/`size.y` 를 따로 가지므로, 그 값을 우선 사용. 부모 frame 의 폭 을 KText 폭으로 간주하면 안 됨 (frame 안에 padding 이 있을 수 있음).
- I-2 글리프 overflow 시 처리 정책: **자르지 않음** (default Figma 동작). KText 의 `wrap` 은 기본값 ('word'), `ellipsis` 도 기본값 (false). 폭이 모자라면 글리프가 frame 밖으로 그려져도 클립당하지 않음 — round 12 의 INSTANCE auto-clip 이 *frame* 자기 bbox 만 자르지, 그 안의 KText 자체는 자르지 않으므로 horizontally overflow 가 정상.
- I-3 폰트 메트릭 mismatch 가 가시화될 때의 fallback: 실제 폰트 (Inter / Pretendard 등) 가 로드되지 않은 환경에서, Konva 의 system fallback 이 측정한 글자 폭이 실제보다 *클* 수 있음. 이 경우 우리 측 디자인 의도 (보이는 글자 수) 가 깨짐. 대안:
  - I-3a (선호): 폰트 로드를 보장 — `document.fonts.ready` 대기 후 첫 paint
  - I-3b: KText 의 `letterSpacing` 을 negative micro-tighten — 호환성 깨짐. 채택 안 함.
- I-4 button "Button" → "Butto" 케이스의 root cause 가 *폰트 메트릭* 인지 *frame 폭 자체* 인지 audit harness 에서 측정 (KText 의 `getTextWidth()` vs frame.w). measurement 결과에 따라 I-1 / I-3 중 어느 invariant 가 fix 인지 결정.

### 2.2 비활성 opacity 적층 (C2)

- I-5 노드의 `opacity` 는 자기 자신에만 적용. 자식 (master expansion 결과 포함) 은 *별도 자기 opacity* 만 따른다. 부모-자식 opacity 는 Konva 의 자연 합성에 맡긴다 (Konva 가 자동 multiply 처리).
- I-6 disabled variant 의 데이터 source: master 트리에 있는 `opacity` 가 outer INSTANCE 의 expansion 시 어떤 노드에 적용되었는지 audit. 한 노드에만 0.4 가 있는데 우리 측이 두 군데 (frame + text) 에 적용하고 있는지 확인.
- I-7 fix 점은 두 후보 중 하나:
  - I-7a: `Canvas.tsx` 의 NodeShape 가 자식 props 로 opacity 를 *forward* 하고 있다면 그 forward 제거 (Konva 자동 합성에 맡김)
  - I-7b: master expansion 시 child 노드들에 master 의 opacity 를 *복제 적용* 하고 있으면 (`toClientChildForRender` 에서 `out.opacity = data.opacity * parent.opacity` 같은 짓), 그 복제 제거

## 3. Investigation order

본 spec 은 **fix 전에 measurement 가 필요**. 작업 순서:

1. button-5_9 의 한 variant 골라 KText.getTextWidth() vs frame.w 측정 → C1 의 I-1 vs I-3 결정
2. button-5_9 의 disabled variant 데이터 dump → opacity field 가 어느 노드들에 있는지, 우리 측 NodeShape 가 어떻게 forward 하는지 grep → C2 의 I-7a vs I-7b 결정
3. 결정된 invariant 대로 작은 fix → visual gate 재확인

## 4. 비대상

- 다국어 폰트 fallback 일반화 (한 / 영 mix 의 중국어 hint 등) — 메타리치 design system 에서 발견될 때 별도 라운드.
- KText 의 ellipsis 사용 — Figma 에 ellipsis 가 명시된 텍스트만 적용. 일반 frame 에서는 overflow 자연 노출이 default.
- 폰트 로드 progress UI — 첫 paint 가 fallback 폰트로 그려져도 시각적 충격 없도록 기존 fallback chain (Inter → system) 을 유지하되, fonts.ready 후 re-render 강제는 본 spec 에 포함될 수 있음 (I-3a).
- **INSTANCE size override + auto-layout reflow** — alert dialog 의 "취소" / "삭제" 버튼처럼 INSTANCE 가 master 크기를 절반 이하로 축소 override 하는 케이스. Figma 는 auto-layout reflow 로 child TEXT 를 INSTANCE 중심으로 재배치 → 글자가 자연 폭으로 새 INSTANCE 안에 fit. 우리는 master 좌표 그대로 렌더 + round-12 INSTANCE auto-clip 으로 잘림. 본 spec 으로는 fix 못 함 (round-12 INSTANCE clip 을 끄면 `Defa미분배` 케이스가 되돌아옴; 진짜 fix 는 auto-layout reflow 구현). 별도 라운드 ("INSTANCE auto-layout reflow" spec).
