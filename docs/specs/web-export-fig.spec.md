# spec/web-export-fig

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 7) |
| 구현 | `web/core/application/ExportFig.ts` + `web/server/adapters/driven/KiwiCodec.ts` |
| 테스트 | `web/core/application/ExportFig.test.ts` |

## 1. 목적

세션의 현재 편집 상태를 Figma가 import 할 수 있는 `.fig` 바이트로 repack 한다. JSON 모드 repack — message.json 을 kiwi로 다시 인코드 + 사이드카(`01_container/*`)를 그대로 ZIP에 묶음.

## 2. Input / Output

```ts
input  = { sessionId: string }
output = {
  bytes: Uint8Array,
  origName: string,                                  // for download Content-Disposition
  filesReport: Array<{name: string, bytes: number}>, // round-trip diagnostics
}
```

## 3. Invariants

- I-1 모든 `EditNode` / `ResizeNode` / `OverrideInstanceText` PATCH 는 message.json에 즉시 기록되므로, ExportFig 호출 시점의 message.json 이 그대로 인코드된다 (편집 손실 0)
- I-2 `output.bytes` 는 valid ZIP — 첫 4 바이트가 `PK\x03\x04`
- I-3 ZIP 내부 `canvas.fig` + `meta.json` + `images/*` 가 모두 존재
- I-4 `output.bytes` 를 다시 `decodeFigCanvas` 로 디코드하면 같은 `nodeChanges` 카운트가 나옴 (e2e 회귀 테스트가 검증)

## 4. Error cases

- 세션 미존재 → `NotFoundError`
- repack 내부 오류 (예: schema 손상) → `Error` 그대로 전파

## 5. 비대상

- byte-level repack (편집 안 한 경우의 무손실 복제). 본 use case는 항상 JSON 모드.
- 압축 옵션 선택 (deflate-raw 고정)

## 6. 라우팅 결합

`POST /api/save/:id`. 응답은 `application/octet-stream` + RFC 5987 `filename*=UTF-8''<encoded>-edited.fig` 헤더로 직접 다운로드. Content-Disposition 인코딩은 라우팅 레이어 책임 (도메인은 origName만 노출).
