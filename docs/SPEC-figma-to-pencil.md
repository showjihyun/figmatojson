# SPEC: Figma → pencil.dev Copy/Paste 변환

**Status**: 역공학 완료 (Pencil v1.1.55, app.asar 분석 기반)
**Last updated**: 2026-05-01
**Audit baseline**: `docs/메타리치 화면 UI Design.pen` (pencil.dev paste 결과)

이 문서는 Figma 의 `.fig` 바이너리 데이터가 pencil.dev 에 복사/붙여넣기 될 때 적용되는
변환 규칙을 정리합니다. 본 프로젝트의 `pen-export` 출력이 pencil.dev 의 paste 결과와
동일하도록 보장하기 위한 SPEC 입니다.

---

## 1. 데이터 흐름 개요

```
.fig (binary)
  │
  ├── kiwi-schema decode → message {nodeChanges[], blobs[]}
  │
  ├── INSTANCE 확장
  │     ├── master 트리 클론
  │     ├── symbolOverrides 적용 (nested INSTANCE 까지 propagation)
  │     ├── derivedSymbolData 적용 (Figma 사전-resolved 값 stamp)
  │     └── overriddenSymbolID 처리 (instance swap)
  │
  ├── 노드별 .pen 변환
  │     ├── 시각 속성: fill, stroke, cornerRadius, opacity, effects
  │     ├── 레이아웃: layout / gap / padding / justifyContent / alignItems
  │     ├── 사이즈 정책: Fixed / FillContainer / FitContent
  │     ├── 위치: parent layout 에 따라 명시 또는 omit
  │     ├── 텍스트: fontFamily / fontWeight / fontSize / lineHeight / letterSpacing
  │     └── path geometry: VECTOR 노드 별 vectorNetworkBlob 디코드
  │
  └── .pen JSON 직렬화
```

---

## 2. INSTANCE 확장 규칙

### 2.1 symbolOverrides 적용

**입력 형태** (Figma `.fig` 의 INSTANCE 노드 `symbolData.symbolOverrides[]`):
```ts
{ guidPath: { guids: [{sessionID, localID}, ...] },  // master 트리 안의 path
  textData?: { characters?: string, lines?: [...] },
  visible?: boolean,
  size?: {x, y},
  cornerRadius?: number,
  strokePaints?: [...],
  borderRightWeight?: number,
  /* etc. - 임의의 master 필드 override */ }
```

**규칙**:

1. **guidPath 길이 = 1**: master 의 직접 자식 노드를 타겟. 매칭되는 자식의 `data` 에
   override 필드를 **deep-merge** (textData 같은 nested 객체는 부분 키 병합 — 단순
   shallow assign 시 master 의 styleOverrideTable, fontMetaData 등이 유실됨).

2. **guidPath 길이 ≥ 2**: 중첩된 INSTANCE 를 거쳐 도달해야 하는 노드 타겟.
   직접 자식이 INSTANCE (children 비어있음 — expansion 전) 인 경우, `guidPath.guids` 의
   첫 원소를 제거한 nested override 를 그 INSTANCE 의 `symbolData.symbolOverrides` 에
   **추가 주입**. 그 INSTANCE 가 추후 expand 될 때 함께 적용됨.

   **이전 버그**: nested override 를 자식의 (빈) children 에 recurse 만 → override 유실.
   특히 Dropdown 같은 다단계 INSTANCE 에서 option 의 텍스트 override 6개 ("오늘", "최근 1주일", ...) 가 모두 사라짐.

3. **direct merge 시 주의**:
   - `textData` override 는 `{characters, lines}` 만 들어있으므로 master 의 textData 와
     deep-merge (`{...master.textData, ...override.textData}`) 해야 함.
   - 같은 원리로 `symbolData` 도 deep-merge.

### 2.2 overriddenSymbolID (instance swap)

INSTANCE 의 `data.overriddenSymbolID` 가 있으면, master 결정 시 그 값을 우선 사용
(기본 `symbolData.symbolID` 보다 앞순위). Figma 의 "Swap instance" 기능에 해당.

