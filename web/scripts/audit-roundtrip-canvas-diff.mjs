/**
 * Phase 1.5 — diff canvas.fig (kiwi message) between original and round-trip.
 *
 *   node web/scripts/audit-roundtrip-canvas-diff.mjs           # default fixtures
 *   node web/scripts/audit-roundtrip-canvas-diff.mjs <path>... # specific
 *
 * Pre-req: web backend up at :5274. Reads docs/audit-roundtrip/<name>/report.json
 * is NOT required — this script does its own upload→save→decode round.
 *
 * For each fixture:
 *   1. POST /api/upload + /api/save → get round-tripped .fig
 *   2. Unzip both, extract canvas.fig
 *   3. Decode both via dist/decoder.js (kiwi)
 *   4. Walk both messages in parallel, classify diffs
 *   5. Aggregate by field name; report top categories
 *
 * Goal: decide whether canvas.fig size delta comes from
 *   (a) defaults being made explicit
 *   (b) unknown fields lost
 *   (c) array re-ordering
 *   (d) something else
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { decodeFigCanvas } from '../../dist/decoder.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND = process.env.AUDIT_BACKEND ?? 'http://localhost:5274';
const OUT_ROOT = resolve(REPO_ROOT, 'docs', 'audit-roundtrip');

const DEFAULT_FIXTURES = [
  'docs/bvp.fig',
  'docs/메타리치 화면 UI Design.fig',
];

function repoPath(p) { return isAbsolute(p) ? p : resolve(REPO_ROOT, p); }

async function uploadFig(bytes, origName) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), origName);
  const res = await fetch(`${BACKEND}/api/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return res.json();
}

async function saveFig(sessionId) {
  const res = await fetch(`${BACKEND}/api/save/${sessionId}`, { method: 'POST' });
  if (!res.ok) throw new Error(`save ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

function extractCanvasFig(figBytes) {
  const isZip = figBytes[0] === 0x50 && figBytes[1] === 0x4b;
  if (!isZip) return figBytes;
  const zip = new AdmZip(Buffer.from(figBytes));
  const entry = zip.getEntries().find((e) => e.entryName === 'canvas.fig');
  if (!entry) throw new Error('no canvas.fig entry');
  return new Uint8Array(entry.getData());
}

/**
 * Walk two values in parallel; emit diff records.
 * Diff record shape: { path, kind, fieldName?, origType?, rtType?, origValue?, rtValue? }
 *   kind: 'added' | 'removed' | 'changed' | 'array-len' | 'type-mismatch'
 */
function* walkDiff(orig, rt, path = '') {
  const oType = typeOf(orig);
  const rType = typeOf(rt);
  if (oType !== rType) {
    yield { path, kind: 'type-mismatch', origType: oType, rtType: rType };
    return;
  }
  if (oType === 'object') {
    const oKeys = new Set(Object.keys(orig));
    const rKeys = new Set(Object.keys(rt));
    const all = new Set([...oKeys, ...rKeys]);
    for (const k of all) {
      const sub = path ? `${path}.${k}` : k;
      if (!oKeys.has(k)) {
        yield { path: sub, kind: 'added', fieldName: k, rtValue: previewValue(rt[k]) };
      } else if (!rKeys.has(k)) {
        yield { path: sub, kind: 'removed', fieldName: k, origValue: previewValue(orig[k]) };
      } else {
        yield* walkDiff(orig[k], rt[k], sub);
      }
    }
  } else if (oType === 'array') {
    if (orig.length !== rt.length) {
      yield { path, kind: 'array-len', origValue: orig.length, rtValue: rt.length };
    }
    const minLen = Math.min(orig.length, rt.length);
    for (let i = 0; i < minLen; i++) {
      yield* walkDiff(orig[i], rt[i], `${path}[${i}]`);
    }
  } else if (oType === 'bytes') {
    if (orig.length !== rt.length || !bytesEqual(orig, rt)) {
      yield { path, kind: 'changed', origValue: `<${orig.length}B>`, rtValue: `<${rt.length}B>` };
    }
  } else {
    // NaN !== NaN — treat both-NaN as equal (Figma's kiwi float schema
    // emits NaN bit-pattern as default for unset stack* spacing fields).
    const bothNaN = typeof orig === 'number' && typeof rt === 'number'
      && Number.isNaN(orig) && Number.isNaN(rt);
    if (orig !== rt && !bothNaN) {
      yield { path, kind: 'changed', origValue: previewValue(orig), rtValue: previewValue(rt) };
    }
  }
}

