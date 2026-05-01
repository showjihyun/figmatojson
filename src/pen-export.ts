/**
 * Pencil .pen 형식 호환 export.
 *
 * 분석 reference: docs/메타리치 화면 UI Design.pen (v2.11)
 * - 4 노드 타입만: frame, text, path, rectangle
 * - 단순 hex fill ("#rrggbbaa")
 * - SVG path geometry 직접
 * - z-order = children 배열 순서
 *
 * 본 export는 Figma raw 메타를 잃지만 사람이 직접 편집하기 가장 직관적.
 * round-trip은 sidecar(figma.editable.meta.js)와 결합해 보존.
 */

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { extractVectors, decodeCommandsBlob } from './vector.js';
import type { DecodedFig } from './decoder.js';
import type { BuildTreeResult, ContainerResult, TreeNode } from './types.js';

export interface PenExportInputs {
  tree: BuildTreeResult;
  decoded: DecodedFig;
  container: ContainerResult;
  outDir: string; // 기본: extracted/<figName>/08_pen/
}

export interface PenExportResult {
  outDir: string;
  /** 페이지별 산출물 — 각 페이지마다 .pen.json (figma round-trip용) + .pen (Pencil native) 두 파일 */
  files: Array<{ path: string; bytes: number; nodeCount: number; penPath: string; penBytes: number }>;
  totalPages: number;
  totalNodes: number;
}

interface PenNode {
  type: 'frame' | 'text' | 'path' | 'rectangle';
  id: string;
  name?: string;
  /** visible:false로 토글된 노드 (Pencil convention). 직접 visible:false이거나
   *  INSTANCE의 componentPropAssignments(boolValue:false)가 자손의 componentPropRefs(VISIBLE)에 매핑된 경우. */
  enabled?: boolean;
  x?: number;
  y?: number;
  // 'fill_container' or 'fill_container(N)' or number
  width?: number | string;
  height?: number | string;
  opacity?: number;
  fill?: PenFill;
  stroke?: PenStroke;
  cornerRadius?: number;
  effect?: PenEffect;
  // text-specific
  content?: string;
  fontFamily?: string;
  fontSize?: number;
  /** Pencil 스키마 호환: 항상 string. 'normal' (=400) 또는 numeric string ('100'~'900'). 'bold'는 출력 X. */
  fontWeight?: string;
  lineHeight?: number;
  letterSpacing?: number;
  textAlign?: string;
  textAlignVertical?: string;
  /** Pencil 스키마: width/height가 적용되려면 이걸 명시해야 함.
   *  - 'fixed-width'        — width 고정, height 자동 계산 (wrap 가능)
   *  - 'fixed-width-height' — 둘 다 고정 (overflow 가능)
   *  - 'auto'(default, omit) — wrap 없음, width/height는 콘텐츠 크기 */
  textGrowth?: 'fixed-width' | 'fixed-width-height';
  // path-specific
  geometry?: string;
  // frame-specific (v2.11에서 부분만)
  layout?: 'none' | 'horizontal' | 'vertical';
  alignItems?: string;
  justifyContent?: string;
  gap?: number;
  padding?: number | number[] | { top: number; right: number; bottom: number; left: number };
  clip?: boolean;
  children?: PenNode[];
}

type PenFillSingle =
  | string
  | { type: 'color'; color: string; enabled?: boolean }
  | { type: 'image'; enabled?: boolean; url?: string; mode?: string }
  | { type: 'gradient'; enabled?: boolean };
type PenFill = PenFillSingle | PenFillSingle[]; // 다중 layer는 array
type PenStroke = {
  align: 'inside' | 'outside' | 'center';
  /** 균일 두께면 number, 비대칭(예: 하단만)이면 부분 객체 — Pencil 스키마 호환 */
  thickness: number | { top?: number; right?: number; bottom?: number; left?: number };
  fill?: string;
};
type PenEffect = {
  type: 'shadow' | 'blur';
  shadowType?: 'inner' | 'outer';
  color?: string;
  offset?: { x: number; y: number };
  blur?: number;
};

interface PenDocument {
  version: string;
  /** Figma round-trip을 위한 추가 메타 (Pencil v2.11 schema 외) */
  __figma?: {
    pageId: string;
    pageName: string;
    archiveVersion: number;
    sourceFigSha256?: string;
    /** 재발급된 Pencil 호환 short ID → 원본 figma GUID(또는 INSTANCE 확장 path) */
    idMap?: Record<string, string>;
    /** 원본 Figma 좌표 → pen 좌표 (top-level bbox를 (0,0)으로 평행이동). 원본 = pen 좌표 - 이 offset. */
    viewportOffset?: { dx: number; dy: number };
  };
  children: PenNode[];
}

const PEN_VERSION = '2.11';

/** Figma 노드 타입 → pen type. null이면 표시 안 함 (메타 노드) */
function mapNodeType(type: string): PenNode['type'] | null {
  switch (type) {
    case 'FRAME':
    case 'GROUP':
    case 'SECTION':
    case 'INSTANCE':
    case 'SYMBOL':
    case 'BOOLEAN_OPERATION':
      return 'frame';
    case 'RECTANGLE':
    case 'ROUNDED_RECTANGLE':
      return 'rectangle';
    case 'TEXT':
      return 'text';
    case 'VECTOR':
    case 'STAR':
    case 'LINE':
    case 'ELLIPSE':
    case 'REGULAR_POLYGON':
      return 'path';
    // hidden 메타
    case 'DOCUMENT':
    case 'CANVAS':
    case 'VARIABLE_SET':
    case 'VARIABLE':
    case 'BRUSH':
    case 'CODE_LIBRARY':
      return null;
    default:
      return null;
  }
}

/** rgba(0..1) → "#rrggbbaa" 8자리 hex (Pencil reference 관찰: fill/stroke는 항상 8자 유지) */
function colorToHex(c: { r?: number; g?: number; b?: number; a?: number }): string {
  const r = clampByte(c.r ?? 0);
  const g = clampByte(c.g ?? 0);
  const b = clampByte(c.b ?? 0);
  const a = clampByte(c.a ?? 1);
  return '#' + [r, g, b, a].map((n) => n.toString(16).padStart(2, '0')).join('');
}

/** rgba(0..1) → "#rrggbb" or "#rrggbbaa" — alpha=1.0면 6자.
 *  Pencil reference의 effect.color에만 사용. */
function colorToHexShortAlpha(c: { r?: number; g?: number; b?: number; a?: number }): string {
  const r = clampByte(c.r ?? 0);
  const g = clampByte(c.g ?? 0);
  const b = clampByte(c.b ?? 0);
  const a = clampByte(c.a ?? 1);
  const base = '#' + [r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('');
  return a === 255 ? base : base + a.toString(16).padStart(2, '0');
}

/** Figma paint(`{color, opacity}`) → "#rrggbbaa" 합성 hex.
 *  Figma는 color.a (색 자체의 알파) + paint.opacity (페인트 레이어 투명도)를 분리 저장 →
 *  최종 알파 = color.a × paint.opacity. 둘 중 하나만 보면 stroke/fill 색이 진하게 나옴. */
function paintToHex(paint: { color?: { r?: number; g?: number; b?: number; a?: number }; opacity?: number }): string | null {
  if (!paint.color) return null;
  const c = paint.color;
  const colorA = c.a ?? 1;
  const paintA = typeof paint.opacity === 'number' ? paint.opacity : 1;
  return colorToHex({ r: c.r, g: c.g, b: c.b, a: colorA * paintA });
}
function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v * 255)));
}

/**
 * 단일 paint → PenFillSingle.
 * Pencil 동작: visible=false도 보존 (`enabled: false` 객체).
 * - SOLID + visible=true → bare hex string
 * - SOLID + visible=false → { type: 'color', color, enabled: false }
 * - IMAGE → { type: 'image', enabled, url, mode }
 * - GRADIENT → { type: 'gradient', enabled }
 */
function paintToFillSingle(paint: Record<string, unknown>): PenFillSingle | null {
  const t = paint.type;
  const enabled = paint.visible !== false;
  if (t === 'SOLID' && paint.color) {
    const hex = paintToHex(paint as { color?: { r?: number; g?: number; b?: number; a?: number }; opacity?: number });
    if (!hex) return null;
    if (enabled) return hex; // 활성화된 단순 색은 hex string만 (Pencil 동일)
    return { type: 'color', color: hex, enabled: false };
  }
  if (t === 'IMAGE') {
    const image = paint.image as { hash?: unknown } | undefined;
    void image;
    return {
      type: 'image',
      enabled,
      url: '', // 이미지 hash는 sidecar에서 추적
      // Figma scaleMode → Pencil mode. 정적 매핑 — Pencil reference도 일관성이 떨어짐(같은 FILL이 어떤 곳은 'fill' 어떤 곳은 'stretch')
      // 가장 흔한 케이스 우선: FIT → 'fit', 그 외 'fill'.
      mode: paint.scaleMode === 'FIT' ? 'fit' : 'fill',
    };
  }
  if (t === 'GRADIENT_LINEAR' || t === 'GRADIENT_RADIAL' || t === 'GRADIENT_ANGULAR') {
    return { type: 'gradient', enabled };
  }
  return null;
}

