# Phase 0 — Developer-tool foundation

| 항목 | 값 |
|---|---|
| 상태 | Inventory + decision draft (round 33 시작) |
| 목적 | (나) 개발자 도구 vision 의 Phase 1~5 가 의존하는 안정 표면 (CLI / HTTP / 라이브러리 / token schema) 정의 |
| 후속 | `docs/specs/tokens.spec.md` (Phase 1), `docs/api/cli.md` & `docs/api/http.md` (참조 문서) |

본 문서는 *현재까지 만들어진 것* 의 인벤토리와 Phase 1~5 가 외부에 노출할 *공개 표면* 의 1차 안 (proposal). 사용자 확인 후 spec 으로 분리.

## 0a. CLI surface 현재 상태

### 등록된 subcommand

| Subcommand | 상태 | 입력 → 출력 | 1 차 사용 사례 |
|---|---|---|---|
| `extract` | 🟢 stable | `<input.fig>` → `output/<name>/{document.json, pages/*, assets/*, ...}` + `extracted/<name>/01_container/...` | .fig 디코드 |
| `repack` | 🟢 stable | `<extracted-dir> <out.fig>` (`--mode byte\|kiwi\|json`) | 편집된 JSON → .fig |
| `html-report` | 🟢 stable | `<extracted-dir> [out-dir]` (`--single-file`) | 인터랙티브 대시보드 |
| `editable-html` | 🟢 stable | `<input.fig>` → 단일 .html (`--single-file` 시 inline 모든 자산) | 디자인 미리보기 + 편집 시작점 |
| `pen-export` | 🟢 stable | `<input.fig> [out-dir]` → 페이지별 `<idx>_<page>.pen.json` | Pencil 도구용 |
| `round-trip-html` | 🔴 deprecated | (위 `editable-html --single-file` 로 통합) | (legacy) |

### 빠진 subcommand (Phase 1+ 후보)

- `tokens` — 디자인 토큰 추출 (Phase 1)
- `diff` — 두 .fig 사이 structural diff (Phase 3)
- `lint` — 가이드라인 검증 (Phase 4)
- `convert` — `.fig` → SVG / React stub / Storybook (Phase 2 의 일부; 현재 `pen-export` 가 한 포맷 담당)

### CLI option / output 안정성 정책 (제안)

- 🟢 stable: 생성되는 파일명 (`document.json`, `pages/*.json`, `assets/...`), JSON top-level 필드. **breaking change 시 major version bump.**
- 🟡 stable-but-internal: `extracted/<name>/01..05_*` 중간 산출물. 디버깅용, 외부 의존 비권장.
- 🔴 unstable / experimental: `--include-raw-message` (kiwi raw), `04_decoded/message.json` schema. minor 버전에서 변경 가능.

## 0b. Web HTTP API 현재 상태

`web/server` (Hono backend, default `:5274`).

| Method | Path | 책임 | 안정성 |
|---|---|---|---|
| GET | `/` | health text | 🟢 |
| POST | `/api/upload` | multipart `.fig` → `{ sessionId, origName, pageCount, nodeCount }` | 🟢 |
| GET | `/api/doc/:id` | 세션의 `documentJson` 반환 | 🟢 |
| PATCH | `/api/doc/:id` | `{nodeGuid, field, value}` → 노드 필드 수정 | 🟢 |
| POST | `/api/save/:id` | repack → `application/octet-stream` (.fig 다운로드) | 🟢 |
| POST | `/api/instance-override/:id` | INSTANCE 텍스트 override 적용 | 🟢 |
| POST | `/api/resize/:id` | resize 적용 | 🟢 |
| GET | `/api/asset/:id/:hash` | 이미지/벡터 blob 반환 | 🟢 |
| GET | `/api/session/:id/snapshot` | 세션 → 스냅샷 다운로드 | 🟢 |
| POST | `/api/session/load` | 스냅샷 → 새 세션 | 🟢 |
| POST | `/api/undo/:id` | 마지막 edit 롤백 | 🟢 |
| POST | `/api/redo/:id` | 롤백된 edit 재적용 | 🟢 |
| POST | `/api/audit/compare` | 세션 vs Plugin/REST tree → 필드별 diff | 🟢 (round 30+) |
| POST | `/api/chat/:id` | Anthropic Agent SDK 채팅 (실험) | 🟡 internal |

### 빠진 endpoint (Phase 1+ 후보)

- `GET /api/tokens/:id` — 세션의 디자인 토큰 (Phase 1, CLI `tokens` 와 동일 출력)
- `POST /api/diff` — 두 세션/2개의 .fig 사이 structural diff (Phase 3)
- `POST /api/lint/:id` — lint 결과 (Phase 4)

### 안정성 정책

- 🟢 stable: 위 endpoint URL 패턴 + 응답 JSON top-level 키. minor 변경 시 backward-compat 유지.
- 🟡 internal: `/api/chat/*` (실험), `/api/audit/compare` 의 sample 형식.
- session id 는 1 시간 TTL (env `SESSION_GC_AGE_MS`), 따라서 외부 클라이언트는 항상 *재업로드 후 재시도* 패턴 필요.

## 0c. Token output schema (Phase 1 입력 — DRAFT)

### 출력 shape (1 차 안)

