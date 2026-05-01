/**
 * Driven port: apply an LLM-requested tool call as a side effect on a
 * session's Document.
 *
 * Today's adapter is `InProcessTools` — it owns the same handler set the
 * REST endpoints use (set_text, override_instance_text, set_position,
 * set_size, set_fill_color), so a tool call from the chat path produces
 * exactly the same mutation as the equivalent inspector edit.
 *
 * The caller (RunChatTurn) provides the session id and the parsed
 * (name, input) tuple from the LLM's response; the dispatcher returns
 * a structured outcome so the caller can both surface it to the user
 * and trigger a doc refetch on the client.
 */

export interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface ToolOutcome {
  /** Echo of what was applied — included verbatim in the chat reply. */
  call: ToolCall;
  ok: boolean;
  /** Human-readable error if `ok` is false. */
  error?: string;
}

export interface ToolDispatcher {
  /**
   * Apply one tool call. Implementations MUST be transactional per call:
   * either the document mutation lands and is flushed to disk, or it
   * doesn't (no half-applied state).
   */
  apply(sessionId: string, call: ToolCall): Promise<ToolOutcome>;

  /** The tool catalogue this dispatcher can apply, for `runTurn` wiring. */
  catalogue(): Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
}
