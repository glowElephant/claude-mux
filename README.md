# claude-mux

> **PTY-based Claude Code session multiplexer.** Replace `claude -p` headless calls with interactive sessions to stay inside your Pro/Max subscription after the 2026-06-15 billing change.

## Why

From 2026-06-15, `claude -p` (headless / print mode) is metered against a separate credit pool on Pro ($20/mo) / Max ($100–200/mo) plans. Interactive TUI (`claude` no args) stays inside the regular subscription.

`claude-mux` spawns `claude` as an interactive TUI inside a PTY (pseudo-terminal), then your apps talk to it programmatically via a daemon. From Anthropic's perspective it looks identical to a human typing — no headless credits consumed.

## Goal

```python
# before
proc = subprocess.run(["claude", "-p", ...], input=prompt, ...)

# after
from claude_mux import Client
text = Client().ask(prompt)
```

Drop-in replacement, zero headless billing impact.

## Status

🚧 Phase 0 — PoC. Measuring whether subscription-mode PTY interaction is actually free of headless credit consumption.

## Roadmap

- [ ] **Phase 0 / PoC** — PTY round-trip + billing verification
- [ ] **v0.1.0 / MVP** — `ask` / `stream` / `openSession` + TS client + daemon
- [ ] **v0.2.0 / migration** — Python client + migrate `currency-edge` / `vidfolio`

## Architecture

```
N apps → N clients (TS/Python) → muxd daemon → N isolated PTY sessions
```

Each session is fully isolated — 20 concurrent apps get 20 independent `claude` PTYs, contexts never bleed.

## License

TBD (likely MIT)

---

Built to solve a billing edge case. Hopefully irrelevant if Anthropic ever expands subscription to cover headless properly.
