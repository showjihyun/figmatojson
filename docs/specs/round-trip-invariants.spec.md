# spec/round-trip-invariants

| 항목 | 값 |
|---|---|
| 상태 | Approved (Iteration 10) |
| 책임 | 본 spec의 Invariants를 코드로 검증하는 하네스 — `test/harness/roundtrip.harness.test.ts` |
| 의존 | 모든 다른 spec (editable-html, sidecar-meta, html-to-message, text-segments, parent-index-position) |
| 부모 SPEC | [SPEC-roundtrip §8](../SPEC-roundtrip.md) · [HARNESS.md L2](../HARNESS.md) |

## 1. 목적

본 spec은 **양방향 round-trip 시 보존되어야 하는 invariant들**을 모아놓은 catalog다. 각 invariant는 [HARNESS.md](../HARNESS.md)의 Layer 2 자동 검증으로 코드 표현된다.

> "이 invariant 중 하나라도 깨지면 v2 round-trip이 실패다." — Iron Law

## 2. 검증 대상 사이클

```
원본 .fig
  ↓ (1) extract → tree, decoded, container, output/
  ↓ (2) editable-html → figma.editable.html
  ↓ (3) sidecar-meta → figma.editable.meta.js
  ↓ (4) [편집 없이] html-to-message → 새 message
  ↓ (5) repack (kiwi mode) → 새 .fig
  ↓ (6) extract → tree', decoded', container'
  ↓ (7) compare(tree, tree') → invariants 검증
```

각 단계는 별도 spec에 있고, 본 spec은 **(7) compare**의 명시적 invariant 모음.

## 3. 핵심 Invariants

### I-1 GUID 집합 동등 (Identity Preservation)

```ts
const a = new Set([...tree.allNodes.keys()]);
const b = new Set([...tree2.allNodes.keys()]);
expect(symmetricDifference(a, b)).toEqual(new Set());
```

- 모든 35,660 GUID가 round-trip 후 그대로 등장
- 손실율 0%

### I-2 부모-자식 관계 동등 (Tree Shape)

```ts
function shape(t: BuildTreeResult): Map<string, string | null> {
  return new Map([...t.allNodes.values()].map(n => [
    n.guidStr,
    n.parentGuid ? guidKey(n.parentGuid) : null
  ]));
}
expect(shape(tree2)).toEqual(shape(tree));
```

- 각 노드의 부모 GUID가 동일

### I-3 형제 순서 동등 (Sibling Order)

```ts
function siblingOrder(t: BuildTreeResult): Map<string, string[]> {
  const m = new Map();
  for (const n of t.allNodes.values()) {
    m.set(n.guidStr, n.children.map(c => c.guidStr));  // children은 이미 position 정렬됨
  }
  return m;
}
expect(siblingOrder(tree2)).toEqual(siblingOrder(tree));
```

- 같은 부모의 자식 순서가 동등

### I-4 Schema 정의 보존

```ts
expect(decoded2.schemaStats.definitionCount).toBe(decoded.schemaStats.definitionCount);
expect(definitionNames(decoded2.schema)).toEqual(definitionNames(decoded.schema));
```

- 568 정의 모두 보존
- 정의 이름 집합 동등

### I-5 Archive version 보존

```ts
expect(decoded2.archiveVersion).toBe(decoded.archiveVersion);
```

- v106 → v106

### I-6 message rootType 보존

```ts
expect(decoded2.message.type).toBe(decoded.message.type);
expect(decoded2.message.type).toBe('NODE_CHANGES');
```

### I-7 이미지 hash 보존

```ts
const a = new Set([...container.images.keys()]);
const b = new Set([...container2.images.keys()]);
expect(b).toEqual(a);

// 각 이미지의 byte 동등 (sha256)
for (const hash of a) {
  const sha1 = sha256(container.images.get(hash));
  const sha2 = sha256(container2.images.get(hash));
  expect(sha1).toBe(sha2);
}
```

### I-8 Vector 개수 보존

```ts
const v1 = countVectorNodes(tree);
const v2 = countVectorNodes(tree2);
expect(v2).toBe(v1);  // 1599
```

### I-9 노드별 raw 키 집합 동등 (Tier C 제외)

각 노드의 raw 필드 키 집합이 round-trip 후 동등 (단, `parentIndex.position`은 재계산되어 값은 다를 수 있으나 key 자체는 보존).

```ts
const TIER_C = new Set(['guid', 'parentIndex', 'phase']);

for (const guid of guids) {
  const original = rawKeys(tree.allNodes.get(guid)!.data);
  const restored = rawKeys(tree2.allNodes.get(guid)!.data);
  
  const o = original.filter(k => !TIER_C.has(k));
  const r = restored.filter(k => !TIER_C.has(k));
  expect(new Set(r)).toEqual(new Set(o));
}
```

(단순화 단계: Tier A·B 모든 raw 필드 보존을 검증)

### I-10 노드별 시각 핵심 필드 byte 동등

핵심 시각 필드(size, transform, fillPaints, cornerRadius)는 byte-level 동등.

```ts
const VISUAL_FIELDS = ['size', 'transform', 'fillPaints', 'strokePaints',
                       'cornerRadius', 'cornerRadii', 'opacity', 'visible',
                       'effects', 'blendMode'];

for (const guid of guids) {
  for (const field of VISUAL_FIELDS) {
    const a = (tree.allNodes.get(guid)!.data as any)[field];
    const b = (tree2.allNodes.get(guid)!.data as any)[field];
    expect(b).toEqual(a);  // deep equal
  }
}
```

### I-11 TEXT segment 보존

