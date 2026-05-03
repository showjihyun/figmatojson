# spec/json-repack-codec

| 항목 | 값 |
|---|---|
| 상태 | Draft — awaiting trigger (활성 버그 없음, round-13 scope 에서 제외) |
| Trigger | 새 round-trip 태그 추가가 필요한 PR 의 *첫 단계* 로 진행. 그때까지는 ADR-2 + `test/e2e.test.ts` 의 `repack json mode` gate 가 충분. |
| 구현 | `src/jsonRepackCodec.ts` (new) |
| 테스트 | `src/jsonRepackCodec.test.ts` (new — encode/decode round-trip 단위 테스트), `test/e2e.test.ts` 의 `repack json mode` (기존 — 회귀 가드) |
| 형제 | `docs/adr/0002-roundtrip-equality-tiers.md` (lossy mode 금지) |

## 1. 목적

ADR-0002 가 명시한 contract — "JSON Repack 의 encode (`roundTripReplacer` in `src/intermediate.ts`) 와 decode (`reviveBinary` in `src/repack.ts`) 의 두 절반은 *함께* 움직여야 한다" — 이 현재 *문서 규약* 일 뿐, *구조적 보장* 이 아니다. 두 함수가 두 파일에 흩어져 있어:

- 새 round-trip 태그 (e.g. `__date` for ISO timestamps) 추가 시 두 파일을 동기화해야 함. 한쪽만 수정해도 컴파일 에러 없음. 실패 모드는 *조용한 데이터 손실* — ADR-0002 가 명시적으로 금지하는 결과.
- Codec 의 *전체 동작* 은 이미 wide (encode/decode 양쪽이 full `JSON.stringify`/`JSON.parse` 를 소유) — `intermediate.ts:347` 와 `repack.ts:277`. **정작 빠진 것은 한 모듈 owner**.

본 spec 은 두 함수를 한 파일로 모아 contract 를 구조화한다. 동작 변경 0, 위치 변경만.

## 2. Interface

```ts
// src/jsonRepackCodec.ts
export function encodeMessage(data: unknown, opts?: { minify?: boolean }): string;
export function decodeMessage(text: string): unknown;

// 단위 테스트 / 디버깅용으로 raw 형태도 노출
export const TAGS = { bytes: '__bytes', num: '__num', bigint: '__bigint' } as const;
```

호출자가 알아야 할 것은 `encodeMessage` / `decodeMessage` 두 함수와 `TAGS` 상수. JSON 자체 (replacer / reviver, `JSON.stringify` / `JSON.parse`) 는 codec 내부.

## 3. Invariants

- I-1 `encodeMessage(decodeMessage(x))` 와 `decodeMessage(encodeMessage(x))` 가 lossless — 모든 round-trip 가능 타입 (Uint8Array, bigint, NaN/±Infinity) 이 보존됨.
- I-2 `TAGS` 의 string 값 (`"__bytes"`, `"__num"`, `"__bigint"`) 은 외부에서 변경되지 않는 frozen const. 레이블 변경은 **breaking** — 이전 message.json 파일이 더 이상 decode 되지 않음.
- I-3 새 태그 추가 = `TAGS` 에 한 entry 추가 + `encodeMessage` 의 replacer 에 한 case 추가 + `decodeMessage` 의 reviver 에 한 case 추가. 셋 다 한 파일 안. 한 변경에 빠진 case 가 있으면 단위 테스트 (`jsonRepackCodec.test.ts`) 에서 즉시 발견.
- I-4 인덴테이션 정책: `opts.minify === true` 면 indent 없음, 아니면 2 space (현행 동작 유지). I-1 의 round-trip 보존은 minify 와 무관.
- I-5 reviver 의 일반 object/array/scalar 통과 동작 — `__bytes` 등 magic key 가 *없는* object 는 그대로 통과. 기존 `reviveBinary` 의 fallback 동작 보존.

## 4. 호출자 변경

### 4.1 `src/intermediate.ts`

- 현재 `roundTripReplacer` 함수 (line 353+) 와 `writeJsonRoundTrip` (line 341-351) — 둘 다 codec 으로 위임.
- 변경 후:
  ```ts
  import { encodeMessage } from './jsonRepackCodec.js';
  function writeJsonRoundTrip(path, data, minify) {
    const text = encodeMessage(data, { minify });
    writeFileSync(path, new TextEncoder().encode(text));
    return { path, bytes: text.length };
  }
  ```
- `roundTripReplacer` 함수 자체는 삭제 — codec 내부로 흡수.

### 4.2 `src/repack.ts`

- 현재 `reviveBinary` (line 312+) 와 `JSON.parse(text, (_k, v) => reviveBinary(v))` (line 277) — 둘 다 codec 으로 위임.
- 변경 후:
  ```ts
  import { decodeMessage } from './jsonRepackCodec.js';
  const message = decodeMessage(messageJsonText) as Record<string, unknown>;
  ```
- `reviveBinary` 함수 자체는 삭제 — codec 내부로 흡수.

## 5. Tests

### 5.1 새 위치

`src/jsonRepackCodec.test.ts` (vitest, 새 파일):

- Round-trip Uint8Array (binary blob)
- Round-trip bigint (kiwi version field 등)
- Round-trip NaN / Infinity / -Infinity
- 일반 object/array/scalar 통과 (시그니처 회귀)
- minify on/off 결과 비교 + 둘 다 같은 decode 결과
- 알 수 없는 태그 (`__foo`) 가 일반 object 로 처리되는지

### 5.2 회귀 가드

- `test/e2e.test.ts` 의 `repack json mode` 테스트 — 변경 없이 통과해야 함. 외부 동작 동일.

## 6. 마이그레이션 순서

1. `src/jsonRepackCodec.ts` 생성 — encode/decode/TAGS 구현 + 단위 테스트 작성.
2. `src/intermediate.ts` 의 호출자 변경, `roundTripReplacer` 삭제. `npm test` 통과 확인.
3. `src/repack.ts` 의 호출자 변경, `reviveBinary` 삭제. `npm test` 통과 확인.

세 단계 모두 한 PR 가능 (~30 줄 이동 + 단위 테스트 추가). 실패 위험 거의 없음 — `repack json mode` e2e 테스트가 회귀 즉시 발견.

## 7. ADR-0002 와의 관계

본 spec 은 ADR-0002 의 invariant 를 **취소하지 않음** — 오히려 enforce. ADR-0002 가 "두 절반이 함께 움직여야 한다" 라는 *규약* 을 선언했고, 본 spec 은 그 규약을 한 모듈 안의 *구조* 로 변환해 **두 절반이 함께 움직일 수밖에 없게** 만든다. ADR-0002 는 그대로 유효, 본 spec 의 codec 모듈이 그 enforcement 메커니즘.

## 8. 비대상

- **Wire format 변경 (JSON → MessagePack 등)** — 본 spec 은 JSON 한정. 다른 wire format 이 필요해지면 별도 spec.
- **encode/decode 의 type-safe API** — 입력 / 출력 모두 `unknown`. 타입 안전한 입출력은 호출자 책임. (현행과 동일.)
- **Streaming encode/decode** — 메시지 전체를 한 번에 처리. 큰 파일에서 메모리 압박이 발생하면 별도.
- **ADR-0002 가 금지하는 lossy 모드 도입** — 영구 비대상.
