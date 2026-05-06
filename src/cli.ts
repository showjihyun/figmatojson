#!/usr/bin/env node
/**
 * figma-reverse CLI 진입점 (PRD §5.2)
 *
 * 사용법:
 *   npx tsx src/cli.ts <input.fig> [output-dir]
 *   npm run extract      # PRD 첨부 파일 + output/
 */

import { existsSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { collectImageRefs } from './assets.js';
import { loadContainer } from './container.js';
import { decodeFigCanvas } from './decoder.js';
import { exportAll } from './export.js';
import { createHash } from 'node:crypto';
import { generateEditableHtml } from './editable-html.js';
import { generateHtmlDashboard, generateRoundTripHtml } from './html-export.js';
import { generatePenExport } from './pen-export.js';
import { buildByteLevelFigBuffer } from './repack.js';
import { extractTokens, formatTokens, type TokenFormat } from './tokens.js';
import {
  dumpStage1Container,
  dumpStage2Archive,
  dumpStage3Decompressed,
  dumpStage4Decoded,
  dumpStage5Tree,
} from './intermediate.js';
import { repack, type RepackMode } from './repack.js';
import { buildTree } from './tree.js';
import { runVerification } from './verify.js';

interface CliOptions {
  input: string;
  outputDir: string;
  /** 중간 산출물 디렉토리 (default: <output-dir 옆>/extracted) */
  extractedDir: string;
  minify: boolean;
  /** document.json (전체 트리 단일 파일) 생략. pages/*만 출력. */
  noDocument: boolean;
  /** 04_decoded/message.json (full kiwi-decoded message) 포함. 매우 큼. */
  includeRawMessage: boolean;
  /** 벡터 추출 skip. */
  noVector: boolean;
  /** 중간 산출물 dump 비활성화 */
  noIntermediate: boolean;
}

function parseExtractArgs(args: string[]): CliOptions {
  const opts: CliOptions = {
    input: '',
    outputDir: 'output',
    extractedDir: '',
    minify: false,
    noDocument: false,
    includeRawMessage: false,
    noVector: false,
    noIntermediate: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--minify':
        opts.minify = true;
        break;
      case '--no-document':
        opts.noDocument = true;
        break;
      case '--include-raw-message':
        opts.includeRawMessage = true;
        break;
      case '--no-vector':
        opts.noVector = true;
        break;
      case '--no-intermediate':
        opts.noIntermediate = true;
        break;
      case '--extracted-dir':
        opts.extractedDir = args[++i] ?? fatal('--extracted-dir requires a path');
        break;
      case '--verbose':
        // main().catch에서만 사용 — argv에서 직접 검사. 여기서는 silently 받기.
        break;
      default:
        if (a.startsWith('--')) {
          fatal(`unknown flag: ${a}`);
        }
        positional.push(a);
    }
  }
  if (positional.length === 0) fatal('missing input file');
  opts.input = positional[0]!;
  // 사용자 지정 outputDir이 있으면 그대로, 없으면 output/<figName> default
  const figName = figFileSlug(opts.input);
  if (positional[1]) {
    opts.outputDir = positional[1];
  } else {
    opts.outputDir = join('output', figName);
  }
  // extracted dir 기본값: <root>/extracted/<figName>
  if (!opts.extractedDir) {
    // output 경로가 명시적이면 그 부모 옆에 extracted, 아니면 cwd 옆에
    const root =
      opts.outputDir === join('output', figName)
        ? '.'
        : dirname(resolve(opts.outputDir));
    opts.extractedDir = join(root, 'extracted', figName);
  }
  return opts;
}

/** .fig 파일 경로 → 안전한 디렉토리 이름 (예: "메타리치 화면 UI Design.fig" → "메타리치 화면 UI Design") */
function figFileSlug(figPath: string): string {
  const base = basename(figPath);
  const noExt = base.replace(/\.fig$/i, '');
  // 파일 시스템 안전 문자만 (공백·한글 OK, 제어문자·예약문자 _로)
  return noExt.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').slice(0, 120) || 'design';
}

