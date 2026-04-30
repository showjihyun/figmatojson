/**
 * Iteration 11: editable HTML 생성기 (Tier A)
 * spec: docs/specs/editable-html.spec.md
 *
 * tree + assets → figma.editable.html (편집 가능, Tier A 필드만 inline)
 * Tier B (sidecar)는 sidecar-meta.ts 책임 (Iteration 12)
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ContainerResult, TreeNode } from './types.js';
import type { DecodedFig } from './decoder.js';
import type { BuildTreeResult } from './types.js';
import { hashToHex } from './assets.js';
import { guidKey } from './tree.js';
import { renderEditableCss } from './editable-html-css.js';
import { extractVectors } from './vector.js';

export interface EditableHtmlInputs {
  tree: BuildTreeResult;
  decoded: DecodedFig;
  container: ContainerResult;
  outputDir: string; // 기존 figma-reverse extract output (assets/ 포함)
  htmlOutDir: string; // 출력 디렉토리 (default: extracted/<figName>/07_editable/)
  options?: {
    singleFile?: boolean; // default false (Decision D-2)
    cssExternal?: boolean; // default true
  };
  /**
   * 통합 모드 — single-file이고 .fig 바이트가 주어지면 HTML에 base64 임베드 + 다운로드 버튼.
   * round-trip-html 기능 흡수. cli.ts가 buildByteLevelFigBuffer로 미리 생성해 전달.
   */
  figBundle?: {
    bytes: Uint8Array;
    fileName: string; // 다운로드 시 사용할 파일명 (예: "메타리치 화면 UI Design.fig")
    sha256: string;
  };
}

export interface EditableHtmlResult {
  htmlOutDir: string;
  files: Array<{ path: string; bytes: number }>;
  /** single-file + figBundle 모드 시 디스크에 함께 출력된 .fig 파일 경로 */
  figFilePath?: string;
  stats: {
    totalNodes: number;
    pages: number;
    elementsByType: Record<string, number>;
    sourceFigSha256: string;
    schemaSha256: string;
  };
}

const DEFAULT_OPTIONS = {
  singleFile: false,
  cssExternal: true,
};

const ASSET_DIRS = ['images', 'vectors', 'thumbnail.png'] as const;

export function generateEditableHtml(inputs: EditableHtmlInputs): EditableHtmlResult {
  const { tree, decoded, container, outputDir, htmlOutDir } = inputs;
  const options = { ...DEFAULT_OPTIONS, ...inputs.options };

  if (!tree.document) {
    throw new Error('editable-html: no DOCUMENT root in tree');
  }

  ensureDir(htmlOutDir);

  const files: EditableHtmlResult['files'] = [];

  // 1. CSS 작성 (또는 inline)
  const css = renderEditableCss();
  if (options.cssExternal && !options.singleFile) {
    const cssPath = join(htmlOutDir, 'figma.editable.css');
    writeBytes(cssPath, new TextEncoder().encode(css), files);
  }

  // 2. assets/ 복사 (output/assets/ → htmlOutDir/assets/)
  if (!options.singleFile) {
    copyAssetsDir(join(outputDir, 'assets'), join(htmlOutDir, 'assets'));
  }

  // 3. 노드 타입 통계
  const elementsByType: Record<string, number> = {};
  for (const n of tree.allNodes.values()) {
    elementsByType[n.type] = (elementsByType[n.type] ?? 0) + 1;
  }

  // 4. HTML 본문 생성 (전체 트리 → DOM 트리)
  const renderer = new EditableHtmlRenderer(tree, decoded, container, options);
  const bodyHtml = renderer.renderTree();

  // 5. 메타 정보 (data-figma-* attributes on <html>/<body>)
  const sourceFigSha256 = computeSourceFigSha256(container);
  const schemaSha256 = sha256(decoded.rawSchemaBytes);
  const fileName = container.metaJson?.file_name ?? 'figma-design';

  const html = renderHtmlDocument({
    title: fileName,
    cssExternal: options.cssExternal && !options.singleFile,
    cssInline: options.singleFile || !options.cssExternal ? css : '',
    bodyHtml,
    archiveVersion: decoded.archiveVersion,
    sourceFigSha256,
    schemaSha256,
    rootMessageType: typeof decoded.message.type === 'string' ? decoded.message.type : 'NODE_CHANGES',
    sidecarSrc: options.singleFile ? '' : 'figma.editable.meta.js', // single-file은 inline
    figBundle: options.singleFile ? inputs.figBundle : undefined, // single-file 모드만 임베드
  });

  const htmlPath = join(htmlOutDir, 'figma.editable.html');
  writeBytes(htmlPath, new TextEncoder().encode(html), files);

  // 6. README (편집 가이드)
  const readme = renderReadme(fileName, sourceFigSha256, options);
  const readmePath = join(htmlOutDir, 'README.md');
  writeBytes(readmePath, new TextEncoder().encode(readme), files);

  // 7. single-file + figBundle 모드: .fig 파일도 디스크에 함께 출력
  // (사용자가 브라우저 다운로드 버튼 안 눌러도 즉시 Figma에 import 가능)
  let figFilePath: string | undefined;
  if (options.singleFile && inputs.figBundle) {
    figFilePath = join(htmlOutDir, inputs.figBundle.fileName);
    writeBytes(figFilePath, inputs.figBundle.bytes, files);
  }

  return {
    htmlOutDir,
    files,
    figFilePath,
    stats: {
      totalNodes: tree.allNodes.size,
      pages: tree.document.children.filter((c) => c.type === 'CANVAS').length,
      elementsByType,
      sourceFigSha256,
      schemaSha256,
    },
  };
}

