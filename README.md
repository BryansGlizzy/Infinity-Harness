# Infinity Harness

_A meta harness for all of your agents to work together._

Infinity Harness runs the coding agents you already have (Claude Code, Codex, Kimi Code, Antigravity, OpenCode) as a team. You describe a goal; an **orchestrator** agent splits it into **cards** on a kanban board; each card is worked by whichever agent has quota and fits best, in its own git branch; finished work is reviewed, tested and **landed** (as a GitHub PR or a local merge). You watch it live and step in only where a person is needed.

It is a local daemon with a web UI, a VS Code extension, a terminal UI and a command line (`ih`). Everything runs on your machine, with your own logins.

| | |
|---|---|
| **New here?** | Read this page, then the step-by-step [user guide](docs/user-guide.md). |
| **How it is built, and what is and isn't verified** | [docs/master-plan.md](docs/master-plan.md) |
| **What agents are told about the board** | [docs/agents/](docs/agents/) |

## What you need

- **Node 24+**, **pnpm**, **git**. (The daemon runs TypeScript directly: there is no build step for it, and `./install.sh` checks or installs Node 24+ and `pnpm` automatically.)
- **At least one agent, signed in as you normally would** — or installed and signed in directly from the **Agents → System Harnesses & Agent Links** panel in the Web UI. Pools whose tool or keys are missing are simply not offered until linked.

| Agent (pool) | CLI / Bridge & Sign-In (CLI or 1-click in Web UI → Agents) |
|---|---|
| Claude Code (`claude`) | `claude` CLI (`npm i -g @anthropic-ai/claude-code`), logged in (`claude auth login` or **Sign in** in UI) |
| Codex (`codex`) | `codex` + `@agentclientprotocol/codex-acp`, logged in (`codex login` / device code / API key in UI) |
| Kimi Code (`kimi`) | `@moonshot-ai/kimi-code`, logged in (`kimi login` or device code in UI) |
| Antigravity (`agy`) | `scripts/install-agy-acp.sh`, logged in via Google OAuth (`node scripts/agy-acp-login.mjs` or **Sign in** in UI) |
| NVIDIA NIM / a local model (`nim`, `local`) | OpenCode 2 (`https://opencode.ai/v2/install`) and `NVIDIA_API_KEY` / `LOCAL_LLM_BASE_URL` in `.env` (or **Configure NIM / Local LLM** in UI) |
| GitHub PRs (optional) | `gh auth login` (or token login in UI) and an `origin` remote on GitHub. Without them, cards land as local merges. |

Optional helpers (all in `.env`; copy `.env.example` and fill in what you use): **Kev**, a small judge model that scores cards and routes work (`KEV_URL`, `KEV_API_KEY`, `KEV_MODEL`; without it cards route on default estimates); **embeddings** for smarter note search (`EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL`); and **Groq / NIM / local** for the small fast-lane jobs (status lines, commit messages) via `GROQ_API_KEY` and friends.

## Install, build and update (1-shot script)

Run the all-in-one installer from a checkout (or clone directly from `https://github.com/BryansGlizzy/Infinity-Harness.git`):

```sh
./install.sh                   # checks/installs Node 24+ & pnpm, installs deps + agy ACP, builds Web UI & VS Code ext, links ~/.local/bin/ih
./install.sh --with-agents     # also installs missing global agent CLIs (claude, codex, codex-acp, kimi, opencode)
./install.sh --update          # pulls latest changes from GitHub (or run: ih update) and rebuilds everything
pnpm start                     # (or: ih daemon) serves everything on http://127.0.0.1:7420
```

Or manual step-by-step:

```sh
pnpm install
./scripts/install-agy-acp.sh   # only if you use Antigravity
pnpm start                     # builds the UI, then serves everything on http://127.0.0.1:7420
```

Open <http://127.0.0.1:7420>. For development: `pnpm daemon` (restarts on change) and `pnpm web` (Vite on :5173).

**VS Code:** `pnpm --filter infinity-harness install-local` builds and installs the extension. Open any repository and the Infinity Harness view finds (or creates) its board. See [apps/vscode/README.md](apps/vscode/README.md).

**Ports:** `7420` the UI and API, `7421` the LLM gateway, `7422` the federation port (other swarms; see below). A second, separate instance on one machine (its own database, worktrees and identity) needs its own folder and ports:
`IH_STATE_DIR=/some/dir IH_PORT=7430 IH_GATEWAY_PORT=7431 IH_FED_PORT=7432 node apps/daemon/src/main.ts`

