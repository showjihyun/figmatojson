# Archived round-fidelity specs

이 디렉토리는 이미 land 된 web canvas render-fidelity round 의 spec 모음.
각 round 는 자체 PR / 머지로 닫혀 있고, 후속 round 가 동일 영역을 다시 커버하면
형제로 cross-link 만 남겨두었다. 새 round 작업은 `docs/specs/` 루트에 추가한다.

| Round | 주제 | 핵심 구현 |
|---|---|---|
| [round 2](./web-render-fidelity-round2.spec.md) | TEXT / VECTOR 분기 + strokeAlign / shadow 1차 | `Canvas.tsx`, `lib/strokeAlign.ts`, `lib/shadow.ts` |
| [round 3](./web-render-fidelity-round3.spec.md) | transform 보정 + stroke cap/join | `lib/transform.ts`, `lib/strokeCapJoin.ts` |
| [round 4](./web-render-fidelity-round4.spec.md) | gradient · paint 일반화 | `lib/gradient.ts`, `lib/paint.ts` |
| [round 5](./web-render-fidelity-round5.spec.md) | cornerRadii per-corner + textTransform | `lib/cornerRadii.ts`, `lib/textTransform.ts` |
| [round 6](./web-render-fidelity-round6.spec.md) | paint render 재구조 + inner shadow overlay | `lib/paintRender.ts`, `components/canvas/InnerShadowOverlay.tsx` |
| [round 7](./web-render-fidelity-round7.spec.md) | hover/selection overlay + blendMode | `lib/blendMode.ts`, `components/canvas/HoverOverlay.tsx` |
| [round 8](./web-render-fidelity-round8.spec.md) | image fill scale + stroke per-side 보정 | `lib/imageScale.ts` |
| [round 9](./web-render-fidelity-round9.spec.md) | layer blur + outer Group blendMode | `lib/blurEffect.ts`, `components/canvas/LayerBlurWrapper.tsx` |
| [round 10](./web-render-fidelity-round10.spec.md) | Canvas variant 라벨 (`size=XL` 등) | `lib/variantLabel.ts`, `components/canvas/VariantLabel.tsx` |
| [round 11](./web-render-fidelity-round11.spec.md) | vector path inset / offset 계산 | `core/domain/clientNode.ts` (toClientNode) |
| [round 12](./web-render-fidelity-round12.spec.md) | vector path scale 보정 | `core/domain/clientNode.ts` (vectorPathScale) |
| [round 13](./web-render-fidelity-round13.spec.md) | VECTOR strokeAlign INSIDE/OUTSIDE | `lib/strokeAlign.ts` (`applyStrokeAlignToVectorPath`) |
| [round 14](./web-render-fidelity-round14.spec.md) | LayerTree / AssetList variant prop= prefix strip | `components/sidebar/LayerTree.tsx` |
| [round 15](./web-render-fidelity-round15.spec.md) | Inspector library color/text-style label (single-hop) | `core/domain/colorStyleRef.ts` |
| [round 16](./web-render-fidelity-round16.spec.md) | effective text-style + scope-leak hotfix | `core/domain/colorStyleRef.ts` (effectiveTextStyle) |
| [round 18-A](./web-render-fidelity-round18-A.spec.md) | resolveVariableChain (variable alias 다단 walker) | `core/domain/colorStyleRef.ts` |
| [round 18-B](./web-render-fidelity-round18-B.spec.md) | Inspector alias trail "A → B → C" | `core/domain/colorStyleRef.ts` (`colorVarTrail`) |

> Round 17 은 audit harness 작업으로 spec 형태가 다름 — `docs/specs/audit-raw-coverage.spec.md` 참조.
> Round 18 부터는 sub-id (A/B) 로 분기. 새 round 는 `docs/specs/` 루트 (archive 가 아님) 에 `web-render-fidelity-round{N}.spec.md` 로 작성.