function typeOf(v) {
  if (v === null || v === undefined) return 'nullish';
  if (v instanceof Uint8Array) return 'bytes';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function previewValue(v) {
  if (v === null || v === undefined) return String(v);
  if (v instanceof Uint8Array) return `<bytes:${v.length}>`;
  if (Array.isArray(v)) return `<array:${v.length}>`;
  if (typeof v === 'object') return `<object:${Object.keys(v).length}keys>`;
  if (typeof v === 'string') return v.length > 40 ? `"${v.slice(0, 37)}..."` : `"${v}"`;
  return String(v);
}

/** Strip array indices from path so we can group by field. */
function fieldKey(path) {
  return path.replace(/\[\d+\]/g, '[]');
}

function aggregateDiffs(diffs) {
  const byKind = {};
  const byField = {};
  let total = 0;
  for (const d of diffs) {
    total++;
    byKind[d.kind] = (byKind[d.kind] || 0) + 1;
    const key = fieldKey(d.path);
    if (!byField[key]) byField[key] = { count: 0, kinds: {} };
    byField[key].count++;
    byField[key].kinds[d.kind] = (byField[key].kinds[d.kind] || 0) + 1;
  }
  const topFields = Object.entries(byField)
    .sort(([, a], [, b]) => b.count - a.count)
    .slice(0, 30);
  return { total, byKind, topFields };
}

async function auditOne(figPath) {
  const absPath = repoPath(figPath);
  if (!existsSync(absPath)) throw new Error(`not found: ${absPath}`);
  const name = basename(absPath, '.fig');
  console.log(`\n=== ${name} ===`);

  const origBytes = new Uint8Array(readFileSync(absPath));
  const upload = await uploadFig(origBytes, basename(absPath));
  const rtBytes = await saveFig(upload.sessionId);

  const origCanvas = extractCanvasFig(origBytes);
  const rtCanvas = extractCanvasFig(rtBytes);
  console.log(`  canvas.fig orig=${origCanvas.length.toLocaleString()} rt=${rtCanvas.length.toLocaleString()}`);

  const origDecoded = decodeFigCanvas(origCanvas);
  const rtDecoded = decodeFigCanvas(rtCanvas);
  console.log(`  archive version orig=${origDecoded.archiveVersion} rt=${rtDecoded.archiveVersion}`);
  console.log(`  schema definitions orig=${origDecoded.schemaStats.definitionCount} rt=${rtDecoded.schemaStats.definitionCount}`);

  const diffs = [...walkDiff(origDecoded.message, rtDecoded.message)];
  const agg = aggregateDiffs(diffs);
  console.log(`  total diffs: ${agg.total.toLocaleString()}`);
  console.log(`  by kind:`);
  for (const [kind, count] of Object.entries(agg.byKind).sort(([, a], [, b]) => b - a)) {
    console.log(`    ${kind.padEnd(20)} ${count.toLocaleString()}`);
  }
  console.log(`  top 30 differing fields (by count):`);
  for (const [field, info] of agg.topFields) {
    const kindStr = Object.entries(info.kinds).map(([k, c]) => `${k}:${c}`).join(' ');
    console.log(`    ${String(info.count).padStart(7)}  ${field.padEnd(60)}  [${kindStr}]`);
  }

  const outDir = resolve(OUT_ROOT, name);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'canvas-diff.json'), JSON.stringify({
    fixture: figPath,
    canvasOrigBytes: origCanvas.length,
    canvasRtBytes: rtCanvas.length,
    schemaDefsOrig: origDecoded.schemaStats.definitionCount,
    schemaDefsRt: rtDecoded.schemaStats.definitionCount,
    aggregate: agg,
    sample: diffs.slice(0, 200),
  }, null, 2));
  console.log(`  → ${resolve(outDir, 'canvas-diff.json')}`);
  return { name, agg };
}

async function main() {
  const args = process.argv.slice(2);
  const fixtures = args.length > 0 ? args : DEFAULT_FIXTURES;
  for (const f of fixtures) {
    try { await auditOne(f); }
    catch (err) { console.error(`  ERR ${f}: ${err.message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
