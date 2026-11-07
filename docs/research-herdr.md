# Research: herdr (input to master plan Phase 6.6)

Studied 2026-11-06 from a shallow clone at `research/herdr` (git-ignored; commit `ee5bfb5`, Oct 29 2026; Apache-2.0; about 329k lines of Rust, 48k stars). Source: https://github.com/herdrdev/herdr. What follows is what I read (README, `AGENTS.md`, `skills/herdr/SKILL.md`, the docs under `docs/next/website/src/content/docs/`, the detection manifests, and the layout of `src/`). I did not build or run herdr, and I did not read its Rust line by line; claims about behaviour come from its docs unless stated otherwise.

## 1. What herdr is, and how it differs from us

herdr is **a terminal multiplexer that knows about coding agents**. One Rust binary runs a background server that owns real PTYs ("panes", grouped into tabs and workspaces); a TUI client attaches to it, over a local socket or over SSH. It does not wrap or replace the agents. It watches each pane and decides whether the agent in it is `working`, `blocked`, `done`, `idle` or `unknown`.

| | herdr | Infinity Harness |
|---|---|---|
| Unit of work | A terminal pane someone started | A card in a task tree, planned, routed and landed by the daemon |
| How it knows what an agent is doing | Reads the screen against per-agent TOML "manifests" (plus optional hooks that report state) | Protocols we control: ACP, MCP, Claude hooks, OTLP telemetry |
| Who decides what runs where | The human (or an agent calling the CLI) | The scheduler: deterministic routing, quota windows, budgets |
| Isolation | Optional: a worktree is "a workspace with Git provenance" | Every card has its own worktree and branch (worktree boards) |
| Review, merge, tests | None | Reviewer agents, serial merge queue, test command, landing |
| Persistence | Server keeps PTYs alive; layout restores after restart; agents resume if they reported a resume command | SQLite state; sessions per card |
| Remote | SSH: attach a local UI to a remote server, or save several machines in one window | Loopback only today |
| Agent-facing surface | A skill file plus a JSON CLI and socket API | The `board` MCP server, plus `get_docs` |

So the two projects overlap in the **runtime and UX layer** (seeing many agents at once, knowing which one needs you, attaching from anywhere) and not at all in the orchestration layer (planning, routing, review, landing), which is our whole point. herdr is the better reference for how a terminal-first control surface should feel; we are the better reference for what the work graph under it should be.

