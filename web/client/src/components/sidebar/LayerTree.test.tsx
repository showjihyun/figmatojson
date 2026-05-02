// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';

import { LayerTree, buildAncestorIndex } from './LayerTree';

interface DocNode {
  guid?: { sessionID?: number; localID?: number };
  type?: string;
  name?: string;
  children?: DocNode[];
}

function n(localID: number, type: string, name: string, children?: DocNode[]): DocNode {
  return {
    guid: { sessionID: 0, localID },
    type,
    name,
    children,
  };
}

const PAGE: DocNode = {
  guid: { sessionID: 0, localID: 100 },
  type: 'CANVAS',
  name: 'Page 1',
  children: [
    n(1, 'FRAME', 'Header', [
      n(11, 'TEXT', 'Title'),
      n(12, 'INSTANCE', 'u:check-circle'),
    ]),
    n(2, 'FRAME', 'Body', [
      n(21, 'RECTANGLE', 'card'),
    ]),
    n(3, 'TEXT', 'Footer'),
  ],
};

describe('LayerTree', () => {
  it('renders only depth-0 children at first paint (collapsed by default)', () => {
    const onSelect = vi.fn();
    render(
      <LayerTree
        page={PAGE}
        pageKey={0}
        selectedGuids={new Set()}
        onSelect={onSelect}
      />,
    );

    // Top-level rows visible
    expect(screen.getByText('Header')).toBeTruthy();
    expect(screen.getByText('Body')).toBeTruthy();
    expect(screen.getByText('Footer')).toBeTruthy();
    // Children collapsed → not in DOM
    expect(screen.queryByText('Title')).toBeNull();
    expect(screen.queryByText('u:check-circle')).toBeNull();
  });

  it('expands a row when its chevron is clicked, revealing children', () => {
    render(
      <LayerTree
        page={PAGE}
        pageKey={0}
        selectedGuids={new Set()}
        onSelect={vi.fn()}
      />,
    );

    // Click the Expand chevron on "Header"
    const headerRow = screen.getByText('Header').closest('[role="treeitem"]')!;
    const chevron = headerRow.querySelector('button[aria-label="Expand"]')!;
    fireEvent.click(chevron);

    // Header's children now visible
    expect(screen.getByText('Title')).toBeTruthy();
    expect(screen.getByText('u:check-circle')).toBeTruthy();
    // Sibling subtree still collapsed
    expect(screen.queryByText('card')).toBeNull();
  });

  it('chevron click does NOT trigger onSelect — only row body click does', () => {
    const onSelect = vi.fn();
    render(
      <LayerTree
        page={PAGE}
        pageKey={0}
        selectedGuids={new Set()}
        onSelect={onSelect}
      />,
    );

    const headerRow = screen.getByText('Header').closest('[role="treeitem"]')!;
    const chevron = headerRow.querySelector('button[aria-label="Expand"]')!;
    fireEvent.click(chevron);
    expect(onSelect).not.toHaveBeenCalled();

    // Click the row body itself — different element from the chevron.
    fireEvent.click(headerRow);
    expect(onSelect).toHaveBeenCalledWith('0:1', 'replace');
  });

  it('shift-click on a row dispatches a toggle selection', () => {
    const onSelect = vi.fn();
    render(
      <LayerTree
        page={PAGE}
        pageKey={0}
        selectedGuids={new Set()}
        onSelect={onSelect}
      />,
    );

    const row = screen.getByText('Body').closest('[role="treeitem"]')!;
    fireEvent.click(row, { shiftKey: true });
    expect(onSelect).toHaveBeenCalledWith('0:2', 'toggle');
  });

  it('highlights rows whose guid is in selectedGuids', () => {
    render(
      <LayerTree
        page={PAGE}
        pageKey={0}
        selectedGuids={new Set(['0:2'])}
        onSelect={vi.fn()}
      />,
    );

    const bodyRow = screen.getByText('Body').closest('[role="treeitem"]')!;
    expect(bodyRow.getAttribute('aria-selected')).toBe('true');
    const headerRow = screen.getByText('Header').closest('[role="treeitem"]')!;
    expect(headerRow.getAttribute('aria-selected')).toBe('false');
  });

  it('drops expand state when pageKey changes (spec I-F2)', () => {
    function Harness() {
      const [pk, setPk] = useState(0);
      return (
        <>
          <button data-testid="next-page" onClick={() => setPk((p) => p + 1)}>next</button>
          <LayerTree
            page={PAGE}
            pageKey={pk}
            selectedGuids={new Set()}
            onSelect={vi.fn()}
          />
        </>
      );
    }
    render(<Harness />);

    // Expand Header
    const headerRow = screen.getByText('Header').closest('[role="treeitem"]')!;
    const chevron = headerRow.querySelector('button[aria-label="Expand"]')!;
    fireEvent.click(chevron);
    expect(screen.getByText('Title')).toBeTruthy();

    // Switch page → expansion should reset, Title hidden again
    fireEvent.click(screen.getByTestId('next-page'));
    expect(screen.queryByText('Title')).toBeNull();
    expect(screen.getByText('Header')).toBeTruthy();
  });

  it('shows the "No document open" placeholder when page is null', () => {
    render(
      <LayerTree
        page={null}
        pageKey={0}
        selectedGuids={new Set()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('No document open')).toBeTruthy();
  });

  it('renders <unnamed> for nodes with empty/null name', () => {
    const page: DocNode = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      name: 'p',
      children: [{ guid: { sessionID: 0, localID: 1 }, type: 'TEXT', name: '' }],
    };
    render(
      <LayerTree
        page={page}
        pageKey={0}
        selectedGuids={new Set()}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText('<unnamed>')).toBeTruthy();
  });
});

