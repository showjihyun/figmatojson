# spec/rest-api-normalize

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `src/normalize.ts` (`normalizeTree`, `normalizeNode`, `computeBoundingBox`, `serializableRaw`) |
| 테스트 | `test/normalize.test.ts` (있는 한도 내) — 본 spec 의 alias / bbox / Uint8Array conversion 단위 |
| 형제 | `SPEC.md §Stage 8` (출력 파이프라인 source), `PRD.md §10 결정 b` ("실용형" 정책 결정) |

## 1. 목적

CLI Stage 8 의 `output/document.json` 과 `output/pages/*.json` 출력은 *Figma
REST API 응답과 부분 호환* 되어야 한다 (PRD G4). 그러나 Kiwi 의 wire format
이 REST 와 *완벽 일치는 아닌* 영역들 — 필드 명칭 (fillPaints vs fills),
좌표 계산 (transform 행렬 vs absoluteBoundingBox), 직렬화 안전성 (Uint8Array,
BigInt) — 이 있음. 본 spec 은 *어디까지 alias 하고, 무엇은 원본 그대로
보존하는지* 를 single source 로 둔다.

정책: PRD §10 결정 (b) **"실용형"** — Kiwi 원본 키를 *그대로 보존* + REST
API 별칭 *추가*. 양쪽 모두 grep 가능. (a) "REST 완전 호환" 은 변환 비용
높고 일부 데이터 (`derivedSymbolData`) 는 REST 에 매핑 없음.

## 2. 출력 노드 형태

```ts
interface NormalizedNode {
  id:                     string;     // "sessionID:localID" — REST 명명
  guid:                   GUID;       // 원본 {sessionID, localID} 보존
  type:                   string;
  name?:                  string;
  visible?:               boolean;
  parentId?:              string;     // parent 의 id (REST 명명)
  fills?:                 unknown;    // fillPaints alias
  strokes?:               unknown;    // strokePaints alias
  effects?:               unknown;    // 그대로
  absoluteBoundingBox?:   { x, y, width, height };
  children?:              NormalizedNode[];
  raw:                    Record<string, unknown>;  // Kiwi 원본 (직렬화 안전)
}
```

- I-N1 `id` 와 `guid` *동시 emit*. REST consumer 는 `id`, kiwi-aware 코드는
  `guid` 사용 — 한 node 에서 둘 다 grep 가능 (실용형 정책 핵심).
- I-N2 `raw` 필드는 *Kiwi 의 모든 원본 필드* (직렬화 안전 변환 후) 를
  carry. alias 가 추가되어도 원본 키 (`fillPaints` 등) 가 raw 안에 살아있음.
- I-N3 alias 는 *별칭* (reference) 이지 deep-clone 아님 — `out.fills =
  out.raw.fillPaints` 는 같은 array 를 가리킨다. mutation 시 양쪽이 동시
  변경됨. 호출자가 read-only 가정.

## 3. 필드 alias 매핑

| Kiwi 원본 | REST alias | 적용 조건 |
|---|---|---|
| `data.fillPaints` | `node.fills` | `'fillPaints' in data` |
| `data.strokePaints` | `node.strokes` | `'strokePaints' in data` |
| `data.effects` | `node.effects` | `'effects' in data` |
| `treeNode.guid` (`{sessionID, localID}`) | `node.id` (`"sessionID:localID"`) | 항상 |
| `treeNode.parentGuid` | `node.parentId` (`"sessionID:localID"`) | parent 존재 시 |
| `data.visible` (boolean) | `node.visible` | typeof boolean 일 때만 |

- I-A1 alias 는 *추가만* — 원본 키 삭제 안 함. `node.raw.fillPaints` 도 함께
  존재.
- I-A2 부재 필드는 alias 도 부재 — `'fillPaints' in data` 가 false 면
  `node.fills` 도 emit 안 함. REST 응답의 omission 정책과 일치.
- I-A3 `node.id` 형식 = `${sessionID}:${localID}` (decimal). pencil.dev 의
  `Pen ID` (5-base62 chars) 와 다른 ID space (CONTEXT.md `GUID` 항목).

## 4. `absoluteBoundingBox` — best-effort 계산

Figma REST 의 `absoluteBoundingBox` 는 *root-relative* canvas 좌표계의
bounding box. 우리는 transform 행렬의 *translation 컴포넌트* 만 읽어 근사.

- I-B1 `data.size` 가 `{x: number, y: number}` 형태가 *아니면* bbox 미생성.
  rectangle / vector 가 아닌 노드 (e.g. DOCUMENT root) 가 size 부재라 제외.
- I-B2 `data.transform` 부재 시: `{ x: 0, y: 0, width: size.x, height: size.y }`
  (origin 가정).
- I-B3 `data.transform` 존재 시: `transform.m02` / `m12` 만 사용 (translation).
  rotation (m01, m10) 과 scale (m00, m11) **무시** — best-effort.
- I-B4 *root-relative* 가 아님 — 본 함수는 `transform` 만 보고 부모 chain 을
  walk 하지 않음. Figma REST 의 *진짜 absoluteBoundingBox* 는 부모 transform
  의 누적 — 우리 출력은 *parent-relative bbox* 에 가깝다 (이름은 REST 호환
  유지).
- I-B5 회전된 노드의 bbox: 본 spec 미지원. rotation 이 있으면 emit 된 width/
  height 는 *축에 정렬된 박스의 비-회전 크기*. 정확한 회전 bbox 는 별도
  helper (현재 미구현).

