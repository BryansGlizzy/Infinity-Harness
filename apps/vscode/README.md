# Infinity Harness for VS Code

Run the Infinity Harness (the repository this extension lives in) from the workspace you have open. The board for this folder's repository shows up in the sidebar. You plan goals from the editor, chat with a goal's agents, review each card's changes in VS Code's own diff editor (comment on lines, approve, request changes, try it, land it), attach to an agent's live terminal, and answer agents and decide their requests when they need you.

The extension is a client of the local Infinity Harness daemon. The agents (Claude Code, Codex, Kimi, Antigravity, OpenCode) still run there, each card in its own git worktree and branch of this repository. Their work lands back in your checkout through the merge queue.

## Install

From the Infinity Harness checkout:

```sh
pnpm install
pnpm --filter infinity-harness install-local   # builds dist/infinity-harness.vsix and installs it with `code`
```

For development, open `apps/vscode` in VS Code and press F5, or run `pnpm --filter infinity-harness watch`.

## Use

1. **Start the daemon** (`pnpm start` in the checkout). If it isn't running, the sidebar offers **Start Daemon**, which asks once where your checkout is (`infinityHarness.installPath`).
2. **Create a board** for the workspace when the sidebar asks. A folder that isn't a repository yet is set up first (git, README, .gitignore, first commit). A subfolder gets the board of its repository.
3. **Set up agents.** The board opens at the Agents view: which agent plans and which ones work, with their models and reasoning levels. Set the test command in Settings → Refinery.
4. **Plan a goal** with the ✨ button, **Infinity Harness: Plan a Goal…**, or right-click a selection → **Plan a Goal About the Selection…**. The active file (and selection) goes with the goal, so the orchestrator knows what you mean. **Plan a Fix for This File's Problems** turns the file's errors and warnings into a goal.

## What's where

| Place | What it does |
|---|---|
| **Chat** view | One conversation per goal across its whole card tree: what the agents say, status changes and your messages. A card's question to you appears inline with a reply box. The list button picks the goal; the menu under the box picks which card your message goes to (start with `!urgent` to interrupt its turn). |
| **Cards** view | The board as a tree: goals, leads and workers with status, agent and the narrator's live line. Click a card to open it on the board. Inline actions: **Show Changes**, **Attach Terminal** (Claude cards), **Message Agent**. The context menu adds **Run on Best Agent**, **Stop Agent**, **Open Worktree in New Window**, and, for a card in Review, **Approve Card**, **Request Changes…**, **Land Now** and **Try Locally** (check out the branch, or apply its diff to your working tree). |
| **Needs you** view | **Approvals** (an escalation to answer, a new agent, an MCP server, a skill or a tool grant; inline Approve and Deny, and a pop-up when one arrives), messages agents sent to you, blocks to weigh (Pass, Fail, Ignore) and blocked cards. The badge counts what's new. Notices from the path policy (a tool call refused outside the worktree) are here too. |
| **Board** tab | The full web UI in an editor tab: tree, card panel (Activity, Changes, Context, Terminal), Agents, Pools and Settings. |
| **Show Changes** | Every file the card changed, before ↔ after, in VS Code's multi-file diff editor. Nothing needs to be checked out. Comment on lines of the "after" side: while the card is being worked a comment goes to its agent at once; once it is in Review, your comments are collected and go with **Request Changes…**. **Approve Card** sends it to the merge queue without an agent review. |
| **IDE bridge** | While this window is bound to a board, its agents can ask you a quick question (a pick list or input box here), read this window's errors and warnings for files in their worktree, and show you a proposed change in the diff editor. If you close the window or dismiss a question, the question becomes a message in Needs you. Language servers may not analyse files in a card's worktree (it lies outside your workspace folder); on direct boards the files are your workspace's own. |
| **Attach Terminal** | The agent's live Claude Code session in a VS Code terminal. Watch it, or type to take over. |
| Editor right-click | **Send Selection to a Card's Agent…** sends the selected code (with path and lines) as a message. |
| Status bar | Cards working and items that need you. The tooltip lists the pools with their state and fullest window, the last day's tokens and cost, and any budget that is warning or used up. Click to open the board. |

## Settings

| Setting | Default | |
|---|---|---|
| `infinityHarness.daemonUrl` | `http://127.0.0.1:7420` | Where the daemon serves its API and UI. Use another port for a second instance (`MH_PORT`). |
| `infinityHarness.apiToken` | — | The daemon's API token (`.meta-harness/api-token`). Only needed for a daemon on another machine, or one started with `MH_REQUIRE_TOKEN=1`. The extension reconnects with `?since=` after a drop, so events that happened meanwhile (and their notifications) are not missed. |
| `infinityHarness.installPath` | — | Your Infinity Harness checkout, for **Start Daemon**. |
| `infinityHarness.notifications` | `attention` | `all` also announces landed cards; `off` keeps only the badge and status bar. |
| `infinityHarness.editorContext` | `true` | Add the active file and selection to goals planned from the editor. |
| `infinityHarness.ideBridge` | `true` | Let agents on this window's board ask you questions, read its problems and show you changes (the `ide_*` tools). |

## Building and publishing

```sh
pnpm --filter infinity-harness package         # dist/infinity-harness.vsix
pnpm --filter infinity-harness icon            # regenerate media/icon.png (the PNG is committed)
```

`.github/workflows/vsix.yml` typechecks, runs the extension tests and builds the `.vsix` on every change to the extension. Pushing a tag such as `vscode-v0.2.0` also publishes it to the Visual Studio Marketplace (secret `VSCE_PAT`) and Open VSX (secret `OVSX_PAT`); a publish step is skipped when its token isn't set. Before a public listing, replace the placeholder `publisher` and `license` in `package.json` and the repository URLs.
