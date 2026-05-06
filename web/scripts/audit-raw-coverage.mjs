/**
 * Round 17 — raw wire-format coverage audit.
 *
 *   node web/scripts/audit-raw-coverage.mjs           # default fixtures
 *   node web/scripts/audit-raw-coverage.mjs <path>... # specific
 *
 * Pre-req: web backend up at :5274 (`cd web && npm run dev:server`).
 *
 * For each fixture:
 *   1. Decode locally via dist/decoder.js → raw kiwi nodeChanges (ground truth).
 *   2. Upload to backend + GET /api/doc → client-shaped documentJson.
 *   3. Walk both. For every (type, fieldKey) pair classify as
 *      present-both / lost-(un)expected / extra-(un)expected.
 *   4. Probe JSON.stringify on each raw value → record serialization
 *      failures (BigInt, function, cycle, undefined-object …).
 *   5. Emit docs/audit-raw-coverage/<fixture>/coverage.json + console summary.
 *
 * Spec: docs/specs/audit-raw-coverage.spec.md
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFigCanvas } from '../../dist/decoder.js';
import AdmZip from 'adm-zip';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND = process.env.AUDIT_BACKEND ?? 'http://localhost:5274';
const OUT_ROOT = resolve(REPO_ROOT, 'docs', 'audit-raw-coverage');

const DEFAULT_FIXTURES = [
  'docs/bvp.fig',
  'docs/메타리치 화면 UI Design.fig',
];

// Spec §I-R8 — toClientNode drops these keys deliberately.
const EXPECTED_LOSS_KEYS = new Set([
  'guid', 'type', 'name',
  'derivedSymbolData', 'derivedTextData',
  'fillGeometry', 'strokeGeometry',
  'vectorData',
]);

// Spec §I-R9 — toClientNode synthesizes these "_xxx" prefixed fields.
const EXPECTED_SYNTH_PREFIX = '_';
// id is also synthesized (= guidStr); children is built from parent links.
const EXPECTED_SYNTH_KEYS = new Set(['id', 'children']);

function repoPath(p) { return isAbsolute(p) ? p : resolve(REPO_ROOT, p); }

function extractCanvasFig(figBytes) {
  const isZip = figBytes[0] === 0x50 && figBytes[1] === 0x4b;
  if (!isZip) return figBytes;
  const zip = new AdmZip(Buffer.from(figBytes));
  const entry = zip.getEntries().find((e) => e.entryName === 'canvas.fig');
  if (!entry) throw new Error('no canvas.fig entry');
  return new Uint8Array(entry.getData());
}

async function uploadFig(bytes, origName) {
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), origName);
  const res = await fetch(`${BACKEND}/api/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`upload ${res.status}: ${await res.text().catch(() => '')}`);
  return res.json();
}

async function fetchDoc(sessionId) {
  const res = await fetch(`${BACKEND}/api/doc/${sessionId}`);
  if (!res.ok) throw new Error(`doc ${res.status}`);
  return res.json();
}

function fieldKey(path) {
  return path.replace(/\[\d+\]/g, '[]');
}

/** Walk every key path under a node object (no recursion into Uint8Array).
 *  Yields { path, key, value, type }. */
function* walkPaths(obj, path = '') {
  if (obj === null || obj === undefined) return;
  if (obj instanceof Uint8Array) return;
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const child = obj[i];
      const p = `${path}[${i}]`;
      if (child !== null && typeof child === 'object' && !(child instanceof Uint8Array)) {
        yield* walkPaths(child, p);
      }
    }
    return;
  }
  if (typeof obj !== 'object') return;
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    const p = path ? `${path}.${key}` : key;
    yield { path: p, key, value: v };
    if (v !== null && typeof v === 'object' && !(v instanceof Uint8Array)) {
      yield* walkPaths(v, p);
    }
  }
}

