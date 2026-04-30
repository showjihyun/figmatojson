# spec/html-to-message

| 항목 | 값 |
|---|---|
| 상태 | Approved (Iteration 10) |
| 책임 모듈 | `src/html-to-message.ts` (신규) |
| 의존 | `src/decoder.ts` (schema), `src/assets.ts::hashToHex`, htmlparser2 (parsing) |
| 테스트 | `test/html-to-message.test.ts` |
| 부모 SPEC | [SPEC-roundtrip §4](../SPEC-roundtrip.md) |
| 의존 spec | [text-segments.spec.md](./text-segments.spec.md), [parent-index-position.spec.md](./parent-index-position.spec.md) |

## 1. 목적

편집 가능 HTML(`figma.editable.html`) + sidecar(`figma.editable.meta.js`) → 갱신된 KiwiMessage 객체. 이 객체를 `kiwi.compileSchema(schema).encodeMessage(msg)`에 입력하면 새 .fig 생성 가능.

## 2. 입력

```ts
interface HtmlToMessageInputs {
  htmlPath: string;               // figma.editable.html 경로
  sidecarPath?: string;           // figma.editable.meta.js (기본: htmlPath 같은 디렉토리)
  schema: kiwi.Schema;            // 원본 .fig의 schema (추출에서 가져옴)
  options?: {
    strict?: boolean;             // default true. 형식 깨지면 즉시 에러 vs warning만
    onUnknownElement?: 'ignore' | 'preserve' | 'error';  // default 'preserve' — sidecar에 있던 raw 보존
  };
}
```

## 3. 출력

```ts
interface HtmlToMessageResult {
  message: KiwiMessage;           // 갱신된 nodeChanges 포함
  stats: {
    nodesTotal: number;           // 총 노드 수 (원본 + 변경)
    nodesEditedTierA: number;     // HTML에서 변경된 노드
    nodesEditedTierB: number;     // sidecar에서 변경된 노드
    nodesRemoved: number;         // DOM에 없는 (REMOVED phase)
    nodesAddedAttempted: number;  // DOM에 새로 추가 (v2 미지원이므로 0이어야 — D-4)
    warnings: string[];           // 손실 가능 요소 (예: 알 수 없는 paint type)
  };
}
```

## 4. Invariants

### I-1 GUID 보존 100%

원본 sidecar의 GUID 집합이 결과 message에 모두 등장 (REMOVED 포함).

```
∀ guid ∈ sidecar.nodes:
   ∃ nc ∈ message.nodeChanges, nc.guid의 string === guid
```

### I-2 노드 추가 거부 (D-4)

DOM에 `data-figma-id` 없는 element가 있으면:
- `options.onUnknownElement === 'error'` → throw
- `'preserve'` (default) → warning만, 결과 message에 추가하지 않음
- `'ignore'` → silent skip

```
options.strict === true ∧ data-figma-id 없는 element 존재
   ⇒ throw 또는 warning에 명시
```

(v3에서 노드 추가 지원 시 본 invariant 변경)

### I-3 Tier A > Tier B 우선

HTML에 표현된 필드가 sidecar 값과 다르면 HTML 값 사용.

```
∀ guid, ∀ field ∈ Tier A:
   tierAValue(html, guid, field) !== undefined
   ⇒ result.nodes[guid][field] === tierAValue
```

### I-4 미편집 노드 byte-level 동등

사용자가 편집 안 한 노드는 raw 필드가 원본과 byte-level 동등.

```
∀ guid, ∀ field:
   editedInHtml(guid, field) === false
   ∧ editedInSidecar(guid, field) === false
   ⇒ result.nodes[guid][field] === original.nodes[guid][field]
```

### I-5 Tier C 자동 설정

도구가 자동 설정:
- `guid`: HTML element의 `data-figma-id`로 복원 (`"S:L"` → `{sessionID:S, localID:L}`)
- `parentIndex.guid`: HTML 부모 element의 `data-figma-id`
- `parentIndex.position`: DOM 형제 순서로 재계산 — [parent-index-position.spec.md](./parent-index-position.spec.md) 따라
- `phase`:
  - DOM에 있고 sidecar에 있음 → 원본 phase 유지 (보통 `CREATED`)
  - DOM에 있고 sidecar에 없음 → `CREATED` (v3 노드 추가)
  - DOM에 없고 sidecar에 있음 → `REMOVED`

### I-6 CSS 역변환 룰

[SPEC-roundtrip §4.2](../SPEC-roundtrip.md)의 모든 매핑이 양방향.

