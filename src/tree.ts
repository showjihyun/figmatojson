/**
 * Iteration 5: 노드 트리 재구성 (PRD §4.2 F-PROC-05)
 *
 * 입력: NodeChanges 메시지
 * 출력: parent-child 링크된 트리 (DOCUMENT → CANVAS(Page) → ...)
 *
 * 각 nodeChange는 guid (sessionID, localID)와 parentIndex (parent guid + position 문자열)를 가진다.
 * position은 "fractional indexing" 문자열로, 형제 정렬에 사용.
 */

import type { BuildTreeResult, GUID, KiwiMessage, KiwiNode, TreeNode } from './types.js';

export function guidKey(g: GUID | undefined): string {
  if (!g) return '';
  return `${g.sessionID ?? 0}:${g.localID ?? 0}`;
}

export function buildTree(message: KiwiMessage): BuildTreeResult {
  const nodeChanges = (message.nodeChanges ?? []) as KiwiNode[];
  const allNodes = new Map<string, TreeNode>();

  // Pass 1: 모든 노드 객체 생성
  for (const nc of nodeChanges) {
    if (!nc.guid) continue;
    const key = guidKey(nc.guid);
    if (!key) continue;

    const tn: TreeNode = {
      guid: nc.guid,
      guidStr: key,
      type: typeof nc.type === 'string' ? nc.type : 'NONE',
      name: typeof nc.name === 'string' ? nc.name : undefined,
      parentGuid: nc.parentIndex?.guid,
      position: nc.parentIndex?.position,
      children: [],
      data: nc,
    };
    allNodes.set(key, tn);
  }

  // Pass 2: parent 링크 설정
  let document: TreeNode | null = null;
  const orphans: TreeNode[] = [];

  for (const tn of allNodes.values()) {
    if (!tn.parentGuid || guidKey(tn.parentGuid) === '') {
      // 부모 없음 → DOCUMENT 후보 또는 root orphan
      if (tn.type === 'DOCUMENT') {
        if (!document) {
          document = tn;
        } else {
          // 여러 DOCUMENT가 있으면 첫 번째를 진짜 문서로, 나머지는 orphans
          orphans.push(tn);
        }
      } else {
        orphans.push(tn);
      }
      continue;
    }

    const parent = allNodes.get(guidKey(tn.parentGuid));
    if (parent) {
      parent.children.push(tn);
    } else {
      orphans.push(tn);
    }
  }

  // Pass 3: position 문자열로 형제 정렬 (fractional indexing)
  const sortChildren = (tn: TreeNode): void => {
    tn.children.sort((a, b) => {
      const pa = a.position ?? '';
      const pb = b.position ?? '';
      if (pa < pb) return -1;
      if (pa > pb) return 1;
      return 0;
    });
    for (const c of tn.children) sortChildren(c);
  };
  if (document) sortChildren(document);
  for (const o of orphans) sortChildren(o);

  return { document, allNodes, orphans };
}

/** DOCUMENT의 직속 자식 = 페이지(CANVAS 노드들) */
export function getPages(document: TreeNode | null): TreeNode[] {
  if (!document) return [];
  return document.children.filter((c) => c.type === 'CANVAS');
}