function printHelp(): void {
  process.stdout.write(`figma-reverse v0.1.0 — .fig file ⇄ structured JSON + assets

Usage:
  figma-reverse extract <input.fig> [output-dir] [options]
  figma-reverse repack  <extracted-dir> <out.fig> [options]
  figma-reverse <input.fig> [output-dir] [options]   # extract (default)

Subcommand: extract — .fig → JSON + assets
  Arguments:
    <input.fig>            .fig 파일 (ZIP-wrapped 또는 raw fig-kiwi 자동 분기)
    [output-dir]           출력 디렉토리 (default: ./output/<figName>, 여러 .fig 처리 시 자동 분리)
  Options:
    --minify               JSON 들여쓰기 제거
    --no-document          document.json 생략 (pages/*만)
    --include-raw-message  extracted/04_decoded/message.json 포함 (매우 큼)
    --no-vector            벡터 SVG 추출 skip
    --no-intermediate      extracted/ 중간 산출물 dump 비활성화
    --extracted-dir <path> 중간 산출물 디렉토리 (default: ./extracted)

Subcommand: repack — extracted/ → .fig 재생성
  Arguments:
    <extracted-dir>        extract가 생성한 디렉토리 (e.g. ./extracted)
    <out.fig>              생성할 .fig 경로
  Options:
    --mode byte|kiwi|json  (default: byte)
                           byte: 01_container/의 raw 파일 그대로 ZIP 묶기 (안전)
                           kiwi: kiwi 메시지 재인코드 + deflate-raw 압축 (binary roundtrip)
                           json: 04_decoded/message.json (편집된 JSON) → kiwi 인코드 → .fig
                                 (extract 시 --include-raw-message 필요)
    --original <orig.fig>  원본과 round-trip 비교 (선택)

Subcommand: html-report — extracted/ + output/ → 대화형 HTML 대시보드
  Arguments:
    <extracted-dir>        extract가 생성한 디렉토리 (e.g. ./extracted)
    [html-out-dir]         대시보드 출력 위치 (default: ./dashboard, --single-file 시 ./dashboard.html)
  Options:
    --single-file          단일 .html 파일에 모든 데이터·이미지·SVG inline (~16-21 MB)
    --output <path>        figma-reverse extract output 디렉토리 (default: ./output)
    --html-out <path>      [html-out-dir]과 동일

Subcommand: round-trip-html — Round-trip HTML (.fig 임베드 + 시각 미리보기) [DEPRECATED]
  ⚠️  editable-html --single-file로 통합되었습니다.
  Arguments:
    <extracted-dir>        extract가 생성한 디렉토리
    [out.html]             출력 .html (default: <extracted-dir>/06_report/figma-round-trip.html)
  Options:
    --output <path>        figma-reverse extract output 디렉토리 (default: ./output)

Subcommand: pen-export — Pencil .pen 형식 호환 단순 JSON
  Arguments:
    <input.fig>            .fig 파일
    [out-dir]              출력 디렉토리 (default: extracted/<figName>/08_pen)
  설명: 페이지별 <idx>_<page>.pen.json 생성. 4 노드 타입 (frame/text/path/rectangle),
        hex fill, SVG path geometry, auto-layout 직접 표현.
        편집 시 가장 직관적. round-trip은 sidecar 메타와 결합.

Subcommand: tokens — 디자인 토큰 추출 (color / typography / effect styles)
  Arguments:
    <input.fig>            .fig 파일
  Options:
    --format json|css|js|ts  출력 포맷 (default: json)
    --out <path>             파일 저장 (생략 시 stdout)
  설명: Figma 의 published styles 을 schemaVersion 1 의 Tokens shape 으로 추출.
        FILL → colors, TEXT → typography, EFFECT → effects. v1 spacing 미지원,
        variables (modes) 는 default mode 로 resolve. spec: docs/specs/tokens.spec.md.

Examples:
  figma-reverse extract design.fig
  figma-reverse extract "/path/to/My Design.fig" ./out --minify

  figma-reverse repack ./extracted ./repacked.fig
  figma-reverse repack ./extracted ./repacked.fig --mode kiwi --original design.fig

  figma-reverse html-report ./extracted ./dashboard
  figma-reverse html-report ./extracted ./report.html --single-file

  figma-reverse round-trip-html ./extracted
  -h, --help                 이 도움말

npm scripts:
  npm run extract -- design.fig
  npm run extract:sample           # 첨부 메타리치 파일

Final output (<output-dir>/):
  document.json, pages/*, assets/images/*, assets/vectors/*, schema.json,
  metadata.json, manifest.json, verification_report.md

Intermediate breadcrumbs (<extracted-dir>/):
  01_container/, 02_archive/, 03_decompressed/, 04_decoded/, 05_tree/
  각 단계에 _info.json (sha256, sizes, magic bytes 등)
`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
    printHelp();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const cmd = argv[0]!;
  if (cmd === 'repack') {
    return runRepack(argv.slice(1));
  }
  if (cmd === 'extract') {
    return runExtract(argv.slice(1));
  }
  if (cmd === 'html-report') {
    return runHtmlReport(argv.slice(1));
  }
  if (cmd === 'round-trip-html') {
    return runRoundTripHtml(argv.slice(1));
  }
  if (cmd === 'editable-html') {
    return runEditableHtml(argv.slice(1));
  }
  if (cmd === 'pen-export') {
    return runPenExport(argv.slice(1));
  }
  if (cmd === 'tokens') {
    return runTokens(argv.slice(1));
  }
  // backwards-compat: 첫 인자가 .fig면 extract로 간주
  return runExtract(argv);
}

async function runExtract(args: string[]): Promise<void> {
  const opts = parseExtractArgs(args);
  const inputPath = resolve(opts.input);
  const outputDir = resolve(opts.outputDir);
  const extractedDir = resolve(opts.extractedDir);

  if (!existsSync(inputPath)) {
    fatal(`Input file not found: ${inputPath}`);
  }
  const inputSize = statSync(inputPath).size;

  const intOpts = {
    enabled: !opts.noIntermediate,
    dir: extractedDir,
    includeFullMessage: opts.includeRawMessage,
    minify: opts.minify,
  };

  log(`▶ figma-reverse v0.1.0`);
  log(`  input     : ${inputPath} (${formatBytes(inputSize)})`);
  log(`  output    : ${outputDir}`);
  if (intOpts.enabled) log(`  extracted : ${extractedDir}`);
  log('');

  // ─── Iteration 1: Container ─────────────────────────────────────────────
  log('[1/6] 컨테이너 분해...');
  const container = loadContainer(inputPath);
  log(
    `      ZIP-wrapped: ${container.isZipWrapped} | canvas.fig: ${formatBytes(
      container.canvasFig.byteLength,
    )} | images: ${container.images.size}`,
  );
  const stage1 = dumpStage1Container(intOpts, container);
  if (stage1) log(`      → extracted/01_container/ (${stage1.files.length} files)`);

  // ─── Iteration 2-4: Decode ──────────────────────────────────────────────
  log('[2/6] Kiwi 디코드 (archive → schema → message)...');
  const decoded = decodeFigCanvas(container.canvasFig);
  log(
    `      archive v${decoded.archiveVersion} | schema defs: ${decoded.schemaStats.definitionCount} | message type: ${decoded.message.type ?? '(unknown)'}`,
  );
  const stage2 = dumpStage2Archive(intOpts, decoded.archive);
  const stage3 = dumpStage3Decompressed(intOpts, decoded);
  const stage4 = dumpStage4Decoded(intOpts, decoded);
  if (stage2) log(`      → extracted/02_archive/ (${stage2.files.length} files)`);
  if (stage3) log(`      → extracted/03_decompressed/ (${stage3.files.length} files)`);
  if (stage4) log(`      → extracted/04_decoded/ (${stage4.files.length} files)`);

  // ─── Iteration 5: Tree ──────────────────────────────────────────────────
  log('[3/6] 노드 트리 재구성...');
  const tree = buildTree(decoded.message);
  const pageCount = tree.document?.children.filter((c) => c.type === 'CANVAS').length ?? 0;
  log(
    `      total nodes: ${tree.allNodes.size} | pages: ${pageCount} | orphans: ${tree.orphans.length}`,
  );
  const stage5 = dumpStage5Tree(intOpts, tree);
  if (stage5) log(`      → extracted/05_tree/ (${stage5.files.length} files)`);

  // ─── Iteration 6: Image refs ────────────────────────────────────────────
  log('[4/6] 이미지 참조 매핑...');
  const imageRefs = collectImageRefs(tree.document);
  log(`      unique image refs: ${imageRefs.size} (vs ${container.images.size} on disk)`);

  // ─── Iteration 7-9: Export ──────────────────────────────────────────────
  log('[5/6] 산출물 export...');
  const artifacts = await exportAll({
    outputDir,
    container,
    decoded,
    tree,
    imageRefs,
    options: {
      minify: opts.minify,
      includeDocument: !opts.noDocument,
      // raw message는 이제 extracted/04_decoded/로 이동했으므로 output에는 더 이상 출력 안함
      includeRawMessage: false,
      extractVectors: !opts.noVector,
    },
  });
  log(`      ${artifacts.files.length} files written`);

  // ─── Verification ───────────────────────────────────────────────────────
  log('[6/6] 검증 보고서 생성...');
  const verify = runVerification({
    outputDir,
    container,
    decoded,
    tree,
    imageRefs,
    artifacts,
  });
  log('');
  log(`Verification: ${badge(verify.overall)}`);
  for (const c of verify.checks) {
    log(`  ${badge(c.status)} ${c.id} ${c.name}: ${c.detail}`);
  }
  log('');
  log(`Done. Output: ${outputDir}`);
  if (intOpts.enabled) log(`      Intermediates: ${extractedDir}`);
  log(`      Report: ${verify.reportPath}`);

  if (verify.overall === 'FAIL') process.exit(2);
}

interface RepackCliOptions {
  extractedDir: string;
  outFig: string;
  mode: RepackMode;
  originalFig?: string;
}

function parseRepackArgs(args: string[]): RepackCliOptions {
  // -h / --help → help + exit 0
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }
  // 인자 0개 → 명시적 에러 + help + exit 1
  if (args.length === 0) {
    process.stderr.write(
      'error: repack requires <extracted-dir> <out.fig>\n\n',
    );
    printHelp();
    process.exit(1);
  }
  const opts: RepackCliOptions = {
    extractedDir: '',
    outFig: '',
    mode: 'byte',
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--mode': {
        const m = args[++i];
        if (m !== 'byte' && m !== 'kiwi' && m !== 'json') {
          fatal(`--mode must be 'byte', 'kiwi', or 'json' (got: ${m ?? '(missing)'})`);
        }
        opts.mode = m as RepackMode;
        break;
      }
      case '--original':
        opts.originalFig = args[++i] ?? fatal('--original requires a path');
        break;
      case '--verbose':
        // main().catch에서만 사용
        break;
      default:
        if (a.startsWith('--')) fatal(`unknown flag: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length < 2) {
    fatal('repack requires <extracted-dir> <out.fig>');
  }
  opts.extractedDir = positional[0]!;
  opts.outFig = positional[1]!;
  return opts;
}

async function runRepack(args: string[]): Promise<void> {
  const opts = parseRepackArgs(args);
  const extractedDir = resolve(opts.extractedDir);
  const outPath = resolve(opts.outFig);
  const originalFig = opts.originalFig ? resolve(opts.originalFig) : undefined;

  if (!existsSync(extractedDir)) {
    fatal(`extracted directory not found: ${extractedDir}`);
  }
  if (originalFig && !existsSync(originalFig)) {
    fatal(`original .fig not found: ${originalFig}`);
  }

  log(`▶ figma-reverse repack`);
  log(`  mode      : ${opts.mode}`);
  log(`  extracted : ${extractedDir}`);
  log(`  output    : ${outPath}`);
  if (originalFig) log(`  compare   : ${originalFig}`);
  log('');

  const result = await repack(extractedDir, outPath, {
    mode: opts.mode,
    originalFig,
  });

  log(`▶ Repack 완료`);
  log(`  out: ${result.outPath} (${formatBytes(result.outBytes)})`);
  log(`  sha256: ${result.outSha256}`);
  log(`  files: ${result.files.length}`);
  log('');

  // Round-trip 검증
  if (!result.verify.extracted) {
    log(`🔴 Round-trip FAIL: ${result.verify.error ?? 'unknown'}`);
    process.exit(2);
  }
  log(`🟢 Round-trip: 우리 파서로 재추출 성공`);
  log(
    `   archive v${result.verify.archiveVersion} | schema defs: ${result.verify.schemaDefCount} | nodes: ${result.verify.nodeChangesCount} | blobs: ${result.verify.blobsCount} | type: ${result.verify.rootMessageType}`,
  );

  if (result.comparison) {
    log('');
    log(`▶ 원본 비교`);
    const c = result.comparison;
    const checks: Array<[string, boolean, string]> = [
      [
        '노드 수',
        c.nodeCountMatch,
        `${result.verify.nodeChangesCount} vs ${c.originalNodeCount}`,
      ],
      [
        '스키마 정의 수',
        c.schemaDefCountMatch,
        `${result.verify.schemaDefCount} vs ${c.originalSchemaDefCount}`,
      ],
      [
        'archive version',
        c.archiveVersionMatch,
        `${result.verify.archiveVersion} vs ${c.originalArchiveVersion}`,
      ],
    ];
    if (typeof c.canvasFigBytesIdentical === 'boolean') {
      checks.push([
        'canvas.fig byte 동일',
        c.canvasFigBytesIdentical,
        c.canvasFigBytesIdentical ? '✓ 1:1 보존' : '✗ 차이 있음',
      ]);
    }
    let allOk = true;
    for (const [name, ok, detail] of checks) {
      log(`  ${ok ? '🟢' : '🔴'} ${name}: ${detail}`);
      if (!ok) allOk = false;
    }
    log('');
    log(allOk ? '🟢 원본과 의미적 동등 확인' : '🔴 차이 발견 — verify report 확인');
    if (!allOk) process.exit(2);
  }
}

interface HtmlReportCliOptions {
  extractedDir: string;
  outputDir: string;
  htmlOutDir: string;
  singleFile: boolean;
}

function parseHtmlReportArgs(args: string[]): HtmlReportCliOptions {
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }
  if (args.length === 0) {
    process.stderr.write('error: html-report requires <extracted-dir>\n\n');
    printHelp();
    process.exit(1);
  }
  const opts: HtmlReportCliOptions = {
    extractedDir: '',
    outputDir: 'output',
    htmlOutDir: 'dashboard',
    singleFile: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--output':
        opts.outputDir = args[++i] ?? fatal('--output requires a path');
        break;
      case '--html-out':
        opts.htmlOutDir = args[++i] ?? fatal('--html-out requires a path');
        break;
      case '--single-file':
        opts.singleFile = true;
        // 단일 파일이면 default 출력을 dashboard.html로
        if (opts.htmlOutDir === 'dashboard') opts.htmlOutDir = 'dashboard.html';
        break;
      case '--verbose':
        break;
      default:
        if (a.startsWith('--')) fatal(`unknown flag: ${a}`);
        positional.push(a);
    }
  }
  if (positional.length === 0) fatal('html-report requires <extracted-dir>');
  opts.extractedDir = positional[0]!;
  if (positional[1]) opts.htmlOutDir = positional[1];
  return opts;
}

async function runHtmlReport(args: string[]): Promise<void> {
  const opts = parseHtmlReportArgs(args);
  const extractedDir = resolve(opts.extractedDir);
  const outputDir = resolve(opts.outputDir);
  const htmlOutDir = resolve(opts.htmlOutDir);

  if (!existsSync(extractedDir)) {
    fatal(`extracted directory not found: ${extractedDir}`);
  }
  if (!existsSync(outputDir)) {
    fatal(
      `output directory not found: ${outputDir}\n` +
        `Run \`figma-reverse extract\` first or pass --output <path>.`,
    );
  }

  log(`▶ figma-reverse html-report${opts.singleFile ? ' (single-file)' : ''}`);
  log(`  extracted : ${extractedDir}`);
  log(`  output    : ${outputDir}`);
  log(`  ${opts.singleFile ? 'html-file' : 'dashboard'} : ${htmlOutDir}`);
  log('');

  const result = generateHtmlDashboard({
    extractedDir,
    outputDir,
    htmlOutDir,
    singleFile: opts.singleFile,
  });

  log(`🟢 ${result.singleFile ? 'Single-file HTML' : 'Dashboard'} generated`);
  log(`   pages   : ${result.pages.length}`);
  log(`   images  : ${result.imagesCopied}`);
  log(`   vectors : ${result.vectorsCopied}`);
  log(`   total   : ${formatBytes(result.totalBytes)}`);
  log('');
  if (result.singleFile) {
    log(`Open: file://${result.outDir.replace(/\\/g, '/')}`);
  } else {
    log(`Open: file://${htmlOutDir.replace(/\\/g, '/')}/index.html`);
  }
}

