# claude-mux (Python client)

Python client for the [`claude-mux`](https://github.com/glowElephant/claude-mux) daemon.

Replaces `subprocess.run(["claude", "-p", ...])` headless calls with PTY-multiplexed
interactive sessions — stays inside your Pro/Max subscription after the 2026-06-15
billing change.

## Install

```bash
pip install claude-mux
```

Requires `@claude-mux/muxd` daemon running (or on PATH for auto-spawn).

## Usage

```python
from claude_mux import Client, BlockedError

c = Client()  # auto-spawns muxd if not running

# 1. one-shot — drop-in for subprocess.run(["claude", "-p", ...])
try:
    text = c.ask(
        "Bot status: running. Reply with 'noted'.",
        cwd="/path/to/project",
        mode="automation",
        idle_death_ms=120_000,
    )
except BlockedError as e:
    # model couldn't handle it — fallback
    print(f"blocked: {e.reason}")

# 2. reusable session — context preserved across sends
sess = c.open_session(cwd="/path/to/project", mode="automation")
try:
    ack = sess.send("Bot status is running. Reply with 'noted'.")
    reply = sess.send("Question: what's the status? Reply in one line.")
finally:
    sess.close()
```

### Prompt pattern (important)

Through PoC validation we found that **standalone imperative** prompts work; referential
prefixes (`"Given that ..."`, `"Based on the above ..."`) cause stall in automation mode.

```python
# ✅ works
prompt = f"Bot status is: {status}. Question: {q}. Reply with answer in one line."

# ❌ stalls (model can't bridge referential phrase + automation 'don't ask' rule)
sess.send(f"Bot status: {status}")
sess.send(f"Given the above status, answer: {q}")
```

See [`poc/sidecar-currency-edge/README.md`](https://github.com/glowElephant/claude-mux/blob/main/poc/sidecar-currency-edge/README.md)
for the full pattern matrix.

## Status

v0.1.5 — sync API, JSON-RPC over Unix socket (POSIX) / Named pipe (Windows via pywin32).
Async wrapper deferred. Migration of `currency-edge` / `vidfolio` is the goal of v0.2.0.

## License

MIT
