/**
 * figma.editable.css — 편집 가능 HTML의 기본 스타일.
 * 페이지를 캔버스처럼 보이게 하고, 편집 가능 영역 시각 표시.
 */

export function renderEditableCss(): string {
  return `/* figma-reverse editable HTML — Figma-like canvas styles
   웹 폰트는 HTML <link> 태그에서 로드 (CSS @import는 더 느리고 일부 브라우저에서 cascade 깨짐).
   본 CSS는 system font fallback chain만 책임. */

/* Reset — 모든 element의 margin/padding 0, font 상속 */
*, *::before, *::after {
  box-sizing: border-box;
  margin: 0;
  padding: 0;
  font-family: inherit;
  font-size: inherit;
  line-height: inherit;
}

/* HTML5 semantic elements가 inline 또는 inline-block default일 수도 — block으로 통일 */
main, section, article, aside, header, footer, nav, figure { display: block; }

html, body {
  margin: 0;
  padding: 0;
  font-family:
    'Inter', 'Pretendard',
    -apple-system, BlinkMacSystemFont, 'Segoe UI',
    'Apple SD Gothic Neo',         /* macOS 한글 */
    'Malgun Gothic', '맑은 고딕',  /* Windows 한글 */
    'Noto Sans KR',
    Roboto, sans-serif;
  background-color: #1e1e1e;
  color: #e6e6e6;
  font-size: 13px;
  line-height: 1.4;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  /* Figma-style 캔버스 grid 배경 (점 점 점) */
  background-image:
    radial-gradient(circle, rgba(255,255,255,0.04) 1px, transparent 1px);
  background-size: 24px 24px;
  min-height: 100vh;
}

main.fig-document {
  display: flex !important;  /* reset의 main {block}을 override */
  flex-direction: column;
  align-items: flex-start;
  gap: 80px;
  padding: 60px 40px;
  min-width: 100%;
  width: max-content;
}

section.fig-page {
  display: block;
  position: relative;
  box-shadow: 0 8px 40px rgba(0, 0, 0, 0.6);
  flex-shrink: 0;
  /* inline style의 background, width, height 우선 */
  /* background 없는 페이지에 fallback (CSS variable 트릭) */
  background-color: rgba(255, 255, 255, 0.03);
  outline: 1px solid rgba(255, 255, 255, 0.08);
  outline-offset: 0;
}

section.fig-page::before {
  content: attr(data-figma-name);
  position: absolute;
  left: 0;
  top: -32px;
  color: #999;
  font-size: 12px;
  font-weight: 600;
  pointer-events: none;
  white-space: nowrap;
}

/* 페이지 안의 모든 노드는 inline style의 position/size로 배치 */
.fig-node {
  font-size: inherit;
  line-height: 1.2;
  overflow: visible;  /* inline style의 overflow:hidden (clipsContent) 우선 */
  /* 텍스트 색은 노드별 inline style에서 결정 — 부모에서 상속 막기 */
  color: inherit;
}

/* TEXT 노드는 white-space pre-wrap (Figma 기본) */
.fig-text {
  white-space: pre-wrap;
  overflow-wrap: break-word;
  /* 폰트 크기·색·줄높이는 inline style에서 결정 */
}

/* VECTOR — inline SVG 임베드 (img 대신). fill·viewBox·currentColor 모두 정확 */
.fig-vector > svg {
  display: block;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}
/* SVG 안의 path 기본은 자체 fill 사용. 일부 SVG는 fill 없을 때 currentColor 동작 */
.fig-vector > svg > * {
  /* SVG 내부 element들 — 별도 reset 불필요 */
}

/* fig-meta(VARIABLE_SET, BRUSH 등 데이터 정의 노드) — 시각 표시 안 함.
   inline style의 display:none이 우선이지만 안전망. */
.fig-meta { display: none !important; }

/* 알 수 없는 타입에 대한 디버깅 outline (의도된 fig-unknown 클래스용 — 현재는 fig-meta로 대체) */
.fig-unknown {
  outline: 1px dashed rgba(247, 181, 0, 0.5);
  outline-offset: -1px;
}

/* SECTION (Figma 그룹 컨테이너)에 약한 outline */
.fig-section {
  /* inline style 우선이지만 약한 visual 표시 */
}

/* 편집 가능 영역 hover hint (devtools 친화) */
.fig-node[data-figma-editable]:hover {
  outline: 1px dashed #0d99ff;
  outline-offset: -1px;
}

/* INSTANCE는 컴포넌트라 약한 보라색 outline */
.fig-instance {
  /* inline style 그대로 사용. 필요 시 디버깅을 위해 outline 추가 가능 */
}

/* INSTANCE 안의 master clone — readonly 표시 (옅은 색) */
.fig-instance-clone {
  /* 시각은 동일하게 보이되 클릭 시 편집 안 됨을 미세하게 표시 */
  pointer-events: auto;
}

/* 인쇄·내보내기 시 배경 grid 제거 */
@media print {
  body { background-image: none; background: white; }
}
`;
}
