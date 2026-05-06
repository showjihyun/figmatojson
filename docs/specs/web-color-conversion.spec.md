# spec/web-color-conversion

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/color.ts` |
| 테스트 | `web/core/domain/color.test.ts` (현재 `strokeFromPaints` 만 — 다른 export 도 본 spec 추가 후 단위 테스트 권장) |
| 형제 | `web-render-fidelity-round8.spec.md §3` (gradient stroke fallback 의 source), `audit-oracle.spec.md §I-A5` (paint length 비교 정책) |

## 1. 목적

Figma 의 paint 데이터는 `{r, g, b, a}` 채널을 0..1 범위로 carry. 우리
프로젝트의 세 다른 consumer 가 같은 paint 를 다른 형태로 필요로 한다:

- Canvas (Konva): CSS `rgba(r,g,b,a)` 문자열.
- Inspector: `<input type="color">` 의 swatch + 사용자 hex 편집 textbox.
- AI tool dispatcher / mutation 도구: 사용자 입력 hex 를 다시 0..1 channel
  로 환원해 wire 에 쓸 때.

본 spec 은 그 변환 helper 들의 *입출력 계약, opacity 합성 룰, paint-array
fallback 정책* 을 single source 로 둔다. 모든 helper 는 pure function — IO
없음 / framework 의존 없음.

## 2. 데이터 형태

```ts
interface Rgba01 {
  r: number;        // 0..1
  g: number;        // 0..1
  b: number;        // 0..1
  a?: number;       // 0..1 (default 1)
}
```

- I-D1 channel 값은 0..1 *연속* 으로 저장. wire format 도 동일.
- I-D2 `a` 는 *channel alpha* — Figma 의 paint-level `opacity` (별 필드)
  와는 다른 layer. 합성 룰은 §4 참조.
- I-D3 0..1 범위 밖 값 (negative / >1) 은 channel→byte 변환 시 0..255 로
  *clamp* — invalid wire 가 NaN / >255 byte 로 leak 하지 않게 한다.

## 3. 변환 helper 출력 계약

### 3.1 `rgbaToHex(c)` — channel → "#RRGGBB"

- I-H1 입력: `{ r?, g?, b? }` (채널 단독 또는 `Rgba01`). undefined 채널은
  0 으로 처리.
- I-H2 출력: `"#RRGGBB"` 형식. 6 자리 hex, lowercase. **alpha 는 drop** —
  hex swatch 는 channel alpha 를 carry 하지 않는다 (slider 별도 처리).
- I-H3 결정성: 동일 입력 → 동일 출력 (반올림 룰: `Math.round` — banker's
  rounding 사용 안 함).

### 3.2 `hexToRgb01(hex)` — "#rrggbb" → channel 0..1

- I-H4 입력: `"#rrggbb"` 또는 `"rrggbb"` (`#` 선택). case-insensitive.
- I-H5 출력: `{ r, g, b }` 0..1 범위. **alpha 는 emit 안 함** — caller 가
  필요 시 별도 채널로 주입.
- I-H6 parse 실패 (잘못된 길이 / 비-hex 문자) → `{ r: 0, g: 0, b: 0 }`.
  throw 안 함 — UI 의 hex 입력 textbox 가 partial typing 중인 상태에서
  exception 으로 깨지면 안 됨.

### 3.3 `rgbaToCss(c, layerOpacity = 1)` — channel + opacity → CSS rgba()

- I-H7 입력: `Rgba01` (선택) + `layerOpacity` (default 1).
- I-H8 출력: `"rgba(R,G,B,A)"` 문자열 — R/G/B 는 0..255 정수, A 는 3 자리
  소수 (`a.toFixed(3)`).
- I-H9 알파 합성: `A = (c.a ?? 1) * layerOpacity` — channel alpha 와 layer
  opacity 를 *곱셈* 으로 결합. Figma 의 paint-level opacity 의미와 일치.

### 3.4 `solidFillCss(node)` — 첫 visible SOLID fill → CSS

- I-H10 입력: `{ fillPaints?: unknown }` (전체 노드 또는 paint 컨테이너).
- I-H11 출력: 첫 *visible* `SOLID` paint 의 `rgbaToCss(color, paint.opacity ?? 1)`.
  매칭 없으면 `"transparent"` (gradient / image / hidden / 부재 모두).
- I-H12 visible 판정: `paint.visible !== false` (undefined → visible).
- I-H13 opacity 합성: paint 의 opacity 만 적용 — node-level layer opacity
  는 호출자 책임 (Konva 의 `opacity` prop 으로 별도 전달).

### 3.5 `solidStrokeCss(node)` — 첫 visible SOLID stroke → `{color, width}`

- I-H14 입력: `{ strokeWeight?: unknown, strokePaints?: unknown }`.
- I-H15 출력: `{ color: string, width: number }` 또는 `null`.
- I-H16 null 반환 조건: `strokeWeight` 가 number 아니거나 0 이하; `strokePaints`
  가 array 아님; visible SOLID paint 부재.

### 3.6 `strokeFromPaints(node)` — gradient/image-aware stroke resolver

`solidStrokeCss` 의 *상위 함수* — gradient stroke 도 처리. Konva 가
gradient stroke 를 native 지원 안 하므로 *first stop color* 로 fallback
(round-8 §3 I-SG1 의 source).

- I-H17 입력 / 출력 형태는 `solidStrokeCss` 와 동일.
- I-H18 paint walk 룰 (visible 만, 첫 매칭 win):
  - `SOLID` + `color` 존재 → `rgbaToCss(color, paint.opacity ?? 1)`.
  - `GRADIENT_*` (`LINEAR/RADIAL/ANGULAR/DIAMOND`) + `stops[0].color` 존재
    → `rgbaToCss(stops[0].color, paint.opacity ?? 1)` — *근사* 이고
    pixel-perfect 아님.
  - `IMAGE` / 기타 / hidden → skip, 다음 paint 시도.
