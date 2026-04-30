/**
 * e2e — 실제 sample .fig 파일에 대한 전체 파이프라인 통합 테스트
 * + repack round-trip (byte 모드 + kiwi 모드)
 *
 * 실행 시간 길어 single-fork pool 사용 (vitest.config.ts).
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { collectImageRefs } from '../src/assets.js';
import { loadContainer } from '../src/container.js';
import { decodeFigCanvas } from '../src/decoder.js';
import { exportAll } from '../src/export.js';
import { dumpStage1Container, dumpStage3Decompressed, dumpStage4Decoded } from '../src/intermediate.js';
import { repack } from '../src/repack.js';
import { buildTree } from '../src/tree.js';

const SAMPLE = 'docs/메타리치 화면 UI Design.fig';

let tmp: string;
beforeAll(() => {
  if (!existsSync(SAMPLE)) {
    throw new Error(`sample missing: ${SAMPLE}`);
  }
});
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'figrev-e2e-'));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('full pipeline (extract)', () => {
  it('decodes the sample .fig and produces expected metadata', async () => {
    const c = loadContainer(SAMPLE);
    expect(c.isZipWrapped).toBe(true);
    expect(c.images.size).toBe(12);
    expect(c.metaJson?.file_name).toBe('메타리치 화면 UI Design');

    const d = decodeFigCanvas(c.canvasFig);
    expect(d.archiveVersion).toBe(106);
    expect(d.schemaStats.definitionCount).toBe(568);
    expect(d.schemaCompression).toBe('deflate-raw');
    expect(d.dataCompression).toBe('zstd');
    expect(d.message.type).toBe('NODE_CHANGES');

    const tree = buildTree(d.message);
    expect(tree.allNodes.size).toBe(35660);
    expect(tree.orphans.length).toBe(0);
    expect(tree.document?.children.filter((c) => c.type === 'CANVAS').length).toBe(6);

    const refs = collectImageRefs(tree.document);
    expect(refs.size).toBe(12); // 모든 이미지가 참조됨
  });

  it('export produces 1620+ files (pages + images + svgs + meta)', async () => {
    const c = loadContainer(SAMPLE);
    const d = decodeFigCanvas(c.canvasFig);
    const tree = buildTree(d.message);
    const refs = collectImageRefs(tree.document);

    const artifacts = await exportAll({
      outputDir: join(tmp, 'output'),
      container: c,
      decoded: d,
      tree,
      imageRefs: refs,
      options: {
        minify: true,
        includeDocument: false,
        includeRawMessage: false,
        extractVectors: true,
      },
    });

    expect(artifacts.files.length).toBeGreaterThan(1600);
    expect(artifacts.stats.pages).toBe(6);
    expect(artifacts.stats.totalNodes).toBe(35660);
    expect(artifacts.stats.imagesReferenced).toBe(12);
    expect(artifacts.stats.imagesUnused).toBe(0);
    expect(artifacts.stats.vectorsConverted).toBeGreaterThan(1500);
  });
});

describe('repack round-trip', () => {
  beforeEach(() => {
    // extracted 디렉토리 준비
    const c = loadContainer(SAMPLE);
    const d = decodeFigCanvas(c.canvasFig);
    const intOpts = { enabled: true, dir: join(tmp, 'extracted'), includeFullMessage: false, minify: true };
    dumpStage1Container(intOpts, c);
    dumpStage3Decompressed(intOpts, d);
  });

  it('byte mode: canvas.fig is byte-identical to original', async () => {
    const result = await repack(join(tmp, 'extracted'), join(tmp, 'rb.fig'), {
      mode: 'byte',
      originalFig: SAMPLE,
    });
    expect(result.verify.extracted).toBe(true);
    expect(result.verify.archiveVersion).toBe(106);
    expect(result.verify.nodeChangesCount).toBe(35660);
    expect(result.comparison?.canvasFigBytesIdentical).toBe(true);
    expect(result.comparison?.nodeCountMatch).toBe(true);
    expect(result.comparison?.schemaDefCountMatch).toBe(true);
  });

  it('kiwi mode: semantically equivalent (deflate-raw 압축, byte 다름)', async () => {
    // 이 모드는 03_decompressed가 필요한데 beforeEach에서 dumpStage1+3만 했으므로
    // 02_archive _info.json은 없음 → archive version은 fallback default(106) 사용 OK.
    const result = await repack(join(tmp, 'extracted'), join(tmp, 'rk.fig'), {
      mode: 'kiwi',
      originalFig: SAMPLE,
    });
    expect(result.verify.extracted).toBe(true);
    expect(result.verify.nodeChangesCount).toBe(35660);
    expect(result.comparison?.nodeCountMatch).toBe(true);
    expect(result.comparison?.schemaDefCountMatch).toBe(true);
    // kiwi mode는 byte-identical 아님
    expect(result.comparison?.canvasFigBytesIdentical).toBeUndefined();
  });

  it('json mode: edited message.json round-trips to semantically equivalent .fig', async () => {
    // json 모드는 04_decoded/message.json이 필요. includeFullMessage=true로 추가 dump.
    const c = loadContainer(SAMPLE);
    const d = decodeFigCanvas(c.canvasFig);
    const intOpts = { enabled: true, dir: join(tmp, 'extracted'), includeFullMessage: true, minify: true };
    dumpStage4Decoded(intOpts, d);

    const result = await repack(join(tmp, 'extracted'), join(tmp, 'rj.fig'), {
      mode: 'json',
      originalFig: SAMPLE,
    });
    expect(result.verify.extracted).toBe(true);
    expect(result.verify.archiveVersion).toBe(106);
    expect(result.verify.nodeChangesCount).toBe(35660);
    expect(result.verify.blobsCount).toBe(6094);
    expect(result.comparison?.nodeCountMatch).toBe(true);
    expect(result.comparison?.schemaDefCountMatch).toBe(true);
  });
});