## Your first goal

1. **New board.** Pick a project folder (or create one). A git repository gets **worktree mode**: every card works on its own branch. Any other folder gets **direct mode**: agents edit the folder itself, a few at a time, like an IDE assistant, with no branches or landing.
2. **Switch on your agents.** The **Agents** view opens next. New boards start with the subscription workers *off*: turn on the agents you want as workers (ones you have signed in to), and pick an orchestrator. Without a worker, cards have nobody to take them.
3. **Set the test command** (Settings → Refinery), e.g. `pnpm test`. Landing runs it before anything is merged.
4. **Type a goal** in the top bar and press **Plan**. The orchestrator reads the repo and creates cards. They start by themselves.
5. **Watch.** The **Tree** (or **Board**) shows each card with its role, agent, model and a one-line status. Click a card to see its activity, the files it changed, and the notes it left; attach to a Claude card's terminal; message its agent (start with `!urgent` to interrupt).
6. **Step in when asked.** Things that need you collect in one place: a finished card you chose to review, a question from an agent, a request for a new tool, a blocked card. Everything else lands on its own. You can clear messages once read, and clicking one takes you to what it is about.
7. **Read the wrap-up.** When the last card of a goal is done, the orchestrator that planned it gets one more turn and writes a report from what its cards told it: what was done, how to run and verify it, decisions, open issues, and the documentation they mention. It does not go back through the project, so it costs little. It arrives in your messages and is saved on the goal.

## How it works, in one page

- **Cards and agents.** A goal becomes a tree of cards. Each *agent* is a pool (Claude, Kimi, …) plus a model, a reasoning level and a role: **orchestrator** (plans), **lead** (splits a big chunk further) or **worker** (writes code). Settings say which agents may hand cards to which.
- **Routing is code, not a model.** Kev scores each card's kind of work and difficulty. Then plain code ranks the agents that are allowed, free and under their rate limits, by their track record on that kind of work. Over time it learns which model does what well.
- **A model that stops answering is taken out, not blamed.** Endpoints are checked, an unreachable provider is never counted against a model, and a pool whose endpoint is really down is taken out of rotation until you put it back (Agents view: online, no response, **Test**).
- **Limits are respected.** Each pool's 5-hour, weekly and per-minute windows feed one limiter: at 80% an agent ranks lower, at 95% it gets no new cards and work flows to others. You can also set token or dollar **budgets** per board or agent.
- **Each card works in isolation.** Its own git worktree and branch; it may only touch its worktree plus shared tool and scratch locations; every refusal is reported to you. Agents reserve files before editing, so two cards don't collide.
- **Agents talk through the board.** A shared MCP server lets them message each other, ask a question, search each other's notes and decisions, and write a handoff when a card moves to another agent.
- **Landing.** A finished card is optionally reviewed by an agent from a *different* provider, then queued: the base branch is merged in, your tests run, and it lands as a PR (merged automatically) or a local merge commit. Conflicts and failing tests go back to the author, then to another agent, then to you. `git log --first-parent main` reads as one commit per card.
- **You can review instead.** Turn on *Hold cards in Review for me* and approve, request changes (with comments on lines), land now, or try a branch in your checkout, from the web UI or VS Code.
- **MCP servers, hosted once.** Install or link MCP servers for the machine (Settings → MCP); each board's **MCP** tab switches them on and sets which agents may use each one (off, read only or full). The harness runs a shared server once and agents reach it through it, so no agent ever holds the server's address or keys. The orchestrator is told what is available, so it never plans work nobody can do. Roblox Studio ships as an **add-on** you switch on per direct board (off by default): its MCP server, RbxSync's file sync running in the board's folder, and RbxSync's MCP server, all together. Agents can also carry short notes (UI DEV, CODE REVIEW…) that steer which cards they get.
- **Things agents may not do alone** (spawn another agent, add an MCP server or skill, get a browser tool, install software) wait in an **approval queue** for your yes or no.
- **Restarts are safe.** After a stop or crash, interrupted cards go back to Ready with their work kept, and agents pick their conversation up where the tool allows.

## Four ways to drive it