```ts
const sid = instance.overriddenSymbolID ?? instance.symbolData.overriddenSymbolID
         ?? instance.symbolData.symbolID;
const master = symbolIndex.get(`${sid.sessionID}:${sid.localID}`);
```

### 2.3 derivedSymbolData 적용

Figma 가 **per-instance 사전-resolved** snapshot 으로 제공하는 데이터.
원본 master 에서 우리가 다시 resolve 하면 gap 발생 → `derivedSymbolData` 가 authoritative.

```ts
derivedSymbolData[]: {
  guidPath: { guids: [...] },     // master 트리 내 descendant 경로
  derivedTextData?: {              // text 노드용 — fully-resolved font metadata
    layoutSize, baselines, glyphs, fontMetaData, derivedLines, ...
  },
  fillGeometry?: [{ commandsBlob }],  // vector 노드용 — instance 별 path
  size?: {x, y},                   // instance 에서의 실제 크기
  transform?: {...},               // instance 에서의 실제 위치
}
```

guidPath 매칭 노드의 `data` 에 `_derivedTextData`, `_derivedFillGeometry`, `_derivedSize`,
`_derivedTransform` 마커 stamp. `convertNode` 의 text/path branch 가 이 마커를 우선 사용.

---

## 3. Color Variable Alias 해석

Figma 의 paint 객체:
```ts
{ type: "SOLID",
  color: { r, g, b, a },                  // 직접 RGBA (placeholder 일 수 있음)
  opacity: 1,
  visible: true,
  colorVar?: {                              // Color Variable 참조 (있으면 우선)
    value: { alias: { guid: { sessionID, localID } } },
    dataType: "ALIAS",
    resolvedDataType: "COLOR",
  } }
```

**규칙**: `colorVar.dataType === "ALIAS"` 이면 alias chain 을 따라 실제 RGBA 를 resolve
하고 paint.color 대신 사용.

**Why**: Figma override 는 paint.color 를 placeholder (`{r:1,g:1,b:1,a:1}`) 로 stamp 하면서
alias 만 정확히 유지하는 경우가 있음 (Dropdown stroke `#c4cfddff` vs naive `#ffffffff` 케이스).
pencil.dev 는 항상 alias 를 따라가 정확한 색을 얻음.

**Variable 노드 형태** (NodeChanges 안의 `type: "VARIABLE"`):
```ts
{ guid, name: "Border/Default",
  variableResolvedType: "COLOR",
  variableDataValues: {
    entries: [{
      modeID,
      variableData: {
        dataType: "ALIAS" | "COLOR",
        value: {
          alias?: { guid: {...} },        // ALIAS 인 경우
          colorValue?: { r, g, b, a },    // COLOR 인 경우
        },
      },
    }],
  } }
```

resolver 는 ALIAS chain 을 재귀적으로 따라가 COLOR 를 만날 때까지 진행. 캐시로 cycle 방지.

---

## 4. 사이즈 정책 (TQ + uw + VZ 함수)

pencil.dev 의 정확한 알고리즘 (역공학):

### 4.1 사이즈 분류 (axis 별, `TQ`)

각 axis (x=Horizontal, y=Vertical) 에 대해 다음 우선순위로 결정:

```
n = perpendicular axis (queried 의 반대축)
i = parent.stackMode 의 방향 (HORIZONTAL/VERTICAL/null)
r = self.stackMode 의 방향

return (
  // 부모 stack 이 perpendicular 이고 self 가 STRETCH → FillContainer
  (i === n && self.stackChildAlignSelf === "STRETCH") ||
  (i === e && self.stackChildPrimaryGrow)
    ? FillContainer :

  // 자기 stack 이 perpendicular 이고 RESIZE_TO_FIT_WITH_IMPLICIT_SIZE → FitContent
  (r === n && self.stackCounterSizing === "RESIZE_TO_FIT_WITH_IMPLICIT_SIZE")
    ? FitContent :

  // 자기 stack 이 along 이고 FIXED → Fixed
  (r === e && self.stackPrimarySizing === "FIXED") ||
  (i === e && self.stackChildPrimaryGrow)
    ? Fixed :

  // 자기 stack 이 along (FIXED 아님) → FitContent
  r === e ? FitContent : Fixed
);
```

