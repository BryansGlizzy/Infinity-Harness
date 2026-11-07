# Board tools

Every tool is on the `board` MCP server. Which ones you see depends on your role and the board's settings.

## Knowing where you are
- `whoami`: your card, board, branch, worktree, pool and model.
- `list_cards`: every card with status, role, parent, what it waits for, agent and branch.

## Planning (orchestrators and leads; workers only if the board allows)
- `create_subtask(title, description, acceptance_criteria, work_type?, blocked_by?, parent_id?, delegate?, needs_network?, grants?)`: a card under yours. It starts by itself once the cards in `blocked_by` have reached Review. `delegate=true` makes a lead card that another agent plans further. `needs_network=true` keeps it away from agents whose shell has no network (Codex). `grants` asks for tool grants such as `browser` (see `extending`).
- `update_subtask`: revise a card you created, for example after its spec was sent back as too vague.
- `add_dependency(card_id, blocked_by)`: cycles are refused.

## Coordinating
- `reserve_paths(paths, ttl_minutes?)` / `release_paths` / `who_holds(path?)`: file leases. All or nothing: if another card holds one of the paths, nothing is reserved and the holder is named. Edits to files another card holds are refused. You are told when a file you wanted is released.
- `post_message(to, body, urgent?)`: to another card's id, or `to="human"`. Delivered at the recipient's next turn. Use `urgent` rarely.
- `read_inbox`: messages not yet delivered, plus the last few.
- `ask_agent(card_id, question)`: waits for the answer. An idle agent is asked directly. A busy one is not interrupted; its notes answer if they can.

## Shared notes
- `search_context(query, scope?, kinds?)`: decisions, contracts, handoffs, findings, card specs and agents' summaries. `scope` is `card`, `subtree` (your siblings) or `board`.
- `get_artifact(id)`: the full text of a note.
- `put_artifact(kind, title, body, supersedes?)`: `decision` (a choice and why), `contract` (an interface others rely on), `finding` (a gotcha), `note`.
- `write_handoff(state, decisions?, blockers?, files?, next_steps?)`: for whoever continues your card.

## Getting out
- `report_blocked(reason)`: you cannot finish. Write a handoff first. The card goes to another agent.
- `escalate_to_human(reason)`: you need a decision or access no agent can give. The card waits for a human, who answers in an approval; you resume with their note.

## Asking for more (see `extending`)
`spawn_agent`, `propose_mcp`, `propose_skill`, `request_grant`. Each waits for a human.

## In the editor
While a VS Code window is attached to the board you also get `ide_ask(question, options?)` (a quick pick for the human), `ide_diagnostics(paths)` (the language server's problems for files in your worktree) and `ide_show_diff(path, proposed)` (opens a proposed change in their diff editor). If nobody answers, the question becomes a message to the humans.

## Other
- `get_docs(topic?)`: this guide.
