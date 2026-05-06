/**
 * Pure tree-mapping helpers: kiwi-decoded TreeNode → client-friendly
 * DocumentNode tree.
 *
 * No IO, no framework, no React. Lives in domain/ because it's a deterministic
 * data transformation; both the FsSessionStore (when creating a session from
 * fresh .fig bytes) and the snapshot-load path call into here.
 *
 * Lifted from server/index.ts as part of Phase 3 — see docs/SPEC-architecture.md §16.
 */

import { parseVectorNetworkBlob, vectorNetworkToPath } from '../../../src/vector.js';
import { buildMasterIndex } from '../../../src/masterIndex.js';
import { isHiddenByPropBinding } from '../../../src/effectiveVisibility.js';
import {
  collectDerivedSizesFromInstance,
  collectDerivedTransformsFromInstance,
  collectFillOverridesFromInstance,
  collectPropAssignmentsAtPathFromInstance,
  collectPropAssignmentsFromInstance,
  collectStackOverridesFromInstance,
  collectSwapTargetsAtPathFromInstance,
  collectTextOverridesFromInstance,
  collectTextStyleOverridesFromInstance,
  collectVisibilityOverridesFromInstance,
  collectVisualStyleOverridesFromInstance,
  mergeOverridesForNested,
  type Transform2D,
} from '../../../src/instanceOverrides.js';
import type { TreeNode } from '../../../src/types.js';

// Override collectors live in src/instanceOverrides.ts since round 18.
// Production callers (LoadSnapshot, FsSessionStore, messageJson) only
// touch toClientNode + buildSymbolIndex from here, so no re-export is
// needed for them. Tests now import collectors from src/ directly.
import type {
  ComponentTextRef,
  DocumentNode,
} from './entities/Document';

/** Node types that have a vectorNetworkBlob and therefore an SVG path. */
export const VECTOR_TYPES: ReadonlySet<string> = new Set([
  'VECTOR',
  'STAR',
  'LINE',
  'ELLIPSE',
  'REGULAR_POLYGON',
  'BOOLEAN_OPERATION',
  'ROUNDED_RECTANGLE',
]);

/**
 * Map a TreeNode (kiwi-decoded) to the client-friendly DocumentNode shape.
 * Spreads `data` fields onto the node so `node.textData.characters`,
 * `node.fillPaints`, etc. work directly without indirection through
 * `.raw`. Drops binary fields and cyclical references; keeps everything
 * the canvas / inspector cares about.
 */
