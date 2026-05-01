# spec/web-snapshot

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 7) |
| 구현 | `web/core/application/SaveSnapshot.ts` + `LoadSnapshot.ts` |
| 테스트 | e2e (`web/e2e/upload-edit-save.spec.ts: session snapshot save → load round-trips edits`) |

## 1. 목적

편집 도중 상태를 .fig export 없이 JSON 한 파일로 저장/복원한다. 사용자가 작업을 중단하고 나중에 같은 시점부터 이어서 편집할 수 있게 한다 (사용자가 원본 .fig 를 다시 업로드할 필요 없음).

## 2. Snapshot 포맷 (v1)

```ts
interface SnapshotV1 {
  version: 1
  origName: string
  archiveVersion: number
  archiveInfo: object | null
  schemaBinB64: string | null    // base64 of extracted/03_decompressed/schema.kiwi.bin
  messageJson: string            // raw JSON of extracted/04_decoded/message.json
  sidecars: Array<{name: string, b64: string}>  // 01_container/*
}
```

JSON-portable — base64 binary 사이드카는 그대로 ZIP 내부 파일을 보존한다 (이미지 등).

## 3. SaveSnapshot Invariants

- I-1 출력 `version === 1`
- I-2 `messageJson` 은 `extracted/04_decoded/message.json` 의 현재 내용 그대로 (편집 반영됨)
- I-3 `schemaBinB64` 가 있으면 디코드 시 `Buffer.from(s, 'base64')` 가 정확히 원본 schema.kiwi.bin 바이트를 복원
- I-4 `sidecars[].name` 은 `01_container/` 기준 상대 경로 (예: `images/abc123...`, `meta.json`)

## 4. LoadSnapshot Invariants

- I-5 `version !== 1` → `ValidationError`
- I-6 새 working dir이 mkdtemp로 생성되고 `extracted/` 하위가 SaveSnapshot 생성 시점과 byte-identical
- I-7 새 sessionId 가 발급되고 `SessionStore.getById` 로 조회 가능
- I-8 LoadSnapshot 후 `ExportFig.execute` 가 정상 반환 (저장 시점의 편집이 export에 반영됨, e2e가 검증)

## 5. Error cases

- SaveSnapshot: 세션 미존재 → `NotFoundError`. message.json 누락 → `Error` (스냅샷이 무의미)
- LoadSnapshot: `version !== 1` → `ValidationError`. fs 에러 → `Error` 전파, 임시 디렉터리 정리

## 6. 비대상

- 압축 (현 v1: 평문 base64 — 메타리치 .fig 1개에 ~50MB JSON. 압축은 v2 후보)
- 다중 사용자 공유 (서명/암호화 없음)
- 부분 스냅샷 (현 v1: 항상 전체)

## 7. 라우팅 결합

- `GET /api/session/:id/snapshot` → SaveSnapshot.execute
- `POST /api/session/load` (body = SnapshotV1) → LoadSnapshot.execute
