# figma-reverse

.fig (Figma) 파일 역공학 → 구조화된 JSON + 에셋 export 파이프라인.
TypeScript / Node.js 20+ / vitest.

## Architecture (web subtree)

`web/` follows Clean + Hexagonal layers — see [docs/SPEC-architecture.md](docs/SPEC-architecture.md):

```
web/core/                      framework-free
  domain/                      pure data + helpers
  ports/                       interfaces (driving + driven)
  application/                 use cases (orchestrate ports)
web/server/adapters/
  driven/                      Fs/Kiwi/SDK implementations of ports
  driving/http/                Hono routes — call use cases, never inline biz logic
web/client/src/services/       client-side service layer (network + localStorage)
```

**Dependency direction:** always inward. domain has zero deps; application
depends only on ports + domain; adapters depend on ports + external libs;
driving adapters call application.

## Testing & SDD

This project uses [Spec-Driven Development](docs/SDD.md) and a [test harness](docs/HARNESS.md).
Both pre-date the web layer; they apply to it the same way.

**Before adding a new web feature:**
1. Write or update `docs/specs/web-<feature>.spec.md` with input / output /
   invariants / error cases. (See existing examples — `web-edit-node.spec.md`,
   `web-chat-turn.spec.md`.)
2. Write a unit test under `web/core/application/<UseCase>.test.ts` that
   encodes each invariant as an assertion. Use `FakeSessionStore` from
   `web/core/application/testing/`.
3. Implement the use case until the test passes. Don't add behavior the
   spec doesn't describe.
4. Add an HTTP route adapter under `web/server/adapters/driving/http/`
   that translates the request shape → use case input → response shape.

**Iron rule:** spec is the source of truth. If implementation diverges,
update the spec first, then the test, then the code — never the other way.

**Run tests:**
- Unit (vitest): `cd web && npm test` — must pass before commit.
- E2E (Playwright): `cd web && npm run test:e2e` — must pass before merge.

## Agent skills

### Issue tracker

Issues live as markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

Default vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo — `CONTEXT.md` + `docs/adr/` at root. See `docs/agents/domain.md`.
