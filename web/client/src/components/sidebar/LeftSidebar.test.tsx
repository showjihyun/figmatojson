// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Stub ChatPanel — its internals (services, dialogs) aren't the focus here;
// LeftSidebar just hosts it as a tab. The stub renders a marker we can
// assert against to verify the chat tab is wired and remains mounted.
vi.mock('../../ChatPanel', () => ({
  ChatPanel: ({ sessionId }: { sessionId: string | null }) => (
    <div data-testid="chat-stub">chat-stub:{sessionId ?? 'no-session'}</div>
  ),
}));

import { LeftSidebar } from './LeftSidebar';

// Asset/One is nested INSIDE Header so the Files tree (collapsed by default)
// shows only Header at depth 0 — Asset/One stays hidden in Files but is
// always discoverable in the Assets list (which walks the whole subtree).
const PAGE = {
  guid: { sessionID: 0, localID: 100 },
  type: 'CANVAS',
  name: 'Page',
  children: [
    {
      guid: { sessionID: 0, localID: 1 },
      type: 'FRAME',
      name: 'Header',
      children: [
        { guid: { sessionID: 0, localID: 2 }, type: 'COMPONENT', name: 'Asset/One' },
      ],
    },
  ],
};
const DOC = {
  guid: { sessionID: 0, localID: 0 },
  type: 'DOCUMENT',
  children: [PAGE],
};

function renderSidebar(opts: Partial<React.ComponentProps<typeof LeftSidebar>> = {}) {
  return render(
    <LeftSidebar
      doc={opts.doc === undefined ? DOC : opts.doc}
      pages={opts.pages ?? [PAGE]}
      pageIdx={opts.pageIdx ?? 0}
      setPageIdx={opts.setPageIdx ?? vi.fn()}
      currentPage={opts.currentPage === undefined ? PAGE : opts.currentPage}
      selectedGuids={opts.selectedGuids ?? new Set()}
      onSelect={opts.onSelect ?? vi.fn()}
      sessionId={opts.sessionId ?? 'sid'}
      selectedGuidForChat={opts.selectedGuidForChat ?? null}
      onDocChange={opts.onDocChange ?? vi.fn()}
    />,
  );
}

/**
 * Radix Tabs keep ALL panels mounted (spec I-T5 — preserves chat draft /
 * tree expansion across tab swaps). So `queryByText` finds elements in
 * inactive panels too. These helpers scope queries to the currently-active
 * tabpanel only.
 */
function activePanel(): HTMLElement | null {
  return document.querySelector('[role="tabpanel"][data-state="active"]') as HTMLElement | null;
}
function inActivePanel(text: string | RegExp): boolean {
  const panel = activePanel();
  if (!panel) return false;
  if (text instanceof RegExp) return text.test(panel.textContent ?? '');
  return (panel.textContent ?? '').includes(text);
}
function activeTabName(): string | null {
  return activePanel()?.getAttribute('aria-labelledby')?.split('-trigger-')[1] ?? null;
}

describe('<LeftSidebar>', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to the Files tab and shows the layer tree', () => {
    renderSidebar();
    expect(activeTabName()).toBe('files');
    expect(inActivePanel('Header')).toBe(true);
    expect(inActivePanel('Asset/One')).toBe(false);
    expect(inActivePanel(/chat-stub/)).toBe(false);
  });

  it('switching to Assets shows the asset list in the active panel', () => {
    renderSidebar();
    // Radix Tabs.Trigger activates on mousedown (not click) — see jsdom note.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Assets/i }));
    expect(activeTabName()).toBe('assets');
    expect(inActivePanel('Asset/One')).toBe(true);
  });

  it('switching to Chat reveals the (stubbed) ChatPanel with forwarded sessionId', () => {
    renderSidebar({ sessionId: 'sid-XYZ' });
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Chat/i }));
    expect(activeTabName()).toBe('chat');
    expect(inActivePanel('chat-stub:sid-XYZ')).toBe(true);
  });

  it('persists the active tab in localStorage and restores it on next mount', () => {
    const { unmount } = renderSidebar();
    // Radix Tabs.Trigger activates on mousedown (not click) — see jsdom note.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Assets/i }));
    expect(localStorage.getItem('leftSidebar.tab')).toBe('assets');

    unmount();
    renderSidebar();
    expect(activeTabName()).toBe('assets');
    expect(inActivePanel('Asset/One')).toBe(true);
  });

  it('falls back to Files if localStorage holds an invalid tab value', () => {
    localStorage.setItem('leftSidebar.tab', 'bogus-tab');
    renderSidebar();
    expect(activeTabName()).toBe('files');
    expect(inActivePanel('Header')).toBe(true);
  });

  it('clicking an asset triggers setPageIdx and onSelect, even when on a different page', () => {
    const setPageIdx = vi.fn();
    const onSelect = vi.fn();
    // Create two pages so asset's pageIdx (0) differs from current pageIdx (1).
    const pageEmpty = {
      guid: { sessionID: 0, localID: 200 },
      type: 'CANVAS',
      name: 'Empty',
      children: [],
    };
    renderSidebar({
      pages: [PAGE, pageEmpty],
      pageIdx: 1,
      currentPage: pageEmpty,
      setPageIdx,
      onSelect,
    });
    // Radix Tabs.Trigger activates on mousedown (not click) — see jsdom note.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Assets/i }));
    fireEvent.click(screen.getByText('Asset/One'));
    expect(setPageIdx).toHaveBeenCalledWith(0);
    expect(onSelect).toHaveBeenCalledWith('0:2', 'replace');
  });

  it('does NOT call setPageIdx if the asset is already on the current page', () => {
    const setPageIdx = vi.fn();
    renderSidebar({ setPageIdx });
    // Radix Tabs.Trigger activates on mousedown (not click) — see jsdom note.
    fireEvent.mouseDown(screen.getByRole('tab', { name: /Assets/i }));
    fireEvent.click(screen.getByText('Asset/One'));
    expect(setPageIdx).not.toHaveBeenCalled();
  });
});
