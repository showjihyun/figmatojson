/**
 * Plugin trial simulation via Figma REST API.
 *
 * Acts as a stand-in for the Figma Desktop plugin: instead of having a
 * human run the plugin in Figma's UI to serialize `figma.currentPage`,
 * we fetch the same file via Figma's REST API (`/v1/files/:key`) and
 * adapt the response to the same shape `figma-plugin/code.js` would
 * emit. Then POST to our `/api/audit/compare` with the local .fig as
 * the comparison target.
 *
 * Caveats vs. a real plugin trial:
 *   - REST returns *file* state (current online); plugin would return
 *     the desktop client's loaded state. Same source file → same
 *     content in practice.
 *   - REST coords are `absoluteBoundingBox` (absolute pixels). We
 *     convert back to parent-relative to match our `transform.m02/m12`
 *     by subtracting the parent's absolute origin during the walk.
 *
 * Pre-reqs: web backend up at :5274. .env.local has FIGMA_TOKEN +
 * FIGMA_FILE_KEY_BVP (and/or FIGMA_FILE_KEY for metarich).
 *
 *   node web/scripts/audit-rest-as-plugin.mjs                 # default = bvp
 *   node web/scripts/audit-rest-as-plugin.mjs metarich        # use FIGMA_FILE_KEY
 *   node web/scripts/audit-rest-as-plugin.mjs bvp metarich    # both
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const BACKEND = process.env.AUDIT_BACKEND ?? 'http://localhost:5274';

const CORPORA = {
  bvp: { figPath: 'docs/bvp.fig', keyEnv: 'FIGMA_FILE_KEY_BVP' },
  metarich: { figPath: 'docs/메타리치 화면 UI Design.fig', keyEnv: 'FIGMA_FILE_KEY' },
};

function loadEnv() {
  const env = {};
  const path = resolve(REPO_ROOT, '.env.local');
  if (!existsSync(path)) throw new Error(`missing ${path}`);
  for (const line of readFileSync(path, 'utf-8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

async function fetchFile(token, fileKey) {
  const url = `https://api.figma.com/v1/files/${fileKey}`;
  const res = await fetch(url, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) throw new Error(`Figma API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

/**
 * Walk the REST API tree and produce the same shape `figma-plugin/code.js`
 * `serializeNode` emits. Keeps fields aligned with COMPARABLE_FIELDS
 * in `web/core/application/AuditCompare.ts`.
 *
 * @param node REST API DocumentNode
 * @param parentAbs { x, y } absolute origin of the parent (for transform conversion)
 */
function adaptNode(node, parentAbs = { x: 0, y: 0 }) {
  const out = {
    id: node.id,
    type: node.type,
    name: node.name,
    visible: node.visible !== false,
  };
  const bbox = node.absoluteBoundingBox;
  if (bbox) {
    out.size = { x: bbox.width, y: bbox.height };
    out.transform = { m02: bbox.x - parentAbs.x, m12: bbox.y - parentAbs.y };
  }
  if (typeof node.opacity === 'number' && node.opacity !== 1) out.opacity = node.opacity;
  if (typeof node.rotation === 'number' && node.rotation !== 0) out.rotation = node.rotation;
  if (typeof node.cornerRadius === 'number' && node.cornerRadius !== 0) out.cornerRadius = node.cornerRadius;
  // Always emit fills/strokes arrays (even empty) so the audit `fills.length`
  // / `strokes.length` comparisons aren't poisoned by adapter omission.
  // strokeWeight likewise — REST emits it on every shape regardless of
  // whether `strokes` has entries.
  if (Array.isArray(node.fills)) out.fills = node.fills.map(adaptFill);
  if (Array.isArray(node.strokes)) out.strokes = node.strokes.map(adaptFill);
  if (typeof node.strokeWeight === 'number') out.strokeWeight = node.strokeWeight;
  if (node.type === 'TEXT') {
    out.characters = node.characters;
    if (node.style) {
      out.fontSize = node.style.fontSize;
      if (node.style.fontFamily || node.style.fontPostScriptName) {
        // PostScript names use `<family-no-spaces>-<style>` but `fontFamily`
        // can be a different display string (e.g. fontFamily="Pretendard"
        // postScriptName="PretendardVariable-Medium"). Strip the trailing
        // `-<style>` segment from the PS name regardless of family match.
        const ps = node.style.fontPostScriptName;
        const dash = typeof ps === 'string' ? ps.lastIndexOf('-') : -1;
        out.fontName = {
          family: node.style.fontFamily,
          style: dash > 0 ? ps.slice(dash + 1) : (typeof ps === 'string' ? ps : undefined),
        };
      }
    }
  }
  // Auto-layout — REST exposes these on FRAME-like nodes when layoutMode set.
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    out.stackMode = node.layoutMode;
    out.stackSpacing = node.itemSpacing;
    out.stackPaddingLeft = node.paddingLeft;
    out.stackPaddingRight = node.paddingRight;
    out.stackPaddingTop = node.paddingTop;
    out.stackPaddingBottom = node.paddingBottom;
    out.stackPrimaryAlignItems = node.primaryAxisAlignItems;
    out.stackCounterAlignItems = node.counterAxisAlignItems;
  }
  if (Array.isArray(node.children) && node.children.length > 0) {
    // GROUP transparency — Figma's plugin API treats GROUP as having no
    // transform space, so children's `node.x/y` are relative to the
    // closest non-GROUP ancestor. Mirror that here so REST trial signal
    // matches Plugin trial signal (and our parser's group-flatten in
    // AuditCompare's `indexById`).
    const childParentAbs = node.type === 'GROUP'
      ? parentAbs
      : (bbox ? { x: bbox.x, y: bbox.y } : parentAbs);
    out.children = node.children.map((c) => adaptNode(c, childParentAbs));
  }
  return out;
}

