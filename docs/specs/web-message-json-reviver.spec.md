# spec/web-message-json-reviver

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/messageJson.ts` (`rebuildDocumentFromMessage`) |
| 테스트 | (TODO) `web/core/domain/messageJson.test.ts` — 본 spec 의 reviver 룰 단위 |
| 형제 | `json-repack-codec.spec.md` (CLI 측 encode/decode tag system), `web-instance-pipeline.spec.md` (`toClientNode` 의 호출자), `web-chat-duplicate.spec.md` / `web-group-ungroup.spec.md` (structural tools — 본 reviver 의 사용처) |

## 1. 목적

Web pipeline 의 *structural mutation tools* (`duplicate`, `group`, `ungroup`)
는 트리의 parent-child 관계를 *전역적으로* 재배치한다 — `parentIndex.guid +
position` 이 다수 노드에 걸쳐 변경되므로 `documentJson` 을 *부분 mutation*
으로 동기화할 방법이 없다. 본 spec 의 helper 가 그 케이스의 *전체 재계산*
파이프라인을 정의한다:

```
messageJsonRaw (string)
  ↓ JSON.parse + reviver (Uint8Array 복원)
  ↓ buildTree (parent-child 링크 복원)
  ↓ buildSymbolIndex (master GUID 인덱스)
  ↓ toClientNode (INSTANCE 확장 + override 적용)
  ↓ Document