export function toClientNode(
  n: TreeNode,
  blobs: Array<{ bytes: Uint8Array }>,
  symbolIndex: Map<string, TreeNode>,
): DocumentNode {
  const data = (n.data ?? {}) as Record<string, unknown>;
  const out: DocumentNode = {
    id: n.guidStr,
    guid: n.guid,
    type: n.type,
    name: n.name,
    children: n.children.map((c) => toClientNode(c, blobs, symbolIndex)),
  };

  // Pre-decode the vectorNetworkBlob into an SVG path string so the canvas
  // can render real shapes via Konva.Path. Without this, every vector
  // becomes a colored bbox rectangle (no shape fidelity).
  if (VECTOR_TYPES.has(n.type)) {
    const vd = data.vectorData as
      | { vectorNetworkBlob?: number; normalizedSize?: { x?: unknown; y?: unknown } }
      | undefined;
    if (vd && typeof vd.vectorNetworkBlob === 'number') {
      const blob = blobs[vd.vectorNetworkBlob];
      if (blob?.bytes) {
        const vn = parseVectorNetworkBlob(blob.bytes);
        if (vn) out._path = vectorNetworkToPath(vn);
      }
    }
    // round 11/12 — fit the path inside the node box. Two mutually-exclusive
    // branches based on the sign of (size − normalizedSize):
    //   • size ≥ normalizedSize on both axes → round 11 inset (stroke outset
    //     pattern, e.g. 700:319 size=20×20 normalized=16×16 → offset (2,2)).
    //   • any axis has size < normalizedSize → round 12 scale (parametric
    //     primitive, e.g. 1440:621 ELLIPSE size=80×80 normalized=120×120
    //     → scale (0.667, 0.667)). Spec round12 §I-2/3.
    const size = data.size as { x?: unknown; y?: unknown } | undefined;
    const ns = vd?.normalizedSize;
    if (
      size && ns &&
      typeof size.x === 'number' && typeof size.y === 'number' &&
      typeof ns.x === 'number' && typeof ns.y === 'number'
    ) {
      const dx = size.x - ns.x;
      const dy = size.y - ns.y;
      if (dx < 0 || dy < 0) {
        if (ns.x !== 0 && ns.y !== 0) {
          out._pathScale = { x: size.x / ns.x, y: size.y / ns.y };
        }
      } else if (dx !== 0 || dy !== 0) {
        out._pathOffset = { x: dx / 2, y: dy / 2 };
      }
    }
  }

  // INSTANCE: collect editable TEXT descendants + attach the master's
  // expanded subtree as `_renderChildren` so the canvas can show actual
  // button shapes / icons / labels (without these the instance is just an
  // empty colored rectangle).
  if (n.type === 'INSTANCE' && n.children.length === 0) {
    const sd = data.symbolData as {
      symbolID?: { sessionID?: number; localID?: number };
      symbolOverrides?: Array<Record<string, unknown>>;
    } | undefined;
    const sid = sd?.symbolID;
    if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
      const masterKey = `${sid.sessionID}:${sid.localID}`;
      const master = symbolIndex.get(masterKey);
      if (master) {
        const texts: ComponentTextRef[] = [];
        collectTexts(master, [], texts, symbolIndex, 0);
        if (texts.length > 0) out._componentTexts = texts;

        const textOverrides = collectTextOverridesFromInstance(sd?.symbolOverrides);
        const fillOverrides = collectFillOverridesFromInstance(sd?.symbolOverrides);
        const visOverrides = collectVisibilityOverridesFromInstance(sd?.symbolOverrides);
        const propAssignments = collectPropAssignmentsFromInstance(data);
        const propAssignmentsByPath = collectPropAssignmentsAtPathFromInstance(sd?.symbolOverrides);
        const swapTargetsByPath = collectSwapTargetsAtPathFromInstance(sd?.symbolOverrides);
        const derivedSizesByPath = collectDerivedSizesFromInstance(data);
        // Round 24: also collect Figma's post-layout transforms for any
        // descendant (path-keyed). Applied during descendant emit; reflow
        // only touches direct children, so deep descendants always keep
        // the derived transform. Spec §3.10 I-DT2.
        const derivedTransformsByPath = collectDerivedTransformsFromInstance(data);
        // Round 26: TEXT styling overrides (fontSize / fontName /
        // lineHeight / letterSpacing / ...). Whitelist of 14 fields
        // (spec render-overrides §3.5 I-S2). Applied to TEXT descendants
        // only at data spread, so the master's fields stay for fields
        // the override doesn't mention (partial-override merge).
        const textStyleOverridesByPath = collectTextStyleOverridesFromInstance(sd?.symbolOverrides);
        // Round 27: visual style overrides (strokePaints / opacity /
        // cornerRadius family). Whitelist of 7 fields (spec §3.6 I-V2).
        // Applied to all node types (no TEXT guard) at data spread.
        const visualStyleOverridesByPath = collectVisualStyleOverridesFromInstance(sd?.symbolOverrides);
        // Round 28: stack subset overrides (stackSpacing / padding).
        // Whitelist of 8 fields (spec §3.7). Master-root entry is
        // merged into masterData so applyInstanceReflow uses the
        // variant-stamped values instead of master defaults.
        const stackOverridesByPath = collectStackOverridesFromInstance(sd?.symbolOverrides);
        const expanded = master.children.map((c) =>
          toClientChildForRender(c, blobs, symbolIndex, textOverrides, fillOverrides, visOverrides, 0, [], propAssignments, propAssignmentsByPath, swapTargetsByPath, derivedSizesByPath, derivedTransformsByPath, textStyleOverridesByPath, visualStyleOverridesByPath),
        );
        if (expanded.length > 0) {
          // Spec web-instance-autolayout-reflow: when the INSTANCE size
          // differs from master and master has HORIZONTAL/VERTICAL stack
          // with CENTER alignment, re-position visible children so they
          // sit centered in the INSTANCE's effective bbox. Without this,
          // children stay at master coords and round-12's INSTANCE clip
          // cuts them (alert/input-box action button text-clip).
          const masterData = (master.data ?? {}) as Record<string, unknown>;
          // Spec §3.7 I-AL3 (round-28): merge master-root stack* override
          // into a temporary effectiveMasterData for reflow. Master
          // TreeNode itself is NOT mutated — only the value passed to
          // applyInstanceReflow.
          const stackOvAtRoot = stackOverridesByPath.get(master.guidStr ?? '');
          const effectiveMasterData = stackOvAtRoot
            ? { ...masterData, ...stackOvAtRoot }
            : masterData;
          const masterSize = masterData.size as { x?: number; y?: number } | undefined;
          const origInstSize = data.size as { x?: number; y?: number } | undefined;
          // Round 20: AUTO-grow primarySizing — see detectAutoGrownSize.
          const grownSize = detectAutoGrownSize(sd?.symbolOverrides, sid, masterData, origInstSize);
          if (grownSize) {
            (out as { _autoGrownSize?: { x?: number; y?: number } })._autoGrownSize = grownSize;
          }
          const instSize = grownSize ?? origInstSize;
          out._renderChildren = applyInstanceReflow(expanded, effectiveMasterData, masterSize, instSize);
        }
      }
    }
  }

  for (const k of Object.keys(data)) {
    if (k === 'guid' || k === 'type' || k === 'name') continue;
    const v = data[k];
    if (v instanceof Uint8Array) continue;
    if (k === 'derivedSymbolData' || k === 'derivedTextData') continue;
    if (k === 'fillGeometry' || k === 'strokeGeometry') continue;
    if (k === 'vectorData') continue;
    out[k] = v;
  }
  // Round 20: apply the auto-grown size computed above (overrides the
  // literal `data.size` that the spread just copied). This ensures the
  // Canvas + INSTANCE auto-clip use the grown bbox.
  const autoGrown = (out as { _autoGrownSize?: { x?: number; y?: number } })._autoGrownSize;
  if (autoGrown) {
    out.size = autoGrown;
    delete (out as { _autoGrownSize?: { x?: number; y?: number } })._autoGrownSize;
  }
  return out;
}

// Override collectors + path-key helpers moved to src/instanceOverrides.ts
// in round 18 step 3 (cluster A). Imported above and re-exported for
// caller compatibility (LoadSnapshot, FsSessionStore, messageJson, tests).

/**
 * Test a node's `componentPropRefs` against a propAssignments map. Returns
 * `false` if any VISIBLE-field ref resolves to a `false` assignment, else
 * `undefined` (meaning "no opinion — leave existing visibility as-is").
 *
 * Spec: §3.4 I-P8 — explicit symbolOverrides[].visible wins over this; the
 * caller checks visOv first and only consults this when visOv is absent.
 */
// Round 18 (cluster A 추출 step 2): Property Visibility Toggle 의 실제 결정은
// src/effectiveVisibility.ts:isHiddenByPropBinding 으로 통합. 본 wrapper 는
// 기존 caller (line ~758) 가 기대하는 tri-state 형태 (`false` = hidden by
// prop / `undefined` = no opinion) 로 변환만 한다.
function visibleFromPropRefs(
  data: Record<string, unknown>,
  propAssignments: Map<string, boolean>,
): boolean | undefined {
  return isHiddenByPropBinding(data, propAssignments) ? false : undefined;
}