핵심:
- `width: Npx` → `size.x = N`
- `height: Npx` → `size.y = N`
- `left: Xpx; top: Ypx` → `transform.m02 = X; m12 = Y`
- `transform: matrix(a,b,c,d,e,f)` → `m00=a, m10=b, m01=c, m11=d, m02=e, m12=f`
- `background-color: rgba(R,G,B,A)` → `fillPaints = [{type:'SOLID', color:{r:R/255, g:G/255, b:B/255, a:A}, visible:true, opacity:1, blendMode:'NORMAL'}]`
- `background-color: transparent` → `fillPaints = []`
- `opacity: O` → `opacity = O`
- `display: none` → `visible = false`
- `border-radius: Rpx` → `cornerRadius = R` (또는 cornerRadii 4개 분리)
- `border: Wpx solid color` → `strokePaints[0] = {type:'SOLID', color}; strokeWeight = W`
- `box-shadow: X Y B [S] color [inset]` → `effects[]` (DROP_SHADOW 또는 INNER_SHADOW)
- `filter: blur(Npx)` → `effects[] += {type:'LAYER_BLUR', radius:N}`
- `backdrop-filter: blur(Npx)` → `effects[] += {type:'BACKGROUND_BLUR', radius:N}`
- `mix-blend-mode: X` → `blendMode = X.toUpperCase()`
- `font-size: Npx` → TEXT `fontSize = N`
- `font-family: F1, F2, ...` → TEXT `fontName.family = F1` (첫 family)
- `color: rgba(...)` → TEXT `fillPaints[0].color`
- `text-align: X` → `textAlignHorizontal = X.toUpperCase()`
- TEXT 노드 segment → [text-segments.spec.md](./text-segments.spec.md) 룰

### I-7 SVG path → commandsBlob 재인코딩 (best-effort)

`<svg><path d="..."/></svg>`의 `d` 속성이 변경된 경우, path command 파싱 → commandsBlob byte stream 재생성.

성공 시: blob 갱신, message 그대로.
실패 시 (지원 안 되는 SVG path 명령): warning + 원본 commandsBlob 보존.

```
SVG path 'M0 0 L10 10' → bytes [0x01, 0x00*8, 0x02, 0x00*4, 0x41200000*2 ...]
```

상세 매핑은 본 spec 부록 A 참조.

### I-8 message 최상위 보존

`message.type`, `message.sessionID`, `message.ackID` 등 top-level 필드는 sidecar의 `__meta` + `message`에서 복원.

### I-9 결정성

같은 HTML + sidecar → 같은 message (byte-level).

## 5. Error Cases

| ID | 조건 | 행동 |
|---|---|---|
| E-1 | HTML 파싱 실패 (malformed) | throw `Error("html-to-message: parse error at line N")` |
| E-2 | sidecar 로드 실패 (`window.FIGMA_RAW` 없음) | throw |
| E-3 | sidecar의 `__meta.archiveVersion` !== schema 호환 archiveVersion | throw `"version mismatch"` |
| E-4 | data-figma-id 형식 불량 (예: "abc") | strict면 throw, 아니면 skip + warning |
| E-5 | 부모-자식 cycle (HTML이 어떻게든 깨진 경우) | throw |
| E-6 | sibling position 재계산 실패 | throw, [parent-index-position.spec.md](./parent-index-position.spec.md) 참조 |
| E-7 | TEXT segment 형식 불량 (`<span data-style-id="...">`가 깨짐) | strict면 throw, 아니면 plain text fallback + warning |
| E-8 | CSS 값 파싱 실패 (예: `width: NaN`) | warning, 원본 값 유지 |

## 6. Out of Scope

- O-1: HTML 생성 — [editable-html.spec.md](./editable-html.spec.md)
- O-2: 노드 추가 (D-4) — v3
- O-3: kiwi encode + 압축 + ZIP 패키징 — `repack.ts` 재사용 (별도 단계)
- O-4: schema 자체 변경 — schema는 input으로 받고 그대로 사용
- O-5: 사용자가 schema 외 type 추가 — 무시 또는 strict 시 error
- O-6: blob 의미 변경 (commandsBlob 외 어떤 blob의 byte 직접 수정) — sidecar에서 byte 수정한 경우만 반영, 의미 검증은 안 함

## 7. 부록 A — SVG path → commandsBlob 매핑

| SVG command | commandsBlob byte | float32 args |
|---|---|---|
| `M x y` | 0x01 | x, y |
| `L x y` | 0x02 | x, y |
| `C c1x c1y c2x c2y x y` | 0x03 | 6 floats |
| `Q cx cy x y` | 0x04 | 4 floats |
| `Z` | 0x05 | (none) |

지원 안 됨 (warning):
- `H`, `V` (수평·수직만) — `L`로 변환 가능, 예외 없이 변환
- `S`, `T` (smooth) — 직전 control point 추정해 `C`/`Q`로 변환
- `A` (arc) — best-effort: arc → cubic Bezier 근사

## 8. 참조

- 부모: [SPEC-roundtrip §4](../SPEC-roundtrip.md)
- 형제: [editable-html.spec.md](./editable-html.spec.md), [sidecar-meta.spec.md](./sidecar-meta.spec.md)
- 의존: [text-segments.spec.md](./text-segments.spec.md), [parent-index-position.spec.md](./parent-index-position.spec.md)