// ─── HTML Renderer ────────────────────────────────────────────────────

class EditableHtmlRenderer {
  private imageHashesByExt: Map<string, string> = new Map();
  /** SYMBOL (컴포넌트 마스터) 인덱스 — INSTANCE 렌더 시 master children inline용 */
  private symbolIndex: Map<string, TreeNode> = new Map();
  /** VECTOR GUID → inline SVG content (벡터 노드의 inline 렌더용) */
  private svgInlineMap: Map<string, string> = new Map();

  constructor(
    private tree: BuildTreeResult,
    private decoded: DecodedFig,
    private container: ContainerResult,
    private options: typeof DEFAULT_OPTIONS,
  ) {
    // 이미지 hash → ext 매핑
    for (const [hash, _bytes] of container.images) {
      const ext = detectImageExt(_bytes);
      this.imageHashesByExt.set(hash.toLowerCase(), ext);
    }
    // SYMBOL 인덱스
    for (const n of tree.allNodes.values()) {
      if (n.type === 'SYMBOL') this.symbolIndex.set(n.guidStr, n);
    }
    // SVG 인라인 맵 — vector.ts가 commandsBlob 디코드한 결과를 그대로 사용
    const blobs = (decoded.message as { blobs?: Array<{ bytes: Uint8Array }> }).blobs ?? [];
    if (tree.document) {
      const vectors = extractVectors(tree.document, blobs);
      for (const v of vectors) {
        if (v.svg) {
          // width/height 속성 제거 + inline style로 100% 채움
          const inlined = v.svg
            .replace(/<svg([^>]*?)\s+width="[^"]*"/, '<svg$1')
            .replace(/<svg([^>]*?)\s+height="[^"]*"/, '<svg$1')
            .replace(
              /<svg([^>]*?)>/,
              '<svg$1 style="width:100%;height:100%;display:block;overflow:visible">',
            );
          this.svgInlineMap.set(v.nodeId, inlined);
        }
      }
    }
  }

  renderTree(): string {
    return this.renderNode(this.tree.document!);
  }

  private renderNode(node: TreeNode, depth = 0): string {
    const tagInfo = chooseTag(node.type);
    const cls = tagInfo.classes.join(' ');
    const attrs = this.renderAttrs(node);
    const style = this.renderStyle(node);
    const inner = this.renderInner(node, depth);
    const indent = '  '.repeat(depth);
    const indentChild = '  '.repeat(depth + 1);

    const styleAttr = style ? ` style="${escapeAttr(style)}"` : '';
    if (inner.length === 0) {
      return `${indent}<${tagInfo.tag} class="${cls}"${attrs}${styleAttr}></${tagInfo.tag}>\n`;
    }
    if (node.children.length === 0) {
      // text 노드 등 inline 컨텐츠
      return `${indent}<${tagInfo.tag} class="${cls}"${attrs}${styleAttr}>${inner}</${tagInfo.tag}>\n`;
    }
    return (
      `${indent}<${tagInfo.tag} class="${cls}"${attrs}${styleAttr}>\n` +
      inner +
      `${indent}</${tagInfo.tag}>\n`
    );
  }

  private renderAttrs(node: TreeNode): string {
    const parts: string[] = [];
    parts.push(`data-figma-id="${node.guidStr}"`);
    parts.push(`data-figma-type="${node.type}"`);
    if (node.name) parts.push(`data-figma-name="${escapeAttr(node.name)}"`);
    if (node.position) parts.push(`data-figma-position="${escapeAttr(node.position)}"`);
    const editable = computeEditableFields(node);
    if (editable) parts.push(`data-figma-editable="${editable}"`);
    return ' ' + parts.join(' ');
  }

