# spec/vector-decode

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `src/vector.ts` (`extractVectors`, `decodeCommandsBlob`, `parseVectorNetworkBlob`, `vectorNetworkToPath`) |
| 테스트 | `test/vector*.test.ts` (있는 항목) — 본 spec 의 cmd opcode 매핑 / offset fallback / VN region 디코드 단위 |
| 형제 | `SPEC.md §Stage 7` (파이프라인 위치), `SPEC-figma-to-pencil.md` (pen-export 가 사용하는 path 출력 계약) |

## 1. 목적

`.fig` 의 vector 노드는 path geometry 를 두 가지 별개 바이너리 포맷으로
보유한다 — `commandsBlob` (per-fill/stroke geometry) 와 `vectorNetworkBlob`
(노드 전체의 path graph). 둘 다 schema 의 blob 인덱스로만 참조되고 wire
포맷 자체는 schema 에 노출되지 않는다. 본 spec 은 두 디코더의 **opcode 매핑,
offset fallback, error 처리, SVG 출력 계약** 을 source of truth 로 못 박는다.

CLI Stage 7 (`extractVectors`) 와 pen-export 의 vectorPathMap 모두 이 코드를
공유하므로 한 디코더의 변경이 두 출력에 동시에 영향을 준다.

## 2. 적용 대상 노드

- I-N1 vector 추출 대상 type:
  `VECTOR / STAR / LINE / ELLIPSE / REGULAR_POLYGON / BOOLEAN_OPERATION /
  ROUNDED_RECTANGLE`. 그 외 type 은 본 spec 비대상 (그리기 자체를 reduce-to-Pen
  단계에서 다른 경로로 처리).
- I-N2 위 type 의 노드라도 `fillGeometry` / `strokeGeometry` / `vectorData.vectorNetworkBlob`
  중 어느 것도 갖지 않으면 결과의 `error = 'no fill/stroke geometry'` 로
  반환하고 svg 는 미생성. **에러는 throw 안 함** — 95% 성공률 보장의 전제.
- I-N3 `BOOLEAN_OPERATION` 은 본 디코더가 path 만 추출 — boolean 연산
  (UNION/INTERSECT/SUBTRACT/EXCLUDE) 자체는 *비대상* (현재 구현 5% 의 출처).
  결과 svg 는 자식 path 들의 단순 union 이며 정확하지 않을 수 있음.

## 3. `commandsBlob` 디코더

per-geometry 바이너리. 각 fill/stroke geometry 가 자신의 blob 인덱스를
들고 있고, 디코더는 byte stream 을 SVG path 명령으로 변환한다.

### 3.1 Opcode 매핑

- I-C1 1-byte opcode + 페이로드 형식. 모든 float 는 **little-endian f32**.
  정수는 LE u32 (해당하는 cmd 없음, opcode 자체가 u8).

| opcode | 명령 | 페이로드 (bytes) | SVG mnemonic |
|---|---|---|---|
| `0x00` | NO-OP / subpath separator | 0 | (skip) |
| `0x01` | MOVE_TO | 8 (x, y) | `M` |
| `0x02` | LINE_TO | 8 (x, y) | `L` |
| `0x03` | QUAD_TO | 16 (cx, cy, x, y) | `Q` |
| `0x04` | CUBIC_TO | 24 (c1x, c1y, c2x, c2y, x, y) | `C` |
| `0x05` | CLOSE | 0 | `Z` |

- I-C2 **`0x03`/`0x04` 의 의미는 swap 되어 있지 않다** — 0x03 = quadratic,
  0x04 = cubic. 이 매핑은 round-trip 검증으로 못 박은 사실 (이전 구현이 두
  cmd 를 뒤바꿨다가 아이콘 곡선이 깨진 적 있음). 변경 시 vector regression
  발생.
- I-C3 알 수 없는 opcode 만나면 디코드 *중단* (throw 아님): 그 시점까지
  누적된 path 를 살리고, `error = "unknown cmd 0x?? at offset N/M"` 마킹.
  이걸 trailing metadata 로 간주하는 게 핵심 — 일부 blob 이 실제로 path
  뒤에 winding flag 같은 부속 데이터를 carry 한다.
- I-C4 페이로드 truncation (남은 bytes < 페이로드 size) 도 동일 — 누적
  path 보존 + error 마킹 + 즉시 종료.

### 3.2 Offset fallback

- I-C5 일부 blob 은 첫 1 byte 가 winding flag (또는 미분류 헤더) 로 추정,
  그 뒤에 opcode stream 이 시작. 디코더는 `startOffset ∈ {0, 1}` 두 시도를
  모두 돌려 **`commandCount` 가 더 큰 쪽** 을 채택.
- I-C6 동률이면 `startOffset` 작은 쪽 우선 (= 0). i.e. blob 이 정상 cmd
  로 시작하면 offset 0 이 항상 이긴다.
