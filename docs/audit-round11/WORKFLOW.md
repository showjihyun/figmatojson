# Audit-round11 — iteration workflow

이 폴더는 figma_reverse 가 메타리치 .fig 파일을 렌더링한 결과를 Figma 의 실제 화면과 비교하기 위한 audit harness 다.

## 폴더 구조

```
docs/audit-round11/
  _INVENTORY.md           ← 6개 페이지 × 컨테이너 노드 인벤토리 (자동 생성)
  _INVENTORY.json         ← 같은 정보 머신 읽기용
  WORKFLOW.md             ← (이 파일)
  GAPS.md                 ← gap 분석 결과 (라운드별 갱신)

  <page-slug>/                       ex: design-setting/, web/, mobile/
    _overview/
      ours.png                       ← 페이지 전체 자동 캡처
      figma.png                      ← (당신이 드롭) Figma 페이지 전체 캡처
    <component-slug>/                ex: button-5_9/, sidemenu-23_1635/
      ours.png                       ← 자동 캡처
      figma.png                      ← (당신이 드롭) 같은 노드의 Figma 캡처
```

페이지 슬러그: `design-setting`, `internal-only-canvas`, `web`, `mobile`,
`dash-board`, `icons`. 컴포넌트 슬러그는 `<이름>-<sessionID_localID>` 형식.
정확한 목록은 `_INVENTORY.md` 참조.

## 캡처 갯수

| 페이지 | ours.png 캡처 수 |
|---|---:|
| design-setting | 29 (overview + 28 컨테이너) |
| internal-only-canvas | 3 |
| web | 527 |
| mobile | 147 |
| dash-board | 45 |
| icons | 2 |
| **합계** | **753** |

WEB / MOBILE 은 컨테이너 갯수가 많아 모두 비교는 비현실적이다. **현실적
워크플로우**: 페이지 overview 1장 + 그 페이지에서 가장 핵심인 5–10개
컴포넌트 우선 비교. Gap 발견되어 수정 → 재캡처 → 재비교.

## 사용자 → AI 인계 흐름

### 1. Figma 캡처 (당신)
- 페이지 하나씩 진행. 우선순위: design-setting → web → mobile →
  dash-board → icons → internal-only-canvas (메타 페이지라 후순위)
- 페이지 overview 한 장: `<page-slug>/_overview/figma.png`
- 페이지에서 핵심 컴포넌트들 (보통 5~10개)을 정확히 같은 영역으로 캡처:
  `<page-slug>/<component-slug>/figma.png`
- 컴포넌트 슬러그는 `_INVENTORY.md` 의 슬러그 컬럼에서 그대로 복사

### 2. AI 가 받아서 (나)
- 매칭되는 (figma.png, ours.png) 모두 시각 비교
- `GAPS.md` 의 해당 페이지 섹션에 gap 항목 추가
- 우선순위 정해서 라운드 N spec + 구현 + 테스트
- 코드 변경 후 자동 재캡처: `node web/scripts/audit-round11-screenshots.mjs <page-slug>`
- 같은 figma.png 와 다시 비교 → high 항목이 0될 때까지 반복

### 3. 페이지 전환 결정
- AI 가 페이지의 high gap 모두 해결했다고 판단하면 보고
- 당신이 "다음 페이지" 또는 "이 페이지 더 깊게" 결정

## 관련 스크립트

```bash
# 인벤토리 재계산 (메타리치 .fig 파일이 바뀐 경우만)
node web/scripts/build-audit-inventory.mjs

# 모든 페이지 our-side 재캡처
node web/scripts/audit-round11-screenshots.mjs

# 특정 페이지만 재캡처
node web/scripts/audit-round11-screenshots.mjs design-setting web
```

스크립트는 `npm run dev` 로 :5273 + :5274 가 떠 있을 때만 작동.

## 현 시점 상태 (2026-05-03)

- ✅ Phase A 인벤토리 (6 페이지, 747 컨테이너)
- ✅ Phase B our-side 자동 캡처 (753 PNG)
- ⏳ Phase C: 사용자 figma.png 페이지별로 드롭 시작
- ⏳ Phase D: 페이지별 GAPS.md 작성 + 라운드 N+ 수정 루프
