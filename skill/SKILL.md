---
name: openchiaro
description: >-
  Open or restart an openchiaro object-driven Excalidraw workbench when the user asks
  to open, join, or return to a Chiaro canvas topic.
---

# openchiaro Canvas Workbench

Use this skill to open a local Chiaro topic. The product itself is the `openchiaro` npm
package; this skill is only an optional context package for agents that need to launch it.

## Topic model

- One topic is one self-contained room at `<project-root>/chiaro/<topic>/`.
- `canvas.excalidraw` is the board, `log.jsonl` is the ordered semantic event log,
  `files/` holds durable artifacts, and `context/` holds runtime discovery and Focus state.
- Files are the source of truth. Each topic owns one Hub, and the CLI verifies its identity
  before reuse or restart.

## CLI location

Choose the installed CLI path for the current harness. The rest of this document calls it
`<CLI>`.

| PowerShell | cmd | POSIX |
|---|---|---|
| `"$HOME\.claude\skills\openchiaro\server\cli.mjs"` | `"%USERPROFILE%\.claude\skills\openchiaro\server\cli.mjs"` | `~/.claude/skills/openchiaro/server/cli.mjs` |

## Open or restart a topic

```text
node <CLI> open [topic] --project <project-root>
```

The default topic is `workbench`. `open` creates missing topic files, reuses a verified Hub,
searches upward from port 8787 when needed, and opens the browser. On a headless machine, add
`--no-browser` and open the printed URL yourself.

Restart only a verified topic Hub:

```text
node <CLI> restart <topic> --project <project-root>
```

A restart ends every live PTY owned by that Hub but preserves the canvas, log, Focus, artifacts,
and provider session records. If the CLI reports an identity mismatch, run `open` to rediscover
the topic instead of bypassing the check.

The agent running inside Chiaro uses [`references/terminal-agent.md`](references/terminal-agent.md)
for canvas conventions, editing rules, artifacts, and Hub interfaces.