/**
 * 다중 paint 배열 → PenFill.
 * - 0개: null
 * - 1개: 단일 PenFillSingle
 * - 2+: array
 */
function paintsToFill(paints: Array<Record<string, unknown>>): PenFill | null {
  const layers: PenFillSingle[] = [];
  for (const p of paints) {
    const layer = paintToFillSingle(p);
    if (layer !== null) layers.push(layer);
  }
  if (layers.length === 0) return null;
  if (layers.length === 1) return layers[0]!;
  return layers;
}

function strokeFromNode(data: Record<string, unknown>): PenStroke | undefined {
  // strokeWeight가 있으면 stroke 정보 출력 (Pencil 동작 — strokePaints 없어도 thickness/align만 표시)
  if (typeof data.strokeWeight !== 'number' || data.strokeWeight <= 0) return undefined;
  const align =
    data.strokeAlign === 'INSIDE'
      ? 'inside'
      : data.strokeAlign === 'OUTSIDE'
        ? 'outside'
        : 'center';

  // 비대칭 stroke: borderStrokeWeightsIndependent === true → border{Top,Right,Bottom,Left}Weight 사용.
  // 정의된 면만 thickness 객체에 포함 (Pencil이 빠진 면 = 두께 0으로 해석).
  let thickness: PenStroke['thickness'] = data.strokeWeight;
  if (data.borderStrokeWeightsIndependent === true) {
    const t = data.borderTopWeight as number | undefined;
    const r = data.borderRightWeight as number | undefined;
    const b = data.borderBottomWeight as number | undefined;
    const l = data.borderLeftWeight as number | undefined;
    const obj: { top?: number; right?: number; bottom?: number; left?: number } = {};
    if (typeof t === 'number') obj.top = t;
    if (typeof r === 'number') obj.right = r;
    if (typeof b === 'number') obj.bottom = b;
    if (typeof l === 'number') obj.left = l;
    if (Object.keys(obj).length > 0) thickness = obj;
  }
  const result: PenStroke = { align, thickness };
  const strokes = data.strokePaints as Array<Record<string, unknown>> | undefined;
  const first = strokes?.find((s) => s.visible !== false);
  if (first?.type === 'SOLID' && first.color) {
    const hex = paintToHex(first as { color?: { r?: number; g?: number; b?: number; a?: number }; opacity?: number });
    if (hex) result.fill = hex;
  }
  return result;
}

function effectFromNode(data: Record<string, unknown>): PenEffect | undefined {
  const effects = data.effects as Array<Record<string, unknown>> | undefined;
  const first = effects?.find((e) => e.visible !== false);
  if (!first) return undefined;
  const t = first.type;
  if (t === 'DROP_SHADOW' || t === 'INNER_SHADOW') {
    const color = first.color as { r?: number; g?: number; b?: number; a?: number } | undefined;
    const offset = first.offset as { x?: number; y?: number } | undefined;
    // Pencil reference 관찰: blur = Figma radius × 0.875 (= 7/8). 정확한 이유는 불명이나
    // Pencil 자체의 컨버터가 일관되게 이 비율로 변환 (radius 4 → 3.5, 8 → 7 등).
    const radius = (first.radius as number) ?? 0;
    return {
      type: 'shadow',
      shadowType: t === 'INNER_SHADOW' ? 'inner' : 'outer',
      color: color ? colorToHexShortAlpha(color) : undefined,
      offset: { x: offset?.x ?? 0, y: offset?.y ?? 0 },
      blur: radius * 0.875,
    };
  }
  if (t === 'LAYER_BLUR' || t === 'BACKGROUND_BLUR') {
    return { type: 'blur', blur: (first.radius as number) ?? 0 };
  }
  return undefined;
}

/**
 * stackMode 기반 노드의 auto-layout 정보.
 * Pencil convention:
 *   - layout 'horizontal'은 default라 키 omit
 *   - layout 'vertical' 또는 'none'만 명시
 *   - padding: 모두 동일 → number, [vert, horz]일 땐 [v, h], 4개 다르면 [t, r, b, l]
 */
function layoutFromNode(data: Record<string, unknown>): {
  layout?: PenNode['layout'];
  alignItems?: string;
  justifyContent?: string;
  gap?: number;
  padding?: number | number[] | { top: number; right: number; bottom: number; left: number };
} {
  const stackMode = data.stackMode as string | undefined;
  // GRID는 Pencil이 지원하지 않으므로 'none'으로 fallback
  if (!stackMode || stackMode === 'NONE' || stackMode === 'GRID') {
    return { layout: 'none' };
  }

  const out: ReturnType<typeof layoutFromNode> = {};
  // 'horizontal'은 default — 키 omit. 'vertical'만 명시.
  if (stackMode === 'VERTICAL') out.layout = 'vertical';
  // HORIZONTAL은 layout 키 안 넣음

  // Figma의 실제 필드는 `stackSpacing` (`itemSpacing`이 아님 — 흔한 착각)
  const stackSpacing = data.stackSpacing as number | undefined;
  if (typeof stackSpacing === 'number' && stackSpacing > 0) out.gap = stackSpacing;

  // padding 단축형 — Figma 필드: stackHorizontalPadding/stackVerticalPadding이 기본,
  // stackPaddingTop/Right/Bottom/Left가 per-side override.
  const pad = getPadding(data);
  const pT = pad.top;
  const pR = pad.right;
  const pB = pad.bottom;
  const pL = pad.left;
  if (pT > 0 || pR > 0 || pB > 0 || pL > 0) {
    if (pT === pR && pT === pB && pT === pL) {
      out.padding = pT; // 모두 동일 → 단일 number
    } else if (pT === pB && pR === pL) {
      out.padding = [pT, pR]; // [vertical, horizontal] CSS shorthand
    } else {
      out.padding = [pT, pR, pB, pL]; // [top, right, bottom, left]
    }
  }

  // alignment — Pencil 스키마는 'start' | 'center' | 'end' | 'space_between' | 'space_around' / 'start' | 'center' | 'end'
  // (CSS의 'flex-start'/'flex-end'가 아님 — schema 그대로 'start'/'end' 사용)
  const stackAlign = data.stackPrimaryAlignItems as string | undefined;
  if (stackAlign === 'MIN') out.justifyContent = 'start';
  else if (stackAlign === 'CENTER') out.justifyContent = 'center';
  else if (stackAlign === 'MAX') out.justifyContent = 'end';
  else if (stackAlign === 'SPACE_BETWEEN') out.justifyContent = 'space_between';
  else if (stackAlign === 'SPACE_EVENLY') out.justifyContent = 'space_around';

  const stackCounter = data.stackCounterAlignItems as string | undefined;
  if (stackCounter === 'MIN') out.alignItems = 'start';
  else if (stackCounter === 'CENTER') out.alignItems = 'center';
  else if (stackCounter === 'MAX') out.alignItems = 'end';
  // BASELINE은 Pencil 스키마에 없음 — 'start'로 fallback
  else if (stackCounter === 'BASELINE') out.alignItems = 'start';

  return out;
}

/**
 * width/height axis별 omit 결정 (Pencil convention).
 * - 자기가 auto-layout container: stackPrimarySizing/CounterSizing 별로
 * - 부모가 auto-layout: 자식은 양쪽 omit (단 absolute 자식 제외)
 * - TEXT: textAutoResize에 따라
 */
function omitDimensions(
  data: Record<string, unknown>,
  nodeType: string,
  parentData: Record<string, unknown> | undefined,
): { width: boolean; height: boolean } {
  // TEXT: auto-resize 모드별
  if (nodeType === 'TEXT') {
    const ar = data.textAutoResize as string | undefined;
    if (ar === 'WIDTH_AND_HEIGHT') return { width: true, height: true };
    if (ar === 'HEIGHT') return { width: false, height: true };
    // NONE/TRUNCATE: 둘 다 명시
    return { width: false, height: false };
  }

  // 자기가 auto-layout container —
  //   - primary axis: 기본 AUTO (hug). 명시적 'FIXED'일 때만 표시.
  //   - counter axis: 기본 FIXED (표시). 명시적 비-FIXED(AUTO 등)일 때만 omit.
  // (Figma 기본값 차이를 반영). GRID는 제외.
  const myStack = data.stackMode as string | undefined;
  if (myStack && myStack !== 'NONE' && myStack !== 'GRID') {
    const primary = data.stackPrimarySizing as string | undefined;
    const counter = data.stackCounterSizing as string | undefined;
    const primaryAuto = !primary || primary !== 'FIXED';
    const counterAuto = counter !== undefined && counter !== 'FIXED';
    if (myStack === 'HORIZONTAL') {
      return { width: primaryAuto, height: counterAuto };
    }
    return { width: counterAuto, height: primaryAuto };
  }

  // 그 외 (auto-layout 부모의 자식 포함): 항상 명시 (Pencil convention)
  return { width: false, height: false };
}

/**
 * 자식이 부모 컨테이너를 채우는지 판단 (Pencil 'fill_container' 표현용).
 * - 부모 stack 방향(primary)이 자식 layoutGrow=1이면 → primary axis fill
 * - 부모 stack 수직(counter)이 자식 layoutAlign='STRETCH'면 → counter axis fill
 */
