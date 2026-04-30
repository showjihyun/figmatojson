/**
 * Iteration 9: 최종 export 모듈 (PRD §4.3)
 *
 * 출력 디렉토리 구조:
 *   output/
 *   ├── document.json
 *   ├── pages/<idx>_<safe-name>.json
 *   ├── assets/
 *   │   ├── images/<hash>.<ext>
 *   │   ├── vectors/<node-id>.svg
 *   │   └── thumbnail.png
 *   ├── schema.json
 *   ├── metadata.json
 *   ├── manifest.json
 *   └── verification_report.md (← verify.ts에서 생성)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { writeFile as writeFileAsync } from 'node:fs/promises';
import { join } from 'node:path';
import * as kiwi from 'kiwi-schema';
import { detectImageExt, hashToHex } from './assets.js';
import type { DecodedFig } from './decoder.js';
import { extractVectors } from './vector.js';
import type { VectorExtractionResult } from './vector.js';
import { normalizeTree } from './normalize.js';
import type { NormalizedNode } from './normalize.js';
import { getPages, guidKey } from './tree.js';
import type { BuildTreeResult, ContainerResult, ExtractStats } from './types.js';

export interface ExportArtifacts {
  outputDir: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  stats: ExtractStats;
  imageRefs: Map<string, Set<string>>;
  vectorResults: VectorExtractionResult[];
  document: NormalizedNode | null;
}

export interface ExportOptions {
  /** JSON 들여쓰기 제거 */
  minify: boolean;
  /** document.json 출력 (default true) */
  includeDocument: boolean;
  /** raw_message.json 출력 (default false — 매우 큼) */
  includeRawMessage: boolean;
  /** 벡터 SVG 추출 (default true) */
  extractVectors: boolean;
}

const DEFAULT_OPTIONS: ExportOptions = {
  minify: false,
  includeDocument: true,
  includeRawMessage: false,
  extractVectors: true,
};

export interface ExportInputs {
  outputDir: string;
  container: ContainerResult;
  decoded: DecodedFig;
  tree: BuildTreeResult;
  imageRefs: Map<string, Set<string>>;
  options?: Partial<ExportOptions>;
}