  private renderStyle(node: TreeNode): string {
    const styles: string[] = [];
    const data = node.data as Record<string, unknown>;

    // 페이지(CANVAS)와 일반 노드 구분
    const isPage = node.type === 'CANVAS';
    const isDocument = node.type === 'DOCUMENT';

    // Hidden 메타 노드 (VARIABLE_SET, BRUSH 등) — 시각 표시 안 함
    if (isHiddenType(node.type)) return 'display: none';

    if (isDocument) {
      // DOCUMENT의 inline style은 비움 — CSS의 main.fig-document {flex} 적용되도록.
      // 이전엔 display:contents를 inline에 넣어 CSS flex가 무시되고 페이지 layout 깨짐.
      return '';
    }

    if (isPage) {
      // 페이지 컨테이너 — 자식의 (0,0) ~ (maxX, maxY) 영역을 감싸는 페이지
      const bg = data.backgroundColor as { r?: number; g?: number; b?: number; a?: number } | undefined;
      if (bg) styles.push(`background: ${rgbaCss(bg)}`);
      styles.push('position: relative');
      styles.push('overflow: visible');
      const bbox = computeChildrenBBoxUnion(node);
      if (bbox) {
        // 자식 좌표는 페이지 (0,0) 기준 — 페이지 사이즈는 (max(maxX, 800), max(maxY, 600))
        // 음수 minX/minY는 자식이 페이지 외부 좌·상으로 약간 나오는 것 (Figma 무한 캔버스)
        // → overflow: visible로 그대로 보이게
        const w = Math.max(bbox.x + bbox.width, 800);
        const h = Math.max(bbox.y + bbox.height, 600);
        styles.push(`width: ${w}px`);
        styles.push(`height: ${h}px`);
      } else {
        // 자식 없는 빈 페이지
        styles.push('width: 800px');
        styles.push('height: 600px');
      }
      return styles.join('; ');
    }

    // 일반 노드: position absolute
    const size = data.size as { x?: number; y?: number } | undefined;
    const transform = data.transform as
      | { m00?: number; m01?: number; m02?: number; m10?: number; m11?: number; m12?: number }
      | undefined;

    // TEXT 노드는 textAutoResize에 따라 width/height 처리 다름
    const isTextNode = node.type === 'TEXT';
    const textAutoResize = isTextNode ? (data.textAutoResize as string | undefined) : undefined;

    if (size && typeof size.x === 'number' && typeof size.y === 'number') {
      if (textAutoResize === 'WIDTH_AND_HEIGHT') {
        // 콘텐츠에 맞춰 자동 조정 — width 안 명시하고 white-space:nowrap
        styles.push('white-space: nowrap');
        styles.push('width: max-content');
        styles.push('height: max-content');
      } else if (textAutoResize === 'HEIGHT') {
        // width 고정, height 자동 (multi-line)
        styles.push(`width: ${size.x}px`);
        styles.push('height: auto');
        styles.push(`min-height: ${size.y}px`);
      } else if (textAutoResize === 'TRUNCATE') {
        // 한 줄 잘림
        styles.push(`width: ${size.x}px`);
        styles.push(`height: ${size.y}px`);
        styles.push('white-space: nowrap');
        styles.push('overflow: hidden');
        styles.push('text-overflow: ellipsis');
      } else {
        // NONE 또는 비-TEXT: 고정 사이즈
        styles.push(`width: ${size.x}px`);
        styles.push(`height: ${size.y}px`);
      }
    }

    // textTruncation: ENDING → ellipsis (별도 처리)
    if (isTextNode && data.textTruncation === 'ENDING' && textAutoResize !== 'TRUNCATE') {
      styles.push('overflow: hidden');
      styles.push('text-overflow: ellipsis');
    }

    if (transform) {
      const tx = transform.m02 ?? 0;
      const ty = transform.m12 ?? 0;
      styles.push('position: absolute');
      styles.push(`left: ${tx}px`);
      styles.push(`top: ${ty}px`);
      // identity가 아닌 회전·스케일 → matrix transform
      const m00 = transform.m00 ?? 1;
      const m01 = transform.m01 ?? 0;
      const m10 = transform.m10 ?? 0;
      const m11 = transform.m11 ?? 1;
      if (m00 !== 1 || m01 !== 0 || m10 !== 0 || m11 !== 1) {
        styles.push(`transform: matrix(${m00}, ${m10}, ${m01}, ${m11}, 0, 0)`);
        styles.push('transform-origin: 0 0');
      }
    }

    // visible
    if (data.visible === false) styles.push('display: none');

    // clipsContent (FRAME, GROUP 등) — Figma의 자식 잘림 옵션
    if (data.clipsContent === true) styles.push('overflow: hidden');

    // opacity
    if (typeof data.opacity === 'number' && data.opacity < 1) {
      styles.push(`opacity: ${data.opacity}`);
    }

    // cornerRadius
    if (typeof data.cornerRadius === 'number' && data.cornerRadius > 0) {
      styles.push(`border-radius: ${data.cornerRadius}px`);
    } else if (Array.isArray(data.cornerRadii) && data.cornerRadii.length === 4) {
      const [tl, tr, br, bl] = data.cornerRadii as number[];
      styles.push(`border-radius: ${tl}px ${tr}px ${br}px ${bl}px`);
    }

    // ELLIPSE
    if (node.type === 'ELLIPSE') styles.push('border-radius: 50%');

    // fillPaints — 다중 layer를 콤마 구분 background로 쌓음. VECTOR는 SVG가 처리하므로 skip.
    const fills = data.fillPaints as Array<Record<string, unknown>> | undefined;
    const visibleFills = (fills ?? []).filter((f) => f.visible !== false);
    if (visibleFills.length > 0 && !isVectorType(node.type)) {
      if (node.type === 'TEXT') {
        // TEXT는 첫 SOLID fill을 color로 (여러 layer는 의미 없음)
        const solid = visibleFills.find((f) => f.type === 'SOLID');
        if (solid?.color) {
          styles.push(`color: ${rgbaCss(solid.color as { r?: number; g?: number; b?: number; a?: number })}`);
        }
      } else {
        // 다중 fill layer를 background shorthand로
        const bgCss = paintsToMultiLayerBackground(visibleFills, this.imageHashesByExt);
        if (bgCss) styles.push(bgCss);
      }
    }

    // strokePaints + effects를 통합 box-shadow로 (CSS box-shadow는 한 번만 적용)
    const strokes = data.strokePaints as Array<Record<string, unknown>> | undefined;
    const firstStroke = strokes?.find((s) => s.visible !== false);
    const effects = data.effects as Array<Record<string, unknown>> | undefined;
    const boxShadows: string[] = [];
    const filters: string[] = [];
    const backdropFilters: string[] = [];

    // Stroke
    if (firstStroke && firstStroke.type === 'SOLID' && typeof data.strokeWeight === 'number' && !isVectorType(node.type)) {
      const strokeColor = rgbaCss(firstStroke.color as { r?: number; g?: number; b?: number; a?: number });
      const w = data.strokeWeight;
      const align = data.strokeAlign as string | undefined;
      if (align === 'INSIDE') {
        boxShadows.push(`inset 0 0 0 ${w}px ${strokeColor}`);
      } else if (align === 'OUTSIDE') {
        boxShadows.push(`0 0 0 ${w}px ${strokeColor}`);
      } else {
        // CENTER: 절반 inset + 절반 outset
        const half = w / 2;
        boxShadows.push(`0 0 0 ${half}px ${strokeColor}`);
        boxShadows.push(`inset 0 0 0 ${half}px ${strokeColor}`);
      }
    }

    // Effects
    if (effects && effects.length > 0) {
      for (const e of effects) {
        if (e.visible === false) continue;
        const t = e.type;
        if (t === 'DROP_SHADOW' || t === 'INNER_SHADOW') {
          const offset = e.offset as { x?: number; y?: number } | undefined;
          const radius = (e.radius as number) ?? 0;
          const spread = (e.spread as number) ?? 0;
          const color = e.color as { r?: number; g?: number; b?: number; a?: number } | undefined;
          const inset = t === 'INNER_SHADOW' ? 'inset ' : '';
          boxShadows.push(
            `${inset}${offset?.x ?? 0}px ${offset?.y ?? 0}px ${radius}px ${spread}px ${color ? rgbaCss(color) : 'rgba(0,0,0,0.25)'}`,
          );
        } else if (t === 'LAYER_BLUR') {
          filters.push(`blur(${(e.radius as number) ?? 0}px)`);
        } else if (t === 'BACKGROUND_BLUR') {
          backdropFilters.push(`blur(${(e.radius as number) ?? 0}px)`);
        }
      }
    }

    if (boxShadows.length) styles.push(`box-shadow: ${boxShadows.join(', ')}`);
    if (filters.length) styles.push(`filter: ${filters.join(' ')}`);
    if (backdropFilters.length) styles.push(`backdrop-filter: ${backdropFilters.join(' ')}`);

    // blendMode
    if (typeof data.blendMode === 'string' && data.blendMode !== 'PASS_THROUGH' && data.blendMode !== 'NORMAL') {
      styles.push(`mix-blend-mode: ${data.blendMode.toLowerCase().replace(/_/g, '-')}`);
    }

    // TEXT 노드 특수 스타일
    if (node.type === 'TEXT') {
      const td = data.textData as Record<string, unknown> | undefined;
      const fontSize = (data.fontSize as number) ?? (td?.fontSize as number | undefined);
      if (typeof fontSize === 'number') styles.push(`font-size: ${fontSize}px`);

      const fontName = (data.fontName ?? td?.fontName) as { family?: string; style?: string } | undefined;
      if (fontName?.family) {
        // body의 font-family stack과 같은 fallback 체인 (CSS는 inherit chain 안 됨)
        styles.push(
          `font-family: ${cssEscapeFamily(fontName.family)}, 'Inter', 'Pretendard', 'Noto Sans KR', system-ui, sans-serif`,
        );
      }
      // font-weight from style name (Bold → 700 등)
      if (fontName?.style) {
        const weightMap: Record<string, number> = {
          Thin: 100,
          'Extra Light': 200,
          Light: 300,
          Regular: 400,
          Medium: 500,
          'Semi Bold': 600,
          SemiBold: 600,
          Bold: 700,
          'Extra Bold': 800,
          ExtraBold: 800,
          Black: 900,
        };
        for (const [k, v] of Object.entries(weightMap)) {
          if (fontName.style.includes(k)) styles.push(`font-weight: ${v}`);
        }
        if (/italic/i.test(fontName.style)) styles.push('font-style: italic');
      }

      const align = data.textAlignHorizontal as string | undefined;
      if (align && align !== 'LEFT') styles.push(`text-align: ${align.toLowerCase()}`);

      // lineHeight: { unit: 'PIXELS' | 'PERCENT' | 'AUTO' | 'RAW', value: number }
      const lh = (data.lineHeight ?? td?.lineHeight) as { units?: string; value?: number } | undefined;
      if (lh && typeof lh.value === 'number' && lh.value > 0) {
        if (lh.units === 'PIXELS' || lh.units === 'RAW') styles.push(`line-height: ${lh.value}px`);
        else if (lh.units === 'PERCENT') styles.push(`line-height: ${lh.value}%`);
      } else {
        // Figma 기본 line-height = polyfill 1 (사이즈 그대로)
        styles.push('line-height: 1.2');
      }

      // letterSpacing: { units: 'PIXELS' | 'PERCENT', value: number }
      const ls = (data.letterSpacing ?? td?.letterSpacing) as { units?: string; value?: number } | undefined;
      if (ls && typeof ls.value === 'number') {
        if (ls.units === 'PIXELS' || ls.units === 'RAW') styles.push(`letter-spacing: ${ls.value}px`);
        else if (ls.units === 'PERCENT') styles.push(`letter-spacing: ${ls.value / 100}em`);
      }

      // textCase
      const textCase = data.textCase as string | undefined;
      if (textCase === 'UPPER') styles.push('text-transform: uppercase');
      else if (textCase === 'LOWER') styles.push('text-transform: lowercase');
      else if (textCase === 'TITLE') styles.push('text-transform: capitalize');

      // textDecoration
      const td2 = data.textDecoration as string | undefined;
      if (td2 === 'UNDERLINE') styles.push('text-decoration: underline');
      else if (td2 === 'STRIKETHROUGH') styles.push('text-decoration: line-through');
    }

    return styles.join('; ');
  }

