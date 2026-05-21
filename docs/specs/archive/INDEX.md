# Archived round-fidelity specs

This directory collects the specs of web canvas render-fidelity rounds that have already landed.
Each round closed with its own PR/merge; when a later round revisits the same area we only leave
sibling cross-links. New round work goes in the `docs/specs/` root.

| Round | Topic | Core implementation |
|---|---|---|
| [round 2](./web-render-fidelity-round2.spec.md) | TEXT / VECTOR branching + first pass of strokeAlign / shadow | `Canvas.tsx`, `lib/strokeAlign.ts`, `lib/shadow.ts` |
| [round 3](./web-render-fidelity-round3.spec.md) | transform correction + stroke cap/join | `lib/transform.ts`, `lib/strokeCapJoin.ts` |
| [round 4](./web-render-fidelity-round4.spec.md) | gradient / paint generalization | `lib/gradient.ts`, `lib/paint.ts` |
| [round 5](./web-render-fidelity-round5.spec.md) | cornerRadii per-corner + textTransform | `lib/cornerRadii.ts`, `lib/textTransform.ts` |
| [round 6](./web-render-fidelity-round6.spec.md) | paint render restructuring + inner shadow overlay | `lib/paintRender.ts`, `components/canvas/InnerShadowOverlay.tsx` |
| [round 7](./web-render-fidelity-round7.spec.md) | hover / selection overlay + blendMode | `lib/blendMode.ts`, `components/canvas/HoverOverlay.tsx` |
| [round 8](./web-render-fidelity-round8.spec.md) | image fill scale + per-side stroke correction | `lib/imageScale.ts` |
| [round 9](./web-render-fidelity-round9.spec.md) | layer blur + outer group blendMode | `lib/blurEffect.ts`, `components/canvas/LayerBlurWrapper.tsx` |
| [round 10](./web-render-fidelity-round10.spec.md) | Canvas variant labels (e.g. `size=XL`) | `lib/variantLabel.ts`, `components/canvas/VariantLabel.tsx` |
| [round 11](./web-render-fidelity-round11.spec.md) | vector path inset / offset calculation | `core/domain/clientNode.ts` (toClientNode) |
| [round 12](./web-render-fidelity-round12.spec.md) | vector path scale correction | `core/domain/clientNode.ts` (vectorPathScale) |
| [round 13](./web-render-fidelity-round13.spec.md) | VECTOR strokeAlign INSIDE/OUTSIDE | `lib/strokeAlign.ts` (`applyStrokeAlignToVectorPath`) |
| [round 14](./web-render-fidelity-round14.spec.md) | LayerTree / AssetList variant prop= prefix strip | `components/sidebar/LayerTree.tsx` |
| [round 15](./web-render-fidelity-round15.spec.md) | Inspector library color / text-style label (single-hop) | `core/domain/colorStyleRef.ts` |
| [round 16](./web-render-fidelity-round16.spec.md) | effective text-style + scope-leak hotfix | `core/domain/colorStyleRef.ts` (effectiveTextStyle) |
| [round 18-A](./web-render-fidelity-round18-A.spec.md) | resolveVariableChain (multi-hop variable alias walker) | `core/domain/colorStyleRef.ts` |
| [round 18-B](./web-render-fidelity-round18-B.spec.md) | Inspector alias trail "A → B → C" | `core/domain/colorStyleRef.ts` (`colorVarTrail`) |

> Round 17 was audit-harness work and has a different spec shape — see `docs/specs/audit-raw-coverage.spec.md`.
> Starting at round 18 the spec is split into sub-ids (A/B). New rounds go in the `docs/specs/` root (not in archive) as `web-render-fidelity-round{N}.spec.md`.
