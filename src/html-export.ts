/**
 * extracted/ + output/ → 단일 HTML 대시보드 export
 *
 * 출력 구조:
 *   <out>/
 *   ├── index.html
 *   ├── styles.css
 *   ├── app.js
 *   ├── data/
 *   │   ├── overview.js   (window.OVERVIEW)
 *   │   ├── tree.js       (window.NODES_FLAT)
 *   │   ├── schema.js     (window.SCHEMA)
 *   │   └── pages/<n>.js  (window.PAGE)  ← lazy load via <script>
 *   └── assets/
 *       ├── images/*
 *       ├── vectors/*
 *       └── thumbnail.png
 *
 * file:// 프로토콜에서도 동작하도록 모든 데이터는 <script src> 글로벌 주입.
 */

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { renderHtml, renderSingleFileHtml, renderStyles, renderApp } from './html-export-templates.js';
import { buildByteLevelFigBuffer } from './repack.js';

export interface HtmlExportInputs {
  extractedDir: string;
  outputDir: string;     // figma-reverse extract의 output (pages/, assets/)
  htmlOutDir: string;    // dashboard 출력 위치 (--single-file이면 .html 파일 경로)
  /** 모든 데이터·에셋을 단일 .html 파일에 inline (base64 이미지, inline SVG) */
  singleFile?: boolean;
}

export interface HtmlExportResult {
  outDir: string;        // single-file 모드면 단일 파일 경로
  pages: Array<{ index: number; name: string; nodeCount: number; relPath: string }>;
  imagesCopied: number;
  vectorsCopied: number;
  totalBytes: number;
  singleFile: boolean;
}