- I-H19 모든 paint 가 unusable 이면 `null`.
- I-H20 `solidStrokeCss` vs `strokeFromPaints` 의 선택 = *gradient 폴백 허용
  여부*. 호출자가 명시적으로 결정 (`solidStrokeCss` 는 SOLID-only 의 엄격
  버전, `strokeFromPaints` 는 round-8 위 너그러운 버전).

## 4. Opacity 합성 layer 표

같은 paint 의 alpha 는 여러 layer 에서 곱해진다. 본 spec 은 helper 가
*어디까지 합성하는지* 명시.

| layer | source | helper 가 합성? |
|---|---|---|
| **channel alpha** (`color.a`) | `rgbaToCss(c, _)` 의 `c.a` | ✅ (rgbaToCss / solidFillCss / strokeFromPaints) |
| **paint opacity** (`paint.opacity`) | paint 별 `opacity` 필드 | ✅ (solidFillCss / solidStrokeCss / strokeFromPaints) |
| **node opacity** (`node.opacity`) | DocumentNode 의 layer opacity | ❌ — Konva 의 `opacity` prop 으로 *별도 전달* |
| **parent INSTANCE opacity** | render-overrides §3.6 의 visualStyleOverride | ❌ — clientNode pipeline 이 `node.opacity` 로 patch, 그 뒤 위와 동일 |

- I-O1 layer 4 종 중 **위 2 종만** color helper 가 합성 — node-level
  opacity 는 Konva-side 로 분리해 *paint string 에 alpha 가 두 번 곱해지는
  버그* 를 방지.
- I-O2 `rgbaToCss(c, layerOpacity)` 의 `layerOpacity` 인자는 *paint-level*
  opacity 의미. node-level opacity 를 여기로 전달하면 안 된다 (round-8 의
  fillPaints 처리 코드를 따라가서 재확인).

## 5. Error policy

- I-E1 모든 helper 는 *throw 없음*. parse 실패 / 형 mismatch / 범위 밖 입력
  은 *안전한 기본값* 으로 fallback.
  - `rgbaToHex({}) → "#000000"`
  - `hexToRgb01("not-hex") → { r:0, g:0, b:0 }`
  - `rgbaToCss(undefined) → "rgba(0,0,0,1.000)"`
  - `solidFillCss({}) → "transparent"`
  - `solidStrokeCss({}) → null`
- I-E2 `null` vs `"transparent"` 구분: stroke 는 `null` (옵셔널 필드 부재
  시 stroke 자체 안 그림), fill 은 `"transparent"` (Konva 의 fill prop 은
  string 만 받으므로 fallback 필요).
- I-E3 channel 범위 밖 입력 (negative / >1) 은 byte 단계에서 clamp — 결과
  는 0 또는 255 이지만 throw 안 함. mutation tool 이 wire 에 잘못된 값을
  쓰는 회귀가 발견되면 *상위 layer* 에서 검증 (helper 책임 아님).

## 6. 비대상

- ❌ **gradient render** — stops + transform 을 Konva 의 `<linearGradient>`
  로 변환하는 일은 별도 spec (`web/client/src/lib/gradient.ts` 가 담당,
  현 spec 은 *fallback 1색* 만).
- ❌ **image fill / image stroke** — `IMAGE` paint 는 본 helper 에서 skip.
  실제 image 처리는 `web/client/src/lib/imageScale.ts` + `web-render-fidelity-round*`.
- ❌ **HSL / HSV / OKLCH 등 다른 color space** — Figma wire 가 항상 sRGB
  rgba01. 다른 space 는 비대상.
- ❌ **wide-gamut display-p3** — wire 가 0..1 sRGB 가정. P3 / DCI-P3 / Rec.2020
  는 우리 측 미지원.
- ❌ **Figma 변수 alias 해석** — paint 가 `colorVar.value.alias` 를 carry
  해도 helper 는 *literal `color`* 만 읽는다 (`web-instance-render-overrides
  §6 비대상` 과 같은 정책). literal 이 항상 함께 stamp 되어 시각 손실 없음.

## 7. Resolved questions

- **왜 `rgbaToCss` 가 alpha 를 `toFixed(3)` 로 자르나?** Konva 가 받는 CSS
  rgba() 는 sub-pixel alpha 차이가 visible 하지 않다. 3 자리는 `0.000`~`1.000`
  의 1001 단계 — channel byte 의 0..255 256 단계와 호환되며 noise 도 적당.
  `audit-roundtrip-canvas-diff.mjs` 의 NaN 등치 룰과 다르게, alpha 는 *결정성*
  만 필요해 truncation 으로 충분.
- **`solidFillCss` 가 paint-level opacity 만 합성하고 node opacity 를 안
  하는 이유?** Konva 의 `Konva.Rect({ fill, opacity })` 가 두 layer 를 곱해
  렌더링한다. helper 가 미리 곱하면 Konva 가 두 번째로 곱해 *제곱* 됨. 문서
  화 안 된 채로 두면 round-8 디버깅 때 같은 함정에 두 번째 빠진다.
- **`strokeFromPaints` 가 first-stop fallback 인 근거?** round-8 §3 I-SG1
  의 디자인 결정. gradient stroke 의 dominant tone 보존이 빈 stroke 또는
  pixel-perfect 시뮬레이션보다 user 의 시각 인상에 가깝다 — figma audit
  으로 검증.
