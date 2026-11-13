# Infinity Harness

_A meta harness for all of your agents to work together._ (Formerly Meta-Harness; package names and the `.meta-harness/` state folder keep the old name.)

A local daemon and web UI that runs the coding agents installed on this machine as workers on a kanban board. Each card runs in its own git worktree and branch, and agents coordinate through a shared board server. The plan of record is [docs/master-plan.md](docs/master-plan.md). **New here? Start with the step-by-step [user guide](docs/user-guide.md).**

**Status:** Phases 1–5.5 done (shared context and learning, plus setup, reasoning levels and councils). Phase 5.6, UI refinement, is under way: Agents and Pools views, tabbed Settings, a draggable tree with model tags and live animations, and themes are in. **Phase 6 is built, including 6.6** (terminal UI, `ih` command line, other machines over SSH, a skill file, worktree setup, restart recovery; see below):

**Phase 7, swarm federation, is built** (F1 to F4: harnesses on different machines connect, share what they own and file requests with each other, agents can ask a peer and wait for the answer, trusted peers can be auto-accepted within limits, and requests carry budgets and milestones; see below and `docs/master-plan.md`).
- **6.1:** the **VS Code extension** (`apps/vscode`): cards, a chat view per goal, review in the diff editor, an IDE bridge for agents, and **direct mode** (agents work in a folder itself, no git needed).
- **6.2:** **agent tool access**. Agents can use the machine's toolchains and scratch space, not just their worktree.
- **6.3:** **metrics and budgets**: tokens and cost per agent, model, pool and card tree (Claude's OpenTelemetry feed, harness-reported usage, the gateway); budgets per board and per agent that warn at 80% and stop new work at 95%; a day of history per pool.
- **6.4:** **governance**: an approval queue for escalations, new agents, MCP servers, skills and tool grants; agent-facing docs (`docs/agents/`, served by `get_docs`).
- **6.5:** **deeper verification**: per-card tool grants (a headless browser for UI checks), and **best-of-N** (race a big card on several agents, Kev keeps the best).
- **Agents:** Claude Code, Codex, Kimi Code, Antigravity and OpenCode (NVIDIA NIM, local LLM) all work cards end to end. Each agent is a pool, a model chosen from what that harness offers (e.g. Gemini 4 Argon or 3.8 Flash on agy, Opus or Sonnet on Claude, any Kimi or NIM model) and a **reasoning level** from the ones the harness publishes.
- **Setup:** **New board** browses to any folder. A git repository gets **worktree mode**: each card on its own branch, landed through the merge queue. Any other folder defaults to **direct mode**: agents edit the folder itself, like an IDE assistant, with no branches, reviews or landing, one worker at a time by default. You can also have a non-repository folder set up as one (git, README, .gitignore, first commit, optionally a GitHub repository) and use worktrees. Settings then opens at the agent layout.
- **Planning:** type a goal and the orchestrator agent (any pool and model) splits it into cards. It can hand a large chunk to a **lead** agent, which splits it further for its own workers. With two or more orchestrators, a **council** plans together: each proposes a split, Kev picks the best, each plans its share, and they cross-check each other's work at the end. Kev scores each card's work type and complexity, and deterministic code routes it to the best agent with free capacity and quota.
- **Live tree:** a tree view shows parent/child links, dependencies and agent-to-agent messages. A fast-lane narrator writes a one-line status for each card.
- **Coordination:** agents reserve files, message each other and humans, and are refused edits to files another card holds. They are told when a file they wanted is released.
- **Landing:** reviewed cards go through a serial merge queue per board. Each is brought up to date and tested, then lands as a GitHub PR that is opened and merged automatically, or as a local merge. Kev flags cards that need a second look; those are reviewed first by an agent on a different provider. Conflicts and failing tests go back to the author, then to another agent, then to you.
- **Shared context:** card specs, agents' summaries, decisions, interface contracts, findings and handoffs are saved as notes that any agent can search (keywords plus embeddings). A card that moves to another agent always carries a structured handoff. `ask_agent` gets an answer from another card, from its notes when that agent is busy.
- **Learning:** Kev scores landed work against the card's acceptance criteria. Routing blends each model's recorded outcomes per work type with priors that reflect what each model is good at.
- **VS Code:** the extension binds the open workspace to its board. It shows cards and what needs you in the sidebar, plus a **chat** per goal. You plan goals from the editor (with the selection or the file's problems attached), **review a card in the diff editor** (comment on lines, approve or request changes, land it now, or try it in your checkout), answer agents' questions and decide requests where you are, attach to an agent's terminal, and open the full board in a tab. While a window is attached, agents on the board can ask you a quick question, read the editor's problems for their files and show you a proposed change.
- **You as reviewer:** a card's branch can be approved or sent back by you (web UI or VS Code) instead of an agent. Turn on **Hold cards in Review for me** to make that the rule.
- **Metrics and budgets:** the **Metrics** view shows tokens and cost per agent, model, pool and card (a goal shows what its whole sub-agent tree used). **Budgets** cap a board or an agent; they live in the same limiter as the pools, so a halted agent is skipped by routing and a halted board starts nothing new.
- **Governance:** agents can *ask* for a new agent, an MCP server, a skill or a tool grant; each waits in the approval queue (status strip, or VS Code's Needs you). An escalation is answered there, and the card resumes with your note.
- **Tool grants and best-of-N:** a card can be given extra tools as MCP servers (Vercel's agent-browser and agent-desktop ship as grants). Big cards can optionally be raced by 2–3 agents, with Kev picking the winner.
- **Swarms:** this daemon can cooperate with others (yours on another machine, or a colleague's). **Swarms** view / `ih peer`: connect over SSH (or your own tunnel), compare fingerprints, and the other operator accepts you; until then nothing you sent reaches any of their agents. Each swarm publishes the projects it chooses (a card drafted from the README and manifests, reviewed by you), at *basic* or *full* visibility, and agents can look up what peers maintain. A peer can send a **request** (a bug report or a piece of work): nothing runs before its receiving operator approves it, and the goal it becomes is marked as untrusted outside text. Only structured data crosses, never chat or code. An agent blocked by a dependency a peer maintains can **ask that peer** (an approval for you first, by default): its card waits, and runs again with the answer and your acceptance criteria. A **trusted** peer can be **auto-accepted** within a per-request and a per-day limit, and every request has a budget (warn at 80%, held from 95%) and optional milestones. See the user guide, section 10a.
- **File tree:** the web UI has the project's files down the left side: folders open in place as you click them, a click reads a file in the viewer on the right, git's changes are marked (M modified, U new, a dot on a folder with changes inside), and with a card selected you can switch to that card's worktree. The TUI has the same as its **Files** tab (`4`; Enter or → opens a folder, a file opens in a reader). Read-only: agents and your editor do the writing.
- **Naming other swarms' projects:** type `@` in a goal or a message to a card and the web UI offers `@swarm/project` for everything your accepted peers share. A name typed in full (from any client, including `ih plan`) makes the daemon attach that project's card to what the planner is given, as data, with a reminder that the way to get something from them is a request.
- **Removing boards:** every client can remove a board (web *Remove board…*, VS Code, the TUI's board menu, `ih board remove`). **Remove from Infinity Harness** forgets the board and its records and deletes the card worktrees it made; your project folder and branches stay. **Delete on system** also deletes the project folder, after a second confirmation (the board's name typed back), and is refused for folders the daemon must never delete (home, the top of the disk, anything holding the harness, a folder another board uses).
- **Rate limits:** API traffic is paced by a gateway with per-pool limits. Claude's and Codex's 5-hour and weekly usage, observed lockouts and operator overrides feed the same limiter. Pools at 95% receive no new cards.

## Requirements

- Node 24+ (TypeScript runs directly; the daemon has no build step), pnpm, git
- Whichever agents you want, signed in as you normally would:

| Pool | Needs |
|---|---|
| `claude` | `claude` CLI, logged in (`/login`). Uses your Claude subscription. |
| `codex` | `codex` CLI signed in (`codex login`), plus the ACP bridge: `npm i -g @agentclientprotocol/codex-acp`. Uses your ChatGPT plan or API key. |
| `kimi` | `kimi` CLI (`npm i -g @moonshot-ai/kimi-code`), `kimi login` |
| `agy` | `agy` CLI signed in, plus `scripts/install-agy-acp.sh` (Google's ACP server). On macOS the server reuses the CLI login. On Linux, run `node scripts/agy-acp-login.mjs` once and open the link it prints. |
| GitHub PRs | `gh` CLI, `gh auth login`, and an `origin` remote on GitHub. Without them, cards land locally. |
| `nim`, `local` | OpenCode 2 (`~/.opencode/bin/opencode`, from `curl -fsSL https://opencode.ai/v2/install \| bash`) and keys/URLs in `.env` |
| judge | `KEV_URL`, `KEV_API_KEY`, `KEV_MODEL` (self-hosted Kev). Without it, cards route on default estimates and landed work isn't scored. |
| vector search | `EMBEDDINGS_BASE_URL`, `EMBEDDINGS_MODEL` (an OpenAI-compatible `/embeddings`, e.g. EmbeddingGemma). The key defaults to `KEV_API_KEY`. Without it, search is full-text only. |
| fast lane | `GROQ_API_KEY`/`GROQ_MODEL`. Falls back to NIM, then local. |

Copy `.env.example` to `.env` and fill in what you use. Pools whose CLI or keys are missing are simply not offered.

## Run

```sh
pnpm install
./scripts/install-agy-acp.sh   # only for the agy pool
pnpm start                     # builds the UI, then serves daemon + UI on http://127.0.0.1:7420
```

For development, run `pnpm daemon` (restarts on change) and `pnpm web` (Vite on http://localhost:5173, proxying to the daemon).

**VS Code:** `pnpm --filter infinity-harness install-local` builds `apps/vscode/dist/infinity-harness.vsix` and installs it. Then open any repository: the Infinity Harness view in the activity bar finds (or creates) its board. See [apps/vscode/README.md](apps/vscode/README.md). A GitHub Actions workflow (`.github/workflows/vsix.yml`) builds the `.vsix` on every change and publishes tagged releases (`vscode-v*`) to the Marketplace and Open VSX when their tokens are set.

To run a second, separate instance (its own database, worktrees and swarm identity, same logins), set `MH_STATE_DIR=/some/dir MH_PORT=7430 MH_GATEWAY_PORT=7431 MH_FED_PORT=7432`.

**Who can call the daemon.** It listens on `127.0.0.1`. The first start writes an API token to `.meta-harness/api-token` (readable by you only; `MH_API_TOKEN` overrides it). Callers on this machine need nothing; a caller from another machine, or from anywhere when `MH_REQUIRE_TOKEN=1`, must send `Authorization: Bearer <token>` (WebSockets: `?token=`). Without a token, requests are refused unless the `Host` header names loopback and any `Origin` matches it, so a web page on another site cannot drive the daemon. Agents' own endpoints (the board MCP server, telemetry, Claude's hook) stay open to local processes. `MH_ALLOWED_HOSTS=name1,name2` adds Host names. Web UI: if the daemon asks, the page prompts for the token once (or open it with `#token=...`). VS Code: `infinityHarness.apiToken`. This is the groundwork for reaching a daemon over an SSH port forward (master plan Phase 6.6).

**Federation port.** Besides the main port, the daemon listens on `127.0.0.1:7422` (`MH_FED_PORT`; `off` disables it) for other swarms. It serves only signed `/fed/*` routes and nothing else, so an SSH account you give a peer can be limited to it (`PermitOpen 127.0.0.1:7422`) instead of the whole operator API. This swarm's identity is an ed25519 key in `swarm-key.json` beside the database (mode 0600); `ih swarm` shows its fingerprint.

**Worktrees.** Each card gets its own worktree under `.meta-harness/worktrees/<board>/<card>` (set `MH_WORKTREES_DIR=~/checkouts` to put them elsewhere). Settings → Refinery → *Worktree setup command* runs once in each new worktree before its agent starts (install dependencies, copy `.env`; `MH_REPO_PATH` is the main checkout), is logged on the card, and when it fails the agent is told and you get a message. A folder in the way that is not a worktree of the repository is moved aside (`<dir>.leftover-<time>`), never deleted; a worktree whose folder was deleted by hand is repaired. `ih worktree remove <card>` deletes a card's worktree folder (the branch and its commits stay) and refuses when it has uncommitted changes unless `--force`. If git refuses a repository owned by another user, the daemon says to run `git config --global --add safe.directory <path>` rather than trusting it for you.

**Live stream.** `/ws?since=<seq>` replays the events after `seq` (at most 5000) and then goes live with no gap or repeat; `since=now` only reports the current position. A `stream.status` message follows the replay: `{ latest, replayed, lost }`, where `lost` (`ahead`, `too_many`, `invalid`) means the client must reload instead.

1. **New board**: browse to a project folder, or create a new one. Folders that aren't repositories yet are set up for you. The **Agents** view opens next: set up the agents, then the test command in Settings → Refinery.
2. Type a goal in the top bar and press **Plan**. The orchestrator reads the repo and creates worker cards, which start on their own. Or add cards yourself: a card moved to **Ready** is routed automatically, and **Run** picks a pool by hand.
3. Watch the **Tree** (or **Board**) view. Every card shows its role, agent, model and reasoning level. Drag tree cards to rearrange them (remembered per board); the toolbar has Fit, Follow running, Fold finished and colour by status or agent. Open a card for its **Routing** section (Kev's scores, why each agent was or wasn't chosen, and the card's routing rules) and its tabs:
   - **Activity:** the agent's work as it happens.
   - **Changes:** the files it changed, with diffs and whole files.
   - **Context:** its notes, and a search of the board's notes.
   - **Terminal** (Claude cards): see or take over the live session.

   **Run** works a card by hand on any agent and model. Message the agent from the card (start with `!urgent`, or tick Urgent, to interrupt its turn).

The status strip shows pool gauges (rate limits, Claude's and Codex's 5-hour and weekly usage, sessions working), active file leases, **Approvals** waiting for you, and messages agents sent to you. The **Pools** view expands each pool, grouped by harness: every window with its reset time, slots in use, the agents on it, the cards it is working on across boards, and a chart of its last 24 hours (fullest window, halted or locked stretches, requests and tokens). The **Metrics** view is covered below. The theme picker switches between Clean, Frutiger Aero, Metro, Metalheart and Glassmorphism.

The **Agents** view holds each agent's pool, model (from the models its harness offers), reasoning level, role (orchestrator, lead or worker) and which agents its child cards may go to, with the model family's strengths, its pool's live state, the hierarchy and the role permissions (create cards, add dependencies, spawn agents, propose MCP servers and skills, request tool grants). Two or more enabled orchestrators plan goals as a council.

**Settings** holds the rest, in tabs (each knob shows its default; each tab can be reset):
- pool slots and scarcity (shared by all agents on a pool), the Claude and Codex reserves (the share of each 5-hour window kept for the orchestrator) and the re-route delay;
- tree guardrails;
- **learning:** use outcomes in routing, Kev scoring, and a table of each agent's expected success per work type (editable; observed results shown underneath);
- the fast-lane toggles (including the notification text for approvals);
- **budgets:** a cap per board and per agent, in tokens or dollars, per day, per week or in total;
- **tools:** hold cards for your review, best-of-N, tool grants (and which need your approval), new-agent auto-approval, and the MCP servers and skills agents proposed that you approved;
- **Force 95%** per pool (in the Pools view), to watch work flow elsewhere.

## Agents and models

An **agent** is a pool plus a model and a role, e.g. `orchestrator` on Claude/Opus, `sonnet-lead` on Claude/Sonnet, `agy-argon` on agy/Gemini 4 Argon. Agents on the same pool share its quota, slots and rate-limit state. Every pool without its own worker or lead gets a worker on its default model (`*_MODEL` in `.env`), so a new pool works without setup.

The daemon asks each harness which models your login offers. The ACP harnesses (Kimi, agy, OpenCode) list them when a session opens; Claude Code takes the `fable`, `opus`, `sonnet` and `haiku` aliases. **Refresh models** in Settings probes again, e.g. after a plan change.

Delegation follows the agents' `delegates to` lists. Example:
```
orchestrator (agy · gemini-4-argon) → sonnet-lead, agy, kimi
sonnet-lead  (claude · sonnet, lead) → local, nim
```
The orchestrator's cards go to `agy`, `kimi`, or, with `delegate=true`, to the lead. The lead's cards go only to `local` and `nim`. An empty list means any worker (and for the orchestrator, any lead). Saving a loop is refused.

## How planning and routing work

1. **Plan.** A goal becomes an orchestrator card on the first enabled orchestrator agent (Claude Opus by default). It falls back to a lead, then to another subscription pool, when that pool is halted. The orchestrator creates cards with the board MCP tools `create_subtask`, `update_subtask` and `add_dependency`. `delegate=true` makes a lead card, which a lead agent plans the same way. Tools are gated by role (workers can't create cards by default) and by depth, fan-out and per-turn caps.
2. **Lint.** Agent-written cards are checked on the fast lane before assignment. A vague spec goes back to Backlog, and the orchestrator is asked to fix it.
3. **Classify.** Kev scores each card's work type (confirming the orchestrator's tag), complexity (0–4) and need for review, in one call.
4. **Route.** Code, not an LLM, ranks the agents:
   - **Filter:** role (lead cards go only to leads), routing rules (inherited down the tree; set per card in its Routing section, naming agents or pools), capability, free slots, pool state (never halted or locked), and the Claude and Codex reserves.
   - **Score:** success × headroom × scarcity × load.
   A card waits for its dependencies to reach Review, then starts with their branches merged. A dependency on a lead or orchestrator card waits for that card's whole subtree. A card that waits longer than the re-route delay for its previous agent moves to the next best one.

## Shared context and learning

**Notes.** Every card's spec and every agent's end-of-turn summary are saved automatically. Agents add their own with the board MCP tools:
- `put_artifact`: a decision, interface contract, finding or note;
- `write_handoff`: where the work stands;
- `search_context`: search the notes of the card, its sibling cards or the whole board;
- `get_artifact`: read one in full.

The fast lane tags and summarizes each note and widens searches with extra keywords. Search combines full-text and embeddings. It falls back to full-text when the embeddings server is down and fills in the vectors later. The card panel's **Context** tab lists a card's notes, searches the board and lets you add a note.

**Handoffs.** Whenever a card goes to another agent (a failed run, a second failed landing), the daemon writes a structured handoff: state, decisions, blockers, files edited and next steps, plus the previous agent's own handoff if it wrote one. The new agent gets it as its first message, and its prompt lists the card's earlier notes.

**ask_agent.** An idle agent is asked directly and the call waits for its reply. A busy one isn't interrupted: the fast lane answers from that card's notes, or the question waits in its inbox.

**Learning.** When a card lands, Kev scores the change against its acceptance criteria and checks it stayed in scope. Each result is recorded for the agent's pool and model:
- a landed card counts by its score;
- a failed landing counts low;
- a failed run or escalation counts 0;
- a card an agent reports blocked doesn't count until you weigh it under **Blocks to weigh** in the status strip (or on the card): **Pass** if the block was justified, **Fail** if it should have done the work, **Ignore** to leave it out;
- quota lockouts don't count.

Routing blends these outcomes, per work type and near the card's complexity, with the model's prior, which counts like three outcomes. A card's Routing section shows prior, observed and count for every agent.

The priors come from the operator's view of each model:
- **Opus:** planning.
- **Sonnet:** all-round coding.
- **Haiku:** research and summaries.
- **Gemini Argon:** research and creative work.
- **Gemini Flash:** web front-end and docs.
- **Kimi K3.1 Pro:** coding, tests and verification.
- **Nemotron:** review and tool use.
- **Local Qwen:** simple code and review.

NIM and the local model have no web access, so research cards never go to them.

## How cards land

Once a worker card reaches **Review**, the refinery takes it from there:
1. **Review.** If Kev's needs-review score is at least the threshold (Settings → Refinery, default 0.6), an agent on a *different* provider reads the branch and replies with a verdict. It works in a read-only copy. Requested changes go back to the author. After the last review round the card lands anyway, because the tests still gate it.
2. **Queue.** One card lands at a time per board, in order. A card waits for the cards it depends on to land, and for any file it changes that another card has reserved.
3. **Update and test.** The base branch is merged into the card's branch, and the board's **test command** runs in its worktree.
4. **Land.** The commit or PR text is written by the fast lane.
   - **GitHub PR** (default for repos with a GitHub remote, needs `gh auth login`): push, open the PR, merge it. Your local default branch follows when its checkout is clean.
   - **Local:** a merge commit onto the default branch, which moves only when its checkout has no uncommitted changes.
5. **On failure:**
   - A merge conflict or failing tests (with a short triage of the log) go to the card's agent first, then to a different agent with a handoff note, then to you. The limits are in Settings.
   - A run that fails outright is reassigned the same way.
   - Agents can also call `escalate_to_human`.
   - Moving a blocked card back by hand resets its counters.

**You as the reviewer.** Instead of (or before) the agent review, you can judge a card's branch yourself, from its panel in the web UI or from VS Code's diff editor:
- **Approve** sends it to the queue without an agent review.
- **Request changes** sends your notes (and any comments on lines of the diff) to the author, who reworks it. A new head is reviewed afresh.
- **Land now** skips the review and goes to the front of the queue; its tests still run, and the cards it depends on must have landed.
- **Check out here** detaches your checkout at the branch head, and **Apply diff** applies its diff to your working tree, so you can try it. Both refuse a checkout with uncommitted changes.
- **Hold cards in Review for me** (Settings → Tools) makes a card wait for your verdict. A verdict you give with it off still stands in for the agent reviewer.

Cards land as merge commits rather than squashes. A card that waited for another one already contains that card's commits, so a squash of the first would make it conflict. `git log --first-parent` shows one commit per card. Build output (`__pycache__`, `*.pyc`, `node_modules`, test caches) is never committed.

## Metrics and budgets

**Where usage comes from.** Every record is attributed to a board, card, agent and model where it can be:
- **Claude Code** exports OpenTelemetry metrics (tokens by type, and cost) to the daemon's OTLP/HTTP receiver (`POST /v1/metrics`). The daemon turns them on for each Claude session (`CLAUDE_CODE_ENABLE_TELEMETRY` and the `OTEL_*` variables) and tags them with the session, so no setup is needed. Checked live against Claude Code 2.1.318. The payload also carries account details; the daemon stores none of them.
- **ACP harnesses** (Kimi, agy, Codex, OpenCode) report a turn's token usage in the turn's result when they publish it; the daemon records it when present.
- **API pools** (NIM, local) are counted at the gateway. A gateway request names no card, so it is credited to the card working on that pool when exactly one session is; otherwise it stays unattributed (still counted for the pool).
- Cost is shown only where a harness reports it (Claude Code). Cache tokens are tracked apart and are not counted in budgets.

**The Metrics view** (top bar) shows, for the last hour, day, week or month: total tokens and cost, tokens over time, each budget with its gauge, and tables by agent, model, pool and card. The card table rolls usage up the tree, so a goal or lead shows what its whole sub-agent tree used.

**Budgets** (Settings → Budgets): a limit per board and per agent, in tokens or US dollars, per rolling day, per rolling week or in total. They are windows in the same limiter as the pools, so they behave the same way:
- at 80% the agent ranks lower in routing and you get a message;
- at 95% an agent gets no new cards (the reason shows in the card's Routing section), or, for the board budget, no new card starts and no new goal is planned;
- turns already running finish; nothing is killed. Raise the limit or wait for the window to roll over.

**Pool history.** The daemon samples each pool's state and windows (every minute, when something changes) and keeps a week. The Pools view charts the last 24 hours per pool.

## Governance: approvals, MCP servers, skills and tool grants

Some things an agent may not do on its own. It asks; the request waits in the **approval queue** (the status strip's **Approvals**, or VS Code's Needs you view) until you decide. Each request is worded in a plain sentence by the fast lane (falls back to plain text).

| Request | How an agent makes it | What approving does |
|---|---|---|
| **Escalation** | `escalate_to_human`; also when the refinery gives up on a card | Your answer goes to the agent and the card runs again (its retry counters reset). |
| **New agent** | `spawn_agent` (needs the role's *Spawn agents* permission; off by default) | Adds the agent profile to the board. Settings → Tools can apply these without asking. |
| **MCP server** | `propose_mcp` (needs *Propose MCP / skills*; off by default; always waits) | Every new agent session gets the server. Running sessions don't. |
| **Skill** | `propose_skill` (same permission; always waits) | New worker prompts carry the skill's instructions. |
| **Tool grant** | `request_grant`, or `grants` on `create_subtask` | The card gets the grant's MCP server the next time it runs. |
| **Install a tool** | Raised by the daemon the first time a card holding a grant meets a tool that isn't installed (once per board and tool) | Runs the grant's install command on this machine, then the waiting card starts with the tool. Denying lets it start without the tool. |

Approved MCP servers and skills are listed (and removable) under Settings → Tools.

**Tool grants** (Settings → Tools) are extra MCP servers a single card's agent can use, named `grant-<name>`. Two ship with the daemon:
- `browser`: a headless browser, [agent-browser](https://github.com/vercel-labs/agent-browser) run as `agent-browser mcp`. You don't have to install it yourself: the first card that needs it waits while you're asked to approve `npm install -g --allow-scripts=agent-browser agent-browser && agent-browser install` (it downloads Chrome for Testing, about 200 MB; some Linux systems also need `agent-browser install --with-deps`, which needs root and isn't run for you). Each card gets its own isolated session (`AGENT_BROWSER_SESSION`), its screenshots and downloads go to `/tmp/mh-browser/<card>` rather than the worktree, and an idle browser exits after 5 minutes. Needs your approval by default.
- `computer`: the desktop, [agent-desktop](https://github.com/vercel-labs/agent-desktop) run as `agent-desktop mcp`. Installed the same way (`npm install -g --allow-scripts=agent-desktop agent-desktop`) when you approve. It sees and operates desktop apps through the OS accessibility tree, on the real desktop of the machine the daemon runs on (it needs macOS 13+, Windows 10 1809+ or Ubuntu 24.04+ with AT-SPI; macOS needs the Accessibility permission, `agent-desktop permissions --guide`). **Off by default**: turn it on in Settings → Tools, and keep it on `approval` unless you trust the board's agents with your desktop. Snapshots and screenshots can contain private desktop content.

Both tools ship their own usage guide (`agent-browser skills get core`, `agent-desktop skills get desktop`); the grant's prompt text tells the agent to read it first. **Installing.** A card whose grant's command isn't on the machine does not start. The daemon asks you once (an **Install a tool** approval that shows the exact command), and the card starts when the install ends. The command is the grant's `install` field, which you can edit in Settings → Tools; an agent's request only ever names the grant, never a command. Settings → Tools also shows each tool as installed or not, with an **Install** button (your click is the approval). Denied, or failed, installs let the card start without the tool, with a message saying why. `npm` blocks install scripts by default, which is why the commands pass `--allow-scripts` for just that package. The automated tests use fake agents and a stand-in installer. Checked by hand on this machine: both packages installed with those commands, `agent-browser mcp` opened a page, took a snapshot and wrote a screenshot to the per-card folder, and `agent-desktop mcp` answered `tools/list`. Driving a real desktop with `agent-desktop` was not tried.

Each grant is `off`, `approval` or `auto`. A card with a grant waiting for approval does not start until you decide. `{card}` and `{worktree}` in a grant's arguments and environment are filled in per card.

**Agent docs.** `docs/agents/` is the agents' own guide (the board tools, conventions, tool access, how to ask for things). Agents read it with the `get_docs` tool, and their prompts point to it.

**Needs network.** An orchestrator can mark a card `needs_network`; agents whose shell has no network (Codex) are then skipped, with the reason shown in the card's Routing section.

## Best-of-N

Off by default (Settings → Tools). When on, a worker card at or above the chosen complexity is raced by 2–3 agents at once, when at least two different agents could take it. Each candidate has its own worktree and branch (the card plus clones titled "… (candidate 2)"). When all have finished, Kev scores each diff against the card's criteria; the best goes on to review and landing, and the others are discarded (branch and worktree removed, a low outcome recorded for their agents). Cards that depend on the original follow the winner. It costs N times the tokens and is not used on direct boards.

## How a run works

1. The daemon creates `.meta-harness/worktrees/<board>/<card>` on branch `mh/<card-slug>-<id>` and starts the agent there. The agent gets the card's prompt and a `board` MCP server for `reserve_paths`, `post_message`, `read_inbox`, `list_cards`, `who_holds`, `report_blocked` and more.
2. Messages to a busy agent wait for its next turn. Urgent ones interrupt it.
3. When the agent finishes, the daemon commits its changes, releases its leases and moves the card to **Review**, where the refinery picks it up (see above). The session stays open (idle) for 15 minutes, so a message can wake it.
4. Failures, or a `report_blocked` call, move the card to **Blocked**.

## Safety

- **Worktree confinement.** Every tool call that names a path outside the card's worktree is refused. That includes paths inside shell commands (redirects, `../`, `~`, absolute paths), with an allowlist of system locations like `/usr` and `/dev/null`.
  - **Shared tool locations** are the exception (Settings → Guardrails → Agent tool access, on by default): `/tmp`, every directory on `PATH`, toolchain folders in your home (`~/.local`, `~/.cache`, `~/.cargo`, `~/.platformio`, `~/.nvm`, `~/.pyenv`, …) and extra **Tool paths**. The repo's git dir and each harness's own state are always allowed. Other projects, the main checkout and the rest of your home stay refused.
  - Every refusal is sent to you as a message ("Needs you" in VS Code), naming the path and where to allow it. Agents are told a refusal is the policy, not a human.
  - Claude is checked by a `PreToolUse` hook on every call.
  - OpenCode and agy are checked on their ACP permission requests.
  - Kimi asks for shell commands and outside writes. It edits inside its worktree without asking.
  - Codex runs in its own sandbox: writable are the worktree, `/tmp` and the shared tool locations. Its shell has no network (no package installs); its web search does work and is set to live results.
- **Leases.** Edits to files another card has reserved are refused (Claude, OpenCode and agy).
- **Keys.** API keys stay in the daemon's gateway. Agents get a local token, and their environment has provider keys and parent Claude Code session markers removed.
- **Asking, not taking.** Spawning agents, adding MCP servers or skills, and granting browsers or other tools are off for agents by default, wait for you when allowed, and are recorded in the approval queue. MCP servers and tool grants run on your machine with your permissions: read what an approval applies before you approve it.
- **The IDE bridge** answers agents only through your VS Code window, and only with what you choose: a quick pick you answer, problems the language server already has for files in the agent's own worktree, and a diff you may close. Turn it off with `infinityHarness.ideBridge`.
- **Not a sandbox.** Shell commands still run unsandboxed in the worktree. Container isolation is planned (master plan §5.9).

## Command line and other machines

`pnpm ih help` (or `node apps/cli/src/main.ts`, or link `apps/cli` to get `ih`). Output is JSON when piped (scripts, agents) and tables at a terminal; errors go to stderr (`{"error": "..."}` in JSON mode); exit 0 done, 1 the daemon refused or was unreachable, 2 wrong usage. `IH_URL` and `IH_TOKEN` point it at a daemon (default `http://127.0.0.1:7420`); the board is the only one, or the one holding the current folder, or `--board`.

```sh
ih status                      # daemon, boards, pools
ih plan "add dark mode"        # the orchestrator makes cards
ih needs                       # approvals, reviews, blocked cards, messages
ih approve ap_1f3 ; ih deny ap_9c2 --note "not now"
ih review c_ab12 changes --notes "handle the empty state"
ih watch                       # live events, one JSON line each
ih terminal c_ab12             # attach to a Claude session (Ctrl+] detaches)
```

**Restarts.** When the daemon stops or crashes, sessions that were mid-turn have no process, and a card left "in progress" would hold its board's worker slots forever. On start the daemon closes those sessions, puts interrupted workers back in **Ready** (their worktree, branch and commits are kept), blocks interrupted planners for you (planning again could duplicate cards) and posts one message saying which. A graceful stop (Ctrl+C, SIGTERM) records which sessions it cut off. When such a card runs again on the same pool, the agent's own conversation is picked up where the harness can (ACP agents that offer `loadSession`; Claude with `--resume`) and it is told the daemon restarted instead of being sent the task again; the replayed history is not written to the card's log a second time. Where it cannot (the harness has no resume, the old session is gone, the card was routed to another pool) it starts fresh with the usual "an earlier session stopped before finishing" note.

**The skill.** `skills/infinity-harness/SKILL.md` teaches an agent that is *outside* the board (your own Claude Code session, say) how to use `ih`: it is gated (use it only when you mention Infinity Harness; a card's own agent has the `board` MCP tools instead), points at `ih help` for syntax rather than copying flags, and states what an agent may never do for you (approve, deny, land, move, cancel, force-remove, add machines, answer an agent's question). Install it with `ih skill install` (Claude: `~/.claude/skills`; `--target agents` for `~/.agents/skills`; `--dir PARENT` for anything else); it refuses to overwrite a different file without `--force`. A test checks that every command and flag the skill names exists.

**The TUI** (`ih tui`, or `pnpm tui`) is a full-screen view for people who do not live in tmux: everything is clickable, the keys are printed on the buttons, and the mouse works over SSH and on a phone. Three screens: **Needs you** (approvals, finished cards waiting for your verdict, blocked cards, results to weigh, agents' messages: select one and its buttons appear), **Board** (cards grouped blocked → review → in progress → … → done, click a group to fold it, click a card to open it with Message, Move, Stop, Terminal, Approve, Request changes, Land), **Pools** (quota windows and budgets). The header's machine and board names open switchers; with a saved machine selected, a lost connection greys the screen out ("showing the last known state") and removes the buttons until it is back. Items you have not looked at carry a ● and count in the header; what counts as seen is remembered per device (`~/.config/infinity-harness/tui-seen.json`), so reading on your phone does not clear your desk. Approving something that runs code on this machine (an install) asks once more. **Terminal** hands your terminal to a Claude session (Ctrl+] comes back). `IH_TUI_MOUSE=0` or `--no-mouse` leaves mouse capture off so your terminal's own text selection works; mouse reporting is always switched off again on exit, on Ctrl+C and when the process is killed. `IH_TUI_BELL=0` silences the bell for new items. It adapts down to about 50 columns.

**Other machines** are reached over SSH, never by opening the daemon to the network. `ih machine add user@host --label workbox [--root ~/infinity-harness]` saves a profile (id, label, SSH target, ports; no passwords, keys or tokens) in `~/.config/infinity-harness/machines.json` after checking it can connect. Then `ih --machine workbox cards`, or `ih card workbox:c_ab12`, runs against that machine's daemon through an `ssh -L` forward that `ih` makes, watches and re-makes with a growing delay (1 s to 2 min). Authentication is OpenSSH's: it never prompts (BatchMode), so load your key into `ssh-agent`; a refused login or unknown host key is reported as needing attention, not retried. If the other daemon requires its API token, `--root` lets `ih` read `.meta-harness/api-token` over SSH. `ih machine forward workbox --port 7430` holds the forward open so the web UI or VS Code (`infinityHarness.daemonUrl`) can use `http://127.0.0.1:7430`. The other machine's daemon must already be running; nothing is installed or started there. `IH_SSH_ARGS="-F /path"` adds ssh options for setups `~/.ssh/config` cannot express.

## Layout

| Path | What |
|---|---|
| `apps/daemon` | HTTP + WebSocket server, runner (sessions, reviews, messaging, leases), scheduler (classify, lint, route, narrate), refinery (review, operator verdicts, merge queue, landing, retries), council (multi-orchestrator planning), best-of-N (`bestof.ts`), budgets and pool history (`budgets.ts`, `history.ts`), OTLP receiver and metrics (`telemetry.ts`, `metrics.ts`), approval queue (`approvals.ts`), tool grants and approved MCP servers (`tools.ts`), IDE bridge (`ide.ts`), goal chat (`chat.ts`), context capture and handoffs, new-board setup (folder browser, repo init), GitHub via `gh`, board MCP server, Claude hook endpoint, terminal WebSocket |
| `apps/web` | React UI: file tree and viewer, tree (React Flow), board, agents, pools and metrics views, tabbed settings (incl. budgets and tools), approvals panel, review controls, themes (`themes.css`), xterm.js terminal |
| `apps/vscode` | VS Code extension: workspace ↔ board, Cards and Needs-you views, chat view, planning from the editor, native diffs with review comments, approvals, IDE bridge, agent terminals, the board in a tab |
| `apps/daemon/src/federation/` | Swarm federation: identity and signatures, the knock and peer states, project cards and their visibility, requests, the `/fed` listener and the operator routes |
| `apps/cli` | `ih`, the command line: boards, cards, planning, needs-you, approvals, review, landing, live events, terminal attach, saved machines, swarm federation (`swarm`, `peer`, `project`, `request`) |
| `apps/tui` | `ih tui`: the mouse-first terminal UI (own small renderer: canvas with click regions, SGR mouse parser, no dependencies) |
| `packages/client` | `@mh/client`: how anything talks to a daemon. REST client, the replaying event stream, "needs you" logic (browser and Node); in `@mh/client/node`: saved machines, SSH forwards, terminal attach. Used by the web UI, the VS Code extension and the CLI |
| `packages/core` | Shared types and the event schema |
| `packages/db` | SQLite store (`node:sqlite`), migrations, append-only event log |
| `packages/adapters` | ACP client and agent (OpenCode, Kimi, agy, Codex), Claude PTY adapter + hook script, permission policy, shared tool locations (`environment.ts`) |
| `packages/gateway` | OpenAI-compatible proxy and the unified rate limiter (warn 80%, halt 95%); budgets are scopes in the same limiter |
| `packages/router` | Kev client (classification, outcome scoring), per-model priors and the routing policy |
| `packages/fast-lane` | Groq → NIM → local utility jobs: narrator, spec lint, commit/PR text, test-failure triage, query rewrite, note tagging, quick answers, notification text |
| `packages/context` | Notes store: hybrid full-text + embeddings search, tagging, backfill |
| `skills/infinity-harness/` | The skill file for agents outside the board (`ih skill install`) |
| `docs/research-herdr.md` | What was learned from herdr and what was borrowed for Phase 6.6 |
| `docs/agents/` | The agents' own guide (board tools, conventions, tool access, asking for things), served by the `get_docs` tool |
| `scripts/` | `install-agy-acp.sh`, `agy-acp-login.mjs` |
| `.meta-harness/` | Runtime state: database, worktrees, generated OpenCode config, Claude session settings (gitignored) |

## Checks

```sh
pnpm test        # node:test — context (search, handoffs, ask_agent, outcomes changing routing), refinery (review, landing, conflicts, retries, PRs), agents/delegation, store, limiter/gateway, leases, shell policy and shared tool locations, ACP adapter, router, fast lane, runner, scheduler + board MCP end to end, telemetry, metrics, budgets and pool history, approvals and tool grants, operator review / land now / try locally / chat / IDE bridge, best-of-N, VS Code extension (client, and the bundled extension activated against a live daemon with a stand-in `vscode` API), swarm federation (signatures, quarantine, visibility, requests, two daemons driven with `ih`)
pnpm typecheck
```