export function generateHtmlDashboard(inputs: HtmlExportInputs): HtmlExportResult {
  const { extractedDir, outputDir, htmlOutDir, singleFile } = inputs;

  if (!existsSync(extractedDir)) {
    throw new Error(`extracted directory not found: ${extractedDir}`);
  }
  if (!existsSync(outputDir)) {
    throw new Error(`output directory not found: ${outputDir}. Run \`figma-reverse extract\` first.`);
  }

  if (singleFile) {
    return generateSingleFile(extractedDir, outputDir, htmlOutDir);
  }

  // 1. 출력 디렉토리 준비
  mkdirSync(htmlOutDir, { recursive: true });
  mkdirSync(join(htmlOutDir, 'data'), { recursive: true });
  mkdirSync(join(htmlOutDir, 'data', 'pages'), { recursive: true });
  mkdirSync(join(htmlOutDir, 'data', 'pen-pages'), { recursive: true });
  mkdirSync(join(htmlOutDir, 'assets', 'images'), { recursive: true });
  mkdirSync(join(htmlOutDir, 'assets', 'vectors'), { recursive: true });

  let totalBytes = 0;

  // 2. Overview 데이터 — meta.json + 각 stage _info.json + verification stats
  const overview = collectOverview(extractedDir, outputDir);
  totalBytes += writeJsModule(join(htmlOutDir, 'data', 'overview.js'), 'OVERVIEW', overview);

  // 3. Tree 평탄 테이블
  const treePath = join(extractedDir, '05_tree', 'nodes-flat.json');
  const tree = existsSync(treePath) ? JSON.parse(readFileSync(treePath, 'utf8')) : [];
  totalBytes += writeJsModule(join(htmlOutDir, 'data', 'tree.js'), 'NODES_FLAT', tree);

  // 4. Schema (568 정의)
  const schemaPath = join(extractedDir, '04_decoded', 'schema.json');
  const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null;
  totalBytes += writeJsModule(join(htmlOutDir, 'data', 'schema.js'), 'SCHEMA', schema);

  // 5. Pages — 각 페이지별 데이터 lazy load 가능하게 분리
  const pagesDir = join(outputDir, 'pages');
  const pages: HtmlExportResult['pages'] = [];
  if (existsSync(pagesDir)) {
    const files = readdirSync(pagesDir).filter((f) => f.endsWith('.json')).sort();
    files.forEach((file, idx) => {
      const data = JSON.parse(readFileSync(join(pagesDir, file), 'utf8'));
      const safeName = file.replace(/\.json$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      const jsPath = join(htmlOutDir, 'data', 'pages', `${safeName}.js`);
      totalBytes += writeJsModule(jsPath, 'PAGE', data);
      pages.push({
        index: idx,
        name: data.name ?? file,
        nodeCount: countNodes(data),
        relPath: `data/pages/${safeName}.js`,
      });
    });
  }

  // 6. Assets — output/assets/* 복사
  let imagesCopied = 0;
  let vectorsCopied = 0;

  const imagesSrc = join(outputDir, 'assets', 'images');
  if (existsSync(imagesSrc)) {
    for (const f of readdirSync(imagesSrc)) {
      const src = join(imagesSrc, f);
      const dst = join(htmlOutDir, 'assets', 'images', f);
      copyFileSync(src, dst);
      imagesCopied++;
    }
  }

  const vectorsSrc = join(outputDir, 'assets', 'vectors');
  if (existsSync(vectorsSrc)) {
    for (const f of readdirSync(vectorsSrc)) {
      copyFileSync(join(vectorsSrc, f), join(htmlOutDir, 'assets', 'vectors', f));
      vectorsCopied++;
    }
  }

  const thumbSrc = join(outputDir, 'assets', 'thumbnail.png');
  if (existsSync(thumbSrc)) {
    copyFileSync(thumbSrc, join(htmlOutDir, 'assets', 'thumbnail.png'));
  }

  // 7. 페이지 인덱스 (어떤 페이지 파일을 lazy load할지 알려줌)
  totalBytes += writeJsModule(
    join(htmlOutDir, 'data', 'pages-index.js'),
    'PAGES_INDEX',
    pages,
  );

  // 7b. .pen.json 파일들 — 구조화된 뷰를 위해 별도로 lazy-load 가능하게 분리
  const penDir = join(extractedDir, '08_pen');
  const penIndex: Array<{ idx: number; name: string; fileName: string; nodeCount: number; relPath: string; bytes: number }> = [];
  if (existsSync(penDir)) {
    const penFiles = readdirSync(penDir).filter((f) => f.endsWith('.pen.json')).sort();
    penFiles.forEach((file, idx) => {
      const data = JSON.parse(readFileSync(join(penDir, file), 'utf8'));
      const safeName = file.replace(/\.pen\.json$/, '').replace(/[^a-zA-Z0-9_-]/g, '_');
      const jsPath = join(htmlOutDir, 'data', 'pen-pages', `${safeName}.js`);
      const written = writeJsModule(jsPath, 'PEN', data);
      totalBytes += written;
      const nodeCount = countPenNodes(data.children ?? []);
      penIndex.push({
        idx,
        name: data.__figma?.pageName ?? file,
        fileName: file,
        nodeCount,
        relPath: `data/pen-pages/${safeName}.js`,
        bytes: written,
      });
    });
  }
  totalBytes += writeJsModule(
    join(htmlOutDir, 'data', 'pen-index.js'),
    'PEN_INDEX',
    penIndex,
  );

  // 8. 정적 파일 (HTML, CSS, JS)
  totalBytes += writeFile(join(htmlOutDir, 'index.html'), renderHtml());
  totalBytes += writeFile(join(htmlOutDir, 'styles.css'), renderStyles());
  totalBytes += writeFile(join(htmlOutDir, 'app.js'), renderApp());

  return {
    outDir: htmlOutDir,
    pages,
    imagesCopied,
    vectorsCopied,
    totalBytes,
    singleFile: false,
  };
}

// ─── Single-file generator ──────────────────────────────────────────────

function generateSingleFile(
  extractedDir: string,
  outputDir: string,
  outPath: string,
): HtmlExportResult {
  const overview = collectOverview(extractedDir, outputDir);

  const treePath = join(extractedDir, '05_tree', 'nodes-flat.json');
  const tree = existsSync(treePath) ? JSON.parse(readFileSync(treePath, 'utf8')) : [];

  const schemaPath = join(extractedDir, '04_decoded', 'schema.json');
  const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null;

  // 페이지: raw 중 렌더러가 사용하지 않는 필드 제거 → 사이즈 축소
  const pagesDir = join(outputDir, 'pages');
  const pages: Array<{ index: number; name: string; nodeCount: number; data: unknown }> = [];
  if (existsSync(pagesDir)) {
    const files = readdirSync(pagesDir).filter((f) => f.endsWith('.json')).sort();
    files.forEach((file, idx) => {
      const data = JSON.parse(readFileSync(join(pagesDir, file), 'utf8'));
      const stripped = stripPageForRenderer(data);
      pages.push({
        index: idx,
        name: data.name ?? file,
        nodeCount: countNodes(data),
        data: stripped,
      });
    });
  }

  // 이미지 → base64 data URI
  const images: Record<string, string> = {};
  let imagesCopied = 0;
  const imagesSrc = join(outputDir, 'assets', 'images');
  if (existsSync(imagesSrc)) {
    for (const f of readdirSync(imagesSrc).sort()) {
      const dot = f.lastIndexOf('.');
      if (dot <= 0) continue;
      const hash = f.slice(0, dot);
      const ext = f.slice(dot + 1);
      const mime = mimeFromExt(ext);
      const buf = readFileSync(join(imagesSrc, f));
      images[hash] = `data:${mime};base64,${buf.toString('base64')}`;
      imagesCopied++;
    }
  }

  // 썸네일
  let thumbnailDataUri: string | null = null;
  const thumbPath = join(outputDir, 'assets', 'thumbnail.png');
  if (existsSync(thumbPath)) {
    thumbnailDataUri = `data:image/png;base64,${readFileSync(thumbPath).toString('base64')}`;
  }

  // SVG → 인라인 (raw string)
  const vectors: Record<string, string> = {};
  let vectorsCopied = 0;
  const vectorsSrc = join(outputDir, 'assets', 'vectors');
  if (existsSync(vectorsSrc)) {
    for (const f of readdirSync(vectorsSrc).sort()) {
      const id = f.replace(/\.svg$/, '');
      vectors[id] = readFileSync(join(vectorsSrc, f), 'utf8');
      vectorsCopied++;
    }
  }

  // 페이지 인덱스 (data 별로)
  const pagesIndex = pages.map((p) => ({
    index: p.index,
    name: p.name,
    nodeCount: p.nodeCount,
  }));

  // 단일 HTML 생성
  const html = renderSingleFileHtml({
    overview,
    tree,
    schema,
    pages: pages.map((p) => p.data),
    pagesIndex,
    images,
    vectors,
    thumbnailDataUri,
  });

  const buf = new TextEncoder().encode(html);

  // outPath가 디렉토리면 그 안에 dashboard.html 생성, 아니면 그대로 사용
  let finalPath = outPath;
  if (outPath.endsWith('/') || (existsSync(outPath) && statSync(outPath).isDirectory())) {
    finalPath = join(outPath, 'dashboard.html');
  } else if (!outPath.endsWith('.html')) {
    finalPath = `${outPath}.html`;
  }

  // 부모 디렉토리 보장
  const dir = dirname(finalPath);
  if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });

  writeFileSync(finalPath, buf);

  return {
    outDir: finalPath,
    pages: pagesIndex.map((p) => ({ ...p, relPath: '(inline)' })),
    imagesCopied,
    vectorsCopied,
    totalBytes: buf.byteLength,
    singleFile: true,
  };
}