describe('LayerTree — COMPONENT_SET variant badge (spec I-F3.5)', () => {
  it('renders "(N)" next to a COMPONENT_SET row whose direct children are COMPONENTs', () => {
    const page: DocNode = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      name: 'p',
      children: [
        n(1, 'COMPONENT_SET', 'Input Box', [
          n(11, 'COMPONENT', 'Default'),
          n(12, 'COMPONENT', 'Hover'),
          n(13, 'COMPONENT', 'Focus'),
          n(14, 'COMPONENT', 'Error'),
          n(15, 'COMPONENT', 'Disabled'),
          n(16, 'COMPONENT', 'Filled'),
        ]),
      ],
    };
    render(
      <LayerTree page={page} pageKey={0} selectedGuids={new Set()} onSelect={vi.fn()} />,
    );
    const setRow = screen.getByText('Input Box').closest('[role="treeitem"]')!;
    // "(6)" is rendered next to the name with aria-label for screen readers.
    expect(setRow.textContent).toContain('(6)');
    expect(setRow.querySelector('[aria-label="6 variants"]')).toBeTruthy();
  });

  it('omits the badge when COMPONENT_SET has no COMPONENT children', () => {
    const page: DocNode = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      name: 'p',
      children: [n(1, 'COMPONENT_SET', 'Empty SET', [])],
    };
    render(
      <LayerTree page={page} pageKey={0} selectedGuids={new Set()} onSelect={vi.fn()} />,
    );
    const setRow = screen.getByText('Empty SET').closest('[role="treeitem"]')!;
    expect(setRow.querySelector('[aria-label$="variants"]')).toBeNull();
  });

  it('does not render the badge for non-COMPONENT_SET types even with children', () => {
    const page: DocNode = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      name: 'p',
      children: [
        n(1, 'FRAME', 'Header', [n(11, 'TEXT', 'a'), n(12, 'TEXT', 'b')]),
      ],
    };
    render(
      <LayerTree page={page} pageKey={0} selectedGuids={new Set()} onSelect={vi.fn()} />,
    );
    const frameRow = screen.getByText('Header').closest('[role="treeitem"]')!;
    expect(frameRow.querySelector('[aria-label$="variants"]')).toBeNull();
  });

  // Legacy Figma — the metarich pattern: a FRAME named "Button" whose
  // children are 50 SYMBOLs with `prop=value, prop=value` names. The
  // newer COMPONENT_SET branch wouldn't fire here, but our spec still
  // wants the variant affordances on this shape.
  it('shows the badge on a legacy FRAME container with variant-named SYMBOL children', () => {
    const page: DocNode = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      name: 'p',
      children: [
        n(1, 'FRAME', 'Button', [
          n(11, 'SYMBOL', 'size=XL, State=default, Type=primary'),
          n(12, 'SYMBOL', 'size=XL, State=hover, Type=primary'),
          n(13, 'SYMBOL', 'size=L, State=default, Type=primary'),
        ]),
      ],
    };
    render(
      <LayerTree page={page} pageKey={0} selectedGuids={new Set()} onSelect={vi.fn()} />,
    );
    const buttonRow = screen.getByText('Button').closest('[role="treeitem"]')!;
    expect(buttonRow.textContent).toContain('(3)');
    expect(buttonRow.querySelector('[aria-label="3 variants"]')).toBeTruthy();
  });
});

