/**
 * 역방향 파이프라인: extracted/ → .fig 파일 재생성 (PRD §2.2 v1 비목표 → v2 scope)
 *
 * 두 가지 모드:
 *   (a) "byte"  — extracted/01_container/의 raw 파일들을 ZIP STORE로 다시 묶음.
 *                 canvas.fig 내용은 1:1 보존. 가장 안전.
 *   (b) "kiwi"  — extracted/03_decompressed/의 schema.kiwi.bin + data.kiwi.bin을
 *                 kiwi.encodeBinarySchema/encodeMessage로 재인코드 후
 *                 deflate-raw로 압축, 새로운 canvas.fig 작성.
 *                 ※ 원본 data 청크는 zstd였지만 fzstd는 decode-only이므로 deflate-raw 통일.
 *
 * 두 모드 모두 결과 .fig를 즉시 다시 추출해 round-trip 검증 수행.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import AdmZip from 'adm-zip';
import * as kiwi from 'kiwi-schema';
import { deflateRaw } from 'pako';
import { loadContainer } from './container.js';
import { decodeFigCanvas } from './decoder.js';

export type RepackMode = 'byte' | 'kiwi' | 'json';

export interface RepackOptions {
  mode: RepackMode;
  /** 원본 .fig 경로 — round-trip 비교용 (선택) */
  originalFig?: string;
}

export interface RepackResult {
  mode: RepackMode;
  outPath: string;
  outBytes: number;
  outSha256: string;
  files: Array<{ name: string; bytes: number }>;
  /** repack한 .fig를 우리 자신의 파서로 다시 추출 */
  verify: {
    extracted: boolean;
    isZipWrapped?: boolean;
    archiveVersion?: number;
    schemaDefCount?: number;
    nodeChangesCount?: number;
    blobsCount?: number;
    rootMessageType?: string;
    error?: string;
  };
  /** 원본 .fig와의 비교 (originalFig 제공 시) */
  comparison?: {
    originalNodeCount: number;
    nodeCountMatch: boolean;
    originalSchemaDefCount: number;
    schemaDefCountMatch: boolean;
    originalArchiveVersion: number;
    archiveVersionMatch: boolean;
    canvasFigBytesIdentical?: boolean;
  };
}

export async function repack(
  extractedDir: string,
  outPath: string,
  opts: RepackOptions,
): Promise<RepackResult> {
  switch (opts.mode) {
    case 'byte':
      return repackByteLevel(extractedDir, outPath, opts);
    case 'kiwi':
      return repackKiwi(extractedDir, outPath, opts);
    case 'json':
      return repackFromJson(extractedDir, outPath, opts);
    default:
      throw new Error(`unknown repack mode: ${opts.mode as string}`);
  }
}

// ─── (a) byte-level repack ─────────────────────────────────────────────────

/**
 * extracted/01_container/ → byte-level .fig 버퍼 (async, 모든 file read 병렬).
 * round-trip HTML 등 .fig 바이트가 필요한 다른 모듈에서 재사용.
 */
export async function buildByteLevelFigBuffer(extractedDir: string): Promise<{
  buffer: Uint8Array;
  files: Array<{ name: string; bytes: number }>;
}> {
  const containerDir = join(extractedDir, '01_container');
  if (!existsSync(containerDir)) {
    throw new Error(
      `extracted/01_container/ not found at: ${containerDir}\n` +
        `Run \`figma-reverse extract <file.fig>\` first.`,
    );
  }

  // 동시에 읽을 파일 목록 수집
  const canvasPath = join(containerDir, 'canvas.fig');
  if (!existsSync(canvasPath)) {
    throw new Error(`canvas.fig not found in ${containerDir}`);
  }
  const reads: Array<Promise<{ name: string; data: Buffer } | null>> = [];
  reads.push(readFile(canvasPath).then((data) => ({ name: 'canvas.fig', data })));
  for (const optName of ['meta.json', 'thumbnail.png']) {
    const p = join(containerDir, optName);
    if (existsSync(p)) reads.push(readFile(p).then((data) => ({ name: optName, data })));
  }
  const imagesDir = join(containerDir, 'images');
  if (existsSync(imagesDir)) {
    for (const f of readdirSync(imagesDir).sort()) {
      const fpath = join(imagesDir, f);
      if (statSync(fpath).isFile()) {
        reads.push(readFile(fpath).then((data) => ({ name: `images/${f}`, data })));
      }
    }
  }

  // 모든 read 병렬 실행
  const entries = (await Promise.all(reads)).filter(
    (e): e is { name: string; data: Buffer } => e !== null,
  );

  const zip = new AdmZip();
  const files: Array<{ name: string; bytes: number }> = [];
  for (const e of entries) {
    zip.addFile(e.name, e.data);
    files.push({ name: e.name, bytes: e.data.byteLength });
  }

  // STORE 압축 (Figma 원본 형식과 동일)
  forceStoreCompression(zip);
  return { buffer: new Uint8Array(zip.toBuffer()), files };
}