  private renderInner(node: TreeNode, depth: number): string {
    if (node.type === 'TEXT') {
      const data = node.data as Record<string, unknown>;
      const characters = (data.characters as string) ?? (data.textData as { characters?: string } | undefined)?.characters ?? '';
      return escapeHtml(characters);
    }

    if (isVectorType(node.type)) {
      // inline SVG 우선 (fill·viewBox·currentColor 모두 정확). 없으면 빈 placeholder.
      const inline = this.svgInlineMap.get(node.guidStr);
      if (inline) return inline;
      return ''; // 디코드 못한 vector — 색상이 inline style의 background로 대체
    }

    // ★ INSTANCE — master(SYMBOL)의 children을 inline 복제 (visual only)
    if (node.type === 'INSTANCE' && node.children.length === 0) {
      const data = node.data as Record<string, unknown>;
      const symbolData = data.symbolData;
      if (symbolData && typeof symbolData === 'object') {
        const sd = symbolData as Record<string, unknown>;
        const sid = sd.symbolID as { sessionID?: number; localID?: number } | undefined;
        if (sid && typeof sid.sessionID === 'number' && typeof sid.localID === 'number') {
          const masterGuid = `${sid.sessionID}:${sid.localID}`;
          const master = this.symbolIndex.get(masterGuid);
          if (master && master.children.length > 0) {
            const overrideMap = buildOverrideMap(sd.symbolOverrides);
            let html = '\n';
            for (const c of master.children) {
              html += this.renderClonedNode(c, depth + 1, overrideMap);
            }
            html += '  '.repeat(depth);
            return html;
          }
        }
      }
    }

    if (node.children.length === 0) return '';
    return '\n' + node.children.map((c) => this.renderNode(c, depth + 1)).join('') + '  '.repeat(depth);
  }