What we should **not** copy: its terminal emulation (it vendors libghostty-vt, with a 5k-line Rust binding, plus thousands of lines of PTY and screen-state code), screen-scraping state detection for agents we can already drive over a protocol, Windows ConPTY support, and its plugin system (it exists to keep herdr's core lean; we do not have that problem yet).

### How herdr agents talk to each other (including across machines)

There is **no agent-to-agent protocol and no message router**. An agent in one pane runs the `herdr` CLI (the skill teaches it how), the CLI sends a JSON request to the local server's socket, and the server does to the other agent's terminal what a human would:

- `herdr agent prompt reviewer "..." --wait` types the text into the target agent's pane (honouring bracketed paste, then Enter) and waits until its detected state settles on idle, done or blocked.
- `herdr agent read reviewer` returns the target's screen text, which is how the answer comes back. If the screen is too short to hold the reply, the skill says to ask the target to write it to a file and read that.
- `herdr agent wait`, `agent send-keys` (for example `esc`) and `pane run` / `pane wait-output` complete the set. A prompt to an agent already waiting at an approval dialog is refused (`agent_blocked`), so one agent cannot blindly answer another's permission request.

**Across machines** the same request goes through SSH. `herdr --machine <label> agent prompt ...` uses the saved profile's SSH target, runs `herdr remote-api-bridge` on the remote host (`src/remote.rs`), which pipes stdio to that host's local API socket, and speaks the same JSON protocol. The remote server never listens on the network. Agent names and pane IDs are scoped to a server, so the caller must name the machine every time; an agent on machine A reaches an agent on machine B only because someone saved B as a machine on A and the caller adds `--machine`. Nothing is shared between the two servers.

The trade-off: it works with any agent that has a terminal, but the channel is the screen. Delivery and completion are inferred (hence the stall and blocked checks), replies are scraped, and there is no durable thread. Ours is the opposite: cards, `send_message`-style board messages and the events log are structured and persistent, but only for agents we can give the `board` server.

### What screen-state detection is for

Two separate steps, both in `src/detect/`:
1. **Which agent is it?** The foreground process of the pane (name, argv, wrapper scripts) is matched to one of 24 known agents.
2. **What is it doing?** A TOML manifest per agent holds rules over regions of the live screen (the last N non-empty lines, the area below the last horizontal rule, the terminal title and progress escape sequences). Rules carry priorities and AND/OR/NOT gates; the winner gives `working`, `blocked` or `idle`, and anything unmatched on a known agent falls back to `idle`. Agents with an integration that reports state (Pi, OpenCode, Kimi, Kilo, MastraCode) skip this.

That state is the only thing that drives: the sidebar badges and the roll-up per workspace; the attention sort; toasts and sounds ("finished", "needs input"); the seen/done logic; `agent wait`, `agent prompt --wait` and the `agent_blocked` refusal; and the readiness check in `agent start`. It exists because herdr has no other window into an agent that it did not start through a protocol. It is acknowledged to be brittle (manifests are versioned, hot-reloadable and published separately from releases so a CLI update that changes its prompt can be fixed without a new herdr release; "idle is not authorization" in its docs).

We do not need it: hooks, ACP and telemetry tell us the state exactly. It would only matter for the generic-adapter idea in section 6.

## 2. Worktrees with multiple agents

**herdr.** Worktrees are a convenience, not a guarantee. `herdr worktree create --branch X` runs `git worktree add` under `<worktrees.directory>/<repo>/<branch-slug>` (default `~/.herdr/worktrees`), opens it as a workspace, and groups it under the repo's workspace in the sidebar. An agent may start in the shared checkout or in a worktree; nothing stops two agents editing the same files. Its own contributor rules tell agents to use `../herdr-worktrees/<task-slug>` for bigger work and "if you find unrelated implementation changes already in progress in the main worktree, use a dedicated worktree": isolation by convention, in prose.

Details worth noting from its docs and `src/worktree.rs`:
- Checking out an **existing local branch** if the name exists, otherwise creating it from `--base` or `HEAD`.
- `worktree remove` runs `git worktree remove` safely first; if Git refuses because the checkout is dirty, the user is asked again before a forced remove. It **never deletes the branch**.
- A `--trust-repository` flag adds Git's `safe.directory` trust for one command, only after the human verified the repo (Git rejects repos owned by another user).
- It detects a **leftover checkout folder** that matches the repo (`leftover_worktree_checkout_matches_repo`) instead of failing.
- Closing the parent workspace closes the group, but not the folders or branches.
- Worktree lifecycle is an event (`worktree.created`, `.opened`, `.removed`) that plugins hook, e.g. to bootstrap dependencies.

**Us.** Isolation is by construction: the daemon creates one worktree and one branch per card (`ensureWorktree`), paths are policed, build output is excluded from commits, and a serial refinery brings each branch up to date, tests it and lands it. Conflicts are handled by the merge queue and escalation, not by agents noticing each other.

**Where herdr is ahead of us** (worth copying):
1. **No worktree bootstrap.** A fresh worktree has no `node_modules`, no `.env`, no virtualenv. herdr solves it with a `worktree.created` hook. Today our agents each spend their first turn on `pnpm install`, or skip the build because it fails. A per-board **setup command** (run once per new worktree, output kept in the card's activity, cached or hard-linked where possible) is the most valuable single borrow for Phase 6's exit ("no agent skipping a build or test").
2. **Configurable worktree root.** Ours is fixed under the daemon state dir. Some people want checkouts beside the repo so editors and language servers find them.
3. **`safe.directory` handling** and leftover-folder recovery, for repos owned by another user or interrupted runs.
4. **Dirty-remove confirmation** when a card's worktree is deleted by hand. Our automatic cleanup is fine; a manual "delete worktree" in the UI should refuse a dirty one.

**Where we are ahead:** guaranteed isolation, a merge queue, automatic cleanup of losing best-of-N candidates, path policy.

## 3. Remote session linking

herdr's design, and what it teaches:

- **It never invents its own network protocol or auth.** Remote access is plain OpenSSH. `herdr --remote host` SSHes in, finds or installs a compatible `herdr` binary there, and bridges stdio to the remote server's local socket (`herdr remote-api-bridge`, `herdr remote-client-bridge`). Authentication, host keys, agent forwarding and keepalives are all OpenSSH's. The server never listens on a public port.
- **Saved machines** (`herdr machine add <host> --label x`): a profile is only an opaque ID, a label, an SSH target, an optional remote session name and an enabled flag. No passwords, keys or tickets are stored.
- **Many machines in one window.** The selected machine streams its screen; the others stream only workspace and agent state, so a combined agent list shows where each agent runs and which one needs an answer.
- **IDs are scoped to a server.** `w1:p1` exists on every machine. Commands from a pane do not retarget when you select another machine; automation uses an explicit `--machine <label>` prefix.
- **Failures are local.** A lost connection dims that machine's cached state and disables input until a fresh connection arrives; other machines are unaffected. Backoff grows to two minutes, and a brief success does not reset it. Needs-attention states (`! auth`, `! error`) are shown, never silently retried with prompts. Background connections never answer a prompt or install or restart anything.
- **Compatibility is negotiated, not exact.** Client and server advertise capabilities; a missing optional method disables one action rather than rejecting the connection. Its `AGENTS.md` treats the wire format as frozen (generation 1 must stay available).
- **Lag is explicit.** A subscriber that falls behind gets an `events_lost` error and is disconnected, so it re-reads state instead of silently missing events.

**What we have today:** the daemon listens on `127.0.0.1`, **its REST and WebSocket API has no authentication** (only the gateway and the Claude hook endpoint carry bearer tokens), and the live `/ws` stream has no cursor, so a client that reconnects misses whatever happened in between. Remote linking needs three things before any of herdr's ideas apply:

1. A **bearer token for the API and `/ws`** (generated on first run, stored next to the state, required when the request is not from loopback; the web UI, VS Code extension and TUI send it). Without this, no tunnel is safe.
2. An **event cursor**: `/ws?since=<event seq>` replays what a client missed, and says so when the log no longer reaches back (herdr's `events_lost`). The events log already exists; this also fixes flaky reconnects for the VS Code extension today.
3. **Machine profiles on the client side** (label, SSH target, local port), with the connection made by `ssh -L` (or `ssh -N` with a ControlMaster), not by the daemon. Everything else is the client's problem: the web UI, VS Code and the TUI each gain a machine switcher, and board and card IDs are shown scoped by machine.

Recommendation: **follow herdr and let SSH do the work.** Do not ship our own TLS, relay or account system. Phone access then comes free (SSH client plus the TUI), as herdr advertises.

## 4. The TUI

herdr's TUI is mouse-first with a tmux-style prefix layer; its layout is a sidebar of workspaces and agents beside the pane area. Ideas that transfer:

- **Attention first.** Agents are sorted by attention (blocked, then done-and-unseen, then working, then idle). A workspace's state is the roll-up of its agents. Our equivalent is the "Needs you" list: approvals, escalations, cards waiting for a human review, cards held for an install or a grant.
- **"Seen" is per client.** `done` becomes `idle` once a client has looked; a second client keeps its own badge. We have no seen/unseen notion; for a TUI on a phone plus VS Code at a desk, the inbox must not clear itself on the other device. Needs a per-client read marker on approvals and finished cards.
- **Ordered, monotonic reports.** Every state report carries a sequence number; stale ones are dropped (`--seq`, `state_change_seq`, `completion_seq`). Our Claude hook posts can arrive out of order; a per-session sequence would make card state robust.
- **Declarative views.** `agent.view.set` takes a filter tree (`all/any/not/eq/in/exists` over status, workspace, tab and plugin tokens) plus a sort, and drives the sidebar, mouse targets and next/previous navigation. Cheap for us to adopt as saved filters on the board (for example "blocked or in Review, newest first").
- **Narrow screens.** It collapses the sidebar and uses a switcher on a phone. The TUI should be designed for 60 columns first.
- **Toasts and sound.** `herdr` (in-app), `terminal` (an OSC notification that works through SSH), `system` (OS service) or off; separate sounds for "finished" and "needs input"; popups suppressed for the tab you are looking at. We already generate a short plain sentence per request with the fast lane; the TUI is where it gets used.
- **Mouse is first-class, not an add-on.** The client turns on the terminal's mouse reporting (xterm modes 1000, 1002, 1003 and SGR 1006; `src/terminal_modes.rs`) and handles clicks, drags and wheel itself: click a pane, tab, workspace or agent; drag split borders; select text; right-click menus; every action reachable by mouse, with keys as an optional layer. A config switch (`ui.mouse_capture = false`) turns capture off for people who want the terminal's own selection. For users who do not know vim or tmux keys this is the main usability win, and it works over SSH and on a phone.
- **Attach is a first-class action.** We already stream a card's live Claude terminal over `/ws/terminal/:id` for the web UI.

How we should build ours (our constraints differ: TypeScript, Node 24, shared types):
- **Ink (React for terminals)**, so it shares `@mh/core` types and a client library with the web UI, and `apps/tui` follows the layout of `apps/vscode`. The alternative (a Rust TUI) would give a single binary but cuts us off from our types and tests.
- **Mouse support is ours to add.** Ink (as far as I know) has no built-in mouse handling. The mechanism is small: write the same enable sequences herdr uses, parse the SGR mouse reports from stdin, hit-test against our own layout, and always turn mouse reporting off on exit. There are community packages for this; I have not evaluated any. Design rule: every action is a visible clickable control, and keyboard shortcuts are shown on the controls, not required.
- **Do not embed a terminal emulator.** herdr needs one because it is a multiplexer. We only need "show this card's terminal": suspend the Ink screen and pipe the user's terminal straight to `/ws/terminal/:id` until a detach key, like `tmux attach`. If we want a live preview of several terminals later, that is the point to consider an emulator.
- A **shared client package** (`packages/client`) for REST, the live socket with a cursor, machine profiles and the token, used by the TUI first and by the VS Code extension and web UI later; today each of those carries its own copy of `api`/`client` code.
- Screens, in order: Board (columns, filter, card detail with activity and changes), Needs you (approve, deny, answer, with notes), Pools and budgets strip, Live terminal attach. Everything else stays in the web UI.

## 5. The skill file

herdr ships one skill, `skills/herdr/SKILL.md`, installable with `npx skills add herdrdev/herdr --skill herdr -g`. What makes it good, and worth matching:

- **Gated.** The description says to use it only when the user names herdr, and the first step is `test "$HERDR_ENV" = 1`, stopping otherwise. It never controls a session it was not started inside. The environment variables herdr injects into every pane (`HERDR_ENV`, `HERDR_PANE_ID`, `HERDR_BIN_PATH`, `HERDR_SOCKET_PATH`) are the contract.
- **The binary is the authority on syntax.** The skill teaches concepts and judgement (which primitive to use, IDs come from JSON responses, not guesses) and tells the agent to run `herdr --help` and `herdr <group>` to learn the current commands. It does not duplicate flags, so it does not go stale.
- **Safety rules written as rules.** Do not close what you did not create; do not stop the server; do not answer an approval dialog on the user's behalf; a timeout does not prove the prompt was not delivered, so read before retrying; use `--no-focus` for background work.
- Its `AGENTS.md` says the skill tracks the latest *stable* release only, and is updated in release prep.

For us there are two different audiences, and we only serve one so far:
1. **An agent working a card** already gets everything through the `board` MCP server and `get_docs` (`docs/agents/*`). That stays.
2. **An agent or person outside a card**: your own Claude Code in a terminal or VS Code, asked to "plan this on the board", "what is blocked", "approve the install". It has no `board` server and no CLI to call. This is the skill file's job, and it needs something to drive: **a small CLI (`ih`) over the daemon's REST API**, with JSON output, stable IDs and a `--help` that is the source of truth. The TUI would be built on the same client package.

So the skill depends on the CLI, and the CLI and the TUI share a client. Suggested contents for `skills/infinity-harness/SKILL.md`: the gate (`IH_URL` set, or a reachable daemon; stop otherwise), what a board, card, worktree and approval are, which actions are safe (read, plan, message, comment) and which need the human (approve, deny, land, grant, install; never answer an approval for them), and "run `ih --help` for the commands".

## 6. Other things worth repurposing

| Idea | What herdr does | What it means for us | Size |
|---|---|---|---|
| Worktree setup hook | `worktree.created` event hook | Per-board setup command for each new worktree | S |
| Event cursor + `events_lost` | `events.subscribe` with bounded history | `/ws?since=` replay | S |
| Resume after restart | Agents report a resume command (`resume_argv`); restored panes run it | Check what a daemon restart does to live sessions today; for Claude, `--resume <id>`; for ACP, `session/load` where offered. **I have not checked what we do now.** | M |
| Generic "any CLI agent" adapter | Screen manifests in TOML for 22 agents (Amp, Kiro, Cursor, Gemini, Droid, Kimi...) with AND/OR/NOT line rules and an `explain` command to debug them | A fallback adapter for agents with no ACP or hooks, using herdr's manifests (Apache-2.0, attribution required) for state. Large, and screen-scraping is brittle by their own admission ("idle is not authorization"). Only if we want those agents on the board. | L |
| Prompt delivery you can trust | `agent prompt --wait` must see `working` or `blocked` within 5 s, else `agent_prompt_stalled`; never resend blindly | Same stall detection for messages we deliver to PTY sessions | S |
| Notifications with kinds | done vs request sounds, per-agent override, suppressed for the viewed tab | TUI and VS Code notifications | S |
| Named sessions | Separate runtime namespaces per server | We already have boards; no change | none |
| Update handoff | Live binary handoff so panes survive an update | Not needed; our processes are the agents' own | none |
| Pre-release audit skill, throwaway-repro skill | Maintainer skills in `.agents/skills` | The throwaway-repro idea (a disposable named session to drive the real UI) is how we should test the TUI | S |

## 7. Order for 6.6 (all eight steps built 2026-11-06; what each did and did not cover is under Phase 6.6 in master-plan.md)

1. API token and `/ws?since=` cursor (unblocks everything remote, and fixes reconnects now).
2. `packages/client` extracted from the extension and web client; machine profiles and SSH-forward helper.
3. `ih` CLI on it.
4. Worktree setup command and configurable worktree root (independent; can go first if you prefer).
5. `apps/tui` (Ink), mouse-first (decided 2026-11-06): Needs you, Board, Pools, terminal attach.
6. `skills/infinity-harness/SKILL.md` and `ih skill install`.
7. Resume-after-restart audit, then per-client seen markers.

Not recommended for now: the generic screen-manifest adapter, a plugin system, an embedded terminal emulator.