function computeFillContainer(
  data: Record<string, unknown>,
  parentData: Record<string, unknown> | undefined,
  _nodeType?: string,
): { width: boolean; height: boolean } {
  if (!parentData) return { width: false, height: false };
  const parentStack = parentData.stackMode as string | undefined;
  if (!parentStack || parentStack === 'NONE' || parentStack === 'GRID') return { width: false, height: false };
  // Figma 필드: stackChildPrimaryGrow (layoutGrow), stackChildAlignSelf (layoutAlign)
  const layoutGrow =
    (data.stackChildPrimaryGrow as number | undefined) ?? (data.layoutGrow as number | undefined);
  const layoutAlign =
    (data.stackChildAlignSelf as string | undefined) ?? (data.layoutAlign as string | undefined);
  // STRETCH는 실제 사이즈가 parent's available counter axis와 일치할 때만 fill_container (Pencil 동작)
  const childSize = data.size as { x?: number; y?: number } | undefined;
  const parentSize = parentData.size as { x?: number; y?: number } | undefined;
  const pad = getPadding(parentData);
  const primaryFill = layoutGrow === 1;
  let counterFill = layoutAlign === 'STRETCH';
  if (counterFill && childSize && parentSize) {
    if (parentStack === 'HORIZONTAL') {
      const avail = (parentSize.y ?? 0) - pad.top - pad.bottom;
      if (Math.abs((childSize.y ?? 0) - avail) > 0.01) counterFill = false;
    } else {
      const avail = (parentSize.x ?? 0) - pad.left - pad.right;
      if (Math.abs((childSize.x ?? 0) - avail) > 0.01) counterFill = false;
    }
  }
  if (parentStack === 'HORIZONTAL') {
    return { width: primaryFill, height: counterFill };
  }
  return { width: counterFill, height: primaryFill };
}

/**
 * 부모가 auto-layout이면 자식의 x/y는 layout이 결정 → omit (Pencil convention).
 * 단, parent가 INSTANCE 치환 결과(merged)면 children 위치는 항상 명시 (Pencil 동작).
 * TEXT 노드는 INSTANCE 치환 여부와 관계 없이 auto-layout parent에서 position omit.
 */
function shouldOmitPosition(
  data: Record<string, unknown>,
  parentData: Record<string, unknown> | undefined,
  parentIsInstanceReplaced: boolean,
  nodeType: string,
  effectiveVisible: boolean,
): boolean {
  if (!parentData) return false;
  const parentStack = parentData.stackMode as string | undefined;
  // GRID는 auto-layout으로 안 침 (Pencil은 GRID 미지원 → 자식 위치 명시)
  if (!parentStack || parentStack === 'NONE' || parentStack === 'GRID') return false;
  const myPos = data.stackPositioning as string | undefined;
  if (myPos === 'ABSOLUTE') return false;
  // 숨겨진 노드(visible:false 또는 propAssignments로 토글)는 auto-layout flow에서 빠지므로
  // 항상 명시적 위치 표시 (Pencil 동작과 일치)
  if (!effectiveVisible) return false;
  const showPosOverride = (data as { _showPos?: boolean })._showPos;
  // TEXT: 항상 auto-layout parent에서 position omit (textAutoResize 무관, _showPos 무시)
  if (nodeType === 'TEXT') return true;
  // overlap/shrunk 자식은 항상 위치 명시 (auto-layout flow가 결정할 수 없음)
  if (showPosOverride === true) return false;
  // INSTANCE 치환된 부모의 (non-text) 자식: _showPos가 false면 omit, 그 외 명시
  if (parentIsInstanceReplaced && showPosOverride !== false) return false;
  return true;
}

/** Figma auto-layout 노드의 padding 추출 (stackHorizontalPadding/Vertical 기본 + per-side override) */
function getPadding(data: Record<string, unknown>): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  const h = data.stackHorizontalPadding as number | undefined;
  const v = data.stackVerticalPadding as number | undefined;
  return {
    top: (data.stackPaddingTop as number | undefined) ?? v ?? 0,
    right: (data.stackPaddingRight as number | undefined) ?? h ?? 0,
    bottom: (data.stackPaddingBottom as number | undefined) ?? v ?? 0,
    left: (data.stackPaddingLeft as number | undefined) ?? h ?? 0,
  };
}

/** Figma fontName.style ("Bold", "Medium", etc.) → Pencil 호환 fontWeight (`StringOrVariable`).
 *  Pencil reference 관찰: 모두 string. 400만 'normal', 나머진 모두 numeric string ("700", "500"…).
 *  ※ 'bold'를 출력하지 말 것 — reference는 "Bold"도 "700"으로 표기. */
function fontWeightName(fontStyle?: string): string {
  if (!fontStyle) return 'normal';
  const lc = fontStyle.toLowerCase();
  if (lc.includes('thin')) return '100';
  if (lc.includes('extra light') || lc.includes('extralight')) return '200';
  if (lc.includes('light')) return '300';
  if (lc.includes('semi bold') || lc.includes('semibold')) return '600';
  if (lc.includes('extra bold') || lc.includes('extrabold')) return '800';
  if (lc.includes('black') || lc.includes('heavy')) return '900';
  if (lc.includes('bold')) return '700';
  if (lc.includes('medium')) return '500';
  if (lc.includes('regular') || lc.includes('normal')) return 'normal';
  return 'normal';
}

/**
 * Pencil-style 트리 변환 (depth-first).
 * vectorSvgMap: VECTOR 노드 GUID → SVG path geometry 'M ...' 추출 결과
 */
/** SYMBOL 인덱스 — INSTANCE → master children inline용 */
function buildSymbolIndex(allNodes: Map<string, TreeNode>): Map<string, TreeNode> {
  const idx = new Map<string, TreeNode>();
  for (const n of allNodes.values()) {
    if (n.type === 'SYMBOL') idx.set(n.guidStr, n);
  }
  return idx;
}

/**
 * INSTANCE의 symbolOverrides를 master 자손 트리에 적용.
 * guidPath로 descendant를 찾아 visible/size/etc override.
 *
 * Pencil 동작: instance의 visibility override는 master 자식의 effective visibility를 결정한다.
 * (예: master에서 visible:false인 option이 instance override로 visible:true가 되면 flow에 포함)
 */
function applySymbolOverrides(
  children: TreeNode[],
  overrides: Array<Record<string, unknown>> | undefined,
): TreeNode[] {
  if (!Array.isArray(overrides) || overrides.length === 0) return children;
  // 깊이 1: 직접 자식. guidPath.guids[0]이 자식 guid인 것만 filter & group.
  // guids[1+]는 더 깊은 descendants — 자식 변환 시 recursive 적용.
  type Override = Record<string, unknown> & { guidPath?: { guids?: Array<{ sessionID?: number; localID?: number }> } };
  const directByGuid = new Map<string, Override[]>();
  const nestedByGuid = new Map<string, Override[]>();
  for (const o of overrides as Override[]) {
    const guids = o.guidPath?.guids;
    if (!Array.isArray(guids) || guids.length === 0) continue;
    const head = guids[0];
    if (!head || typeof head.sessionID !== 'number' || typeof head.localID !== 'number') continue;
    const key = `${head.sessionID}:${head.localID}`;
    if (guids.length === 1) {
      const arr = directByGuid.get(key) ?? [];
      arr.push(o);
      directByGuid.set(key, arr);
    } else {
      const arr = nestedByGuid.get(key) ?? [];
      arr.push(o);
      nestedByGuid.set(key, arr);
    }
  }
  if (directByGuid.size === 0 && nestedByGuid.size === 0) return children;

  return children.map((c) => {
    const direct = directByGuid.get(c.guidStr);
    const nested = nestedByGuid.get(c.guidStr);
    let modifiedData = c.data as Record<string, unknown>;
    let modifiedChildren = c.children;
    if (direct) {
      const merged = { ...modifiedData };
      for (const o of direct) {
        // visible/size/etc: override 필드를 master data에 덮어씀
        for (const k of Object.keys(o)) {
          if (k === 'guidPath') continue;
          (merged as Record<string, unknown>)[k] = o[k];
        }
      }
      modifiedData = merged;
    }
    if (nested) {
      // 다음 레벨로 내려가는 path: guids 첫 번째 제거 후 재귀
      const nextLevel: Override[] = nested.map((o) => ({
        ...o,
        guidPath: { guids: (o.guidPath?.guids ?? []).slice(1) },
      }));
      modifiedChildren = applySymbolOverrides(c.children, nextLevel);
    }
    if (modifiedData === c.data && modifiedChildren === c.children) return c;
    return { ...c, data: modifiedData as never, children: modifiedChildren };
  });
}

/**
 * Auto-layout master의 children counter axis 위치를 instance size에 맞춰 재계산.
 * - HORIZONTAL master: counter = y (height). instance height ≠ master height면 y 재계산.
 * - VERTICAL master: counter = x (width). instance width ≠ master width면 x 재계산.
 * stackCounterAlignItems에 따라 MIN/CENTER/MAX/STRETCH.
 */
