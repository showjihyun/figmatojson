# spec/web-left-sidebar

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/components/sidebar/LeftSidebar.tsx`, `LayerTree.tsx`, `AssetList.tsx` |
| 테스트 | `web/client/src/components/sidebar/*.test.tsx`, `web/e2e/left-sidebar.spec.ts` |
| 의존 | shadcn `Tabs`, `Input`, `Button`. lucide-react 아이콘. 기존 `ChatPanel`. App 의 `selectedGuids` / `setPageIdx` / `handleSelect` props. |

## 1. 목적

Figma 의 좌측 패널과 동일한 UX 를 제공한다 — 기본은 **Files (레이어 트리)** + **Assets (검색 가능한 컴포넌트 목록)** 두 탭. 기존 `ChatPanel` 은 **Chat 탭** 안으로 이관되어 옵션으로 남는다.

배경:
- 현재 좌측 320px = `ChatPanel` 단독. 디자인 탐색용 UI 가 부재 (App.tsx:362).
- 메타리치 샘플은 35,660 노드 / 6 페이지 — Figma 와 같은 트리/검색 없이는 노드 도달이 캔버스 클릭 외에는 없음.

## 2. 레이아웃

```
+--------------------------------------------------+
| Header (changes none)                            |
+----------+---------------------------+-----------+
| Sidebar  | Canvas                    | Inspector |
| 320px    | flex-1                    | 360px     |
| ┌──────┐ |                           |           |
| │Files │ │                           |           |
| │Assets│ │                           |           |
| │Chat  │ │                           |           |
| └──────┘ │                           |           |
| <body>   │                           |           |
+----------+---------------------------+-----------+
```

- 좌측 `<aside>` 너비 (`w-80` = 320px) / `border-r` / `flex flex-col` 유지. 내부만 `<LeftSidebar>` 로 교체.
- 탭 헤더는 sidebar 상단 고정 (~36px). 본문은 `flex-1 min-h-0 overflow-auto`.

## 3. Tabs

shadcn `<Tabs>` 사용 (`web/client/src/components/ui/tabs.tsx`).

- I-T1 탭은 정확히 3개: `files` / `assets` / `chat`.
- I-T2 기본 탭 = `files`.
- I-T3 활성 탭은 `localStorage["leftSidebar.tab"]` 에 저장. 페이지 새로고침 시 복원. 잘못된 값이면 `files` 로 fallback.
- I-T4 세션이 없을 때 (`session === null`) 도 모든 탭 클릭은 가능하지만, Files/Assets 탭은 "No document open" placeholder 를 보인다 (캔버스 placeholder 와 동일 톤).
- I-T5 탭 전환 시 본문은 unmount 되지 않는다 (Radix `<Tabs>` 기본 동작 — 채팅 입력 / 레이어 펼침 상태 / 스크롤 위치 보존).

## 4. Files 탭 — Pages section + Layer Tree

Files 탭은 두 섹션을 세로로 적층. 각 섹션은 자체 collapsible 헤더를 가지고, 사이에 1px separator.

```
┌──────────────────────┐
│ ▾ Pages              │
│   • Cover            │
│   • Design Setting ✓ │  ← current page
│   • ...              │
├──────────────────────┤
│ ▾ Layers             │
│   ▸ sidemenu         │  ← currentPage 의 children
│   ▸ section 1        │
│   ...                │
└──────────────────────┘
```

### 4.0 Pages section

- I-PG1 입력 = `pages` (App 의 `doc.children.filter(type === 'CANVAS')`). 한 행 per page.
- I-PG2 행 내용 = page name (또는 `<unnamed>`). 추가 메타정보는 v1 비대상.
- I-PG3 현재 페이지 (`pageIdx` 가 가리키는 행) 는 `bg-accent` + 좌측에 4px primary-color 막대로 강조. 다른 모든 행은 hover 시 `hover:bg-accent/50`.
- I-PG4 페이지 행 클릭 → `setPageIdx(idx)` + `onSelect(null)` (선택 해제). 이는 LeftSidebar 가 받는 `setPageIdx` prop 의 시그니처에 이미 들어있다 (App.tsx 의 setPageIdx 래퍼가 selectedGuids 를 비움).
- I-PG5 Pages 섹션 자체도 collapsible — 헤더의 chevron 으로 접고 펼침. 기본 펼침. 접힘 상태는 컴포넌트 로컬 state, localStorage 비대상.
- I-PG6 페이지가 0개 (세션 없음) → "No document open" 한 줄 placeholder.
- I-PG7 상단바의 페이지 Select 는 본 spec 도입과 함께 **삭제**한다 — Pages 섹션이 유일한 페이지 전환 surface (Figma 와 동일). 상단바에는 nodeCount/페이지수 요약 텍스트만 남는다.

### 4.1 Data source (Layer Tree)
- I-F1 입력 = `currentPage` (App 의 `pages[pageIdx]`). 트리는 `currentPage.children` 의 재귀 렌더.
- I-F2 페이지 전환 시 (`pageIdx` 변경) 트리는 자동으로 새 페이지의 children 으로 다시 렌더. 이전 페이지의 expand 상태는 **버린다** (페이지별 따로 유지하지 않음 — Figma 도 동일).

### 4.2 Row content
각 행 (`LayerRow`):
- 들여쓰기 = `depth * 12px` (왼쪽 padding).
- chevron (`ChevronRight` / `ChevronDown` from lucide) — 자식이 있으면 표시, 클릭으로 expand/collapse. 자식이 없으면 자리만 차지 (정렬 유지).
- 타입 아이콘 — 노드 type 별:
  - `FRAME` / `GROUP` / `CANVAS` → `Square`
  - `TEXT` → `Type`
  - `RECTANGLE` / `ELLIPSE` / `LINE` / `STAR` / `VECTOR` / `BOOLEAN_OPERATION` → `Shapes`
  - `INSTANCE` → `Component` (아이콘은 lucide `Component` 또는 fallback `Square`)
  - `SYMBOL` / `COMPONENT` / `COMPONENT_SET` → `Component`
  - 그 외 → `Square`
- 이름 (`node.name`). 빈 이름은 `<unnamed>` (muted-foreground 색).
- I-F3 visibility 토글 / lock 은 v1 에서 비대상 (UI 없음). type 아이콘 + 이름만.
- I-F3.5 **Variant 배지** — 노드가 variant container (newer `COMPONENT_SET` 또는 legacy FRAME/SYMBOL 로 ≥2개의 `key=value` 이름 SYMBOL/COMPONENT 자식을 가진 경우) 이면 이름 옆에 `(N)` 형식의 작은 muted 텍스트 배지를 표시한다. 검출 함수 = `countVariantChildren` (`web/client/src/lib/variants.ts`). 0 이면 배지 생략. `메타리치 화면 UI Design.fig` 의 "Button" 같은 legacy 컨테이너에서도 작동하도록 하기 위함.

### 4.3 Expand / Collapse
- I-F4 expand 상태는 `Set<guidStr>` 컴포넌트 로컬 state. 페이지 전환 시 비운다 (I-F2).
- I-F5 chevron 클릭은 행 클릭과 분리 — chevron 만 expand 토글, 행 본체 클릭은 selection.
- I-F6 자식 0개 노드는 chevron 없음 — `children.length === 0 && _renderChildren?.length` 도 안 보여줌 (instance 의 master 자손은 트리에 노출하지 않음 — Figma 동일).
- I-F7 모든 노드는 기본 collapsed. depth 0 (페이지 직속 자식) 만 처음부터 보인다.

### 4.4 Selection sync
- I-F8 행 클릭 → `onSelect(guidStr, 'replace')`. App 의 `handleSelect` 호출 (Canvas 가 사용하는 것과 동일).
- I-F9 Shift+클릭 → `onSelect(guidStr, 'toggle')`.
- I-F10 `selectedGuids.has(guidStr)` 인 행은 `bg-accent` (선택 배경). hover 는 `hover:bg-accent/50`.
- I-F11 캔버스에서 선택 변경 → `selectedGuids` prop 변경 → 트리 리렌더 → 해당 행 하이라이트.
- I-F11.5 **Auto-reveal** (Figma "left layer" 동작): `selectedGuids` 변경 (이전 → 현재 셋이 다름) 시, 트리는 모든 selected guid 의 ancestor chain (`guidStr[]`) 을 expand 집합에 *추가* 한다. 기존 expand 상태는 보존 — collapse 가 풀리는 게 아니라 부족한 ancestor 만 채워 넣음.
- I-F11.5b **Variant container self-expand**: 선택된 노드가 variant container (`countVariantChildren(node) > 0`) 이면 그 guid 도 expand 집합에 추가 — variants 가 즉시 펼쳐져 보이도록. Figma 가 SET 을 기본 펼쳐 두는 동작과 일치. variant container 가 *아닌* 일반 FRAME 등은 self-expand 하지 않음 (트리 폭발 방지).
- I-F11.6 첫 selected row 의 DOM 요소를 `scrollIntoView({ block: 'nearest', behavior: 'auto' })` 로 viewport 안으로 끌어온다. expand 커밋 직후 (effect 의 다음 microtask 이후) 1회. behavior: 'auto' 는 jsdom / e2e 환경에서 결정적.
- I-F11.7 사용자가 직접 chevron 으로 collapse 한 경우, 다음 `selectedGuids` 변경이 일어나기 전까지 그 collapse 는 유지된다 — 즉 ancestor 자동 expand 는 selectedGuids 의 *deps 변경* 에만 트리거된다 (effect dep 가 selectedGuids 한정). 같은 selection 으로 트리 자체가 리렌더되어도 자동 expand 가 다시 실행되지 않으므로 사용자 manual collapse 가 살아남는다.
- I-F11.8 selection 이 비어있으면 (`selectedGuids.size === 0`) auto-reveal 은 no-op — expand 집합 변경 / 스크롤 없음.

### 4.5 Performance
- I-F12 collapse-by-default 정책으로 첫 렌더는 depth 0 만 — 메타리치 샘플의 첫 페이지 직속 자식 수 (~수십) 로 시작. virtualization 없이 충분.
- I-F13 펼친 노드의 자식 수가 1000+ 인 케이스는 측정 후 v2 에서 `react-window` 도입 결정. v1 은 가드 없음 — 사용자가 펼쳐서 멈추면 측정 트리거.

## 5. Assets 탭

### 5.1 Data source
- I-A1 입력 = 전체 `doc` (모든 페이지). `useMemo` 로 한 번만 walk.
- I-A2 결과 = 평면 `Asset[]` 배열, 각 항목 `{guid: string, name: string, type: string, pageIdx: number, pageName: string}`.
- I-A3 포함 type: `SYMBOL`, `COMPONENT`, `COMPONENT_SET`. 그 외 모두 무시.
- I-A4 정렬: 이름 ascending (case-insensitive). 동일 이름 내 type 순서는 유지 (stable sort).

### 5.2 Search
- I-S1 shadcn `<Input />` 검색바. placeholder = `"Search assets..."`.
- I-S2 매치 = case-insensitive substring (`name.toLowerCase().includes(q.toLowerCase())`). 정규식 / 와일드카드 / 다국어 토큰화 비대상.
- I-S3 빈 검색어 → 전체 보임. 매치 없음 → "No assets match" placeholder.
- I-S4 디바운스 없음 — 메타리치 sample 의 `Asset[]` 길이는 ~1500 정도이며 substring 필터는 frame budget 안에서 끝남.

### 5.3 Row content
- 타입 아이콘 (`Component` from lucide) + 이름.
- 보조 정보: 페이지 이름 (muted, text-xs, 오른쪽 정렬). 어느 페이지에 정의되어 있는지 단서 제공.
- I-AS1 썸네일 미리보기는 v1 비대상. 타입 아이콘만.

### 5.4 Click behavior
- I-AC1 행 클릭 → `setPageIdx(asset.pageIdx)` + `onSelect(asset.guid, 'replace')`. 같은 페이지면 page 변경 무시.
- I-AC2 클릭 후 검색어는 유지 (사용자가 다른 asset 도 시험할 수 있도록).
- I-AC3 클릭 시 캔버스 자동 pan-to 는 v1 비대상.

## 6. Chat 탭

- I-C1 기존 `ChatPanel` 컴포넌트를 그대로 hosting. props (`sessionId`, `selectedGuid`, `onChange`) 는 `LeftSidebar` 가 받아 forward. 내부 동작 / API / 모델 선택 / auth 모드는 변경 없음.
- I-C2 탭 미활성 시 unmount 되지 않으므로 (I-T5) 채팅 메시지 상태 / 입력 중 텍스트 / 모델 선택 / 인증 토큰은 보존된다.
- I-C3 채팅 탭은 항상 보인다 — 세션 없을 때도 (`ChatPanel` 자체가 그 케이스를 자체 처리).

## 7. Props contract

```ts
interface LeftSidebarProps {
  // Document state
  doc: any | null;                  // root DOCUMENT node (used by AssetList walk)
  pages: Array<{ name: string; children?: any[] }>;
  pageIdx: number;
  setPageIdx: (idx: number) => void;
  currentPage: any | null;          // pages[pageIdx]
  // Selection
  selectedGuids: Set<string>;
  onSelect: (guid: string | null, mode?: 'replace' | 'toggle') => void;
  // Chat (forwarded verbatim to ChatPanel)
  sessionId: string | null;
  selectedGuidForChat: string | null;
  onDocChange: () => void;
}
```

## 8. Error / Edge cases

- I-E1 `doc === null` (세션 없음) → 모든 탭에서 "No document open" placeholder. localStorage 의 마지막 탭은 그대로 복원 시도하되 빈 본문이라 사용자에게 차이 없음.
- I-E2 `currentPage === undefined` (`pageIdx` 가 `pages.length` 초과) → Files 탭만 placeholder. Assets / Chat 영향 없음.
- I-E3 `node.name === ''` 또는 `null` → `<unnamed>` 표시 (muted).
- I-E4 트리에서 무한 cycle (`parentIndex` 손상으로 자식이 조상을 가리킴) — 발생 시 React maxDepth 도달로 throw. v1 은 가드 없음 (실제 .fig 데이터에서 본 적 없음).

## 9. 비대상 (v1)

- 페이지 셀렉터를 사이드바로 이전 — 현재 상단바 위치 유지 (App.tsx:297). v2.
- 레이어 visibility / lock 토글 UI.
- 레이어 우클릭 컨텍스트 메뉴 (이름 변경 / 삭제 / 복제).
- 트리 가상화 (react-window).
- Asset 썸네일 미리보기.
- Asset 클릭 시 캔버스 zoom-to-fit (선택 + 페이지 이동만 v1).
- 사이드바 collapse / resize.
- 다국어 검색 (한글 자모 분리, fuzzy match) — substring 만.
- 다중 선택 시 auto-reveal 의 스크롤 대상 — *첫 번째* selected row 만 scrollIntoView (전체를 한 viewport 에 fit 하는 동작은 v2).

## 10. Resolved questions

- **탭 위치 (top vs side)** — top tabs (가로) — Inspector 가 같은 패턴 (`Inspector.tsx:121`). 일관성 우선.
- **chat 을 third tab vs slide-over** — third tab. drawer 는 추가 컴포넌트 + 상태 + 키 단축키 필요. v1 단순함 우선.
- **asset scope (current page vs all pages)** — all pages. Figma 동일 + 메타리치 사용 패턴 (페이지별로 master 분산).
- **트리 expand 상태 페이지별 보존** — 보존 안 함. Figma 도 페이지 전환 시 트리 reset. 메모리/복잡도 감소.
- **selection prop drilling vs 외부 store** — props drilling. 기존 App→Canvas 패턴과 동일. SelectionStore 를 sidebar 까지 확장하는 건 v2 (현재 SelectionStore 는 Canvas-internal).
