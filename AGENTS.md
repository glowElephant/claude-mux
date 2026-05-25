# claude-mux (Agent-agnostic context)

PTY-based interactive Claude Code session multiplexer. Replaces `claude -p` headless calls to avoid 2026-06-15 billing changes.

## Architecture

```
N apps → N clients (TS or Python) → muxd daemon → N isolated PTY sessions
```

- Each client request carries a `sessionId`. Daemon routes to that PTY only.
- Sessions never share context. 20 concurrent apps = 20 independent PTYs.
- Per-session message queue: same session can't be hit in parallel (PTY is serial).

## API surface

- `ask(prompt, opts)` — one-shot (drop-in for `claude -p`)
- `stream(prompt, opts)` — async iterable of text chunks
- `openSession(opts) / send / close` — reusable session

## Constraints

- Host's Claude Pro/Max subscription required. No API key path.
- Stay within Anthropic ToS — equivalent to a human typing in `claude` TUI.
- Parser must tolerate `claude` CLI version drift (TUI output is not stable).

## Stack

- TypeScript + Node.js daemon, `node-pty` for cross-platform PTY
- IPC: JSON-RPC over Unix socket / Windows named pipe
- Clients: npm package + pip package
- Tests: vitest (TS), pytest (Python)

## Repo layout (planned)

```
packages/
  muxd/          # TypeScript daemon
  client-ts/     # @claude-mux/client (npm)
  client-py/     # claude-mux (pip)
poc/             # Phase 0 cost-measurement scripts
docs/
  spec.md
  cost-poc.md   # subscription-mode billing measurements
  know-how/     # imported from context-forge catalog
```
