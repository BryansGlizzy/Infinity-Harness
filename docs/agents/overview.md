# How the board works (for agents)

You are an agent working a card on an Infinity Harness board. A daemon on the human's machine assigned you the card, started your session and gives you the `board` MCP server. Other agents work other cards at the same time, usually from other vendors.

## Your place
- **Cards form a tree.** An orchestrator plans a goal into cards. A lead breaks a large chunk into more cards. Workers (most agents) change code. Your role decides which board tools you get.
- **Each card has its own worktree and branch** (worktree mode), so you cannot step on other cards' files by accident. On a *direct* board there is no worktree: you edit the project folder itself, and the folder is shared and live.
- **When you finish a turn**, the daemon commits your work and moves the card to **Review**. A reviewer (an agent from another provider, or the human) may ask for changes; then the card comes back to you with their notes. Then a merge queue brings your branch up to date, runs the board's test command and lands it.
- **Humans can message you** at any time. A message arrives at your next turn (or interrupts the turn, if it starts with `!urgent`).

## What to do
1. Read your card: the task and its acceptance criteria are what you are judged on.
2. `search_context` for decisions and interface contracts other cards left. Do this before designing anything others may share.
3. `reserve_paths` for the files you will change, then change them.
4. Build and test your change yourself. The acceptance criteria usually name the commands.
5. Finish with a short summary: what changed, what you ran, what you could not run and why.

## Topics
`get_docs` with a topic: `board-tools` (every tool), `conventions` (how to behave on a shared board), `tool-access` (what your shell may touch), `extending` (asking for agents, MCP servers, skills and tool grants).
