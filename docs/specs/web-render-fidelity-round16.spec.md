# spec/web-render-fidelity-round16

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/colorStyleRef.ts` (`effectiveTextStyle`) + `web/client/src/render/nodeRender.ts` (text-simple / text-styled plan) + `web/client/src/Inspector.tsx` (TextSection 표시) |
| 테스트 | `web/core/domain/colorStyleRef.test.ts` (effectiveTextStyle 케이스 추가) + 기존 nodeRender 회귀 |
| 형제 | round 15 (Inspector library color/text-style label), round 26 (textStyleRuns — per-character overrides) |

## 1. 배경 — 원인 분석

`.fig` 의 TEXT 노드는 두 가지 layer 의 typography 정보를 carry 한다:

1. **Node-level raw 필드** — `fontName`, `fontSize`, `lineHeight`,
   `letterSpacing`, `textCase`, `textDecoration` 등이 노드 자체에 직접 set.
2. **Style asset 참조** — `node.styleIdForText.guid` 가 있으면 별도 노드
   (type=`TEXT` + `styleType='TEXT'`) 가 *style 정의* 를 carry.

Figma 의 동작 — **`styleIdForText` 가 있으면 style asset 의 typography 가
*effective* 값** 이고 노드의 raw 필드는 stale 잔재로 *무시* 된다 (per-
character override 가 없는 한). 즉:

```
effective_fontName  = styleAsset.fontName  ?? node.fontName
effective_fontSize  = styleAsset.fontSize  ?? node.fontSize
... (이하 동일)
```

### 1.1 메타리치 toast popup 케이스 (사용자 발견)

| 노드 | raw fontName | raw fontSize | styleIdForText | 결과 |
|---|---|---|---|---|
| `53:303` ("수정이 완료되었습니다.") | Inter Regular | 12 | `16:727` | Pretendard SemiBold 16 (effective) |
| `53:349` ("저장에 실패했습니다.") | Pretendard SemiBold | 18 | `16:727` | Pretendard SemiBold 16 (effective) |

→ `16:727` = `Body/L_sb` (Pretendard SemiBold 16). Figma 에선 두 노드가
동일하게 보임. 우리 클라이언트는 raw 만 사용 → Inter 12 vs Pretendard 18
로 다르게 그려짐. 이게 시각 격차의 직접 원인.

### 1.2 Round 15 와의 차이

Round 15 는 *라벨로* style name 표시만 (`Style: Body/L_sb`). 본 라운드는
*실제 typography 적용* — Canvas + Inspector 가 effective 값 기반 동작.

### 1.3 Round 26 (textStyleRuns) 와의 관계

Round 26 은 *per-character* override (한 노드 안 부분 영역의 다른 style).
본 라운드는 *node-level base*. 둘은 직교 — character override 가 base
위에 stack 됨:

```
char_effective_fontSize = override.fontSize ?? base_effective_fontSize
                                              ↑
                                     (round 16 이 정의)
