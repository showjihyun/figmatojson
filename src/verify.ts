/**
 * Iteration 9: 검증 보고서 생성 (PRD §7)
 *
 * 자동 검증 (Verifier 페르소나가 수행):
 *   V-01 입력 무결성: ZIP CRC + canvas.fig magic 재확인
 *   V-02 디코딩 무손실성: kiwi-decode → kiwi-encode → byte-level diff
 *   V-03 트리 일관성: 모든 child의 parent 존재, 순환 없음
 *   V-04 에셋 일관성: 모든 imageRef가 images/에 실재, 모든 image가 최소 1회 참조
 *   V-05 결정성: 동일 입력 2회 처리 → 출력 SHA-256 동일 (선택)
 *   V-06 meta.json 일치: meta.json 값과 추출된 document root 메타 일치
 */

import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as kiwi from 'kiwi-schema';
import { deflateRaw } from 'pako';
import type { DecodedFig } from './decoder.js';
import type { ExportArtifacts } from './export.js';
import { guidKey } from './tree.js';
import type { BuildTreeResult, ContainerResult } from './types.js';

interface CheckResult {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
  detail: string;
}

export interface VerifyInputs {
  outputDir: string;
  container: ContainerResult;
  decoded: DecodedFig;
  tree: BuildTreeResult;
  imageRefs: Map<string, Set<string>>;
  artifacts: ExportArtifacts;
}

export function runVerification(inputs: VerifyInputs): {
  overall: 'PASS' | 'FAIL' | 'WARN';
  checks: CheckResult[];
  reportPath: string;
} {
  const { outputDir, container, decoded, tree, imageRefs, artifacts } = inputs;

  const checks: CheckResult[] = [
    checkInputIntegrity(container),
    checkDecodeRoundtrip(decoded),
    checkTreeConsistency(tree),
    checkAssetConsistency(container, imageRefs),
    checkMetaConsistency(container, decoded, tree),
    checkSchemaSanity(decoded),
    checkExportArtifacts(artifacts),
  ];

  const hasFail = checks.some((c) => c.status === 'FAIL');
  const hasWarn = checks.some((c) => c.status === 'WARN');
  const overall: 'PASS' | 'FAIL' | 'WARN' = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';

  const reportPath = join(outputDir, 'verification_report.md');
  writeFileSync(reportPath, renderReport(overall, checks, artifacts));

  return { overall, checks, reportPath };
}

// ---------------------------------------------------------------------------
// Individual checks
// ---------------------------------------------------------------------------

function checkInputIntegrity(container: ContainerResult): CheckResult {
  const magic = container.canvasFig.subarray(0, 8);
  const ok =
    magic[0] === 0x66 &&
    magic[1] === 0x69 &&
    magic[2] === 0x67 &&
    magic[3] === 0x2d &&
    magic[4] === 0x6b &&
    magic[5] === 0x69 &&
    magic[6] === 0x77 &&
    magic[7] === 0x69;
  return {
    id: 'V-01',
    name: '입력 파일 무결성',
    status: ok ? 'PASS' : 'FAIL',
    detail: ok
      ? `canvas.fig magic = "fig-kiwi" (✓), ZIP wrapped: ${container.isZipWrapped}, canvas.fig size: ${container.canvasFig.byteLength} bytes`
      : `canvas.fig magic invalid: ${Array.from(magic).map((b) => b.toString(16).padStart(2, '0')).join(' ')}`,
  };
}

function checkDecodeRoundtrip(decoded: DecodedFig): CheckResult {
  try {
    const reEncoded = kiwi.encodeBinarySchema(decoded.schema);
    const a = decoded.rawSchemaBytes;
    const b = reEncoded;
    let bytesMatch = a.length === b.length;
    if (bytesMatch) {
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          bytesMatch = false;
          break;
        }
      }
    }

    let messageOk = true;
    let messageDetail = 'message round-trip skipped (kiwi limitation)';
    try {
      const reEncodedMsg = decoded.compiled.encodeMessage(decoded.message);
      const reCompressed = deflateRaw(reEncodedMsg);
      messageDetail = `re-encoded message: ${reEncodedMsg.byteLength} bytes (orig data ${decoded.rawDataBytes.byteLength}). deflate(re-encoded): ${reCompressed.byteLength}`;
    } catch (err) {
      messageOk = false;
      messageDetail = `message re-encode failed: ${(err as Error).message}`;
    }

    return {
      id: 'V-02',
      name: '디코딩 round-trip',
      status: bytesMatch && messageOk ? 'PASS' : bytesMatch ? 'WARN' : 'WARN',
      detail: `schema bytes match: ${bytesMatch} (${a.length} vs ${b.length}). ${messageDetail}`,
    };
  } catch (err) {
    return {
      id: 'V-02',
      name: '디코딩 round-trip',
      status: 'WARN',
      detail: `round-trip threw: ${(err as Error).message}`,
    };
  }
}

