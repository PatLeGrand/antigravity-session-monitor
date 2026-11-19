---
name: session-monitor
description: Open the Session Monitor side panel, or answer questions about the current session's context size, tool usage or running subagents. Use when the user asks to see their context/token usage, which tools were used, or whether subagents are still working.
---

# Session Monitor

The `session-monitor` plugin ships a live side panel (sidecar `session-monitor/monitor`)
showing, for the current conversation:

- context size (tokens of the latest model call vs a selectable limit) and its history,
- tool usage (totals per tool, errors, latest calls),
- the subagent tree with each subagent's live state (working / idle / error / stale / killed).

## Opening the panel

When the user asks to open/see the monitor, reply with this pill (it toggles the aux pane):

```markdown
[Session Monitor](sidecar://session-monitor/monitor/)
```

## Answering directly

If the user asks for the numbers in chat, read your own compact transcript
(`<appDataDir>/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`):

- Context size = `input_tokens + cache_read_tokens` of the newest `PLANNER_RESPONSE` step.
- Tool usage = count of `tool_calls[].name` over `PLANNER_RESPONSE` steps.
- Subagents = `manage_subagents` with `Action: list`.

Keep the answer short and also offer the pill above.
