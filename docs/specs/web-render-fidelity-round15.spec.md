# spec/web-render-fidelity-round15

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/core/domain/colorStyleRef.ts` (신규) + `web/client/src/Inspector.tsx` + `web/client/src/App.tsx` |
| 테스트 | `web/core/domain/colorStyleRef.test.ts` (신규) |
| 형제 | round 14 (variant label UI) |

## 1. 배경

`.fig` 의 fillPaints/strokePaints 는 SOLID color RGBA 값과 함께 *선택적
으로* `colorVar.value.alias.guid` 를 carry — 이게 Figma 의 *color
variable* (라이브러리 색상) 참조다. TEXT 노드의 `styleIdForText.guid` 도
같은 패턴 — 텍스트 스타일 asset 참조.

메타리치 5:8 SYMBOL "size=XL, State=default, Type=primary" (Button master):
```
fillPaints[0]: {
  type: 'SOLID',
  color: { r: 0.097, g: 0.441, b: 0.957, a: 1 },   // raw RGBA
  colorVar: {
    value: { alias: { guid: { sessionID: 11, localID: 434 } } },
    dataType: 'ALIAS',
    resolvedDataType: 'COLOR',
  }
}
```

GUID `11:434` → DOCUMENT root 의 `Internal Only Canvas` 페이지에 들어
있는 `VARIABLE` 노드, `name: "Button/Primary/Default"`.

Figma 의 우측 패널은 fill 색상 옆에 그 라이브러리 색상 이름을 라벨로
보여준다 — 우리 Inspector 는 raw RGBA 만 노출. 본 라운드는 그 라벨을
복원.

## 2. 도메인 헬퍼 — `colorStyleRef.ts`

`web/core/domain/` 에 신규 모듈. 모든 헬퍼는 pure (no IO, no React).

### 2.1 paint → color variable name

- I-1 `colorVarName(paint, root)`:
  - 입력: `paint` 객체 + DOCUMENT root (= 전체 트리 root, VARIABLE 노드도
    포함하는 가장 상위 노드).
  - `paint.colorVar.value.alias.guid` (`{sessionID, localID}`) 추출.
  - 추출 실패 (필드 부재 / 타입 불일치) → `null`.
  - guid 로 root 트리에서 노드 lookup. 노드가 *없거나* `type !==
    'VARIABLE'` → `null` (방어적; figma 의 VARIABLE 만 라이브러리 색상으로
    인정).
  - lookup 노드의 `name` 이 string 이면 그대로 반환, 아니면 `null`.

### 2.2 node → text style asset name

- I-2 `textStyleName(node, root)`:
  - `node.styleIdForText.guid` 추출 — 같은 패턴, 같은 방어.
  - lookup 노드의 type 은 `TEXT` 면서 `styleType === 'TEXT'` 인 *style
    asset* 노드 (예: 메타리치 `4:184 "Lable/L_sb"` — type 은 TEXT 지만 본문
    노드가 아닌 style 정의 노드).
  - 노드가 그 형식이 아니면 `null`. style asset name 그대로 반환.

### 2.3 Cycle / chain 정책

- I-3 한 단계만 따른다 — VARIABLE 의 `variableDataValues` 가 또 다른
  alias 일 수 있지만 본 라운드는 *가장 바깥쪽 (= 사용자가 화면에서 본)
  alias name* 만 라벨로 표시. 라벨이 사용자에게 의미있는 이름이고
  (`Button/Primary/Default`), 더 깊은 chain 은 별도 라운드.

## 3. Inspector UI 변경

- I-4 `App.tsx` 의 `<Inspector>` mount 에 새 prop 추가: `root={doc}` —
  현재 `page` 만 전달하는데 VARIABLE 노드는 *페이지 외* (`Internal Only
  Canvas`) 에 들어있어 `page` 만으론 lookup 불가.
- I-5 `Inspector` 가 root 를 `FillSection` / `StrokeSection` 으로 그대로
  전달. 두 섹션은 raw paint + root 로 헬퍼 호출.
- I-6 라벨 위치 — 기존 `<Row label="Color">` 아래에 추가 row:
  ```
  <Row label="Style">
    <span className="text-xs text-muted-foreground">Button/Primary/Default</span>
  </Row>
  ```
  헬퍼가 null 이면 row 자체 미표시 — 일반 SOLID color (figma library 미참조)
  의 표시는 이전과 동일.

## 4. Invariants — 한 줄 요약

| ID | 명제 | 검증 |
|---|---|---|
| I-1 | `colorVarName` 은 `paint.colorVar.alias.guid` 를 root 에서 lookup 후 VARIABLE.name 반환 | unit |
| I-1a | guid 부재 / 타입 불일치 / lookup 실패 / VARIABLE 아님 → null | unit |
| I-2 | `textStyleName` 은 `node.styleIdForText.guid` 를 root 에서 lookup 후 TEXT style asset.name 반환 | unit |
| I-4 | App 이 `root={doc}` 를 Inspector 에 전달 | manual UI |
| I-6 | colorVarName 이 null 이면 Style row 미표시 | unit (Inspector snapshot) |

## 5. Out of scope

- ❌ Selection colors 섹션 (multi-select 시 노드들의 color 들 요약). 별도 라운드.
- ❌ VARIABLE chain 의 deep resolve (raw color 까지 trace). I-3 정책.
- ❌ effect style / fill style (paint 종합) reference. 현재 SOLID color 만.
- ❌ paint 본문 (gradient stops / image hash) 의 라이브러리 참조. 별도 라운드.
- ❌ color variable 편집. 본 라운드는 *읽기 전용 라벨*.
- ❌ `audit-oracle` 의 COMPARABLE_FIELDS 확장. 별도 라운드.

## 6. 참조

- 메타리치 fixture — 5:8 SYMBOL, 5:2 TEXT (colorVar 사용 예)
- `web/core/domain/tree.ts` — `findById` 헬퍼 재사용
