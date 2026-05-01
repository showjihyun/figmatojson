# ARCHITECTURE — Clean + Hexagonal target

| 항목 | 값 |
|---|---|
| 문서 버전 | v0.1 (Phase 0 산출물) |
| 작성일 | 2026-05-02 |
| 적용 대상 | `web/` (서버 + 클라이언트). `src/` CLI는 추후 별도 phase |
| 자매 문서 | [HARNESS.md](./HARNESS.md), [SDD.md](./SDD.md) |

---

## 1. 목표

> 현재 단일 1234줄 `server/index.ts`와 비즈 로직이 컴포넌트 안에 산재한 React 클라이언트를, **Clean Architecture × Hexagonal Architecture(Ports & Adapters)** 로 재배치한다. 외부 의존(파일시스템, Anthropic SDK, Hono, React)을 도메인 코어에서 분리해 **유지보수성·테스트 용이성**을 높이고, [SDD.md](./SDD.md)/[HARNESS.md](./HARNESS.md)가 정의하는 SPEC→TEST→IMPL 사이클을 web 레이어에도 일관되게 적용한다.

비목표:
- `src/` CLI 재구조화 (별도 phase)
- 기존 동작/스펙 변경 (마이그레이션 = 이전, 기능 추가 아님)
- 한 번에 모든 코드 이동 (단계적, 회귀 가드 유지)

---

## 2. 현재 상태 (Phase 0 인벤토리)

### 2.1 LOC 분포 (web/)

```
server/index.ts            1234   ← 모놀리스: 라우팅 + 도메인 로직 + IO + SDK 호출
client/src/Canvas.tsx       878   ← Konva 렌더 + 이벤트 + 좌표 수학
client/src/Inspector.tsx    948   ← UI + 패치 디스패치 + 색/숫자 변환 + 컴포넌트 텍스트 모델
client/src/ChatPanel.tsx    543   ← UI + fetch + 인증 모드 + 모델 선택
client/src/App.tsx          344   ← 레이아웃 + onUpload/onSave/onMove* 오케스트레이션
client/src/hooks/usePatch.ts 77   ← 디바운스 패치 (이미 추출됨)
client/src/multiResize.ts   ~80   ← 그룹 리사이즈 수학 (이미 추출됨)
─────────────────────────────────
                           ≈4659  (UI 프리미티브 제외 본체)
```

### 2.2 의존성 흐름 — 현재 (간소화)

```
Hono routes ── readFileSync ── tmpdir/figrev-web-XXX/extracted/...
            ── repack() ────── ../../src/repack.ts
            ── decodeFigCanvas — ../../src/decoder.ts
            ── @anthropic-ai/sdk
            ── @anthropic-ai/claude-agent-sdk
            ── tokenizePath/setPath/findById  (인라인 정의)
            ── summarizeDoc                    (인라인 정의)

React (App.tsx)
   ├── api.ts (fetch wrapper)
   ├── Canvas.tsx ── Konva ── (paint helpers 인라인)
   ├── Inspector.tsx ── usePatch ── api.ts
   └── ChatPanel.tsx ── fetch /api/chat ── localStorage
```

문제:
- 라우트 핸들러가 도메인 로직(트리 mutation, 색 변환)과 IO(fs)와 외부 SDK 호출을 한 함수에서 처리 → 단위 테스트 불가
- React 컴포넌트가 직접 `fetch()` → 컴포넌트 테스트 시 네트워크 모킹 필요
- 같은 도메인 개념(예: GUID 변환, 색 RGBA→hex)이 클라이언트와 서버 양쪽에 중복 정의

---

## 3. 목표 상태

### 3.1 레이어 다이어그램