- I-C7 두 시도 모두 0개 명령이거나 path 가 빈 문자열이면 throw —
  `decodeCommandsBlob` 의 유일한 throw 케이스. 호출자 (`tryExtract`) 는
  이 throw 를 catch 해서 `result.errors[]` 에 기록하고 다음 geometry 로
  진행.

### 3.3 Float 직렬화

- I-C8 디코드된 float32 는 `Number.toString()` 으로 직렬화 (정밀도 손실
  없음). `toFixed(N)` 사용 금지 — 이전 구현이 5자리 절단을 하다가
  absolute → relative 변환 단계에서 마지막 자리 drift 가 발생한 적 있음.
- I-C9 SVG 출력 후처리 (`absoluteToRelative` 등) 가 필요하면 그 단계에서
  반올림. 본 디코더는 항상 **무손실 직렬화**.

### 3.4 SVG 출력

- I-C10 `tryExtract` 의 출력은 `<svg viewBox="0 0 W H" width=W height=H>`
  + per-geometry `<path>` 들. `W/H = data.size.{x,y}` (없으면 100 fallback).
- I-C11 fill geometry: `<path d="…" fill="…" fill-rule="…"/>`. fill-rule
  은 `windingRule === 'ODD' ? 'evenodd' : 'nonzero'` (default nonzero).
- I-C12 stroke geometry: `<path d="…" fill="none" stroke="…" stroke-width="N"/>`.
- I-C13 fill / stroke color: `data.fillPaints[0]` / `data.strokePaints[0]`
  중 첫 번째 visible SOLID. 없으면 `currentColor`. gradient / image paint
  는 *비대상* (Stage 7 best-effort).
- I-C14 stroke-width: `data.strokeWeight` 가 양수면 그대로, 아니면 1.

## 4. `vectorNetworkBlob` 디코더

vector 노드의 *그래프* 표현 — vertices + segments + regions. pen-export
가 path 의 진짜 source 로 사용 (pencil.dev v1.1.55 `parseVectorNetworkBlob`
와 binary-compatible 으로 reverse-engineered).

### 4.1 Wire format

- I-V1 헤더 (12B, LE u32): `vertexCount`, `segmentCount`, `regionCount`.
- I-V2 vertex (12B × N): `styleID:u32, x:f32, y:f32`.
- I-V3 segment (28B × M):
  `styleID:u32, start.{vertex:u32, dx:f32, dy:f32}, end.{vertex:u32, dx:f32, dy:f32}`.
  `dx/dy` 는 **vertex 좌표를 기준으로 한 control-point delta** (절대 좌표
  아님). cubic Bézier 의 컨트롤 포인트는 `vertex + (dx, dy)`.
- I-V4 region (가변 길이):
  - packed `u32`: 최하위 비트 = winding (`1 = NONZERO`, `0 = ODD`),
    상위 비트 = `styleID` (>> 1).
  - `loopCount:u32`, 그리고 loop 별로 `segmentCount:u32 + indices:u32 × N`.
- I-V5 길이 검증: 한 번이라도 남은 bytes 가 다음 record 보다 작으면
  파서는 `null` 반환 (throw 아님). vertex / segment 인덱스가
  `vertexCount` / `segmentCount` 범위를 벗어나도 `null`.
- I-V6 `bytes.length < 12` 면 즉시 `null` (헤더도 못 채움).

### 4.2 SVG path 변환

- I-V7 region 이 1개 이상이면: 각 region 의 각 loop 의 segment 인덱스를
  `vn.segments` 로 풀고 `orientSegments` 로 endpoint chain 정렬 후
  `buildPathFromSegments` 로 직렬화. 여러 loop / region 의 path 는
  공백 join — fill-rule 은 region 의 windingRule 이 결정 (호출자 책임).