function reflowMasterChildren(
  children: TreeNode[],
  masterData: Record<string, unknown>,
  masterSize: { x?: number; y?: number } | undefined,
  instSize: { x?: number; y?: number } | undefined,
): TreeNode[] {
  const stackMode = masterData.stackMode as string | undefined;
  if (!stackMode || stackMode === 'NONE' || stackMode === 'GRID') return children;
  if (!masterSize || !instSize) return children;
  const counterAlign = masterData.stackCounterAlignItems as string | undefined;
  const pad = getPadding(masterData);
  const isHorizontal = stackMode === 'HORIZONTAL';
  const instCounter = isHorizontal ? instSize.y : instSize.x;
  const masterCounter = isHorizontal ? masterSize.y : masterSize.x;
  if (typeof instCounter !== 'number' || typeof masterCounter !== 'number') return children;
  const padStart = isHorizontal ? pad.top : pad.left;
  const padEnd = isHorizontal ? pad.bottom : pad.right;
  const availCounter = instCounter - padStart - padEnd;
  const counterChanged = instCounter !== masterCounter;

  // 자식별 expected flow primary axis 위치 계산 (auto-layout MIN/start 기준)
  const gap = (masterData.stackSpacing as number | undefined) ?? 0;
  const primaryAlign = masterData.stackPrimaryAlignItems as string | undefined;
  const expectedPrimary: number[] = [];
  if (primaryAlign === 'CENTER' || primaryAlign === 'MAX' || primaryAlign === 'SPACE_EVENLY' || primaryAlign === 'SPACE_BETWEEN') {
    for (let i = 0; i < children.length; i++) expectedPrimary.push(NaN);
  } else {
    let cur = isHorizontal ? pad.left : pad.top;
    for (const c of children) {
      expectedPrimary.push(cur);
      const csz = (c.data as Record<string, unknown>).size as { x?: number; y?: number } | undefined;
      const sz = isHorizontal ? (csz?.x ?? 0) : (csz?.y ?? 0);
      cur += sz + gap;
    }
  }

  // primary axis가 instance에서 master보다 작아지면 → auto-layout flow 불가능, 모든 자식 위치 명시
  // 크거나 같으면 → flow 가능, overlap된 자식만 명시
  const instPrimary = isHorizontal ? instSize.x : instSize.y;
  const masterPrimary = isHorizontal ? masterSize.x : masterSize.y;
  const primaryShrunk =
    typeof instPrimary === 'number' &&
    typeof masterPrimary === 'number' &&
    instPrimary < masterPrimary;

  // overlap 그룹 감지: master에서 동일 primary 위치가 반복되는 자식들
  // → primary가 instance에서 더 클 때(reflow 가능) overlap된 자식들을 flow 위치로 분산
  //   분산 후 LAST one만 _showPos=true (Pencil 동작과 일치)
  const overlapGroupLastIdx = new Set<number>();
  if (!primaryShrunk && children.length > 0) {
    const masterPrimaryAt: number[] = [];
    for (const c of children) {
      const ctr = (c.data as Record<string, unknown>).transform as { m02?: number; m12?: number } | undefined;
      masterPrimaryAt.push(isHorizontal ? (ctr?.m02 ?? 0) : (ctr?.m12 ?? 0));
    }
    const lastIdxByValue = new Map<number, number>();
    const countByValue = new Map<number, number>();
    for (let i = 0; i < masterPrimaryAt.length; i++) {
      const v = masterPrimaryAt[i];
      countByValue.set(v, (countByValue.get(v) || 0) + 1);
      lastIdxByValue.set(v, i);
    }
    for (const [v, count] of countByValue) {
      if (count > 1) overlapGroupLastIdx.add(lastIdxByValue.get(v)!);
    }
  }

  return children.map((c, idx) => {
    const cdata = c.data as Record<string, unknown>;
    const csize = cdata.size as { x?: number; y?: number } | undefined;
    const ctr = cdata.transform as { m02?: number; m12?: number } | undefined;
    if (!csize) return c;
    const f32 = Math.fround;
    let newSize = csize;
    let newTransform = ctr;
    // 위치 명시 규칙:
    //   - primary 축이 instance에서 master보다 작아짐 → 모든 자식 위치 명시 (flow 불가)
    //   - overlap 그룹의 LAST one → reflow + 명시
    //   - 그 외: flow 계산 가능 시 omit (auto-flow가 결정)
    let showPosOverride: boolean | undefined;
    if (primaryShrunk) {
      showPosOverride = true;
    } else if (overlapGroupLastIdx.has(idx)) {
      showPosOverride = true;
      const expected = expectedPrimary[idx];
      if (typeof expected === 'number' && !Number.isNaN(expected) && ctr) {
        newTransform = isHorizontal
          ? { ...ctr, m02: f32(expected) }
          : { ...ctr, m12: f32(expected) };
      }
    } else {
      const expected = expectedPrimary[idx];
      if (typeof expected === 'number' && !Number.isNaN(expected)) {
        showPosOverride = false;
      }
    }
    // STRETCH 자식: counter axis size를 instance available에 맞춤
    // master 원본 size는 _masterCounterSize에 저장 (Pencil의 fill_container(N) 표기)
    const childAlign = cdata.stackChildAlignSelf as string | undefined;
    let masterCounterSize: number | undefined;
    if (childAlign === 'STRETCH') {
      const origCounter = isHorizontal ? csize.y : csize.x;
      const newCounterVal = f32(availCounter);
      if (typeof origCounter === 'number' && origCounter !== availCounter) {
        masterCounterSize = origCounter;
      }
      if (isHorizontal) {
        newSize = { ...csize, y: newCounterVal };
      } else {
        newSize = { ...csize, x: newCounterVal };
      }
    }
    // counter axis 위치 재계산 (size 변화에 따라).
    // showPos=true (위치 명시)인 경우 master의 정확한 위치를 보존 — flow 재계산 안 함.
    if (counterChanged && showPosOverride !== true && (newTransform || ctr)) {
      const childCounterSize = isHorizontal
        ? (newSize.y ?? csize.y ?? 0)
        : (newSize.x ?? csize.x ?? 0);
      let newCounter: number;
      if (counterAlign === 'CENTER') {
        newCounter = padStart + (availCounter - childCounterSize) / 2;
      } else if (counterAlign === 'MAX') {
        newCounter = instCounter - padEnd - childCounterSize;
      } else {
        newCounter = padStart;
      }
      const base = newTransform ?? ctr!;
      newTransform = isHorizontal
        ? { ...base, m12: f32(newCounter) }
        : { ...base, m02: f32(newCounter) };
    }
    if (newSize === csize && newTransform === ctr && masterCounterSize === undefined && showPosOverride === undefined) return c;
    return {
      ...c,
      data: {
        ...cdata,
        size: newSize,
        ...(newTransform ? { transform: newTransform } : {}),
        ...(masterCounterSize !== undefined ? { _masterCounterSize: masterCounterSize } : {}),
        ...(showPosOverride !== undefined ? { _showPos: showPosOverride } : {}),
      } as never,
    };
  });
}

/**
 * 노드와 그 자손들의 guidStr에 prefix를 붙여 unique 만들기.
 * INSTANCE → master 확장 시 master 자손 GUID가 여러 INSTANCE 사이에서 충돌하므로 필수.
 *
 * Pencil .pen 스펙은 같은 파일 내 unique id를 요구한다 (pencil.dev 앱이 중복 시 import 실패).
 *
 * Pretix는 가까운 INSTANCE의 guidStr (이미 prefix가 적용된 상태일 수 있음).
 * 결과: `${prefix}/${node.guidStr}` 형태로 모든 자손이 unique해짐.
 */
function prefixGuids(n: TreeNode, prefix: string): TreeNode {
  return {
    ...n,
    guidStr: `${prefix}/${n.guidStr}`,
    children: n.children.map((c) => prefixGuids(c, prefix)),
  };
}

/**
 * 노드와 그 자손들의 transform.m02/m12 / size를 sx/sy 비율로 스케일.
 * INSTANCE resize 시 master 자식들에게 적용 (Pencil 동작과 일치).
 */
function scaleNode(n: TreeNode, sx: number, sy: number): TreeNode {
  if (sx === 1 && sy === 1) return n;
  const data = n.data as Record<string, unknown>;
  const transform = data.transform as
    | { m00?: number; m01?: number; m02?: number; m10?: number; m11?: number; m12?: number }
    | undefined;
  const size = data.size as { x?: number; y?: number } | undefined;
  // Float32 정밀도로 반올림 (Pencil이 사용하는 표현)
  const f32 = Math.fround;
  return {
    ...n,
    data: {
      ...data,
      transform: transform
        ? {
            ...transform,
            m02: typeof transform.m02 === 'number' ? f32(transform.m02 * sx) : transform.m02,
            m12: typeof transform.m12 === 'number' ? f32(transform.m12 * sy) : transform.m12,
          }
        : transform,
      size: size
        ? {
            ...size,
            x: typeof size.x === 'number' ? f32(size.x * sx) : size.x,
            y: typeof size.y === 'number' ? f32(size.y * sy) : size.y,
          }
        : size,
    } as never,
    children: n.children.map((c) => scaleNode(c, sx, sy)),
  };
}

