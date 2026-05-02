// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import { AssetList, collectAssets } from './AssetList';

interface DocNode {
  guid?: { sessionID?: number; localID?: number };
  type?: string;
  name?: string;
  children?: DocNode[];
}

function n(localID: number, type: string, name: string, children?: DocNode[]): DocNode {
  return { guid: { sessionID: 0, localID }, type, name, children };
}

const PAGE_A: DocNode = {
  guid: { sessionID: 0, localID: 100 },
  type: 'CANVAS',
  name: 'page-a',
  children: [
    n(1, 'FRAME', 'Header', [
      n(2, 'SYMBOL', 'u:check'),
      n(3, 'COMPONENT', 'Button/Primary'),
    ]),
    n(4, 'TEXT', 'just-text'),
  ],
};
const PAGE_B: DocNode = {
  guid: { sessionID: 0, localID: 101 },
  type: 'CANVAS',
  name: 'page-b',
  children: [
    n(5, 'COMPONENT_SET', 'Button'),
    n(6, 'SYMBOL', 'u:check-circle'),
  ],
};
const DOC: DocNode = {
  guid: { sessionID: 0, localID: 0 },
  type: 'DOCUMENT',
  name: 'root',
  children: [PAGE_A, PAGE_B],
};

describe('collectAssets', () => {
  it('finds SYMBOL/COMPONENT/COMPONENT_SET across all pages', () => {
    const list = collectAssets(DOC, [PAGE_A, PAGE_B]);
    const names = list.map((a) => a.name);
    expect(names).toContain('u:check');
    expect(names).toContain('u:check-circle');
    expect(names).toContain('Button/Primary');
    expect(names).toContain('Button');
    expect(names).not.toContain('just-text'); // TEXT excluded
    expect(names).not.toContain('Header');     // FRAME excluded
  });

  it('annotates each asset with its page index and name', () => {
    const list = collectAssets(DOC, [PAGE_A, PAGE_B]);
    const check = list.find((a) => a.name === 'u:check')!;
    expect(check.pageIdx).toBe(0);
    expect(check.pageName).toBe('page-a');
    const checkCircle = list.find((a) => a.name === 'u:check-circle')!;
    expect(checkCircle.pageIdx).toBe(1);
    expect(checkCircle.pageName).toBe('page-b');
  });

  it('sorts by name ascending, case-insensitive', () => {
    const list = collectAssets(DOC, [PAGE_A, PAGE_B]);
    const names = list.map((a) => a.name);
    const sorted = [...names].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
    expect(names).toEqual(sorted);
  });

  it('returns empty array for null doc or empty pages', () => {
    expect(collectAssets(null, [])).toEqual([]);
    expect(collectAssets(DOC, [])).toEqual([]);
  });
});

describe('AssetList component', () => {
  it('renders one row per asset with the page name shown', () => {
    render(
      <AssetList
        doc={DOC}
        pages={[PAGE_A, PAGE_B]}
        selectedGuids={new Set()}
        onAssetClick={vi.fn()}
      />,
    );
    expect(screen.getByText('u:check')).toBeTruthy();
    expect(screen.getByText('u:check-circle')).toBeTruthy();
    // Page name appears at least once next to its asset.
    expect(screen.getAllByText('page-a').length).toBeGreaterThan(0);
    expect(screen.getAllByText('page-b').length).toBeGreaterThan(0);
  });

  it('filters by case-insensitive substring on the search input', () => {
    render(
      <AssetList
        doc={DOC}
        pages={[PAGE_A, PAGE_B]}
        selectedGuids={new Set()}
        onAssetClick={vi.fn()}
      />,
    );
    const search = screen.getByLabelText('Search assets') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'CHECK' } });

    expect(screen.getByText('u:check')).toBeTruthy();
    expect(screen.getByText('u:check-circle')).toBeTruthy();
    expect(screen.queryByText('Button/Primary')).toBeNull();
    expect(screen.queryByText('Button')).toBeNull();
  });

  it('shows "No assets match" when search yields zero results', () => {
    render(
      <AssetList
        doc={DOC}
        pages={[PAGE_A, PAGE_B]}
        selectedGuids={new Set()}
        onAssetClick={vi.fn()}
      />,
    );
    const search = screen.getByLabelText('Search assets') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'zzz_nope' } });
    expect(screen.getByText('No assets match')).toBeTruthy();
  });

  it('fires onAssetClick with the entry on row click', () => {
    const onAssetClick = vi.fn();
    render(
      <AssetList
        doc={DOC}
        pages={[PAGE_A, PAGE_B]}
        selectedGuids={new Set()}
        onAssetClick={onAssetClick}
      />,
    );
    fireEvent.click(screen.getByText('u:check-circle'));
    expect(onAssetClick).toHaveBeenCalledTimes(1);
    const arg = onAssetClick.mock.calls[0]![0];
    expect(arg.name).toBe('u:check-circle');
    expect(arg.pageIdx).toBe(1);
    expect(arg.guid).toBe('0:6');
  });

  it('shows the No-document placeholder when doc is null', () => {
    render(
      <AssetList
        doc={null}
        pages={[]}
        selectedGuids={new Set()}
        onAssetClick={vi.fn()}
      />,
    );
    expect(screen.getByText('No document open')).toBeTruthy();
  });
});
