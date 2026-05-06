# spec/asset-walk

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `src/assets.ts` (`detectImageExt`, `hashToHex`, `collectImageRefs`, `walkValue`) |
| 테스트 | `test/assets.test.ts` (있는 한도 내) — magic 매핑 + walk 패턴 + Uint8Array 변환 단위 |
| 형제 | `SPEC.md §Stage 6` (CLI 파이프라인 source), `PRD.md §1.2.4` (실측 magic 검증), `verification-report.spec.md §V-04` (이미지 일관성 검증의 입력) |

## 1. 목적

CLI Stage 6 — `.fig` 컨테이너의 `images/<sha1>` (확장자 없는 binary) 와 노드
트리의 `imageRef` 사이를 *양방향* 매핑. 두 sub-task:

1. **확장자 추론** (`detectImageExt`): magic byte 8 개로 PNG/JPEG/GIF/PDF/WebP/SVG
   분류. Figma 가 wire 에 mime-type 을 carry 하지 않으므로 우리 측이 추론
   해야 디스크에 ext 붙여 저장 가능.
2. **트리 walk** (`collectImageRefs`): 노드 데이터의 *어느 위치* 에 image
   hash 가 등장할 수 있는지 패턴 매칭. 결과는 `Map<hash, Set<owner-guid>>`
   — 어떤 이미지가 어떤 노드에서 사용되는지의 인벤토리.

본 spec 은 두 룰의 *입력 형태 / 매핑 / fallback / 결정성* 을 source 로
둔다.

## 2. `detectImageExt(buf)` — magic byte → 확장자

### 2.1 매핑 표

| 확장자 | Magic bytes (offset 0 from buf) | 비고 |
|---|---|---|
| `png` | `89 50 4e 47 0d 0a 1a 0a` (8B) | PNG signature 표준 |
| `jpg` | `ff d8 ff` (3B) | JPEG SOI marker (그 뒤 segment 별 다름) |
| `gif` | `47 49 46 38` (4B "GIF8") | GIF87a 또는 GIF89a 모두 매칭 |
| `pdf` | `25 50 44 46` (4B "%PDF") | PDF header |
| `webp` | RIFF wrapper at offset 0-11: `52 49 46 46 ?? ?? ?? ?? 57 45 42 50` | offset 0-3 = "RIFF", 8-11 = "WEBP", 4-7 은 size (variable) |
| `svg` | 첫 16 byte 안에 `<?xml` 또는 `<svg` (case-insensitive) | text-based — magic 아닌 prefix matching |
| `bin` | (위 어느 것도 매칭 안 됨) | fallback |

- I-X1 *우선순위*: WebP → SVG → MAGICS 순. WebP 가 RIFF prefix 검사를 먼저
  통과하지 않으면 다른 매핑이 잘못 잡을 수 있어 가장 먼저.
- I-X2 SVG 는 *string prefix matching* — `String.fromCharCode(...buf.slice(0, 16))`
  → `/^\s*<\?xml/.test(...)` 또는 `/^\s*<svg/i.test(...)`. 다른 항목과
  다른 검사 방식.
- I-X3 *binary detection 만* — text encoding (UTF-8 vs UTF-16) 검출 안 함.
  SVG 가 UTF-16 BOM 으로 시작하면 매칭 실패 → fallback 'bin'. wire 에서
  발견 안 됨.
- I-X4 fallback `'bin'` — 알 수 없는 형식. 디스크에 `<hash>.bin` 으로 저장.
  사용자가 사후 검사 가능.

### 2.2 입력 검사

- I-X5 `buf.length < 4` → 즉시 `'bin'` 반환 (PNG/JPG/GIF/PDF magic 의 최단
  길이가 4B).
- I-X6 `buf.length < 12` → WebP 검사 skip. PNG/JPG/GIF/PDF/SVG 만 시도.
- I-X7 SVG 의 prefix slice 길이는 `min(buf.length, 16)`. 짧은 buffer 도
  안전.

### 2.3 결정성

