/**
 * 공통 타입 정의 — kiwi-decoded 결과는 동적이므로 일부 필드는 unknown/any 사용
 */

export interface GUID {
  sessionID: number;
  localID: number;
}

export interface FigClientMeta {
  background_color?: { r: number; g: number; b: number; a: number };
  thumbnail_size?: { width: number; height: number };
  render_coordinates?: { x: number; y: number; width: number; height: number };
}

export interface FigMetaJson {
  client_meta?: FigClientMeta;
  file_name?: string;
  developer_related_links?: unknown[];
  exported_at?: string;
  [key: string]: unknown;
}

/** 컨테이너 분해 결과 */
export interface ContainerResult {
  isZipWrapped: boolean;
  canvasFig: Uint8Array;
  metaJson?: FigMetaJson;
  thumbnail?: Uint8Array;
  /** 원본 파일명(해시) → 바이트. 확장자는 추출 시 magic으로 추론 */
  images: Map<string, Uint8Array>;
}

/** fig-kiwi 아카이브 분해 결과 */
export interface FigArchive {
  prelude: string;
  version: number;
  /** 첫 번째 = schema, 두 번째 = data (일반적). 추가 청크는 보존만. */
  chunks: Uint8Array[];
}

/** 압축 알고리즘 자동 감지 결과 */
export type Compression = 'deflate-raw' | 'deflate-zlib' | 'zstd' | 'unknown';

/** kiwi-schema의 디코드된 메시지는 동적 객체 */
export type KiwiMessage = Record<string, unknown> & {
  type?: string;
  nodeChanges?: KiwiNode[];
  blobs?: Array<{ bytes: Uint8Array }>;
};

export type KiwiNode = Record<string, unknown> & {
  guid?: GUID;
  type?: string;
  name?: string;
  parentIndex?: { guid: GUID; position: string };
  phase?: string;
};

/** 트리 노드 — Kiwi 노드 + 부모/자식 링크 */
export interface TreeNode {
  guid: GUID;
  guidStr: string;
  type: string;
  name?: string;
  parentGuid?: GUID;
  position?: string;
  children: TreeNode[];
  /** Kiwi 원본 노드 데이터 */
  data: KiwiNode;
}

export interface BuildTreeResult {
  document: TreeNode | null;
  allNodes: Map<string, TreeNode>;
  orphans: TreeNode[];
}

export interface ExtractStats {
  totalNodes: number;
  pages: number;
  topLevelFrames: number;
  imagesReferenced: number;
  imagesUnused: number;
  vectorsConverted: number;
  vectorsFailed: number;
  unknownTypes: Record<string, number>;
}