/** 부모 + 자기 INSTANCE의 prop assignments 합치기. 자기(가까운) 값이 부모를 override. */
function mergeAssignments(
  parent: Map<string, boolean> | undefined,
  child: Map<string, boolean> | undefined,
): Map<string, boolean> | undefined {
  if (!parent && !child) return undefined;
  if (!parent) return child;
  if (!child) return parent;
  const out = new Map(parent);
  for (const [k, v] of child) out.set(k, v);
  return out;
}

/**
 * INSTANCE의 componentPropAssignments → defID(`s:l`) → boolValue/instance값 Map.
 * 자손 노드의 componentPropRefs(VISIBLE)에 매핑해 effective visibility 결정에 사용.
 */
function buildPropAssignmentMap(
  instData: Record<string, unknown>,
): Map<string, boolean> | undefined {
  const cpa = instData.componentPropAssignments as
    | Array<{
        defID?: { sessionID?: number; localID?: number };
        value?: { boolValue?: boolean };
        varValue?: { value?: { boolValue?: boolean }; dataType?: string };
      }>
    | undefined;
  if (!Array.isArray(cpa) || cpa.length === 0) return undefined;
  const out = new Map<string, boolean>();
  for (const a of cpa) {
    const d = a.defID;
    if (!d || typeof d.sessionID !== 'number' || typeof d.localID !== 'number') continue;
    // Figma stores the boolean in either `value.boolValue` (직접 세팅) 또는
    // `varValue.value.boolValue` (variant/default 경유). 둘 다 체크해야 안 빠짐.
    const directV = a.value?.boolValue;
    const varV = a.varValue?.value?.boolValue;
    const v = typeof directV === 'boolean' ? directV : (typeof varV === 'boolean' ? varV : undefined);
    if (typeof v !== 'boolean') continue;
    out.set(`${d.sessionID}:${d.localID}`, v);
  }
  return out.size > 0 ? out : undefined;
}

/**
 * INSTANCE의 derivedSymbolData[] → guidPath → derived 항목 Map.
 *
 * Figma의 derivedSymbolData는 instance마다 모든 override/variable/inheritance가
 * 이미 적용된 사전-계산 snapshot (Figma copy/paste가 이걸 직렬화함).
 * raw master에서 우리가 다시 resolve하면 gap 발생 → derivedSymbolData가 authoritative.
 *
 * 각 entry:
 *   - guidPath.guids[] — master 기준 descendant 경로 ([masterChildGuid] 또는 [child, grand-child, ...])
 *   - derivedTextData — 텍스트 노드의 fully-resolved fontMetaData (fontWeight, family, style 등)
 *   - fillGeometry — 벡터 노드의 resolved 경로 (commandsBlob index)
 *   - size, transform — instance에서의 실제 크기/위치
 */
function buildDerivedMap(
  instData: Record<string, unknown>,
): Map<string, Record<string, unknown>> | undefined {
  const ds = instData.derivedSymbolData as
    | Array<Record<string, unknown> & { guidPath?: { guids?: Array<{ sessionID?: number; localID?: number }> } }>
    | undefined;
  if (!Array.isArray(ds) || ds.length === 0) return undefined;
  const out = new Map<string, Record<string, unknown>>();
  for (const entry of ds) {
    const guids = entry.guidPath?.guids;
    if (!Array.isArray(guids) || guids.length === 0) continue;
    const key = guids.map((g) => `${g.sessionID}:${g.localID}`).join('/');
    out.set(key, entry);
  }
  return out.size > 0 ? out : undefined;
}

/**
 * derivedMap을 master children에 적용 — 매칭되는 descendant의 data에
 * `_derivedTextData`, `_derivedFillGeometry` 등 마커 stamp.
 * convertNode의 text/path branch가 이 마커를 우선 사용 → Figma의 사전-resolved 값을 그대로 반영.
 *
 * derivedMap의 guidPath는 master 기준이라, 자손 트리를 따라 내려가며 부분 매칭 가능.
 *  깊이 1: guidPath = [c.guid] → c에 stamp
 *  깊이 2+: guidPath = [c.guid, gc.guid] → c의 children 처리 시 [gc.guid]로 줄여 재귀
 */
function applyDerivedSymbolData(
  children: TreeNode[],
  derivedMap: Map<string, Record<string, unknown>>,
): TreeNode[] {
  if (derivedMap.size === 0) return children;
  // Group entries by first-level guid; entries whose path is exactly [guid] applied here, deeper ones recurse
  const directByGuid = new Map<string, Record<string, unknown>>();
  const nestedByGuid = new Map<string, Map<string, Record<string, unknown>>>();
  for (const [pathKey, entry] of derivedMap) {
    const segs = pathKey.split('/');
    const head = segs[0]!;
    if (segs.length === 1) {
      directByGuid.set(head, entry);
    } else {
      const rest = segs.slice(1).join('/');
      if (!nestedByGuid.has(head)) nestedByGuid.set(head, new Map());
      nestedByGuid.get(head)!.set(rest, entry);
    }
  }
  return children.map((c) => {
    const direct = directByGuid.get(c.guidStr);
    const nested = nestedByGuid.get(c.guidStr);
    let data = c.data as Record<string, unknown>;
    let kids = c.children;
    if (direct) {
      const merged = { ...data };
      if (direct.derivedTextData !== undefined) merged._derivedTextData = direct.derivedTextData;
      if (direct.fillGeometry !== undefined) merged._derivedFillGeometry = direct.fillGeometry;
      if (direct.size !== undefined) merged._derivedSize = direct.size;
      if (direct.transform !== undefined) merged._derivedTransform = direct.transform;
      data = merged;
    }
    if (nested) kids = applyDerivedSymbolData(c.children, nested);
    if (data === c.data && kids === c.children) return c;
    return { ...c, data: data as never, children: kids };
  });
}

/**
 * 노드의 componentPropRefs(VISIBLE)가 propAssignments에 의해 false로 토글되었는지.
 * - propRefs[].defID가 assignments에 있고 그 boolValue=false → 자식 hidden.
 * - boolValue=true이면 표시 (강제 visible — Figma의 boolean prop 의미).
 */
function isHiddenByPropAssignment(
  data: Record<string, unknown>,
  assignments: Map<string, boolean>,
): boolean {
  const refs = data.componentPropRefs as
    | Array<{ defID?: { sessionID?: number; localID?: number }; componentPropNodeField?: string }>
    | undefined;
  if (!Array.isArray(refs)) return false;
  for (const r of refs) {
    if (r.componentPropNodeField !== 'VISIBLE') continue;
    const d = r.defID;
    if (!d || typeof d.sessionID !== 'number' || typeof d.localID !== 'number') continue;
    const v = assignments.get(`${d.sessionID}:${d.localID}`);
    if (v === false) return true;
  }
  return false;
}

