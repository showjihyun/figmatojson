/**
 * Left-sidebar AI chat. Talks to /api/chat which proxies to Anthropic with
 * tool-use enabled. The user supplies their own API key (stored in
 * localStorage) — no key ever rides through the bundle.
 */
import { useEffect, useRef, useState } from 'react';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  actions?: Array<{ tool: string; input: unknown }>;
}

interface ChatPanelProps {
  sessionId: string | null;
  selectedGuid: string | null;
  onChange: () => void;
}

const KEY_STORE = 'figrev_anthropic_key';
const MODEL_STORE = 'figrev_claude_model';
const AUTH_MODE_STORE = 'figrev_auth_mode';
type AuthMode = 'subscription' | 'api-key';

interface ModelOption {
  id: string;
  label: string;
  blurb: string;
}

// Default is Opus 4.6 (per user preference). Options follow Anthropic's
// current Claude 4.x lineup — Opus 4.7 is the freshest, Sonnet 4.6 trades
// some quality for speed, Haiku 4.5 is fastest / cheapest.
const MODELS: ModelOption[] = [
  { id: 'claude-opus-4-6', label: 'Opus 4.6', blurb: 'Default · best for design tasks' },
  { id: 'claude-opus-4-7', label: 'Opus 4.7', blurb: 'Newest · highest quality' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6', blurb: 'Faster · still strong' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', blurb: 'Fastest · cheapest' },
];
const DEFAULT_MODEL = 'claude-opus-4-6';