| | |
|---|---|
| **Web UI** | The full picture: tree, board, agents, pools, metrics, swarms, settings, a **file tree** down the left for reading the project (and a card's worktree), and board removal. |
| **VS Code** | Cards and "Needs you" in the sidebar, a chat per goal, plan from a selection or a file's problems, review a card in the diff editor, answer agents' questions in the editor. |
| **Terminal UI** | `ih tui`: Needs you, Board, Pools and Files, mouse-first (everything clickable, keys printed on the buttons), works over SSH and on a phone. |
| **Command line** | `ih` prints JSON when piped and tables at a terminal. `pnpm ih help` lists it all. |

```sh
ih status                      # daemon, boards, pools
ih plan "add dark mode"        # the orchestrator makes cards
ih needs                       # everything waiting for you
ih approve ap_1f3 ; ih deny ap_9c2 --note "not now"
ih review c_ab12 changes --notes "handle the empty state"
ih watch --count 20            # live events, one JSON line each
ih machine add me@workbox --label workbox ; ih --machine workbox cards   # another computer, over SSH
ih skill install               # teach another agent (e.g. your own Claude session) how to use ih
```

`IH_URL` and `IH_TOKEN` point `ih` at a daemon. **Other machines** are reached over SSH, never by exposing the daemon to the network.

## Several swarms working together

Run Infinity Harness on more than one machine (yours, or a colleague's) and the daemons can cooperate. Open the **Swarms** view:

1. **Connect.** Give the other swarm's address (an SSH target and its federation port 7422, or a local URL of your own tunnel). The box on its Swarms page shows what to give you. The other operator sees "wants to connect" with your **fingerprint**, compares it, and accepts. Until then nothing you sent reaches any of their agents.
2. **Share.** Each swarm publishes the projects it chooses as short **project cards** (drafted from the README and manifests, edited by you), at *basic* or *full* visibility. A **trusted** peer sees more.
3. **Ask.** Type `@` in a goal to name a peer's project (`@beta/textkit`). An agent that needs something from another swarm (a fix, a version, an answer) sends a **request**; the other swarm's orchestrator answers it, or plans the work, and replies. The asking card waits and carries on with the reply. You can let a trusted peer's requests start automatically within token limits, and every request has a budget.

Only structured requests and replies cross, never chat or code. See the user guide (section 10a).

## Safety, plainly

- **Local first.** The daemon listens on `127.0.0.1`. Other machines (and other websites) cannot drive it: a token is required from elsewhere, and Host/Origin checks stop browser tricks. The first start writes a token to `.infinity-harness/api-token`.
- **Keys stay in the daemon.** Agents get a local token, not your provider keys.
- **Not a sandbox.** Agents' shell commands run on your machine inside their worktree policy, which is a guard rail, not a container. Container isolation is not built yet.
- **Deleting is deliberate.** Removing a board either forgets it (your project folder stays) or also deletes the folder, which asks you to type the board's name and is refused for your home folder or anything holding Infinity Harness.

## Configuration you will touch

- **Settings** (per board, with defaults shown and a Reset per tab): pool slots and scarcity, tree limits, what each role may do, learning, budgets, tools (review, best-of-N, tool grants), the refinery (landing mode, test command, a worktree setup command such as installing dependencies).
- **`.env`:** keys and URLs (see `.env.example`). `IH_API_TOKEN`, `IH_REQUIRE_TOKEN=1`, `IH_ALLOWED_HOSTS`, `IH_WORKTREES_DIR`, `IH_FED_PORT` (`off` disables federation) are the ones people reach for.

## What is where

| | |
|---|---|
| `apps/daemon` | the server: runner, scheduler, refinery, board MCP server, federation |
| `apps/web` · `apps/vscode` · `apps/tui` · `apps/cli` | the four clients |
| `packages/` | shared code: types, database, adapters for each agent, the client library, router, gateway, fast lane, notes |
| `docs/` | user guide, master plan, the agents' own guide, research notes, `archive/` (the unabridged plan and the old long README) |
| `skills/infinity-harness/` | the skill file for agents outside the board |
| `.infinity-harness/` | runtime state: database, worktrees, keys (git-ignored) |

## Upgrading from the old name (Meta-Harness)

Nothing to do by hand. On the first start the daemon moves `.meta-harness/` to `.infinity-harness/`, renames the database, points your cards and git worktrees at the new place, and keeps honouring `MH_*` settings as `IH_*` (it tells you which to rename). Branches already called `mh/…` stay as they are; new ones are `ih/…`. The web UI forgets its remembered view and theme once.

## Checks

```sh
pnpm test        # ~300 tests against a real daemon with fake agents
pnpm typecheck
```

The tests use scripted fake agents, so they prove the plumbing, not how a real agent behaves. The master plan's section 8 says what has and has not been tried on real agents.