interface RoundTripCliOptions {
  extractedDir: string;
  outputDir: string;
  htmlOutPath: string;
}

function parseRoundTripArgs(args: string[]): RoundTripCliOptions {
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }
  if (args.length === 0) {
    process.stderr.write('error: round-trip-html requires <extracted-dir>\n\n');
    printHelp();
    process.exit(1);
  }
  const opts: RoundTripCliOptions = {
    extractedDir: '',
    outputDir: 'output',
    htmlOutPath: '',
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--output':
        opts.outputDir = args[++i] ?? fatal('--output requires a path');
        break;
      case '--verbose':
        break;
      default:
        if (a.startsWith('--')) fatal(`unknown flag: ${a}`);
        positional.push(a);
    }
  }
  opts.extractedDir = positional[0]!;
  if (positional[1]) opts.htmlOutPath = positional[1];
  return opts;
}

async function runRoundTripHtml(args: string[]): Promise<void> {
  // ⚠️ Deprecated — 통합 후 editable-html --single-file이 동일 기능 + 메타도 풍부.
  // 본 명령은 backward-compat alias. extractedDir에서 figName 추론 → editable-html.
  log('[deprecated] round-trip-html은 editable-html --single-file로 통합되었습니다.');
  log('             (07_editable/figma.editable.html이 동일 기능 + 편집 메타 포함)');
  log('');

  const opts = parseRoundTripArgs(args);
  const extractedDir = resolve(opts.extractedDir);
  let outputDir = resolve(opts.outputDir);
  if (opts.outputDir === 'output') {
    const figName = basename(extractedDir);
    const candidate = resolve('output', figName);
    if (existsSync(candidate)) outputDir = candidate;
  }
  const htmlOutPath = opts.htmlOutPath
    ? resolve(opts.htmlOutPath)
    : resolve(extractedDir, '06_report', 'figma-round-trip.html');

  if (!existsSync(extractedDir)) fatal(`extracted directory not found: ${extractedDir}`);
  if (!existsSync(outputDir)) {
    fatal(
      `output directory not found: ${outputDir}\n` +
        `Run \`figma-reverse extract\` first or pass --output <path>.`,
    );
  }

  log(`▶ figma-reverse round-trip-html`);
  log(`  extracted : ${extractedDir}`);
  log(`  output    : ${outputDir}`);
  log(`  html-out  : ${htmlOutPath}`);
  log('');

  const result = await generateRoundTripHtml({
    extractedDir,
    outputDir,
    htmlOutPath,
  });

  log(`🟢 Round-trip HTML generated`);
  log(`   pages         : ${result.pages}`);
  log(`   images        : ${result.images}`);
  log(`   vectors       : ${result.vectors}`);
  log(`   embedded .fig : ${formatBytes(result.figBytes)}  sha256=${result.figSha256.slice(0, 12)}…`);
  log(`   html total    : ${formatBytes(result.htmlBytes)}`);
  log('');
  log(`Open: file://${result.outPath.replace(/\\/g, '/')}`);
  log(`(헤더의 "Download .fig" 버튼으로 임베드된 .fig 추출 → Figma import)`);
}