  /**
   * INSTANCE inheritance용 — master의 children을 readonly clone으로 렌더.
   * data-figma-id 부여 안 함 (GUID 1:1 invariant 깨지면 안 됨).
   * 대신 data-figma-clone-of로 master GUID 표시.
   * @param overrideMap GUID별 instance override (best-effort: characters, fillPaints 등)
   */
  private renderClonedNode(
    node: TreeNode,
    depth: number,
    overrideMap?: Map<string, Record<string, unknown>>,
  ): string {
    // override 적용된 효과적 데이터 (master 데이터 위에 override를 spread)
    const override = overrideMap?.get(node.guidStr);
    const effectiveNode = override
      ? ({ ...node, data: { ...(node.data as Record<string, unknown>), ...override } } as TreeNode)
      : node;

    const tagInfo = chooseTag(effectiveNode.type);
    const cls = tagInfo.classes.join(' ') + ' fig-instance-clone';
    const attrs =
      ` data-figma-clone-of="${effectiveNode.guidStr}"` +
      ` data-figma-type="${effectiveNode.type}"` +
      ` data-figma-readonly="true"`;
    const style = this.renderStyle(effectiveNode);
    const styleAttr = style ? ` style="${escapeAttr(style)}"` : '';

    let inner: string;
    if (effectiveNode.type === 'TEXT') {
      const data = effectiveNode.data as Record<string, unknown>;
      const characters =
        (data.characters as string) ??
        (data.textData as { characters?: string } | undefined)?.characters ??
        '';
      inner = escapeHtml(characters);
    } else if (isVectorType(effectiveNode.type)) {
      const inline = this.svgInlineMap.get(effectiveNode.guidStr);
      inner = inline ?? '';
    } else if (effectiveNode.type === 'INSTANCE' && effectiveNode.children.length === 0) {
      inner = this.renderInner(effectiveNode, depth);
    } else if (effectiveNode.children.length > 0) {
      inner =
        '\n' +
        effectiveNode.children
          .map((c) => this.renderClonedNode(c, depth + 1, overrideMap))
          .join('') +
        '  '.repeat(depth);
    } else {
      inner = '';
    }

    const indent = '  '.repeat(depth);
    if (inner.length === 0) {
      return `${indent}<${tagInfo.tag} class="${cls}"${attrs}${styleAttr}></${tagInfo.tag}>\n`;
    }
    return `${indent}<${tagInfo.tag} class="${cls}"${attrs}${styleAttr}>${inner}</${tagInfo.tag}>\n`;
  }
}

/**
 * symbolOverrides 배열을 GUID → override 객체 map으로 변환.
 * Figma의 symbolOverrides 구조는 다양하지만 대표 패턴:
 *   { guidPath: [{sessionID, localID}, ...], <fieldName>: <newValue> }
 * guidPath의 마지막 GUID가 override 대상.
 */