export async function exportAll(inputs: ExportInputs): Promise<ExportArtifacts> {
  const { outputDir, container, decoded, tree, imageRefs } = inputs;
  const options: ExportOptions = { ...DEFAULT_OPTIONS, ...inputs.options };

  ensureDir(outputDir);
  ensureDir(join(outputDir, 'pages'));
  ensureDir(join(outputDir, 'assets'));
  ensureDir(join(outputDir, 'assets', 'images'));
  ensureDir(join(outputDir, 'assets', 'vectors'));

  const files: ExportArtifacts['files'] = [];
  const indent = options.minify ? 0 : 2;

  // 1. document.json — 정규화된 전체 트리 (옵션)
  const document = normalizeTree(tree.document);
  if (options.includeDocument) {
    writeJson(join(outputDir, 'document.json'), document, files, indent);
  }

  // 2. pages/* — CANVAS 별로 분리
  const pages = getPages(tree.document);
  pages.forEach((page, idx) => {
    const safeName = sanitize(page.name ?? `page-${idx}`);
    const path = join(outputDir, 'pages', `${pad2(idx)}_${safeName}.json`);
    writeJson(path, normalizeTree(page), files, indent);
  });

  // 3. assets/images/* — magic 기반 확장자
  const imagesWritten = new Map<string, { path: string; ext: string }>();
  for (const [hash, bytes] of container.images) {
    const ext = detectImageExt(bytes);
    const filename = `${hash}.${ext}`;
    const fullPath = join(outputDir, 'assets', 'images', filename);
    writeBytes(fullPath, bytes, files);
    imagesWritten.set(hash.toLowerCase(), {
      path: `assets/images/${filename}`,
      ext,
    });
  }

  // 4. thumbnail
  if (container.thumbnail) {
    writeBytes(join(outputDir, 'assets', 'thumbnail.png'), container.thumbnail, files);
  }

  // 5. assets/vectors/* — best-effort SVG (옵션)
  // 1599개 SVG (각 ~200B)를 sync writeFileSync로 쓰면 Windows 파일 핸들 비용이
  // 누적되어 ~400ms 소요. fs.promises.writeFile + Promise.all 배치로 ~2-3x 단축.
  const messageBlobs =
    (decoded.message as { blobs?: Array<{ bytes: Uint8Array }> }).blobs ?? [];
  const vectorResults = options.extractVectors
    ? extractVectors(tree.document, messageBlobs)
    : [];
  let vectorsConverted = 0;
  let vectorsFailed = 0;

  if (vectorResults.length > 0) {
    const enc = new TextEncoder();
    const tasks: Array<Promise<{ path: string; bytes: number; sha256: string }>> = [];
    for (const v of vectorResults) {
      if (v.svg) {
        const path = join(outputDir, 'assets', 'vectors', `${sanitize(v.nodeId)}.svg`);
        const bytes = enc.encode(v.svg);
        tasks.push(
          writeFileAsync(path, bytes).then(() => ({
            path,
            bytes: bytes.byteLength,
            sha256: sha256(bytes),
          })),
        );
        vectorsConverted++;
      } else {
        vectorsFailed++;
      }
    }
    // 결정성을 위해 결과를 입력 순서대로 files 배열에 push (Promise.all은 순서 보존)
    const results = await Promise.all(tasks);
    for (const r of results) files.push(r);
  }

  // 6. schema.json — Kiwi 스키마 (역공학 산출물)
  writeJson(
    join(outputDir, 'schema.json'),
    serializeSchema(decoded.schema, decoded.schemaStats.definitionCount),
    files,
    indent,
  );

  // 7. metadata.json — meta.json + 추가 추출 메타
  const metadata = {
    archive: {
      isZipWrapped: container.isZipWrapped,
      kiwiVersion: decoded.archiveVersion,
    },
    metaJson: container.metaJson ?? null,
    schemaStats: decoded.schemaStats,
    rootMessageType:
      typeof decoded.message.type === 'string' ? decoded.message.type : null,
    nodeCount: tree.allNodes.size,
    pageCount: pages.length,
    orphanCount: tree.orphans.length,
    imageCount: container.images.size,
    imageRefsCount: imageRefs.size,
    vectorsConverted,
    vectorsFailed,
    extractedAt: new Date().toISOString(),
  };
  writeJson(join(outputDir, 'metadata.json'), metadata, files, indent);

  // 8. raw_message.json — 원본 디코드 메시지 (옵션 — 매우 큼)
  if (options.includeRawMessage) {
    writeJson(
      join(outputDir, 'raw_message.json'),
      sanitizeForJson(decoded.message),
      files,
      indent,
    );
  }

  // 9. orphans.json — parent 못 찾은 노드들 (디버깅용)
  if (tree.orphans.length > 0) {
    writeJson(
      join(outputDir, 'orphans.json'),
      tree.orphans.map((o) => ({
        id: o.guidStr,
        type: o.type,
        name: o.name,
        parentId: o.parentGuid ? guidKey(o.parentGuid) : null,
      })),
      files,
      indent,
    );
  }

  // 10. manifest.json — 모든 산출물 인덱스 + SHA-256
  const manifest = {
    generator: 'figma-reverse v0.1.0',
    sourceContainer: {
      isZipWrapped: container.isZipWrapped,
      canvasFigSize: container.canvasFig.byteLength,
      imagesCount: container.images.size,
    },
    files: files.map((f) => ({
      path: f.path.replace(outputDir + '\\', '').replace(outputDir + '/', '').replace(/\\/g, '/'),
      bytes: f.bytes,
      sha256: f.sha256,
    })),
  };
  writeJson(join(outputDir, 'manifest.json'), manifest, files, indent);

  const stats: ExtractStats = {
    totalNodes: tree.allNodes.size,
    pages: pages.length,
    topLevelFrames: pages.reduce((sum, p) => sum + p.children.length, 0),
    imagesReferenced: countReferencedImages(imageRefs, container.images),
    imagesUnused:
      container.images.size - countReferencedImages(imageRefs, container.images),
    vectorsConverted,
    vectorsFailed,
    unknownTypes: countUnknownTypes(tree),
  };

  return {
    outputDir,
    files,
    stats,
    imageRefs,
    vectorResults,
    document,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function sanitize(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80);
}

function writeBytes(
  path: string,
  bytes: Uint8Array,
  out: ExportArtifacts['files'],
): void {
  writeFileSync(path, bytes);
  out.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
}

function writeJson(
  path: string,
  data: unknown,
  out: ExportArtifacts['files'],
  indent: number = 2,
): void {
  const text = JSON.stringify(data, jsonReplacer, indent || undefined);
  const bytes = new TextEncoder().encode(text);
  writeFileSync(path, bytes);
  out.push({ path, bytes: bytes.byteLength, sha256: sha256(bytes) });
}

function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Uint8Array) return hashToHex(value);
  return value;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function countReferencedImages(
  refs: Map<string, Set<string>>,
  images: Map<string, Uint8Array>,
): number {
  let n = 0;
  for (const hash of images.keys()) {
    if (refs.has(hash.toLowerCase())) n++;
  }
  return n;
}

function countUnknownTypes(tree: BuildTreeResult): Record<string, number> {
  const known = new Set([
    'NONE',
    'DOCUMENT',
    'CANVAS',
    'GROUP',
    'FRAME',
    'BOOLEAN_OPERATION',
    'VECTOR',
    'STAR',
    'LINE',
    'ELLIPSE',
    'RECTANGLE',
    'REGULAR_POLYGON',
    'ROUNDED_RECTANGLE',
    'TEXT',
    'SLICE',
    'SYMBOL',
    'INSTANCE',
    'STICKY',
    'SHAPE_WITH_TEXT',
    'CONNECTOR',
    'CODE_BLOCK',
    'WIDGET',
    'STAMP',
    'MEDIA',
    'HIGHLIGHT',
    'SECTION',
    'SECTION_OVERLAY',
    'WASHI_TAPE',
    'VARIABLE',
  ]);
  const unknown: Record<string, number> = {};
  for (const tn of tree.allNodes.values()) {
    if (!known.has(tn.type)) {
      unknown[tn.type] = (unknown[tn.type] ?? 0) + 1;
    }
  }
  return unknown;
}

function serializeSchema(
  schema: kiwi.Schema,
  count: number,
): Record<string, unknown> {
  return {
    package: (schema as unknown as { package?: string }).package ?? null,
    definitionCount: count,
    definitions: schema.definitions ?? [],
  };
}

function sanitizeForJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, jsonReplacer));
}
