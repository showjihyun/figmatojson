# Figma `.fig` 파일 구조 (Reverse-Engineered)

> Figma 가 공식 문서화하지 않은 internal binary format 의 reverse-engineered 그림.
> Evan Wallace (전 Figma CTO) 가 만든 [kiwi](https://github.com/evanw/kiwi) binary
> schema 라이브러리를 컨테이너로 사용. 이 문서는 .fig 파일을 raw bytes 부터 시작해
> Figma 의 화면 요소까지 어떻게 도달하는지 *세 단계의 디코딩* 으로 정리한다.

---

## 0. 한눈에 보기

`.fig` 파일은 세 layer 의 디코딩을 거쳐야 의미가 나온다:

```
┌──────────────────────────────────────────────────────────────┐
│  Layer 1: 파일 컨테이너                                        │
│  [magic 8B][version 4B][length-prefixed chunks ...]          │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 2: Schema chunk 해석                                   │
│  압축 해제 → kiwi binary schema → 558개 type 정의              │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
┌──────────────────────────────────────────────────────────────┐
│  Layer 3: Data chunk 해석                                     │
│  압축 해제 → schema 로 디코드 → Message + 노드 트리             │
└──────────────────────────────────────────────────────────────┘
              │
              ▼
       Figma UI (Layers / Canvas / Inspector)
```

**핵심 원칙 3가지:**

1. **Self-describing**: schema 자체가 파일에 동봉됨 → forward/backward compat
2. **Linearly serializable**: 모든 디코드가 single forward scan, no look-ahead
3. **Tag-based wire format**: optional field 와 새 field 추가가 자유로움

---

## 1. Layer 1 — 파일 컨테이너

### 전체 레이아웃

```
offset  size    field
─────────────────────────────────────────
0x00    8       magic = "fig-kiwi" (ASCII)
0x08    4       version (uint32 LE)
0x0C    4       chunk[0] length (uint32 LE)
0x10    N0      chunk[0] bytes
0x10+N0 4       chunk[1] length
...     N1      chunk[1] bytes
        4       chunk[2] length      (있을 수도 없을 수도)
        N2      chunk[2] bytes
        ...                          (EOF 까지 반복)
```

### 디코더 의사코드

```javascript
const magic = readBytes(8);                  // "fig-kiwi"
const version = readUint32LE();              // file format version
const chunks = [];
while (offset < bytes.length) {
  const len = readUint32LE();
  chunks.push(readBytes(len));
}
if (chunks.length < 2) throw 'invalid';
```

### 약속된 chunk 의미

| index | 내용 | 필수 여부 |
|---|---|---|
| `chunk[0]` | Schema (kiwi binary) | 필수 |
| `chunk[1]` | Data (Message) | 필수 |
| `chunk[2]` | Preview thumbnail (PNG bytes) | 옵션 |
| `chunk[3+]` | 미래 확장용 | 현재 알려진 사용 없음 |

### 압축

각 chunk 는 **독립적으로 압축**되어 있다. 어느 알고리즘인지 표시하는 헤더는 없고, sniff 방식:

```javascript
function decompress(chunk) {
  try { return pako.inflateRaw(chunk); }       // deflate (raw)
  catch { return zstdDecode(chunk); }           // zstd fallback
}
```

---

## 2. Layer 2 — Schema chunk 해석

압축을 풀면 **또 binary**. 이게 kiwi 의 self-describing schema format (`.bkiwi` 와 동일).

### 2.1 전체 구조

```
[definitionCount : varuint]
└── for i in 0..definitionCount:
    ├── [name       : null-terminated UTF-8 string]
    ├── [kind       : 1 byte]                ─┐
    ├── [fieldCount : varuint]                │  ENUM = 0
    └── for j in 0..fieldCount:               │  STRUCT = 1
        ├── [fieldName : string]              │  MESSAGE = 2
        ├── [type      : varint]              │
        ├── [isArray   : 1 byte (low bit)]    │
        └── [value     : varuint]             │
```

### 2.2 각 필드의 의미

| 필드 | 의미 |
|---|---|
| `definitionCount` | 이 schema 에 들어있는 type 의 갯수. Figma .fig 는 보통 ~558. |
| `name` | type 이름. 예: `"GUID"`, `"NodeChange"`, `"Message"` |
| `kind` | `ENUM` (0), `STRUCT` (1), `MESSAGE` (2) 중 하나 |
| `field.type` | 음수 → built-in type index, 양수 → 다른 definition 의 index |
| `field.isArray` | 이 field 가 array `T[]` 인지 |
| `field.value` | **MESSAGE 의 wire tag**, 또는 ENUM 의 binary value |

### 2.3 Built-in type table

`field.type` 이 음수일 때 가리키는 8개 기본 타입:

| index | 타입 | 인코딩 |
|---|---|---|
| -1 | bool | 1 byte |
| -2 | byte | 1 byte |
| -3 | int | varint (zigzag) |
| -4 | uint | varuint |
| -5 | float | 4 bytes (LE, 일부 zigzag 변형) |
| -6 | string | null-terminated UTF-8 |
| -7 | int64 | varint64 |
| -8 | uint64 | varuint64 |

### 2.4 세 종류 type 의 wire 차이 (★중요)

| 종류 | wire 패턴 | 진화 가능성 |
|---|---|---|
| **ENUM** | `[varuint]` | 새 value 추가 가능 |
| **STRUCT** | `[val][val][val]…` (no tag) | **새 field 추가 불가** (이미 사용 중인 struct) |
| **MESSAGE** | `[tag][val][tag][val]…[0]` | 새 field 자유 추가, optional |

이 차이가 Layer 3 의 디코더 분기를 결정한다.

### 2.5 디코드 결과 (in-memory schema 객체)

```javascript
{
  definitions: [
    {
      name: "GUID",
      kind: "STRUCT",
      fields: [
        { name: "sessionID", type: -4 /*uint*/, isArray: false, value: 0 },
        { name: "localID",   type: -4,         isArray: false, value: 0 },
      ]
    },
    {
      name: "NodeChange",
      kind: "MESSAGE",
      fields: [
        { name: "guid",     type: <GUID idx>,    isArray: false, value: 1  },
        { name: "type",     type: <NodeType idx>,isArray: false, value: 2  },
        { name: "name",     type: -6 /*string*/, isArray: false, value: 3  },
        { name: "transform",type: <Matrix idx>,  isArray: false, value: 4  },
        { name: "size",     type: <Vector idx>,  isArray: false, value: 5  },
        // ...
      ]
    },
    {
      name: "Message",     // ← root type, 약속된 이름
      kind: "MESSAGE",
      fields: [
        { name: "type",         type: <MsgType idx>,    isArray: false, value: 1 },
        { name: "sessionID",    type: -4,               isArray: false, value: 2 },
        { name: "nodeChanges",  type: <NodeChange idx>, isArray: true,  value: 3 },
        // ...
      ]
    },
    // ... ~555개 더
  ]
}
```

### 2.6 Schema chunk hex 샘플 (가상)

`GUID` STRUCT 하나만 정의된 가장 단순한 schema 의 byte stream:

```
01                          ← definitionCount = 1
47 55 49 44 00              ← name = "GUID\0"
01                          ← kind = STRUCT (1)
02                          ← fieldCount = 2
73 65 73 73 69 6F 6E 49 44 00  ← fieldName = "sessionID\0"
07                          ← type = -4 (uint, varint zigzag of -4 = 0x07)
00                          ← isArray = 0
00                          ← value = 0
6C 6F 63 61 6C 49 44 00     ← fieldName = "localID\0"
07                          ← type = -4 (uint)
00                          ← isArray = 0
00                          ← value = 0
```

총 26 bytes. 실제 Figma .fig 의 schema chunk 는 이런 definition 이 ~558개 줄줄이 이어진 binary.

---

## 3. Layer 3 — Data chunk 해석

압축을 풀면 **단일 root Message 객체** 하나가 통째로 들어있다. Schema 와 달리
도입부 헤더가 없다.

### 3.1 시작 지점

decoder 는 schema 에서 `name == "Message"` 인 definition 을 찾아 그 type 으로 디코드 시작.

```javascript
const rootDef = schema.definitions.find(d => d.name === "Message");
const message = decodeMessage(dataBytes, rootDef, schema);
```

이 약속만이 schema 외부에서 합의된 유일한 convention.

### 3.2 MESSAGE 디코딩 알고리즘

```javascript
function decodeMessage(bb, def, schema) {
  const result = {};
  while (true) {
    const tag = bb.readVarUint();
    if (tag === 0) break;                           // ★ 0 = sentinel, message 끝

    const field = def.fields.find(f => f.value === tag);
    if (!field) {
      skipUnknownField(bb, schema);                 // forward compat
      continue;
    }

    result[field.name] = field.isArray
      ? decodeArray(bb, field.type, schema)
      : decodeValue(bb, field.type, schema);
  }
  return result;
}
```

### 3.3 STRUCT vs MESSAGE 디코딩 분기

| 만난 type | 디코딩 방식 |
|---|---|
| STRUCT | `def.fields` 를 순서대로 읽음 (tag 없음, 종료 sentinel 없음, 모든 field 강제) |
| MESSAGE | tag-based loop, 0 sentinel 까지 |
| ENUM | `varuint` 한 개 읽고, schema 의 enum value 와 매칭해 이름 lookup |
| array `T[]` | `[count : varuint]` 읽고 count 만큼 element 디코드 |

### 3.4 Field tag 매칭 (★핵심)

데이터의 byte 가 어떤 field 인지 결정하는 메커니즘:

```
data byte stream:        03 ...
                         ↑
                         │ 이 byte 가 tag (varuint)
                         │
Schema definition:       Message {
                           ...
                           field { name: "nodeChanges", value: 3 }  ← 매칭!
                           ...
                         }
                         │
결과:                    result["nodeChanges"] = decodeArray(...)
```

**값(value) 이 같으면 이름이 바뀌어도 호환성 유지된다** — 이게
Figma 가 schema 를 진화시키면서도 옛 .fig 파일을 계속 읽을 수 있는 비결.
audit-oracle spec 에서 본 `SPACE_EVENLY ↔ SPACE_BETWEEN` 도 같은 메커니즘.

### 3.5 노드 ID 의 정체

각 노드는 `GUID = { sessionID: uint, localID: uint }` 로 식별:

- `sessionID`: 그 노드를 만든 클라이언트의 세션 번호
- `localID`: 그 세션 안에서 일련번호

문자열로 표현할 때 보통 `<sessionID>:<localID>` 형식. 부모-자식 관계는
`parentIndex: { guid, position: fractional }` 로 표현되어, **CRDT 정렬용 fractional
indexing** 으로 동시 편집 시 충돌 없이 형제 순서를 유지한다.

### 3.6 Data chunk hex 샘플 (가상)

`Message { type: NODE_CHANGES, sessionID: 42 }` 만 들어있는 최소 data:

```
01                          ← tag = 1 ("type" field)
00                          ← value = 0 (enum value for NODE_CHANGES)
02                          ← tag = 2 ("sessionID" field)
2A                          ← value = 42 (varuint)
00                          ← tag = 0 → message 끝
```

총 5 bytes. 실제 .fig 는 여기 `nodeChanges: NodeChange[]` 가 array 로 붙어
수만 개의 노드가 줄줄이 들어간다.

---

## 4. 디코드 결과의 형태

Layer 3 까지 끝나면 in-memory JSON-like 객체가 나온다.

### 4.1 최상위 Message

```javascript
{
  type: "NODE_CHANGES",
  sessionID: 0,
  ackID: 0,
  nodeChanges: [
    { /* DOCUMENT */ },
    { /* CANVAS (page 1) */ },
    { /* FRAME */ },
    { /* RECTANGLE */ },
    // ...
  ]
}
```

### 4.2 노드 한 개 예시 (RECTANGLE)

```javascript
{
  guid:    { sessionID: 0, localID: 12 },
  parentIndex: {
    guid: { sessionID: 0, localID: 5 },
    position: "!"          // fractional index
  },
  type:    "RECTANGLE",
  name:    "Button BG",
  visible: true,

  // 시각 속성
  transform: {
    m00: 1, m01: 0, m02: 100,    // 2x3 affine matrix
    m10: 0, m11: 1, m12: 200
  },
  size: { x: 120, y: 40 },
  cornerRadius: 8,
  opacity: 1,

  // 채움
  fillPaints: [
    {
      type: "SOLID",
      color: { r: 0.2, g: 0.5, b: 1.0, a: 1.0 },
      opacity: 1,
      visible: true
    }
  ],
  strokePaints: [],
  strokeWeight: 1,
  // ...
}
```

### 4.3 INSTANCE 노드 (component instance)

```javascript
{
  guid: { sessionID: 0, localID: 87 },
  type: "INSTANCE",
  name: "Button/Primary",
  componentRef: { sessionID: 0, localID: 23 },   // master 의 GUID
  overrideKey: 12345,                             // override 추적
  // master 에서 derive 된 effective children
  _renderChildren: [ /* ... */ ],
  // override 된 속성만 carry
  fillPaints: [ /* override */ ],
}
```

### 4.4 TEXT 노드

```javascript
{
  guid: { sessionID: 0, localID: 33 },
  type: "TEXT",
  textData: {
    characters: "Hello, world!",
    styleOverrideTable: [ /* per-char style runs */ ],
    layoutSize: { x: 200, y: 24 },
  },
  fontName: { family: "Inter", style: "Bold" },
  fontSize: 16,
}
```

### 4.5 VECTOR 노드 (별도 binary blob 영역)

```javascript
{
  guid: { sessionID: 0, localID: 99 },
  type: "VECTOR",
  vectorNetworkBlob: <Uint8Array>,   // ← schema 의 시야 너머, 또 한 층 binary
  commandsBlob: <Uint8Array>,         // ← SVG path 명령의 packed binary
  fillPaints: [ /* ... */ ],
}
```

`vectorNetworkBlob` 과 `commandsBlob` 은 schema 가 byte array 로만 알고 있고,
*그 안의 의미* 는 별도의 reverse-engineering 영역.

---

## 5. Figma UI 와의 매칭

| Figma 화면 영역 | data chunk 안의 source |
|---|---|
| **상단 Pages 탭** | `CANVAS` type 노드들 (각 페이지 = 한 sub-root) |
| **왼쪽 Layers panel** | 모든 노드의 `guid`, `name`, `type`, `visible`, parent-child 관계 |
| **가운데 Canvas** | 위 속성들로부터 *런타임에 계산되는* 렌더 결과 (픽셀은 저장 안 됨) |
| **오른쪽 Inspector** | 선택된 노드의 `transform`, `size`, `fillPaints`, `strokePaints`, `effects`, `cornerRadius`, `opacity`, layoutMode + stack* 필드 등 |
| **Components panel** | `SYMBOL` type 노드 (master) + `INSTANCE` 의 `componentRef` |
| **Variables panel** | `VARIABLE`, `VARIABLE_SET` type 노드 |
| **Prototype 탭** | `reactions`, `prototypeStartNode`, transition 속성 |
| **Auto-layout controls** | `layoutMode`, `stackSpacing`, `stackPadding*`, `stackAlign*` |

### Inspector ↔ schema field 의 1:1 관계

오른쪽 Inspector 의 한 row 는 schema field 의 한 entry 와 거의 1:1. 사용자가
"Corner radius: 8" 을 보고 있을 때, 실제로는 selected 노드의 `cornerRadius: 8`
이라는 schema field 값이 그대로 표시되는 것.

### 캔버스의 진정한 의미

가장 헷갈리는 부분: **캔버스의 픽셀은 저장되지 않는다.** 저장되는 건 그리기
명령일 뿐이고, 클라이언트 renderer 가 매번 새로 그려낸다. 그래서:

> `.fig` 는 "이미지 파일" 이 아니라 **"그리기 프로그램의 source code"** 에 가깝다.

같은 .fig 라도 zoom, pan, dark mode, 다른 폰트 fallback 에 따라 화면이 달라지는
이유.

---

## 6. data chunk 에 *없는* 것들

| 항목 | 어디 있는가 |
|---|---|
| 이미지 픽셀 (PNG/JPG bytes) | 별도 blob store / `.make` ZIP 의 `images/` 폴더 / Figma 서버 |
| Font glyph (실제 폰트 파일) | OS / Google Fonts / Figma font server. 이름만 저장됨 |
| Vector path 의 풀린 형태 | `commandsBlob` 안에 또 한 층의 packed binary 로 들어있음 |
| 협업 history, 코멘트 | Figma server-side, Postgres + DynamoDB |
| Hover/selection state | 런타임 전용, 저장 안 됨 |
| `absoluteRenderBounds` 등 derived 값 | 런타임 계산, plugin API 가 노출만 함 |
| Preview thumbnail | 별도 chunk (chunk[2]) |

이 분리가 audit-oracle spec §7.1 의 "비대상" 항목과 정확히 겹친다 — *.fig 파일
자체의 scope 밖이거나, schema 의 시야를 벗어난 binary blob 들*.

---

## 7. 전체 디코드 파이프라인 (총정리)

```javascript
async function decodeFigFile(bytes) {
  // ─── Layer 1: 컨테이너 파싱 ───
  const magic = readBytes(bytes, 0, 8);          // "fig-kiwi"
  if (toString(magic) !== "fig-kiwi") throw "not a .fig";
  const version = readUint32LE(bytes, 8);

  let offset = 12;
  const chunks = [];
  while (offset < bytes.length) {
    const len = readUint32LE(bytes, offset); offset += 4;
    chunks.push(bytes.slice(offset, offset + len)); offset += len;
  }

  // ─── Layer 2: schema 디코드 ───
  const rawSchema = decompress(chunks[0]);       // pako or zstd
  const schema = decodeBinarySchema(rawSchema);  // ~558 definitions

  // ─── Layer 3: data 디코드 ───
  const rawData = decompress(chunks[1]);
  const rootDef = schema.definitions.find(d => d.name === "Message");
  const message = decodeMessage(rawData, rootDef, schema);

  // ─── Optional: preview ───
  const preview = chunks[2];                     // PNG bytes (있으면)

  return { version, schema, message, preview };
}
```

### 결과로부터 노드 트리 만들기

```javascript
// nodeChanges 는 평탄한 array → tree 로 재구성
const byId = new Map();
for (const node of message.nodeChanges) {
  byId.set(`${node.guid.sessionID}:${node.guid.localID}`, node);
}

for (const node of message.nodeChanges) {
  const parentKey = node.parentIndex
    ? `${node.parentIndex.guid.sessionID}:${node.parentIndex.guid.localID}`
    : null;
  const parent = parentKey ? byId.get(parentKey) : null;
  if (parent) (parent.children ??= []).push(node);
}

// fractional index 로 형제 정렬
for (const node of byId.values()) {
  node.children?.sort((a, b) =>
    a.parentIndex.position < b.parentIndex.position ? -1 : 1
  );
}
```

이제 이 트리가 곧 Figma 왼쪽 Layers panel 에 보이는 그것이다.

---

## 부록 A: 주요 노드 type 일람 (kiwi 의 `type` enum)

| kiwi name | Plugin/REST name | 비고 |
|---|---|---|
| `DOCUMENT` | `DOCUMENT` | 최상위 root |
| `CANVAS` | `PAGE` | 각 페이지 |
| `FRAME` | `FRAME` 또는 `GROUP` | `resizeToFit=true` + 빈 fillPaints 면 GROUP |
| `RECTANGLE` | `RECTANGLE` | |
| `ROUNDED_RECTANGLE` | `RECTANGLE` | corner-radius 가 있는 변형 |
| `ELLIPSE` | `ELLIPSE` | |
| `LINE` | `LINE` | |
| `VECTOR` | `VECTOR` | path 데이터는 `commandsBlob` 에 |
| `STAR`, `REGULAR_POLYGON` | 동일 | |
| `TEXT` | `TEXT` | `textData` 에 characters + style |
| `SYMBOL` | `COMPONENT` | component master |
| `INSTANCE` | `INSTANCE` | component instance |
| `BOOLEAN_OPERATION` | `BOOLEAN_OPERATION` | union/subtract/intersect/exclude |
| `SLICE` | `SLICE` | export 영역 |
| `STICKY` | `STICKY` | FigJam 포스트잇 |
| `VARIABLE` / `VARIABLE_SET` | (트리 외부 노출) | plugin/REST 는 children 으로 안 보여줌 |

---

## 부록 B: 자주 등장하는 STRUCT

```
STRUCT GUID         { uint sessionID; uint localID; }
STRUCT Vector       { float x; float y; }
STRUCT Color        { float r; float g; float b; float a; }
STRUCT Matrix       { float m00; float m01; float m02;
                      float m10; float m11; float m12; }
STRUCT ParentIndex  { GUID guid; string position; }   // position = fractional
```

이 STRUCT 들은 **모든 field 가 항상 등장하고 정의 순서대로** 인코딩되므로
wire 에서 가장 컴팩트한 영역이 된다. 반대로 한번 사용된 STRUCT 는
field 추가가 불가능 — schema 진화의 제약 지점.

---

## 부록 C: 참고 자료

- [evanw/kiwi](https://github.com/evanw/kiwi) — kiwi binary format 본가
- [evanw/kiwi/js/binary.ts](https://github.com/evanw/kiwi/blob/master/js/binary.ts) — `decodeBinarySchema` 의 정본 구현
- [madebyevan.com/figma/fig-file-parser](https://madebyevan.com/figma/fig-file-parser/) — Evan 본인의 .fig parser (browser)
- [fig-kiwi (npm)](https://www.npmjs.com/package/fig-kiwi) — `readFigFile` / `writeFigFile`
- [allan-simon/figma-kiwi-protocol](https://github.com/allan-simon/figma-kiwi-protocol) — WebSocket frame 까지 포함한 최신 reverse-eng

> **주의**: kiwi schema (`~558 types`) 는 Figma 가 임의로 바꿀 수 있는
> internal format. 어느 날 schema 가 진화해도 wire-level forward compat 는
> 유지되지만, *이름* 으로 의존하는 코드는 깨질 수 있다. audit-oracle 의
> `VALUE_ALIASES` 가 정확히 그 패치 layer.