function buildOverrideMap(
  overrides: unknown,
): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(overrides)) return map;
  for (const o of overrides) {
    if (!o || typeof o !== 'object') continue;
    const obj = o as Record<string, unknown>;
    const path = obj.guidPath;
    if (!Array.isArray(path) || path.length === 0) continue;
    const last = path[path.length - 1] as Record<string, unknown> | undefined;
    if (!last || typeof last !== 'object') continue;
    const sessionID = last.sessionID;
    const localID = last.localID;
    if (typeof sessionID !== 'number' || typeof localID !== 'number') continue;
    const targetGuid = `${sessionID}:${localID}`;
    const overrideData: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'guidPath') continue;
      overrideData[k] = v;
    }
    if (Object.keys(overrideData).length > 0) {
      map.set(targetGuid, overrideData);
    }
  }
  return map;
}

// ─── Helpers ────────────────────────────────────────────────────────

/** 시각 표시 없는 메타 노드 타입 — 데이터 정의용 */
const HIDDEN_NODE_TYPES = new Set([
  'VARIABLE_SET',
  'VARIABLE',
  'BRUSH',
  'CODE_LIBRARY',
  // SYMBOL은 컴포넌트 마스터 — 일부 디자인에선 페이지에 보이는 게 의도적이라 표시
]);

function isHiddenType(type: string): boolean {
  return HIDDEN_NODE_TYPES.has(type);
}

function chooseTag(type: string): { tag: string; classes: string[] } {
  switch (type) {
    case 'DOCUMENT':
      return { tag: 'main', classes: ['fig-document'] };
    case 'CANVAS':
      return { tag: 'section', classes: ['fig-page'] };
    case 'FRAME':
      return { tag: 'div', classes: ['fig-node', 'fig-frame'] };
    case 'GROUP':
      return { tag: 'div', classes: ['fig-node', 'fig-group'] };
    case 'RECTANGLE':
      return { tag: 'div', classes: ['fig-node', 'fig-rect'] };
    case 'ROUNDED_RECTANGLE':
      return { tag: 'div', classes: ['fig-node', 'fig-rect', 'fig-rounded'] };
    case 'ELLIPSE':
      return { tag: 'div', classes: ['fig-node', 'fig-ellipse'] };
    case 'TEXT':
      return { tag: 'p', classes: ['fig-node', 'fig-text'] };
    case 'VECTOR':
    case 'STAR':
    case 'LINE':
    case 'REGULAR_POLYGON':
    case 'BOOLEAN_OPERATION':
      return { tag: 'div', classes: ['fig-node', 'fig-vector'] };
    case 'INSTANCE':
      return { tag: 'div', classes: ['fig-node', 'fig-instance'] };
    case 'SYMBOL':
      return { tag: 'div', classes: ['fig-node', 'fig-symbol'] };
    case 'SECTION':
      return { tag: 'section', classes: ['fig-node', 'fig-section'] };
    default:
      return { tag: 'div', classes: ['fig-node', 'fig-meta'] };
  }
}