function attemptStringify(v) {
  try {
    const s = JSON.stringify(v, (_k, val) => {
      if (typeof val === 'bigint') throw new Error('BigInt');
      if (typeof val === 'function') throw new Error('function');
      if (typeof val === 'symbol') throw new Error('symbol');
      if (val instanceof Uint8Array) return `<bytes:${val.length}>`;
      return val;
    });
    if (s === undefined) return { ok: false, reason: 'undefined' };
    return { ok: true };
  } catch (e) {
    if (e?.message === 'BigInt') return { ok: false, reason: 'BigInt' };
    if (e?.message === 'function') return { ok: false, reason: 'function' };
    if (e?.message === 'symbol') return { ok: false, reason: 'symbol' };
    if (String(e).includes('circular') || String(e).includes('Converting circular')) {
      return { ok: false, reason: 'circular' };
    }
    return { ok: false, reason: String(e).slice(0, 80) };
  }
}

/** Build the set of (type, fieldKey) seen on each side. */
function collectFields(nodes, sideName) {
  const byType = new Map(); // type → Map<fieldKey, count>
  let visited = 0;
  const serializationFailures = [];

  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    visited++;
    const type = String(n.type ?? 'NONE');
    if (!byType.has(type)) byType.set(type, new Map());
    const m = byType.get(type);
    // Top-level keys + nested paths
    for (const { path, value } of walkPaths(n)) {
      const k = fieldKey(path);
      m.set(k, (m.get(k) ?? 0) + 1);
      if (sideName === 'raw' && serializationFailures.length < 50) {
        const probe = attemptStringify(value);
        if (!probe.ok) {
          serializationFailures.push({ path, type, reason: probe.reason, sampleType: typeof value });
        }
      }
    }
  }
  return { byType, visited, serializationFailures };
}

/** DFS the client documentJson, yielding every node (including _renderChildren). */
function* clientNodes(root) {
  if (!root) return;
  const stack = [root];
  while (stack.length > 0) {
    const n = stack.pop();
    if (!n || typeof n !== 'object') continue;
    yield n;
    for (const c of n.children ?? []) stack.push(c);
    for (const c of n._renderChildren ?? []) stack.push(c);
  }
}

function classifyLoss(key) {
  if (EXPECTED_LOSS_KEYS.has(key)) return { expected: true, rule: key };
  // Nested paths under a known-dropped root also count as expected.
  for (const k of EXPECTED_LOSS_KEYS) {
    if (key === k || key.startsWith(`${k}.`) || key.startsWith(`${k}[`)) {
      return { expected: true, rule: k };
    }
  }
  return { expected: false, rule: null };
}

function classifyExtra(key) {
  // Top-level segment.
  const seg = key.split(/[.[]/, 1)[0];
  if (EXPECTED_SYNTH_KEYS.has(seg)) return true;
  if (seg.startsWith(EXPECTED_SYNTH_PREFIX)) return true;
  return false;
}

function topN(map, n) {
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n);
}

