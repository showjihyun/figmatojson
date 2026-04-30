/**
 * 중간 산출물 추적용 dumper (PRD §6 Plan-Execute-Verify breadcrumb trail)
 *
 * 파이프라인 각 단계 직후 disk에 산출물을 남겨, 디버깅·검증·재현이 가능하도록 한다.
 * 모든 stage 디렉토리는 `_info.json` 메타파일을 함께 출력해 무엇이 일어났는지 기록.
 *
 *   01_container/      ZIP 분해 직후 (ZIP 내부 파일 구조 그대로)
 *   02_archive/        fig-kiwi 청크 분해 (압축 상태)
 *   03_decompressed/   압축 해제 (kiwi binary)
 *   04_decoded/        Kiwi 디코드 결과 (JSON)
 *   05_tree/           트리 빌드 결과 (요약 + orphans)
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hashToHex } from './assets.js';
import type { DecodedFig } from './decoder.js';
import { guidKey } from './tree.js';
import type { BuildTreeResult, ContainerResult, FigArchive } from './types.js';

export interface IntermediateOptions {
  /** 중간 산출물 dump 활성화 (default true) */
  enabled: boolean;
  /** dump 루트 디렉토리 */
  dir: string;
  /** 04_decoded/message.json (디코드된 전체 메시지 — 매우 큼) 포함 */
  includeFullMessage: boolean;
  /** JSON 들여쓰기 제거 */
  minify: boolean;
}

export interface StageWritten {
  stage: string;
  files: Array<{ path: string; bytes: number }>;
}

// ─── Stage 1: Container ────────────────────────────────────────────────────

export function dumpStage1Container(
  opts: IntermediateOptions,
  c: ContainerResult,
): StageWritten | null {
  if (!opts.enabled) return null;
  const dir = join(opts.dir, '01_container');
  ensureDir(dir);
  ensureDir(join(dir, 'images'));

  const written: StageWritten = { stage: '01_container', files: [] };
  pushFile(written, writeBytes(join(dir, 'canvas.fig'), c.canvasFig));

  if (c.metaJson) {
    pushFile(written, writeJson(join(dir, 'meta.json'), c.metaJson, opts.minify));
  }
  if (c.thumbnail) {
    pushFile(written, writeBytes(join(dir, 'thumbnail.png'), c.thumbnail));
  }
  // 이미지는 ZIP 내 원본 그대로 (해시 파일명, 확장자 없음)
  for (const [hash, bytes] of c.images) {
    pushFile(written, writeBytes(join(dir, 'images', hash), bytes));
  }

  pushFile(
    written,
    writeJson(
      join(dir, '_info.json'),
      {
        stage: '01_container',
        description: 'ZIP 컨테이너 분해 직후 — Figma Cloud export ZIP 내부 파일 그대로',
        isZipWrapped: c.isZipWrapped,
        canvasFig: {
          bytes: c.canvasFig.byteLength,
          firstBytesHex: hexHead(c.canvasFig, 16),
          sha256: sha256(c.canvasFig),
        },
        metaJsonPresent: !!c.metaJson,
        thumbnail: c.thumbnail
          ? { bytes: c.thumbnail.byteLength, sha256: sha256(c.thumbnail) }
          : null,
        images: {
          count: c.images.size,
          hashes: Array.from(c.images.keys()),
          totalBytes: Array.from(c.images.values()).reduce((s, b) => s + b.byteLength, 0),
        },
      },
      opts.minify,
    ),
  );
  return written;
}

// ─── Stage 2: Archive (compressed chunks) ──────────────────────────────────

export function dumpStage2Archive(
  opts: IntermediateOptions,
  archive: FigArchive,
): StageWritten | null {
  if (!opts.enabled) return null;
  const dir = join(opts.dir, '02_archive');
  ensureDir(dir);
  ensureDir(join(dir, 'chunks'));

  const written: StageWritten = { stage: '02_archive', files: [] };
  archive.chunks.forEach((chunk, i) => {
    const name =
      i === 0 ? '00_schema.bin' : i === 1 ? '01_data.bin' : `${pad2(i)}_extra.bin`;
    pushFile(written, writeBytes(join(dir, 'chunks', name), chunk));
  });

  pushFile(
    written,
    writeJson(
      join(dir, '_info.json'),
      {
        stage: '02_archive',
        description:
          'fig-kiwi 청크 분해 (압축 상태). 첫 청크 = Kiwi 스키마, 두 번째 = 데이터 메시지.',
        prelude: archive.prelude,
        version: archive.version,
        chunkCount: archive.chunks.length,
        chunks: archive.chunks.map((c, i) => ({
          index: i,
          role: i === 0 ? 'schema' : i === 1 ? 'data' : 'extra',
          compressedBytes: c.byteLength,
          firstBytesHex: hexHead(c, 8),
          sha256: sha256(c),
        })),
      },
      opts.minify,
    ),
  );
  return written;
}