function isVectorType(type: string): boolean {
  return ['VECTOR', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION'].includes(type);
}

/** 노드의 직속 자식들의 bbox union (자식 좌표는 부모 기준이므로 그대로 합산) */
function computeChildrenBBoxUnion(node: TreeNode): { x: number; y: number; width: number; height: number } | null {
  if (node.children.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const c of node.children) {
    const data = c.data as Record<string, unknown>;
    const size = data.size as { x?: number; y?: number } | undefined;
    const transform = data.transform as { m02?: number; m12?: number } | undefined;
    if (!size || !transform) continue;
    const x = transform.m02 ?? 0;
    const y = transform.m12 ?? 0;
    const w = size.x ?? 0;
    const h = size.y ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  if (!isFinite(minX)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function computeEditableFields(node: TreeNode): string {
  const fields: string[] = ['name'];
  if (node.type !== 'DOCUMENT' && node.type !== 'CANVAS') {
    fields.push('position', 'size', 'opacity', 'visible');
  }
  const data = node.data as Record<string, unknown>;
  if (data.fillPaints) fields.push('fills');
  if (data.strokePaints) fields.push('strokes');
  if (data.cornerRadius != null || data.cornerRadii != null) fields.push('cornerRadius');
  if (data.effects) fields.push('effects');
  if (node.type === 'TEXT') fields.push('text', 'fontSize', 'fontFamily');
  return fields.join(' ');
}

function rgbaCss(c: { r?: number; g?: number; b?: number; a?: number }): string {
  const r = Math.round((c.r ?? 0) * 255);
  const g = Math.round((c.g ?? 0) * 255);
  const b = Math.round((c.b ?? 0) * 255);
  const a = c.a ?? 1;
  return a < 1 ? `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(4))})` : `rgb(${r}, ${g}, ${b})`;
}

/**
 * 단일 paint를 CSS background layer 문법(콤마로 stack 가능한 형태)로 변환.
 * 반환값은 background shorthand의 한 layer (예: `linear-gradient(...)` 또는 `url(...) center/cover`).
 * 색상은 stack 마지막에 분리되어야 하므로 별도 처리 (paintsToMultiLayerBackground).
 */
function paintToLayer(
  paint: Record<string, unknown>,
  imageExtMap: Map<string, string>,
): string | null {
  const t = paint.type;
  const opacity = typeof paint.opacity === 'number' ? paint.opacity : 1;

  if (t === 'SOLID' && paint.color) {
    // SOLID도 layer로 만들기 위해 단색 gradient 트릭 (colored layer)
    const c = applyOpacity(paint.color as { r?: number; g?: number; b?: number; a?: number }, opacity);
    return `linear-gradient(${rgbaCss(c)}, ${rgbaCss(c)})`;
  }
  if (t === 'IMAGE') {
    const image = paint.image as { hash?: unknown } | undefined;
    const hash = hashToHex(image?.hash) ?? (typeof paint.imageRef === 'string' ? paint.imageRef.toLowerCase() : null);
    if (hash) {
      const ext = imageExtMap.get(hash) ?? 'png';
      const scaleMode = paint.scaleMode as string | undefined;
      const size = scaleMode === 'FIT' ? 'contain' : scaleMode === 'TILE' ? 'auto' : 'cover';
      const repeat = scaleMode === 'TILE' ? 'repeat' : 'no-repeat';
      return `url("assets/images/${hash}.${ext}") center/${size} ${repeat}`;
    }
  }
  if (t === 'GRADIENT_LINEAR' || t === 'GRADIENT_RADIAL' || t === 'GRADIENT_ANGULAR') {
    const stops = paint.stops as
      | Array<{ position?: number; color?: { r?: number; g?: number; b?: number; a?: number } }>
      | undefined;
    if (stops && stops.length > 0) {
      const stopsCss = stops
        .map((s) =>
          s.color
            ? `${rgbaCss(applyOpacity(s.color, opacity))} ${((s.position ?? 0) * 100).toFixed(1)}%`
            : `transparent ${((s.position ?? 0) * 100).toFixed(1)}%`,
        )
        .join(', ');

      const handles = paint.gradientHandlePositions as
        | Array<{ x?: number; y?: number }>
        | undefined;
      let angle = 180;
      if (handles && handles.length >= 2 && handles[0] && handles[1]) {
        const dx = (handles[1].x ?? 0) - (handles[0].x ?? 0);
        const dy = (handles[1].y ?? 0) - (handles[0].y ?? 0);
        angle = Math.round((Math.atan2(dx, -dy) * 180) / Math.PI);
        if (angle < 0) angle += 360;
      }
      if (t === 'GRADIENT_RADIAL') return `radial-gradient(ellipse at center, ${stopsCss})`;
      if (t === 'GRADIENT_ANGULAR') return `conic-gradient(from ${angle}deg, ${stopsCss})`;
      return `linear-gradient(${angle}deg, ${stopsCss})`;
    }
  }
  return null;
}

/**
 * 여러 paint를 CSS multiple background로 stack.
 * Figma: fills[0]가 가장 위. CSS background도 콤마 구분 시 첫 항목이 위 → 일치.
 */
function paintsToMultiLayerBackground(
  paints: Array<Record<string, unknown>>,
  imageExtMap: Map<string, string>,
): string | null {
  const layers: string[] = [];
  for (const p of paints) {
    const layer = paintToLayer(p, imageExtMap);
    if (layer) layers.push(layer);
  }
  if (layers.length === 0) return null;
  return `background: ${layers.join(', ')}`;
}

function applyOpacity(
  c: { r?: number; g?: number; b?: number; a?: number },
  opacity: number,
): { r?: number; g?: number; b?: number; a: number } {
  const a = (c.a ?? 1) * opacity;
  return { r: c.r, g: c.g, b: c.b, a };
}

function cssEscapeFamily(family: string): string {
  if (/^[a-zA-Z][a-zA-Z0-9-]*$/.test(family)) return family;
  return `"${family.replace(/"/g, '\\"')}"`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function detectImageExt(buf: Uint8Array): string {
  if (buf.length < 4) return 'bin';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  if (
    buf[0] === 0x52 &&
    buf[1] === 0x49 &&
    buf[2] === 0x46 &&
    buf[3] === 0x46 &&
    buf[8] === 0x57 &&
    buf[9] === 0x45 &&
    buf[10] === 0x42 &&
    buf[11] === 0x50
  ) {
    return 'webp';
  }
  return 'bin';
}

function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true });
}

function writeBytes(path: string, bytes: Uint8Array, files: Array<{ path: string; bytes: number }>): void {
  ensureDir(join(path, '..'));
  writeFileSync(path, bytes);
  files.push({ path, bytes: bytes.byteLength });
}

function copyAssetsDir(srcRoot: string, dstRoot: string): void {
  if (!existsSync(srcRoot)) return;
  ensureDir(dstRoot);
  for (const sub of ['images', 'vectors']) {
    const srcSub = join(srcRoot, sub);
    if (!existsSync(srcSub)) continue;
    const dstSub = join(dstRoot, sub);
    ensureDir(dstSub);
    for (const f of readdirSync(srcSub)) {
      const sp = join(srcSub, f);
      if (statSync(sp).isFile()) copyFileSync(sp, join(dstSub, f));
    }
  }
  // thumbnail
  const thumbSrc = join(srcRoot, 'thumbnail.png');
  if (existsSync(thumbSrc)) copyFileSync(thumbSrc, join(dstRoot, 'thumbnail.png'));
}

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}

function computeSourceFigSha256(_container: ContainerResult): string {
  // 실제로는 원본 .fig 파일 sha — 본 단계에선 canvas.fig sha로 대체 (proxy)
  return sha256(_container.canvasFig);
}

// ─── HTML document template ────────────────────────────────────────

interface DocumentArgs {
  title: string;
  cssExternal: boolean;
  cssInline: string;
  bodyHtml: string;
  archiveVersion: number;
  sourceFigSha256: string;
  schemaSha256: string;
  rootMessageType: string;
  sidecarSrc: string;
  figBundle?: { bytes: Uint8Array; fileName: string; sha256: string };
}

function renderHtmlDocument(a: DocumentArgs): string {
  const cssTag = a.cssExternal
    ? '<link rel="stylesheet" href="figma.editable.css" />'
    : `<style>\n${a.cssInline}\n</style>`;
  const sidecarTag = a.sidecarSrc ? `<script src="${a.sidecarSrc}"></script>` : '';

  // 웹 폰트 — preconnect + 비동기 로드.
  const fontLinks = `<link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link rel="preconnect" href="https://cdn.jsdelivr.net" crossorigin />
  <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@100;200;300;400;500;600;700;800;900&family=Roboto:wght@300;400;500;700&family=Noto+Sans+KR:wght@100;300;400;500;700;900&display=swap" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.css" />`;

  // figBundle (round-trip 통합) — 단일 파일에 .fig base64 임베드 + 다운로드 버튼
  const bundleScript = a.figBundle ? renderFigBundleScript(a.figBundle) : '';
  const bundleButton = a.figBundle ? renderDownloadButton(a.figBundle) : '';

  return `<!DOCTYPE html>
<html lang="ko"
  data-figma-roundtrip="v2"
  data-figma-archive-version="${a.archiveVersion}"
  data-figma-source-fig-sha256="${a.sourceFigSha256}"
  data-figma-schema-sha256="${a.schemaSha256}"
  data-figma-root-message-type="${a.rootMessageType}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(a.title)} · figma-reverse${a.figBundle ? ' bundle' : ' editable'}</title>
  ${fontLinks}
  ${cssTag}
  ${sidecarTag}
</head>
<body>
${bundleButton}
${a.bodyHtml}
${bundleScript}
</body>
</html>
`;
}

function renderDownloadButton(fb: { bytes: Uint8Array; fileName: string; sha256: string }): string {
  const sizeMb = (fb.bytes.byteLength / 1024 / 1024).toFixed(2);
  return `<button id="fig-download-btn" class="fig-download-btn" type="button"
  title="원본 .fig 다운로드 (${sizeMb} MB) → Figma에 import 가능"
  style="position: fixed; top: 12px; right: 12px; z-index: 10000;
         background: #1bc47d; color: white; border: none;
         padding: 8px 14px; border-radius: 6px; font-size: 12px;
         font-weight: 600; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,0.4);">
  ⬇ Download .fig (${sizeMb} MB)
</button>`;
}

function renderFigBundleScript(fb: { bytes: Uint8Array; fileName: string; sha256: string }): string {
  const base64 = Buffer.from(fb.bytes).toString('base64');
  return `<script>
(function () {
  window.FIG_BUNDLE = {
    base64: ${JSON.stringify(base64)},
    fileName: ${JSON.stringify(fb.fileName)},
    bytes: ${fb.bytes.byteLength},
    sha256: ${JSON.stringify(fb.sha256)}
  };
  function setupDownload() {
    var btn = document.getElementById('fig-download-btn');
    if (!btn) return setTimeout(setupDownload, 100);
    btn.addEventListener('click', function () {
      var b = window.FIG_BUNDLE;
      var bin = atob(b.base64);
      var bytes = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      var blob = new Blob([bytes], { type: 'application/octet-stream' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = b.fileName;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    });
  }
  setupDownload();
})();
</script>`;
}

function renderReadme(fileName: string, sourceSha: string, options: { singleFile: boolean }): string {
  return `# figma.editable.html — 편집 가이드

| 항목 | 값 |
|---|---|
| 파일명 | \`${fileName}\` |
| 원본 .fig sha256 | \`${sourceSha.slice(0, 16)}…\` |
| 모드 | ${options.singleFile ? 'single-file' : 'directory'} |
| 생성 도구 | figma-reverse v2 |

## 편집 방법

### 1. HTML (figma.editable.html)
브라우저에서 열어 시각 확인 + IDE에서 직접 편집.

**편집 가능한 주요 속성**:
- \`style="width:Npx; height:Npx"\` — 사이즈
- \`style="left:Xpx; top:Ypx"\` — 위치
- \`style="background-color:..."\` — 채움
- \`style="opacity:..."\` — 투명도
- \`style="border-radius:..."\` — 모서리 둥글림
- \`style="box-shadow:..."\` — 그림자
- \`style="color:...; font-size:..."\` — TEXT 노드
- \`<p>내용</p>\` — TEXT innerText

### 2. Sidecar (figma.editable.meta.js)
HTML에 표현 안 된 고급 필드는 sidecar에서 편집 (Iteration 12에서 생성):
- effects, layoutGrids, interactions, componentProperties 등

### 3. 변환

편집 완료 후 다음 명령으로 새 .fig 생성 (Iteration 13에서 구현):

\`\`\`bash
figma-reverse html-to-fig <htmlOutDir> <out.fig>
\`\`\`

생성된 .fig를 Figma 데스크톱에서 Import.

## 주의 사항

- \`data-figma-id\`, \`data-figma-type\` 절대 변경 금지
- 새 element 추가는 v2 미지원 (v3 예정)
- 형제 순서 변경은 가능 (parentIndex.position 자동 재계산)
- TEXT segment 편집은 \`<span data-style-id="...">\` 구조 따라야 함

## 디버깅

- HTML 깨짐: 브라우저 devtools console 확인
- 변환 실패: \`--verbose\` 플래그 사용
`;
}