### 4.2 사이즈 직렬화 (`uw` + `VZ`)

```
fit_content(N) emit 결정 (FitContent 인 경우):

let hasContent = self.hasLayout()
              && self.children.some(c => c.affectsLayout()
                                       && c.sizingBehavior[axis] !== FillContainer);

if (hasContent) → "fit_content"  (fallback 없음 — 자식이 알아서 채움)
else            → "fit_content(N)"  (fallback N — 자식이 비었을 때 표시할 사이즈)
```

여기서:
- `affectsLayout()` = `node.enabled && node.position === 0`
  - `enabled` = visible (`visible !== false` AND `componentPropAssignments(VISIBLE)` 토글 false 아님)
  - `position === 0` = NORMAL (not ABSOLUTE / not FLOATING)
- `hasLayout()` = `stackMode in {HORIZONTAL, VERTICAL}`

**FillContainer 도 동일 패턴**:
```
if (self.isInLayout()) → "fill_container"  (parent layout 안에서는 fallback 불필요)
else                   → "fill_container(N)"  (parent 가 layout 아닌 경우 fallback)
```

### 4.3 위치 명시 vs omit

부모가 auto-layout (`stackMode in {HORIZONTAL, VERTICAL}`) 이면 자식 위치는 omit
(자동 계산되므로). 단, 다음 경우는 명시:
- `stackPositioning === "ABSOLUTE"` (자식이 floating)
- 자식이 `visible: false` 또는 prop assignment 로 hidden (flow 에서 빠지므로)
- `_showPos: true` (overlap / shrunk reflow 마커)

부모가 auto-layout 이 아닌 경우 (`stackMode === "NONE"` 또는 없음) 모든 자식은
**좌표 0 이어도 명시 emit** (`x: 0, y: 0`).

---

## 5. Path Geometry 처리

### 5.1 Source 우선순위

pencil.dev 는 path 를 `vectorData.vectorNetworkBlob` 에서 직접 디코드 (정확한 source).
`fillGeometry.commandsBlob` 은 Figma 의 사전-계산된 fill outline 으로, 정밀도가 다를 수 있음.

**규칙**:
1. master VECTOR 노드: `vectorData.vectorNetworkBlob` 우선, 없으면 `fillGeometry.commandsBlob`.
2. INSTANCE 확장 (per-instance path): master 의 `vectorData.vectorNetworkBlob` 우선,
   없으면 `derivedSymbolData[].fillGeometry.commandsBlob` (legacy fallback).

### 5.2 vectorNetworkBlob 포맷 (역공학)

모든 정수는 LE uint32, 모든 실수는 LE float32:

```
header (12 bytes):
  vertexCount  (uint32)
  segmentCount (uint32)
  regionCount  (uint32)

vertex (12 bytes × vertexCount):
  styleID (uint32)
  x (float32)
  y (float32)

segment (28 bytes × segmentCount):
  styleID (uint32)
  start.vertex (uint32)   // index into vertices
  start.dx (float32)      // tangent vector (control point delta from start vertex)
  start.dy (float32)
  end.vertex (uint32)
  end.dx (float32)
  end.dy (float32)

region (variable × regionCount):
  packed (uint32):           // (styleID << 1) | (windingRule_bit)
                             //   bit 0: 1=NONZERO, 0=ODD
  loopCount (uint32)
  loop (variable × loopCount):
    segmentCount (uint32)
    segmentIndex (uint32 × segmentCount)  // indices into segments
```

### 5.3 Path 빌드 알고리즘 (`xQ`)

```
For each region (또는 0개면 segments 전체를 한 묶음으로):
  For each loop:
    segs = loop.segments.map(idx => allSegments[idx])
    segs = orientSegments(segs)  // 연속된 endpoint 일치하도록 reverse
    buildPathFromSegments(vertices, segs)
```