```

## 2. 처리 방향

### 2.1 Effective text style resolver

신규 헬퍼 `effectiveTextStyle(node, root) → EffectiveTextStyle` —
`web/core/domain/colorStyleRef.ts` 에 collocate (이미 `textStyleName` 이
같은 alias path 를 walk 하므로 같은 모듈).

```ts
interface EffectiveTextStyle {
  fontName?: { family?: string; style?: string; postscript?: string };
  fontSize?: number;
  lineHeight?: { value?: number; units?: string };
  letterSpacing?: { value?: number; units?: string };
  textCase?: string;          // ORIGINAL / UPPER / LOWER / TITLE
  textDecoration?: string;    // NONE / UNDERLINE / STRIKETHROUGH
  paragraphSpacing?: number;
  paragraphIndent?: number;
}
```

룰:

- I-1 `node.styleIdForText.guid` 가 있고 lookup 성공 + 타깃의 `type ==='TEXT'`
  + `styleType === 'TEXT'` 이면 → 타깃 노드의 위 필드들을 그대로 채택.
  타깃에 어떤 필드가 *없으면* node 의 raw 필드로 *필드 단위 fallback*.
  (style asset 이 fontSize 만 정의하고 textCase 는 미정의 → fontSize 는
  asset, textCase 는 node raw 에서.)
- I-2 styleIdForText 부재 / lookup 실패 / 타깃이 style asset 형태 아님
  → 모든 필드가 node raw 에서. round 16 이전과 동일 동작.
- I-3 root 가 null/undefined 면 lookup 불가 → I-2 의 fallback. (Inspector
  callers 가 root 를 항상 전달하지만 방어).
- I-4 헬퍼는 *pure* — no IO, no React. Canvas plan + Inspector 모두 사용.

### 2.2 Canvas 렌더 (nodeRender)

- I-5 `nodeRender.ts` 의 `RenderContext` 에 새 필드 `documentRoot?: unknown`
  추가. `App.tsx` 가 `nodeRender(node, ctx)` 호출 시점에 `doc` 을 ctx 로
  넘긴다.
- I-6 `planTextSimple` / `planTextStyled` 가 raw 필드 대신 `effectiveTextStyle(
  node, ctx.documentRoot)` 결과를 사용해 fontFamily / fontSize /
  fontStyle / lineHeight / letterSpacing / textCase / textDecoration 을
  채운다. raw 필드 직접 접근 코드 모두 헬퍼 통과.
- I-7 round 26 의 character-level override 는 `effectiveTextStyle` 의
  base 위에 stack — round 26 의 `splitTextRuns` 는 base 를 입력 받도록
  변경 (필요하면 별도 라운드, round 16 은 base 만 정확). round 26 의
  per-run fontSize/fontFamily 가 v1 비대상 (`Canvas.tsx` 주석) 이라
  현재는 base 만 효과적이면 시각이 충분히 figma 에 가까워진다.

### 2.3 Inspector — Text section

- I-8 Inspector Text section 의 *표시* 는 effective 값. 즉 사용자가 보는
  `Family`, `Weight`, `Size`, `L Height`, `Letter` 등 input 의 *value*
  prop 이 effective 에서 읽힘.
- I-9 *편집* (TextInput / NumberInput 의 onCommit) 은 raw 필드를 patch.
  v1 비대상: style 적용된 노드 편집 시 raw 가 변경돼도 effective 는
  여전히 style asset 값이라 화면에 변화 없을 수 있음 — Inspector 의
  Style row (round 15 가 추가) 가 사용자에게 "style 적용 중" 신호 역할.
  Detach (편집 시 styleIdForText 자동 제거 + raw 로 전환) 는 *별도
  라운드 후보*. round 16 은 이 시나리오를 *알려진 한계* 로 명시.
- I-10 Inspector 가 `root` prop 을 이미 받음 (round 15) — Text section
  도 같은 root 를 헬퍼에 전달.

### 2.4 audit harness 영향

- I-11 `audit-oracle.spec.md` 의 COMPARABLE_FIELDS 의 `fontSize`,
  `fontName.family`, `fontName.style` 은 *node raw* 를 읽는다 (`pickOurs`).
  본 라운드 후에도 audit 비교 자체는 raw 사용 — figma plugin/REST 가
  resolved effective 를 emit 하므로 *기존 audit* 의 mismatch 가 일부
  생길 수 있음. 별도 라운드에서 audit pickOurs 를 effective 로 전환 권장.
  round 16 자체는 audit 비교 룰 변경 안 함.

## 3. Invariants — 한 줄 요약

| ID | 명제 | 검증 |
|---|---|---|
| I-1 | styleIdForText 있고 asset 정상 → style 필드 우선, 빈 필드는 node raw fallback | unit |
| I-2 | styleIdForText 부재 / 잘못된 타깃 → 모두 node raw | unit |
| I-3 | root null → 모두 node raw | unit |
| I-6 | nodeRender text plan 들이 effective 값 사용 | unit (nodeRender.test.ts) |
| I-8 | Inspector Text section 표시값 = effective | manual UI |
| I-9 | Inspector edit onCommit 은 raw 필드 patch | manual UI |

## 4. Out of scope

- ❌ Inspector edit detach 정책 (편집 시 자동 styleIdForText 제거). round 17 후보.
- ❌ Audit pickOurs 의 effective 전환. round 17 후보.
- ❌ Per-character `styleOverrideTable` 의 fontSize/fontFamily override (round 26 의 v1 비대상). round 17/18 후보.
- ❌ Component 에 적용된 style asset 의 nested resolution (style asset → 또 다른 style asset alias). 단일 hop.
- ❌ Style asset 자체의 *편집*. 본 라운드는 read-only 적용.

## 5. 참조

- Round 15: `colorVarName` / `textStyleName` (라벨 표시)
- Round 26: `textStyleRuns` (per-character overrides)
- 메타리치 fixture: `53:303`, `53:349`, `16:727 "Body/L_sb"`