// ─── Stage 3: Decompressed kiwi binaries ───────────────────────────────────

export function dumpStage3Decompressed(
  opts: IntermediateOptions,
  decoded: DecodedFig,
): StageWritten | null {
  if (!opts.enabled) return null;
  const dir = join(opts.dir, '03_decompressed');
  ensureDir(dir);

  const written: StageWritten = { stage: '03_decompressed', files: [] };
  pushFile(written, writeBytes(join(dir, 'schema.kiwi.bin'), decoded.rawSchemaBytes));
  pushFile(written, writeBytes(join(dir, 'data.kiwi.bin'), decoded.rawDataBytes));

  pushFile(
    written,
    writeJson(
      join(dir, '_info.json'),
      {
        stage: '03_decompressed',
        description:
          '02_archive 청크를 압축 해제한 raw kiwi 바이너리. ' +
          'schema.kiwi.bin → kiwi.decodeBinarySchema, data.kiwi.bin → compiled.decodeMessage 입력.',
        schema: {
          bytes: decoded.rawSchemaBytes.byteLength,
          compression: decoded.schemaCompression,
          firstBytesHex: hexHead(decoded.rawSchemaBytes, 16),
          sha256: sha256(decoded.rawSchemaBytes),
        },
        data: {
          bytes: decoded.rawDataBytes.byteLength,
          compression: decoded.dataCompression,
          firstBytesHex: hexHead(decoded.rawDataBytes, 16),
          sha256: sha256(decoded.rawDataBytes),
        },
      },
      opts.minify,
    ),
  );
  return written;
}

// ─── Stage 4: Kiwi-decoded JSON ────────────────────────────────────────────

export function dumpStage4Decoded(
  opts: IntermediateOptions,
  decoded: DecodedFig,
): StageWritten | null {
  if (!opts.enabled) return null;
  const dir = join(opts.dir, '04_decoded');
  ensureDir(dir);

  const written: StageWritten = { stage: '04_decoded', files: [] };

  // schema는 항상 (~800KB)
  pushFile(
    written,
    writeJson(
      join(dir, 'schema.json'),
      {
        package: (decoded.schema as unknown as { package?: string }).package ?? null,
        definitionCount: decoded.schemaStats.definitionCount,
        rootType: decoded.schemaStats.rootType ?? null,
        definitions: decoded.schema.definitions ?? [],
      },
      opts.minify,
    ),
  );

  // 전체 메시지는 옵션 (~150 MB).
  // round-trip 가능하도록 Uint8Array를 base64 태그({__bytes: "base64..."})로 직렬화.
  // (다른 _info.json 등은 hashToHex 표현이 디스플레이 용도라 무손실 불요)
  if (opts.includeFullMessage) {
    pushFile(
      written,
      writeJsonRoundTrip(join(dir, 'message.json'), decoded.message, opts.minify),
    );
  }

  const msg = decoded.message as Record<string, unknown>;
  const blobs = (msg.blobs as Array<{ bytes?: Uint8Array }> | undefined) ?? [];
  pushFile(
    written,
    writeJson(
      join(dir, '_info.json'),
      {
        stage: '04_decoded',
        description: 'Kiwi 스키마 + 데이터 디코드 결과 (JSON 형태).',
        rootMessageType: typeof msg.type === 'string' ? msg.type : null,
        topLevelKeys: Object.keys(msg).sort(),
        nodeChangesCount: Array.isArray(msg.nodeChanges) ? msg.nodeChanges.length : 0,
        blobsCount: blobs.length,
        blobsTotalBytes: blobs.reduce((s, b) => s + (b.bytes?.byteLength ?? 0), 0),
        schemaDefinitionCount: decoded.schemaStats.definitionCount,
        archiveVersion: decoded.archiveVersion,
        fullMessageWritten: opts.includeFullMessage,
      },
      opts.minify,
    ),
  );
  return written;
}

// ─── Stage 5: Tree build result ────────────────────────────────────────────