/** 렌더러가 사용하지 않는 raw 필드를 제거해 페이지 데이터 사이즈 축소 */
function stripPageForRenderer(node: unknown): unknown {
  if (!node || typeof node !== 'object') return null;
  const n = node as Record<string, unknown>;
  const out: Record<string, unknown> = {
    id: n.id,
    type: n.type,
    name: n.name,
  };
  if (n.absoluteBoundingBox) out.absoluteBoundingBox = n.absoluteBoundingBox;
  if (n.fills) out.fills = n.fills;
  if (n.strokes) out.strokes = n.strokes;

  const r = n.raw as Record<string, unknown> | undefined;
  if (r && typeof r === 'object') {
    const rawOut: Record<string, unknown> = {};
    if (r.fillPaints) rawOut.fillPaints = r.fillPaints;
    if (r.strokePaints) rawOut.strokePaints = r.strokePaints;
    if (r.cornerRadius != null) rawOut.cornerRadius = r.cornerRadius;
    if (r.fontSize != null) rawOut.fontSize = r.fontSize;
    if (typeof r.characters === 'string') rawOut.characters = r.characters;
    if (r.textData && typeof r.textData === 'object') {
      const td = r.textData as Record<string, unknown>;
      const tdOut: Record<string, unknown> = {};
      if (typeof td.characters === 'string') tdOut.characters = td.characters;
      if (td.fontSize != null) tdOut.fontSize = td.fontSize;
      if (Object.keys(tdOut).length > 0) rawOut.textData = tdOut;
    }
    if (Object.keys(rawOut).length > 0) out.raw = rawOut;
  }

  const children = n.children;
  if (Array.isArray(children) && children.length > 0) {
    const stripped = children.map((c) => stripPageForRenderer(c)).filter((x): x is Record<string, unknown> => x !== null);
    if (stripped.length > 0) out.children = stripped;
  }
  return out;
}

