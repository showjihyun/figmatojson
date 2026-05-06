# spec/tokens

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 1 — round 33) |
| 구현 | `src/tokens.ts` + `src/cli.ts` (`tokens` subcommand) + `src/index.ts` (re-export) |
| 테스트 | (TODO) `src/tokens.test.ts` — 본 spec 의 Invariants 단위 |
| 형제 | `audit-oracle.spec.md` (parser correctness), Phase 0d packaging (`docs/PHASE-0-FOUNDATION.md`) |

## 1. 목적

Figma published styles 을 *언어-중립* 디자인 토큰으로 추출. 1차 사용자
는 (나) 개발자 도구 — CI 에서 `.fig` 변경 시 토큰 export 자동 갱신,
디자인-코드 sync 의 source-of-truth.

스타일 → 토큰 변환은 *데이터 보존* 이지 *해석* 이 아님. Figma 의
authored value 그대로 (예: `lineHeight: 1.33` RAW 는 그대로 multiplier
로 emit). consumer (CSS / JS) 가 자기 단위로 변환.

## 2. 입력 / 출력

- 입력: `.fig` 파일 (CLI) 또는 `DecodedFig` (library API).
- 출력: `Tokens` JSON (default), 또는 CSS variables / JS / TS export.

```
$ figma-reverse tokens design.fig                          # JSON to stdout
$ figma-reverse tokens design.fig --format css --out tokens.css
$ figma-reverse tokens design.fig --format ts --out src/design-tokens.ts
```

```ts
import { decodeFigCanvas, extractTokens, loadContainer } from 'figma-reverse';

const decoded = decodeFigCanvas(loadContainer('design.fig').canvasFig);
const tokens = extractTokens(decoded, 'design.fig');
// tokens.colors["Blue-100"] === { value: "#e5f0ff" }
```

## 3. 출력 schema (v1)

```ts
interface Tokens {
  schemaVersion: '1';
  source: { figName: string };
  colors: Record<string, ColorToken>;
  typography: Record<string, TypographyToken>;
  effects: Record<string, EffectToken>;
}
```

### 3.1 ColorToken

- I-T1 `value` 필수. CSS-호환 hex: alpha=1 일 때 `#RRGGBB`, 그 외
  `#RRGGBBAA`. 모두 lowercase.
- I-T2 `description` (optional) — Figma 의 style description 전달.
- I-T3 v1 은 SOLID FILL 만 추출. gradient / image fill style 은
  *키 자체를 emit 안 함* (tokens.colors 에 entry 없음). 향후
  v2 에서 `gradient` 필드 추가.
- I-T4 다중 fillPaints 인 경우 첫 visible SOLID 만. 다른 paint 는
  무시.

### 3.2 TypographyToken

- I-T5 `fontFamily`, `fontStyle`, `fontSize` 필수. fontStyle 은
  Figma 가 가진 라벨 그대로 ("Regular", "Bold", "SemiBold" — weight
  numeric 변환은 consumer 책임).
- I-T6 `lineHeight: { unit, value }` —
  `PX` (PIXELS), `PERCENT` (PERCENT), `AUTO` (RAW unitless multiplier).
  AUTO 의 value 는 해당 multiplier (예: 1.33).
- I-T7 `letterSpacing: { unit, value }` — `PX` (default) 또는
  `PERCENT`. PERCENT 는 100 = 1em.
- I-T8 `description` (optional).

### 3.3 EffectToken

- I-T9 `type` 필수: `DROP_SHADOW` / `INNER_SHADOW` / `LAYER_BLUR` /
  `BACKGROUND_BLUR`.
- I-T10 DROP_SHADOW / INNER_SHADOW: `color` (hex), `offset {x,y}`,
  `radius` (blur), `spread`.
- I-T11 LAYER_BLUR / BACKGROUND_BLUR: `blur` 만.
- I-T12 다중 effects 인 경우 첫 visible 만. 다른 effects 는 무시.

## 4. 추출 룰

- I-T13 입력 노드 중 `styleType ∈ {FILL, TEXT, EFFECT}` 인 노드만
  대상. `name` 없는 노드 skip.
- I-T14 `name` 키 그대로 유지 (Figma 의 namespace `/` 포함). 예:
  `colors["Heading/XL"]`. consumer 가 변환 책임.