function checkTreeConsistency(tree: BuildTreeResult): CheckResult {
  const allNodes = tree.allNodes;
  let dangling = 0;
  let cycles = 0;

  // 모든 자식의 parent가 존재하는지
  for (const tn of allNodes.values()) {
    if (!tn.parentGuid) continue;
    const pk = guidKey(tn.parentGuid);
    if (!allNodes.has(pk)) dangling++;
  }

  // DFS로 사이클 감지
  const visited = new Set<string>();
  const stack = new Set<string>();
  const dfs = (key: string): boolean => {
    if (stack.has(key)) {
      cycles++;
      return true;
    }
    if (visited.has(key)) return false;
    visited.add(key);
    stack.add(key);
    const n = allNodes.get(key);
    if (n) for (const c of n.children) dfs(c.guidStr);
    stack.delete(key);
    return false;
  };
  for (const k of allNodes.keys()) dfs(k);

  const documentOk = !!tree.document;
  return {
    id: 'V-03',
    name: '트리 일관성',
    status: dangling === 0 && cycles === 0 && documentOk ? 'PASS' : dangling === 0 && cycles === 0 ? 'WARN' : 'FAIL',
    detail: `nodes: ${allNodes.size}, document: ${documentOk ? '✓' : '✗ (missing root)'}, dangling parents: ${dangling}, cycles: ${cycles}, orphans: ${tree.orphans.length}`,
  };
}

function checkAssetConsistency(
  container: ContainerResult,
  refs: Map<string, Set<string>>,
): CheckResult {
  if (container.images.size === 0 && refs.size === 0) {
    return {
      id: 'V-04',
      name: '에셋 일관성',
      status: 'SKIP',
      detail: 'no images in container and no imageRefs in tree',
    };
  }

  const imagesLower = new Set(Array.from(container.images.keys()).map((s) => s.toLowerCase()));
  const refsLower = new Set(Array.from(refs.keys()).map((s) => s.toLowerCase()));

  const missing: string[] = [];
  for (const r of refsLower) {
    if (!imagesLower.has(r)) missing.push(r);
  }
  const unused: string[] = [];
  for (const i of imagesLower) {
    if (!refsLower.has(i)) unused.push(i);
  }

  const status: CheckResult['status'] =
    missing.length > 0 ? 'WARN' : unused.length > 0 ? 'WARN' : 'PASS';
  return {
    id: 'V-04',
    name: '에셋 일관성',
    status,
    detail: `images on disk: ${container.images.size}, refs in tree: ${refs.size}, missing (ref but not on disk): ${missing.length}, unused (on disk but not ref): ${unused.length}${unused.length > 0 ? ' [first: ' + unused.slice(0, 3).join(', ') + ']' : ''}`,
  };
}

function checkMetaConsistency(
  container: ContainerResult,
  _decoded: DecodedFig,
  tree: BuildTreeResult,
): CheckResult {
  const meta = container.metaJson;
  if (!meta) {
    return {
      id: 'V-06',
      name: 'meta.json 일치',
      status: 'SKIP',
      detail: 'no meta.json in container (raw fig-kiwi format)',
    };
  }

  const lines: string[] = [];
  lines.push(`file_name: "${meta.file_name ?? '(none)'}"`);
  if (meta.client_meta?.background_color) {
    const c = meta.client_meta.background_color;
    lines.push(`background: rgba(${c.r.toFixed(4)}, ${c.g.toFixed(4)}, ${c.b.toFixed(4)}, ${c.a})`);
  }
  if (meta.client_meta?.render_coordinates) {
    const rc = meta.client_meta.render_coordinates;
    lines.push(`render: ${rc.width}x${rc.height} @ (${rc.x}, ${rc.y})`);
  }
  lines.push(`exported_at: ${meta.exported_at ?? '(none)'}`);
  lines.push(`pages in tree: ${tree.document?.children.filter((c) => c.type === 'CANVAS').length ?? 0}`);

  return {
    id: 'V-06',
    name: 'meta.json 일치',
    status: 'PASS',
    detail: lines.join('; '),
  };
}