- I-V7a **Region + orphan 합성**: region 이 1개 이상인 경우라도 *어느
  region/loop 에도 포함되지 않은 segments* (= "orphan stroke-only
  segments") 가 존재하면 그 segments 도 region path 뒤에 별도 sub-path
  로 emit 한다. 이는 figma 의 한 vector 노드가 *동시에* fill-region
  (점·도형) 과 stroke-only line (선) 을 carry 하는 흔한 케이스를 다룬다.
  HPAI 700:319 ("data-01 / Icon") 의 22 segments 중 6 개가 정확히 이
  분기에 해당 — region 4개가 점을 그리고, orphan 6개가 선을 그린다.
  이전 구현 (round 11 까지) 은 region 만 emit 해서 line 이 통째로 누락.
  - orphan segments 는 `orientSegments` 를 *통하지 않고* 원본 인덱스 순서
    그대로 `buildPathFromSegments` 호출. 이유: orphan 은 disconnected
    line 모음일 가능성이 크고, 그럴 때 orientSegments 의 "이전 endpoint
    매칭으로 뒤집기" 가 거짓 뒤집기를 만든다. `buildPathFromSegments`
    는 connected 가 아닐 때 자동으로 새 `M` subpath 시작 — 따라서 orient
    없이도 각 line 이 정확히 그려진다.
  - fill-rule 은 region path 에만 의미가 있고 orphan 은 stroke-only.
    호출자가 fill-rule 을 region 단위로 적용하든 path 전체로 적용하든
    orphan segments 는 fill 로 그려지지 않는다 (closing Z 가 없거나
    open chain).
- I-V8 region 이 0개면 stroke-only / line: 모든 segment 를 한 path 로
  단일 호출. segments 도 0개면 빈 문자열.
- I-V9 segment chain orientation (`orientSegments`):
  1. 첫 segment 의 `end.vertex` 가 다음 segment 의 어느 endpoint 와도
     일치하지 않으면 첫 segment 를 뒤집음 (`reverseSegment` 가
     start/end 의 vertex/dx/dy 모두 swap).
  2. 그 뒤 i ≥ 1 에서 `prev.end.vertex !== curr.start.vertex` 이면 curr
     뒤집음.
  3. **In-place mutation 금지**: input segments 를 deep-copy 하고 그
     copy 만 mutate. 원본은 `vn.segments` 의 공유 reference 이므로 다른
     region/loop 가 같은 segment 를 다른 방향으로 쓸 수 있음.
- I-V10 segment → path 명령:
  - 양쪽 tangent 가 모두 0 (`start.dx == 0 && start.dy == 0 && end.dx == 0 && end.dy == 0`)
    이면 `L b.x b.y` (직선).
  - 그 외 cubic: `C (a.x+sd.dx) (a.y+sd.dy) (b.x+ed.dx) (b.y+ed.dy) b.x b.y`.
  - subpath 시작 (직전 endpoint != current start) 이면 `M a.x a.y` 선행.
  - subpath 가 startVertex 로 돌아오면 `Z` 추가 + lastVertex 리셋.
- I-V11 float 직렬화는 §3.3 와 동일 (`Number.toString()`, 정밀도 손실 없음).

## 5. Error policy

- I-E1 `extractVectors` / `tryExtract` 는 **never throw** (입력 트리가 null
  인 경우 외). 디코드 실패는 `result.error` 문자열로 전파. CLI 가 95%
  성공률을 광고할 수 있는 근거.
- I-E2 `decodeCommandsBlob` 만 빈 결과일 때 throw (§I-C7). 호출자가 다음
  geometry 로 넘어가는 hook.
- I-E3 `parseVectorNetworkBlob` 는 throw 안 함 — 잘못된 wire 는 `null`
  반환. 호출자 (pen-export) 가 fallback 으로 `commandsBlob` 디코더로
  내려가는 경로 보장.
- I-E4 blob 인덱스 미존재 (`blobs[idx]?.bytes` falsy) 는 errors 배열에
  `blob[idx] missing` 으로 push 하고 다음 geometry 진행. node-level
  하드 실패 안 함.

## 6. 비대상

- ❌ Boolean 연산 결과의 정확한 path 합성 (UNION/SUBTRACT 등). `BOOLEAN_OPERATION`
  은 자식 path 의 단순 concat 만 — 5% 미해석의 주된 원인.
- ❌ gradient / image paint 의 SVG 출력 — solid color 만 (§I-C13).
- ❌ stroke align (CENTER/INSIDE/OUTSIDE), stroke cap/join 등 stroke 스타일
  세부 — 본 spec 은 path geometry 만. stroke 스타일은 pen-export 측 spec.
- ❌ `fillGeometry[].styleID` 의 자세한 의미 (style 테이블 참조 추정).
  현재는 path 추출에만 사용.
- ❌ vectorNetworkBlob 의 `region.styleID` 사용 — pen-export 가 별도 경로로
  처리. 본 디코더는 path 출력만.
- ❌ TextNode 의 vector 데이터 — type 이 VECTOR_TYPES 에 없으므로 본 spec
  대상 외. text glyph path 는 별도 처리.

## 7. Resolved questions

- **왜 commandsBlob 와 vectorNetworkBlob 가 둘 다 있나?** Figma 가 paint /
  rendering 용으로 pre-flattened path (commandsBlob) 와 editing 용 graph
  (vectorNetworkBlob) 를 둘 다 carry 하는 것으로 보임. Pencil 은 후자를
  진짜 source 로 사용 — 우리도 pen-export 가 가능하면 vectorNetworkBlob,
  fallback 으로 commandsBlob 을 쓴다.
- **왜 0x03/0x04 swap 사실을 spec 에 명시하나?** opcode 매핑은 wire format
  의 contract 이고, 외부 reverse-engineering 자료에서 두 opcode 의 의미가
  swap 된 채로 적힌 경우가 있음. 본 spec 이 round-trip 검증과 함께
  authoritative.
- **NO-OP `0x00` 의 정체?** 명확하지 않음 — subpath separator 또는 unset
  field 의 default 로 보임. 안전한 처리는 *skip*.
