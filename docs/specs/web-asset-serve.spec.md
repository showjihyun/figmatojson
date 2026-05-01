# spec/web-asset-serve

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 7) |
| 구현 | `web/core/application/ServeAsset.ts` + `web/server/adapters/driven/FsAssetServer.ts` |
| 테스트 | `web/core/application/ServeAsset.test.ts` |

## 1. 목적

세션 안의 이미지 fillPaint 를 캔버스가 렌더할 수 있도록 raw 바이트로 서빙한다. URL 키는 Figma 가 사용하는 20-byte SHA-1 의 lowercase hex.

## 2. Input / Output

```ts
input  = { sessionId: string, hashHex: string }
output = { bytes: Uint8Array, mime: string }
```

## 3. Invariants

- I-1 `hashHex` 가 정확히 40자 lowercase hex 가 아니면 `ValidationError` (path traversal 방지)
- I-2 세션 디렉터리의 `extracted/01_container/images/<hashHex>` 가 존재하지 않으면 `NotFoundError`
- I-3 `output.mime` 은 magic-byte sniff 결과 (PNG / JPEG / GIF / WebP) 또는 `application/octet-stream`
- I-4 `output.bytes` 는 디스크 파일과 byte-identical (read-only)

## 4. Error cases

- `hashHex` 형식 위반 → `ValidationError`
- 세션 미존재 OR 파일 미존재 → `NotFoundError`

## 5. 비대상

- 이미지 변환 (resize, format conversion)
- 권한/인증
- CDN 캐싱 (라우팅 레이어가 `Cache-Control: private, max-age=3600` 헤더 추가)

## 6. 라우팅 결합

`GET /api/asset/:id/:hash`. 응답은 `Content-Type: <sniffed mime>` + `Cache-Control: private, max-age=3600`.