describe('LayerTree — COMPONENT_SET self-expand on selection (spec I-F11.5b)', () => {
  let scrollSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  });
  afterEach(() => {
    scrollSpy.mockRestore();
  });

  const SET_PAGE: DocNode = {
    guid: { sessionID: 0, localID: 100 },
    type: 'CANVAS',
    name: 'page',
    children: [
      n(1, 'COMPONENT_SET', 'Input Box', [
        n(11, 'COMPONENT', 'Default'),
        n(12, 'COMPONENT', 'Hover'),
        n(13, 'COMPONENT', 'Focus'),
      ]),
      n(2, 'FRAME', 'unrelated frame', [n(21, 'TEXT', 'leaf')]),
    ],
  };

  it('selecting the COMPONENT_SET expands it AND its variants become visible', () => {
    function Harness({ sel }: { sel: Set<string> }) {
      return (
        <LayerTree page={SET_PAGE} pageKey={0} selectedGuids={sel} onSelect={vi.fn()} />
      );
    }
    const { rerender } = render(<Harness sel={new Set()} />);
    // Default: SET row visible, variants hidden (collapsed by default).
    expect(screen.getByText('Input Box')).toBeTruthy();
    expect(screen.queryByText('Default')).toBeNull();

    // Select the SET externally — its variants must appear.
    rerender(<Harness sel={new Set(['0:1'])} />);
    expect(screen.getByText('Default')).toBeTruthy();
    expect(screen.getByText('Hover')).toBeTruthy();
    expect(screen.getByText('Focus')).toBeTruthy();
  });

  it('selecting a non-COMPONENT_SET FRAME does NOT auto-expand its children', () => {
    function Harness({ sel }: { sel: Set<string> }) {
      return (
        <LayerTree page={SET_PAGE} pageKey={0} selectedGuids={sel} onSelect={vi.fn()} />
      );
    }
    const { rerender } = render(<Harness sel={new Set()} />);
    rerender(<Harness sel={new Set(['0:2'])} />); // selects the FRAME
    // FRAME should be highlighted but its child 'leaf' should remain hidden
    // — only variant containers self-expand per spec I-F11.5b.
    expect(screen.queryByText('leaf')).toBeNull();
    const frameRow = screen.getByText('unrelated frame').closest('[role="treeitem"]')!;
    expect(frameRow.getAttribute('aria-selected')).toBe('true');
  });

  it('selecting a LEGACY variant container (FRAME with prop=value SYMBOL kids) self-expands', () => {
    // Same shape as the metarich "Button" frame — without COMPONENT_SET
    // type, but with variant-named SYMBOL children. Spec I-F11.5b applies.
    const legacyPage: DocNode = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      name: 'page',
      children: [
        n(1, 'FRAME', 'Button', [
          n(11, 'SYMBOL', 'size=XL, State=default'),
          n(12, 'SYMBOL', 'size=XL, State=hover'),
          n(13, 'SYMBOL', 'size=XL, State=disabled'),
        ]),
      ],
    };
    function Harness({ sel }: { sel: Set<string> }) {
      return (
        <LayerTree page={legacyPage} pageKey={0} selectedGuids={sel} onSelect={vi.fn()} />
      );
    }
    const { rerender } = render(<Harness sel={new Set()} />);
    expect(screen.queryByText('size=XL, State=default')).toBeNull();

    rerender(<Harness sel={new Set(['0:1'])} />);
    expect(screen.getByText('size=XL, State=default')).toBeTruthy();
    expect(screen.getByText('size=XL, State=hover')).toBeTruthy();
    expect(screen.getByText('size=XL, State=disabled')).toBeTruthy();
  });
});