interface EditableHtmlCliOptions {
  inputFig: string; // 원본 .fig (자동 extract 후 editable HTML 생성)
  htmlOutDir: string;
  singleFile: boolean;
}

function parseEditableHtmlArgs(args: string[]): EditableHtmlCliOptions {
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }
  if (args.length === 0) {
    process.stderr.write('error: editable-html requires <input.fig>\n\n');
    printHelp();
    process.exit(1);
  }
  const opts: EditableHtmlCliOptions = {
    inputFig: '',
    htmlOutDir: '',
    singleFile: false,
  };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--single-file':
        opts.singleFile = true;
        break;
      case '--out':
        opts.htmlOutDir = args[++i] ?? fatal('--out requires a path');
        break;
      case '--verbose':
        break;
      default:
        if (a.startsWith('--')) fatal(`unknown flag: ${a}`);
        positional.push(a);
    }
  }
  opts.inputFig = positional[0]!;
  if (positional[1] && !opts.htmlOutDir) opts.htmlOutDir = positional[1];
  return opts;
}

async function runEditableHtml(args: string[]): Promise<void> {
  const opts = parseEditableHtmlArgs(args);
  const inputPath = resolve(opts.inputFig);
  const figName = figFileSlug(opts.inputFig);
  // default: <root>/extracted/<figName>/07_editable
  const htmlOutDir = resolve(opts.htmlOutDir || `extracted/${figName}/07_editable`);

  if (!existsSync(inputPath)) fatal(`input .fig not found: ${inputPath}`);

  log(`▶ figma-reverse editable-html`);
  log(`  input    : ${inputPath}`);
  log(`  htmlOut  : ${htmlOutDir}`);
  log(`  mode     : ${opts.singleFile ? 'single-file' : 'directory'}`);
  log('');

  // 자동 extract — output·extracted 모두 <figName> 하위로
  const outputDir = resolve('output', figName);
  const extractedDir = resolve('extracted', figName);

  if (
    !existsSync(join(outputDir, 'manifest.json')) ||
    !existsSync(join(extractedDir, '01_container'))
  ) {
    log(`  (output/${figName}/ 또는 extracted/${figName}/ 없음 — 먼저 extract 실행)`);
    log('');
    await runExtract([
      inputPath,
      outputDir,
      '--no-document',
      '--minify',
      '--extracted-dir',
      extractedDir,
    ]);
    log('');
  }

  // editable-html generation에 필요한 데이터 다시 로드
  log('[*] tree + assets 로드...');
  const container = loadContainer(inputPath);
  const decoded = decodeFigCanvas(container.canvasFig);
  const tree = buildTree(decoded.message);
  log(`    nodes: ${tree.allNodes.size} | pages: ${tree.document?.children.filter((c) => c.type === 'CANVAS').length}`);
  log('');

  // single-file 모드 시 .fig 바이트도 빌드해 HTML에 임베드 + 디스크 출력 (round-trip 통합)
  let figBundle: { bytes: Uint8Array; fileName: string; sha256: string } | undefined;
  if (opts.singleFile) {
    log('[*] .fig bundle 빌드 (byte-level repack)...');
    const { buffer } = await buildByteLevelFigBuffer(extractedDir);
    const figFileName = (container.metaJson?.file_name ?? figName)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .slice(0, 80) + '.fig';
    figBundle = {
      bytes: buffer,
      fileName: figFileName,
      sha256: createHash('sha256').update(buffer).digest('hex'),
    };
    log(`    .fig: ${figBundle.fileName} (${formatBytes(buffer.byteLength)})`);
  }

  log('[*] editable HTML 생성...');
  const result = generateEditableHtml({
    tree,
    decoded,
    container,
    outputDir,
    htmlOutDir,
    options: { singleFile: opts.singleFile, cssExternal: !opts.singleFile },
    figBundle,
  });

  log(`🟢 Editable HTML generated`);
  log(`   nodes      : ${result.stats.totalNodes}`);
  log(`   pages      : ${result.stats.pages}`);
  log(`   files      : ${result.files.length}`);
  log(`   source sha : ${result.stats.sourceFigSha256.slice(0, 16)}…`);
  if (result.figFilePath) log(`   .fig out   : ${result.figFilePath}`);
  log('');
  const htmlFile = opts.singleFile ? 'figma.editable.html' : 'figma.editable.html';
  log(`Open: file://${join(result.htmlOutDir, htmlFile).replace(/\\/g, '/')}`);
  if (opts.singleFile) {
    log('헤더의 "⬇ Download .fig" 버튼으로 임베드된 .fig 추출 → Figma에 import.');
  } else {
    log(`Edit: HTML 직접 편집 또는 브라우저 devtools`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Pencil .pen 형식 호환 export
// ────────────────────────────────────────────────────────────────────────

interface PenExportCliOptions {
  inputFig: string;
  outDir: string;
}

function parsePenExportArgs(args: string[]): PenExportCliOptions {
  if (args.includes('-h') || args.includes('--help')) {
    printHelp();
    process.exit(0);
  }
  if (args.length === 0) {
    process.stderr.write('error: pen-export requires <input.fig>\n\n');
    printHelp();
    process.exit(1);
  }
  const opts: PenExportCliOptions = { inputFig: '', outDir: '' };
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    switch (a) {
      case '--out':
        opts.outDir = args[++i] ?? fatal('--out requires a path');
        break;
      case '--verbose':
        break;
      default:
        if (a.startsWith('--')) fatal(`unknown flag: ${a}`);
        positional.push(a);
    }
  }
  opts.inputFig = positional[0]!;
  if (positional[1] && !opts.outDir) opts.outDir = positional[1];
  return opts;
}

async function runPenExport(args: string[]): Promise<void> {
  const opts = parsePenExportArgs(args);
  const inputPath = resolve(opts.inputFig);
  if (!existsSync(inputPath)) fatal(`input .fig not found: ${inputPath}`);

  const figName = figFileSlug(opts.inputFig);
  const outDir = resolve(opts.outDir || `extracted/${figName}/08_pen`);

  log(`▶ figma-reverse pen-export`);
  log(`  input  : ${inputPath}`);
  log(`  outDir : ${outDir}`);
  log('');

  log('[*] tree + assets 로드...');
  const container = loadContainer(inputPath);
  const decoded = decodeFigCanvas(container.canvasFig);
  const tree = buildTree(decoded.message);
  log(`    nodes: ${tree.allNodes.size} | pages: ${tree.document?.children.filter((c) => c.type === 'CANVAS').length}`);
  log('');

  log('[*] .pen 형식 변환...');
  const result = await generatePenExport({ tree, decoded, container, outDir });

  log(`🟢 .pen export generated`);
  log(`   pages       : ${result.totalPages}`);
  log(`   total nodes : ${result.totalNodes} (Figma 35660 → pen ${result.totalNodes}, 메타 노드·SYMBOL 평면화로 축소)`);
  log(`   files       : ${result.files.length} pages × 2 formats (.pen.json + .pen)`);
  for (const f of result.files) {
    const rel = f.path.replace(outDir + '\\', '').replace(outDir + '/', '');
    const penRel = f.penPath.replace(outDir + '\\', '').replace(outDir + '/', '');
    log(`     - ${rel}  (${formatBytes(f.bytes)}, ${f.nodeCount} nodes)`);
    log(`       └─ ${penRel}  (${formatBytes(f.penBytes)}, Pencil native)`);
  }
  log('');
  log(`Open: ${outDir.replace(/\\/g, '/')}`);
  log(`(.pen.json: figma round-trip 메타 포함  /  .pen: Pencil 앱이 직접 import 가능한 native 형식)`);
}

function fatal(msg: string): never {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}

function log(msg: string): void {
  process.stdout.write(msg + '\n');
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function badge(s: string): string {
  switch (s) {
    case 'PASS':
      return '🟢';
    case 'FAIL':
      return '🔴';
    case 'WARN':
      return '🟡';
    case 'SKIP':
      return '⚪';
    default:
      return s;
  }
}

async function runTokens(args: string[]): Promise<void> {
  let input = '';
  let outPath: string | undefined;
  let format: TokenFormat = 'json';
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--format' || a === '-f') {
      const v = args[++i];
      if (v !== 'json' && v !== 'css' && v !== 'js' && v !== 'ts') {
        fatal(`unknown --format value: ${v} (json|css|js|ts)`);
      }
      format = v;
    } else if (a === '--out' || a === '-o') {
      outPath = args[++i];
    } else if (!input) {
      input = a!;
    }
  }
  if (!input) {
    process.stderr.write('error: tokens requires <input.fig>\n\n');
    process.stderr.write('Usage:\n');
    process.stderr.write('  figma-reverse tokens <input.fig> [--format=json|css|js|ts] [--out <path>]\n');
    process.exit(1);
  }
  const inputPath = resolve(input);
  if (!existsSync(inputPath)) fatal(`input .fig not found: ${inputPath}`);

  const container = loadContainer(inputPath);
  const decoded = decodeFigCanvas(container.canvasFig);
  const tokens = extractTokens(decoded, basename(inputPath));
  const text = formatTokens(tokens, format);

  if (outPath) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(resolve(outPath), text, 'utf-8');
    log(`▶ tokens written: ${resolve(outPath)} (${format}) — ` +
      `${Object.keys(tokens.colors).length} colors, ` +
      `${Object.keys(tokens.typography).length} typography, ` +
      `${Object.keys(tokens.effects).length} effects`);
  } else {
    process.stdout.write(text);
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  // 사용자에게는 친화적 메시지만. stack은 DEBUG=1 또는 --verbose 시에만 노출.
  const verbose = process.env.DEBUG === '1' || process.argv.includes('--verbose');
  const msg = e?.message ?? String(err);
  process.stderr.write(`error: ${msg}\n`);
  if (verbose && e?.stack) process.stderr.write(e.stack + '\n');
  process.exit(1);
});
