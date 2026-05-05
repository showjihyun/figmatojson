/**
 * Audit — round-trip integrity baseline.
 *
 *   node web/scripts/audit-roundtrip.mjs           # all default fixtures
 *   node web/scripts/audit-roundtrip.mjs <path>... # specific .fig files
 *
 * Pre-reqs: web backend up at :5274 (`cd web && npm run dev:server`).
 *
 * For each .fig fixture:
 *   1. POST /api/upload  → sessionId
 *   2. POST /api/save/:id → round-tripped .fig bytes (no edits applied)
 *   3. Unzip BOTH (orig + round-trip) with adm-zip
 *   4. Per-entry byte-compare; classify identical / differing / orphan
 *
 * Output: docs/audit-roundtrip/<fixture-name>/report.json + summary printed.
 *
 * Phase 1 baseline (round 30 transition): tells us *what fraction of bytes
 * survives a no-op load→save through the web pipeline*. Lower-bounds
 * "Figma load 후 정상 표시" — anything that doesn't round-trip here can't.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND = process.env.AUDIT_BACKEND ?? 'http://localhost:5274';
const OUT_ROOT = resolve(REPO_ROOT, 'docs', 'audit-roundtrip');

const DEFAULT_FIXTURES = [
  'docs/bvp.fig',
  'docs/메타리치 화면 UI Design.fig',
];

function repoPath(p) {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

async function uploadFig(bytes, origName) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), origName);
  const res = await fetch(`${BACKEND}/api/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function saveFig(sessionId) {
  const res = await fetch(`${BACKEND}/api/save/${sessionId}`, { method: 'POST' });
  if (!res.ok) throw new Error(`save ${res.status}: ${await res.text().catch(() => '')}`);
  return new Uint8Array(await res.arrayBuffer());
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Unzip `bytes` (or treat as raw fig-kiwi if not a ZIP). Returns Map<name, Uint8Array>. */
function unzipFig(bytes) {
  // ZIP files start with PK (0x50 0x4B). Raw fig-kiwi files start with "fig-kiwi".
  const isZip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  if (!isZip) {
    return new Map([['<raw>canvas.fig', bytes]]);
  }
  const zip = new AdmZip(Buffer.from(bytes));
  const out = new Map();
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue;
    out.set(e.entryName, new Uint8Array(e.getData()));
  }
  return out;
}

function compareEntries(origMap, rtMap) {
  const allNames = new Set([...origMap.keys(), ...rtMap.keys()]);
  const entries = [];
  let identicalBytes = 0;
  let totalOrigBytes = 0;
  for (const name of [...allNames].sort()) {
    const a = origMap.get(name);
    const b = rtMap.get(name);
    if (a) totalOrigBytes += a.length;
    if (a && !b) {
      entries.push({ name, status: 'missing-in-roundtrip', origBytes: a.length, rtBytes: 0 });
    } else if (!a && b) {
      entries.push({ name, status: 'extra-in-roundtrip', origBytes: 0, rtBytes: b.length });
    } else if (bytesEqual(a, b)) {
      entries.push({ name, status: 'identical', origBytes: a.length, rtBytes: b.length });
      identicalBytes += a.length;
    } else {
      // Compute first-diff offset for quick triage.
      const minLen = Math.min(a.length, b.length);
      let firstDiff = minLen;
      for (let i = 0; i < minLen; i++) if (a[i] !== b[i]) { firstDiff = i; break; }
      entries.push({
        name, status: 'differs',
        origBytes: a.length, rtBytes: b.length,
        deltaBytes: b.length - a.length,
        firstDiffOffset: firstDiff,
      });
    }
  }
  return {
    entries,
    summary: {
      totalOrigBytes,
      identicalBytes,
      identicalRatio: totalOrigBytes ? identicalBytes / totalOrigBytes : 0,
      identicalCount: entries.filter((e) => e.status === 'identical').length,
      differingCount: entries.filter((e) => e.status === 'differs').length,
      missingCount: entries.filter((e) => e.status === 'missing-in-roundtrip').length,
      extraCount: entries.filter((e) => e.status === 'extra-in-roundtrip').length,
      totalEntries: entries.length,
    },
  };
}

async function auditOne(figPath) {
  const absPath = repoPath(figPath);
  if (!existsSync(absPath)) throw new Error(`fixture not found: ${absPath}`);
  const name = basename(absPath, '.fig');
  console.log(`\n=== ${name} (${figPath}) ===`);

  const origBytes = new Uint8Array(readFileSync(absPath));
  console.log(`  orig: ${origBytes.length.toLocaleString()} bytes`);

  const upload = await uploadFig(origBytes, basename(absPath));
  console.log(`  uploaded → session=${upload.sessionId} pages=${upload.pageCount} nodes=${upload.nodeCount}`);

  const rtBytes = await saveFig(upload.sessionId);
  console.log(`  round-trip: ${rtBytes.length.toLocaleString()} bytes (Δ ${(rtBytes.length - origBytes.length).toLocaleString()})`);

  const orig = unzipFig(origBytes);
  const rt = unzipFig(rtBytes);
  const diff = compareEntries(orig, rt);
  const s = diff.summary;
  console.log(
    `  entries: ${s.totalEntries} (identical ${s.identicalCount}, differs ${s.differingCount}, missing ${s.missingCount}, extra ${s.extraCount})`,
  );
  console.log(`  byte-identical ratio: ${(s.identicalRatio * 100).toFixed(2)}% (${s.identicalBytes.toLocaleString()} / ${s.totalOrigBytes.toLocaleString()})`);

  const outDir = resolve(OUT_ROOT, name);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(resolve(outDir, 'report.json'), JSON.stringify({
    fixture: figPath,
    origBytes: origBytes.length,
    rtBytes: rtBytes.length,
    upload,
    summary: s,
    entries: diff.entries,
  }, null, 2));
  return { name, summary: s };
}

async function main() {
  const args = process.argv.slice(2);
  const fixtures = args.length > 0 ? args : DEFAULT_FIXTURES;
  const results = [];
  for (const f of fixtures) {
    try {
      results.push(await auditOne(f));
    } catch (err) {
      console.error(`  ERR: ${err.message}`);
      results.push({ name: basename(f, '.fig'), error: err.message });
    }
  }
  console.log('\n=== aggregate ===');
  for (const r of results) {
    if (r.error) {
      console.log(`  ${r.name}: ERROR — ${r.error}`);
      continue;
    }
    const s = r.summary;
    console.log(`  ${r.name}: ${(s.identicalRatio * 100).toFixed(2)}% byte-identical (${s.identicalCount}/${s.totalEntries} entries)`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
