/**
 * Iteration 1: ZIP 컨테이너 분해 (PRD §1.2.1, §4.2 F-PROC-01)
 *
 * 입력: .fig 파일 (ZIP-wrapped 또는 raw fig-kiwi)
 * 출력: canvas.fig 바이너리 + meta.json + thumbnail.png + images/
 *
 * 헤더 sniff 자동 분기:
 *   - 50 4B 03 04         → ZIP (PK\x03\x04)
 *   - "fig-kiwi" (66 69 67 2D 6B 69 77 69) → raw 단일 바이너리
 */

import AdmZip from 'adm-zip';
import { readFileSync } from 'node:fs';
import type { ContainerResult, FigMetaJson } from './types.js';

const FIG_KIWI_MAGIC = new Uint8Array([0x66, 0x69, 0x67, 0x2d, 0x6b, 0x69, 0x77, 0x69]); // "fig-kiwi"
const ZIP_MAGIC = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

function startsWith(buf: Uint8Array, magic: Uint8Array): boolean {
  if (buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
  return true;
}

function hex(buf: Uint8Array, n = 16): string {
  return Array.from(buf.slice(0, n))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join(' ');
}

export function loadContainer(filePath: string): ContainerResult {
  const file = readFileSync(filePath);
  const buf = new Uint8Array(file.buffer, file.byteOffset, file.byteLength);

  if (startsWith(buf, ZIP_MAGIC)) {
    return loadZipContainer(file);
  }
  if (startsWith(buf, FIG_KIWI_MAGIC)) {
    return {
      isZipWrapped: false,
      canvasFig: buf,
      images: new Map(),
    };
  }
  throw new Error(
    `Unknown file magic in ${filePath}. First 16 bytes: ${hex(buf)}\n` +
      `Expected ZIP (50 4b 03 04) or fig-kiwi (66 69 67 2d 6b 69 77 69).`,
  );
}

function loadZipContainer(buf: Buffer): ContainerResult {
  let zip: AdmZip;
  let entries: AdmZip.IZipEntry[];
  try {
    zip = new AdmZip(buf);
    entries = zip.getEntries();
  } catch (err) {
    // ADM-ZIP의 raw 메시지("No END header found" 등)를 파일 사이즈 정보와 함께 wrap.
    const reason = (err as Error).message ?? String(err);
    throw new Error(
      `Invalid ZIP container (file may be truncated or corrupted). ` +
        `Read ${buf.byteLength} bytes. Underlying: ${reason}`,
    );
  }

  let canvasFig: Uint8Array | null = null;
  let metaJson: FigMetaJson | undefined;
  let thumbnail: Uint8Array | undefined;
  const images = new Map<string, Uint8Array>();

  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const name = entry.entryName.replace(/\\/g, '/');
    const data = entry.getData();

    if (name === 'canvas.fig') {
      canvasFig = new Uint8Array(data);
    } else if (name === 'meta.json') {
      try {
        metaJson = JSON.parse(data.toString('utf8')) as FigMetaJson;
      } catch (err) {
        throw new Error(`meta.json is not valid JSON: ${(err as Error).message}`);
      }
    } else if (name === 'thumbnail.png') {
      thumbnail = new Uint8Array(data);
    } else if (name.startsWith('images/')) {
      const hash = name.slice('images/'.length);
      if (hash.length > 0) images.set(hash, new Uint8Array(data));
    }
    // 알 수 없는 엔트리는 무시 (forward-compat)
  }

  if (!canvasFig) {
    throw new Error(
      'canvas.fig not found in ZIP container. ' +
        `Found entries: ${entries.map((e) => e.entryName).join(', ')}`,
    );
  }

  return {
    isZipWrapped: true,
    canvasFig,
    metaJson,
    thumbnail,
    images,
  };
}
