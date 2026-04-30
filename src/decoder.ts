/**
 * Iteration 3-4: Kiwi 스키마 디코드 + 데이터 메시지 디코드 (PRD §4.2 F-PROC-03, F-PROC-04)
 *
 * 흐름:
 *   1. archive.chunks[0] (압축) → decompress → schemaBytes
 *   2. schemaBytes → kiwi.decodeBinarySchema → Schema 객체 (~534 type)
 *   3. compileSchema(schema) → compiled (decodeMessage 메서드 보유)
 *   4. archive.chunks[1] (압축) → decompress → dataBytes
 *   5. compiled.decodeMessage(dataBytes) → Message (NodeChanges 트리)
 */

import * as kiwi from 'kiwi-schema';
import { parseFigArchive } from './archive.js';
import { decompress, detectCompression } from './decompress.js';
import type { Compression, FigArchive, KiwiMessage } from './types.js';

export interface DecodedFig {
  archiveVersion: number;
  /** 원본 archive (chunk bytes 보유) — 중간 산출물 dump용 */
  archive: FigArchive;
  schema: kiwi.Schema;
  /** 컴파일된 스키마 — encodeMessage/decodeMessage 가능. verify.ts 등에서 재사용. */
  compiled: ReturnType<typeof kiwi.compileSchema>;
  /** 디코드된 NodeChanges 메시지 (or 다른 RootType) */
  message: KiwiMessage;
  rawSchemaBytes: Uint8Array;
  rawDataBytes: Uint8Array;
  /** 청크별 감지된 압축 알고리즘 */
  schemaCompression: Compression;
  dataCompression: Compression;
  /** 추가 청크 (있다면 보존) */
  extraChunks: Uint8Array[];
  /** 스키마 통계 */
  schemaStats: {
    definitionCount: number;
    rootType?: string;
  };
}

export function decodeFigCanvas(canvasFig: Uint8Array): DecodedFig {
  const archive = parseFigArchive(canvasFig);
  if (archive.chunks.length < 2) {
    throw new Error(
      `Expected ≥2 chunks (schema + data), got ${archive.chunks.length}. ` +
        `Archive version: ${archive.version}`,
    );
  }

  const [schemaCompressed, dataCompressed, ...rest] = archive.chunks;
  const schemaCompression = detectCompression(schemaCompressed!);
  const dataCompression = detectCompression(dataCompressed!);

  const rawSchemaBytes = decompress(schemaCompressed!);
  const schema = kiwi.decodeBinarySchema(rawSchemaBytes);
  const compiled = kiwi.compileSchema(schema);

  const rawDataBytes = decompress(dataCompressed!);

  // kiwi-schema의 compiled.decodeMessage는 첫 번째 byte(들)에서 root type ID를
  // 읽는다고 알려져 있으나, 단순히 호출만 해도 동작.
  const message = compiled.decodeMessage(rawDataBytes) as KiwiMessage;

  return {
    archiveVersion: archive.version,
    archive,
    schema,
    compiled,
    message,
    rawSchemaBytes,
    rawDataBytes,
    schemaCompression,
    dataCompression,
    extraChunks: rest,
    schemaStats: {
      definitionCount: schema.definitions?.length ?? 0,
      rootType: extractRootType(schema),
    },
  };
}

function extractRootType(schema: kiwi.Schema): string | undefined {
  // Schema에 rootType이 별도 필드로 있을 수 있음
  const def = (schema as unknown as { rootType?: string }).rootType;
  return def ?? schema.definitions?.find((d) => d.kind === 'MESSAGE')?.name;
}