```ts
for (const node of textNodes(tree)) {
  const a = node.data;
  const b = tree2.allNodes.get(node.guidStr)!.data;
  expect(b.characters).toBe(a.characters);
  expect(b.characterStyleIDs).toEqual(a.characterStyleIDs);
  expect(b.styleOverrideTable).toEqual(a.styleOverrideTable);
}
```

### I-12 Sidecar (Tier B) 필드 보존

다음 Tier B 필드들이 byte-level 동등:

```ts
const TIER_B_FIELDS = ['layoutGrids', 'interactions', 'componentPropertyDefinitions',
                       'componentPropertyReferences', 'variantProperties',
                       'pluginData', 'sharedPluginData', 'mainComponent',
                       'overrides', 'handoffStatusMap', 'connectorStart',
                       'connectorEnd', 'transitionInfo', 'transitionDuration'];

for (const guid of guids) {
  for (const field of TIER_B_FIELDS) {
    const a = (tree.allNodes.get(guid)!.data as any)[field];
    const b = (tree2.allNodes.get(guid)!.data as any)[field];
    expect(b).toEqual(a);
  }
}
```

### I-13 결정성 (Determinism)

같은 입력 → 같은 출력 (시퀀스 5번 반복).

```ts
const results = Array(5).fill(0).map(() =>
  sha256(roundTrip(SAMPLE).new_fig_bytes)
);
expect(new Set(results).size).toBe(1);
```

### I-14 Schema sha256 동등

```ts
const a = sha256(decoded.rawSchemaBytes);
const b = sha256(decoded2.rawSchemaBytes);
expect(b).toBe(a);
```

(우리는 schema를 변경하지 않으므로)

### I-15 Verification report PASS

기존 V-01 ~ V-08 + 신규 V-09 ~ V-15 모두 PASS.

```ts
const verify = runVerification({...});
expect(verify.overall).toBe('PASS');
```

## 4. 편집 시나리오 invariants (Layer 3)

위 I-1 ~ I-15는 **편집 없는 round-trip**. 사용자 편집 시나리오에서 추가 invariant:

### EI-1 텍스트 교체 (E1)

```
htmlEdit: 모든 <p class="fig-text"> innerText에 "PREFIX " prepend
roundTrip → 새 .fig

invariant: ∀ TEXT 노드:
   new.characters.startsWith("PREFIX ")
   ∧ new.characters.length === old.characters.length + "PREFIX ".length
```

### EI-2 색상 swap (E2)

```
htmlEdit: 모든 background-color rgb의 R↔B swap

invariant: ∀ SOLID fill:
   new.color.r === old.color.b
   ∧ new.color.b === old.color.r
   ∧ new.color.g === old.color.g
   ∧ new.color.a === old.color.a
```

### EI-3 좌표 평행 이동 (E3)

```
htmlEdit: top-level frame의 left += 100

invariant: top-level frame의 transform.m02:
   new.m02 === old.m02 + 100
```

### EI-4 사이즈 2배 (E4)

```
htmlEdit: 특정 노드의 width, height 2배

invariant: 그 노드의 size:
   new.size.x === old.size.x * 2
   new.size.y === old.size.y * 2
```

### EI-5 effects 추가 (sidecar 편집, Tier B)

```
sidecarEdit: 노드 raw.effects에 새 DROP_SHADOW 추가

invariant: 그 노드의 effects:
   new.effects.length === old.effects.length + 1
   ∧ new.effects[-1] is DROP_SHADOW
```

### EI-6 노드 삭제 (E6)

```
htmlEdit: <div data-figma-id="X"> 제거

invariant:
  ∃ nc ∈ new message.nodeChanges:
    nc.guid.string === "X" ∧ nc.phase === 'REMOVED'
  ∧ "X"의 자식들도 모두 phase REMOVED
```

### EI-7 rich text segment 변경 (E7, D-5)

```
htmlEdit: <span data-style-id="1"> 추가 (새 스타일)

invariant: TEXT 노드의:
   new.styleOverrideTable에 새 ID 등장
   ∧ new.characterStyleIDs[해당 character 범위] === 새 ID
```

## 5. 메트릭 임계 (Layer 2 합격 기준)

| 메트릭 | 임계 | 정책 |
|---|---|---|
| GUID 보존율 | 1.0 | < 1.0 → reject |
| Tree shape 동등 | 100% | 미동등 → reject |
| Schema 정의 보존율 | 1.0 | < 1.0 → reject |
| 시각 필드 동등 (I-10) | 100% | 미동등 → reject |
| Tier B 필드 동등 (I-12) | ≥ 0.99 | < 0.99 → warning |
| 결정성 | 1.0 | 변동 시 reject |

## 6. 실행 명령

```bash
# Layer 2 라운드트립 (편집 없음)
npm run harness:roundtrip

# Layer 3 편집 시뮬레이션
npm run harness:edit-sim

# 둘 다
npm run harness:all
```

각 명령은 `test/harness/<name>.harness.test.ts` 실행. 실패 시 어떤 invariant가 깨졌는지 명시.

## 7. 출력 형식 (실패 시)

```
🔴 Round-trip harness FAILED

Invariant: I-1 GUID set is identical
  Original GUIDs: 35,660
  Restored GUIDs: 35,659 (1 missing)

Missing GUIDs:
  - 627:8805 (VECTOR, "icon-arrow")

Hint: html-to-message.ts에서 fig-vector element를 처리하는지 확인하세요.
References:
  - spec/round-trip-invariants.md#i-1-guid-집합-동등
  - spec/html-to-message.md#i-1-guid-보존-100
```

## 8. 참조

- 부모: [HARNESS.md](../HARNESS.md), [SPEC-roundtrip.md §8](../SPEC-roundtrip.md)
- 메서드: 모든 다른 spec