async function repackByteLevel(
  extractedDir: string,
  outPath: string,
  opts: RepackOptions,
): Promise<RepackResult> {
  const { buffer, files: rawFiles } = await buildByteLevelFigBuffer(extractedDir);
  const files: RepackResult['files'] = rawFiles.map((f) => ({ ...f }));

  ensureDir(dirname(outPath));
  await writeFile(outPath, buffer);

  return finalizeResult('byte', outPath, files, opts.originalFig);
}

// ─── (b) Kiwi re-encode repack ─────────────────────────────────────────────

async function repackKiwi(
  extractedDir: string,
  outPath: string,
  opts: RepackOptions,
): Promise<RepackResult> {
  const decompDir = join(extractedDir, '03_decompressed');
  const schemaBinPath = join(decompDir, 'schema.kiwi.bin');
  const dataBinPath = join(decompDir, 'data.kiwi.bin');
  if (!existsSync(schemaBinPath) || !existsSync(dataBinPath)) {
    throw new Error(
      `extracted/03_decompressed/ binaries not found. ` +
        `Run \`figma-reverse extract <file.fig>\` first (without --no-intermediate).`,
    );
  }

  // 1. schema/data binary + 부속 파일들을 모두 동시에 읽기
  const containerDir = join(extractedDir, '01_container');
  const sidecarPaths: Array<{ name: string; path: string }> = [];
  for (const name of ['meta.json', 'thumbnail.png']) {
    const p = join(containerDir, name);
    if (existsSync(p)) sidecarPaths.push({ name, path: p });
  }
  const imagesDir = join(containerDir, 'images');
  if (existsSync(imagesDir)) {
    for (const f of readdirSync(imagesDir).sort()) {
      const fpath = join(imagesDir, f);
      if (statSync(fpath).isFile()) sidecarPaths.push({ name: `images/${f}`, path: fpath });
    }
  }
  const [schemaBuf, dataBuf, sidecars] = await Promise.all([
    readFile(schemaBinPath),
    readFile(dataBinPath),
    Promise.all(
      sidecarPaths.map(async (s) => ({ name: s.name, data: await readFile(s.path) })),
    ),
  ]);
  const schemaBin = new Uint8Array(schemaBuf);
  const dataBin = new Uint8Array(dataBuf);

  // 2. 스키마 + 메시지 디코드 → 재인코드 (CPU-heavy, 동기)
  const schema = kiwi.decodeBinarySchema(schemaBin);
  const compiled = kiwi.compileSchema(schema);
  const message = compiled.decodeMessage(dataBin);

  const reSchemaBin = kiwi.encodeBinarySchema(schema);
  const reDataBin = compiled.encodeMessage(message);

  // 3. deflate-raw 압축 (CPU-heavy, 동기 — pako sync)
  const compressedSchema = deflateRaw(reSchemaBin);
  const compressedData = deflateRaw(reDataBin);

  // 4. archive version 복원 (extracted/02_archive/_info.json)
  const archiveVersion = readArchiveVersion(extractedDir);

  // 5. fig-kiwi 아카이브 작성
  const newCanvas = buildFigKiwiArchive(archiveVersion, [compressedSchema, compressedData]);

  // 6. ZIP으로 패키징 (mem 작업)
  const zip = new AdmZip();
  const files: RepackResult['files'] = [];
  zip.addFile('canvas.fig', Buffer.from(newCanvas));
  files.push({ name: 'canvas.fig', bytes: newCanvas.byteLength });
  for (const s of sidecars) {
    zip.addFile(s.name, s.data);
    files.push({ name: s.name, bytes: s.data.byteLength });
  }

  forceStoreCompression(zip);
  ensureDir(dirname(outPath));
  await writeFile(outPath, zip.toBuffer());

  return finalizeResult('kiwi', outPath, files, opts.originalFig);
}