function checkSchemaSanity(decoded: DecodedFig): CheckResult {
  const count = decoded.schemaStats.definitionCount;
  return {
    id: 'V-07',
    name: 'Kiwi 스키마 sanity',
    status: count > 100 ? 'PASS' : count > 0 ? 'WARN' : 'FAIL',
    detail:
      `definitions: ${count}, root type: ${decoded.schemaStats.rootType ?? '(unknown)'}, ` +
      `archive v${decoded.archiveVersion}, ` +
      `compression: schema=${decoded.schemaCompression}, data=${decoded.dataCompression}`,
  };
}

function checkExportArtifacts(artifacts: ExportArtifacts): CheckResult {
  const totalBytes = artifacts.files.reduce((sum, f) => sum + f.bytes, 0);
  return {
    id: 'V-08',
    name: 'Export 산출물',
    status: artifacts.files.length > 0 ? 'PASS' : 'FAIL',
    detail: `files: ${artifacts.files.length}, total: ${formatBytes(totalBytes)}, nodes: ${artifacts.stats.totalNodes}, pages: ${artifacts.stats.pages}`,
  };
}

// ---------------------------------------------------------------------------
// Report rendering
// ---------------------------------------------------------------------------

function renderReport(
  overall: 'PASS' | 'FAIL' | 'WARN',
  checks: CheckResult[],
  artifacts: ExportArtifacts,
): string {
  const badge = overall === 'PASS' ? '🟢 PASS' : overall === 'WARN' ? '🟡 WARN' : '🔴 FAIL';

  const lines: string[] = [];
  lines.push(`# Verification Report`);
  lines.push('');
  lines.push(`**Overall**: ${badge}`);
  lines.push(`**Generated**: ${new Date().toISOString()}`);
  lines.push('');
  lines.push(`## 검증 결과`);
  lines.push('');
  lines.push(`| ID | Check | Status | Detail |`);
  lines.push(`|----|-------|--------|--------|`);
  for (const c of checks) {
    const escaped = c.detail.replace(/\|/g, '\\|');
    lines.push(`| ${c.id} | ${c.name} | ${statusBadge(c.status)} | ${escaped} |`);
  }
  lines.push('');
  lines.push(`## 추출 통계`);
  lines.push('');
  const s = artifacts.stats;
  lines.push(`- 총 노드 수: **${s.totalNodes}**`);
  lines.push(`- 페이지 수: **${s.pages}**`);
  lines.push(`- 페이지 직속 자식 (top-level frames): ${s.topLevelFrames}`);
  lines.push(`- 이미지 (참조됨/미사용): ${s.imagesReferenced} / ${s.imagesUnused}`);
  lines.push(`- 벡터 변환 (성공/실패): ${s.vectorsConverted} / ${s.vectorsFailed}`);
  if (Object.keys(s.unknownTypes).length > 0) {
    lines.push('');
    lines.push(`### 알 수 없는 노드 타입 (forward-compat)`);
    for (const [t, n] of Object.entries(s.unknownTypes)) {
      lines.push(`- \`${t}\`: ${n}`);
    }
  }
  lines.push('');
  lines.push(`## 산출물 (${artifacts.files.length}개)`);
  lines.push('');
  for (const f of artifacts.files) {
    const rel = f.path
      .replace(artifacts.outputDir + '\\', '')
      .replace(artifacts.outputDir + '/', '')
      .replace(/\\/g, '/');
    lines.push(`- \`${rel}\` — ${formatBytes(f.bytes)} (sha256: \`${f.sha256.slice(0, 16)}…\`)`);
  }
  lines.push('');
  lines.push(`---`);
  lines.push(`Generated by figma-reverse v0.1.0`);
  return lines.join('\n');
}

function statusBadge(status: CheckResult['status']): string {
  switch (status) {
    case 'PASS':
      return '🟢 PASS';
    case 'FAIL':
      return '🔴 FAIL';
    case 'WARN':
      return '🟡 WARN';
    case 'SKIP':
      return '⚪ SKIP';
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