describe('buildAncestorIndex', () => {
  it('returns an empty map for null/empty pages', () => {
    expect(buildAncestorIndex(null).size).toBe(0);
    expect(buildAncestorIndex({ children: [] }).size).toBe(0);
  });

  it('records the ancestor chain (root-most first) for every descendant', () => {
    // Page → A → B → C
    const page: DocNode = {
      guid: { sessionID: 0, localID: 100 },
      type: 'CANVAS',
      name: 'page',
      children: [
        n(1, 'FRAME', 'A', [
          n(2, 'FRAME', 'B', [
            n(3, 'TEXT', 'C'),
          ]),
        ]),
      ],
    };
    const idx = buildAncestorIndex(page);
    expect(idx.get('0:1')).toEqual([]);          // top-level frame, no ancestors above it
    expect(idx.get('0:2')).toEqual(['0:1']);
    expect(idx.get('0:3')).toEqual(['0:1', '0:2']);
  });
});

describe('LayerTree — auto-reveal on selection (spec I-F11.5–I-F11.8)', () => {
  // jsdom doesn't implement scrollIntoView; spy on the prototype so the
  // effect doesn't throw and we can assert on call shape.
  let scrollSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    scrollSpy = vi.spyOn(HTMLElement.prototype, 'scrollIntoView').mockImplementation(() => {});
  });
  afterEach(() => {
    scrollSpy.mockRestore();
  });

  // Deep test fixture: page > section1 > typography > rectangle17 > color
  const DEEP: DocNode = {
    guid: { sessionID: 0, localID: 100 },
    type: 'CANVAS',
    name: 'design setting',
    children: [
      n(1, 'FRAME', 'sidemenu'),
      n(2, 'FRAME', 'section 1', [
        n(3, 'FRAME', 'typography', [
          n(4, 'RECTANGLE', 'rectangle 17'),
          n(5, 'TEXT', 'color'),
        ]),
      ]),
    ],
  };

  it('auto-expands the full ancestor chain when a deep guid becomes selected', () => {
    function Harness({ sel }: { sel: Set<string> }) {
      return (
        <LayerTree page={DEEP} pageKey={0} selectedGuids={sel} onSelect={vi.fn()} />
      );
    }
    const { rerender } = render(<Harness sel={new Set()} />);

    // Default state: only top-level rows visible.
    expect(screen.getByText('section 1')).toBeTruthy();
    expect(screen.queryByText('typography')).toBeNull();
    expect(screen.queryByText('color')).toBeNull();

    // Select the deepest leaf — every ancestor (section 1 → typography)
    // must auto-expand and the leaf row itself must render.
    rerender(<Harness sel={new Set(['0:5'])} />);
    expect(screen.getByText('typography')).toBeTruthy();
    expect(screen.getByText('color')).toBeTruthy();

    const colorRow = screen.getByText('color').closest('[role="treeitem"]')!;
    expect(colorRow.getAttribute('aria-selected')).toBe('true');
  });

  it('calls scrollIntoView({ block: "nearest" }) on the selected row', () => {
    function Harness({ sel }: { sel: Set<string> }) {
      return (
        <LayerTree page={DEEP} pageKey={0} selectedGuids={sel} onSelect={vi.fn()} />
      );
    }
    const { rerender } = render(<Harness sel={new Set()} />);
    expect(scrollSpy).not.toHaveBeenCalled();

    rerender(<Harness sel={new Set(['0:4'])} />);
    expect(scrollSpy).toHaveBeenCalled();
    const lastCall = scrollSpy.mock.calls[scrollSpy.mock.calls.length - 1]!;
    expect(lastCall[0]).toMatchObject({ block: 'nearest' });
  });

  it('manual collapse persists if selection does not change (I-F11.7)', () => {
    function Harness() {
      // Stable Set identity — mirrors App.tsx where setSelectedGuids only
      // produces a new Set when selection actually changes. Manual collapse
      // must survive any unrelated re-render.
      const [sel] = useState(() => new Set(['0:5']));
      const [, force] = useState(0);
      return (
        <>
          <button data-testid="rerender" onClick={() => force((n) => n + 1)}>r</button>
          <LayerTree
            page={DEEP}
            pageKey={0}
            selectedGuids={sel}
            onSelect={vi.fn()}
          />
        </>
      );
    }
    render(<Harness />);

    // Auto-reveal: section 1 + typography expanded; color visible.
    expect(screen.getByText('color')).toBeTruthy();

    // User collapses 'section 1' manually.
    const sectionRow = screen.getByText('section 1').closest('[role="treeitem"]')!;
    const collapseBtn = sectionRow.querySelector('button[aria-label="Collapse"]')!;
    fireEvent.click(collapseBtn);
    expect(screen.queryByText('typography')).toBeNull();
    expect(screen.queryByText('color')).toBeNull();

    // Force a re-render with the same selection — collapse must persist.
    fireEvent.click(screen.getByTestId('rerender'));
    expect(screen.queryByText('typography')).toBeNull();
    expect(screen.queryByText('color')).toBeNull();
  });

  it('a NEW selection re-expands a previously-user-collapsed parent', () => {
    function Harness({ sel }: { sel: Set<string> }) {
      return (
        <LayerTree page={DEEP} pageKey={0} selectedGuids={sel} onSelect={vi.fn()} />
      );
    }
    const { rerender } = render(<Harness sel={new Set(['0:5'])} />);
    expect(screen.getByText('color')).toBeTruthy();

    // User collapses section 1.
    const sectionRow = screen.getByText('section 1').closest('[role="treeitem"]')!;
    const collapseBtn = sectionRow.querySelector('button[aria-label="Collapse"]')!;
    fireEvent.click(collapseBtn);
    expect(screen.queryByText('typography')).toBeNull();

    // New selection on a different deep node — auto-reveal kicks in again
    // and the previously-collapsed parent re-expands.
    rerender(<Harness sel={new Set(['0:4'])} />);
    expect(screen.getByText('typography')).toBeTruthy();
    expect(screen.getByText('rectangle 17')).toBeTruthy();
  });

  it('empty selection is a no-op (I-F11.8)', () => {
    function Harness({ sel }: { sel: Set<string> }) {
      return (
        <LayerTree page={DEEP} pageKey={0} selectedGuids={sel} onSelect={vi.fn()} />
      );
    }
    const { rerender } = render(<Harness sel={new Set(['0:5'])} />);
    // Clear selection — already-expanded sections stay expanded; just no
    // scroll/expand on the empty change.
    scrollSpy.mockClear();
    rerender(<Harness sel={new Set()} />);
    // section 1 was expanded by the prior auto-reveal — we don't COLLAPSE
    // it on selection-cleared (consistent with the spec — auto-reveal only
    // adds to the expand set).
    expect(screen.getByText('typography')).toBeTruthy();
    // No scroll because there's no selected row to focus on.
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
