/**
 * Left-sidebar AI chat. Talks to /api/chat which proxies to Anthropic with
 * tool-use enabled.
 *
 * Two auth modes:
 *   - Subscription (default): uses the user's local Claude Code login,
 *                             no key needed. Recommended.
 *   - API Key:                user-supplied sk-ant-... key, stored in
 *                             localStorage only (never in the bundle).
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowUp, ChevronDown, Check, KeyRound, Loader2, Save, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { cn } from '@/lib/utils';

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

/** Tiny color cue per model family — gold opus, blue sonnet, green haiku. */
function modelDot(id: string): string {
  if (id.includes('opus-4-7')) return '#ffd166';
  if (id.includes('opus-4-6')) return '#cc9933';
  if (id.includes('sonnet')) return '#7eb6ff';
  if (id.includes('haiku')) return '#a3e3a3';
  return '#888';
}

export function ChatPanel({ sessionId, selectedGuid, onChange }: ChatPanelProps) {
  const [apiKey, setApiKey] = useState<string>(() => localStorage.getItem(KEY_STORE) ?? '');
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
    <div className="flex h-full min-h-0 flex-col bg-card">
      {/* Header */}
      <div className="flex flex-shrink-0 items-center gap-2 border-b border-border bg-card px-4 py-3">
        <div className="flex-1 min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            AI Assistant
          </div>
          <div className="mt-0.5 flex items-center gap-2 text-sm font-semibold text-foreground">
            Claude
            <span
              className={cn(
                'inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium',
                authMode === 'subscription'
                  ? 'bg-emerald-950 text-emerald-300'
                  : 'bg-blue-950 text-blue-300',
              )}
            >
              {authMode === 'subscription' ? (
                <>
                  <ShieldCheck className="h-3 w-3" />
                  Subscription
                </>
              ) : (
                <>
                  <KeyRound className="h-3 w-3" />
                  API Key{!apiKey && ' (not set)'}
                </>
              )}
            </span>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={() => setShowAuth(true)}>
          Auth
        </Button>
      </div>

      {/* Message list */}
      <div ref={scrollerRef} className="flex-1 overflow-auto px-4 py-3 min-h-0">
        {messages.length === 0 && (
          <div className="text-sm leading-relaxed text-muted-foreground">
            <div className="mb-2 font-medium text-foreground">Try:</div>
            <ul className="space-y-1.5 pl-1">
              <li className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                "Change the selected text to <span className="text-foreground">…</span>"
              </li>
              <li className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                "Move the selected node to <span className="text-foreground">(200, 100)</span>"
              </li>
              <li className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                "Resize selection to <span className="text-foreground">400×60</span>"
              </li>
              <li className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                "Make the fill green (rgb 0.2, 0.8, 0.3)"
              </li>
              <li className="rounded-md border border-border bg-background px-3 py-2 text-xs">
                "Override this instance's button text to 'Save'"
              </li>
            </ul>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className="mb-4">
            <div
              className={cn(
                'mb-1 text-[10px] font-semibold uppercase tracking-wider',
                m.role === 'user' ? 'text-primary' : 'text-muted-foreground',
              )}
            >
              {m.role === 'user' ? 'You' : 'Claude'}
            </div>
            <div
              className={cn(
                'whitespace-pre-wrap break-words rounded-md px-3 py-2 text-sm leading-relaxed',
                m.role === 'user'
                  ? 'bg-primary/15 text-foreground border border-primary/30'
                  : 'bg-muted text-foreground border border-border',
              )}
            >
              {m.content}
            </div>
            {m.actions && m.actions.length > 0 && (
              <div className="mt-1.5 space-y-1">
                {m.actions.map((a, j) => (
                  <div key={j} className="font-mono text-[11px] text-muted-foreground">
                    <span className="text-blue-400">{a.tool}</span>
                    <span className="text-muted-foreground/60">(</span>
                    <span className="text-emerald-400">
                      {JSON.stringify(a.input).slice(0, 80)}
                    </span>
                    <span className="text-muted-foreground/60">)</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        {busy && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Thinking…
          </div>
        )}
      </div>

      {/* Composer (pencil.dev-style: textarea + bottom bar with model picker + send) */}
      <div className="flex-shrink-0 border-t border-border bg-card p-3">
        <div className="flex flex-col gap-2 rounded-lg border border-input bg-background p-2 focus-within:ring-2 focus-within:ring-ring">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder={
              authMode === 'subscription'
                ? 'Ask Claude to edit…'
                : apiKey
                  ? 'Ask Claude to edit…'
                  : 'Set API key first'
            }
            rows={2}
            disabled={busy}
            className="min-h-[44px] resize-none border-0 bg-transparent px-1 py-1 text-sm shadow-none focus-visible:ring-0"
          />
          <div className="flex items-center gap-2">
            {/* Model picker — custom popover so we can show label+blurb per item */}
            <div ref={modelMenuRef} className="relative">
              <Button
                variant="outline"
                size="sm"
                onClick={() => setModelMenuOpen((o) => !o)}
                title={currentModel.blurb}
                className="gap-2"
              >
                <span
                  className="inline-block h-2 w-2 rounded-sm"
                  style={{ background: modelDot(currentModel.id) }}
                />
                {currentModel.label}
                <ChevronDown className="h-3 w-3 opacity-60" />
              </Button>
              {modelMenuOpen && (
                <div className="absolute bottom-[calc(100%+6px)] left-0 z-50 min-w-[260px] rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-xl">
                  {MODELS.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      onClick={() => pickModel(m.id)}
                      className={cn(
                        'flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors',
                        m.id === model ? 'bg-accent' : 'hover:bg-accent/60',
                      )}
                    >
                      <span
                        className="h-2.5 w-2.5 flex-shrink-0 rounded"
                        style={{ background: modelDot(m.id) }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-semibold leading-tight">{m.label}</div>
                        <div className="mt-0.5 text-xs text-muted-foreground">{m.blurb}</div>
                      </div>
                      {m.id === model && <Check className="h-4 w-4 flex-shrink-0 text-primary" />}
                    </button>
                  ))}
                </div>
              )}
            </div>
            <Button
              onClick={send}
              disabled={busy || !input.trim()}
              size="default"
              className="ml-auto"
              title="Send (Enter)"
            >
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowUp />}
              Send
            </Button>
          </div>
        </div>
      </div>

      <AuthModal
        open={showAuth}
        mode={authMode}
        apiKey={apiKey}
        onPickMode={pickAuthMode}
        onSaveKey={saveKey}
        onClose={() => setShowAuth(false)}
      />
    </div>
  );
}

function AuthModal({
  open,
  mode,
  apiKey,
  onPickMode,
  onSaveKey,
  onClose,
}: {
  open: boolean;
  mode: AuthMode;
  apiKey: string;
  onPickMode: (m: AuthMode) => void;
  onSaveKey: (k: string) => void;
  onClose: () => void;
}) {
  const [val, setVal] = useState(apiKey);
  useEffect(() => setVal(apiKey), [apiKey]);
  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="text-base">Claude Authentication</DialogTitle>
          <DialogDescription>
            Choose how this app calls Claude. Subscription mode is recommended — it uses your local
            Claude Code login so no key is needed.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-2.5">
          {/* Subscription card */}
          <button
            type="button"
            onClick={() => onPickMode('subscription')}
            className={cn(
              'group flex w-full items-start gap-3 rounded-lg border p-3.5 text-left transition-colors',
              mode === 'subscription'
                ? 'border-emerald-700 bg-emerald-950/40'
                : 'border-border bg-background hover:border-emerald-900',
            )}
          >
            <div
              className={cn(
                'mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md',
                mode === 'subscription' ? 'bg-emerald-900' : 'bg-muted',
              )}
            >
              <ShieldCheck
                className={cn(
                  'h-5 w-5',
                  mode === 'subscription' ? 'text-emerald-300' : 'text-muted-foreground',
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">Subscription</span>
                <span className="rounded bg-emerald-700 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white">
                  Default
                </span>
                {mode === 'subscription' && (
                  <Check className="ml-auto h-4 w-4 text-emerald-400" />
                )}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Uses your existing Claude Code session (read from <code className="rounded bg-muted px-1">~/.claude/</code>).
                No key required. Run <code className="rounded bg-muted px-1">claude login</code> once if you haven't yet.
              </div>
            </div>
          </button>

          {/* API Key card */}
          <button
            type="button"
            onClick={() => onPickMode('api-key')}
            className={cn(
              'group flex w-full items-start gap-3 rounded-lg border p-3.5 text-left transition-colors',
              mode === 'api-key'
                ? 'border-blue-700 bg-blue-950/40'
                : 'border-border bg-background hover:border-blue-900',
            )}
          >
            <div
              className={cn(
                'mt-0.5 flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md',
                mode === 'api-key' ? 'bg-blue-900' : 'bg-muted',
              )}
            >
              <KeyRound
                className={cn(
                  'h-5 w-5',
                  mode === 'api-key' ? 'text-blue-300' : 'text-muted-foreground',
                )}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold text-foreground">Anthropic API Key</span>
                {mode === 'api-key' && <Check className="ml-auto h-4 w-4 text-blue-400" />}
              </div>
              <div className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Paste an <code className="rounded bg-muted px-1">sk-ant-…</code> key. Stored only in
                your browser's localStorage. Get one at{' '}
                <a
                  href="https://console.anthropic.com/"
                  target="_blank"
                  rel="noreferrer"
                  className="text-primary underline-offset-2 hover:underline"
                  onClick={(e) => e.stopPropagation()}
                >
                  console.anthropic.com
                </a>
                .
              </div>
            </div>
          </button>
        </div>

        {mode === 'api-key' && (
          <div className="space-y-1.5">
            <label className="text-xs font-medium text-muted-foreground" htmlFor="api-key-input">
              API Key
            </label>
            <Input
              id="api-key-input"
              type="password"
              value={val}
              onChange={(e) => setVal(e.target.value)}
              placeholder="sk-ant-api03-..."
              autoFocus
              className="font-mono"
            />
          </div>
        )}

        <DialogFooter>
          <Button variant="outline" size="default" onClick={onClose}>
            Close
          </Button>
          {mode === 'api-key' && (
            <Button
              size="default"
              onClick={() => {
                if (val && !val.startsWith('sk-ant-')) {
                  if (!confirm('Key does not start with sk-ant- — save anyway?')) return;
                }
                onSaveKey(val.trim());
              }}
            >
              <Save />
              Save Key
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