function adaptFill(p) {
  if (!p || p.type !== 'SOLID') return { type: p && p.type };
  return {
    type: 'SOLID',
    color: p.color ? { r: p.color.r, g: p.color.g, b: p.color.b } : undefined,
    opacity: p.opacity == null ? 1 : p.opacity,
    visible: p.visible !== false,
  };
}

async function uploadFig(figPath) {
  const abs = resolve(REPO_ROOT, figPath);
  if (!existsSync(abs)) throw new Error(`fixture ${abs} not found`);
  const bytes = readFileSync(abs);
  const fd = new FormData();
  fd.append('file', new Blob([bytes]), basename(abs));
  const res = await fetch(`${BACKEND}/api/upload`, { method: 'POST', body: fd });
  if (!res.ok) throw new Error(`upload ${res.status}`);
  return res.json();
}

async function compare(sessionId, figmaTree) {
  const res = await fetch(`${BACKEND}/api/audit/compare`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId, figmaTree }),
  });
  if (!res.ok) throw new Error(`compare ${res.status}`);
  return res.json();
}

async function auditOne(name, env) {
  const cfg = CORPORA[name];
  if (!cfg) throw new Error(`unknown corpus ${name} (use bvp or metarich)`);
  const token = env.FIGMA_TOKEN;
  const fileKey = env[cfg.keyEnv];
  if (!token) throw new Error('FIGMA_TOKEN missing in .env.local');
  if (!fileKey) throw new Error(`${cfg.keyEnv} missing in .env.local`);

  console.log(`\n=== ${name} ===`);
  console.log(`  fetching REST: ${cfg.keyEnv}=${fileKey.slice(0, 8)}…`);
  const restJson = await fetchFile(token, fileKey);
  const figmaTree = adaptNode(restJson.document);

  console.log(`  uploading local: ${cfg.figPath}`);
  const upload = await uploadFig(cfg.figPath);
  console.log(`  upload sessionId=${upload.sessionId} pages=${upload.pageCount} nodes=${upload.nodeCount}`);

  console.log('  comparing…');
  const report = await compare(upload.sessionId, figmaTree);
  const s = report.summary;
  console.log(`  figmaNodes=${s.figmaNodeCount} ourNodes=${s.ourNodeCount} matched=${s.matchedNodes} onlyInFigma=${s.onlyInFigma} onlyInOurs=${s.onlyInOurs} totalDiffs=${s.totalDiffs}`);
  console.log('  top differing fields:');
  for (const tf of report.topFields.slice(0, 15)) {
    console.log(`    ${String(tf.count).padStart(7)}  ${tf.field}`);
  }
  if (report.sample.length) {
    console.log('  first 5 sample diffs:');
    for (const sm of report.sample.slice(0, 5)) {
      console.log(`    [${sm.id}] ${sm.field}: figma=${JSON.stringify(sm.origValue)} ours=${JSON.stringify(sm.rtValue)}`);
    }
  }
}

async function main() {
  const env = loadEnv();
  const args = process.argv.slice(2);
  const names = args.length > 0 ? args : ['bvp'];
  for (const n of names) {
    try { await auditOne(n, env); }
    catch (err) { console.error(`  ERR ${n}: ${err.message}`); }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