/**
 * Round 20: detect when an INSTANCE's size is a `RESIZE_TO_FIT*` hint
 * (Figma's "auto-grow to content") and return a grown size if so.
 *
 * Figma's stackPrimarySizing override at the master root path tells the
 * renderer the INSTANCE should auto-grow on the primary axis to fit its
 * children. The literal `instance.size` is just a designer hint /
 * minimum. Without this fix, long text overrides (e.g. dashboard
 * "Excel 다운로드" button sized 44 wide but content needs ~130) clip.
 *
 * v1: we don't have text-measurement infra on the data side, so when
 * AUTO-grow is detected and the override size is smaller than master,
 * fall back to the master's primary-axis size. Inexact (figma may
 * render even wider for very long overrides) but eliminates the
 * visible leading-clip in the common case.
 */
function detectAutoGrownSize(
  symbolOverrides: Array<Record<string, unknown>> | undefined,
  sid: { sessionID: number; localID: number },
  masterData: Record<string, unknown>,
  instSize: { x?: number; y?: number } | undefined,
): { x?: number; y?: number } | undefined {
  if (!Array.isArray(symbolOverrides) || !instSize) return undefined;
  const masterSize = masterData.size as { x?: number; y?: number } | undefined;
  if (!masterSize) return undefined;
  // Find root override entry (path is single-step, matching the master).
  const rootOverride = symbolOverrides.find((o) => {
    const g = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
    return Array.isArray(g) && g.length === 1
      && g[0]?.sessionID === sid.sessionID
      && g[0]?.localID === sid.localID;
  });
  const primarySizing = rootOverride?.stackPrimarySizing as string | undefined;
  if (typeof primarySizing !== 'string' || !primarySizing.startsWith('RESIZE_TO_FIT')) {
    return undefined;
  }
  const stackMode = masterData.stackMode as string | undefined;
  const isHor = stackMode === 'HORIZONTAL';
  const primaryAxis: 'x' | 'y' = isHor ? 'x' : 'y';
  const instPrim = instSize[primaryAxis];
  const masterPrim = masterSize[primaryAxis];
  if (typeof instPrim !== 'number' || typeof masterPrim !== 'number') return undefined;
  if (instPrim >= masterPrim) return undefined; // Already big enough.
  return isHor
    ? { ...instSize, x: masterPrim }
    : { ...instSize, y: masterPrim };
}

/**
 * Re-position visible `_renderChildren` of an INSTANCE so they sit centered
 * inside the INSTANCE's effective bbox, when the INSTANCE size differs
 * from the master AND the master has HORIZONTAL/VERTICAL stack with
 * CENTER primary + CENTER counter alignment. Mirrors what Figma does at
 * render time when an instance overrides its size — children re-flow via
 * auto-layout — without us having to simulate the full auto-layout system.
 *
 * Out of scope (returns the input array unchanged):
 *   - Other primary alignments (MIN/MAX/SPACE_BETWEEN/SPACE_EVENLY)
 *   - Other counter alignments (MIN/MAX/STRETCH)
 *   - Padding handling (v1 ignores padding — for the metarich Button case
 *     with R/B padding only, ignoring padding gives a closer visual match
 *     than partial application).
 *   - stackMode === NONE / GRID / undefined
 *
 * Spec: docs/specs/web-instance-autolayout-reflow.spec.md §2 / §3.
 */