**`orientSegments` (`EQ`)**:
- 길이 < 2 → 그대로
- 첫 segment 의 end 가 두 번째의 start/end 모두 아니면 첫 segment reverse
- 이후 각 segment 에 대해, 이전 segment 의 end 와 현재의 start 가 다르면 현재 reverse

**`reverseSegment` (`AQ`)**: start ↔ end 스왑 (vertex 인덱스, dx, dy 모두).

**`buildPathFromSegments` (`xQ` 의 핵심 루프)**:
```
state: lastVertex, subpathStart
for each segment s:
  a = vertices[s.start.vertex]
  b = vertices[s.end.vertex]

  if lastVertex !== s.start.vertex:
    emit "M{a.x} {a.y}"
    subpathStart = s.start.vertex

  if s.start.dx == 0 && s.start.dy == 0 && s.end.dx == 0 && s.end.dy == 0:
    emit "L{b.x} {b.y}"        // 양쪽 tangent 0 → 직선
  else:
    emit "C{a.x+s.start.dx} {a.y+s.start.dy} {b.x+s.end.dx} {b.y+s.end.dy} {b.x} {b.y}"

  lastVertex = s.end.vertex
  if subpathStart !== undefined && s.end.vertex === subpathStart:
    emit "Z"                    // subpath 가 시작점으로 닫혔음
    lastVertex = undefined
    subpathStart = undefined
```

### 5.4 Absolute → Relative 변환 (`vpe = dpe(t).rel().round(5)`)

pencil.dev 가 사용하는 `svgpath` 라이브러리의 정확한 알고리즘:

**1단계 — `.rel()`**: 첫 M 외 모든 명령을 lowercase + 직전 점 기준 상대좌표.
- 첫 M 만 absolute (대문자 M).
- 그 외 M, L, C, Q 모두 m, l, c, q (소문자) 로. 모든 인자에서 직전 점 좌표를 빼서 delta 산출.
- Z/z 는 그대로.

**2단계 — `.round(5)`**: **Error-accumulation rounding** (단순 toFixed 아님).
- carry `(c, u)`: 직전 segment endpoint 의 (원본 - 반올림값) 누적 오차.
- carry `(a, l)`: 현재 subpath start 의 carry (Z 시 복원).
- 각 segment 처리:
  ```
  if isRel: args[len-2] += c; args[len-1] += u   // endpoint 만 carry 누적
  c = args[len-2] - toFixed(args[len-2], 5)       // 새 carry = 누적된값 - 반올림
  u = args[len-1] - toFixed(args[len-1], 5)
  for each non-letter arg: args[i] = +args[i].toFixed(5)   // 모든 인자 5자리 반올림
  ```
- M/m: endpoint = args[0,1]. 추가로 `a = c, l = u` (subpath start carry 갱신).
- Z/z: `c = a, u = l` (subpath start carry 로 복원).

**왜 error-accumulation 인가**: 각 segment 를 독립적으로 반올림하면 endpoint 의 누적
좌표가 원본에서 점점 드리프트됨. carry 누적 방식은 누적 위치의 정확도를 유지.

### 5.5 Path 직렬화 인코딩 룰 (svgpath `.toString()` 호환)

```
- 같은 cmd 가 연속되면 두 번째부터 letter 생략 (M/m 제외 — 다음 cmd 가 implicit L 이라서)
- 첫 인자: letter 다음에 바로 붙임 (공백 X)
- 후속 인자:
    - 음수 (`-` 시작): sign 자체가 separator → 공백 X
    - 양수: 단일 공백
- 0 < x < 1: 선택적으로 leading zero 제거 가능 (`0.5` → `.5`).
  ※ 우리 출력은 leading zero 유지 — pencil.dev reference 와 일치.
```

**예**:
- `M11 14 C10.8 14 10.6 14.1 10.5 14.2 C10.3 14.3 10.2 14.5 10.1 14.7`
  → `M11 14c-0.2 0-0.4 0.1-0.5 0.2-0.2 0.1-0.3 0.3-0.4 0.5`

