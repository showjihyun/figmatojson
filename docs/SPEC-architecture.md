# SPEC — figma-reverse 현재 아키텍처 (round-25 시점)

| 항목 | 값 |
|---|---|
| 문서 버전 | v1.0 |
| 작성일 | 2026-05-05 |
| 적용 범위 | round 25 종료 시점의 전체 시스템 |
| 자매 문서 | [SPEC.md](./SPEC.md) (CLI 9단계), [SDD.md](./SDD.md), [HARNESS.md](./HARNESS.md) |
| 위치 | 본 SPEC 은 *현재 구현 상태* 의 단일 source. Phase 0~7 마이그레이션 이력은 [§16 Appendix A](#16-appendix-a--phase-07-마이그레이션-이력-2026-05-02--05) 에 흡수됨. |

본 문서는 round 26 진입 전 현재 시스템의 정적 구조 + 실행 파이프라인 + 핵심 계약(invariants)을 한 곳에 정리한다. 새 라운드 작업의 기준선.

---

## 1. 시스템 정체

`figma-reverse`는 **두 개의 분리된 파이프라인을 공유 도메인 모듈 위에 얹은 모놀리포** 다.

```
                ┌──────────────────────────────────────────────────┐
                │                  src/  (공유 도메인)                  │
                │  loadContainer / decodeFigCanvas / buildTree      │
                │  vector / instanceOverrides / masterIndex / ...   │
                └────────────┬──────────────────────┬──────────────┘
                             │                      │
                ┌────────────▼─────────┐  ┌─────────▼───────────┐
                │   CLI 파이프라인          │  │   Web 파이프라인         │
                │ (9-stage extract +    │  │ (Hexagonal: ports +  │
                │  repack roundtrip)    │  │  application + UI)   │
                └───────────────────────┘  └──────────────────────┘
```

| 파이프라인 | 입력 | 출력 | 호출 형태 |
|---|---|---|---|
| **CLI extract** | `*.fig` | `output/` (사람이 읽는 JSON + 이미지 + SVG) + `extracted/` (디버그 breadcrumb) | `npx tsx src/cli.ts extract <file>` |
| **CLI repack** | `extracted/` | `*.fig` (byte 또는 kiwi 또는 json 모드) | `npx tsx src/cli.ts repack <dir> <out>` |
| **CLI pen-export** | `*.fig` | `*.pen` (Pencil 호환 design 파일) + `*.pen.json` round-trip | `npx tsx src/cli.ts pen-export <file>` |
| **CLI editable-html** | `*.fig` | 단일 `.html` (편집 가능 dashboard) | `npx tsx src/cli.ts editable-html <file>` |
| **Web 서버** | (HTTP) `.fig` 업로드 | (JSON) `Document` + asset 스트림 + chat agent 응답 | `npm --prefix web run dev` |
| **Web 클라이언트** | `Document` JSON | Konva 캔버스 렌더 + Inspector 패치 + 챗 turn | (브라우저) |

CLI 파이프라인의 9단계는 [SPEC.md](./SPEC.md)에서 상세히 정의. 본 문서는 그 위에 추가된 **Web 파이프라인의 현재 상태**, **두 파이프라인이 공유하는 도메인 모듈**, 그리고 **Figma 바이너리 데이터의 역공학 + 분석 + 변환 흐름** ([§2](#2-figma-fig-데이터-역공학--바이너리--분석--변환))을 중점적으로 다룬다.

---

## 2. Figma `.fig` 데이터 역공학 — 바이너리 → 분석 → 변환

본 섹션은 `.fig` 파일이 우리의 in-memory 트리(그리고 그 다음 `DocumentNode`)까지 변환되는 *역공학 발견 + 데이터 모델 + 변환 전략*을 정리한다. CLI 9단계의 *어떻게* 는 [SPEC.md](./SPEC.md), 본 섹션은 *왜 그런 단계가 필요한지* + *각 단계가 무엇을 디코드하는지*를 중점.

### 2.1 핵심 발견 7가지

PRD §6.3 가설 9개를 V-01~V-08 검증으로 확정하면서 드러난 7가지 핵심 사실:

1. **`.fig` 는 ZIP 컨테이너이고, 안의 `canvas.fig` 가 진짜 바이너리.** Figma Cloud export는 항상 ZIP STORE 모드(압축 없는 ZIP)로 래핑.
2. **canvas.fig 는 fig-kiwi 포맷.** 8 byte magic `66 69 67 2D 6B 69 77 69` ("fig-kiwi") + 4 byte LE version + chunks.
3. **chunks가 두 개**: 첫 chunk = **Kiwi 스키마 정의**, 둘째 chunk = 그 schema로 encode된 **NodeChanges 메시지**.
4. **이중 압축** (본 프로젝트의 핵심 발견): schema chunk = **deflate-raw**, data chunk = **zstd**. fig-kiwi npm 패키지가 가정하는 단일 deflate-raw와 다름 — magic byte 자동 감지로 분기.
5. **NodeChanges 메시지는 평탄 배열.** 35,660 노드(메타리치 기준)가 부모-자식 구조 없이 나열됨. 각 노드의 `parentIndex.guid` 로 트리 재구성, `parentIndex.position` (fractional indexing string)으로 형제 정렬.
6. **이미지는 ZIP의 `images/<sha1-hash>` 에 raw byte로 저장.** 노드의 `image.hash` 필드가 cross-reference. 확장자 없음 — magic byte sniff으로 타입 판정.
7. **Vector path는 `vectorNetworkBlob` index → `message.blobs[]` byte → 5개 path command (MOVE_TO/LINE_TO/CUBIC/QUAD/CLOSE) 디코드.** 95% 성공률 (BOOLEAN_OPERATION 등 합성은 fillGeometry가 비어 best-effort).

### 2.2 컨테이너 레이아웃 (`.fig` 외피)

```
design.fig (ZIP STORE)
├── canvas.fig          ← 진짜 바이너리 (fig-kiwi 포맷)
├── meta.json           ← file_name, background_color, ...
├── thumbnail.png       ← 작은 미리보기
└── images/
    ├── <sha1-hash-1>   ← 확장자 없는 raw byte (magic으로 타입 판정)
    └── <sha1-hash-2>   ← 같은 이미지를 여러 노드가 공유하면 한 번만 저장
```

`src/container.ts:loadContainer` 가 ZIP을 풀어 `ContainerResult` 반환. ZIP magic (`50 4B 03 04`) 으로 자동 분기 — raw fig-kiwi 도 그대로 처리 가능 (드물지만 future-proof).

### 2.3 fig-kiwi 아카이브 포맷

```
[8 bytes  ] "fig-kiwi" magic
[4 bytes  ] version (LE uint32)              ← 메타리치 = 106
[4 bytes  ] chunk[0].size (LE uint32)
[N bytes  ] chunk[0].data                    ← schema chunk (deflate-raw 압축)
[4 bytes  ] chunk[1].size
[N bytes  ] chunk[1].data                    ← data chunk (zstd 압축!)
```

`src/archive.ts:parseFigArchive` 가 magic 검증 + chunk 분해. 압축 해제는 `src/decompress.ts` 책임.

**압축 자동 감지** 룰:
- `28 B5 2F FD` → zstd (`fzstd` 사용, decode-only)
- `78 xx` → deflate-zlib (`pako.inflate`)
- 그 외 → deflate-raw (`pako.inflateRaw`)

자동 감지가 결정적인 이유: fig-kiwi npm 패키지는 schema/data 둘 다 deflate-raw로 가정하지만 실제 `.fig` 의 data chunk는 zstd. 우리가 직접 디코드해야 함. (이 발견이 PRD §1.2.3 "이중 압축" 가설을 실증.)

### 2.4 Kiwi 스키마 시스템

Kiwi (Evan Wallace) 는 schema-based binary format 이다 — Protocol Buffers와 비슷하지만 더 단순. **schema 자체가 스트림으로 전달** 되어 future-compatible.

```
schema chunk (decompressed):
  [type 정의 568개의 binary 인코딩]
  ├── NODE_CHANGES { nodeChanges: NodeChange[], blobs: Bytes[], ... }
  ├── NodeChange   { guid: GUID, type: NodeType, ... }
  ├── GUID         { sessionID: uint32, localID: uint32 }
  ├── Vector2      { x: float, y: float }
  ├── Transform    { m00..m12: float }
  ├── Paint        { type: PaintType, color: Color, ... }
  ├── ...

data chunk (decompressed):
  [위 schema로 encode된 NODE_CHANGES 메시지 하나]
```

디코드 절차 (`src/decoder.ts:decodeFigCanvas`):

```ts
const schema   = kiwi.decodeBinarySchema(schemaBytes);   // 568 types 읽음
const compiled = kiwi.compileSchema(schema);             // decoder 클래스 생성
const message  = compiled.decodeMessage(dataBytes);      // root: NODE_CHANGES
```

스키마는 `output/schema.json` 으로 사람이 읽는 형태로 dump 가능. 새 Figma 버전이 type 정의를 추가/변경해도 schema chunk를 *데이터로 받아 동적으로* 처리하므로 우리 디코더는 깨지지 않는다.

### 2.5 노드 데이터 모델

`message.nodeChanges[]` 의 각 항목 = 한 노드. 모든 노드의 공통 필드:

```ts
{
  guid: { sessionID: uint32, localID: uint32 },     // 노드 고유 ID
  type: 'FRAME' | 'TEXT' | 'VECTOR' | 'INSTANCE' | 'SYMBOL' | ... ,
  parentIndex: { guid: GUID, position: string },    // 부모 + fractional 정렬키
  // 이하 type별 필드 (kiwi schema에 정의)
  size?: { x, y },
  transform?: { m00, m01, m02, m10, m11, m12 },     // 2D affine, 부모 기준
  fillPaints?: Paint[],
  strokePaints?: Paint[],
  textData?: { characters, styleOverrideTable, ... },
  symbolData?: { symbolID, symbolOverrides },        // INSTANCE 만
  derivedSymbolData?: ...,                           // INSTANCE 만 (post-layout)
  componentPropAssignments?: ...,                    // INSTANCE 만
  componentPropRefs?: ...,                           // 변형 binding 자손
  componentPropDefs?: ...,                           // SYMBOL 만 (변형 정의)
  vectorData?: { vectorNetworkBlob: number, ... },   // VECTOR 계열 (blobs[] index)
  fillGeometry?: [{ commandsBlob: number }],
  // auto-layout 필드 (FRAME)
  stackMode?, stackPrimaryAlignItems?, stackCounterAlignItems?,
  stackSpacing?, stackPaddingLeft?, stackPaddingRight?, ...
  ...
}
```

타입 분포 (메타리치 기준 35,660 노드):

| 타입 | 갯수(대략) | 의미 |
|---|---:|---|
| `FRAME` | ~12,000 | 일반 컨테이너, auto-layout 가능 |
| `TEXT` | ~5,800 | 텍스트 렌더 |
| `RECTANGLE` | ~3,400 | 사각형 |
| `INSTANCE` | ~6,000 | SYMBOL 인스턴스 |
| `SYMBOL` | ~600 | 컴포넌트 마스터 |
| `GROUP` | ~2,500 | 그룹 |
| `VECTOR` (+ `STAR`/`LINE`/`ELLIPSE`/`REGULAR_POLYGON`/`BOOLEAN_OPERATION`/`ROUNDED_RECTANGLE`) | ~1,700 | SVG path |
| `DOCUMENT` / `CANVAS` | 1 + 6 | root + 페이지 |
| `VARIABLE_SET` (6) / `BRUSH` (25) / `CODE_LIBRARY` (1) | 32 | 미해석 raw 보존 |

### 2.6 트리 재구성과 fractional indexing

`message.nodeChanges[]` 는 평탄 배열. `tree.buildTree` 가:

1. 모든 노드를 `Map<guidStr, TreeNode>` 에 저장
2. 각 노드의 `parentIndex.guid` 로 부모를 찾아 `parent.children` 에 추가
3. 각 부모의 `children` 을 `parentIndex.position` (string) 으로 sort
4. `DOCUMENT` 타입 = root, parent를 못 찾은 노드 = orphans

**fractional indexing 의 목적**: Figma는 형제 노드 사이 순서를 string 으로 표현. `"A1"` / `"A2"` / `"A3"` 식. 새 노드를 둘 사이에 끼우려면 `"A1"` 와 `"A2"` 사이 문자열 (예 `"A1V"`) 만 있으면 됨 — 다른 노드의 position을 건드리지 않고 삽입 가능. 분산 환경(Figma 멀티유저 + Operational Transform) 에서 충돌 회피용.

(우리의 정렬 룰 + edge case 는 [`parent-index-position.spec.md`](./specs/parent-index-position.spec.md).)

### 2.7 INSTANCE / SYMBOL 컴포넌트 모델 (가장 복잡한 부분)

Figma 디자인 파일의 *재사용 가능한 컴포넌트* 시스템. INSTANCE pipeline 의 모든 라운드(4, 12, 14-25)가 이 모델 위에서 동작.

#### SYMBOL = 마스터 정의

```
SYMBOL "Button" (id=64:1)
└─ FRAME "buttons-container" (id=64:2)
    ├─ INSTANCE "Icon" (id=64:3, → 또 다른 SYMBOL 7:208)
    └─ TEXT "Label" (id=64:4, characters="Button")
```

SYMBOL 은 자체 children 트리를 가지며 변형 정의(`componentPropDefs`)를 보유.

#### INSTANCE = SYMBOL 참조 + 변형 데이터

```
INSTANCE "확인 버튼" (id=300:1) {
  symbolData: {
    symbolID: { sessionID:0, localID:64 },          // Button SYMBOL 가리킴
    symbolOverrides: [
      { guidPath:[64:4], textData:{characters:"확인"} },  // Label 텍스트 변경
      { guidPath:[64:3], visible: false },                 // Icon 숨김
    ],
  },
  derivedSymbolData: [                                     // post-layout 결과
    { guidPath:[64:4], size:{x:30, y:16} },
  ],
  componentPropAssignments: [...],                         // 변형 prop 바인딩
  // INSTANCE 자체는 children 없음 (SYMBOL의 children 을 *expand*)
}
```

INSTANCE 노드는 **자체 children 없음** — 렌더 시 master의 children 트리를 *확장* 하면서 override 를 적용해야 함.

#### 확장 알고리즘 (`web/core/domain/clientNode.ts:toClientNode` INSTANCE 분기)

```
1. master = symbolIndex.get(symbolData.symbolID)
2. for each child of master:
     toClientChildForRender(child, ..., overrides...)
       → recursively walk master subtree
       → at each node, look up overrides by path-key (§6)
       → apply: text / fill / visibility / prop / swap / size / transform
3. applyInstanceReflow(expansion, masterSize, instanceSize)
       → INSTANCE bbox 안에서 자식 위치 재계산 (auto-layout 시뮬레이션)
4. instance._renderChildren = expansion
```

**Master immutability**: master TreeNode 자체는 변경되지 않음. expansion 결과 (`_renderChildren`) 는 per-instance 복제본. 같은 SYMBOL 을 다른 INSTANCE 가 다르게 expand 가능.

#### `symbolOverrides[]` vs `derivedSymbolData[]`

| 필드 | 의미 | 출처 | 우리가 적용하는 것 |
|---|---|---|---|
| `symbolOverrides` | 디자이너가 변형(variant)별로 stamp 한 *입력* | Figma UI 에서 변형 편집 시 작성 | text / fill / visibility / propAssign / swap (override) |
| `derivedSymbolData` | Figma 의 post-layout *출력* (auto-layout, text shaping 결과) | Figma 자동 계산 (read-only) | size (round 22) / transform (round 24) |

두 필드 모두 `guidPath` 로 descendant 를 가리킴. **이 path 가 [§6 path-key 계약](#6-path-key-계약-round-25-정규화--시스템-foundation)의 source.**

### 2.8 Vector / SVG path 디코드

VECTOR 계열 노드의 모양:

```
VECTOR (id=12:34)
├─ vectorData:    { vectorNetworkBlob: 42 }   ← message.blobs[42]
├─ fillGeometry:  [{ commandsBlob: 43 }]      ← message.blobs[43]
└─ strokeGeometry:[...]
```

`message.blobs[N]` 은 byte array. byte 안에 path command 들이 인코딩:

```
[opcode:1B] [args:variable]
  0x01 MOVE_TO + 2×float32 (x, y)
  0x02 LINE_TO + 2×float32
  0x03 CUBIC   + 6×float32 (cp1, cp2, end)
  0x04 QUAD    + 4×float32 (cp, end)
  0x05 CLOSE   (no args)
```

`src/vector.ts:parseVectorNetworkBlob` 가 byte → command list, `vectorNetworkToPath` 가 SVG path string 으로 변환.

발견: 두 가지 시작 offset (0, 1) 에서 디코드를 시도하고 더 많은 명령을 디코드한 쪽 채택 — 일부 blob 에 1 byte prefix 가 있어 (Figma 내부 구분자) 자동 감지 필요.

### 2.9 이미지 임베딩

```
ZIP 안:
  images/01953550...256875bb6b   ← 8.7 KB raw byte (확장자 없음)
  images/0f14a2f9...3977d529     ← 20.2 KB raw

노드 안:
  fillPaints: [{ type:"IMAGE", image: { hash:"01953550...256875bb6b" } }]
  ↓
  ZIP의 images/<같은 hash> 참조
```

확장자 판정 (`src/assets.ts`):
```
89 50 4E 47           → PNG
FF D8 FF              → JPEG
52 49 46 46 ... WEBP  → WebP
47 49 46 38           → GIF
3C 73 76 67           → SVG (text "<svg")
25 50 44 46           → PDF
```

Web 측에서는 `/api/asset/:hash` 라우트 ([`web-asset-serve.spec.md`](./specs/web-asset-serve.spec.md)) 가 hash 로 ZIP 에서 byte 를 꺼내고 mime sniff 해서 스트림.

### 2.10 Text + 스타일 런

```
TEXT (id=88:5)
├─ textData:
│  ├─ characters: "Hello World"                 ← UTF-8 string
│  ├─ styleOverrideTable: [                      ← 인덱스별 스타일 lookup
│  │    { fontFamily:"Inter", fontWeight:600 },        // 0번 = 기본
│  │    { fontFamily:"Inter", color:{r:1,g:0,b:0} },   // 1번 = 빨강
│  │  ]
│  └─ characterStyleIDs: [0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0]   // 각 char 의 스타일 인덱스
├─ size: { x:88, y:20 }                          ← bbox (Figma 의 post-shape 결과)
└─ transform: { ... }
```

각 character 가 `styleOverrideTable[characterStyleIDs[i]]` 의 스타일로 렌더. 우리 `Canvas.tsx` 가 segment 별로 `Konva.Text` (또는 `KText` 컴포넌트) 를 stack.

폰트 로딩: 메타리치는 Pretendard / Inter 사용. 캡처 시 `document.fonts.ready` 대기 후 첫 프레임 (system fallback 으로 첫 프레임이 wider glyph로 측정되면 width override가 잘림 — `web-canvas-text-frame-fidelity.spec.md §2.1 I-3a`).

상세: [`web-canvas-text-style-runs.spec.md`](./specs/web-canvas-text-style-runs.spec.md), [`web-canvas-text-frame-fidelity.spec.md`](./specs/web-canvas-text-frame-fidelity.spec.md), [`text-segments.spec.md`](./specs/text-segments.spec.md).

### 2.11 Layout / Auto-layout

```
FRAME 컨테이너:
├─ size: { x:200, y:60 }                                       ← bbox
├─ transform: { m00:1, m01:0, m02:50, m10:0, m11:1, m12:30 }   ← 부모 기준
├─ stackMode: 'HORIZONTAL' | 'VERTICAL' | 'NONE'               ← auto-layout 활성화
├─ stackPrimaryAlignItems:   'CENTER' | 'MIN' | 'MAX' | 'SPACE_BETWEEN' | ...
├─ stackCounterAlignItems:   'CENTER' | 'MIN' | 'MAX' | 'STRETCH'
├─ stackSpacing: 8                                             ← 자식 간 간격 (px)
├─ stackPaddingLeft/Right/Top/Bottom: 4
├─ stackPrimarySizing: 'AUTO' | 'FIXED' | 'RESIZE_TO_FIT*'     ← AUTO = content 에 맞게 grow
└─ frameMaskDisabled: false                                    ← false = 자식 클립
```

자식의 위치는 자식 자신의 `transform` 으로 결정. Figma 에서는 auto-layout 이 활성화되면 자식 transform 이 *post-layout 결과* 로 stamp. 우리는 INSTANCE 확장 시 master 의 자식 transform 을 가져오지만 INSTANCE size 가 master 와 다르면 reflow 시뮬레이션 필요 (§5 + reflow spec §3.1-3.10).

### 2.12 Component property 시스템 (변형 binding)

Figma 는 같은 SYMBOL 의 여러 변형(variant) 을 component property 로 표현:

```
SYMBOL "Button" 의 componentPropDefs:
  [
    { defID:0, name:"Type",      type:"VARIANT", options:["Primary","Secondary"] },
    { defID:1, name:"ShowIcon",  type:"BOOL",    default:true },
    { defID:2, name:"LabelText", type:"TEXT",    default:"Button" },
  ]

SYMBOL 안의 자손 노드:
  Icon  → componentPropRefs: [{ defID:1, componentPropNodeField:"VISIBLE" }]
  Label → componentPropRefs: [{ defID:2, componentPropNodeField:"TEXT" }]

INSTANCE "확인" 의 componentPropAssignments:
  [
    { defID:0, value:{ type:"VARIANT", value:"Primary" } },
    { defID:1, value:{ type:"BOOL",    boolValue:false } },     // 아이콘 숨김
    { defID:2, value:{ type:"TEXT",    textValue:"확인" } },     // 라벨 텍스트
  ]
```

매칭: INSTANCE 의 `assignment.defID` == 자손의 `ref.defID` → 그 자손의 해당 field 에 value 적용.

우리 구현 (`src/effectiveVisibility.ts:isHiddenByPropBinding`):
- `componentPropNodeField === 'VISIBLE'` + `boolValue === false` → 자손 `visible: false`
- TEXT / INSTANCE_SWAP 은 v3 미지원 (round 26 후보)

상세: [`web-instance-render-overrides.spec.md §3.4`](./specs/web-instance-render-overrides.spec.md) (round 12 + round 15 outer-symbolOverride path-keyed assignments).

### 2.13 변환 전략 — `DocumentNode` 출력 모델

`src/types.ts:TreeNode` (kiwi-decoded) 와 `web/core/domain/entities/Document.ts:DocumentNode` (UI-friendly) 의 차이:

| 측면 | TreeNode | DocumentNode |
|---|---|---|
| guid | `{sessionID, localID}` 객체 | `id: string` 별칭 + 객체 |
| children | TreeNode[] | DocumentNode[] |
| INSTANCE 자식 | 없음 (master 트리 별도) | `_renderChildren` (master expansion 결과) |
| VECTOR path | `vectorData.vectorNetworkBlob` 인덱스 | `_path` (디코드된 SVG path string) |
| TEXT override | (master 에만 있음) | `_renderTextOverride` (variant 별 적용 결과) |
| size / transform | master 값 그대로 | INSTANCE expansion 시 derivedSize/Transform 적용 |
| visibility | (대체로) `data.visible` | propBinding + outer symbolOverride 모두 해석된 결과 |

DocumentNode 는 직렬화 가능한 JSON tree → React Konva 가 직접 렌더. INSTANCE 확장 + override 적용 + reflow 가 모두 *서버 측에서* `toClientNode` 안에서 일어나 클라이언트는 단순한 visual tree 만 받음.

이 변환의 모든 상세 룰이 §4-§6 (clientNode + override + path-key + reflow) 의 주제.

---

## 3. 모듈 카탈로그

### 3.1 `src/` — 공유 도메인 + CLI

| 모듈 | 책임 | 호출자 |
|---|---|---|
| `cli.ts` | CLI entrypoint + subcommand dispatcher | shell |
| `container.ts` | Stage 1: ZIP/raw 자동 분기 | CLI, Web (KiwiCodec) |
| `archive.ts` | Stage 2: fig-kiwi 청크 분해 | container + decoder |
| `decompress.ts` | Stage 3: deflate-raw / zstd 자동 감지 | archive |
| `decoder.ts` | Stage 4: Kiwi 스키마 + 메시지 디코드 | CLI, Web |
| `tree.ts` | Stage 5: parent-child 트리 재구성 + `getPages` | CLI, Web |
| `assets.ts` | Stage 6: 이미지 참조 매핑 + magic-based 확장자 | CLI, Web |
| `vector.ts` | Stage 7: `commandsBlob` → SVG path 디코더 + Canvas 측 `vectorNetworkBlob` 파서 | CLI, Web Canvas |
| `normalize.ts` | Stage 8: REST API 호환 별칭 | CLI export |
| `export.ts` | Stage 8: 산출물 export | CLI |
| `intermediate.ts` | 중간 산출물 dumper (`extracted/*/_info.json`) | CLI |
| `verify.ts` | Stage 9: V-01~V-08 검증 + report | CLI |
| `repack.ts` | 역방향 파이프라인 (byte / kiwi / json 모드) | CLI |
| `pen-export.ts` | `.fig` → `.pen` (Pencil) 변환 | CLI |
| `editable-html.ts`, `editable-html-css.ts`, `html-export-templates.ts`, `html-export.ts` | 단일 .html 출력 (Inspector + Canvas inlined) | CLI |
| **`masterIndex.ts`** | SYMBOL master id → TreeNode 인덱스 (round 18 step 1 추출) | Web `clientNode` |
| **`effectiveVisibility.ts`** | `componentPropAssignments` ↔ `componentPropRefs[VISIBLE]` 해석 (round 18 step 2 추출) | Web `clientNode` |
| **`instanceOverrides.ts`** | 7개 override collector + path-key 도구 (round 18 step 3 추출) | Web `clientNode` |
| `types.ts` | 공통 타입 정의 | 위 모든 모듈 |

`masterIndex.ts` / `effectiveVisibility.ts` / `instanceOverrides.ts` 는 Web 측이 INSTANCE 확장 시 사용하는 핵심 helper 들이지만 `src/`에 둠 — pen-export 도 같은 데이터 모델을 사용하므로 양쪽에서 import 가능 ([ADR 0004](./adr/0004-shared-modules-live-in-src.md)).

### 3.2 `web/core/` — 도메인 코어 (프레임워크 무관)

```
web/core/
├─ domain/                     ← 순수 (no React / no Node fs / no SDK)
│  ├─ entities/Document.ts     DocumentNode 트리 + ComponentTextRef
│  ├─ entities/Session.ts      Session lifecycle 타입
│  ├─ tree.ts                  findById, walk, eachDescendant
│  ├─ path.ts                  tokenizePath, setPath, getPath
│  ├─ color.ts                 rgbaToHex, hexToRgb01, ...
│  ├─ image.ts                 imageHashHex, sniffImageMime
│  ├─ summary.ts               summarizeDoc (LLM 컨텍스트 빌더)
│  ├─ messageJson.ts           메시지 JSON 직렬화 — round-trip
│  └─ clientNode.ts ⭐        TreeNode → DocumentNode 변환의 핵심.
│                              toClientNode + toClientChildForRender +
│                              applyInstanceReflow 가 여기에 산다.
├─ ports/                      ← 인터페이스 (application 이 정의)
│  ├─ SessionStore.ts          create / get / destroy / list / setDocument
│  ├─ Decoder.ts               bytes → DocumentNode
│  ├─ Repacker.ts              DocumentNode + extracted → bytes
│  ├─ AssetServer.ts           (sessionId, hash) → bytes + mime
│  ├─ ChatAdapter.ts           prompt + tools → assistantText
│  ├─ ToolDispatcher.ts        tool name + args → side effects
│  └─ EditJournal.ts           edit history append + replay
└─ application/                ← Use cases (orchestration)
   ├─ UploadFig.ts             .fig bytes → Session 생성 + Document 빌드
   ├─ EditNode.ts              path JSON Patch → Document mutation
   ├─ ResizeNode.ts            BBox + handle → Multi-target resize
   ├─ OverrideInstanceText.ts  INSTANCE 의 text override 작성
   ├─ ExportFig.ts             현재 Document → repacked .fig
   ├─ LoadSnapshot.ts          저장된 snapshot → Session 재생성
   ├─ SaveSnapshot.ts          현재 Session → snapshot 저장
   ├─ RunChatTurn.ts           chat prompt → tool 호출 시퀀스 + 응답
   ├─ ServeAsset.ts            세션 + hash → asset bytes
   ├─ Undo.ts / Redo.ts        EditJournal 기반 시간 이동
   ├─ errors.ts                도메인 에러 타입
   └─ testing/fakeSessionStore.ts  unit-test fixture
```

**의존성 방향: 안쪽으로만.** `domain/` 은 zero deps. `application/` 은 ports + domain 만 import. `adapters/` 는 ports 를 구현 + 외부 라이브러리.

### 3.3 `web/server/adapters/` — Hexagonal 외곽

```
web/server/adapters/
├─ driving/http/                Hono 라우트 (얇은 shell)
│  ├─ index.ts                  app 조립 + wiring (≈100 줄)
│  ├─ deps.ts                   composition root: 모든 adapter 인스턴스화
│  ├─ uploadRoute.ts            POST /api/upload-fig
│  ├─ docRoute.ts               GET  /api/doc/:id
│  ├─ saveRoute.ts              POST /api/save/:id
│  ├─ overrideRoute.ts          POST /api/override-instance-text
│  ├─ resizeRoute.ts            POST /api/resize
│  ├─ chatRoute.ts              POST /api/chat
│  ├─ assetRoute.ts             GET  /api/asset/:hash
│  ├─ snapshotRoute.ts          POST /api/snapshot/:op
│  ├─ historyRoute.ts           GET  /api/history/:id (Undo/Redo)
│  └─ errors.ts                 ApplicationError → HTTP status 매핑
└─ driven/                      외부 의존성 구현체
   ├─ FsSessionStore.ts         mkdtemp + readFile + bounded LRU (round 23 hardening)
   ├─ KiwiCodec.ts              src/decoder + src/repack wrap
   ├─ FsAssetServer.ts          extracted/01_container/images/ 서빙
   ├─ AnthropicChat.ts          @anthropic-ai/sdk (api-key 모드)
   ├─ AgentSdkChat.ts           @anthropic-ai/claude-agent-sdk (subscription)
   ├─ InProcessTools.ts         set_text / set_fill / duplicate / ...
   ├─ applyTool.ts              tool 디스패처 본체
   ├─ atomicWrite.ts            안전한 파일 쓰기 (rename atomicity)
   ├─ FsEditJournal.ts          Undo/Redo journal 디스크 백업
   ├─ InMemoryEditJournal.ts    test fixture
   └─ *.test.ts                 unit tests
```

**Composition root**: `web/server/adapters/driving/http/deps.ts` 가 모든 driven adapter 를 인스턴스화하고 application use case 에 주입. `web/server/index.ts` 는 Hono 인스턴스 생성 + `mountRoutes(app, deps)` 만 호출하는 ≈30 줄짜리 entrypoint.

### 3.4 `web/client/` — React UI

| 파일 | 책임 | LOC (대략) |
|---|---|---|
| `App.tsx` | 레이아웃, onUpload/onSave 오케스트레이션 | ~350 |
| `Canvas.tsx` | Konva 렌더 + 좌표 수학 + 이벤트 | ~900 |
| `Inspector.tsx` | UI + 패치 dispatch + 색/숫자 변환 | ~950 |
| `ChatPanel.tsx` | Chat UI + fetch + 인증 모드 | ~550 |
| `services/*` | docService / chatService / sessionService — 네트워크 추상화 | ~80–150 each |
| `hooks/usePatch.ts` | 디바운스 패치 | ~80 |
| `multiResize.ts` | 그룹 리사이즈 수학 | ~80 |

**Konva 렌더 모델**: Document.children 트리를 NodeShape (Konva.Group) 재귀로 그린다. INSTANCE 노드는 자기 children 대신 `_renderChildren` (master expansion 결과) 을 그린다. VECTOR 계열은 `_path` (SVG path string) 를 Konva.Path 로.

---

## 4. 핵심 데이터 변환: TreeNode → DocumentNode

`.fig` 한 파일이 사용자 화면에 나타나기까지의 변환 chain:

```
.fig bytes
   │
   │ container.loadContainer  (Stage 1)
   ▼
{ canvasFig, metaJson, images, ... }
   │
   │ decoder.decodeFigCanvas  (Stage 2-4)
   ▼
{ schema, message }   ← message = NODE_CHANGES (35,660 노드 평탄 배열)
   │
   │ tree.buildTree           (Stage 5)
   ▼
TreeNode tree                ← parentIndex 로 children 정렬, guidStr / type / data
   │
   │ clientNode.toClientNode  ⭐ Web-only: per-INSTANCE 확장
   ▼
DocumentNode 트리            ← _renderChildren / _path / _isInstanceChild 등 부착
   │
   │ JSON.stringify
   ▼
GET /api/doc/:id 응답
   │
   │ React Canvas.tsx + Konva
   ▼
화면
```

`toClientNode` 가 본 시스템의 **render-fidelity 핵심 함수** 다. 라운드 17~25 작업이 모두 이 함수와 그 helper 들에 모인다.

### 4.1 `toClientNode` 의 역할

| 입력 | TreeNode (kiwi-decoded, master 트리 + 문서 트리 혼재) |
|---|---|
| 출력 | DocumentNode (UI-friendly, INSTANCE 확장 + path 디코드 + 메타 부착) |
| 핵심 사이드 변환 | (1) VECTOR → SVG path, (2) INSTANCE → master expansion + override 적용, (3) data field spread (textData, fillPaints, etc.) |

INSTANCE 분기에서 일어나는 일:
1. `symbolData.symbolID`로 master 찾기 (`buildSymbolIndex` → `Map<guidStr, TreeNode>`)
2. `master.children` 를 `toClientChildForRender` 로 재귀 walk → expansion 결과
3. expansion 에 적용할 override map 6종 + 1종 (prop assignments at-path) 수집
4. expansion 결과를 `applyInstanceReflow` 에 통과 → INSTANCE bbox 안에서 자식 위치 재계산
5. 결과를 `out._renderChildren` 에 부착, master 자체는 mutation 없음 (per-instance 복제본만 변형)

### 4.2 `toClientChildForRender` — INSTANCE expansion walk

master subtree 의 각 노드를 visit 하며 outer INSTANCE 의 override 를 적용. **본 함수의 13개 인자가 path-keyed override 배달의 통로**:

```ts
toClientChildForRender(
  n: TreeNode,                       // 1. 현재 visit 노드
  blobs: Array<{bytes: Uint8Array}>, // 2. vectorNetworkBlob 디코드용
  symbolIndex: Map<...>,             // 3. nested INSTANCE 처리용
  textOverrides:        Map<key, string>,         // 4. round-4
  fillOverrides:        Map<key, unknown[]>,      // 5. round-12
  visibilityOverrides:  Map<key, boolean>,        // 6. round-4
  depth: number,                                  // 7. recursion 깊이 ceiling
  pathFromOuter: string[],                        // 8. ⭐ path-key 누적기
  propAssignments:        Map<defID, boolean>,    // 9. round-12 (at-instance)
  propAssignmentsByPath:  Map<key, Map<...>>,     // 10. round-15 (at-path)
  swapTargetsByPath:      Map<key, swapID>,       // 11. round-16
  derivedSizesByPath:     Map<key, {x,y}>,        // 12. round-22
  derivedTransformsByPath:Map<key, Transform2D>,  // 13. round-24
): DocumentNode
```

각 visit 에서 `currentKey = [...pathFromOuter, n.guidStr].join('/')` 계산 후 7종 map 을 lookup 해서 적용.

### 4.3 `applyInstanceReflow` — INSTANCE bbox 안 재배치

INSTANCE size 가 master 와 다를 때 *figma 의 의도된 layout 재실행* 을 우리가 시뮬레이션. 룰:
- **§3.1-3.5 CENTER+CENTER reflow** (round 14): primary/counter 모두 CENTER, instance < master 일 때 자식 재중앙
- **§3.6 overlap-group reflow** (round 15 phase B): 같은 primary 위치에 stack 된 자식들 분배
- **§3.7 MIN/start-aligned reflow** (round 19): MIN/undefined primary + 일부 hidden, 가시 자식만 packed
- **§3.7.5 trigger narrowing** (round 21): instance < master 인 axis 만 재flow (grown axis 는 master 좌표 유지)
- **§3.8 stackPrimarySizing AUTO grow** (round 20): RESIZE_TO_FIT 모드에서 작은 hint 를 master 로 grow
- **§3.9 derivedSize baking** (round 22): outer INSTANCE 의 `derivedSymbolData[].size` → 모든 descendant
- **§3.10 derivedTransform baking** (round 24): 같은 entry 의 `transform` → 모든 descendant

**v1 한계 (spec §3.10 I-DT4)**: reflow 가 fire 한 직접 자식의 m02/m12 는 reflow 가 wins (derivedTransform 덮어씀). deep descendant 는 reflow 가 건드리지 않으므로 derivedTransform 이 final. 두 계산이 원리적으로 일치해야 하는 케이스라 visual 영향 미관찰.

상세 invariants: [`web-instance-autolayout-reflow.spec.md`](./specs/web-instance-autolayout-reflow.spec.md).

---

## 5. Override 시스템 — 7개 path-keyed pipeline

INSTANCE 확장 시 적용되는 7가지 override 가 모두 **공통 path-key scheme** 으로 매칭된다:

| # | override | 출처 | collector | 적용 위치 in `toClientChildForRender` | 라운드 |
|---|---|---|---|---|---|
| 1 | `_renderTextOverride` | INSTANCE.symbolData.symbolOverrides[].textData | `collectTextOverridesFromInstance` | TEXT 노드 output | 4 |
| 2 | `out.fillPaints` | INSTANCE.symbolData.symbolOverrides[].fillPaints | `collectFillOverridesFromInstance` | data spread 직후 | 12 |
| 3 | `out.visible` | INSTANCE.symbolData.symbolOverrides[].visible | `collectVisibilityOverridesFromInstance` | data spread 직후 | 4 |
| 4 | `out.visible` (default 결정) | INSTANCE.componentPropAssignments + 자손.componentPropRefs[VISIBLE] | `collectPropAssignmentsFromInstance` | visibility override 미존재 시 | 12 |
| 4b | (위) at-path 변형 | symbolOverrides[].componentPropAssignments | `collectPropAssignmentsAtPathFromInstance` | path-keyed merge | 15 |
| 5 | nested INSTANCE 의 master 교체 | symbolOverrides[].overriddenSymbolID | `collectSwapTargetsAtPathFromInstance` | nested INSTANCE 분기 | 16 |
| 6 | `out.size` | derivedSymbolData[].size + .derivedTextData.layoutSize | `collectDerivedSizesFromInstance` | data spread + reflow 전 | 22 |
| 7 | `out.transform` | derivedSymbolData[].transform | `collectDerivedTransformsFromInstance` | data spread + reflow 전 | 24 |

7종 모두 *같은 path-key scheme* 을 공유 — [§6 path-key 계약](#6-path-key-계약-round-25-정규화--시스템-foundation) 에 정의됨.

각 override 의 상세 invariants:
- 1, 2, 3, 4, 4b: [`web-instance-render-overrides.spec.md`](./specs/web-instance-render-overrides.spec.md)
- 5: [`web-instance-variant-swap.spec.md`](./specs/web-instance-variant-swap.spec.md)
- 6, 7: [`web-instance-autolayout-reflow.spec.md`](./specs/web-instance-autolayout-reflow.spec.md) §3.9 / §3.10

---

## 6. Path-key 계약 (round 25 정규화 — 시스템 foundation)

7개 override pipeline 이 모두 의존하는 단일 룰. 라운드 25 에서 Figma 의 wire format 과 정확히 일치하도록 정정됨.

### 6.1 정의

`pathKey` = `slash-joined GUIDs` of:
- (a) outer instance master root 에서 target 까지의 visit chain 중 **`type === 'INSTANCE'` 인 ancestor 만** 포함
- (b) 그리고 **target 노드 자기 자신** 포함

**FRAME / GROUP / SECTION 등 non-INSTANCE 컨테이너 ancestor 는 키에서 skip.**

### 6.2 예시 (alret SYMBOL master 64:376)

```
master 64:376 (alret SYMBOL)
  └ buttons FRAME 60:348      ← skip from key
      ├ Button 60:341 "취소"   ← target → key = "60:341"
      └ Button 60:340 "삭제"   ← target → key = "60:340"
                  └ TEXT 5:45  ← target via INSTANCE 60:340 → key = "60:340/5:45"
```

INSTANCE 60:340 는 자체 master 를 expand 하므로 그 INSTANCE 의 자손에 대한 path 는 INSTANCE-id 를 prefix 로 받는다. 같은 INSTANCE 자손 안의 FRAME 이 또 있다면 그 FRAME 도 skip 된다.

### 6.3 구현 (clientNode.ts)

```ts
const currentPath = n.guidStr ? [...pathFromOuter, n.guidStr] : pathFromOuter;
const currentKey = currentPath.join('/');
// child 재귀 시 INSTANCE 만 path 에 contribute
const childPathFromOuter = n.type === 'INSTANCE' ? currentPath : pathFromOuter;
```

핵심 단 한 줄(`childPathFromOuter` 결정) 이 7개 override pipeline 전체의 매칭 정합성을 결정한다.

### 6.4 Nested INSTANCE prefix-merge

내부 INSTANCE 가 자체 `symbolOverrides` / `derivedSymbolData` 를 가질 때, 그 inner key 들을 outer 의 currentPath 로 prefix 해서 outer override map 과 합친다. 이렇게 해야 outer override 가 grand-descendant 까지 도달 가능.

```ts
// inner override key "5:45" + outer currentPath ["60:340"]
// → merged key "60:340/5:45"
```

7개 override 모두 동일한 `mergeOverridesForNested` (혹은 동등한 패턴) 사용.

### 6.5 Master immutability

override 적용은 *instance-별 `_renderChildren` 복제본* 에만. master TreeNode 자체의 data 는 변경되지 않는다 — 같은 master 를 다른 INSTANCE 가 자기 고유의 override 로 expand 가능.

---

## 7. Web HTTP API

| 라우트 | use case | spec |
|---|---|---|
| `POST /api/upload-fig` | UploadFig | `web-upload-fig.spec.md` |
| `GET  /api/doc/:id` | (LoadSnapshot internally) | — |
| `POST /api/save/:id` | SaveSnapshot | `web-snapshot.spec.md` |
| `POST /api/snapshot/:op` | LoadSnapshot | (위 spec) |
| `POST /api/override-instance-text` | OverrideInstanceText | `web-instance-override.spec.md` |
| `POST /api/resize` | ResizeNode | `web-resize-node.spec.md` |
| `POST /api/edit/:id` | EditNode (path-set) | `web-edit-node.spec.md` |
| `POST /api/chat` | RunChatTurn | `web-chat-turn.spec.md` + `web-chat-leaf-tools.spec.md` + `web-chat-duplicate.spec.md` |
| `GET  /api/asset/:hash` | ServeAsset | `web-asset-serve.spec.md` |
| `GET  /api/history/:id` | Undo/Redo state | `web-undo-redo.spec.md` |
| `POST /api/group` / `/api/ungroup` | (group helpers) | `web-group-ungroup.spec.md` |
| `POST /api/export` | ExportFig | `web-export-fig.spec.md` |

라우트는 모두 **얇은 shell** — 입력 파싱 + use case 호출 + 응답 직렬화. 비즈 로직은 application/ 안에서 일어남.

---

## 8. 라운드 히스토리 매트릭스

각 라운드가 어떤 spec / 코드 / 테스트를 추가했는지의 한 눈에 보기.

| 라운드 | 주제 | spec | 핵심 변경 | 영향권 |
|---|---|---|---|---|
| 1-3 | Hexagonal foundations | `web-render-fidelity-high/round2/round3` | Phase 0~5 마이그레이션 | 모든 web/ |
| 4 | per-instance text/visibility override | `web-render-fidelity-round4` | `collectText/Visibility/FillOverridesFromInstance` | INSTANCE 확장 |
| 5-9 | text style runs / segment fidelity | `web-render-fidelity-round5..9` | font / 색 / decoration / segment | TEXT 렌더 |
| 10 | text frame fidelity / layout size | `web-render-fidelity-round10` + `web-canvas-text-frame-fidelity` | TEXT bbox 정확도 | TEXT 렌더 |
| 11 | audit harness 도입 | (`docs/audit-round11/`) | 메타리치 .fig 비교 baseline 753 PNG | 회귀 보호 |
| 12 | INSTANCE auto-clip + componentPropAssignments visibility | `web-canvas-instance-clip` + `render-overrides.§3.4` | 모달 leak fix + prop binding | 렌더 |
| 13 | round-12 시각 gate | (round-11 baseline 갱신) | — | 회귀 |
| 14 | INSTANCE auto-layout reflow v1 | `web-instance-autolayout-reflow.§2-3.5` | CENTER+CENTER reflow | 렌더 |
| 15 | path-keyed prop assigns + overlap-group reflow | `render-overrides.§3.4 I-P11` + reflow §3.6 | metarich Dropdown rail | 렌더 |
| 16 | variant swap | `web-instance-variant-swap` | overriddenSymbolID 처리 | INSTANCE 확장 |
| 17 | swap target visual inheritance | (variant-swap §3.3 round-17) | swap 시 fill/stroke 등 상속 | 렌더 |
| 18 | cluster A 추출 | (`expansion-context.spec.md` 후보) | `masterIndex` / `effectiveVisibility` / `instanceOverrides` 모듈화 | 코드 구조 |
| 19 | MIN-pack reflow | reflow §3.7 | sidemenu 가시 자식 packing | 렌더 |
| 20 | stackPrimarySizing AUTO grow | reflow §3.8 | Excel 다운로드 button | 렌더 |
| 21 | reflow trigger narrowing | reflow §3.7.5 | grown axis 보호 + round-21 deferred | 렌더 |
| 22 | derivedSymbolData size baking | reflow §3.9 | 모든 descendant 사이즈 | 렌더 |
| 23 | audit isolation v3 + e2e gate | (audit harness 자체) | __setIsolateNode + round-11 baseline 갱신 | 회귀 |
| 24 | derivedSymbolData transform baking | reflow §3.10 | 모든 descendant 위치 + e2e gate | 렌더 |
| **25** | **path-key normalization** | render-overrides §3.1 v3 + 4 spec cross-ref | **FRAME/GROUP ancestor skip → 7 pipeline 전체** | **foundation 정정** |

라운드 25 가 시스템 foundation 을 정정한 시점. 이 이후 INSTANCE pipeline 은 Figma 의 wire format 과 일관됨.

---

## 9. 테스트 레이어

| 레이어 | 도구 | 위치 | 갯수 (round 25 시점) | 범위 |
|---|---|---|---|---|
| **L0 Unit** | vitest | `web/core/**/*.test.ts` + `src/**/*.test.ts` (root) + `test/` | 450 web + 126 root | domain 헬퍼, application use case, adapter, override collectors |
| **L1 e2e** | playwright | `web/e2e/*.spec.ts` | ~30 | upload→save→edit / chat 시퀀스 / audit contract |
| **L2 Audit** | playwright + 메타리치 .fig | `web/scripts/audit-round11-screenshots.mjs` + `docs/audit-round11/` | 749 PNG (baseline) | 시각 회귀 — 4 corpus (design-setting / dash-board / mobile / web) |
| **L3 Round-trip** | vitest | `test/e2e.test.ts` | 1 | .fig → tree → repack → 동등성 |
| **L4 Verification** | CLI `verify.ts` | `output/verification_report.md` | V-01~V-08 | extract 산출물 일관성 |

### 9.1 Audit harness

`docs/audit-round11/` 의 4 corpus 가 1,500+ INSTANCE 슬러그를 커버한다. 각 슬러그:
- `<page>/<slug>/figma.png` — Figma REST API 캡처 (사용자가 사전 배포)
- `<page>/<slug>/ours.png` — 우리 렌더 (자동 캡처)

라운드 작업 후 `node web/scripts/audit-round11-screenshots.mjs <page>` 로 ours.png 재생성, byte delta 분석으로 win/regression 분류, 시각 검사로 confirm. 라운드별 commit (예: `chore(audit): round 25 — refresh WEB`).

`docs/audit-round11/GAPS.md` 에 라운드별 close 노트 누적 — 어떤 win/regression 발견됐고 어떻게 분류됐는지의 영구 기록.

### 9.2 e2e contract gates

특정 시각 win 을 **픽셀 sampling 으로 contract pin** 한 e2e 테스트:

| 파일 | round | contract | fixture |
|---|---|---|---|
| `audit-isolation.spec.ts` | 23 | __setIsolateNode 4 pieces 동작 | right_top, frame-2320, frame-2364 |
| `audit-transform-baking.spec.ts` | 24 | derivedTransform 모바일 5번째 row 렌더 | mobile/frame-2323-477_6439 |
| `audit-transform-baking.spec.ts` | 25 | path-key fix → alret 삭제 button visible | web/alret-364_2962 |

각 contract 는 `samplePixel({clip: 3x3 PNG})` + assertion (R<220 / b > r > 200 등) 패턴.

---

## 10. Spec 레지스트리

`docs/specs/*.spec.md` 의 현재 분류 (39개):

### 10.1 Foundation
- `round-trip-invariants.spec.md` — .fig roundtrip 룰
- `parent-index-position.spec.md` — fractional indexing
- `text-segments.spec.md` — TEXT 세그먼트 모델
- `editable-html.spec.md` / `html-to-message.spec.md` / `sidecar-meta.spec.md` — single-html export
- `json-repack-codec.spec.md` — JSON ⇄ kiwi roundtrip

### 10.2 Web use cases (application)
- `web-upload-fig` / `web-edit-node` / `web-resize-node` / `web-export-fig` / `web-snapshot`
- `web-instance-override` (write 측: chat/HTTP에서 텍스트 override 작성)
- `web-asset-serve`
- `web-chat-turn` / `web-chat-leaf-tools` / `web-chat-duplicate`
- `web-group-ungroup`
- `web-undo-redo`

### 10.3 Render fidelity (clientNode + Canvas)
- `web-render-fidelity-high` (1-3 통합), `web-render-fidelity-round2..10`
- `web-canvas-instance-clip` (round 12)
- `web-canvas-text-style-runs` / `web-canvas-text-frame-fidelity` / `web-canvas-hover-tooltip`
- `web-instance-render-overrides` (read 측: round 4/12/15 — **path-key 계약의 source of truth**)
- `web-instance-variant-swap` (round 16/17)
- `web-instance-autolayout-reflow` (round 14/15/19/20/21/22/24)

### 10.4 Refactor planning
- `expansion-context.spec.md` — round 18 cluster A 추출 계획서

### 10.5 UI / Layout
- `web-left-sidebar`

[SDD.md](./SDD.md) 룰: spec 이 source of truth. Iron rule — 구현이 spec 과 다르면 spec 먼저, test 그 다음, 코드 마지막.

---

## 11. 의존성

### 11.1 런타임 (요약)

| 영역 | 패키지 | 용도 |
|---|---|---|
| CLI codec | `adm-zip`, `pako`, `fzstd`, `kiwi-schema` | ZIP / deflate / zstd / Kiwi |
| Web 서버 | `hono`, `@hono/node-server` | HTTP |
| Chat | `@anthropic-ai/sdk`, `@anthropic-ai/claude-agent-sdk` | LLM |
| Web 클라이언트 | `react`, `react-dom`, `react-konva`, `konva`, `vite` | UI |

### 11.2 개발 (요약)

| 영역 | 패키지 |
|---|---|
| 타입체크 | `typescript` |
| 단위 테스트 | `vitest` |
| e2e 테스트 | `@playwright/test`, `pngjs` |
| dev 실행 | `tsx` |

전체 목록은 `package.json` (root) + `web/package.json`.

---

## 12. 명령어 cheatsheet

```bash
# 단위 테스트
npx vitest run                            # root: 126 tests
npm --prefix web test                     # web: 450 tests

# e2e (dev 서버 필요)
npm --prefix web run dev                  # 백그라운드 띄우기
cd web && npx playwright test e2e/audit-transform-baking.spec.ts

# audit baseline 재캡처 (dev 서버 필요)
node web/scripts/audit-round11-screenshots.mjs <page-slug>

# CLI extract / repack / pen-export
npx tsx src/cli.ts extract docs/메타리치\ 화면\ UI\ Design.fig
npx tsx src/cli.ts repack ./extracted ./out.fig
npx tsx src/cli.ts pen-export docs/메타리치\ 화면\ UI\ Design.fig out.pen
```

---

## 13. 알려진 제약 + round-26 후보군

### 13.1 알려진 제약 (round 25 시점)

- **derivedTransform v1 한계** (reflow §3.10 I-DT4): reflow 가 fire 한 직접 자식의 m02/m12 는 reflow 가 wins. 시각 영향 미관찰이라 v1 punt.
- **componentPropNodeField 부분 지원**: VISIBLE 만 처리, TEXT / INSTANCE_SWAP 미처리.
- **stroke / effects / opacity / blendMode override 미지원**: fillPaints 만 처리. 메타리치 케이스에 미발견.
- **colorVar / variable alias 미해석**: literal color 만 사용. .fig 가 항상 literal 도 stamp 하므로 시각 영향 없음.
- **Vector 디코드 95%**: 82개 BOOLEAN_OPERATION 등 합성 노드는 fillGeometry 없음 — best-effort.
- **Figma 클라우드 임포트 미검증**: repack 한 .fig 를 Figma 가 받는지 미확인.

### 13.2 Round-26 후보군 (현재 비어있음)

라운드 25 close 시점에 신규 candidate 없음. GAPS.md round-25 verdict 에서 "round 26 candidates 없음, future rounds can build on top with confidence" 명시됨.

후속 작업은 *기존 시스템 위의 새 기능* 영역에서 자유 — 예시:
- 새 Figma 디자인 변환 corpus (메타리치 외)
- componentPropNodeField TEXT / INSTANCE_SWAP 지원 확장
- stroke/effects override 추가
- Pencil round-trip (`.pen` ↔ `.fig`) 동등성 강화
- editable-html UI 확장
- LLM agent tool 확장 (현재 set_text / set_fill / duplicate / leaf 작업 지원)

---

## 14. 디렉터리 구조 한 눈

```
figma_reverse/
├─ src/                               CLI + 공유 도메인 (§3.1)
│  ├─ cli.ts, container.ts, decoder.ts, tree.ts, ...
│  ├─ pen-export.ts, editable-html.ts, repack.ts
│  └─ instanceOverrides.ts ⭐ (round 18, 25)
├─ web/
│  ├─ core/                           Hexagonal 도메인 코어 (§3.2)
│  │  ├─ domain/clientNode.ts ⭐
│  │  ├─ ports/, application/
│  ├─ server/adapters/                Hexagonal 외곽 (§3.3)
│  │  ├─ driving/http/
│  │  └─ driven/
│  ├─ client/src/                     React UI (§3.4)
│  ├─ e2e/                            Playwright (§9)
│  └─ scripts/audit-round11-*.mjs    Audit harness
├─ docs/
│  ├─ SPEC.md                         CLI 9-stage (§1, §2)
│  ├─ SPEC-architecture.md            ⭐ 본 문서 (현재 시점 통합 + Phase 0 이력)
│  ├─ SDD.md, HARNESS.md, PRD.md
│  ├─ adr/                            결정 기록 4건
│  ├─ specs/*.spec.md                 39 spec (§10)
│  └─ audit-round11/                  Audit baseline + GAPS.md (§9.1)
├─ test/                              root vitest
└─ extracted/, output/                CLI 산출물 (gitignore)
```

---

## 15. 참고

- 라운드별 commit chain: `git log --oneline --grep "round 2[0-5]"`
- Audit baseline 진화: `docs/audit-round11/GAPS.md` (round 22 / 23 / 24 / 25 close section)
- 새 라운드 시작 체크리스트:
  1. 이 문서 [§8 라운드 매트릭스](#8-라운드-히스토리-매트릭스) 에서 가까운 선례 확인
  2. 영향받는 spec ([§10 Spec 레지스트리](#10-spec-레지스트리)) 식별
  3. SDD 룰 — spec 먼저, test 다음, 코드 마지막
  4. 단위 테스트 + 4 corpus audit baseline 갱신
  5. e2e contract pin (시각 win 이 있다면)
  6. GAPS.md round-N close 섹션 추가

---

## 16. Appendix A — Phase 0~7 마이그레이션 이력 (2026-05-02 ~ 05)

**(구 `docs/ARCHITECTURE.md` 의 흡수본 — 마이그레이션 완료 후 historical reference)**

### 16.1 마이그레이션 개요

| 항목 | 값 |
|---|---|
| 시작 | 2026-05-02 (구 `ARCHITECTURE.md` v0.1 — Phase 0 산출물) |
| 종료 | 2026-05-05 (round 25 cutoff — 본 SPEC 작성 시점) |
| 적용 대상 | `web/` 서버 + 클라이언트 (`src/` CLI 는 비대상) |
| 비목표 | 기능 추가 / 동작 변경 / `src/` 재배치 |

> **목표** (당시): 단일 1,234 줄 `server/index.ts` + 비즈 로직이 컴포넌트
> 안에 산재한 React 클라이언트를, **Clean Architecture × Hexagonal (Ports
> & Adapters)** 로 재배치. 외부 의존(파일시스템, Anthropic SDK, Hono,
> React) 을 도메인 코어에서 분리 → 유지보수성·테스트 용이성. SPEC→TEST→IMPL
> 사이클 ([SDD.md](./SDD.md), [HARNESS.md](./HARNESS.md)) 을 web 레이어에도 일관
> 적용.

### 16.2 Phase 0 인벤토리 (마이그레이션 직전 LOC 분포)

```
server/index.ts            1234   ← 모놀리스: 라우팅 + 도메인 + IO + SDK
client/src/Canvas.tsx       878   ← Konva 렌더 + 이벤트 + 좌표 수학
client/src/Inspector.tsx    948   ← UI + 패치 + 색/숫자 + 컴포넌트 텍스트 모델
client/src/ChatPanel.tsx    543   ← UI + fetch + 인증 모드 + 모델 선택
client/src/App.tsx          344   ← 레이아웃 + onUpload/onSave/onMove*
client/src/hooks/usePatch.ts 77   ← 디바운스 (이미 추출됨)
client/src/multiResize.ts   ~80   ← 그룹 리사이즈 (이미 추출됨)
─────────────────────────────────
                           ≈4659  (UI 프리미티브 제외)
```

당시 문제:
- 라우트 핸들러가 도메인 로직 + IO + 외부 SDK 호출을 한 함수에서 처리 → 단위 테스트 불가
- React 컴포넌트가 직접 `fetch()` → 컴포넌트 테스트 시 네트워크 모킹 필요
- 같은 도메인 개념이 클라이언트와 서버 양쪽에 중복 정의

### 16.3 Phase 로드맵 (실제 진행)

| Phase | 산출물 | 결과 |
|---|---|---|
| **0** | 본 문서의 전신 (`ARCHITECTURE.md` Phase 0 산출물) | ✅ 2026-05-02 완료 |
| **1** | `web/core/ports/*.ts` 6개 인터페이스 | ✅ |
| **2** | `web/core/domain/*.ts` 순수 헬퍼 추출 + shim | ✅ |
| **3** | `web/server/adapters/driven/*.ts` (FsSessionStore 등) | ✅ |
| **4** | `web/core/application/*.ts` use case | ✅ |
| **5** | `web/server/adapters/driving/http/*.ts` Hono 라우트 분할 | ✅ |
| **6** | `web/client/src/services/*.ts` (네트워크/상태 추상화) | ✅ |
| **7** | SDD/Harness 정착: `docs/specs/web-*.spec.md` + L0/L1 테스트 | ✅ (본 SPEC §10 Spec 레지스트리 + §9 테스트 레이어 가 결과) |

7 phase 모두 round 25 까지 완료. 본 SPEC §3 (모듈 카탈로그) 가 *결과* 의
single source — `web/core/domain` zero-deps, `web/core/application` 이 ports
+ domain 만 import, `web/server/adapters/driven` 이 외부 라이브러리 연결.

### 16.4 핵심 마이그레이션 결정 (Phase 0 시점)

| 결정 | 값 | 사유 |
|---|---|---|
| 새 코드 위치 | `web/core/` (web 트리 안) | `src/` 는 CLI 전용으로 유지. 추후 통합 검토 |
| Port 정의 위치 | `web/core/ports/` | application 이 ports 의 owner |
| Domain 의존성 | 0 (no React, no Node fs, no SDK) | 테스트 격리·재사용성 보장 |
| Shim 전략 | 기존 import 경로는 re-export 로 유지 | Phase 2 회귀 0 |
| `src/` 재배치 | 본 마이그레이션 비대상 | 별도 RFC 후 진행 |

마지막 결정 ("`src/` 재배치 비대상") 의 결과: round 18 에서 `masterIndex` /
`effectiveVisibility` / `instanceOverrides` 를 `src/` 에 둔 채로 web 측이
import — [ADR-0004](./adr/0004-shared-modules-live-in-src.md) 에서 정식 결정.

### 16.5 회귀 가드 (당시 Phase 0~2 invariant)

- 8 unit + 7 e2e + typecheck + production build 통과 유지
- `tokenizePath` / `setPath` 등 함수 시그니처 변화 없음 (re-export shim 호환)
- 외부 동작 (`/api/*` 응답) 변화 없음
- 의존성 변화는 dev-deps 추가만, 런타임 deps 추가 0

Phase 3 이후의 동작 동등성은 [HARNESS.md](./HARNESS.md) Layer 0~3 가 보증.
현재는 §9 테스트 레이어 가 evolved — round 25 시점 L0 (450 web + 126 root
unit) + L1 (~30 e2e) + L2 (749 audit PNG) + L3 (round-trip) + L4 (CLI verify).

### 16.6 모듈 이동 매트릭스 (현재 → 도착, 완료)

| 출처 (당시 server/index.ts 안) | 도착 (현재) |
|---|---|
| `tokenizePath`, `setPath` | `web/core/domain/path.ts` |
| `findById`, `findNode` | `web/core/domain/tree.ts` |
| `summarizeDoc` | `web/core/domain/summary.ts` |
| `sniffImageMime` | `web/core/domain/image.ts` |
| `repack` / `decode` 호출 | `web/server/adapters/driven/KiwiCodec.ts` |
| `mkdtemp` / `readFile` / `save` 흐름 | `web/server/adapters/driven/FsSessionStore.ts` |
| `GET /api/asset` 핸들러 | `web/core/application/ServeAsset.ts` + `adapters/driving/http/assetRoute.ts` |
| `POST /api/chat` (subscription) | `RunChatTurn` + `AgentSdkChat` |
| `POST /api/chat` (api-key) | `RunChatTurn` + `AnthropicChat` |
| `applyTool` | `InProcessTools` (구현) + `core/ports/ToolDispatcher.ts` (계약) |
| `Inspector.tsx:rgbaToHex/hexToRgb01` | `web/core/domain/color.ts` (Canvas 와 단일화) |
| `Canvas.tsx:imageHashHex` | `web/core/domain/image.ts` |
| `Canvas.tsx:colorOf/strokeOf/guidStr` | `web/core/domain/color.ts` + `web/core/domain/tree.ts` |
| `client/src/api.ts` (fetch wrapper) | `client/src/services/*Service.ts` |
| `client/src/hooks/usePatch.ts` | (그대로 — 이미 적합 위치) |
| `client/src/multiResize.ts` | (그대로) |
| Hono routes (모든 `app.get/post/patch`) | `adapters/driving/http/*Route.ts` 로 분할 |

이 매트릭스는 *완료된 작업의 archeology* — 새 코드는 본 SPEC §3 의 카탈로그
를 reference. 이 표는 git blame / 마이그레이션 PR 추적 시에만 의미 있음.
