# spec/web-render-fidelity-round5

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` (TEXT 분기 + default Rect 분기) + `web/client/src/lib/cornerRadii.ts`, `web/client/src/lib/textTransform.ts` |
| 테스트 | `web/client/src/lib/cornerRadii.test.ts`, `web/client/src/lib/textTransform.test.ts` |
| 부모 | round 1~4 |

## 1. 목적

Universal Figma 기능 3종 — **per-corner radii** (asymmetric 둥근 모서리), **textCase** (UPPERCASE / lowercase / Title Case), **textDecoration** (underline / strikethrough). 모두 Figma 데이터 모델에 정의된 표준 필드. 파일 종속 휴리스틱 없음.

## 2. Per-corner radii

### 2.1 Field shape

```ts
node.cornerRadius?: number              // uniform fallback (현재 처리됨)
node.rectangleTopLeftCornerRadius?: number
node.rectangleTopRightCornerRadius?: number
node.rectangleBottomRightCornerRadius?: number
node.rectangleBottomLeftCornerRadius?: number
```

Figma 가 4면을 각각 다르게 둥글게 한 사각형은 위 4개 개별 필드로 직렬화한다. 4개 모두 같으면 `cornerRadius` 만 사용해도 충분 (현재 동작). 그 외에는 Konva.Rect 의 array form `cornerRadius={[tl, tr, br, bl]}` 으로 전달.

### 2.2 Resolution

- I-CR1 `cornerRadiusForKonva(node, defaultR)`:
  - 4개 per-corner 필드가 모두 missing → `defaultR` 그대로 반환 (uniform).
  - 4개 모두 같은 값 (`tl === tr === br === bl`) → 해당 값 반환 (uniform; array 안 만듦).
  - 어느 하나라도 다르면 `[tl ?? defaultR, tr ?? defaultR, br ?? defaultR, bl ?? defaultR]` 반환.
- I-CR2 cornerRadiusForKonva 반환값은 Konva.Rect 의 `cornerRadius` prop 에 그대로 전달 (number 또는 array, 둘 다 받음).

### 2.3 strokeAlign 와 결합

- I-CR3 round2 의 strokeAlign INSIDE/OUTSIDE 변환은 cornerRadius 에 `±strokeWeight/2` offset 을 적용. per-corner array 인 경우에도 모든 4개 항목에 동일 offset 적용 (음수 clamp 0).
- I-CR4 strokeAlign 변환은 `applyStrokeAlign` 안에서 수행 — cornerRadius 가 array 일 때도 정상 동작하도록 그 함수 시그니처 확장.

## 3. textCase

### 3.1 Field shape

```ts
node.textCase?: 'ORIGINAL' | 'UPPER' | 'LOWER' | 'TITLE'
```

Figma 의 textCase 는 *렌더 시점* 의 대소문자 변환 — `textData.characters` 자체는 원본 그대로 저장하고 표시할 때만 변환. 우리 코드도 같은 모델.

### 3.2 Transform

- I-TC1 `applyTextCase(chars, textCase)`:
  - `'UPPER'` → `chars.toUpperCase()`
  - `'LOWER'` → `chars.toLowerCase()`
  - `'TITLE'` → 단어 단위 첫글자 대문자, 나머지 소문자. 단어 = `\s+` 로 split.
  - `'ORIGINAL'` 또는 missing → `chars` 그대로.
- I-TC2 한국어 / CJK 문자는 case 가 없으므로 변환 무시 (JavaScript `toUpperCase()` 가 그대로 통과).
- I-TC3 변환 결과만 KText 의 `text` prop 으로 전달. 원본 `characters` 는 message.json 그대로 보존 (Figma 와 동일).

## 4. textDecoration

### 4.1 Field shape

```ts
node.textDecoration?: 'NONE' | 'UNDERLINE' | 'STRIKETHROUGH'
```

### 4.2 Konva 매핑

- I-TD1 `konvaTextDecoration(figma)`:
  - `'UNDERLINE'` → `'underline'`
  - `'STRIKETHROUGH'` → `'line-through'`
  - `'NONE'` 또는 missing 또는 unknown → `undefined` (prop omit).
- I-TD2 Konva.Text 의 `textDecoration` prop 은 string CSS-like 값을 받으므로 그대로 전달.
- I-TD3 동시 적용 (underline + strikethrough) 은 메타리치/일반 Figma 데이터에서 미사용. 본 spec v1 에서 단일만.

## 5. 비대상 (v1)

- **rectangleCornerRadiiData (배열 형태)** — 메타리치 0 노드. 다른 일부 .fig 가 array 형태로 corner 정보 저장하는 경우 대비해 future round 후보.
- **textCase TITLE 의 다국어 토큰화** — 영문 단어 split 만 (`\s+`). 한국어는 case 변환 자체가 무의미.
- **TEXT 의 textDecoration 가 INSTANCE 내 자손에서 override 되는 경우** — 현재 path-keyed override 는 `characters` 만 적용, `textDecoration` override 는 미지원. 데이터 분포상 0 — 발견 시 별도 라운드.
- **double textDecoration** (underline + strikethrough 동시).

## 6. Resolved questions

- **per-corner 4개가 모두 같으면 array 로 보내지 말 것** — Konva 가 array 도 받지만 number 가 더 가볍고 cornerRadius=0 의 short-circuit 도 동작. 동일값이면 number 로 보내는 게 cleaner.
- **strokeAlign 의 offset 은 array 에 어떻게 적용?** — 4개 항목에 동일 offset (`±strokeWeight/2`) 적용. 음수는 0 으로 clamp. 동일 로직, 단순 array map.
- **textCase 변환 후 INSTANCE override 와의 관계** — instance 가 `characters` 를 override 하면 그 override 가 먼저 적용되고, 그 결과에 textCase 변환이 일어남. 즉 master textCase=UPPER + instance characters="hello" → "HELLO" 표시. 자연스러운 의미.