- I-T15 같은 `name` 의 중복 entry 는 *마지막 emit 우선*. 정상적으로
  Figma file 안에서 중복 style 은 없지만 deterministic 동작 보장.
- I-T16 spacing token 은 v1 *비대상* (§7).
- I-T17 variables (multi-mode) 은 v1 *default mode resolved value*
  로만. variable reference 는 1 단계 dereference. v2 에서 mode 별
  분리.

## 5. CLI

`figma-reverse tokens <input.fig> [options]`

- I-C1 `--format json|css|js|ts` (default `json`).
- I-C2 `--out <path>` 미지정 시 stdout 으로.
- I-C3 input `.fig` 가 없으면 비-zero exit + stderr 에러.
- I-C4 출력 끝에 newline 1개 (POSIX 컨벤션).

### 5.1 Format 별 출력 규칙

- I-C5 JSON: `JSON.stringify(tokens, null, 2)` — 2-space indent.
- I-C6 CSS: `:root { ... }` 안에 `--<category>-<slug>-<field>: value;`.
  slug 는 `name.toLowerCase().replace(/[^a-z0-9가-힣]+/g, '-')`. 한글은 보존.
- I-C7 JS: `export default { ... }` (ESM).
- I-C8 TS: `export const tokens: Tokens = { ... }; export default tokens;`.

## 6. Library API

`src/index.ts` 에서 re-export (semver 1.0+ 안정):

- `extractTokens(decoded: DecodedFig, figName: string): Tokens`
- `formatTokens(tokens: Tokens, format: TokenFormat): string`
- types: `Tokens`, `ColorToken`, `TypographyToken`, `EffectToken`, `TokenFormat`

## 7. 비대상 (v1)

- ❌ Spacing tokens — Figma 가 first-class 로 노출 안 함 (§ 0c 이슈).
  v2 후보: 컴포넌트 이름 패턴 (`Spacing/4`) 으로 추론하는 config 옵션.
- ❌ Grid styles — 빈도 낮음. v2.
- ❌ Variables modes (multi-mode) — v1 은 default mode 만. v2 에서
  `Tokens.modes: Record<modeName, ResolvedTokens>` 추가.
- ❌ Gradient / image fills — color token 에 미반영. v2 후보.
- ❌ Multi-effect token — 첫 effect 만. 디자인 시스템 에서 1 effect
  =1 style 이 정상 패턴.
- ❌ 외부 library 참조 (sourceLibraryKey) 의 fully-resolved values —
  로컬 .fig 에 없는 값은 없는 채로 둠.

## 8. Test fixture 결과 (round 33)

| Fixture | colors | typography | effects |
|---|---|---|---|
| `bvp.fig` | 1 | 40 | 2 |
| `메타리치 화면 UI Design.fig` | 22 | 22 | 1 |

샘플 JSON 출력 (bvp):

```json
{
  "colors": {
    "Global / Neutral Grey / 1300": { "value": "#0a090b" }
  },
  "typography": {
    "Caption/14 Regular": {
      "fontFamily": "Pretendard Variable",
      "fontStyle": "Regular",
      "fontSize": 14,
      "lineHeight": { "unit": "PX", "value": 20 },
      "letterSpacing": { "unit": "PX", "value": 0.1 }
    }
  },
  "effects": {
    "d_s": {
      "type": "DROP_SHADOW",
      "color": "#00000036",
      "offset": { "x": 0, "y": 4 },
      "radius": 12,
      "spread": 0
    }
  }
}
```

## 9. Resolved questions

- **slug 에서 한글 보존하는가?** 보존. Figma 디자이너가 한글 style
  이름 자주 사용 (예: "버튼/기본"). CSS 도 한글 변수 식별자 허용.
  consumer 가 ASCII-only 강제 필요시 후처리.
- **lineHeight RAW 단위는 어떻게 emit?** `{ unit: 'AUTO', value: <multiplier> }`.
  CSS 에서 unitless line-height 으로 그대로 사용 가능.
- **letterSpacing PERCENT 는?** `{ unit: 'PERCENT', value }`. CSS 변환 시
  `value/100 + 'em'`. 100 = 1em 의 Figma 컨벤션.
- **`--format css` 변수 prefix 는?** `--color-`, `--typography-`,
  `--shadow-`, `--blur-`. 카테고리별 prefix 일관.