export function applyInstanceReflow(
  expanded: DocumentNode[],
  masterData: Record<string, unknown>,
  masterSize: { x?: number; y?: number } | undefined,
  instSize: { x?: number; y?: number } | undefined,
): DocumentNode[] {
  const stackMode = masterData.stackMode as string | undefined;
  if (stackMode !== 'HORIZONTAL' && stackMode !== 'VERTICAL') return expanded;

  const isHorizontal = stackMode === 'HORIZONTAL';
  const primaryAxis: 'x' | 'y' = isHorizontal ? 'x' : 'y';
  const counterAxis: 'x' | 'y' = isHorizontal ? 'y' : 'x';
  const spacing = (masterData.stackSpacing as number | undefined) ?? 0;

  // Effective visible children participate in any layout calculation.
  // Invisible children stay at master coords (their transforms are not
  // touched) — Canvas drops them anyway via `node.visible === false`.
  type SizedChild = { idx: number; w: number; h: number; primaryPos: number };
  const visibleSized: SizedChild[] = [];
  for (let i = 0; i < expanded.length; i++) {
    const c = expanded[i] as DocumentNode & {
      visible?: boolean;
      size?: { x?: number; y?: number };
      transform?: { m02?: number; m12?: number };
    };
    if (c.visible === false) continue;
    const sz = c.size;
    if (!sz || typeof sz.x !== 'number' || typeof sz.y !== 'number') continue;
    const primaryPos = isHorizontal ? (c.transform?.m02 ?? 0) : (c.transform?.m12 ?? 0);
    visibleSized.push({ idx: i, w: sz.x, h: sz.y, primaryPos });
  }
  if (visibleSized.length === 0) return expanded;

  // Float32 rounding to match the precision the rest of the pipeline uses
  // when copying transforms (see src/pen-export.ts:f32 usage).
  const f32 = Math.fround;

  // Spec §3.1-3.5: CENTER+CENTER reflow when INSTANCE has SHRUNK from
  // master on the primary axis. Re-centers visible children in the new
  // (smaller) bbox.
  //
  // Round 21 narrowing: only fires when `instance.primary < master.primary`.
  // The previous "any size differs" condition fired for grown instances
  // too (e.g. dropdown rail option rows have master 117 but instance
  // 233 — wider, designer wanted overflow), and CENTER-recentering the
  // content pushed text right past the parent Dropdown's clip.
  const primaryAlign = masterData.stackPrimaryAlignItems as string | undefined;
  const counterAlign = masterData.stackCounterAlignItems as string | undefined;
  const instPrimaryRaw = instSize?.[primaryAxis];
  const masterPrimaryRaw = masterSize?.[primaryAxis];
  const instCounterRaw = instSize?.[counterAxis];
  const masterCounterRaw = masterSize?.[counterAxis];
  const instanceShrunkOnPrimary =
    typeof instPrimaryRaw === 'number' &&
    typeof masterPrimaryRaw === 'number' &&
    instPrimaryRaw < masterPrimaryRaw;
  const instanceShrunkOnCounter =
    typeof instCounterRaw === 'number' &&
    typeof masterCounterRaw === 'number' &&
    instCounterRaw < masterCounterRaw;
  if (
    primaryAlign === 'CENTER' && counterAlign === 'CENTER' &&
    (instanceShrunkOnPrimary || instanceShrunkOnCounter) && instSize
  ) {
    const instPrimary = instSize[primaryAxis];
    const instCounter = instSize[counterAxis];
    if (typeof instPrimary === 'number' && typeof instCounter === 'number') {
      const totalPrimary = visibleSized.reduce(
        (sum, c) => sum + (primaryAxis === 'x' ? c.w : c.h),
        0,
      ) + spacing * Math.max(0, visibleSized.length - 1);
      let cursor = (instPrimary - totalPrimary) / 2;
      const out = expanded.slice();
      for (const v of visibleSized) {
        const c = out[v.idx] as DocumentNode & {
          transform?: {
            m00?: number; m01?: number; m02?: number;
            m10?: number; m11?: number; m12?: number;
          };
        };
        const childPrimary = primaryAxis === 'x' ? v.w : v.h;
        const childCounter = counterAxis === 'x' ? v.w : v.h;
        const newPrimary = f32(cursor);
        const newCounter = f32((instCounter - childCounter) / 2);
        const baseT = c.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
        const newTransform = isHorizontal
          ? { ...baseT, m02: newPrimary, m12: newCounter }
          : { ...baseT, m02: newCounter, m12: newPrimary };
        out[v.idx] = { ...c, transform: newTransform };
        cursor += childPrimary + spacing;
      }
      return out;
    }
  }

  // Spec §3.7 (round 19): MIN/start-aligned reflow with visibility filtering.
  // Fires when master uses MIN/undefined primary alignment (Figma's default
  // "pack from start") AND some children are visibility-filtered. Re-pack
  // visible children from the master's first-child position with spacing.
  //
  // Source case: WEB lnb-400_4266 sidemenu — master 23:1635 has 9 items;
  // outer Dropdown override hides 5; remaining 4 should flow into a
  // packed sequence (y=4, 53, 102, 151) instead of staying at master
  // positions (y=102, 298, 347, 396). Without this, 3 items overflow the
  // section bbox and get clipped by round-12 INSTANCE auto-clip.
  const isMinAlign = primaryAlign === undefined || primaryAlign === 'MIN';
  const someHidden = visibleSized.length < expanded.length;
  if (isMinAlign && someHidden) {
    // Anchor: master's first child position, regardless of visibility
    // (digital padding the designer hard-coded). Spec §3.7 I-O7.
    const firstChild = expanded[0] as DocumentNode & {
      transform?: { m02?: number; m12?: number };
    };
    const startPrimary = isHorizontal
      ? (firstChild.transform?.m02 ?? 0)
      : (firstChild.transform?.m12 ?? 0);
    let cursor = startPrimary;
    const out = expanded.slice();
    for (const v of visibleSized) {
      const c = out[v.idx] as DocumentNode & {
        transform?: { m00?: number; m01?: number; m02?: number; m10?: number; m11?: number; m12?: number };
      };
      const childPrimary = primaryAxis === 'x' ? v.w : v.h;
      const newPrimary = f32(cursor);
      const baseT = c.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
      const newTransform = isHorizontal
        ? { ...baseT, m02: newPrimary }
        : { ...baseT, m12: newPrimary };
      out[v.idx] = { ...c, transform: newTransform };
      cursor += childPrimary + spacing;
    }
    return out;
  }

  // Spec §3.6 (round 15 Phase B): overlap-group reflow.
  // Alignment-independent — fires whenever 2+ visible children share the
  // same master primary-axis position. The first child of an overlap
  // group keeps its master position; subsequent visible children flow
  // forward by (cumulative sizes + spacing) starting from the first's
  // position. Counter axis untouched.
  //
  // Detect any overlap by walking visibleSized once and tracking prior
  // positions per group. We don't need to scan all-pairs — duplicates of
  // the first occurrence are enough.
  const seenPositions = new Map<number, number>(); // primaryPos → first occurrence idx in visibleSized
  let overlapDetected = false;
  for (let i = 0; i < visibleSized.length; i++) {
    const pos = visibleSized[i].primaryPos;
    if (seenPositions.has(pos)) {
      overlapDetected = true;
      break;
    }
    seenPositions.set(pos, i);
  }
  if (!overlapDetected) return expanded;

  // Walk visibleSized in master order. Maintain a "flow cursor" anchored
  // to the first occurrence of each primary position. For subsequent
  // visible children at the same position, slot them at (cursor +=
  // childPrimary + spacing). For visible children at a NEW (non-overlap)
  // position, jump cursor to that position and continue.
  const out = expanded.slice();
  let cursor = visibleSized[0].primaryPos;
  let lastSeenPos = visibleSized[0].primaryPos;
  for (let i = 0; i < visibleSized.length; i++) {
    const v = visibleSized[i];
    if (i === 0) {
      // First child stays at master position; cursor anchored here.
      cursor = v.primaryPos;
      lastSeenPos = v.primaryPos;
      continue;
    }
    const childPrimary = primaryAxis === 'x' ? v.w : v.h;
    if (v.primaryPos === lastSeenPos) {
      // Overlap with previous — slot at cursor + previous child's primary + spacing.
      const prev = visibleSized[i - 1];
      const prevPrimary = primaryAxis === 'x' ? prev.w : prev.h;
      cursor = cursor + prevPrimary + spacing;
      const c = out[v.idx] as DocumentNode & {
        transform?: {
          m00?: number; m01?: number; m02?: number;
          m10?: number; m11?: number; m12?: number;
        };
      };
      const baseT = c.transform ?? { m00: 1, m01: 0, m02: 0, m10: 0, m11: 1, m12: 0 };
      const newPrimary = f32(cursor);
      const newTransform = isHorizontal
        ? { ...baseT, m02: newPrimary }
        : { ...baseT, m12: newPrimary };
      out[v.idx] = { ...c, transform: newTransform };
    } else {
      // No overlap with previous — keep this child at master position
      // and re-anchor the cursor.
      cursor = v.primaryPos;
      lastSeenPos = v.primaryPos;
    }
    void childPrimary; // referenced for clarity even when not used in non-overlap branch
  }
  return out;
}

