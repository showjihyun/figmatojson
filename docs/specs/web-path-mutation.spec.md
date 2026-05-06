# spec/web-path-mutation

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/path.ts` (`tokenizePath`, `setPath`, `getPath`) |
| 테스트 | `web/core/domain/path.test.ts` (현재 부재 — 본 spec 추가 후 단위 테스트 권장) |
| 형제 | `web-edit-node.spec.md` (PATCH endpoint 사용처), `web-chat-leaf-tools.spec.md` (AI tool dispatcher 사용처), `web-undo-redo.spec.md` (EditJournal 의 pre-state capture) |

## 1. 목적

Document 트리 안의 *깊게 nested 된 필드* 를 한 wire-format string 으로
addressable 하게 만든다. 같은 syntax 가 세 다른 consumer 에서 사용되어야
서로의 호환성이 깨지지 않는다:

- **PATCH endpoint** (`POST /api/doc/:id/edit`): client 가 보낸 path 문자열
  로 트리의 한 leaf 만 mutate.
- **Inspector** (debounced 입력 patcher): 사용자가 hex 입력 박스에 타이핑
  하면 `fillPaints[0].color.r` 같은 path 로 PATCH 호출.
- **AI tool dispatcher** (`InProcessTools` / `applyTool`): LLM 이 emit 하는
  tool call 의 인자에 path 가 들어옴.

본 spec 은 path 의 *syntax, tokenize 룰, walk 정책, mutation semantics* 를
single source 로 둔다. 변경 시 세 consumer 모두 영향.

## 2. Path syntax

```
path := segment ( "." segment | "[" index "]" )*
segment := /[^.\[\]]+/      // dot 와 bracket 미포함 문자열
index := /[0-9]+/           // 정수만, sign 미허용
```

- I-S1 `segment` 는 dot/bracket 외 모든 문자 허용 (Korean / 공백 / 특수문자
  포함). UI 에서 사용자 입력은 식별자에 한정되지만 wire 자체는 유연.
- I-S2 `index` 는 *정수* — float / 음수 / hex 미허용. 정규식 `\d+` 가 강제.
- I-S3 segment 와 index 의 *순서 무관* — `a.b[0].c[1].d` 처럼 자유 결합.
- I-S4 빈 path (빈 문자열) → 빈 token 배열 → `setPath` / `getPath` 가 root
  을 가리킴 (mutation 은 leaf 가 없으므로 사실상 no-op, getPath 는 root
  반환). syntactically 합법.

## 3. `tokenizePath(path)` — string → Token[]

```ts
type PathToken = string | number;
function tokenizePath(path: string): PathToken[];
```

- I-T1 정규식 `/([^.\[\]]+)|\[(\d+)\]/g` 로 한 번 sweep — segment 또는
  bracketed index 매칭.
- I-T2 segment 매칭은 `string` token, bracketed index 매칭은 `parseInt(.., 10)`
  으로 `number` token. type 이 분기 — 호출자가 typeof 로 segment/index
  구분 가능.
- I-T3 *unmatched 부분은 무시*. `"a..b"` (연속 dot), `"a.[0]"` (dot 직전
  bracket), `"["` (incomplete bracket) 모두 partial 토큰만 emit, throw 안 함.
- I-T4 결정성: 같은 입력 → 같은 token 배열. 결과 길이가 0 일 수 있음 (전체
  unmatched). 호출자가 빈 배열을 *root* 또는 *invalid* 로 해석할지 책임.
- I-T5 IO 없음 / framework 의존 없음. 순수 함수.

## 4. `setPath(obj, tokens, value)` — leaf write

```ts
function setPath(
  obj: Record<string, unknown> | unknown[],
  tokens: PathToken[],
  value: unknown,
): boolean;
```

- I-W1 `tokens.length === 0` → no-op, `true` 반환. (path 가 root 이라 leaf
  미정의 — 의도한 변경 없이 통과.)
- I-W2 walk 룰: 인덱스 `i ∈ [0, tokens.length - 1)` 마다:
  1. `cur[tokens[i]]` 가 `null` 이거나 `undefined` 이면 *intermediate 자동
     생성*: 다음 토큰이 `number` 이면 `[]`, `string` 이면 `{}`.
  2. `cur = cur[tokens[i]]` 로 한 단계 내려감.
  3. **타입 검증 안 함** — `cur` 이 array 인데 다음 토큰이 string 이거나,
     scalar 인데 다음이 array 인 경우, JS native 동작에 위임 (대개 silently
     property 추가 또는 NaN). 본 함수는 path 의 wire format 을 검증하는
     자리가 아니다.
- I-W3 leaf 쓰기: `cur[tokens[last]] = value`. value 의 타입 검증 안 함.
- I-W4 mutation 은 *in-place* — 입력 `obj` 가 바뀐다. 호출자가 immutability
  필요하면 호출 전에 deep-copy.
- I-W5 반환값 `true` 는 항상. boolean 시그니처는 legacy compatibility 유지
  목적이고, 향후 검증이 추가되어 `false` 를 emit 할 가능성 보존.
- I-W6 새 필드 도입 케이스: `setPath({}, ['a', 'b', 'c'], 1)` → `{ a: { b: { c: 1 } } }`.
  사용자가 *지금 처음 등장하는 필드* 에 PATCH 해도 silent 성공.

## 5. `getPath(obj, tokens)` — leaf read

```ts
function getPath(obj: unknown, tokens: PathToken[]): unknown;
```

- I-R1 walk: 각 토큰마다 `cur = cur[tok]`, `cur` 이 `null/undefined` 이거나
  non-object 이면 즉시 `undefined` 반환.
- I-R2 missing intermediate → `undefined`. 호출자가 *"필드 부재"* 로 해석.
- I-R3 EditJournal 의 pre-mutation snapshot 이 `getPath(obj, tokens)` 를
  사용 — 새 필드 도입 case 에서 pre-state 가 `undefined` 로 기록됨이 정상
  (undo 시 그 필드를 *제거* 해야 함을 의미).
- I-R4 setPath 와 다르게 intermediate 자동 생성 없음 — read 가 write 의
  side effect 를 가지면 안 됨.

## 6. Wire format 호환성 — 3 consumer 의 공유 약속

| consumer | 입력 form | 책임 |
|---|---|---|
| **PATCH `/api/doc/:id/edit`** | request body `{ id, path, value }` | server 가 `tokenizePath(path)` → `setPath(node, tokens, value)` |
| **Inspector debounced patcher** | `<input>` 의 onChange → service 함수 호출 시 path 인자 | client 가 path 문자열 build, server 로 PATCH 송신 |
| **AI tool dispatcher** | LLM 이 emit 하는 tool call args.path | dispatcher 가 sanitize 없이 `tokenizePath` 후 사용 |

- I-C1 세 consumer 모두 *동일 path 문자열* 을 wire 에 사용. client 가 build
  한 path 와 server 가 받은 path 가 1:1 동일해야 한다.
- I-C2 client 측 path build helper 는 본 spec 의 syntax 를 따른다 — segment
  dot-join, array index bracket. 다른 표기 (slash 분리 / JSON Pointer / dot
  만) 는 비호환.
- I-C3 LLM 이 잘못된 syntax 를 emit 해도 dispatcher 는 *throw 안 함* — `tokenizePath`
  가 partial 결과만 emit, `setPath` 가 빈 / 잘못된 leaf 에 silent assign.
  LLM 의 자가 회복은 *사후 결과 확인* 으로 (path 가 적용되었는지 GET 으로
  re-read).

## 7. Mutation safety

- I-M1 본 helper 는 *security boundary 가 아니다*. PATCH endpoint 가 받는
  path 는 server 가 신뢰한 client 의 input — public API 가 되면 prototype
  pollution (`__proto__`, `constructor.prototype`) 검증 필요. 현재는
  내부 use 만 가정.
- I-M2 path 가 INSTANCE 의 `_renderChildren` 아래를 가리키는 mutation 은
  next reload 시 손실 — `_renderChildren` 은 master + override 로 재계산
  되는 *derived* 필드. mutation 도구는 master 또는 override 자체를 변경
  해야 영구적 (`web-instance-pipeline.spec.md §1` 참조).
- I-M3 fields 의 *type drift* 가능: setPath 가 원본 `string` 자리에 `number`
  를 쓰면 그대로 들어감. 호출자가 wire format 의 의미를 *알고* 사용해야 함
  — wire 자체에 type schema 가 묶여있지 않다.

## 8. 비대상

- ❌ **JSON Pointer (RFC 6901) 호환** — `~0`/`~1` escape 룰 없음. 본 spec
  의 syntax 는 dot/bracket 기반 *legacy* 형식.
- ❌ **negative index 또는 `[-1]` 같은 last-element shortcut**. index 는
  `\d+` 만.
- ❌ **wildcard / glob path** (`fillPaints[*].color`). single-leaf mutation
  만.
- ❌ **다중 mutation atomicity**. setPath 한 번에 한 leaf. 여러 leaf 를
  atomic 으로 변경하려면 호출자가 사전 lock + 일괄 호출 후 commit (현재
  구현은 single-threaded JS 라 race 없음, 그러나 partial 실패 시 rollback
  안 함).
- ❌ **path schema 검증** — 잘못된 path 도 silent — 호출자가 알고 사용.
  wire 에 schema 첨부는 별도 layer.
- ❌ **prototype pollution 방어** — §I-M1 참조.

## 9. Resolved questions

- **왜 segment 와 index 를 token type 으로 구분하나?** `setPath` 가
  intermediate 자동 생성 시 `[]` vs `{}` 를 *다음 token type* 으로 결정
  (I-W2). string 으로 통일하면 `"0"` 인덱스가 object 키로 오해됨.
- **`tokenizePath` 가 partial 입력에 throw 안 하는 이유?** Inspector 의 hex
  입력처럼 *typing 중* 인 path 가 잠깐 invalid 일 수 있음 — debounced patcher
  가 그 사이 PATCH 를 보내도 안전하게 silent 처리 가 ergonomic.
- **`getPath` 가 setPath 와 시그니처가 다른 이유?** getPath 는 임의 `unknown`
  을 받는다 — DocumentNode 의 자손은 `unknown` 으로 typed 되어 있고, 매
  level 의 type 검사 없이 walk. setPath 는 *root 가 항상 object/array* 라는
  좀 더 강한 contract — caller 가 root 부터 mutation 시작.
- **boolean 반환을 왜 유지?** 향후 검증 추가 시 (path schema enforcement,
  protected key blocklist) `false` 로 reject signal 을 emit 할 수 있는 자리.
  현재는 `true` 만. legacy compatibility.