function mimeFromExt(ext: string): string {
  switch (ext.toLowerCase()) {
    case 'png': return 'image/png';
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'svg': return 'image/svg+xml';
    case 'pdf': return 'application/pdf';
    default: return 'application/octet-stream';
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function writeFile(path: string, content: string): number {
  const buf = new TextEncoder().encode(content);
  writeFileSync(path, buf);
  return buf.byteLength;
}

function writeJsModule(path: string, globalName: string, data: unknown): number {
  // window.<globalName> = JSON.parse('...');  ← stringify+JSON.parse가 큰 데이터에서 빠름
  const json = JSON.stringify(data ?? null);
  // backslash, single quote 이스케이프
  const escaped = json.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  const content = `window.${globalName} = JSON.parse('${escaped}');\n`;
  return writeFile(path, content);
}

function countNodes(node: unknown): number {
  if (!node || typeof node !== 'object') return 0;
  let n = 1;
  const children = (node as { children?: unknown[] }).children;
  if (Array.isArray(children)) {
    for (const c of children) n += countNodes(c);
  }
  return n;
}

function countPenNodes(nodes: unknown[]): number {
  let n = 0;
  for (const x of nodes) {
    if (!x || typeof x !== 'object') continue;
    n++;
    const kids = (x as { children?: unknown[] }).children;
    if (Array.isArray(kids)) n += countPenNodes(kids);
  }
  return n;
}

interface Overview {
  generator: string;
  generatedAt: string;
  fileName: string | null;
  backgroundColor: { r: number; g: number; b: number; a: number } | null;
  renderCoords: { x: number; y: number; width: number; height: number } | null;
  exportedAt: string | null;
  archive: { version: number | null; isZipWrapped: boolean | null; schemaCompression: string | null; dataCompression: string | null };
  totals: {
    nodes: number;
    pages: number;
    images: number;
    vectors: number;
    schemaDefinitions: number;
  };
  pages: Array<{ id: string; name: string; topLevelChildren: number }>;
  typeDistribution: Record<string, number>;
  /** Assets 탭 갤러리용 — output/assets/images/<hash>.<ext> 파일 목록 */
  imageHashes: Array<{ hash: string; ext: string }>;
  thumbnail: boolean;
  verification: Array<{ id: string; name: string; status: string; detail: string }> | null;
}

function collectOverview(extractedDir: string, outputDir: string): Overview {
  const o: Overview = {
    generator: 'figma-reverse v0.1.0',
    generatedAt: new Date().toISOString(),
    fileName: null,
    backgroundColor: null,
    renderCoords: null,
    exportedAt: null,
    archive: { version: null, isZipWrapped: null, schemaCompression: null, dataCompression: null },
    totals: { nodes: 0, pages: 0, images: 0, vectors: 0, schemaDefinitions: 0 },
    pages: [],
    typeDistribution: {},
    imageHashes: [],
    thumbnail: false,
    verification: null,
  };

  // 01_container/_info.json + meta.json
  const c1 = readJsonSafe(join(extractedDir, '01_container', '_info.json'));
  if (c1) {
    o.archive.isZipWrapped = c1.isZipWrapped ?? null;
    o.totals.images = c1.images?.count ?? 0;
  }
  const meta = readJsonSafe(join(extractedDir, '01_container', 'meta.json'));
  if (meta) {
    o.fileName = meta.file_name ?? null;
    o.backgroundColor = meta.client_meta?.background_color ?? null;
    o.renderCoords = meta.client_meta?.render_coordinates ?? null;
    o.exportedAt = meta.exported_at ?? null;
  }

  // 02_archive
  const c2 = readJsonSafe(join(extractedDir, '02_archive', '_info.json'));
  if (c2) o.archive.version = c2.version ?? null;

  // 03_decompressed
  const c3 = readJsonSafe(join(extractedDir, '03_decompressed', '_info.json'));
  if (c3) {
    o.archive.schemaCompression = c3.schema?.compression ?? null;
    o.archive.dataCompression = c3.data?.compression ?? null;
  }

  // 04_decoded
  const c4 = readJsonSafe(join(extractedDir, '04_decoded', '_info.json'));
  if (c4) o.totals.schemaDefinitions = c4.schemaDefinitionCount ?? 0;

  // 05_tree
  const c5 = readJsonSafe(join(extractedDir, '05_tree', '_info.json'));
  if (c5) {
    o.totals.nodes = c5.totalNodes ?? 0;
    o.totals.pages = c5.pageCount ?? 0;
    o.pages = c5.pages ?? [];
    o.typeDistribution = c5.typeDistribution ?? {};
  }

  // assets/vectors 디렉토리에 있는 파일 수
  const vectorsDir = join(outputDir, 'assets', 'vectors');
  if (existsSync(vectorsDir)) {
    o.totals.vectors = readdirSync(vectorsDir).filter((f) => f.endsWith('.svg')).length;
  }

  // assets/images — Assets 탭 갤러리용
  const imagesDir = join(outputDir, 'assets', 'images');
  if (existsSync(imagesDir)) {
    for (const f of readdirSync(imagesDir).sort()) {
      const dot = f.lastIndexOf('.');
      if (dot > 0) {
        o.imageHashes.push({ hash: f.slice(0, dot), ext: f.slice(dot + 1) });
      }
    }
  }
  o.thumbnail = existsSync(join(outputDir, 'assets', 'thumbnail.png'));

  // verification report 파싱 (markdown 표 → 구조화)
  const verifyPath = join(outputDir, 'verification_report.md');
  if (existsSync(verifyPath)) {
    o.verification = parseVerifyReport(readFileSync(verifyPath, 'utf8'));
  }

  return o;
}

function readJsonSafe(path: string): Record<string, any> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

function parseVerifyReport(md: string): Array<{ id: string; name: string; status: string; detail: string }> {
  const out: Array<{ id: string; name: string; status: string; detail: string }> = [];
  // 표 라인: | V-XX | name | status | detail |
  for (const line of md.split('\n')) {
    const m = line.match(/^\| (V-\d+) \| ([^|]+) \| ([^|]+) \| (.+) \|$/);
    if (m) {
      out.push({
        id: m[1]!.trim(),
        name: m[2]!.trim(),
        status: m[3]!.trim(),
        detail: m[4]!.trim(),
      });
    }
  }
  return out;
}

// ─── Round-trip HTML ────────────────────────────────────────────────────

import { renderRoundTripHtml } from './html-export-templates.js';

export interface RoundTripInputs {
  extractedDir: string;
  outputDir: string;
  /** 출력 .html 파일 경로 (default: extractedDir/06_report/figma-round-trip.html) */
  htmlOutPath?: string;
}

export interface RoundTripResult {
  outPath: string;
  htmlBytes: number;
  /** 디스크에도 떨어뜨린 .fig 경로 (06_report/<figName>.fig) */
  figFilePath: string;
  figBytes: number;       // .fig 사이즈 (HTML embed + disk 동일)
  figSha256: string;
  pages: number;
  images: number;
  vectors: number;
}

/**
 * "Round-trip HTML" 단일 파일:
 *   - dashboard 시각 미리보기 + 메타 (Pages/Tree/Assets/Schema/Verify 탭)
 *   - 원본 .fig를 byte-level로 재패키징 → base64로 inline embed
 *   - 헤더에 "Download .fig" 버튼: 클릭하면 임베드 데이터를 Blob으로 다운로드
 *   - 즉 이 HTML 한 파일만으로 (1) Figma처럼 보기 + (2) .fig 추출 가능
 */
export async function generateRoundTripHtml(inputs: RoundTripInputs): Promise<RoundTripResult> {
  const { extractedDir, outputDir } = inputs;

  if (!existsSync(extractedDir)) {
    throw new Error(`extracted directory not found: ${extractedDir}`);
  }
  if (!existsSync(outputDir)) {
    throw new Error(`output directory not found: ${outputDir}. Run \`figma-reverse extract\` first.`);
  }

  // 기본 경로: extracted/06_report/figma-round-trip.html
  const outPath =
    inputs.htmlOutPath ?? join(extractedDir, '06_report', 'figma-round-trip.html');

  // 1. .fig 바이트 (byte-level repack — 원본과 byte-identical)
  const { buffer: figBytes } = await buildByteLevelFigBuffer(extractedDir);
  const figBase64 = Buffer.from(figBytes).toString('base64');
  const figSha256 = createHash('sha256').update(figBytes).digest('hex');

  // 2. dashboard 데이터 수집 (single-file과 동일한 절차)
  const overview = collectOverview(extractedDir, outputDir);
  const treePath = join(extractedDir, '05_tree', 'nodes-flat.json');
  const tree = existsSync(treePath) ? JSON.parse(readFileSync(treePath, 'utf8')) : [];
  const schemaPath = join(extractedDir, '04_decoded', 'schema.json');
  const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, 'utf8')) : null;

  const pagesDir = join(outputDir, 'pages');
  const pages: unknown[] = [];
  const pagesIndex: Array<{ index: number; name: string; nodeCount: number }> = [];
  if (existsSync(pagesDir)) {
    const files = readdirSync(pagesDir).filter((f) => f.endsWith('.json')).sort();
    files.forEach((file, idx) => {
      const data = JSON.parse(readFileSync(join(pagesDir, file), 'utf8'));
      const stripped = stripPageForRenderer(data);
      pages.push(stripped);
      pagesIndex.push({
        index: idx,
        name: data.name ?? file,
        nodeCount: countNodes(data),
      });
    });
  }

  // 이미지 → base64
  const images: Record<string, string> = {};
  let imagesCount = 0;
  const imagesSrc = join(outputDir, 'assets', 'images');
  if (existsSync(imagesSrc)) {
    for (const f of readdirSync(imagesSrc).sort()) {
      const dot = f.lastIndexOf('.');
      if (dot <= 0) continue;
      const hash = f.slice(0, dot);
      const ext = f.slice(dot + 1);
      const buf = readFileSync(join(imagesSrc, f));
      images[hash] = `data:${mimeFromExt(ext)};base64,${buf.toString('base64')}`;
      imagesCount++;
    }
  }

  // 썸네일
  let thumbnailDataUri: string | null = null;
  const thumbPath = join(outputDir, 'assets', 'thumbnail.png');
  if (existsSync(thumbPath)) {
    thumbnailDataUri = `data:image/png;base64,${readFileSync(thumbPath).toString('base64')}`;
  }

  // SVG inline
  const vectors: Record<string, string> = {};
  let vectorsCount = 0;
  const vectorsSrc = join(outputDir, 'assets', 'vectors');
  if (existsSync(vectorsSrc)) {
    for (const f of readdirSync(vectorsSrc).sort()) {
      const id = f.replace(/\.svg$/, '');
      vectors[id] = readFileSync(join(vectorsSrc, f), 'utf8');
      vectorsCount++;
    }
  }

  // 3. HTML 렌더
  const html = renderRoundTripHtml({
    overview,
    tree,
    schema,
    pages,
    pagesIndex,
    images,
    vectors,
    thumbnailDataUri,
    figBase64,
    figBytes: figBytes.byteLength,
    figSha256,
    figFileName: deriveFigFileName(overview),
  });

  const buf = new TextEncoder().encode(html);

  ensureDir(dirname(outPath));
  writeFileSync(outPath, buf);

  // ★ .fig 파일도 디스크에 함께 출력 (06_report/<figName>.fig)
  // 사용자가 브라우저 다운로드 버튼 안 눌러도 즉시 Figma에 import 가능
  const figFileName = deriveFigFileName(overview);
  const figFilePath = join(dirname(outPath), figFileName);
  writeFileSync(figFilePath, figBytes);

  return {
    outPath,
    htmlBytes: buf.byteLength,
    figFilePath,
    figBytes: figBytes.byteLength,
    figSha256,
    pages: pages.length,
    images: imagesCount,
    vectors: vectorsCount,
  };
}

function ensureDir(d: string): void {
  mkdirSync(d, { recursive: true });
}

function deriveFigFileName(overview: unknown): string {
  const o = overview as { fileName?: string };
  const base = o.fileName?.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 80) || 'design';
  return `${base}.fig`;
}
