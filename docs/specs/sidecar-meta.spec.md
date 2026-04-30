# spec/sidecar-meta

| 항목 | 값 |
|---|---|
| 상태 | Approved (Iteration 10) |
| 책임 모듈 | `src/sidecar-meta.ts` (신규) |
| 의존 | `src/decoder.ts`, `src/tree.ts`, `src/assets.ts::hashToHex` |
| 테스트 | `test/sidecar-meta.test.ts` |
| 부모 SPEC | [SPEC-roundtrip §3.5 Tier B, §3.6](../SPEC-roundtrip.md) |

## 1. 목적

모든 노드의 raw 필드를 사용자 편집 가능한 JSON으로 표현하는 sidecar 파일 (`figma.editable.meta.js`) 생성. **Tier A로 HTML에 표현되는 필드도 sidecar에 함께 보유** (HTML 우선이지만 sidecar는 ground truth).

## 2. 입력

```ts
interface SidecarMetaInputs {
  decoded: DecodedFig;            // schema, message, archive version, sha256
  tree: BuildTreeResult;          // 노드 GUID 인덱스
  outputDir: string;              // assets/blobs/ 출력 위치
  options?: {
    blobInlineThresholdBytes?: number;  // default 1024 — 작은 blob은 hex inline, 큰 건 파일 참조
    nodesPerFile?: number;        // default 0 (단일 파일). >0 시 nodes-by-page/<n>.js로 분할
  };
}
```

## 3. 출력

디렉토리 모드:
```
<htmlOutDir>/figma.editable.meta.js
또는 (분할 시):
<htmlOutDir>/figma.editable.meta.js     ← __meta + message만
<htmlOutDir>/data/nodes-page-00.js      ← page 0 nodes
<htmlOutDir>/data/nodes-page-01.js
...
```

`figma.editable.meta.js` 내용 형식:

```javascript
window.FIGMA_RAW = {
  __meta: {
    archiveVersion: 106,
    schemaSha256: "b82dafbd...",
    sourceFigSha256: "de8f66cc...",
    rootMessageType: "NODE_CHANGES",
    generator: "figma-reverse v2.0",
    generatedAt: "2026-04-30T..."
  },
  message: { type: "NODE_CHANGES", sessionID: 0, ackID: 0 },
  nodes: { /* GUID → raw 객체 */ },
  blobs: [ /* commandsBlob 등 */ ]
};
```

큰 blob은 `assets/blobs/<idx>.bin`에 분리하고 `{ ref: "assets/blobs/<idx>.bin", bytes: N }` 참조.

## 4. Invariants

### I-1 모든 노드 보존

```
∀ node ∈ tree.allNodes:
   FIGMA_RAW.nodes[node.guidStr] !== undefined
   ∧ raw 키 집합이 원본 message.nodeChanges의 해당 노드와 동등 (Tier C 제외)
```

### I-2 Uint8Array → hex 문자열 (lossless)

```
∀ field ∈ raw, type(field) === Uint8Array:
   typeof FIGMA_RAW.nodes[guid][field] === 'string'
   ∧ Buffer.from(value, 'hex').equals(원본 Uint8Array)
```

### I-3 BigInt → 문자열 보존

```
∀ field ∈ raw, type(field) === BigInt:
   typeof FIGMA_RAW.nodes[guid][field] === 'string'
   ∧ BigInt(value) === 원본 BigInt
```

### I-4 Tier C 필드 제외

다음 필드는 sidecar에 포함하지 않는다 (HTML 또는 도구가 자동 결정):
- `guid` (또는 `{sessionID, localID}`)  — key가 GUID이므로 중복
- `parentIndex` — DOM 구조로 결정
- `phase` — 도구가 CREATED/REMOVED 자동 설정

```
FIGMA_RAW.nodes[guid].guid === undefined
FIGMA_RAW.nodes[guid].parentIndex === undefined
FIGMA_RAW.nodes[guid].phase === undefined
```

### I-5 Tier A 필드 동기화 (HTML 우선)

HTML에 표현된 필드(예: size, transform, fillPaints)는 sidecar에도 있다. 변환 시 **HTML 값 우선**, sidecar는 fallback.

```
∀ guid:
  htmlValue !== undefined ⇒ result = htmlValue
  htmlValue === undefined ⇒ result = sidecarValue
```

(이 invariant는 [html-to-message.spec.md](./html-to-message.spec.md) 책임)

### I-6 Blob 인덱스 안정성

`FIGMA_RAW.blobs[i]`의 인덱스 `i`는 원본 message.blobs의 인덱스와 일치. 노드의 `commandsBlob: 203` 같은 참조가 그대로 유효.

```
∀ i ∈ [0, blobs.length):
   blobs[i].hex 또는 blobs[i].ref → 원본 message.blobs[i].bytes와 동등
```

### I-7 Inline vs ref threshold

```
∀ blob i:
   blob.bytes ≤ options.blobInlineThresholdBytes:
     blobs[i] === { hex: <hex string> }
   blob.bytes > threshold:
     blobs[i] === { ref: "assets/blobs/<padded i>.bin", bytes: N }
     ∧ <htmlOutDir>/assets/blobs/<padded i>.bin 파일 존재 (raw bytes)
```

### I-8 결정성

같은 입력 → 같은 sidecar JSON (타임스탬프 필드 외).

### I-9 형식 안전성 (HTML 임베드 호환)

`</script>` 시퀀스는 자동 escape (`<\/script>`). 사용자가 raw 데이터에 그 시퀀스를 넣어도 sidecar가 깨지지 않음.

## 5. Error Cases

- E-1: 노드 raw 객체 직렬화 실패 (cycle 등) → throw `Error("sidecar: cyclic reference at <guid>")`
- E-2: blob 인덱스 갭 (예: 0,1,3) → 비어있는 인덱스는 `null`로 채워 array 인덱스 안정성 보장
- E-3: `outputDir` 작성 권한 없음 → throw (fs 에러 전파)

## 6. Out of Scope

- O-1: HTML 생성 — [editable-html.spec.md](./editable-html.spec.md)
- O-2: HTML → message 변환 — [html-to-message.spec.md](./html-to-message.spec.md)
- O-3: blob 의미 디코드 (commandsBlob → SVG path 등) — `vector.ts` 책임 (편집은 SVG에서, sidecar는 raw 보존만)
- O-4: 사용자 편집 시 schema 검증 — html-to-message가 책임
- O-5: 노드별 분할(`data/nodes-page-N.js` 분할)의 lazy load 코드 — HTML/JS 측 책임

## 7. 참조

- 부모: [SPEC-roundtrip §3.6](../SPEC-roundtrip.md)
- 데이터 형식 예시: [SPEC-roundtrip §3.6](../SPEC-roundtrip.md)의 `figma.editable.meta.js` 구조 블록
- 형제: [editable-html.spec.md](./editable-html.spec.md), [html-to-message.spec.md](./html-to-message.spec.md)