function convertNode(
  n: TreeNode,
  vectorPathMap: Map<string, string>,
  symbolIndex?: Map<string, TreeNode>,
  parentData?: Record<string, unknown>,
  parentIsInstanceReplaced: boolean = false,
  propAssignments?: Map<string, boolean>,
  nodeIndex?: Map<string, TreeNode>,
): PenNode | null {
  // ★ INSTANCE를 master로 대체 (Pencil 동작과 일치)
  // INSTANCE는 master의 시각 정보(fill/stroke)와 자식을 가져오되
  // 위치(transform)·사이즈(size)·GUID는 INSTANCE 자체 유지.
  // 사이즈 차이가 있으면 자식들을 비례 스케일링 (Pencil 동작).
  if (n.type === 'INSTANCE' && n.children.length === 0 && symbolIndex) {
    const instData = n.data as Record<string, unknown>;
    const sd = instData.symbolData as Record<string, unknown> | undefined;
    if (sd && typeof sd === 'object') {
      const sid = sd.symbolID as { sessionID?: number; localID?: number } | undefined;
      if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
        const masterGuid = `${sid.sessionID}:${sid.localID}`;
        const master = symbolIndex.get(masterGuid);
        if (master) {
          const masterData = master.data as Record<string, unknown>;
          const masterSize = masterData.size as { x?: number; y?: number } | undefined;
          const instSize = instData.size as { x?: number; y?: number } | undefined;
          // INSTANCE의 size 우선 (override 가능)
          const finalSize = instSize ?? masterSize;
          // master → instance 스케일 비율 (master에 stackMode 없을 때만 적용)
          // - master.stackMode 있음: auto-layout이 자식 위치/크기 결정, 스케일 X
          // - master.stackMode 없음(NONE): 절대 좌표 자식들을 비례 스케일
          const masterStack = masterData.stackMode as string | undefined;
          const useScale = !masterStack || masterStack === 'NONE';
          let sx = 1, sy = 1;
          if (useScale && masterSize && instSize) {
            if (masterSize.x && instSize.x) sx = instSize.x / masterSize.x;
            if (masterSize.y && instSize.y) sy = instSize.y / masterSize.y;
          }
          // INSTANCE의 symbolOverrides를 먼저 master children에 적용 (visible/size/etc).
          // 이후 reflow가 effective visibility 변화를 인지하고 flow position 계산.
          const symbolOverrides = sd.symbolOverrides as
            | Array<Record<string, unknown>>
            | undefined;
          let overriddenChildren = applySymbolOverrides(master.children, symbolOverrides);
          // ★ derivedSymbolData 적용 — Figma의 사전-resolved 값(font weight/style, fillGeometry, size, transform)이
          //   raw master 값보다 authoritative (Figma copy/paste가 사용하는 그 데이터).
          //   대부분의 텍스트 fontWeight 미스매치와 vector path 차이의 근본 해결책.
          const derivedMap = buildDerivedMap(instData);
          if (derivedMap) overriddenChildren = applyDerivedSymbolData(overriddenChildren, derivedMap);
          let scaledChildren: TreeNode[];
          if (useScale) {
            scaledChildren = overriddenChildren.map((c) => scaleNode(c, sx, sy));
          } else {
            // Auto-layout master: counter axis size 차이 시 children counter 위치 재계산
            scaledChildren = reflowMasterChildren(overriddenChildren, masterData, masterSize, instSize);
          }
          // ★ master 자손 GUID에 INSTANCE prefix를 붙여 unique 만들기.
          //   여러 INSTANCE가 같은 master를 참조해도 각 확장본의 자손이 충돌하지 않음.
          //   nested INSTANCE의 경우 inner expansion 시 다시 한 번 prefix가 추가되어 깊이별 unique 보장.
          scaledChildren = scaledChildren.map((c) => prefixGuids(c, n.guidStr));
          // master 루트 자체를 타겟팅하는 symbolOverride (guidPath: [masterGuid]) → merged.data에 적용.
          // 예: cornerRadius, strokePaints, borderStrokeWeightsIndependent, borderRightWeight 등.
          const rootOverrideFields: Record<string, unknown> = {};
          if (Array.isArray(symbolOverrides)) {
            for (const o of symbolOverrides) {
              const gp = (o.guidPath as { guids?: Array<{ sessionID?: number; localID?: number }> } | undefined)?.guids;
              if (Array.isArray(gp) && gp.length === 1 && gp[0]?.sessionID === sid.sessionID && gp[0]?.localID === sid.localID) {
                for (const k of Object.keys(o)) {
                  if (k === 'guidPath') continue;
                  rootOverrideFields[k] = o[k];
                }
              }
            }
          }
          // 사이즈가 다르면 INSTANCE 치환된 자식들이 위치 명시 (Pencil 동작)
          const sizesDiffer =
            !!masterSize && !!instSize &&
            ((masterSize.x ?? 0) !== (instSize.x ?? 0) || (masterSize.y ?? 0) !== (instSize.y ?? 0));
          // 단, master에 stackMode가 있고 자식들이 auto-layout flow와 일치하는 경우는 제외
          // (overlap된 자식만 명시 — Pencil 동작과 일치)
          const masterStackMode = masterData.stackMode as string | undefined;
          const useFlowCheck = sizesDiffer && masterStackMode && masterStackMode !== 'NONE' && masterStackMode !== 'GRID';
          // reflow 메타데이터(_masterCounterSize, _showPos)는 INSTANCE의 data에서 보존
          const instMcs = (instData as { _masterCounterSize?: number })._masterCounterSize;
          const instShowPos = (instData as { _showPos?: boolean })._showPos;
          const merged: TreeNode = {
            ...master,
            guidStr: n.guidStr,
            type: master.type,
            name: n.name ?? master.name,
            parentGuid: n.parentGuid,
            position: n.position,
            children: scaledChildren,
            data: {
              ...masterData,
              ...rootOverrideFields,                       // master root 타겟 symbolOverrides 먼저
              size: finalSize,
              transform: instData.transform, // INSTANCE 위치
              // INSTANCE 자체의 visible:false / opacity는 master 값을 override
              ...(instData.visible !== undefined ? { visible: instData.visible } : {}),
              ...(typeof instData.opacity === 'number' ? { opacity: instData.opacity } : {}),
              // INSTANCE의 컴포넌트/레이아웃 상호작용 필드는 master가 모르므로 instance 값을 보존:
              // - componentPropRefs: 자기 propAssignments(VISIBLE 등)
              // - stackChildAlignSelf / stackChildPrimaryGrow: 부모 auto-layout과의 관계
              // - stackPositioning: ABSOLUTE 자식 표시
              ...(instData.componentPropRefs !== undefined
                ? { componentPropRefs: instData.componentPropRefs }
                : {}),
              ...(instData.stackChildAlignSelf !== undefined
                ? { stackChildAlignSelf: instData.stackChildAlignSelf }
                : {}),
              ...(instData.stackChildPrimaryGrow !== undefined
                ? { stackChildPrimaryGrow: instData.stackChildPrimaryGrow }
                : {}),
              ...(instData.stackPositioning !== undefined
                ? { stackPositioning: instData.stackPositioning }
                : {}),
              ...(instMcs !== undefined ? { _masterCounterSize: instMcs } : {}),
              ...(instShowPos !== undefined ? { _showPos: instShowPos } : {}),
            } as never,
            // 자식 변환 시 forceShowPos 전파를 위한 마커 (사이즈 다를 때만)
            _fromInstance: sizesDiffer,
          } as TreeNode & { _fromInstance: boolean };
          // INSTANCE의 componentPropAssignments를 자식 변환에 전파.
          // 부모 propAssignments도 합치되 INSTANCE 자체 값이 우선 (가까운 instance가 override).
          const instAssignments = buildPropAssignmentMap(instData);
          const mergedAssignments = mergeAssignments(propAssignments, instAssignments);
          return convertNode(merged, vectorPathMap, symbolIndex, parentData, parentIsInstanceReplaced, mergedAssignments, nodeIndex);
        }
      }
    }
  }

  const penType = mapNodeType(n.type);
  if (!penType) return null;

  const data = n.data as Record<string, unknown>;
  // effective visibility: 직접 visible:false 또는 propAssignments(VISIBLE)에 의한 토글
  const directVisible = data.visible !== false;
  const hiddenByProp = !!propAssignments && isHiddenByPropAssignment(data, propAssignments);
  const effectiveVisible = directVisible && !hiddenByProp;

  const out: PenNode = {
    type: penType,
    id: n.guidStr,
  };
  if (n.name) out.name = n.name;
  if (!effectiveVisible) out.enabled = false;

  // 위치 — 부모가 auto-layout이면 omit (Pencil convention)
  const omitPos = shouldOmitPosition(data, parentData, parentIsInstanceReplaced, n.type, effectiveVisible);
  if (!omitPos) {
    const transform = data.transform as { m02?: number; m12?: number } | undefined;
    if (transform) {
      if (typeof transform.m02 === 'number' && transform.m02 !== 0) out.x = transform.m02;
      if (typeof transform.m12 === 'number' && transform.m12 !== 0) out.y = transform.m12;
    }
  }

  // 사이즈 — axis별 omit (Pencil convention)
  // 부모가 auto-layout이고 자식이 layoutAlign='STRETCH' 또는 layoutGrow=1 → 'fill_container'
  const size = data.size as { x?: number; y?: number } | undefined;
  const dimOmit = omitDimensions(data, n.type, parentData);
  const fillContainer = computeFillContainer(data, parentData, n.type);
  if (size || fillContainer.width || fillContainer.height) {
    // Pencil fill_container(N) 표기: 위치가 명시될 때만 (N)을 붙임 (해당 축 size)
    if (fillContainer.width) {
      out.width = !omitPos && typeof size?.x === 'number' ? `fill_container(${size.x})` : 'fill_container';
    } else if (size && typeof size.x === 'number' && !dimOmit.width) out.width = size.x;
    if (fillContainer.height) {
      out.height = !omitPos && typeof size?.y === 'number' ? `fill_container(${size.y})` : 'fill_container';
    } else if (size && typeof size.y === 'number' && !dimOmit.height) out.height = size.y;
  }

  // opacity
  if (typeof data.opacity === 'number' && data.opacity < 1) out.opacity = data.opacity;

  // fill — 다중 layer 지원, 단일은 hex string 또는 객체, 다중은 array (Pencil 동일)
  const fills = data.fillPaints as Array<Record<string, unknown>> | undefined;
  if (fills && fills.length > 0) {
    if (penType === 'text') {
      // text는 fill을 단순 color (hex)로 (visible solid 첫 번째). paint.opacity까지 합성.
      const solid = fills.find((f) => f.type === 'SOLID' && f.visible !== false);
      if (solid?.color) {
        const hex = paintToHex(solid as { color?: { r?: number; g?: number; b?: number; a?: number }; opacity?: number });
        if (hex) out.fill = hex;
      }
    } else {
      const fill = paintsToFill(fills);
      if (fill !== null) out.fill = fill;
    }
  }

  // stroke — TEXT 노드는 stroke 출력 안 함 (Pencil 동작과 일치)
  if (penType !== 'text') {
    const stroke = strokeFromNode(data);
    if (stroke) out.stroke = stroke;
  }

  // cornerRadius
  if (typeof data.cornerRadius === 'number' && data.cornerRadius > 0) {
    out.cornerRadius = data.cornerRadius;
  } else if (n.type === 'ELLIPSE') {
    // ellipse는 사이즈 절반이 cornerRadius와 비슷하나 pen에선 그냥 path로 표현
  }

  // effect
  const effect = effectFromNode(data);
  if (effect) out.effect = effect;

  // type-specific
  if (penType === 'text') {
    const characters =
      (data.characters as string) ?? (data.textData as { characters?: string } | undefined)?.characters;
    if (typeof characters === 'string') out.content = characters;

    const td = data.textData as Record<string, unknown> | undefined;

    // ★ derivedSymbolData가 우선 (Figma copy/paste의 진리). 없으면 styleIdForText, 그 다음 master 자체 값.
    //   derivedTextData.fontMetaData[0]에 instance에서의 final fontWeight/fontStyle/fontFamily가 들어있음.
    const derivedTd = data._derivedTextData as
      | { fontMetaData?: Array<{ key?: { family?: string; style?: string }; fontWeight?: number }> }
      | undefined;
    const derivedFm = derivedTd?.fontMetaData?.[0];

    // styleIdForText 해결: Figma는 공유 텍스트 스타일을 별개 노드로 저장하고, 사용처는 GUID로 참조함.
    const styleId = (data.styleIdForText as { guid?: { sessionID?: number; localID?: number } } | undefined)?.guid;
    let styleData: Record<string, unknown> | undefined;
    if (styleId && typeof styleId.sessionID === 'number' && typeof styleId.localID === 'number' && nodeIndex) {
      const styleNode = nodeIndex.get(`${styleId.sessionID}:${styleId.localID}`);
      if (styleNode) styleData = styleNode.data as Record<string, unknown>;
    }
    const styleTd = styleData?.textData as Record<string, unknown> | undefined;

    // 폰트 family/style — derived가 1순위
    const derivedFamily = derivedFm?.key?.family;
    const derivedStyle = derivedFm?.key?.style;
    const fontName = (styleData?.fontName ?? styleTd?.fontName ?? data.fontName ?? td?.fontName) as { family?: string; style?: string } | undefined;
    const family = derivedFamily ?? fontName?.family;
    const style = derivedStyle ?? fontName?.style;
    if (family) out.fontFamily = family;
    if (style) out.fontWeight = fontWeightName(style);

    const fontSize = (styleData?.fontSize as number) ?? (styleTd?.fontSize as number) ?? (data.fontSize as number) ?? (td?.fontSize as number | undefined);
    if (typeof fontSize === 'number') out.fontSize = fontSize;

    // lineHeight: Pencil schema는 fontSize 배수 (ratio).
    //   Figma RAW {value: v}        → 그대로 (이미 ratio)
    //   Figma PERCENT {value: 100}  → font default = omit
    //   Figma PERCENT {value: v}    → v/100
    //   Figma PIXELS  {value: v}    → v/fontSize
    const lh = (styleData?.lineHeight ?? styleTd?.lineHeight ?? data.lineHeight ?? td?.lineHeight) as { units?: string; value?: number } | undefined;
    if (lh && typeof lh.value === 'number' && lh.value > 0) {
      if (lh.units === 'PERCENT') {
        if (lh.value !== 100) out.lineHeight = lh.value / 100;  // 100% = default → omit
      } else if (lh.units === 'PIXELS' && typeof fontSize === 'number' && fontSize > 0) {
        out.lineHeight = lh.value / fontSize;
      } else {
        // RAW (default in Figma) — 이미 ratio, 그대로 emit (1, 1.3, 1.5 등)
        out.lineHeight = lh.value;
      }
    }
    // letterSpacing: Pencil schema는 픽셀.
    //   Figma PERCENT {value: -0.5} for fontSize 16 → (-0.5/100)*16 = -0.08 px
    //   Figma PIXELS  {value: -1.28}                 → 그대로 -1.28 px
    //   value 0 → 모두 omit (font default)
    const ls = (styleData?.letterSpacing ?? styleTd?.letterSpacing ?? data.letterSpacing ?? td?.letterSpacing) as { units?: string; value?: number } | undefined;
    if (ls && typeof ls.value === 'number' && ls.value !== 0) {
      if (ls.units === 'PERCENT' && typeof fontSize === 'number') {
        out.letterSpacing = (ls.value / 100) * fontSize;
      } else {
        out.letterSpacing = ls.value;
      }
    }
    const ah = data.textAlignHorizontal as string | undefined;
    if (ah && ah !== 'LEFT') out.textAlign = ah.toLowerCase();
    // textAlignVertical: Figma는 'CENTER', Pencil 스키마는 'middle' (어휘 차이 — 모르고 lowercase 하면 'center'가 되어 무시됨)
    const av = data.textAlignVertical as string | undefined;
    if (av === 'CENTER') out.textAlignVertical = 'middle';
    else if (av === 'BOTTOM') out.textAlignVertical = 'bottom';
    // 'TOP' (default) → omit
    // textGrowth — Pencil 스키마는 width/height가 적용되려면 이걸 명시해야 함.
    //   WIDTH_AND_HEIGHT → "auto" (default, omit)
    //   HEIGHT           → "fixed-width"        (width 고정, height는 텍스트 길이로 계산, wrap 가능)
    //   NONE / TRUNCATE  → "fixed-width-height" (둘 다 고정, overflow 가능)
    const tar = data.textAutoResize as string | undefined;
    if (tar === 'HEIGHT') out.textGrowth = 'fixed-width';
    else if (tar === 'NONE' || tar === 'TRUNCATE') out.textGrowth = 'fixed-width-height';
  } else if (penType === 'path') {
    // 1순위: full prefixed path (per-instance resolved path from derivedSymbolData)
    // 2순위: 마지막 segment 원본 master guid (master 자체의 fillGeometry)
    let svgPath = vectorPathMap.get(n.guidStr);
    if (!svgPath && n.guidStr.includes('/')) {
      svgPath = vectorPathMap.get(n.guidStr.split('/').pop()!);
    }
    if (svgPath) out.geometry = svgPath;
  } else if (penType === 'frame') {
    const layout = layoutFromNode(data);
    Object.assign(out, layout);
    // Figma의 클리핑은 `frameMaskDisabled`로 제어됨. 값이 false면 마스크가 ON → clip:true.
    // (이름이 헷갈리지만 "frame mask disabled = false" → 마스크 활성화).
    // 일부 노드엔 legacy `clipsContent` 필드가 남아있어 fallback.
    if (data.frameMaskDisabled === false) out.clip = true;
    else if (data.clipsContent === true) out.clip = true;
  }

  // children 재귀 (INSTANCE는 위에서 이미 master로 대체됨)
  // _fromInstance 마킹: 이 노드가 INSTANCE 치환 결과면 자식들에게 forceShowPos 전파.
  // _showPos=true(overlap)인 노드는 정적 frame으로 취급 → 자식들 내부 flow.
  const isMergedFromInstance = (n as { _fromInstance?: boolean })._fromInstance === true;
  const isOverlapShown = (data as { _showPos?: boolean })._showPos === true;
  const propagateShowPos = isMergedFromInstance && !isOverlapShown;
  if (n.children.length > 0) {
    // auto-layout 부모면 자식들 primary axis overlap 감지 → 해당 자식 _showPos=true로 마킹
    // (이미 _showPos가 설정된 자식은 건드리지 않음)
    const stackMode = data.stackMode as string | undefined;
    const isAutoLayout = stackMode && stackMode !== 'NONE' && stackMode !== 'GRID';
    let kidsToWalk: TreeNode[] = n.children;
    if (isAutoLayout) {
      // 진짜 overlap = 동일한 (x, y) 위치 (wrap layout과 구분)
      const posCounts = new Map<string, number>();
      for (const c of n.children) {
        const ctr = (c.data as Record<string, unknown>).transform as { m02?: number; m12?: number } | undefined;
        if (ctr) {
          const k = (ctr.m02 ?? 0) + ',' + (ctr.m12 ?? 0);
          posCounts.set(k, (posCounts.get(k) || 0) + 1);
        }
      }
      const hasOverlap = [...posCounts.values()].some((v) => v > 1);
      if (hasOverlap) {
        kidsToWalk = n.children.map((c) => {
          const cdata = c.data as Record<string, unknown>;
          if (cdata._showPos !== undefined) return c;
          const ctr = cdata.transform as { m02?: number; m12?: number } | undefined;
          if (!ctr) return c;
          const k = (ctr.m02 ?? 0) + ',' + (ctr.m12 ?? 0);
          if ((posCounts.get(k) ?? 0) > 1) {
            return {
              ...c,
              data: { ...cdata, _showPos: true } as never,
            };
          }
          return c;
        });
      }
    }
    const kids: PenNode[] = [];
    for (const c of kidsToWalk) {
      const converted = convertNode(c, vectorPathMap, symbolIndex, data, propagateShowPos, propAssignments, nodeIndex);
      if (converted) kids.push(converted);
    }
    if (kids.length > 0) out.children = kids;
  }

  return out;
}