```
┌─────────────────────────────────────────────────────────────────────┐
│  driving adapters (어떻게 application을 호출하는가)                    │
│   web/server/adapters/driving/http/        — Hono routes (얇은 shell)│
│   web/client/src/services/                 — React 훅 / service 계층  │
│   src/cli.ts (변경 없음, 추후 phase)                                   │
├─────────────────────────────────────────────────────────────────────┤
│  application/ (use case = 오케스트레이션)                              │
│   web/core/application/                                              │
│     UploadFig.ts          ports: SessionStore, Decoder               │
│     EditNode.ts           ports: SessionStore                        │
│     OverrideInstanceText  ports: SessionStore                        │
│     ResizeNode            ports: SessionStore                        │
│     ExportFig.ts          ports: SessionStore, Repacker              │
│     LoadSnapshot          ports: SessionStore, Decoder               │
│     SaveSnapshot          ports: SessionStore                        │
│     RunChatTurn           ports: SessionStore, ChatAdapter, Tools    │
│     ServeAsset            ports: SessionStore, AssetServer           │
├─────────────────────────────────────────────────────────────────────┤
│  ports/ (인터페이스 — application이 정의, adapters가 구현)              │
│   web/core/ports/                                                    │
│     SessionStore.ts       세션 라이프사이클 + 디렉터리 + 정리            │
│     Decoder.ts            bytes → Document                           │
│     Repacker.ts           Document + extracted/ → bytes              │
│     AssetServer.ts        (sessionId, hash) → bytes + mime           │
│     ChatAdapter.ts        prompt + tools → assistantText + actions   │
│     ToolDispatcher.ts     tool name + args → side effects on Document│
├─────────────────────────────────────────────────────────────────────┤
│  domain/ (순수 — IO/framework 의존성 0)                                │
│   web/core/domain/                                                   │
│     entities/             Document, Node, ImageRef, Session 타입      │
│     path.ts               tokenizePath, setPath, getPath              │
│     tree.ts               findById, walk, eachDescendant              │
│     color.ts              rgbaToHex, hexToRgb01, rgba string          │
│     image.ts              imageHashHex, sniffImageMime                │
│     mutation.ts           setText, resize, applyInstanceOverride      │
│     summary.ts            summarizeDoc (LLM 컨텍스트)                  │
├─────────────────────────────────────────────────────────────────────┤
│  driven adapters (외부 의존성 구현체 — application/ports를 import)      │
│   web/server/adapters/driven/                                        │
│     FsSessionStore.ts     mkdtempSync + readFileSync + ZIP 풀이        │
│     KiwiCodec.ts          ../../src/decoder + ../../src/repack wrap   │
│     FsAssetServer.ts      현재 GET /api/asset 구현 흡수                │
│     AnthropicChat.ts      api-key path                                │
│     AgentSdkChat.ts       subscription path (90s timeout 포함)         │
│     InProcessTools.ts     applyTool 디스패처 (set_text 등)             │
└─────────────────────────────────────────────────────────────────────┘

   의존성 화살표: 안쪽으로만.
   - domain은 누구도 import하지 않음 (zero deps)
   - application은 ports와 domain만 import
   - adapters는 ports를 구현 + 외부 라이브러리 사용
   - driving adapters는 application을 호출
```

### 3.2 디렉터리 구조 (목표)

```
web/
├─ core/                          ← 새 (프레임워크 무관)
│  ├─ domain/
│  │  ├─ entities/Document.ts, Node.ts, Session.ts
│  │  ├─ path.ts
│  │  ├─ tree.ts
│  │  ├─ color.ts
│  │  ├─ image.ts
│  │  ├─ mutation.ts
│  │  └─ summary.ts
│  ├─ ports/
│  │  ├─ SessionStore.ts
│  │  ├─ Decoder.ts
│  │  ├─ Repacker.ts
│  │  ├─ AssetServer.ts
│  │  ├─ ChatAdapter.ts
│  │  └─ ToolDispatcher.ts
│  └─ application/
│     ├─ UploadFig.ts, EditNode.ts, ResizeNode.ts, ...
│     └─ RunChatTurn.ts
├─ server/
│  ├─ index.ts                    ← 얇아짐: 라우터만 wiring
│  └─ adapters/
│     ├─ driving/http/
│     │  ├─ uploadRoute.ts
│     │  ├─ docRoute.ts
│     │  ├─ saveRoute.ts
│     │  ├─ chatRoute.ts
│     │  └─ assetRoute.ts
│     └─ driven/
│        ├─ FsSessionStore.ts
│        ├─ KiwiCodec.ts
│        ├─ FsAssetServer.ts
│        ├─ AnthropicChat.ts
│        ├─ AgentSdkChat.ts
│        └─ InProcessTools.ts
├─ client/
│  └─ src/
│     ├─ services/                ← 새 (네트워크/상태 추상화)
│     │  ├─ docService.ts
│     │  ├─ chatService.ts
│     │  └─ sessionService.ts
│     ├─ hooks/                   ← 기존 + 신규 (usePatch, useDoc, ...)
│     ├─ App.tsx, Canvas.tsx, Inspector.tsx, ChatPanel.tsx
│     └─ components/ui/           ← shadcn 그대로
```

---

## 4. 모듈 매핑 표 (현재 → 목표)