```ts
interface Tokens {
  schemaVersion: '1';
  source: { figName: string; sha256: string };
  colors: Record<string, ColorToken>;
  typography: Record<string, TypographyToken>;
  spacing: Record<string, number>;       // px
  effects: Record<string, EffectToken>;
}

interface ColorToken {
  // CSS-compatible hex (#RRGGBBAA when opacity < 1, #RRGGBB otherwise).
  // For tokens that resolve to gradients we emit `gradient`, otherwise `value`.
  value?: string;
  gradient?: GradientStop[];
  description?: string;
}

interface TypographyToken {
  fontFamily: string;
  fontSize: number;       // px (Figma's authored value)
  fontWeight: number;     // 100-900
  lineHeight: number | { unit: 'PX' | 'PERCENT'; value: number };
  letterSpacing: number;  // px (default 0)
  description?: string;
}

interface EffectToken {
  type: 'DROP_SHADOW' | 'INNER_SHADOW' | 'LAYER_BLUR' | 'BACKGROUND_BLUR';
  // DROP_SHADOW / INNER_SHADOW
  color?: string;         // hex w/ alpha
  offset?: { x: number; y: number };
  radius?: number;
  spread?: number;
  // BLUR
  blur?: number;
  description?: string;
}
```

### 입력 source

Figma 의 *published styles*: 색상 styles, text styles, effect styles, grid styles. kiwi schema 기준 `data.styleType`/`fillPaints`/`textData` 등.

> 주: spacing 토큰은 Figma 가 *first-class style 로 노출하지 않음*. 디자인 시스템들이 자체 컨벤션 (예: `Spacing/4`, `Spacing/8` 같은 컴포넌트로 표시) 사용. v1 은 디자이너 합의된 추출 규칙을 사용자 config 로 받는 것으로 시작 — 또는 v1 에서는 spacing 미지원 (color/typography/effects 만) 으로 단순화 후 v2 에서 확장.

### Output 포맷 옵션 (CLI `--format`)

| Format | 출력 |
|---|---|
| `json` (default) | 위 `Tokens` 인터페이스 그대로 JSON |
| `css` | CSS variables (`--color-primary-500: #...`) |
| `js` | ESM exports (`export const colors = { ... }`) |
| `ts` | TypeScript with shape (`export const tokens: Tokens = {...}`) |

### 결정 보류 항목

- 🟡 변수 (variables) 처리 — Figma 의 design variables 시스템 (mode 별 다중 값). v1 은 *resolved value* 만 (default mode), v2 에서 mode 별 출력.
- 🟡 spacing 추출 알고리즘 — 컴포넌트 이름 패턴? padding 통계?
- 🟡 nested token reference — `color.primary.500` 같은 namespace 처리

## 0d. npm packaging 전략

### 현재 구조

- repo root 의 `package.json` = `figma-reverse` (CLI bin + 라이브러리)
- `web/package.json` = `figma-reverse-web` (private, 개발용)
- `figma-plugin/` = 패키징 안 됨 (Figma Desktop 에서 import-from-manifest)

`main: "dist/cli.js"` — 현재 *라이브러리 import 진입점이 없음*. 외부 코드가 `import { extractTokens } from 'figma-reverse'` 하면 CLI 코드 진입.

### 옵션 A — 단일 패키지 (권장 v1)

```jsonc
{
  "name": "figma-reverse",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".":            "./dist/index.js",       // 새 lib entry
    "./cli":        "./dist/cli.js",         // 기존 CLI
    "./schema":     "./dist/schema/*.json",  // JSON schema 파일
    "./package.json": "./package.json"
  },
  "bin": { "figma-reverse": "dist/cli.js" }
}
```

- 신규: `src/index.ts` 에서 public API 만 re-export (다음 섹션의 *Public API* 참조).
- 기존 코드 손 안 댐. CLI 그대로 동작, 라이브러리 사용자만 새 entry 통해 접근.

장점: 사용자 1 개만 설치, 의존 관리 단순.
단점: bundle 크기. 사용자가 CLI 만 필요한데 lib 코드도 받음 (~수 MB).

### 옵션 B — 분할 (`@figma-reverse/{core,cli,plugin}`) — Phase 5+ 검토

monorepo 구조 (workspace). Phase 1~4 진행 후 사용량 측정 후 결정. 현재 단일이면 충분.

### 권장: 옵션 A + 명확한 `exports` 맵

### Public API surface (1 차 안 — `src/index.ts`)

```ts
// Parsing
export { extractFig } from './export.js';            // .fig bytes → 결과 객체
export { decodeFigCanvas } from './decoder.js';       // .fig bytes → kiwi message
export type { DecodedFig } from './decoder.js';

// Repacking
export { repackFig } from './repack.js';

// Token (Phase 1 — 신규)
export { extractTokens } from './tokens.js';
export type { Tokens, ColorToken, TypographyToken, EffectToken } from './tokens.js';

// Audit (Phase 1+ — 옵션)
export { auditCompare } from './audit/compare.js';

// 명시적 internal: collectTextOverridesFromInstance, kiwi raw schema, 1854:7875 같은
// overrideKey resolution 등은 export 안 함. 필요하면 향후 별도 advanced API.
```

### Versioning 정책

- `0.x` (현재): breaking change 자유롭게.
- `1.0.0` (Phase 5 close 후 목표): 위 Public API + Token schema + HTTP API 가 semver 보장.
- breaking change 발견 시 *반드시* commit message 에 `BREAKING:` prefix.

## 결정 필요 항목 (사용자 합의 후 spec 분리)

1. **Spacing token 처리** — v1 에서 미지원 OK 인가?
2. **Figma variables (modes)** — v1 에서 default mode 만, v2 multi-mode OK?
3. **분할 vs 단일 패키지** — 옵션 A (단일) 로 시작 OK?
4. **Public API export 목록** — 위 `src/index.ts` 안에 빠진 것 있나?
5. **CLI 안정성 약속** — 현재 6 subcommand (deprecated 1 제외) 모두 1.0 까지 유지?
6. **HTTP API 안정성 약속** — `/api/chat/*` 외 13 endpoint 모두 1.0 까지 유지?

위 6 항목 합의 후 → Phase 1 (`tokens` CLI + lib) 시작.
