// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import * as services from './services';

vi.mock('./services', async (orig) => {
  const real = await orig<typeof services>();
  return {
    ...real,
    chatService: { send: vi.fn().mockResolvedValue({ assistantText: 'ok', actions: [] }) },
    preferencesService: {
      getApiKey: vi.fn(() => ''),
      setApiKey: vi.fn(),
      getModel: vi.fn((d: string) => d),
      setModel: vi.fn(),
      getAuthMode: vi.fn((d: services.AuthMode) => d),
      setAuthMode: vi.fn(),
    },
  };
});

import { ChatPanel } from './ChatPanel';

function renderPanel(props: Partial<{
  sessionId: string | null;
  selectedGuid: string | null;
  onChange: () => void;
}> = {}) {
  return render(
    <ChatPanel
      sessionId={props.sessionId === undefined ? 'sid' : props.sessionId}
      selectedGuid={props.selectedGuid ?? null}
      onChange={props.onChange ?? vi.fn()}
    />,
  );
}

describe('<ChatPanel>', () => {
  beforeEach(() => {
    vi.mocked(services.chatService.send).mockClear();
    vi.mocked(services.chatService.send).mockResolvedValue({ assistantText: 'ok', actions: [] });
    vi.mocked(services.preferencesService.getAuthMode).mockReturnValue('subscription');
    vi.mocked(services.preferencesService.getApiKey).mockReturnValue('');
  });

  it('Send button is disabled when the textarea is empty', () => {
    renderPanel();
    const send = screen.getByRole('button', { name: /^send$/i });
    expect((send as HTMLButtonElement).disabled).toBe(true);
  });

  it('Enter (no shift) submits the message via chatService.send', async () => {
    renderPanel();
    const textarea = screen.getByPlaceholderText('Ask Claude to edit…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'rename the button' } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });
    expect(services.chatService.send).toHaveBeenCalledTimes(1);
    const call = vi.mocked(services.chatService.send).mock.calls[0]![0];
    expect(call.sessionId).toBe('sid');
    expect(call.messages).toEqual([{ role: 'user', content: 'rename the button' }]);
    expect(call.authMode).toBe('subscription');
    // Subscription mode must NOT include apiKey.
    expect(call.apiKey).toBeUndefined();
  });

  it('Shift+Enter does NOT submit (multi-line input)', () => {
    renderPanel();
    const textarea = screen.getByPlaceholderText('Ask Claude to edit…');
    fireEvent.change(textarea, { target: { value: 'line one' } });
    fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });
    expect(services.chatService.send).not.toHaveBeenCalled();
  });

  // Auth gate: api-key mode without an apiKey opens the AuthModal instead of
  // calling chatService — prevents wasted round-trips and surfaces the setup
  // step to the user.
  it('opens the AuthModal when api-key mode lacks an apiKey instead of sending', () => {
    vi.mocked(services.preferencesService.getAuthMode).mockReturnValue('api-key');
    vi.mocked(services.preferencesService.getApiKey).mockReturnValue('');
    renderPanel();
    const textarea = screen.getByPlaceholderText(/Set API key first/);
    fireEvent.change(textarea, { target: { value: 'go' } });
    fireEvent.keyDown(textarea, { key: 'Enter' });
    expect(services.chatService.send).not.toHaveBeenCalled();
    // AuthModal title appears.
    expect(screen.getByText(/Claude Authentication/i)).not.toBeNull();
  });

  it('passes the apiKey header when api-key mode has a key set', async () => {
    vi.mocked(services.preferencesService.getAuthMode).mockReturnValue('api-key');
    vi.mocked(services.preferencesService.getApiKey).mockReturnValue('sk-ant-test');
    renderPanel();
    const textarea = screen.getByPlaceholderText('Ask Claude to edit…') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'do it' } });
    await act(async () => {
      fireEvent.keyDown(textarea, { key: 'Enter' });
    });
    const call = vi.mocked(services.chatService.send).mock.calls[0]![0];
    expect(call.authMode).toBe('api-key');
    expect(call.apiKey).toBe('sk-ant-test');
  });

  it('renders the empty-state hint list when there are no messages yet', () => {
    renderPanel();
    expect(screen.getByText(/Try:/)).not.toBeNull();
  });
});
