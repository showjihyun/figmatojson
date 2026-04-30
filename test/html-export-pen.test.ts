/**
 * html-export — pen viewer 대시보드 smoke test.
 *
 * Behavior:
 *   - 08_pen/*.pen.json 파일들이 dashboard/data/pen-pages/<n>.js로 lazy-loadable하게 출력됨
 *   - dashboard/data/pen-index.js 가 생성되어 각 pen 파일의 metadata(name, nodeCount, relPath, bytes)를 담음
 *   - 생성된 index.html에 Pen 탭 버튼이 존재
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateHtmlDashboard } from '../src/html-export.js';

let tmp: string;
let extractedDir: string;
let outputDir: string;
let htmlOutDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'figrev-html-pen-'));
  extractedDir = join(tmp, 'extracted');
  outputDir = join(tmp, 'output');
  htmlOutDir = join(tmp, 'dashboard');
  mkdirSync(extractedDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(extractedDir, '08_pen'), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function writePenFile(fileName: string, doc: unknown): void {
  writeFileSync(join(extractedDir, '08_pen', fileName), JSON.stringify(doc));
}

describe('html-export pen viewer', () => {
  it('generates pen-index.js and pen-pages/<n>.js for each .pen.json file', () => {
    writePenFile('00_first.pen.json', {
      version: '2.11',
      __figma: { pageId: 'p1', pageName: 'first', archiveVersion: 106, sourceFigSha256: 'aa' },
      children: [
        { type: 'frame', id: 'f1', name: 'rootFrame', children: [
          { type: 'text', id: 't1', name: 'hello' },
          { type: 'rectangle', id: 'r1', name: 'box' },
        ]},
      ],
    });
    writePenFile('01_second.pen.json', {
      version: '2.11',
      __figma: { pageId: 'p2', pageName: 'second', archiveVersion: 106, sourceFigSha256: 'bb' },
      children: [{ type: 'frame', id: 'f2', name: 'lone' }],
    });

    const result = generateHtmlDashboard({ extractedDir, outputDir, htmlOutDir, singleFile: false });

    expect(result.singleFile).toBe(false);

    // 1) pen-index.js 파일 생성 + 내용 검증
    const indexPath = join(htmlOutDir, 'data', 'pen-index.js');
    expect(existsSync(indexPath)).toBe(true);
    const indexJs = readFileSync(indexPath, 'utf8');
    // window.PEN_INDEX = JSON.parse('...')
    expect(indexJs).toMatch(/window\.PEN_INDEX/);
    // JSON.parse argument 추출
    const jsonMatch = indexJs.match(/JSON\.parse\('(.*)'\)/s);
    expect(jsonMatch).toBeTruthy();
    const indexData = JSON.parse(jsonMatch![1]!.replace(/\\\\/g, '\\').replace(/\\'/g, "'")) as Array<{
      idx: number; name: string; fileName: string; nodeCount: number; relPath: string; bytes: number;
    }>;
    expect(indexData).toHaveLength(2);
    expect(indexData[0]!.name).toBe('first');
    expect(indexData[0]!.nodeCount).toBe(3); // rootFrame + hello + box
    expect(indexData[1]!.name).toBe('second');
    expect(indexData[1]!.nodeCount).toBe(1);

    // 2) pen-pages/<n>.js 각각 생성
    expect(existsSync(join(htmlOutDir, indexData[0]!.relPath))).toBe(true);
    expect(existsSync(join(htmlOutDir, indexData[1]!.relPath))).toBe(true);

    // 3) index.html에 Pen 탭 존재
    const html = readFileSync(join(htmlOutDir, 'index.html'), 'utf8');
    expect(html).toContain('data-tab="pen"');
    expect(html).toContain('data/pen-index.js');
  });

  it('emits empty PEN_INDEX (=[]) when no 08_pen files exist', () => {
    // 08_pen 비어있음
    const result = generateHtmlDashboard({ extractedDir, outputDir, htmlOutDir, singleFile: false });
    expect(result.singleFile).toBe(false);

    const indexJs = readFileSync(join(htmlOutDir, 'data', 'pen-index.js'), 'utf8');
    const jsonMatch = indexJs.match(/JSON\.parse\('(.*)'\)/s);
    expect(jsonMatch).toBeTruthy();
    const indexData = JSON.parse(jsonMatch![1]!.replace(/\\\\/g, '\\').replace(/\\'/g, "'")) as unknown[];
    expect(indexData).toEqual([]);
  });
});