export function dumpStage5Tree(
  opts: IntermediateOptions,
  tree: BuildTreeResult,
): StageWritten | null {
  if (!opts.enabled) return null;
  const dir = join(opts.dir, '05_tree');
  ensureDir(dir);

  const written: StageWritten = { stage: '05_tree', files: [] };

  // 평탄화된 노드 테이블 (한 줄 = 한 노드, nested children 없음 — grep 가능)
  const flat = Array.from(tree.allNodes.values()).map((n) => ({
    id: n.guidStr,
    type: n.type,
    name: n.name ?? null,
    parentId: n.parentGuid ? guidKey(n.parentGuid) : null,
    childCount: n.children.length,
    position: n.position ?? null,
  }));
  pushFile(written, writeJson(join(dir, 'nodes-flat.json'), flat, opts.minify));

  if (tree.orphans.length > 0) {
    pushFile(
      written,
      writeJson(
        join(dir, 'orphans.json'),
        tree.orphans.map((o) => ({
          id: o.guidStr,
          type: o.type,
          name: o.name ?? null,
          parentId: o.parentGuid ? guidKey(o.parentGuid) : null,
        })),
        opts.minify,
      ),
    );
  }

  const pages = tree.document?.children.filter((c) => c.type === 'CANVAS') ?? [];

  // 노드 타입 분포
  const typeDist: Record<string, number> = {};
  for (const n of tree.allNodes.values()) {
    typeDist[n.type] = (typeDist[n.type] ?? 0) + 1;
  }

  pushFile(
    written,
    writeJson(
      join(dir, '_info.json'),
      {
        stage: '05_tree',
        description: 'parent-child 트리 재구성 결과. nodes-flat.json은 grep 가능한 평탄 테이블.',
        totalNodes: tree.allNodes.size,
        documentRoot: tree.document?.guidStr ?? null,
        documentName: tree.document?.name ?? null,
        pageCount: pages.length,
        pages: pages.map((p) => ({
          id: p.guidStr,
          name: p.name ?? null,
          topLevelChildren: p.children.length,
        })),
        orphanCount: tree.orphans.length,
        typeDistribution: typeDist,
      },
      opts.minify,
    ),
  );
  return written;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true });
}

function writeBytes(path: string, bytes: Uint8Array): { path: string; bytes: number } {
  writeFileSync(path, bytes);
  return { path, bytes: bytes.byteLength };
}

function writeJson(
  path: string,
  data: unknown,
  minify: boolean,
): { path: string; bytes: number } {
  const indent = minify ? undefined : 2;
  const text = JSON.stringify(data, jsonReplacer, indent);
  const buf = new TextEncoder().encode(text);
  writeFileSync(path, buf);
  return { path, bytes: buf.byteLength };
}

function jsonReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Uint8Array) return hashToHex(v);
  return v;
}

/** message.json 전용: Uint8Array를 round-trip 가능한 {__bytes: base64} 형태로 직렬화.
 *  reviver 쌍은 src/repack.ts의 reviveBinary. */
function writeJsonRoundTrip(
  path: string,
  data: unknown,
  minify: boolean,
): { path: string; bytes: number } {
  const indent = minify ? undefined : 2;
  const text = JSON.stringify(data, roundTripReplacer, indent);
  const buf = new TextEncoder().encode(text);
  writeFileSync(path, buf);
  return { path, bytes: buf.byteLength };
}

function roundTripReplacer(_k: string, v: unknown): unknown {
  if (typeof v === 'bigint') return { __bigint: v.toString() };
  if (v instanceof Uint8Array) {
    return { __bytes: Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString('base64') };
  }
  // NaN/Infinity는 JSON에서 null로 손실됨 — 태그로 보존
  if (typeof v === 'number' && !Number.isFinite(v)) {
    if (Number.isNaN(v)) return { __num: 'NaN' };
    return { __num: v > 0 ? 'Infinity' : '-Infinity' };
  }
  return v;
}

function pushFile(
  w: StageWritten,
  entry: { path: string; bytes: number },
): void {
  w.files.push(entry);
}

function pad2(n: number): string {
  return n.toString().padStart(2, '0');
}

function hexHead(b: Uint8Array, n = 8): string {
  return Array.from(b.slice(0, Math.min(n, b.length)))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join(' ');
}

function sha256(b: Uint8Array): string {
  return createHash('sha256').update(b).digest('hex');
}
