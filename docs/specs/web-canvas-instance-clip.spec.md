# spec/web-canvas-instance-clip

| 항목 | 값 |
|---|---|
| 상태 | Approved |
| 구현 | `web/client/src/Canvas.tsx` (`wantClip` 조건 확장) |
| 테스트 | `web/e2e/upload-edit-save.spec.ts` (visual gate) + 기존 unit suite |
| 형제 | `web-instance-render-overrides.spec.md` (override pipeline 자체) |

## 1. 목적

INSTANCE 의 `_renderChildren` (master 트리의 per-instance 복제본) 이
INSTANCE 의 effective bbox 밖으로 벗어나도 우리 Canvas 는 그대로 그린다.
Figma 는 기본적으로 INSTANCE 를 자기 bbox 에 클립한다. 두 동작의 차이
때문에 round-11 audit 의 design-setting 페이지에서 `Defa진행상태` /
`Defa미분배` 같은 mojibake 가 발생 — MultiCheck 마스터 (SYMBOL 11:577,
77×24) 의 자식 TEXT "Default" (32, 5) 가, 24×24 로 size-override 된
table-cell INSTANCE 안에서 32px 오른쪽으로 leak 해 옆 컬럼 위에
그려진다. 본 spec 은 Figma 의 default clip 동작을 우리 Canvas 에 맞춘다.

## 2. Invariants

- I-1 INSTANCE 노드 (`node.type === 'INSTANCE'`) 가 `_renderChildren` 을
  최소 한 개 이상 갖고 있으면 `wantClip = true`. clipFunc 는 INSTANCE 의
  effective bbox `(0, 0, w, h)` 를 그린다 (`cornerR` 가 있으면 라운드
  포함, 기존 FRAME 클립과 동일 형식).
- I-2 INSTANCE 가 `frameMaskDisabled === true` 를 명시적으로 carry 하면
  클립 비활성화. Figma 가 designer 의 "clip content" 토글을 끈 케이스를
  존중. (false / undefined 는 모두 clip 적용 — Figma 의 default 가 clip.)
- I-3 native FRAME (non-INSTANCE) 의 클립 동작은 변경 없음 — 기존 조건
  `node.frameMaskDisabled === false` 그대로. round 2 §3 호환.
- I-4 `_renderChildren` 이 비어있는 INSTANCE (master 미해결 / expansion
  실패 fallback) 는 클립 적용 안 됨 — 추가 비용 없이 기존 fallback 유지.
- I-5 master 트리 자체의 `frameMaskDisabled` 는 INSTANCE expansion 시
  무시. instance 의 effective size 만 기준으로 클립한다 (size override 가
  master.size 보다 작은 경우가 본 spec 의 핵심 케이스).

## 3. Render-side behavior

`Canvas.tsx:517` 의 `wantClip` 분기만 확장. clipFunc body, anyCorner
처리, Group `clipFunc` 전달 모두 기존 코드 재사용.

```diff
- const wantClip = node.frameMaskDisabled === false;
+ const wantClipForInstance =
+   node.type === 'INSTANCE' &&
+   node.frameMaskDisabled !== true &&
+   Array.isArray(node._renderChildren) && node._renderChildren.length > 0;
+ const wantClip = node.frameMaskDisabled === false || wantClipForInstance;
```

## 4. Error cases

- `w` 또는 `h` 가 0 / undefined — 기존 코드는 0 사이즈 rect 로 폴백 (Konva
  가 시각적 no-op). I-1 도 동일하게 안전.
- 매우 깊게 nested INSTANCE — outer + inner INSTANCE 모두 자기 bbox 로
  클립. Konva 가 nested clipFunc 를 자동 합성 (intersect).

## 5. 비대상

- INSTANCE 가 아닌 SYMBOL/COMPONENT master 자체의 클립 — 본 spec 미적용.
  master 는 설계자 viewer 에서 그대로 보여야 함 (도면 페이지 contexts).
- `_renderChildren` 의 *위치 보정* (orphan TEXT 가 instance bbox 안으로
  들어오도록 transform) — 본 spec 은 단순히 가린다. Figma 의 auto-layout
  resize 시뮬레이션은 별도 라운드.
- `Defa미분배` mojibake 의 *근본* 원인 (variant label TEXT 가 24×24
  체크박스 인스턴스 안에 그대로 있는 것) 은 designer 의 의도된 디자인
  데이터 — 우리 쪽에서는 클립으로 시각만 정리.
