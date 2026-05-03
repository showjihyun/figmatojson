/**
 * Pure tree-mapping helpers: kiwi-decoded TreeNode → client-friendly
 * DocumentNode tree.
 *
 * No IO, no framework, no React. Lives in domain/ because it's a deterministic
 * data transformation; both the FsSessionStore (when creating a session from
 * fresh .fig bytes) and the snapshot-load path call into here.
 *
 * Lifted from server/index.ts as part of Phase 3 — see docs/ARCHITECTURE.md.
 */

import { parseVectorNetworkBlob, vectorNetworkToPath } from '../../../src/vector.js';
import { buildMasterIndex } from '../../../src/masterIndex.js';
import { isHiddenByPropBinding } from '../../../src/effectiveVisibility.js';
import {
  collectFillOverridesFromInstance,
  collectPropAssignmentsAtPathFromInstance,
  collectPropAssignmentsFromInstance,
  collectSwapTargetsAtPathFromInstance,
  collectTextOverridesFromInstance,
  collectVisibilityOverridesFromInstance,
  mergeOverridesForNested,
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
    const vd = data.vectorData as { vectorNetworkBlob?: number } | undefined;
    if (vd && typeof vd.vectorNetworkBlob === 'number') {
      const blob = blobs[vd.vectorNetworkBlob];
      if (blob?.bytes) {
        const vn = parseVectorNetworkBlob(blob.bytes);
        if (vn) out._path = vectorNetworkToPath(vn);
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
        const expanded = master.children.map((c) =>
          toClientChildForRender(c, blobs, symbolIndex, textOverrides, fillOverrides, visOverrides, 0, [], propAssignments, propAssignmentsByPath, swapTargetsByPath),
        );
        if (expanded.length > 0) {
          // Spec web-instance-autolayout-reflow: when the INSTANCE size
          // differs from master and master has HORIZONTAL/VERTICAL stack
          // with CENTER alignment, re-position visible children so they
          // sit centered in the INSTANCE's effective bbox. Without this,
          // children stay at master coords and round-12's INSTANCE clip
          // cuts them (alert/input-box action button text-clip).
          const masterData = (master.data ?? {}) as Record<string, unknown>;
          const masterSize = masterData.size as { x?: number; y?: number } | undefined;
          const instSize = data.size as { x?: number; y?: number } | undefined;
          out._renderChildren = applyInstanceReflow(expanded, masterData, masterSize, instSize);
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

  // Spec §3.1-3.5: CENTER+CENTER reflow when sizes differ. Re-positions
  // every visible child for the new INSTANCE bbox.
  const primaryAlign = masterData.stackPrimaryAlignItems as string | undefined;
  const counterAlign = masterData.stackCounterAlignItems as string | undefined;
  const sizesDiffer = !!masterSize && !!instSize && (
    (masterSize.x ?? 0) !== (instSize.x ?? 0) ||
    (masterSize.y ?? 0) !== (instSize.y ?? 0)
  );
  if (
    primaryAlign === 'CENTER' && counterAlign === 'CENTER' &&
    sizesDiffer && instSize
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
): DocumentNode {
  if (depth > 8) {
    return { id: n.guidStr, guid: n.guid, type: n.type, name: n.name, _isInstanceChild: true };
  }
  // Path tracking: append THIS node's guidStr so descendants see their
  // full chain from the outer instance master root. Override Maps are
  // keyed by the same join scheme. Spec §3.2 I-P3 / I-P4.
  const currentPath = n.guidStr ? [...pathFromOuter, n.guidStr] : pathFromOuter;
  const currentKey = currentPath.join('/');
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
      toClientChildForRender(c, blobs, symbolIndex, textOverrides, fillOverrides, visibilityOverrides, depth + 1, currentPath, effectivePropAssignments, propAssignmentsByPath, swapTargetsByPath),
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
        out._renderChildren = master.children.map((c) =>
          toClientChildForRender(c, blobs, symbolIndex, mergedText, mergedFill, mergedVis, depth + 1, currentPath, mergedPropAssignments, mergedPropAssignsByPath, mergedSwapTargets),
        );
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
