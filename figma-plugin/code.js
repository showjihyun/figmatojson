// Plugin sandbox — runs inside Figma. Walks the current page tree on
// request and emits a normalized JSON view through postMessage to the UI.
//
// Phase 2 MVP scope: emit a *minimal but comparable* shape — only the
// fields our parser also produces. The UI ships this to the backend
// where it gets structural-diffed against the same .fig parsed by us.

figma.showUI(__html__, { width: 480, height: 640 });

function serializeNode(node) {
  // Figma SceneNode shape — see https://www.figma.com/plugin-docs/api/nodes/
  // We omit fields that aren't comparable with our parser's output (e.g.
  // Figma-runtime-only props like reactions, prototyping). Add fields here
  // as we expand the diff coverage.
  const out = {
    id: node.id,
    type: node.type,
    name: node.name,
    visible: node.visible,
  };

  if ('width' in node && 'height' in node) {
    out.size = { x: node.width, y: node.height };
  }
  // x/y are absolute relative to parent — match our transform.m02/m12.
  if ('x' in node && 'y' in node) {
    out.transform = { m02: node.x, m12: node.y };
  }
  if ('rotation' in node && node.rotation !== 0) {
    out.rotation = node.rotation;
  }
  if ('opacity' in node && node.opacity !== 1) {
    out.opacity = node.opacity;
  }
  if ('fills' in node && Array.isArray(node.fills)) {
    out.fills = node.fills.map(serializeFill);
  }
  // strokes — emit empty array when present so the audit `strokes.length`
  // comparison can disambiguate "field absent" from "0 strokes".
  // strokeWeight — emit only when strokes are non-empty; the underlying
  // plugin API still reports the kiwi value (often 1) even on shapes that
  // have no strokes, but that value is dead data and only churns audit
  // signal. Pair it with strokes presence to match REST API behavior.
  if ('strokes' in node && Array.isArray(node.strokes)) {
    out.strokes = node.strokes.map(serializeFill);
    if (node.strokes.length > 0 && typeof node.strokeWeight === 'number') {
      out.strokeWeight = node.strokeWeight;
    }
  }
  if ('cornerRadius' in node && typeof node.cornerRadius === 'number' && node.cornerRadius !== 0) {
    out.cornerRadius = node.cornerRadius;
  }
  if (node.type === 'TEXT') {
    out.characters = node.characters;
    out.fontSize = node.fontSize;
    if (node.fontName && typeof node.fontName === 'object') {
      out.fontName = { family: node.fontName.family, style: node.fontName.style };
    }
  }
  // Auto-layout — match our parser's stack* fields where comparable.
  if ('layoutMode' in node && node.layoutMode && node.layoutMode !== 'NONE') {
    out.stackMode = node.layoutMode; // HORIZONTAL | VERTICAL
    out.stackSpacing = node.itemSpacing;
    out.stackPaddingLeft = node.paddingLeft;
    out.stackPaddingRight = node.paddingRight;
    out.stackPaddingTop = node.paddingTop;
    out.stackPaddingBottom = node.paddingBottom;
    out.stackPrimaryAlignItems = node.primaryAxisAlignItems;
    out.stackCounterAlignItems = node.counterAxisAlignItems;
  }

  if ('children' in node && Array.isArray(node.children)) {
    out.children = node.children.map(serializeNode);
  }
  return out;
}

function serializeFill(p) {
  if (!p || p.type !== 'SOLID') return { type: p && p.type };
  return {
    type: 'SOLID',
    color: { r: p.color.r, g: p.color.g, b: p.color.b },
    opacity: p.opacity == null ? 1 : p.opacity,
    visible: p.visible !== false,
  };
}

figma.ui.onmessage = (msg) => {
  if (msg.type === 'serialize-current-page') {
    try {
      const tree = serializeNode(figma.currentPage);
      figma.ui.postMessage({ type: 'serialize-result', tree });
    } catch (err) {
      figma.ui.postMessage({ type: 'serialize-error', error: String(err && err.message || err) });
    }
  } else if (msg.type === 'close') {
    figma.closePlugin();
  }
};