async function auditOne(figPath) {
  const absPath = repoPath(figPath);
  if (!existsSync(absPath)) throw new Error(`not found: ${absPath}`);
  const name = basename(absPath, '.fig');
  console.log(`\n=== ${name} ===`);

  const origBytes = new Uint8Array(readFileSync(absPath));
  const upload = await uploadFig(origBytes, basename(absPath));
  const doc = await fetchDoc(upload.sessionId);

  const canvas = extractCanvasFig(origBytes);
  const decoded = decodeFigCanvas(canvas);
  const rawNodes = (decoded.message?.nodeChanges ?? []);
  console.log(`  raw nodes: ${rawNodes.length.toLocaleString()}`);

  const rawSide = collectFields(rawNodes, 'raw');
  const clientNodeArr = [...clientNodes(doc)];
  console.log(`  client nodes: ${clientNodeArr.length.toLocaleString()}`);
  const clientSide = collectFields(clientNodeArr, 'client');

  // Classify per (type, key)
  const byType = {};
  let pres = 0, lostExp = 0, lostUnexp = 0, extraExp = 0, extraUnexp = 0;
  const allTypes = new Set([...rawSide.byType.keys(), ...clientSide.byType.keys()]);
  for (const type of allTypes) {
    const rawMap = rawSide.byType.get(type) ?? new Map();
    const cliMap = clientSide.byType.get(type) ?? new Map();
    const allKeys = new Set([...rawMap.keys(), ...cliMap.keys()]);
    const presList = [];
    const lostExpList = [];
    const lostUnexpList = [];
    const extraExpList = [];
    const extraUnexpList = [];
    for (const k of allKeys) {
      const inRaw = rawMap.has(k);
      const inCli = cliMap.has(k);
      if (inRaw && inCli) {
        pres++;
        presList.push([k, rawMap.get(k)]);
      } else if (inRaw && !inCli) {
        const c = classifyLoss(k);
        if (c.expected) {
          lostExp++;
          lostExpList.push([k, rawMap.get(k), c.rule]);
        } else {
          lostUnexp++;
          lostUnexpList.push([k, rawMap.get(k)]);
        }
      } else {
        const expected = classifyExtra(k);
        if (expected) {
          extraExp++;
          extraExpList.push([k, cliMap.get(k)]);
        } else {
          extraUnexp++;
          extraUnexpList.push([k, cliMap.get(k)]);
        }
      }
    }
    presList.sort((a, b) => b[1] - a[1]);
    lostExpList.sort((a, b) => b[1] - a[1]);
    lostUnexpList.sort((a, b) => b[1] - a[1]);
    extraExpList.sort((a, b) => b[1] - a[1]);
    extraUnexpList.sort((a, b) => b[1] - a[1]);
    byType[type] = {
      nodeCount: rawSide.byType.get(type)
        ? [...(rawSide.byType.get(type)?.values() ?? [])][0] ?? 0
        : 0,
      presentBoth: presList.slice(0, 30),
      lostExpected: lostExpList.slice(0, 30),
      lostUnexpected: lostUnexpList.slice(0, 30),
      extraExpected: extraExpList.slice(0, 30),
      extraUnexpected: extraUnexpList.slice(0, 30),
    };
  }

  const out = {
    fixture: figPath,
    origBytes: origBytes.length,
    rawNodes: rawNodes.length,
    clientNodes: clientNodeArr.length,
    expectedLossRules: [...EXPECTED_LOSS_KEYS],
    expectedSynthRules: [...EXPECTED_SYNTH_KEYS, '_<prefix>'],
    summary: {
      totalFields: pres + lostExp + lostUnexp + extraExp + extraUnexp,
      presentBoth: pres,
      lostExpected: lostExp,
      lostUnexpected: lostUnexp,
      extraExpected: extraExp,
      extraUnexpected: extraUnexp,
      serializationFailures: rawSide.serializationFailures.length,
    },
    byType,
    serializationFailures: rawSide.serializationFailures,
  };

  const dir = resolve(OUT_ROOT, name);
  mkdirSync(dir, { recursive: true });
  const outPath = resolve(dir, 'coverage.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`  totalFields: ${out.summary.totalFields.toLocaleString()}`);
  console.log(`    presentBoth: ${pres}, lostExp: ${lostExp}, lostUnexp: ${lostUnexp}, extraExp: ${extraExp}, extraUnexp: ${extraUnexp}`);
  console.log(`    serialization failures: ${out.summary.serializationFailures}`);
  // Top-3 unexpected loss / synthesis
  const allLostUnexp = [];
  const allExtraUnexp = [];
  for (const [type, t] of Object.entries(byType)) {
    for (const [k, c] of t.lostUnexpected) allLostUnexp.push([`${type}.${k}`, c]);
    for (const [k, c] of t.extraUnexpected) allExtraUnexp.push([`${type}.${k}`, c]);
  }
  allLostUnexp.sort((a, b) => b[1] - a[1]);
  allExtraUnexp.sort((a, b) => b[1] - a[1]);
  if (allLostUnexp.length > 0) {
    console.log(`  top unexpected loss:`);
    for (const [k, c] of allLostUnexp.slice(0, 5)) console.log(`    ${k} (${c})`);
  }
  if (allExtraUnexp.length > 0) {
    console.log(`  top unexpected synthesis:`);
    for (const [k, c] of allExtraUnexp.slice(0, 5)) console.log(`    ${k} (${c})`);
  }
  console.log(`  → ${outPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const fixtures = args.length > 0 ? args : DEFAULT_FIXTURES;
  let failed = 0;
  for (const f of fixtures) {
    try {
      await auditOne(f);
    } catch (e) {
      console.error(`[!] ${f}: ${e?.message ?? e}`);
      failed++;
    }
  }
  if (failed > 0) console.log(`\n(${failed} fixture(s) failed)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