// ─── (c) JSON-edited message → .fig 재인코드 ─────────────────────────────
//
// 사용자가 extracted/04_decoded/message.json을 편집한 뒤 .fig로 재패키징.
// (extract 시 --include-raw-message 필요)
//
// 한계 (자세히는 docs/JSON_TO_FIG_FEASIBILITY.md):
// - Uint8Array가 JSON에 {"0":1,...} object로 직렬화돼 있으므로 reviver로 복원
// - schema는 03_decompressed/schema.kiwi.bin에서 읽기 (편집 대상 아님)

async function repackFromJson(
  extractedDir: string,
  outPath: string,
  opts: RepackOptions,
): Promise<RepackResult> {
  const decompDir = join(extractedDir, '03_decompressed');
  const schemaBinPath = join(decompDir, 'schema.kiwi.bin');
  const messageJsonPath = join(extractedDir, '04_decoded', 'message.json');
  if (!existsSync(schemaBinPath)) {
    throw new Error(
      `extracted/03_decompressed/schema.kiwi.bin not found. Run \`figma-reverse extract\` first.`,
    );
  }
  if (!existsSync(messageJsonPath)) {
    throw new Error(
      `extracted/04_decoded/message.json not found.\n` +
        `Run \`figma-reverse extract <fig> --include-raw-message\` to generate it.`,
    );
  }

  // 1. schema + message.json + sidecar 파일 병렬 읽기
  const containerDir = join(extractedDir, '01_container');
  const sidecarPaths: Array<{ name: string; path: string }> = [];
  for (const name of ['meta.json', 'thumbnail.png']) {
    const p = join(containerDir, name);
    if (existsSync(p)) sidecarPaths.push({ name, path: p });
  }
  const imagesDir = join(containerDir, 'images');
  if (existsSync(imagesDir)) {
    for (const f of readdirSync(imagesDir).sort()) {
      const fpath = join(imagesDir, f);
      if (statSync(fpath).isFile()) sidecarPaths.push({ name: `images/${f}`, path: fpath });
    }
  }
  const [schemaBuf, messageJsonText, sidecars] = await Promise.all([
    readFile(schemaBinPath),
    readFile(messageJsonPath, 'utf8'),
    Promise.all(
      sidecarPaths.map(async (s) => ({ name: s.name, data: await readFile(s.path) })),
    ),
  ]);

  // 2. JSON 파싱 + Uint8Array 복원 (blobs[].bytes 같은 binary 필드)
  const message = JSON.parse(messageJsonText, (_k, v) => reviveBinary(v)) as Record<string, unknown>;

  // 3. kiwi 인코드
  const schema = kiwi.decodeBinarySchema(new Uint8Array(schemaBuf));
  const compiled = kiwi.compileSchema(schema);
  const reSchemaBin = kiwi.encodeBinarySchema(schema);
  const reDataBin = compiled.encodeMessage(message);

  // 4. compress + archive
  const compressedSchema = deflateRaw(reSchemaBin);
  const compressedData = deflateRaw(reDataBin);
  const archiveVersion = readArchiveVersion(extractedDir);
  const newCanvas = buildFigKiwiArchive(archiveVersion, [compressedSchema, compressedData]);

  // 5. ZIP 패키징
  const zip = new AdmZip();
  const files: RepackResult['files'] = [];
  zip.addFile('canvas.fig', Buffer.from(newCanvas));
  files.push({ name: 'canvas.fig', bytes: newCanvas.byteLength });
  for (const s of sidecars) {
    zip.addFile(s.name, s.data);
    files.push({ name: s.name, bytes: s.data.byteLength });
  }
  forceStoreCompression(zip);
  ensureDir(dirname(outPath));
  await writeFile(outPath, zip.toBuffer());

  return finalizeResult('json', outPath, files, opts.originalFig);
}

/** JSON.parse reviver: intermediate.ts의 roundTripReplacer 쌍.
 *  - {__bytes: "base64..."}  → Uint8Array (kiwi binary blobs)
 *  - {__bigint: "123"}       → bigint
 *  - {__num: "NaN"|"Infinity"|"-Infinity"} → 비-finite 숫자 (JSON에서 null로 손실되는 값)
 *  그 외 일반 object/array/scalar는 통과. */