/** SVG path 'd' attribute만 추출.
 *  Map에는 두 종류 키가 들어감:
 *    1. 원본 master GUID (예: "11:580") — vector.ts/extractVectors 결과
 *    2. INSTANCE 확장 경로 (예: "9:49/7:199") — derivedSymbolData fillGeometry 결과 (per-instance 사전-resolved)
 *  convertNode의 path 분기는 (2)를 우선 lookup → 없으면 (1)으로 fallback.
 */
function buildVectorPathMap(
  tree: BuildTreeResult,
  decoded: DecodedFig,
): Map<string, string> {
  const map = new Map<string, string>();
  const blobs = (decoded.message as { blobs?: Array<{ bytes: Uint8Array }> }).blobs ?? [];
  if (!tree.document) return map;
  // (1) extractVectors가 master node 자체의 fillGeometry로부터 SVG path 추출
  const vectors = extractVectors(tree.document, blobs);
  for (const v of vectors) {
    if (v.svg) {
      const m = v.svg.match(/<path[^>]+d="([^"]+)"/);
      if (m) map.set(v.nodeId, m[1]!);
    }
  }
  // (2) 모든 INSTANCE의 derivedSymbolData[].fillGeometry → instance-prefix 경로로 추가
  //   이게 Figma copy/paste가 사용하는 per-instance resolved path. 우리 Pen export도 이걸 우선 사용.
  for (const node of tree.allNodes.values()) {
    if (node.type !== 'INSTANCE') continue;
    const ds = (node.data as Record<string, unknown>).derivedSymbolData as
      | Array<{
          guidPath?: { guids?: Array<{ sessionID?: number; localID?: number }> };
          fillGeometry?: Array<{ commandsBlob?: number }>;
        }>
      | undefined;
    if (!Array.isArray(ds)) continue;
    for (const entry of ds) {
      const fg = entry.fillGeometry;
      if (!Array.isArray(fg) || fg.length === 0) continue;
      const guids = entry.guidPath?.guids;
      if (!Array.isArray(guids) || guids.length === 0) continue;
      const blobIdx = fg[0]?.commandsBlob;
      if (typeof blobIdx !== 'number' || !blobs[blobIdx]?.bytes) continue;
      const path = decodeCommandsBlob(blobs[blobIdx].bytes);
      if (!path) continue;
      const key = node.guidStr + '/' + guids.map((g) => `${g.sessionID}:${g.localID}`).join('/');
      map.set(key, path);
    }
  }
  return map;
}