export function ChatPanel({ sessionId, selectedGuid, onChange }: ChatPanelProps) {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(KEY_STORE) ?? '');
  // Default to Subscription — uses the user's local Claude Code login,
  // no key needed. API Key mode is the explicit fallback.
  const [authMode, setAuthMode] = useState<AuthMode>(
    () => (localStorage.getItem(AUTH_MODE_STORE) as AuthMode) || 'subscription',
  );
  const [showAuth, setShowAuth] = useState<boolean>(false);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [model, setModel] = useState<string>(
    () => localStorage.getItem(MODEL_STORE) ?? DEFAULT_MODEL,
  );
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const modelMenuRef = useRef<HTMLDivElement>(null);

  // Click outside closes the model picker
  useEffect(() => {
    if (!modelMenuOpen) return;
    const onDown = (e: MouseEvent): void => {
      if (modelMenuRef.current && !modelMenuRef.current.contains(e.target as Node)) {
        setModelMenuOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [modelMenuOpen]);

  function pickModel(id: string): void {
    setModel(id);
    localStorage.setItem(MODEL_STORE, id);
    setModelMenuOpen(false);
  }
  const currentModel = MODELS.find((m) => m.id === model) ?? MODELS[0]!;

  useEffect(() => {
    scrollerRef.current?.scrollTo({ top: scrollerRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages]);

  function saveKey(k: string): void {
    setApiKey(k);
    if (k) localStorage.setItem(KEY_STORE, k);
    else localStorage.removeItem(KEY_STORE);
    setShowAuth(false);
  }

  function pickAuthMode(m: AuthMode): void {
    setAuthMode(m);
    localStorage.setItem(AUTH_MODE_STORE, m);
  }

  async function send(): Promise<void> {
    if (!sessionId) {
      alert('Upload a .fig first');
      return;
    }
    if (authMode === 'api-key' && !apiKey) {
      setShowAuth(true);
      return;
    }
    const text = input.trim();
    if (!text) return;
    setInput('');
    const next = [...messages, { role: 'user' as const, content: text }];
    setMessages(next);
    setBusy(true);
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (authMode === 'api-key' && apiKey) headers['x-anthropic-key'] = apiKey;
      const r = await fetch(`/api/chat/${sessionId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          selectedGuid,
          model,
          authMode,
        }),
      });
      if (!r.ok) {
        const err = await r.text();
        setMessages([
          ...next,
          { role: 'assistant', content: `⚠️ Error: ${r.status} — ${err}` },
        ]);
        if (r.status === 401) setShowAuth(true);
      } else {
        const j = (await r.json()) as { assistantText: string; actions: ChatMsg['actions'] };
        setMessages([
          ...next,
          { role: 'assistant', content: j.assistantText || '(no text)', actions: j.actions },
        ]);
        if (j.actions && j.actions.length > 0) onChange();
      }
    } catch (err) {
      setMessages([...next, { role: 'assistant', content: `⚠️ ${(err as Error).message}` }]);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        background: '#1a1a1a',
        borderRight: '1px solid #2a2a2a',
        minHeight: 0,
      }}
    >
      <div
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid #2a2a2a',
          background: '#181818',
          display: 'flex',
          alignItems: 'center',
          gap: 10,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color: '#777', letterSpacing: 0.5 }}>AI ASSISTANT</div>
          <div style={{ fontSize: 13, color: '#eee', fontWeight: 600, marginTop: 2 }}>
            Claude{' '}
            <span
              style={{
                fontSize: 10,
                color: authMode === 'subscription' ? '#a3e3a3' : '#7eb6ff',
                fontWeight: 500,
                marginLeft: 4,
              }}
            >
              {authMode === 'subscription' ? '⊕ Subscription' : '🔑 API Key' + (apiKey ? '' : ' (not set)')}
            </span>
          </div>
        </div>
        <button
          onClick={() => setShowAuth(true)}
          style={{
            background: 'transparent',
            color: '#888',
            border: '1px solid #2c2c2c',
            padding: '4px 8px',
            borderRadius: 4,
            fontSize: 11,
            cursor: 'pointer',
          }}
        >
          Auth
        </button>
      </div>

      <div ref={scrollerRef} style={{ flex: 1, overflow: 'auto', padding: 14, minHeight: 0 }}>
        {messages.length === 0 && (
          <div style={{ color: '#666', fontSize: 12, lineHeight: 1.6 }}>
            Try:
            <ul style={{ paddingLeft: 18, marginTop: 6 }}>
              <li>"Change the selected text to ..."</li>
              <li>"Move the selected node to (200, 100)"</li>
              <li>"Resize selection to 400×60"</li>
              <li>"Make the fill green (rgb 0.2, 0.8, 0.3)"</li>
              <li>"Override this instance's button text to 'Save'"</li>
            </ul>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 14 }}>
            <div
              style={{
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: 0.6,
                color: m.role === 'user' ? '#0a84ff' : '#999',
                marginBottom: 4,
                fontWeight: 600,
              }}
            >
              {m.role === 'user' ? 'You' : 'Claude'}
            </div>
            <div
              style={{
                background: m.role === 'user' ? '#1f3a5f' : '#222',
                color: '#eee',
                padding: '8px 12px',
                borderRadius: 6,
                fontSize: 13,
                lineHeight: 1.5,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {m.content}
            </div>
            {m.actions && m.actions.length > 0 && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#888' }}>
                {m.actions.map((a, j) => (
                  <div key={j} style={{ marginTop: 2 }}>
                    <code style={{ color: '#7eb6ff' }}>{a.tool}</code>
                    <span style={{ color: '#666' }}>(</span>
                    <code style={{ color: '#a3e3a3' }}>
                      {JSON.stringify(a.input).slice(0, 80)}
                    </code>
                    <span style={{ color: '#666' }}>)</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && <div style={{ color: '#888', fontSize: 12 }}>Thinking…</div>}
      </div>

      <div
        style={{
          padding: 10,
          borderTop: '1px solid #2a2a2a',
          background: '#1a1a1a',
        }}
      >
        {/* Pencil.dev-style composer: textarea + bottom bar with model picker + send. */}
        <div
          style={{
            background: '#0c0c0c',
            border: '1px solid #2c2c2c',
            borderRadius: 8,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={apiKey ? 'Ask Claude to edit…' : 'Set API key first'}
            rows={2}
            disabled={busy}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#e8e8e8',
              padding: '4px 4px 0',
              fontSize: 13,
              fontFamily: 'inherit',
              resize: 'none',
              outline: 'none',
              width: '100%',
              minHeight: 38,
            }}
          />
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <div ref={modelMenuRef} style={{ position: 'relative' }}>
              <button
                onClick={() => setModelMenuOpen((o) => !o)}
                style={{
                  background: 'transparent',
                  border: '1px solid #2c2c2c',
                  borderRadius: 6,
                  color: '#bbb',
                  padding: '4px 10px',
                  fontSize: 12,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                }}
                title={currentModel.blurb}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: 2,
                    background: modelDot(currentModel.id),
                    display: 'inline-block',
                  }}
                />
                <span style={{ fontWeight: 600 }}>{currentModel.label}</span>
                <span style={{ fontSize: 10, color: '#666' }}>▾</span>
              </button>
              {modelMenuOpen && (
                <div
                  style={{
                    position: 'absolute',
                    bottom: 'calc(100% + 6px)',
                    left: 0,
                    background: '#1a1a1a',
                    border: '1px solid #2c2c2c',
                    borderRadius: 8,
                    boxShadow: '0 8px 24px rgba(0,0,0,0.6)',
                    minWidth: 240,
                    zIndex: 50,
                    padding: 4,
                  }}
                >
                  {MODELS.map((m) => (
                    <button
                      key={m.id}
                      onClick={() => pickModel(m.id)}
                      style={{
                        display: 'flex',
                        width: '100%',
                        background: m.id === model ? '#222' : 'transparent',
                        border: 'none',
                        borderRadius: 4,
                        padding: '8px 10px',
                        textAlign: 'left',
                        cursor: 'pointer',
                        gap: 10,
                        alignItems: 'center',
                      }}
                    >
                      <span
                        style={{
                          width: 10,
                          height: 10,
                          borderRadius: 3,
                          background: modelDot(m.id),
                          flexShrink: 0,
                        }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ color: '#eee', fontSize: 12, fontWeight: 600 }}>{m.label}</div>
                        <div style={{ color: '#888', fontSize: 11, marginTop: 1 }}>{m.blurb}</div>
                      </div>
                      {m.id === model && <span style={{ color: '#0a84ff', fontSize: 14 }}>✓</span>}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              onClick={send}
              disabled={busy || !input.trim()}
              style={{
                marginLeft: 'auto',
                background: busy || !input.trim() ? '#1c1c1c' : '#0a84ff',
                color: busy || !input.trim() ? '#555' : 'white',
                border: 'none',
                borderRadius: 6,
                padding: '5px 14px',
                fontSize: 12,
                fontWeight: 600,
                cursor: busy || !input.trim() ? 'default' : 'pointer',
              }}
            >
              {busy ? '…' : 'Send ↵'}
            </button>
          </div>
        </div>
      </div>

      {showAuth && (
        <AuthModal
          mode={authMode}
          apiKey={apiKey}
          onPickMode={pickAuthMode}
          onSaveKey={saveKey}
          onClose={() => setShowAuth(false)}
        />
      )}
    </div>
  );
}

/** Tiny color cue per model family — matches the icon's tier (gold opus,
 *  blue sonnet, green haiku) so users can tell at a glance which one is
 *  active. Pencil.dev uses a similar visual mnemonic. */
function modelDot(id: string): string {
  if (id.includes('opus-4-7')) return '#ffd166'; // brightest gold — newest
  if (id.includes('opus-4-6')) return '#cc9933'; // darker gold
  if (id.includes('sonnet')) return '#7eb6ff';   // blue
  if (id.includes('haiku')) return '#a3e3a3';    // green
  return '#888';
}

function AuthModal({
  mode,
  apiKey,
  onPickMode,
  onSaveKey,
  onClose,
}: {
  mode: AuthMode;
  apiKey: string;
  onPickMode: (m: AuthMode) => void;
  onSaveKey: (k: string) => void;
  onClose: () => void;
}) {
  const [val, setVal] = useState(apiKey);
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.7)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 1000,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: '#1a1a1a',
          border: '1px solid #2a2a2a',
          borderRadius: 10,
          padding: 24,
          width: 520,
          maxWidth: '92vw',
        }}
      >
        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>Claude Authentication</div>
        <div style={{ fontSize: 12, color: '#888', marginBottom: 16, lineHeight: 1.5 }}>
          Choose how this app calls Claude. Subscription mode is recommended — it uses your local
          Claude Code login so no key is needed.
        </div>

        {/* Subscription card */}
        <button
          onClick={() => onPickMode('subscription')}
          style={{
            width: '100%',
            background: mode === 'subscription' ? '#1f3a2a' : '#0c0c0c',
            border: `1px solid ${mode === 'subscription' ? '#3a6e4a' : '#2c2c2c'}`,
            borderRadius: 8,
            padding: '12px 14px',
            textAlign: 'left',
            cursor: 'pointer',
            marginBottom: 10,
            color: '#eee',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>⊕ Subscription</span>
            <span style={{ fontSize: 10, padding: '1px 6px', background: '#3a6e4a', color: 'white', borderRadius: 3, fontWeight: 600 }}>
              DEFAULT
            </span>
            {mode === 'subscription' && <span style={{ marginLeft: 'auto', color: '#a3e3a3' }}>✓</span>}
          </div>
          <div style={{ fontSize: 11, color: '#bbb', lineHeight: 1.5 }}>
            Uses your existing Claude Code session (read from <code>~/.claude/</code>). No key
            required. Run <code>claude login</code> once if you haven't yet.
          </div>
        </button>

        {/* API Key card */}
        <button
          onClick={() => onPickMode('api-key')}
          style={{
            width: '100%',
            background: mode === 'api-key' ? '#1f2f4a' : '#0c0c0c',
            border: `1px solid ${mode === 'api-key' ? '#3a5a8a' : '#2c2c2c'}`,
            borderRadius: 8,
            padding: '12px 14px',
            textAlign: 'left',
            cursor: 'pointer',
            color: '#eee',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
            <span style={{ fontSize: 13, fontWeight: 700 }}>🔑 Anthropic API Key</span>
            {mode === 'api-key' && <span style={{ marginLeft: 'auto', color: '#7eb6ff' }}>✓</span>}
          </div>
          <div style={{ fontSize: 11, color: '#bbb', lineHeight: 1.5 }}>
            Paste an <code>sk-ant-…</code> key. Stored only in your browser's localStorage. Get
            one at{' '}
            <a
              href="https://console.anthropic.com/"
              target="_blank"
              rel="noreferrer"
              style={{ color: '#0a84ff' }}
              onClick={(e) => e.stopPropagation()}
            >
              console.anthropic.com
            </a>
            .
          </div>
        </button>

        {mode === 'api-key' && (
          <div style={{ marginTop: 14 }}>
            <input
              type="password"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder="sk-ant-api03-..."
              autoFocus
              style={{
                width: '100%',
                background: '#0c0c0c',
                border: '1px solid #2c2c2c',
                borderRadius: 4,
                color: '#e8e8e8',
                padding: '8px 10px',
                fontSize: 12,
                fontFamily: 'Menlo, Consolas, monospace',
              }}
            />
          </div>
        )}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
          <button
            onClick={onClose}
            style={{
              background: 'transparent',
              color: '#888',
              border: '1px solid #2c2c2c',
              padding: '6px 14px',
              borderRadius: 4,
              fontSize: 12,
              cursor: 'pointer',
            }}
          >
            Close
          </button>
          {mode === 'api-key' && (
            <button
              onClick={() => {
                if (val && !val.startsWith('sk-ant-')) {
                  if (!confirm('Key does not start with sk-ant- — save anyway?')) return;
                }
                onSaveKey(val.trim());
              }}
              style={{
                background: '#0a84ff',
                color: 'white',
                border: 'none',
                padding: '6px 14px',
                borderRadius: 4,
                fontSize: 12,
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Save Key
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