function reviveBinary(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  const obj = v as Record<string, unknown>;
  if (typeof obj.__bytes === 'string') {
    const buf = Buffer.from(obj.__bytes, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  if (typeof obj.__bigint === 'string') {
    return BigInt(obj.__bigint);
  }
  if (typeof obj.__num === 'string') {
    if (obj.__num === 'NaN') return NaN;
    if (obj.__num === 'Infinity') return Infinity;
    if (obj.__num === '-Infinity') return -Infinity;
  }
  return v;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function readArchiveVersion(extractedDir: string): number {
  const infoPath = join(extractedDir, '02_archive', '_info.json');
  if (!existsSync(infoPath)) return 106; // 관찰된 기본값
  try {
    const info = JSON.parse(readFileSync(infoPath, 'utf8')) as { version?: number };
    return typeof info.version === 'number' ? info.version : 106;
  } catch {
    return 106;
  }
}

function buildFigKiwiArchive(version: number, chunks: Uint8Array[]): Uint8Array {
  // 8B "fig-kiwi" + 4B LE version + N×(4B LE size + size bytes)
  const prelude = new TextEncoder().encode('fig-kiwi');
  const totalSize =
    prelude.byteLength + 4 + chunks.reduce((s, c) => s + 4 + c.byteLength, 0);
  const out = new Uint8Array(totalSize);
  const view = new DataView(out.buffer);
  let offset = 0;
  out.set(prelude, offset);
  offset += prelude.byteLength;
  view.setUint32(offset, version, true);
  offset += 4;
  for (const chunk of chunks) {
    view.setUint32(offset, chunk.byteLength, true);
    offset += 4;
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function forceStoreCompression(zip: AdmZip): void {
  // adm-zip의 ZipEntry header.method 0 = STORE (압축 없음)
  for (const entry of zip.getEntries()) {
    (entry.header as { method: number }).method = 0;
  }
}

async function finalizeResult(
  mode: RepackMode,
  outPath: string,
  files: RepackResult['files'],
  originalFigPath?: string,
): Promise<RepackResult> {
  const outBuf = await readFile(outPath);
  const result: RepackResult = {
    mode,
    outPath,
    outBytes: outBuf.byteLength,
    outSha256: sha256(outBuf),
    files,
    verify: { extracted: false },
  };

  // Round-trip 1단계: 우리 자신의 파서로 .fig를 다시 읽기
  try {
    const container = loadContainer(outPath);
    const decoded = decodeFigCanvas(container.canvasFig);
    const msg = decoded.message as Record<string, unknown>;
    result.verify = {
      extracted: true,
      isZipWrapped: container.isZipWrapped,
      archiveVersion: decoded.archiveVersion,
      schemaDefCount: decoded.schemaStats.definitionCount,
      nodeChangesCount: Array.isArray(msg.nodeChanges) ? msg.nodeChanges.length : 0,
      blobsCount: Array.isArray(msg.blobs) ? (msg.blobs as unknown[]).length : 0,
      rootMessageType: typeof msg.type === 'string' ? msg.type : undefined,
    };

    // Round-trip 2단계: 원본과 비교
    if (originalFigPath && existsSync(originalFigPath)) {
      const origContainer = loadContainer(originalFigPath);
      const origDecoded = decodeFigCanvas(origContainer.canvasFig);
      const origMsg = origDecoded.message as Record<string, unknown>;
      const origNodeCount = Array.isArray(origMsg.nodeChanges)
        ? origMsg.nodeChanges.length
        : 0;
      result.comparison = {
        originalNodeCount: origNodeCount,
        nodeCountMatch: origNodeCount === result.verify.nodeChangesCount,
        originalSchemaDefCount: origDecoded.schemaStats.definitionCount,
        schemaDefCountMatch:
          origDecoded.schemaStats.definitionCount === decoded.schemaStats.definitionCount,
        originalArchiveVersion: origDecoded.archiveVersion,
        archiveVersionMatch: origDecoded.archiveVersion === decoded.archiveVersion,
      };

      // byte mode: canvas.fig가 바이트 동일한지 (ZIP STORE 보존)
      if (mode === 'byte') {
        result.comparison.canvasFigBytesIdentical = bytesEqual(
          container.canvasFig,
          origContainer.canvasFig,
        );
      }
    }
  } catch (err) {
    result.verify = { extracted: false, error: (err as Error).message };
  }

  return result;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true });
}

function sha256(b: Uint8Array | Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}
