/**
 * Re-derive the client-tree `Document` from a raw message.json string.
 *
 * The leaf chat tools (set_text, set_position, ...) mutate `documentJson`
 * in-place because the change is narrow. Structural tools (duplicate,
 * group, ungroup) add or rearrange nodes, so the parent-child relations
 * encoded by `parentIndex.guid + position` change globally — there is no
 * narrow mutation that keeps `documentJson` in sync. This helper runs
 * the same buildTree → toClientNode pipeline used at upload / snapshot-
 * load and yields a fresh tree the caller assigns to `session.documentJson`.
 *
 * The reviver restores Uint8Array values from `{__bytes: <base64>}` so
 * blobs (vector networks, images) come through usable; without it
 * toClientNode emits broken vector paths.
 *
 * Server-side only — uses Node's Buffer for base64 decoding. That matches
 * the existing LoadSnapshot path.
 */

import { buildTree } from '../../../src/tree.js';
import type { TreeNode } from '../../../src/types.js';
import { buildSymbolIndex, toClientNode } from './clientNode';
import type { Document } from './entities/Document';

export function rebuildDocumentFromMessage(messageJsonRaw: string): Document {
  const messageObj = JSON.parse(messageJsonRaw, (_, v) => {
    if (v && typeof v === 'object' && typeof (v as Record<string, unknown>).__bytes === 'string') {
      return Uint8Array.from(Buffer.from((v as { __bytes: string }).__bytes, 'base64'));
    }
    return v;
  });
  const tree = buildTree(messageObj as never);
  if (!tree.document) {
    throw new Error('messageJson has no DOCUMENT root');
  }
  const blobs = (messageObj as { blobs?: Array<{ bytes: Uint8Array }> }).blobs ?? [];
  const symbolIndex: Map<string, TreeNode> = buildSymbolIndex(tree.allNodes.values());
  return toClientNode(tree.document, blobs, symbolIndex) as Document;
}