### 5.6 알려진 잔여 오차 (Skia float32 ↔ float64)

Pencil 은 path 를 Skia/CanvasKit `PathBuilder.cubicTo()` 로 빌드 → `toSVGString()` 출력.
Skia 내부는 모든 좌표를 **float32** 로 저장. 우리 파이프라인은 float32 → float64 promotion
후 산술 → float64 결과. 일부 경우 1 ULP (5번째 소수점 자리) 차이가 발생할 수 있음.

이 차이는 **시각적으로 구분 불가능** (~1e-5 픽셀 단위). Math.fround 로 float32 truncation
을 강제해도 Skia 의 내부 부동소수점 처리가 다르게 누적되는 경우는 완벽히 제거 어려움.

---

## 6. 텍스트 처리

### 6.1 fontWeight 매핑 (fontName.style → 문자열)

```
"Thin"        → "100"
"ExtraLight" / "Extra Light" → "200"
"Light"       → "300"
"Regular"     → "normal"
"Medium"      → "500"
"SemiBold" / "Semi Bold" → "600"
"Bold"        → "700"
"ExtraBold" / "Extra Bold" → "800"
"Black"       → "900"
"ExtraBlack" / "Extra Black" → "950"
"Italic"      → fontStyle: "italic" (별도)
```

### 6.2 textAlignVertical

```
"TOP"    → "top"
"CENTER" → "middle"  (NOT "center")
"BOTTOM" → "bottom"
```

### 6.3 letterSpacing

```ts
{ value, units: "RAW" | "PIXELS" | "PERCENT" }
```
- RAW: value 그대로 (배수 단위)
- PIXELS: value 그대로 (px)
- **PERCENT: `value / 100 × fontSize`** (절대 px 로 변환)

### 6.4 lineHeight

```
RAW:     value 그대로
PIXELS:  value / fontSize (배수로 변환)
PERCENT: 100% 면 0 (omit), 그 외는 warn (실측: 100% 외엔 거의 안 나옴)
```

### 6.5 textAutoResize → textGrowth

```
"NONE" / "TRUNCATE"   → "fixed-width-height"
"WIDTH_AND_HEIGHT"    → "auto"  (default — omit)
"HEIGHT"              → "fixed-width"  (width 고정, height 텍스트 길이)
```

### 6.6 textAlignHorizontal

```
"LEFT"      → "left"
"CENTER"    → "center"  (default — omit)
"RIGHT"     → "right"
"JUSTIFIED" → "justify"
```

---

## 7. Stroke / Border

### 7.1 strokeAlign 매핑

```
"INSIDE"  → "inside"
"OUTSIDE" → "outside"
기타 / "CENTER" → "center"
```

### 7.2 비대칭 stroke

`borderStrokeWeightsIndependent === true` 면 `border{Top,Right,Bottom,Left}Weight` 의 객체로:
```ts
thickness: { top?: number, right?: number, bottom?: number, left?: number }
```
정의되지 않은 면은 thickness 객체에서 omit (= 두께 0 으로 해석).

### 7.3 paint.opacity 합성

stroke / fill 모두 **`color.a × paint.opacity`** 가 최종 알파.
둘 중 하나만 보면 진한 색이 나옴.

### 7.4 Image fill

```ts
{ type: "IMAGE",
  imageScaleMode: "FILL" | "FIT" | "STRETCH" | "CROP" | "TILE",
  image: { hash: Uint8Array, name },
  ... }
```

매핑 (필드명 주의 — `imageScaleMode`, NOT `scaleMode`):
```
"FILL"           → "fill"   (default)
"FIT"            → "fit"
"STRETCH" / "CROP" → "stretch"
"TILE"           → "tile"
```

---

## 8. Shadow / Effects

```ts
effects[]: { type: "DROP_SHADOW" | "INNER_SHADOW",
              color: { r, g, b, a },
              offset: { x, y },
              radius, spread, ... }
```

