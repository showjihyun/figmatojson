# spec/web-resize-node

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 7) |
| 구현 | `web/core/application/ResizeNode.ts` |
| 테스트 | `web/core/application/ResizeNode.test.ts` |

## 1. 목적

`transform.m02/m12` (위치) + `size.x/y` (크기) 를 한 번에 atomic 하게 갱신한다. 캔버스 리사이즈 핸들이 드래그 끝에 한 번 호출하면, 디스크의 message.json은 한 번의 일관된 상태로 기록된다 — 두 PATCH로 쪼개면 발생할 수 있는 "가운데가 깨진" 상태가 없다.

## 2. Input / Output

```ts
input  = { sessionId: string, guid: string, x: number, y: number, w: number, h: number }
output = { ok: true }
```

## 3. Invariants

- I-1 단일 write로 `transform.m02 = x`, `transform.m12 = y`, `size = {x: max(1,w), y: max(1,h)}` 가 message.json 에 모두 적용됨
- I-2 in-memory documentJson 의 동일 노드도 같은 4 값을 갖도록 mirror
- I-3 `w` 또는 `h`가 0 이하인 경우 1로 클램프 (Konva가 음수 크기를 그리지 않도록)
- I-4 다른 transform 채널(m00/m01/m10/m11)은 변경되지 않음 (회전/스큐 보존)

## 4. Error cases

- 세션 미존재 → `NotFoundError`
- 노드 미존재 → `NotFoundError`

## 5. 비대상

- 다중 노드 동시 리사이즈 (App.tsx의 `onResizeMany` 가 본 use case를 N번 호출)
- aspect-ratio 잠금
- 회전 적용 (현 PoC: 직각 사각형만)

## 6. 라우팅 결합

`POST /api/resize/:id`. body = `{nodeGuid, x, y, w, h}`.
