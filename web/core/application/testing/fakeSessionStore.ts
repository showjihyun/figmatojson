/**
 * In-memory SessionStore + FsLike implementation for use case unit tests.
 *
 * - `create()` accepts a pre-built Session (the kiwi pipeline is out of
 *   scope for application-layer tests; we want to inject a known doc).
 * - `readMessage` / `writeMessage` keep the message.json in memory so
 *   EditNode / OverrideInstanceText / ResizeNode see their writes.
 *
 * NOT exported from production code — only test files import this.
 */

import type { Session } from '../../domain/entities/Session.js';
import type { SessionStore } from '../../ports/SessionStore.js';

interface SessionEntry {
  session: Session;
  messageJson: string;
}

export class FakeSessionStore implements SessionStore {
  private readonly entries = new Map<string, SessionEntry>();

  /**
   * Test-only seed. Pass a synthetic Session and the matching message.json
   * payload. Subsequent `readMessage` returns this string; `writeMessage`
   * replaces it.
   */
  seed(session: Session, messageJson: string): void {
    this.entries.set(session.id, { session, messageJson });
  }

  async create(): Promise<Session> {
    throw new Error('FakeSessionStore.create() — use seed() in tests instead');
  }

  getById(id: string): Session | null {
    return this.entries.get(id)?.session ?? null;
  }

  async flush(): Promise<void> { /* no-op in tests */ }

  resolvePath(id: string, ...segments: string[]): string {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`session ${id} not found`);
    return [entry.session.dir, ...segments].join('/');
  }

  async destroy(id: string): Promise<void> {
    this.entries.delete(id);
  }

  /** FsLike — used by EditNode / ResizeNode / OverrideInstanceText. */
  readMessage(id: string): string {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`session ${id} not found`);
    return entry.messageJson;
  }
  writeMessage(id: string, json: string): void {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`session ${id} not found`);
    entry.messageJson = json;
  }
}