매핑:
- color: 6자리 hex (불투명 그림자) 또는 8자리 hex (반투명 — `colorToHexShortAlpha`)
- offset: 그대로 `{x, y}`
- **blur: `radius × 0.875`** (Pencil 컨버전 비율 — 실측 `radius 4 → blur 3.5, 8 → 7`)
- spread: 그대로

---

## 9. 좌표계 / 정규화

### 9.1 Top-level 좌표 보존

pencil.dev paste 는 Figma 의 원본 좌표를 그대로 보존 (음수 Y, 비-zero origin OK).
Pencil 에디터가 bounding box 중심으로 자동 스크롤하므로 normalize 불필요.

**예외**: Figma 페이지가 극단적인 오프셋(-32000 등) 에 있는 경우만 (0,0) 정렬.
임계값: `min coord >= -2000` 이면 그대로 보존, 더 음수면 normalize.

### 9.2 Position 명시 정책

- 부모 auto-layout: omit (위 §4.3 참조)
- 부모 NOT auto-layout: 항상 명시 (`x: 0, y: 0` 도 명시)
- TEXT 노드: `textAutoResize === "NONE"` 외엔 항상 omit (텍스트 자체가 위치 결정)

---

## 10. ID 재발급

`.pen` 의 모든 노드 id 는 base62 [0-9A-Za-z] 5-6자. Figma GUID(`sessionID:localID`)와 무관.

**알고리즘** (round-trip 결정성을 위해):
- pageSeed = `${page.guidStr}|${sourceFigSha256}`
- 노드 순회 순서대로 SHA-256(pageSeed + index) 의 처음 5자 base62 → 충돌 시 6자 확장
- 페이지마다 다른 seed → 페이지 간 ID 충돌 없음
- 같은 입력 → 같은 ID (deterministic)

`.pen.json` 의 `__figma.idMap` 에 `{newId → originalGuidStr}` 매핑 보존 (round-trip 디버깅용).

---

## 11. 검증 / Audit

```bash
# 비교 도구
node _tmp_pen_css_audit.cjs
```

**현재 상태** (00_design setting.pen 기준):

| 카테고리 | 필드 수 × 노드 수 | Diff |
|---|---|---|
| frame | 17 × 123 = 2,091 비교 | **0** ✅ |
| rectangle | 9 × 22 = 198 | **0** ✅ |
| text | 15 × 44 = 660 | **0** ✅ |
| path | 9 × 2 = 18 | **1** (geometry — Skia float32 ULP) |
| Unmatched signatures | — | **0** ✅ |

회귀 테스트: **100/100 pass**.

---

## 12. 출처 / Reference

- **Figma `.fig` format**: Evan Wallace 의 reverse engineering (https://github.com/evanw/figma-fig-format-decoder)
- **Pencil v1.1.55 app.asar**: `~/AppData/Local/Programs/Pencil/resources/app.asar`
  - `parseVectorNetworkBlob`, `xQ`, `EQ`, `AQ` (path build)
  - `TQ`, `uw`, `VZ` (size policy)
  - `vpe`, `dpe.rel()`, `dpe.round()` (path encoding via `svgpath` library)
  - `applyOverrides`, `replaceInstanceProps` (instance expansion)
  - text/font weight mapping, letterSpacing/lineHeight units, textAlignVertical
- **`svgpath` 라이브러리**: https://github.com/fontello/svgpath (pencil 이 사용)
- **`derivedSymbolData`**: Figma 의 클립보드 직렬화가 사용하는 사전-resolved snapshot

---

## 13. 변경 로그

| 날짜 | 변경 사항 |
|---|---|
| 2026-05-01 | 초안 — INSTANCE/Override/ColorVar/Path/Size/Text/Effects 전 영역 SPEC 화 |
| 2026-05-01 | vectorNetworkBlob 디코더 + svgpath error-accumulation rounding 구현 |
| 2026-05-01 | fit_content(N) 의 `affectsLayout` + propAssignments 룰 정확 구현 |
