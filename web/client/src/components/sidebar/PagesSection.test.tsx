// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { PagesSection } from './PagesSection';

const PAGES = [
  { guid: { sessionID: 0, localID: 100 }, type: 'CANVAS', name: 'Cover' },
  { guid: { sessionID: 0, localID: 101 }, type: 'CANVAS', name: 'Design Setting' },
  { guid: { sessionID: 0, localID: 102 }, type: 'CANVAS', name: 'Components' },
];

describe('<PagesSection>', () => {
  it('renders one row per page', () => {
    render(
      <PagesSection pages={PAGES} pageIdx={0} setPageIdx={vi.fn()} />,
    );
    expect(screen.getByText('Cover')).toBeTruthy();
    expect(screen.getByText('Design Setting')).toBeTruthy();
    expect(screen.getByText('Components')).toBeTruthy();
  });

  it('marks the current page with aria-current="page" (spec I-PG3)', () => {
    render(<PagesSection pages={PAGES} pageIdx={1} setPageIdx={vi.fn()} />);
    const cover = screen.getByText('Cover').closest('[role="listitem"]')!;
    const designSetting = screen.getByText('Design Setting').closest('[role="listitem"]')!;
    expect(cover.getAttribute('aria-current')).toBeNull();
    expect(designSetting.getAttribute('aria-current')).toBe('page');
  });

  it('clicking a page row calls setPageIdx with that index (spec I-PG4)', () => {
    const setPageIdx = vi.fn();
    render(<PagesSection pages={PAGES} pageIdx={0} setPageIdx={setPageIdx} />);
    fireEvent.click(screen.getByText('Components'));
    expect(setPageIdx).toHaveBeenCalledWith(2);
  });

  it('header chevron collapses + expands the list (spec I-PG5)', () => {
    render(<PagesSection pages={PAGES} pageIdx={0} setPageIdx={vi.fn()} />);
    // Default expanded — page rows visible.
    expect(screen.getByText('Cover')).toBeTruthy();

    const header = screen.getByRole('button', { name: /Pages/i });
    expect(header.getAttribute('aria-expanded')).toBe('true');

    fireEvent.click(header);
    expect(header.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Cover')).toBeNull();

    fireEvent.click(header);
    expect(screen.getByText('Cover')).toBeTruthy();
  });

  it('shows "No document open" when there are zero pages', () => {
    render(<PagesSection pages={[]} pageIdx={0} setPageIdx={vi.fn()} />);
    expect(screen.getByText('No document open')).toBeTruthy();
  });

  it('renders <unnamed> when a page has no name', () => {
    const pages = [{ guid: { sessionID: 0, localID: 100 }, type: 'CANVAS', name: '' }];
    render(<PagesSection pages={pages} pageIdx={0} setPageIdx={vi.fn()} />);
    expect(screen.getByText('<unnamed>')).toBeTruthy();
  });
});
