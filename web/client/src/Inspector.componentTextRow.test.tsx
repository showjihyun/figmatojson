// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import * as services from './services';

// Mock the documentService BEFORE importing the component, so its module
// graph picks up the spy versions.
vi.mock('./services', async (orig) => {
  const real = await orig<typeof services>();
  return {
    ...real,
    documentService: {
      ...real.documentService,
      setInstanceTextOverride: vi.fn().mockResolvedValue(undefined),
      patch: vi.fn().mockResolvedValue(undefined),
    },
  };
});

import { ComponentTextRow } from './Inspector';

const item = {
  guid: '0:5',
  name: 'Label',
  path: 'Button / Label',
  characters: 'INITIAL',
};

function renderRow(overrideProps: Partial<{
  override: string | undefined;
  mode: 'instance' | 'master';
  onChange: () => void;
}> = {}) {
  const onChange = overrideProps.onChange ?? vi.fn();
  const utils = render(
    <ComponentTextRow
      item={item}
      mode={overrideProps.mode ?? 'instance'}
      instanceGuid="0:1"
      override={overrideProps.override}
      sessionId="sid"
      onChange={onChange}
    />,
  );
  return { ...utils, onChange };
}

describe('<ComponentTextRow>', () => {
  beforeEach(() => {
    vi.mocked(services.documentService.setInstanceTextOverride).mockClear();
    vi.mocked(services.documentService.patch).mockClear();
  });

  it('shows the master text initially when no override is present', () => {
    renderRow();
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('INITIAL');
  });

  it('shows the override text when one exists in instance mode', () => {
    renderRow({ override: 'OVERRIDE_VALUE' });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('OVERRIDE_VALUE');
    // The "OVERRIDE" badge is rendered.
    expect(screen.getByText(/^override$/i)).not.toBeNull();
  });

  // Regression for /review (Claude adversarial subagent), 2026-05-01:
  // ComponentTextRow's useEffect used to overwrite val whenever `displayed`
  // changed — including when a sibling row's Apply triggered onChange + a
  // re-fetch that bumped instanceOverrides map identity. The userTouched
  // ref guard added by the fix preserves user typing across such re-renders.
  it('preserves unsaved typing when displayed changes due to a parent re-render', () => {
    const { rerender } = renderRow({ override: undefined });
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;

    // User types — userTouched.current goes true.
    fireEvent.change(textarea, { target: { value: 'TYPING_IN_PROGRESS' } });
    expect(textarea.value).toBe('TYPING_IN_PROGRESS');

    // Sibling row's Apply lands → parent re-renders this row with new override.
    rerender(
      <ComponentTextRow
        item={item}
        mode="instance"
        instanceGuid="0:1"
        override="UNRELATED_SIBLING_OVERRIDE"
        sessionId="sid"
        onChange={vi.fn()}
      />,
    );

    // User's typing must NOT be wiped — the userTouched ref guard stops the
    // useEffect from clobbering it.
    expect(textarea.value).toBe('TYPING_IN_PROGRESS');
  });

  it('routes Apply through setInstanceTextOverride in instance mode', async () => {
    const onChange = vi.fn();
    renderRow({ onChange });
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'NEW_VALUE' } });
    const apply = screen.getByRole('button', { name: 'Apply' });
    await act(async () => {
      apply.click();
    });
    expect(services.documentService.setInstanceTextOverride).toHaveBeenCalledWith(
      'sid', '0:1', '0:5', 'NEW_VALUE',
    );
    expect(services.documentService.patch).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('routes Apply to Master through patch() in master mode', async () => {
    const onChange = vi.fn();
    renderRow({ mode: 'master', onChange });
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'MASTER_NEW' } });
    const apply = screen.getByRole('button', { name: /Apply to Master/ });
    await act(async () => {
      apply.click();
    });
    expect(services.documentService.patch).toHaveBeenCalledWith(
      'sid', '0:5', 'textData.characters', 'MASTER_NEW',
    );
    expect(services.documentService.setInstanceTextOverride).not.toHaveBeenCalled();
  });

  it('Cancel reverts the textarea to the displayed value and clears dirty', () => {
    renderRow();
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'in-progress' } });
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    act(() => {
      cancel.click();
    });
    expect(textarea.value).toBe('INITIAL');
    // Cancel button gone (dirty went back to false).
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