| 현재 위치 | 목표 위치 | 이동 사유 |
|---|---|---|
| `server/index.ts:tokenizePath/setPath` | `core/domain/path.ts` | 순수, 클라이언트와 공유 가능 |
| `server/index.ts:findById/findNode` | `core/domain/tree.ts` | 중복 제거 + 순수 |
| `server/index.ts:summarizeDoc` | `core/domain/summary.ts` | LLM 컨텍스트 빌더 — 순수 |
| `server/index.ts:sniffImageMime` | `core/domain/image.ts` | 순수, 클라이언트도 잠재적 사용 |
| `server/index.ts:repack/decode 호출` | `adapters/driven/KiwiCodec.ts` | `../../src/` wrap |
| `server/index.ts:mkdtemp/readFile/save 흐름` | `adapters/driven/FsSessionStore.ts` | IO 격리 |
| `server/index.ts:GET /api/asset 핸들러` | `application/ServeAsset.ts` + `adapters/driving/http/assetRoute.ts` | 비즈+IO 분리 |
| `server/index.ts:POST /api/chat (subscription)` | `application/RunChatTurn.ts` + `adapters/driven/AgentSdkChat.ts` | 비즈+SDK 분리 |
| `server/index.ts:POST /api/chat (api-key)` | 동상 + `adapters/driven/AnthropicChat.ts` | 비즈+SDK 분리 |
| `server/index.ts:applyTool` | `adapters/driven/InProcessTools.ts` (구현) + `core/ports/ToolDispatcher.ts` (계약) | port + adapter 분리 |
| `client/src/Inspector.tsx:rgbaToHex/hexToRgb01` | `core/domain/color.ts` | Canvas와 중복 — 단일화 |
| `client/src/Canvas.tsx:imageHashHex` | `core/domain/image.ts` | 같은 헬퍼, 다른 호출자 |
| `client/src/Canvas.tsx:colorOf/strokeOf/guidStr` | `core/domain/color.ts` + `core/domain/tree.ts` | 순수 |
| `client/src/api.ts (fetch wrapper)` | `client/src/services/*Service.ts` | 컴포넌트가 직접 호출 안 하도록 |
| `client/src/hooks/usePatch.ts` | 그대로 (이미 적합한 위치) | — |
| `client/src/multiResize.ts` | 그대로 (이미 추출됨) | — |
| Hono routes (모든 `app.get/post/patch`) | `adapters/driving/http/*Route.ts`로 분할 | `index.ts`는 wiring만 |

---

## 5. 마이그레이션 phase (Phase 0~7 전체 — 본 문서는 Phase 0)

| Phase | 산출물 | 상태 |
|---|---|---|
| **0** | 본 문서 (`ARCHITECTURE.md`) | 진행 중 |
| **1** | `web/core/ports/*.ts` 6개 (인터페이스만) | 미시작 |
| **2** | `web/core/domain/*.ts` (순수 헬퍼 추출 + shim) | 미시작 |
| 3 | `web/server/adapters/driven/*.ts` (FsSessionStore부터) | 후속 결정 |
| 4 | `web/core/application/*.ts` (use case) | 후속 결정 |
| 5 | `web/server/adapters/driving/http/*.ts` (Hono 라우트 분할) | 후속 결정 |
| 6 | `web/client/src/services/*.ts` | 후속 결정 |
| 7 | SDD/Harness 정착: `docs/specs/web-*.spec.md` + L0/L1 테스트 | 후속 결정 |

**Phase 3 진입은 Phase 0~2 완료 후 사용자 검토**.

---

## 6. 호환성 / 회귀 가드

이번 phase 범위(0~2) 동안 지켜야 할 invariant:
1. 8 unit + 7 e2e + typecheck + production build 통과 유지
2. `tokenizePath` / `setPath` 등의 함수 시그니처 변화 없음 (re-export shim으로 호환)
3. 외부 동작(/api/* 응답) 변화 없음
4. 의존성 변화는 dev-deps 추가만, 런타임 deps 추가 0

Phase 3 이후에는 동작 동등성을 [HARNESS.md](./HARNESS.md) Layer 0~3가 보증한다.

---

## 7. 결정 (이번 phase 한정)

| 결정 | 값 | 사유 |
|---|---|---|
| 새 코드 위치 | `web/core/` (web 트리 안) | `src/`는 CLI 전용으로 유지. 추후 phase에서 통합 검토 |
| Port 정의 위치 | `web/core/ports/` | application이 ports의 owner |
| Domain 의존성 | 0 (no React, no Node fs, no SDK) | 테스트 격리·재사용성 보장 |
| Shim 전략 | 기존 import 경로는 re-export로 유지 | Phase 2 회귀 0 |
| `src/` 재배치 | 본 phase 비대상 | 별도 RFC 후 진행 |