```

leaf chat tools (`set_text`, `set_position` 등) 은 *부분 mutation* 으로 충분
— 본 helper 미사용. 사용처 분리는 `web-chat-leaf-tools.spec.md` 와
`web-chat-duplicate.spec.md` 가 source.

## 2. 진입점

```ts
function rebuildDocumentFromMessage(messageJsonRaw: string): Document;
```

- I-E1 입력: `messageJsonRaw` = `JSON.stringify` 결과 문자열. structural
  tool 이 mutation 후 새 message tree 를 `JSON.stringify` 하여 carry, 본
  helper 가 reverse direction.
- I-E2 출력: `DocumentNode` 트리 (root = `DOCUMENT` type). 호출자가
  `session.documentJson` 에 직접 assign — 별도 검증 없음.
- I-E3 *server-side only*. `Buffer.from(..., 'base64')` 가 Node 환경에서만
  동작 — 브라우저에서 호출하면 ReferenceError.

## 3. Reviver — `__bytes` tag 복원

JSON.parse 의 reviver 가 special encoding 을 풀어 `Uint8Array` 를 복원한다.

- I-R1 매칭 룰: `v` 가 truthy object (non-array) AND `v.__bytes` 가 string.
  `Array.isArray` check 도 통과해야 함 (배열은 통과).
- I-R2 매칭 시 `Uint8Array.from(Buffer.from(v.__bytes, 'base64'))` 로 변환.
  `Buffer.from(..., 'base64')` 의 backing buffer 에 view 를 씌운 view 가
  아니라 *copy* — `Uint8Array.from` 이 새 buffer 할당.
- I-R3 매칭 안 되는 모든 value (일반 object/array/scalar) 는 그대로 통과.
- I-R4 *유일 tag = `__bytes`*. CLI 측 codec 의 다른 tag (`__bigint`, `__num`)
  는 *web pipeline 의 message tree 에 등장하지 않음* — 그래서 본 reviver 에
  미구현. 향후 등장하면 추가 (json-repack-codec.spec.md §3.4 참조).

## 4. 처리 단계

### 4.1 JSON.parse + reviver

- I-P1 `JSON.parse(messageJsonRaw, (_, v) => reviver(v))` — 표준 reviver
  signature 의 두 번째 인자.
- I-P2 throw 정책: 잘못된 JSON 은 `JSON.parse` 가 native error throw —
  본 helper 는 catch 하지 않는다. 호출자 (HTTP route) 가 error handler
  에서 400 / 500 으로 매핑.
- I-P3 reviver 자체는 throw 안 함. 잘못된 base64 string 은
  `Buffer.from(invalid, 'base64')` 가 partial decode — silent.

### 4.2 buildTree

- I-P4 `buildTree(messageObj)` 호출 — `src/tree.ts` 의 CLI 와 동일 함수.
  Kiwi Records → linked Tree Nodes 변환 (CONTEXT.md `Tree Node` 항목).
- I-P5 결과 `tree.document` 가 `null` 이면 `throw new Error('messageJson
  has no DOCUMENT root')`. 다른 모든 트리 형태 결함은 silent — buildTree
  자체의 robustness 에 위임.

### 4.3 Symbol index 와 toClientNode

- I-P6 `blobs = (messageObj as ...).blobs ?? []` — 부재 시 빈 배열로 fallback.
  vector / image blob 이 부재해도 트리 변환은 진행 (vector 노드는 `_path`
  미생성 으로 fallback, `vector-decode.spec.md §I-E1` 동일 정책).
- I-P7 `buildSymbolIndex(tree.allNodes.values())` 로 master 인덱스 생성.
  `web-instance-pipeline.spec.md §1` 의 INSTANCE expansion 진입점과 동일
  shape.
- I-P8 `toClientNode(tree.document, blobs, symbolIndex)` 호출 — INSTANCE
  확장 + override 적용 + reflow 적용 모두 본 함수가 책임 (pipeline.spec
  §2 source).

## 5. CLI codec 과의 관계

- I-C1 *encode 측 호환성*: 본 reviver 는 CLI 의 `intermediate.ts:roundTripReplacer`
  가 emit 하는 `{__bytes: <base64>}` tag 와 *형식 동일*. CLI 가 `04_decoded/message.json`
  으로 dump 한 파일을 web 측 reviver 가 그대로 다시 읽어들일 수 있다 (실제로
  쓰지는 않지만 contract 호환).
- I-C2 *비대상 tag*: CLI 의 `__bigint` / `__num` tag 는 본 reviver 미구현.
  web pipeline 의 message tree 에 bigint / 비-finite number 가 *현재* 없어서
  — 등장 시 본 spec 업데이트 필요.
- I-C3 *방향 차이*: CLI codec 은 *encode + decode* 양방향 (`json-repack-codec.spec.md`
  의 `encodeMessage` / `decodeMessage`). 본 helper 는 *decode 만* — web 측
  은 message tree 를 JSON.stringify 그대로 emit (별도 replacer 미사용)
  하고 reviver 만 special-case.

## 6. 호출 시점

본 helper 가 호출되는 정확한 시점:

| Use case | 호출 trigger | source spec |
|---|---|---|
| `Duplicate` | duplicate 후 `session.documentJson` 재계산 | web-chat-duplicate.spec.md |
| `Group` | new GROUP node 추가 후 부모-자식 재배치 | web-group-ungroup.spec.md |
| `Ungroup` | GROUP 해제 후 자식들 re-parent | web-group-ungroup.spec.md |
| `Undo` / `Redo` | structural diff replay 후 | web-undo-redo.spec.md §4.2 |
| `LoadSnapshot` | snapshot 의 messageJson 으로 session 재구성 | web-snapshot.spec.md |
| `UploadFig` | (간접) — kiwi → message tree 처리 후 같은 파이프라인 사용 | web-upload-fig.spec.md |

- I-U1 위 use case 는 모두 *server-side* — 본 helper 가 server 전용인 이유
  (§I-E3) 와 일치.
- I-U2 호출자가 결과 `Document` 의 *deep equality* 를 검증할 책임 없음 —
  buildTree + toClientNode 의 결정성에 의존 (같은 input → 같은 output).

## 7. Error policy

- I-X1 잘못된 JSON → `JSON.parse` 의 native error 그대로 propagate.
- I-X2 `tree.document` null → 명시적 `Error('messageJson has no DOCUMENT
  root')`. 호출자가 catch 후 410 / 422 등 적절한 HTTP 상태로 매핑.
- I-X3 잘못된 base64 string → silent partial decode. wire format 손상이
  있어도 트리 자체는 살아남음 (vector blob 만 깨짐).
- I-X4 build / toClientNode 단계의 unexpected error → propagate. 호출자가
  500 으로 매핑.

## 8. 비대상

- ❌ **CLI codec 과의 통합** — 두 helper 를 한 파일로 합치는 것은 본 spec
  비대상. 환경 차이 (Node Buffer vs browser-safe atob) + tag 범위 차이
  (`__bytes` only vs 3 tag) 가 분리를 정당화.
- ❌ **streaming parse** — 전체 messageJson 을 메모리 한 번에 적재.
  메타리치 6.05 MB / 메시지 트리는 JSON.stringify 후 ~150 MB 이지만 server
  메모리 가정 (NF-02 의 입력 파일 크기 × 5 이내).
- ❌ **diff-only update** — 본 helper 는 *전체 재계산*. structural mutation
  의 partial diff 만 적용하는 incremental update 는 미지원 (전체 재계산이
  결정성 보장의 simple path).
- ❌ **tag 자동 확장** — `__bigint` / `__num` 미구현. 등장 시 명시적 spec
  업데이트.

## 9. Resolved questions

- **왜 `Uint8Array.from(Buffer.from(...))` 인가? 직접 `new Uint8Array(buffer)`
  도 가능한데?** `Buffer` 가 `Uint8Array` 의 subclass 이지만 *typeof* 와 일부
  consumer 가 두 타입을 다르게 다룬다. `Uint8Array.from` 으로 *plain* Uint8Array
  사본을 만들면 downstream 의 type narrow / instanceof 가 안전.
- **structural mutation 후 *부분* mutation 으로 documentJson 을 동기화 못
  하는 이유?** `parentIndex.guid + position` 이 *다른 노드의 sibling 정렬*
  에 영향. 한 노드를 group 에 넣으면 그 sibling 들의 fractional-index 가
  재할당될 수 있고, 그 변화는 단일 mutation 으로 표현 불가능. 전체 재계산이
  *간단성과 결정성* 양쪽에서 우월.
- **leaf tools 가 *항상* 부분 mutation 으로 충분한가?** `set_text` / `set_fill_color`
  등은 한 노드의 한 필드만 변경 — 트리 구조 변경 없음 → 부분 mutation 으로
  충분. 그러나 `set_position` 이 INSTANCE 의 master 를 건드리면 모든 사용처에
  영향이 갈 수도 있음 — 그 케이스는 `web-chat-leaf-tools.spec.md` 가 별도
  처리.
