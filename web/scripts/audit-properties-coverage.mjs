/**
 * Round 17 — component / variable properties coverage.
 *
 *   node web/scripts/audit-properties-coverage.mjs           # default fixtures
 *   node web/scripts/audit-properties-coverage.mjs <path>... # specific
 *
 * Pre-req: web backend up at :5274 (`cd web && npm run dev:server`).
 *
 * Validates the structural integrity of design-system metadata:
 *   - componentPropDef ↔ componentPropAssignment matching (P4/P5)
 *   - VARIABLE alias chain reachability (P6)
 *   - VARIABLE_SET → VARIABLE references (P7)
 *
 * Output: docs/audit-raw-coverage/<fixture>/properties.json + console.
 *
 * Spec: docs/specs/audit-raw-coverage.spec.md §4
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname, isAbsolute, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND = process.env.AUDIT_BACKEND ?? 'http://localhost:5274';
const OUT_ROOT = resolve(REPO_ROOT, 'docs', 'audit-raw-coverage');

const DEFAULT_FIXTURES = [
  'docs/bvp.fig',
  'docs/메타리치 화면 UI Design.fig',
];

function repoPath(p) { return isAbsolute(p) ? p : resolve(REPO_ROOT, p); }

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

/** Walk every node in the client doc (including _renderChildren). */
function* allNodes(root) {
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

function idOf(n) {
  return typeof n.id === 'string' ? n.id : null;
}

function guidStr(g) {
  if (!g || typeof g !== 'object') return null;
  if (typeof g.sessionID !== 'number' || typeof g.localID !== 'number') return null;
  return `${g.sessionID}:${g.localID}`;
}

/** Build parent-id index by scanning the client tree. */
function buildParentIndex(root) {
  const parent = new Map();
  function go(n, p) {
    if (!n) return;
    const id = idOf(n);
    if (id && p) parent.set(id, p);
    for (const c of n.children ?? []) go(c, id);
    for (const c of n._renderChildren ?? []) go(c, id);
  }
  go(root, null);
  return parent;
}

function nearestComponentMaster(parentMap, byId, startId) {
  let cur = startId;
  while (cur) {
    const n = byId.get(cur);
    if (n && (
      n.type === 'SYMBOL' ||
      n.type === 'COMPONENT_SET' ||
      n.isStateGroup === true ||
      (Array.isArray(n.componentPropDefs) && n.componentPropDefs.length > 0)
    )) {
      return n;
    }
    cur = parentMap.get(cur);
  }
  return null;
}

async function auditOne(figPath) {
  const absPath = repoPath(figPath);
  if (!existsSync(absPath)) throw new Error(`not found: ${absPath}`);
  const name = basename(absPath, '.fig');
  console.log(`\n=== ${name} ===`);

  const origBytes = new Uint8Array(readFileSync(absPath));
  const upload = await uploadFig(origBytes, basename(absPath));
  const doc = await fetchDoc(upload.sessionId);

  const byId = new Map();
  for (const n of allNodes(doc)) {
    const id = idOf(n);
    if (id) byId.set(id, n);
  }
  const parentMap = buildParentIndex(doc);
  console.log(`  total client nodes: ${byId.size.toLocaleString()}`);

  // Collect propDefs (def.id is the GUID; matching to assignment.defID).
  const defsByMaster = new Map();   // masterId → Set<defIdString>
  const allPropDefs = [];           // { masterId, defId, type, name }
  const usedDefIds = new Set();     // defIdString seen in any assignment

  for (const n of byId.values()) {
    const defs = n.componentPropDefs;
    if (Array.isArray(defs)) {
      for (const def of defs) {
        const did = guidStr(def?.id);
        if (!did) continue;
        const masterId = idOf(n);
        if (!defsByMaster.has(masterId)) defsByMaster.set(masterId, new Set());
        defsByMaster.get(masterId).add(did);
        allPropDefs.push({
          masterId,
          defId: did,
          type: def.type ?? null,
          name: def.name ?? null,
        });
      }
    }
  }

  // Walk assignments. wire-format key is `defID` (GUID) — must match a
  // `def.id` GUID on the resolved component-master.
  //
  // Master resolution:
  //   - INSTANCE node → master via `symbolData.symbolID` GUID lookup (NOT
  //     a tree ancestor; the INSTANCE's parent in the tree is wherever it
  //     was placed, not the master that defines its props).
  //   - other nodes (e.g. SYMBOL's own children) → tree ancestor walk.
  const brokenAssignments = [];
  let propAssignmentsTotal = 0;
  for (const n of byId.values()) {
    const ass = n.componentPropAssignments ?? n.componentPropertyAssignments;
    if (!Array.isArray(ass)) continue;
    const myId = idOf(n);
    for (const a of ass) {
      const did = guidStr(a?.defID);
      if (!did) continue;
      propAssignmentsTotal++;
      usedDefIds.add(did);

      let master = null;
      if (n.type === 'INSTANCE') {
        const masterId = guidStr(n.symbolData?.symbolID);
        if (masterId) master = byId.get(masterId) ?? null;
      }
      if (!master) {
        master = nearestComponentMaster(parentMap, byId, parentMap.get(myId) ?? myId);
      }
      const ancestorId = master ? idOf(master) : null;
      const allowed = ancestorId && defsByMaster.get(ancestorId);
      if (!allowed || !allowed.has(did)) {
        if (brokenAssignments.length < 50) {
          brokenAssignments.push({ instanceId: myId, defId: did, ancestorId });
        }
      }
    }
  }

  // Orphan defs (defined but never assigned anywhere)
  const orphanDefs = [];
  for (const d of allPropDefs) {
    if (!usedDefIds.has(d.defId)) {
      if (orphanDefs.length < 50) orphanDefs.push(d);
    }
  }

  // VARIABLE chain reachability
  const variables = [];
  for (const n of byId.values()) {
    if (n.type === 'VARIABLE') variables.push(n);
  }
  const brokenVariableChains = [];
  for (const v of variables) {
    const entries = v.variableDataValues?.entries;
    if (!Array.isArray(entries)) continue;
    for (const e of entries) {
      const data = e.variableData;
      if (!data) continue;
      const dt = data.dataType;
      if (dt !== 'ALIAS') continue;
      // Walk the alias chain up to 8 hops to detect cycle / dead-end.
      const chainHeads = [];
      let cur = data.value?.alias?.guid;
      const seen = new Set();
      let ok = false;
      let dead = false;
      for (let i = 0; i < 8; i++) {
        const id = guidStr(cur);
        if (!id) { dead = true; break; }
        if (seen.has(id)) { dead = true; chainHeads.push(`cycle@${id}`); break; }
        seen.add(id);
        chainHeads.push(id);
        const next = byId.get(id);
        if (!next) { dead = true; break; }
        if (next.type !== 'VARIABLE') { ok = true; break; }
        const nextEntries = next.variableDataValues?.entries;
        const nextAlias = nextEntries?.[0]?.variableData;
        if (!nextAlias || nextAlias.dataType !== 'ALIAS') { ok = true; break; }
        cur = nextAlias.value?.alias?.guid;
      }
      if (dead && !ok) {
        if (brokenVariableChains.length < 50) {
          brokenVariableChains.push({
            variableId: idOf(v),
            chainHeads,
            dataType: data.resolvedDataType ?? null,
          });
        }
      }
    }
  }

  // VARIABLE_SET → references
  const danglingVariableRefs = [];
  for (const n of byId.values()) {
    if (n.type !== 'VARIABLE_SET') continue;
    const refs = [];
    for (const lv of n.localVariables ?? []) {
      const id = guidStr(lv?.guid ?? lv);
      if (!id) continue;
      if (!byId.has(id)) refs.push(id);
    }
    if (refs.length > 0 && danglingVariableRefs.length < 50) {
      danglingVariableRefs.push({ setId: idOf(n), refs });
    }
  }

  const out = {
    fixture: figPath,
    summary: {
      componentPropDefsTotal: allPropDefs.length,
      componentPropDefsOrphan: allPropDefs.filter((d) => !usedDefIds.has(d.defId)).length,
      propAssignmentsTotal,
      propAssignmentsBroken: brokenAssignments.length,
      variablesTotal: variables.length,
      variableChainsBroken: brokenVariableChains.length,
      danglingVariableRefs: danglingVariableRefs.length,
    },
    brokenAssignments,
    orphanDefs,
    brokenVariableChains,
    danglingVariableRefs,
  };

  const dir = resolve(OUT_ROOT, name);
  mkdirSync(dir, { recursive: true });
  const outPath = resolve(dir, 'properties.json');
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  const s = out.summary;
  console.log(`  componentPropDefs: ${s.componentPropDefsTotal} (orphan ${s.componentPropDefsOrphan})`);
  console.log(`  componentPropAssignments: ${s.propAssignmentsTotal} (broken ${s.propAssignmentsBroken})`);
  console.log(`  VARIABLEs: ${s.variablesTotal} (broken chains ${s.variableChainsBroken})`);
  console.log(`  dangling variable refs: ${s.danglingVariableRefs}`);
  if (brokenAssignments.length > 0) {
    console.log(`  top broken assignments:`);
    for (const b of brokenAssignments.slice(0, 3)) {
      console.log(`    ${b.instanceId} → defId ${b.defId} (ancestor=${b.ancestorId})`);
    }
  }
  if (orphanDefs.length > 0) {
    console.log(`  top orphan defs:`);
    for (const d of orphanDefs.slice(0, 3)) {
      console.log(`    ${d.masterId} defId ${d.defId} ${d.name ? `"${d.name}" ` : ''}(${d.type})`);
    }
  }
  console.log(`  → ${outPath}`);
}

async function main() {
  const args = process.argv.slice(2);
  const fixtures = args.length > 0 ? args : DEFAULT_FIXTURES;
  let failed = 0;
  for (const f of fixtures) {
    try { await auditOne(f); } catch (e) {
      console.error(`[!] ${f}: ${e?.message ?? e}`);
      failed++;
    }
  }
  if (failed > 0) console.log(`\n(${failed} fixture(s) failed)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