/**
 * Render-only version of toClientNode used inside INSTANCE expansion. Keeps
 * the master's GUIDs (so editing still targets the master node), tags every
 * descendant with `_isInstanceChild: true`, and applies any per-instance
 * text overrides at render time so the canvas reflects them immediately.
 *
 * Recursion is depth-limited (8) and stops at nested INSTANCEs (their own
 * `_renderChildren` will be filled in when toClientNode visits them
 * separately as part of the main tree walk).
 */
export function toClientChildForRender(
  n: TreeNode,
  blobs: Array<{ bytes: Uint8Array }>,
  symbolIndex: Map<string, TreeNode>,
  textOverrides: Map<string, string>,
  fillOverrides: Map<string, unknown[]>,
  visibilityOverrides: Map<string, boolean>,
  depth: number,
  pathFromOuter: string[] = [],
  propAssignments: Map<string, boolean> = new Map(),
  propAssignmentsByPath: Map<string, Map<string, boolean>> = new Map(),
  swapTargetsByPath: Map<string, string> = new Map(),
  derivedSizesByPath: Map<string, { x: number; y: number }> = new Map(),
  derivedTransformsByPath: Map<string, Transform2D> = new Map(),
  textStyleOverridesByPath: Map<string, Record<string, unknown>> = new Map(),
  visualStyleOverridesByPath: Map<string, Record<string, unknown>> = new Map(),
): DocumentNode {
  if (depth > 8) {
    return { id: n.guidStr, guid: n.guid, type: n.type, name: n.name, _isInstanceChild: true };
  }
  // Path tracking: append THIS node's path-guid so descendants see their
  // chain from the outer instance master root. Override Maps are keyed by
  // the same join scheme. Spec §3.2 I-P3 / I-P4 (round-25 v3): the chain
  // contains *INSTANCE-typed ancestors only* + the current node — FRAME /
  // GROUP / SECTION container ancestors are skipped (Figma's path-key
  // scheme matches its symbolOverrides + derivedSymbolData wire format).
  //
  // Round 32 fix: when a master subtree comes from a *published library*
  // component, the local copy's nodes carry their library-stable GUID
  // under `data.overrideKey`, while `guidStr` is the freshly-assigned
  // local kiwi GUID. Figma's symbolOverrides paths use the library-
  // stable identity, so override map lookups need that side of the
  // identity. Use `overrideKey` when present, fall back to `guidStr` for
  // master subtrees defined locally (where the two were always equal).
  const dataForKey = (n.data ?? {}) as Record<string, unknown>;
  const overrideKey = dataForKey.overrideKey as { sessionID?: number; localID?: number } | undefined;
  const pathGuid = overrideKey && typeof overrideKey.sessionID === 'number' && typeof overrideKey.localID === 'number'
    ? `${overrideKey.sessionID}:${overrideKey.localID}`
    : n.guidStr;
  const currentPath = pathGuid ? [...pathFromOuter, pathGuid] : pathFromOuter;
  const currentKey = currentPath.join('/');
  // For child recursion: only INSTANCE nodes contribute to the ancestor
  // chain. Non-INSTANCE containers pass `pathFromOuter` through unchanged
  // so descendants compute the same key Figma stamps.
  const childPathFromOuter = n.type === 'INSTANCE' ? currentPath : pathFromOuter;
  const data = (n.data ?? {}) as Record<string, unknown>;

  // Spec §3.4 I-P11 (round 15): merge in any path-keyed prop assignments
  // from outer symbolOverrides whose guidPath matches THIS node's path.
  // The merged map then propagates through children + nested-instance
  // expansion below. Outer-override assignments override outer instance
  // assignments at the same defID (same flat-overwrite semantics as I-P9).
  const overrideAssigns = propAssignmentsByPath.get(currentKey);
  const effectivePropAssignments = overrideAssigns
    ? new Map([...propAssignments, ...overrideAssigns])
    : propAssignments;

  const out: DocumentNode = {
    id: n.guidStr,
    guid: n.guid,
    type: n.type,
    name: n.name,
    _isInstanceChild: true,
    children: n.children.map((c) =>
      toClientChildForRender(c, blobs, symbolIndex, textOverrides, fillOverrides, visibilityOverrides, depth + 1, childPathFromOuter, effectivePropAssignments, propAssignmentsByPath, swapTargetsByPath, derivedSizesByPath, derivedTransformsByPath, textStyleOverridesByPath, visualStyleOverridesByPath),
    ),
  };
  if (VECTOR_TYPES.has(n.type)) {
    const vd = data.vectorData as { vectorNetworkBlob?: number } | undefined;
    if (vd && typeof vd.vectorNetworkBlob === 'number') {
      const blob = blobs[vd.vectorNetworkBlob];
      if (blob?.bytes) {
        const vn = parseVectorNetworkBlob(blob.bytes);
        if (vn) out._path = vectorNetworkToPath(vn);
      }
    }
  }
  if (n.type === 'TEXT') {
    const ov = textOverrides.get(currentKey);
    if (typeof ov === 'string') out._renderTextOverride = ov;
  }
  // Nested INSTANCE: merge outer overrides (already path-keyed against the
  // outer master's tree, may contain entries that target descendants of
  // THIS inner instance via multi-step paths) with the inner instance's
  // OWN overrides (single-step keys, prefixed with currentPath so they
  // match in the same path-join scheme). Spec §3.2 I-P5.
  if (n.type === 'INSTANCE' && n.children.length === 0) {
    const sd = data.symbolData as {
      symbolID?: { sessionID?: number; localID?: number };
      symbolOverrides?: Array<Record<string, unknown>>;
    } | undefined;
    const sid = sd?.symbolID;
    if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
      // Spec web-instance-variant-swap §3.2 I-P2: when an outer override
      // path-keyed against THIS instance carries `overriddenSymbolID`,
      // use that swapped master for expansion instead of the default
      // `sd.symbolID`. The metarich Dropdown's "직접 선택" option flows
      // through here.
      const swapTargetKey = swapTargetsByPath.get(currentKey);
      const masterKey = swapTargetKey ?? `${sid.sessionID}:${sid.localID}`;
      const master = symbolIndex.get(masterKey)
        // I-E1: corrupt swap target falls back to the default master.
        ?? (swapTargetKey ? symbolIndex.get(`${sid.sessionID}:${sid.localID}`) : undefined);
      const swapApplied = swapTargetKey !== undefined && master !== undefined && masterKey === swapTargetKey;
      // Spec web-instance-variant-swap §3.3 (round 17 extension): when
      // swap is applied, the rendered INSTANCE node inherits the swap
      // target's visual properties (fillPaints, cornerRadius, strokes,
      // etc.) — Figma's semantic is "use this variant's appearance".
      // Without this, e.g. metarich's "직접 선택" row renders the WHITE
      // text with no blue background → visually invisible. The
      // instance's own data fields (transform, etc.) still win on top
      // for non-visual concerns. Mirrors pen-export.ts:1146-1158.
      if (swapApplied && master) {
        const swapTargetData = (master.data ?? {}) as Record<string, unknown>;
        for (const k of Object.keys(swapTargetData)) {
          // Skip fields the instance is meant to own / fields that don't
          // make sense to inherit (children — we expand them separately
          // via _renderChildren below; symbolData — instance-specific).
          if (k === 'guid' || k === 'type' || k === 'name') continue;
          if (k === 'children' || k === 'symbolData') continue;
          if (k === 'transform') continue;            // instance position wins
          if (k === 'parentIndex' || k === 'phase') continue;
          // Only inherit when the instance doesn't already provide the
          // field (instance own value wins on collision). Falls back to
          // swap target for missing visual fields like fillPaints.
          if (data[k] === undefined) {
            (data as Record<string, unknown>)[k] = swapTargetData[k];
          }
        }
      }
      if (master) {
        const innerText = collectTextOverridesFromInstance(sd?.symbolOverrides);
        const innerFill = collectFillOverridesFromInstance(sd?.symbolOverrides);
        const innerVis = collectVisibilityOverridesFromInstance(sd?.symbolOverrides);
        const mergedText = mergeOverridesForNested(textOverrides, innerText, currentPath);
        const mergedFill = mergeOverridesForNested(fillOverrides, innerFill, currentPath);
        const mergedVis = mergeOverridesForNested(visibilityOverrides, innerVis, currentPath);
        // Spec §3.4 I-P9: prop assignments are defID-keyed, not path-keyed,
        // so the merge is a flat overwrite of the outer map (inner wins
        // within this INSTANCE's expansion). Use effectivePropAssignments
        // (which already includes outer-symbolOverride assignments matched
        // to currentKey via I-P11) as the base, then apply this inner
        // INSTANCE's own componentPropAssignments on top.
        const innerPropAssignments = collectPropAssignmentsFromInstance(data);
        const mergedPropAssignments = innerPropAssignments.size > 0
          ? new Map([...effectivePropAssignments, ...innerPropAssignments])
          : effectivePropAssignments;
        // Spec §3.4 I-P11: also collect path-keyed prop assignments from
        // the inner INSTANCE's own symbolOverrides, prefixed with currentPath
        // so they reach descendants of the inner expansion. Outer
        // path-keyed assignments stay valid since they were matched at the
        // currentKey here already (above).
        const innerPropAssignsByPath = collectPropAssignmentsAtPathFromInstance(sd?.symbolOverrides);
        const mergedPropAssignsByPath = innerPropAssignsByPath.size > 0
          ? new Map(propAssignmentsByPath)
          : propAssignmentsByPath;
        if (innerPropAssignsByPath.size > 0) {
          const prefix = currentPath.join('/');
          for (const [innerKey, innerVal] of innerPropAssignsByPath) {
            const merged = prefix.length > 0 ? `${prefix}/${innerKey}` : innerKey;
            mergedPropAssignsByPath.set(merged, innerVal);
          }
        }
        // Spec web-instance-variant-swap §3.2 I-P4: same prefix-merge for
        // inner-INSTANCE swap targets — its own symbolOverrides may
        // specify swaps for grand-descendants.
        const innerSwapTargets = collectSwapTargetsAtPathFromInstance(sd?.symbolOverrides);
        const mergedSwapTargets = innerSwapTargets.size > 0
          ? new Map(swapTargetsByPath)
          : swapTargetsByPath;
        if (innerSwapTargets.size > 0) {
          const prefix = currentPath.join('/');
          for (const [innerKey, innerVal] of innerSwapTargets) {
            const merged = prefix.length > 0 ? `${prefix}/${innerKey}` : innerKey;
            mergedSwapTargets.set(merged, innerVal);
          }
        }
        // Round 21: also collect inner derivedSymbolData sizes from the
        // nested instance + prefix-merge with outer (same path-key scheme).
        const innerDerivedSizes = collectDerivedSizesFromInstance(data);
        const mergedDerivedSizes = innerDerivedSizes.size > 0
          ? new Map(derivedSizesByPath)
          : derivedSizesByPath;
        if (innerDerivedSizes.size > 0) {
          const prefix = currentPath.join('/');
          for (const [innerKey, innerVal] of innerDerivedSizes) {
            const merged = prefix.length > 0 ? `${prefix}/${innerKey}` : innerKey;
            mergedDerivedSizes.set(merged, innerVal);
          }
        }
        // Round 24: same prefix-merge for derivedTransforms so the inner
        // instance's own post-layout transform deltas reach descendants of
        // the inner expansion. Spec §3.10 I-DT3.
        const innerDerivedTransforms = collectDerivedTransformsFromInstance(data);
        const mergedDerivedTransforms = innerDerivedTransforms.size > 0
          ? new Map(derivedTransformsByPath)
          : derivedTransformsByPath;
        if (innerDerivedTransforms.size > 0) {
          const prefix = currentPath.join('/');
          for (const [innerKey, innerVal] of innerDerivedTransforms) {
            const merged = prefix.length > 0 ? `${prefix}/${innerKey}` : innerKey;
            mergedDerivedTransforms.set(merged, innerVal);
          }
        }
        // Round 26: same prefix-merge for TEXT style overrides so the
        // inner INSTANCE's own per-path text-styling deltas reach
        // descendants of the inner expansion. Spec §3.5 I-S6.
        const innerTextStyle = collectTextStyleOverridesFromInstance((data as { symbolData?: { symbolOverrides?: Array<Record<string, unknown>> } }).symbolData?.symbolOverrides);
        const mergedTextStyle = innerTextStyle.size > 0
          ? mergeOverridesForNested(textStyleOverridesByPath, innerTextStyle, currentPath)
          : textStyleOverridesByPath;
        // Round 27: same prefix-merge for visual style overrides
        // (strokePaints / opacity / cornerRadius family). Spec §3.6 I-V6.
        const innerVisualStyle = collectVisualStyleOverridesFromInstance((data as { symbolData?: { symbolOverrides?: Array<Record<string, unknown>> } }).symbolData?.symbolOverrides);
        const mergedVisualStyle = innerVisualStyle.size > 0
          ? mergeOverridesForNested(visualStyleOverridesByPath, innerVisualStyle, currentPath)
          : visualStyleOverridesByPath;
        // Round 28: stack subset overrides on the inner INSTANCE's own
        // symbolOverrides. The master-root entry for THIS nested INSTANCE
        // affects its own reflow below.
        const innerStackOv = collectStackOverridesFromInstance((data as { symbolData?: { symbolOverrides?: Array<Record<string, unknown>> } }).symbolData?.symbolOverrides);
        const nestedExpanded = master.children.map((c) =>
          toClientChildForRender(c, blobs, symbolIndex, mergedText, mergedFill, mergedVis, depth + 1, currentPath, mergedPropAssignments, mergedPropAssignsByPath, mergedSwapTargets, mergedDerivedSizes, mergedDerivedTransforms, mergedTextStyle, mergedVisualStyle),
        );
        // Round 20: AUTO-grow primarySizing also fires for nested INSTANCEs
        // (the dashboard "Excel 다운로드" button is a nested INSTANCE inside
        // the dashboard FRAME). Detect on this nested instance's own
        // symbolOverrides + apply via _autoGrownSize marker.
        const nestedMasterData = (master.data ?? {}) as Record<string, unknown>;
        const nestedMasterSize = nestedMasterData.size as { x?: number; y?: number } | undefined;
        const nestedOrigInstSize = data.size as { x?: number; y?: number } | undefined;
        const nestedGrownSize = detectAutoGrownSize(sd?.symbolOverrides, sid, nestedMasterData, nestedOrigInstSize);
        if (nestedGrownSize) {
          (out as { _autoGrownSize?: { x?: number; y?: number } })._autoGrownSize = nestedGrownSize;
        }
        // Spec §3.9 I-DS3 (round-22): nestedInstSize priority is
        // grown (round-20) > derived (round-22) > origInstSize > master.
        // The derivedSize lookup uses currentKey — the outer instance's
        // derivedSymbolData entry for THIS nested INSTANCE descendant.
        const nestedDerivedSize = derivedSizesByPath.get(currentKey);
        const nestedInstSize = nestedGrownSize ?? nestedDerivedSize ?? nestedOrigInstSize;
        // Spec §3.7 I-AL3 (round-28): merge inner stack* override at
        // master root into a temporary effectiveMasterData for nested
        // reflow. Same pattern as the outer-INSTANCE branch.
        const nestedStackOvAtRoot = innerStackOv.get(master.guidStr ?? '');
        const nestedEffectiveMasterData = nestedStackOvAtRoot
          ? { ...nestedMasterData, ...nestedStackOvAtRoot }
          : nestedMasterData;
        // Apply auto-layout reflow to the nested INSTANCE expansion too.
        out._renderChildren = applyInstanceReflow(nestedExpanded, nestedEffectiveMasterData, nestedMasterSize, nestedInstSize);
        // Spec web-instance-variant-swap §3.3 I-V1: when swap is applied
        // and no explicit visibility override exists for this path, treat
        // the swap as implying visible:true. This compensates for Figma's
        // semantics where a swapped variant is meant to render even if
        // the original instance was hidden by default. Explicit
        // visOverride at this path (handled below in the visOv branch)
        // still wins.
        if (swapApplied) {
          (out as { _swapApplied?: boolean })._swapApplied = true;
        }
      }
    }
  }
  for (const k of Object.keys(data)) {
    if (k === 'guid' || k === 'type' || k === 'name') continue;
    const v = data[k];
    if (v instanceof Uint8Array) continue;
    if (k === 'derivedSymbolData' || k === 'derivedTextData') continue;
    if (k === 'fillGeometry' || k === 'strokeGeometry') continue;
    if (k === 'vectorData') continue;
    out[k] = v;
  }
  // Apply fillPaints override AFTER the data spread so it wins. Spec §3.2 I-P3.
  const fillOv = fillOverrides.get(currentKey);
  if (fillOv) out.fillPaints = fillOv;
  // Apply per-instance visibility override (spec round 4 extension). The
  // 397 metarich entries that hide e.g. an arrow icon inside a Button
  // variant flow through here.
  const visOv = visibilityOverrides.get(currentKey);
  if (visOv !== undefined) {
    out.visible = visOv;
  } else {
    // Spec §3.4 I-P8: explicit override wins; only consult prop-binding
    // when no explicit visibility override is set for this path. Round 12
    // adds this branch to cover Figma's component-property visibility
    // mechanism — used by alret / input-box / datepicker rail / dropdown
    // to hide the trailing arrow icon inside Button variants. Round 15
    // (I-P11) adds: outer-symbolOverride path-keyed assignments are now
    // merged into effectivePropAssignments above, so this lookup also
    // covers the metarich Dropdown rail's "금월"/"전월" rows where the
    // arrow-hide assignment lives in the outer Dropdown's overrides.
    const propVis = visibleFromPropRefs(data, effectivePropAssignments);
    if (propVis === false) out.visible = false;
    // Spec web-instance-variant-swap §3.3 I-V1: when variant swap was
    // applied above and no explicit visibility override exists, treat
    // the swap as implying visible:true even if the master data spread
    // set out.visible = false. Drops the _swapApplied marker after use.
    else if ((out as { _swapApplied?: boolean })._swapApplied === true && out.visible === false) {
      out.visible = true;
    }
  }
  // Strip the internal _swapApplied marker — it was only needed across
  // the single function body for the implicit-visible decision above.
  if ((out as { _swapApplied?: boolean })._swapApplied !== undefined) {
    delete (out as { _swapApplied?: boolean })._swapApplied;
  }
  // Spec §3.9 I-DS2 (round-22): apply outer INSTANCE's derivedSymbolData
  // size to ALL descendant types — not just TEXT. Round-21's TEXT-only
  // attempt broke the datepicker rail because container INSTANCEs kept
  // their master sizes while their descendant text shrank. Now every
  // descendant gets the Figma-derived size when present; subsequent
  // applyInstanceReflow at the outer INSTANCE boundary picks up the
  // updated child sizes for correct CENTER/MIN spacing.
  const derivedSize = derivedSizesByPath.get(currentKey);
  if (derivedSize) {
    out.size = { x: derivedSize.x, y: derivedSize.y };
  }
  // Spec §3.10 I-DT2 (round-24): apply outer INSTANCE's derivedSymbolData
  // transform to descendants. Replaces out.transform wholesale (rotation +
  // scale + translation), not just m02/m12. For direct children of an
  // INSTANCE that also triggers reflow, applyInstanceReflow may overwrite
  // m02/m12 afterwards (v1 limitation — documented in spec §3.10 I-DT4);
  // deeper descendants are never touched by reflow so the derived
  // transform is final for them.
  const derivedTransform = derivedTransformsByPath.get(currentKey);
  if (derivedTransform) {
    out.transform = { ...derivedTransform };
  }
  // Spec §3.5 I-S4/I-S5 (round-26): TEXT styling override. Whitelist of
  // 14 fields (fontSize / fontName / lineHeight / letterSpacing /
  // textTracking / styleIdForText / fontVariations / textAutoResize /
  // fontVariantCommonLigatures / fontVariantContextualLigatures /
  // textDecorationSkipInk / textAlignHorizontal / textAlignVertical /
  // fontVersion). Whitelist is enforced by the collector so this
  // Object.assign is safe — non-whitelisted fields never reach styleOv.
  // Applied AFTER data spread so override values win over master; partial-
  // override merge preserves master fields the override doesn't mention.
  // TEXT-type guard (I-S4) — Figma's componentPropRefs targeting these
  // fields only points at TEXT nodes, but the guard makes the contract
  // explicit and protects against future rule changes.
  if (n.type === 'TEXT') {
    const styleOv = textStyleOverridesByPath.get(currentKey);
    if (styleOv) {
      Object.assign(out, styleOv);
    }
  }
  // Spec §3.6 I-V4/I-V5 (round-27): visual style override (stroke /
  // opacity / cornerRadius family). Whitelist of 7 fields enforced by
  // the collector (so this Object.assign is safe). NO TEXT-type guard
  // — these fields apply to FRAME / RECTANGLE / VECTOR / etc. and the
  // collector's whitelist already keeps the surface narrow.
  // Same partial-override merge: master fields preserved when override
  // doesn't mention them.
  const visualOv = visualStyleOverridesByPath.get(currentKey);
  if (visualOv) {
    Object.assign(out, visualOv);
  }
  return out;
}

