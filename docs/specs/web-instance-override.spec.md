# spec/web-instance-override

| 항목 | 값 |
|---|---|
| 상태 | Approved (Phase 7) |
| 구현 | `web/core/application/OverrideInstanceText.ts` |
| 테스트 | `web/core/application/OverrideInstanceText.test.ts` |

## 1. 목적

특정 INSTANCE 노드 안의 텍스트를 그 인스턴스에서만 다르게 보이게 한다. 마스터(원본 컴포넌트) 텍스트와 다른 인스턴스들은 영향 받지 않는다 — Figma의 "이 인스턴스만 텍스트 변경" UX 와 동일.

## 2. Input / Output

```ts
input = {
  sessionId: string,
  instanceGuid: string,      // INSTANCE 노드의 GUID
  masterTextGuid: string,    // 그 INSTANCE의 마스터 안에 있는 TEXT 노드의 GUID
  value: string,             // 새 텍스트
}
output = { ok: true }
```

## 3. Invariants

- I-1 INSTANCE의 `symbolData.symbolOverrides[]` 에 다음 entry가 존재 (없으면 push, 있으면 in-place 갱신):
  ```
  { guidPath: { guids: [{sessionID, localID}] },     // masterTextGuid 1-step path
    textData: { characters: value, lines: [PLAIN line]}}
  ```
- I-2 마스터 텍스트 노드(`masterTextGuid`)의 `textData.characters` 는 변경되지 않음
- I-3 동일 마스터를 참조하는 다른 INSTANCE 들의 textData 도 변경되지 않음 (per-instance override)
- I-4 in-memory documentJson 의 INSTANCE 노드에 `_instanceOverrides[masterTextGuid] = value` 가 추가되어, Inspector의 ComponentTextRow 가 즉시 override 표시

## 4. Error cases

- 세션 미존재 → `NotFoundError`
- INSTANCE 미존재 → `NotFoundError(\`INSTANCE \${id} not found\`)`
- `masterTextGuid` 가 `<num>:<num>` 형식이 아니면 → `ValidationError`

## 5. 비대상

- 다단 nested INSTANCE (현 PoC: single-step guidPath only)
- 텍스트 외 다른 필드 override (글꼴/색상)
- override 삭제 (호출자가 마스터 값으로 다시 호출하면 됨, 빈 문자열 override 도 가능)

## 6. 라우팅 결합

`POST /api/instance-override/:id`. body = `{instanceGuid, masterTextGuid, value}`.
