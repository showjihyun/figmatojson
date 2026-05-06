/**
 * Public API surface for `figma-reverse` (Phase 0d / round 33).
 *
 * Stability contract: anything re-exported here is part of the
 * library's published surface and follows semver from 1.0.0 onward.
 * Internal helpers (kiwi raw schema utilities, override resolution
 * internals, intermediate dump writers, etc.) live under their own
 * `./<module>.js` entries and are intentionally NOT re-exported.
 *
 * Examples:
 *
 *     import { decodeFigCanvas, extractTokens } from 'figma-reverse';
 *
 *     const canvasBytes = (await unzipFig(buf)).get('canvas.fig')!;
 *     const decoded = decodeFigCanvas(canvasBytes);
 *     const tokens = extractTokens(decoded, 'design.fig');
 */

// Container + decoder — entry point for any consumer that wants
// access to the parsed kiwi tree without going through the CLI.
export { decodeFigCanvas } from './decoder.js';
export type { DecodedFig } from './decoder.js';
export { loadContainer } from './container.js';
export type { ContainerResult } from './types.js';

// Tree builder — turns the kiwi message into a DocumentNode forest.
export { buildTree } from './tree.js';
export type { TreeNode, BuildTreeResult } from './types.js';

// Phase 1 — design token extraction.
export { extractTokens, formatTokens } from './tokens.js';
export type {
  Tokens,
  ColorToken,
  TypographyToken,
  EffectToken,
  TokenFormat,
} from './tokens.js';

// Repack — only the byte-level safe path. The kiwi/json modes need
// extracted/ side artifacts and are CLI-only for now.
export { buildByteLevelFigBuffer } from './repack.js';