/**
 * Walk a master tree and collect every TEXT descendant (with breadcrumb path).
 * Recurses through nested INSTANCEs by following their master via symbolIndex
 * (capped at depth 6 to avoid pathological nesting).
 */
export function collectTexts(
  n: TreeNode,
  ancestors: string[],
  out: ComponentTextRef[],
  symbolIndex: Map<string, TreeNode>,
  depth: number,
): void {
  if (depth > 6) return;
  const data = n.data as Record<string, unknown>;
  if (n.type === 'TEXT') {
    const td = data.textData as { characters?: string } | undefined;
    out.push({
      guid: n.guidStr,
      name: n.name,
      path: ancestors.join(' / '),
      characters: td?.characters ?? '',
    });
    return;
  }
  for (const c of n.children) {
    collectTexts(c, [...ancestors, c.name ?? c.type], out, symbolIndex, depth + 1);
  }
  if (n.type === 'INSTANCE' && n.children.length === 0) {
    const sd = data.symbolData as { symbolID?: { sessionID?: number; localID?: number } } | undefined;
    const sid = sd?.symbolID;
    if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
      const master = symbolIndex.get(`${sid.sessionID}:${sid.localID}`);
      if (master) {
        for (const c of master.children) {
          collectTexts(c, [...ancestors, c.name ?? c.type], out, symbolIndex, depth + 1);
        }
      }
    }
  }
}

/**
 * Re-export of `src/masterIndex.ts:buildMasterIndex` under the legacy
 * name so existing call sites (LoadSnapshot, FsSessionStore,
 * messageJson, tests) work without churn during the round-18 cluster A
 * migration. New callers should import `buildMasterIndex` from
 * `src/masterIndex.ts` directly.
 *
 * Spec: docs/specs/expansion-context.spec.md §3.4.
 *
 * Note: the previous in-line implementation here had a dead-code bug
 * (an unconditional `m.set` after the type-filtered branch) that
 * caused every Tree Node to be indexed regardless of type. The shared
 * `buildMasterIndex` filters correctly to SYMBOL/COMPONENT/
 * COMPONENT_SET only.
 */
export function buildSymbolIndex(allNodes: Iterable<TreeNode>): Map<string, TreeNode> {
  return buildMasterIndex(allNodes);
}