## 5. `serializableRaw` — Kiwi → JSON 안전 형태

Kiwi 가 decode 한 raw 객체는 `Uint8Array` / `BigInt` 등 JSON 직렬화 불가
값을 carry — `JSON.stringify` 가 그대로 실패하거나 `null` 로 손실. 본 함수가
*결정적으로* 직렬화 가능 형태로 변환.

### 5.1 변환 룰

- I-S1 `null` / `undefined` → 그대로.
- I-S2 `bigint` → `(value).toString()` (decimal string). 부호 보존 (`-1n`
  → `"-1"`).
- I-S3 `Uint8Array` → `hashToHex(value)` (lowercase hex string, no `0x`
  prefix). 빈 array → `""`.
- I-S4 `Array` → 새 array, element 별 재귀 변환.
- I-S5 `Object` (plain) → 새 object, property 별 재귀 변환. `for...in` +
  `hasOwnProperty` 룰 — prototype chain 탐색 안 함.
- I-S6 그 외 primitive (`string`, `number`, `boolean`) → 그대로.
- I-S7 `function` / `Symbol` / 기타 exotic 타입 → 본 spec 비대상 (Kiwi 는
  carry 안 함).

### 5.2 결정성

- I-S8 같은 입력 → 같은 출력. Kiwi-decoded 데이터는 트리 구조 (cycle 없음)
  라 `WeakMap` cache 불필요 — 단순 재귀.
- I-S9 입력 *읽기 전용* 가정. 본 함수가 입력 mutation 안 함.
- I-S10 `for (const k in obj)` 의 property 순서는 V8 의 insertion order +
  numeric-key 우선 룰을 따름. CLI 의 `extract` 와 `repack` round-trip 에서
  동일 순서 보장이 *결정성 검증* 의 일부.

### 5.3 `hashToHex` — `assets.spec.md` 와 공유

- I-S11 `Uint8Array` → hex string 변환은 `assets.ts:hashToHex` 가 source.
  `Buffer.from(buf.buffer, byteOffset, byteLength).toString('hex')` 사용
  (zero-copy view). String input (이미 hex) 은 lowercase 변환 후 그대로
  반환.

## 6. Tree 재귀

- I-T1 `normalizeTree(root)` 가 진입점. `root === null` 이면 `null` 반환.
- I-T2 `treeNode.children.length > 0` 이면 `children: tn.children.map(normalizeNode)`
  emit. 빈 children 은 emit 안 함 (REST omission 일관성).
- I-T3 자식 순서는 `tn.children` 의 array 순서 — `parentIndex.position` 의
  fractional-index 정렬 결과 (`parent-index-position.spec.md`).

## 7. 비대상

- ❌ **REST 의 stylable 필드 매핑 일부** — `style`, `styles`, `componentSetId`
  등은 우리 측 alias 안 함 (Kiwi 의 동일 데이터가 다른 shape 라 1:1 매핑
  복잡). raw 안에서 grep.
- ❌ **회전 bbox** — §I-B5 참조.
- ❌ **부모 transform 누적** — §I-B4 참조. 진짜 root-relative 좌표가 필요한
  consumer 는 `pen-export` 의 `convertNode` 사용 (parent chain walk 함).
- ❌ **REST API 의 상위 응답 wrap** (`document.children[0]` 등의 reservation).
  본 함수는 *node-level* 변환만 — `output/document.json` 의 root-level
  wrap 은 `export.ts` 책임.
- ❌ **ColorVar / variable alias 해석** — Kiwi 의 `colorVar.value.alias.guid`
  를 literal color 로 resolve 하지 않음 (`SPEC-figma-to-pencil §3` 의 pen-export
  측 정책과 다른 점). REST 호환성보다 raw 보존이 우선.
- ❌ **mutation API** — 본 함수는 read-only 변환. node 편집 도구는 `web-edit-node.spec.md`.

## 8. Resolved questions

- **왜 `fills` 가 alias 이고 `fillPaints` 가 raw 인가? 반대 아닌가?** Kiwi
  schema 가 `fillPaints` 라는 이름으로 stamp — wire 의 *진짜 이름*. REST
  가 `fills` 라는 *축약 별칭* 을 쓰는 거고, 우리는 *둘 다 emit* 하므로
  consumer 의 grep 자유도 보장.
- **`absoluteBoundingBox` 의 이름이 misleading 인가?** 약간. 진짜
  *absolute* (root-relative) 가 아니지만 REST API 호환 차원에서 그 이름을
  reuse. 정확한 absolute 좌표가 필요하면 pen-export 또는 client 측 transform
  walker 사용.
- **`raw` 필드가 `out` 에 *직접 spread* 되지 않고 별도 properties 에 들어가
  있는 이유?** 두 단계 분리: `out.fillPaints` 가 `out.raw.fillPaints` 에서
  분리되면 *호환성 변경* — 한 객체에 raw + alias 가 동시 존재해야 SDD 의
  "spec 부터 검증" 이 가능. 분리 시 mutation 충돌 (`out.fills` vs `out.raw.fillPaints`)
  도 명확.
- **`raw` 의 deep-clone 비용?** 메타리치 35K 노드 기준 ~1.5초. 본 spec 의
  결정 = 항상 deep-clone (안전 우선). 향후 raw 사용처가 read-only 임이
  검증되면 shallow alias 로 최적화 가능 — 그 전엔 deep-clone 유지.