/**
 * 페이지 top-level children의 bounding box를 (0, 0)에 정렬 — pencil.dev 기본 viewport에서
 * 콘텐츠가 즉시 보이도록 평행 이동. 자식 내부의 상대 좌표는 변경하지 않음.
 *
 * Figma는 페이지마다 임의의 절대 좌표(예: -32000)를 사용 → pencil.dev 기본 뷰가 (0,0) 근처라
 * 멀리 떨어진 콘텐츠는 빈 화면으로 보임. 페이지별로 정규화해 모두 가시 영역에 위치시킴.
 *
 * Returns: 적용된 평행이동 (디버깅용 — __figma 메타에 기록 가능).
 */
function normalizeTopLevelToOrigin(children: PenNode[]): { dx: number; dy: number } {
  let minX = Infinity, minY = Infinity;
  for (const c of children) {
    const x = typeof c.x === 'number' ? c.x : 0;
    const y = typeof c.y === 'number' ? c.y : 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return { dx: 0, dy: 0 };
  const dx = -minX;
  const dy = -minY;
  if (dx === 0 && dy === 0) return { dx: 0, dy: 0 };
  for (const c of children) {
    if (dx !== 0) c.x = (typeof c.x === 'number' ? c.x : 0) + dx;
    if (dy !== 0) c.y = (typeof c.y === 'number' ? c.y : 0) + dy;
  }
  return { dx, dy };
}

/**
 * 페이지 트리의 모든 노드 id를 Pencil 호환 base62 short ID로 재발급.
 * Pencil 앱은 id에 [0-9A-Za-z]만 허용하며 5-6자 길이를 사용.
 *
 * Random-looking 분포 보장:
 *   - pencil.dev는 첫 노드 id를 파일 fingerprint로 사용하는 것으로 추정 (확인 1: 모든 파일이
 *     "00000"으로 시작하니 같은 파일로 인식)
 *   - 페이지별 seed(pageSeed)를 SHA-256 해시에 주입 → 페이지마다 완전히 다른 ID 분포
 *   - 같은 입력(seed + index) → 같은 ID (deterministic)
 *
 * Returns: { newId → originalGuidStr } 매핑 (round-trip / 디버깅용).
 */
function reassignPenIds(
  nodes: PenNode[],
  pageSeed: string,
  globalUsed: Set<string>,
): Record<string, string> {
  const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  const idMap: Record<string, string> = {};
  let index = 0;

  function makeId(): string {
    // SHA-256(seed:index) → 첫 5바이트의 mod 62로 base62 5문자 생성.
    // 충돌(within page OR across pages within same export run) 시 index 증가하며 retry.
    // globalUsed Set을 export run 전체에서 공유 → cross-page collision 0 보장.
    while (true) {
      const hash = createHash('sha256').update(`${pageSeed}:${index++}`).digest();
      let s = '';
      for (let i = 0; i < 5; i++) s += ALPHABET[hash[i]! % 62];
      // 5자에서 충돌이 너무 잦으면 6자로 확장 (62^5 = 916M 한도, 실용상 거의 도달 불가)
      if (globalUsed.has(s)) {
        // collision: hash next index
        continue;
      }
      globalUsed.add(s);
      return s;
    }
  }

  function walk(node: PenNode): void {
    const original = node.id;
    const fresh = makeId();
    node.id = fresh;
    idMap[fresh] = original;
    if (node.children) for (const c of node.children) walk(c);
  }
  for (const n of nodes) walk(n);
  return idMap;
}

export async function generatePenExport(inputs: PenExportInputs): Promise<PenExportResult> {
  const { tree, decoded, container, outDir } = inputs;
  if (!tree.document) {
    throw new Error('pen-export: no DOCUMENT root');
  }

  mkdirSync(outDir, { recursive: true });

  const vectorPathMap = buildVectorPathMap(tree, decoded);
  const symbolIndex = buildSymbolIndex(tree.allNodes);
  // styleIdForText 등의 cross-tree 참조 lookup용
  const nodeIndex = tree.allNodes;
  const sourceFigSha256 = createHash('sha256').update(container.canvasFig).digest('hex');

  // CPU 변환(convertNode + reassignPenIds)은 페이지 순서대로 직렬 처리 → 결정적 ID 순서 보장.
  // 모든 페이지가 공유하는 globalUsedIds Set으로 cross-file collision 0 보장.
  // I/O write만 병렬화 (각 페이지의 stringify+write가 독립).
  const pages = tree.document.children.filter((c) => c.type === 'CANVAS');
  const globalUsedIds = new Set<string>();

  // Phase 1: 직렬로 모든 페이지의 CPU 변환 + ID 재발급
  type PageBuilt = {
    idx: number;
    safeName: string;
    pageChildren: PenNode[];
    doc: PenDocument;
    penDoc: { version: string; children: PenNode[] };
  };
  const built: PageBuilt[] = [];
  for (const [idx, page] of pages.entries()) {
    const safeName = (page.name ?? `page-${idx}`).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
    const pageChildren: PenNode[] = [];
    for (const c of page.children) {
      const converted = convertNode(c, vectorPathMap, symbolIndex, undefined, false, undefined, nodeIndex);
      if (converted) pageChildren.push(converted);
    }
    // 좌표 정규화: top-level bbox를 (0,0)에 정렬 → pencil.dev 기본 뷰포트에 즉시 보임
    const viewportOffset = normalizeTopLevelToOrigin(pageChildren);
    // ID 재발급: 페이지별 seed + globally-shared Set으로 모든 페이지 통틀어 unique
    const pageSeed = `${page.guidStr}|${sourceFigSha256}`;
    const idMap = reassignPenIds(pageChildren, pageSeed, globalUsedIds);
    const doc: PenDocument = {
      version: PEN_VERSION,
      __figma: {
        pageId: page.guidStr,
        pageName: page.name ?? '',
        archiveVersion: decoded.archiveVersion,
        sourceFigSha256,
        idMap,
        viewportOffset,
      },
      children: pageChildren,
    };
    const penDoc = { version: PEN_VERSION, children: pageChildren };
    built.push({ idx, safeName, pageChildren, doc, penDoc });
  }

  // Phase 2: stringify + write 병렬 (I/O 위주이므로 Promise.all 효과 큼)
  const fileResults = await Promise.all(
    built.map(async ({ idx, safeName, pageChildren, doc, penDoc }) => {
      const fileName = `${String(idx).padStart(2, '0')}_${safeName}.pen.json`;
      const filePath = join(outDir, fileName);
      const penFilePath = join(outDir, `${String(idx).padStart(2, '0')}_${safeName}.pen`);

      const json = JSON.stringify(doc, null, 2);
      const bytes = new TextEncoder().encode(json);
      const penJson = JSON.stringify(penDoc, null, 2);
      const penBytes = new TextEncoder().encode(penJson);

      await Promise.all([writeFile(filePath, bytes), writeFile(penFilePath, penBytes)]);

      const nodeCount = countPenNodes(pageChildren);
      return { path: filePath, bytes: bytes.byteLength, nodeCount, penPath: penFilePath, penBytes: penBytes.byteLength };
    }),
  );

  const files = fileResults;
  const totalNodes = fileResults.reduce((sum, f) => sum + f.nodeCount, 0);

  return { outDir, files, totalPages: pages.length, totalNodes };
}

function countPenNodes(nodes: PenNode[]): number {
  let n = 0;
  for (const x of nodes) {
    n++;
    if (x.children) n += countPenNodes(x.children);
  }
  return n;
}
