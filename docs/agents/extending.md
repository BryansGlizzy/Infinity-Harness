# Asking for more: agents, MCP servers, skills and tool grants

Some things you may not do on your own. You ask, a human decides in the **approval queue** (the web UI's Approvals, or VS Code's Needs-you view), and you get a message with the answer. Keep working on what you can meanwhile.

Which of these your role may use is a board setting (Agents view → Permissions). A refusal says so.

## `spawn_agent(id, pool, model?, reasoning?, role?, reason)`
Ask for a new agent on the board: a pool plus a model, as a worker or a lead. Use it when the work needs a model nobody on the team runs. Say why. Some boards apply it at once; most wait for a human.

## `propose_mcp(name, command? | url?, args?, env?, reason)`
Propose an MCP server for the board: a local command (`npx -y some-mcp`) or a remote Streamable-HTTP URL. If approved, every **new** agent session gets it, yours does not. Never put secrets in `env`; name the variable the human must set. The names `board` and `grant-*` are reserved.

## `propose_skill(name, description, body)`
Propose instructions every worker should follow in some situation: a testing recipe, a style rule. `description` says when it applies; `body` is the instructions, at most 4000 characters. If approved, new worker prompts carry it.

## `request_grant(grant, reason)` and `grants` on `create_subtask`
A **tool grant** gives one card extra tools as an MCP server named `grant-<name>`. The board defines them (Settings → Tools); two ship with it:
- `browser`: a headless browser ([agent-browser](https://github.com/vercel-labs/agent-browser)). Snapshot a page, click and fill elements by ref, screenshot. For checking UI flows and visual results. Each card gets its own isolated browser session. Needs a human's approval by default. Before the first use run `agent-browser skills get core` and follow it.
- `computer`: the desktop ([agent-desktop](https://github.com/vercel-labs/agent-desktop)): see and operate apps through the OS accessibility tree. It acts on the real desktop of the machine, so it is off until the human turns it on. Before the first use run `agent-desktop skills get desktop` and `agent-desktop skills get platform`, and follow them. Refs belong to the snapshot they came from; re-snapshot after a `STALE_REF`.

If a tool's command isn't installed on the machine, your card waits while the humans are asked to approve installing it (the daemon asks, you don't have to). Once it is installed your card starts with the tool. If they decline, or the install fails, you start without it: say so in your summary rather than skipping the check silently. You can't supply an install command; only the board's own is ever run.

A grant set to `auto` is given at once; one set to `approval` holds the card until a human decides (a card created with it does not start meanwhile). A grant takes effect the **next time the card runs**. If you cannot finish without it, say so in your summary and `report_blocked`.

When you have a grant, use it the way a person would: run the app, open the page, look at what renders, and report what you saw. Keep the files it produces (screenshots, traces) out of the worktree; `/tmp` is fine.

## Escalations
`escalate_to_human(reason)` is also an approval: the human's answer resumes your card, with their note as your next message.