- I-X8 같은 buffer → 같은 ext. 무작위성 없음.
- I-X9 magic 검사는 *short-circuit* — 첫 매칭에서 즉시 반환. 매핑 표의
  순서가 결과를 결정 (PNG 이 JPG 보다 먼저 — 충돌 가능성 0).
- I-X10 throw 안 함. 모든 입력에 대해 string 반환.

## 3. `hashToHex(hash)` — Uint8Array → hex string

`assets.spec` 의 책임이지만 다른 모듈 (`normalize.ts`, AI tools) 도 사용 →
*single source* 가 본 함수.

- I-H1 입력 `null` / `undefined` / 변환 불가능한 타입 → `null` 반환.
- I-H2 `string` 입력 → `.toLowerCase()` 적용 후 반환 (이미 hex 가정, case
  변동만 정규화).
- I-H3 `Uint8Array` 입력 → `Buffer.from(hash.buffer, byteOffset, byteLength).toString('hex')`.
  *zero-copy view* — 새 byte 할당 없음 (V8 native fast path).
- I-H4 결과는 *항상 lowercase hex* — 뒤에서 정규화 비용 0. wire 의 case
  variation 흡수.
- I-H5 빈 array → `""` (빈 문자열). null 이 아님.
- I-H6 결정성: 같은 buffer → 같은 hex. byte order 보존.

### 3.1 비-Buffer 환경

- I-H7 `Buffer` 는 Node-only. 브라우저에서 호출 시 `ReferenceError`. 본
  helper 는 *server-side* 만 — `web/core/domain/messageJson.ts:reviveBinary`
  와 같은 정책.

## 4. `collectImageRefs(root)` — 트리 walk

노드 트리 전체를 재귀 walk 하여 image hash 등장 위치를 수집.

### 4.1 시그니처와 반환

```ts
function collectImageRefs(root: TreeNode | null): Map<string, Set<string>>;
```

- I-W1 키 = lowercase hex hash. 값 = 그 hash 를 carry 하는 노드의 `guidStr`
  Set.
- I-W2 `root === null` → 빈 Map 반환 (throw 안 함).
- I-W3 *그 노드 자신과 모든 자손* 을 walk — sibling 은 부모 walk 가 별도
  진입.

### 4.2 매칭 패턴

`walkValue(value, ownerGuid, refs)` 가 노드 데이터의 *모든 nested 값* 에
대해 다음 패턴을 순서대로 검사:

- I-W4 `value.image.hash` (nested object): `image` 가 object 이고 `hash`
  필드가 있으면 → `addRef(refs, hashToHex(image.hash), ownerGuid)`. 가장
  흔한 패턴 (rectangle / FRAME 의 imageFill).
- I-W5 `value.hash` (직접 필드): 본 value 가 자체로 `hash: Uint8Array | string`
  필드를 carry → ref 추가. Image 메시지 객체 등에서 등장.
- I-W6 `value.imageRef` (REST API 호환 명명): `imageRef: string` → 그대로
  lowercase 후 ref 추가. 우리 normalize 출력의 alias 와 호환.
- I-W7 위 3 패턴 검사 후 *그래도 모든 자식 walk 진행* — 같은 객체에 여러
  패턴 동시 매칭 시 모두 ref 추가.

### 4.3 Walk 룰

- I-W8 `value === null || undefined` → return (skip).
- I-W9 `typeof value !== 'object'` → return (primitive, hash 의 source
  될 수 없음).
- I-W10 `Uint8Array` → return (binary leaf, walk 종결). image bytes 는 별도
  blob array 가 carry.
- I-W11 `Array` → `for...i` 루프로 각 element 재귀 walk. element 가 string
  이어도 W3 의 `imageRef` 매칭은 *object level* 에서만 — array 의 string
  element 는 hash 로 보지 않음.
- I-W12 plain object → `for...in` + `hasOwnProperty` 로 자기 own 속성만
  walk. prototype chain 미탐색.

### 4.4 cycle 안전성

- I-W13 Kiwi-decoded 데이터는 *트리 구조* (parent → child 단방향 ref) 이므로
  cycle 발생 안 함. 본 함수가 `WeakSet` 등 cycle guard 없음 — 안전.
- I-W14 만약 cycle 이 발견되면 (수동 mutation 후) → infinite recursion +
  stack overflow. 본 함수는 *입력이 트리* 라는 contract 에 의존.

## 5. 결과 사용처

| consumer | 용도 |
|---|---|
| `verify.ts:checkAssetConsistency` (V-04) | `images/` 디렉토리와 ref Map 의 양방향 비교. orphan / unused 검출. |
| `export.ts` | 디스크에 image 파일 저장 시 ext 붙임 + `imagesReferenced` / `imagesUnused` 카운트. |
| `pen-export.ts` | INSTANCE 의 image fill 변환 시 hash → 디스크 path 매핑. |
| `audit-rest-as-plugin.mjs` | (간접) — REST API 의 image fill 도 같은 hash 로 매칭. |

- I-U1 결과 Map 은 *read-only* — consumer 가 mutation 안 함. 같은 Map 이
  여러 consumer 에 share 된다.
- I-U2 owner Set 의 *순서* 는 walk 순서 (트리 DFS 순). 결정적.

## 6. 비대상

- ❌ **vector image (`.svg` text)** — magic detection 만 — 본 spec 의 SVG
  매핑은 wire 의 *binary blob* 이 SVG XML 일 때만. 일반적인 .fig 는
  raster 이미지가 다수 — SVG blob 은 드문 케이스.
- ❌ **HEIC / AVIF / TIFF 등 추가 포맷** — 미지원. 등장 시 fallback `'bin'`,
  사용자가 magic 추가 후 spec 업데이트.
- ❌ **EXIF / metadata 추출** — image bytes 의 inner metadata 는 본 spec 외.
- ❌ **image content 의 hash 재계산** — wire 의 hash 가 정답으로 신뢰. SHA-1
  다시 계산해서 검증하는 것은 별도 round 후보.
- ❌ **vector path image (`fillGeometry` 의 vector)** — `vector-decode.spec.md`
  가 다룸. 본 walk 는 raster image 의 hash 만.
- ❌ **mutation 도구 — 새 image 추가** — read-only 변환만. image upload 와
  ref 갱신은 별도 spec.
- ❌ **image deduplication** — 본 spec 은 hash 매핑만; dedup 자체는 Figma 가
  이미 수행 (같은 image bytes → 같은 SHA-1 → 같은 파일명). 우리는 그
  결과를 *읽을* 뿐.

## 7. Resolved questions

- **WebP 가 별도 분기인 이유?** RIFF/WEBP magic 이 *분리된 두 chunk* 라
  단순 prefix 매칭으로 잡히지 않음 (offset 0-3 + 8-11 두 영역). MAGICS 표의
  `magic: number[]` 형식이 *연속 byte* 만 다루므로 WebP 는 hand-coded check.
- **SVG 가 magic 이 아닌 string prefix matching 인 이유?** XML / SVG 는
  binary magic 이 없고 text. `<?xml` 또는 `<svg` 가 prefix 로 등장 — 다른
  포맷과 구분 가능. `\s*` 로 leading whitespace 도 허용.
- **`hashToHex` 의 `Buffer.from(buffer, byteOffset, byteLength)` 가 왜 fast path 인가?**
  `Buffer.from(uint8Array)` (single arg) 는 *copy*; 3-arg form 은 *view*.
  V8 의 native binding 이 view 위에서 직접 hex string 생성 — Array.from + map +
  join 보다 5-10× 빠름 (메타리치 12 image hash 변환에서 측정).
- **`collectImageRefs` 가 `Set` 으로 owner 를 carry 하는 이유?** 한 hash 가
  여러 노드에서 사용되는 케이스 (component master + 여러 instance + 일반
  rectangle 의 reuse). Set 으로 수집 → V-04 의 unused 체크가 정확.
- **`for...in` vs `Object.keys()` 선택 근거?** `for...in` 이 V8 의 hidden
  class cache 에 우호적 (메타리치 35K 노드 walk 에서 ~5% 빠름). 두 룩
  결과 동일 — 본 spec 의 결정은 perf 우선.
