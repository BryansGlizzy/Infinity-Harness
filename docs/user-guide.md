# Infinity Harness user guide

_How to use Infinity Harness from start to finish: from an empty folder to merged work. As of Phase 6 (2026-11-06; all of it except 6.6). For the design and rationale, see [master-plan.md](master-plan.md)._

## 1. What it does, in one paragraph

You point a **board** at one git repository. You give it work: a **goal** that an orchestrator agent breaks into cards, or **cards** you write yourself. Each card is worked by one agent (Claude, Kimi, Antigravity, NIM or the local model) in its **own git worktree and branch**, so agents never edit the same checkout. When an agent finishes, the card goes to **Review**. The **refinery** then merges it into your default branch (or opens and merges a GitHub PR) once the board's tests pass. You watch, message agents, and step in when something is blocked.

## 2. One-time setup & updating

Run the 1-shot installer at the root of the repository (`https://github.com/BryansGlizzy/Infinity-Harness.git`):

```sh
./install.sh                # verifies Node 24+ & pnpm, installs workspace deps & agy ACP bridge,
                            # initializes .env, builds Web UI & VS Code extension, and links ~/.local/bin/ih
./install.sh --with-agents  # also installs missing agent CLIs (claude, codex, codex-acp, kimi, opencode)
./install.sh --update       # (or: ih update) pulls latest commits from GitHub and rebuilds everything
```

You can either sign in to your agents in the terminal before starting, **or** install and sign in to them directly from the Web UI under **Agents → System Harnesses & Agent Links** once the daemon is running (newly installed or signed-in pools link into the running daemon immediately without a restart).

## 3. Start the app

```sh
pnpm start            # (or: ih daemon) builds the UI, then serves everything on http://127.0.0.1:7420
```

The terminal prints which pools were found (`pools: claude (sonnet), kimi (…), …`), whether GitHub (`gh`) is available, and whether Kev, embeddings and the fast lane are configured. A pool whose CLI or key is missing simply doesn't appear.

> **A second, separate instance** (for demos or experiments) keeps its own database and worktrees while sharing your logins:
> `IH_STATE_DIR=/some/dir IH_PORT=7430 IH_GATEWAY_PORT=7431 IH_FED_PORT=7432 node apps/daemon/src/main.ts`

> **Access.** The daemon only answers this machine unless you give another machine its token (`.infinity-harness/api-token`, created on first start). Set `IH_REQUIRE_TOKEN=1` to require it from this machine's tools too; the web UI then asks for it once, and the VS Code extension reads `infinityHarness.apiToken`. Details in the README.

## 4. Create a board (the app sets up the repository if needed)

A board drives **one project folder**. Click **New board** in the top bar (it opens by itself when there are no boards). Under **How agents work** it offers two modes:
- **Worktrees** (the default for a git repository): each card runs on its own branch in its own worktree, is reviewed, and lands through the merge queue.
- **Directly in the folder** (the default for any other folder): agents edit the folder itself as they go, like an IDE assistant. There's no git setup, branches, reviews or landing; a finished card is **Done**. One worker runs at a time unless you raise Settings → Guardrails → Workers at once. The card's **Changes** tab lists the files its agent edited.

The rest of this section describes worktree boards.

1. **Pick the project folder.**
   - Type a path (`~` works) or use the browser below the field.
   - Click a folder to choose it; **Open ›** (or double-click) goes into it.
   - The breadcrumb jumps back up; **Home** returns to your home folder; **hidden** shows dot-folders.
   - Folders that are git repositories are marked **git**.
   - For a brand-new project, type a name next to **New folder here**. Nothing is created until you confirm.
2. **Read the line under the browser.** It says what the folder is and what will happen:

| The folder is… | What happens |
|---|---|
| A git repository with commits | Used as it is. The line names the branch, the number of commits, and whether cards will land as GitHub PRs or as local merge commits. |
| …with uncommitted changes | A warning. Commit or stash them, or landing waits until the checkout is clean. |
| A git repository with no commits | Its files are committed as the first commit, with a README and .gitignore added if missing. |
| A folder with files, not a repository | `git init`, then the existing files are committed as the first commit. Build output such as `node_modules` and `__pycache__` is left out. |
| Empty, or doesn't exist yet | Created as a new project: `git init`, a README, a .gitignore and a first commit. |
| A subfolder of a repository | Refused: choose the repository's top folder. |

3. **Options**, shown when the folder needs setting up:
   - **Branch:** the default branch of a new repository (`main`).
   - **.gitignore:** general, Python, Node or none. Only written when there isn't one.
4. **GitHub** (shown when `gh` is installed and the repository has no remote):
   - **Local only** (the default): cards land as local merge commits.
   - **Create a private** (or public) **GitHub repository and push:** runs `gh repo create … --source … --push` with your `gh` login. Cards then land as pull requests.
5. **Board name:** filled in from the folder name; change it if you like.
6. Press **Create board**, or **Set up repository & create board** when setup is needed.

Existing commits are never rewritten. The **default branch** is the one checked out when the board is created: cards branch from it and land on it.

**Put real requirements in the repo:** dependencies installed, and a test command that works from a fresh checkout. Agents and the refinery run it in the card's worktree. If you set up git yourself, the commands are `git init -b main`, a first commit, and optionally `gh repo create <name> --private --source . --push`.

## 5. Where things live

- Your repository: wherever you chose. `main` (or your default branch) receives landed work.
- Each card's worktree and branch: `.infinity-harness/worktrees/<board>/<card>` on `ih/<title>-<id>`.
- The database (boards, cards, notes, outcomes): `.infinity-harness/infinity-harness.db`. With `IH_STATE_DIR`, both live under that folder instead.

## 6. Configure the board. Do this before adding work

The top bar has seven views: **Tree**, **Board**, **Agents**, **Pools**, **Metrics**, **Swarms** and **MCP**. Agents, roles and permissions are set in the **Agents** view, the board's MCP servers in the **MCP** view (§6a); everything else is in **Settings** (top right), in tabs: Routing & pools · Refinery · Learning · Fast lane · Guardrails · Budgets · Tools · MCP. Each knob says what it does and its default, and each tab has **Reset to defaults**. A new board opens on the Agents view.

Check these at least:

| Setting | Why |
|---|---|
| **Refinery → Worktree setup command** | Runs once in each new card worktree before its agent starts, e.g. `pnpm install --frozen-lockfile --prefer-offline && cp "$IH_REPO_PATH/.env" .env`. A fresh worktree has no `node_modules` or `.env`; without this every agent spends its first turn on that, or skips the build. Two run at a time. It runs again if you change the text. If it fails, the agent is told (so it doesn't mistake missing dependencies for its own bug) and you get a message. Environment: `IH_REPO_PATH`, `IH_WORKTREE`, `IH_BRANCH`, `IH_BOARD`. |
| **Refinery → Test command** | e.g. `pnpm test`, `pytest -q`, `go test ./...`. It gates every landing. Empty means no tests: cards land as soon as they are reviewed. |
| **Refinery → Land as** | `auto` = GitHub PR when the repo has a GitHub remote and `gh` is installed, otherwise local. Force `local` for experiments. |
| **Refinery → Land automatically** | Off means cards stop in Review until you turn it back on. |
| **Agents view** | Who plans, who leads, who works, and on which model and **reasoning level**. The levels are the ones each harness publishes, e.g. Claude low…max, Kimi low/high/max, agy low/medium/high. By default the orchestrator is Claude/Opus and every pool has a worker on its default model. A harness's own default level applies when you leave the field empty, and it can be high: **Kimi's default is `max`**, and Agy's and Codex's are `high`, which makes every step slow. Set a lower level on agents you want fast, and compare step times in the card's Activity. Each agent also shows whether its model is answering (§9). Two or more enabled orchestrators make a **council** (§7). |
| **Agents → Notes** | Up to six short notes per worker or lead (`UI DEV`, `CODE REVIEW`, `SECURITY AUDITOR`…). The orchestrator sees them in its team list and can ask for one on a card (`prefers`); Kev also says how much each card needs each note. A card that fits a note is drawn to the agent carrying it: its score is multiplied by up to 2× (Settings → Routing & pools → *Pull of agent notes*, 0 ignores notes). It is a nudge: quota, routing rules and track record still count, and it never lets an agent take a card it is not allowed. The card's routing explanation names the note that moved a decision. |
| **Routing & pools → Slots** | How many cards may run on a pool at once. |
| **Routing & pools → Scarcity** | Lower means "use only when the others are busy". Claude is 0.15 to save Pro quota. |
| **Agents → Routing weight** (or `ih weight AGENT N`) | Your thumb on the scale for automatic routing, per agent (1 is neutral). Above 1 favours the agent, but only for cards it handles well, so favouring a cheap agent (NIM, local) sends it the easy cards and not the hard ones. Below 1 holds it back; 0 keeps automatic cards off it. If one agent wins nearly everything, raise the weight of the ones you would rather use (try 1.5 to 3), or lower the winner's. A card's routing explanation shows each agent's score and any weight applied. |
| **Refinery → Cross-provider review** | Cards Kev flags as risky are read by an agent on another provider before landing. |
| **Learning** | Use recorded outcomes in routing, Kev scoring, and the priors table (expected success per agent and work type; edit cells to steer routing). |
| **Budgets** | Optional caps in tokens or dollars per board and per agent (§9a). A board past its budget starts nothing new. |
| **Tools → Hold cards in Review for me** | Cards wait for your approval instead of going to an agent reviewer (§8). |
| **Tools → Final summary when a goal is done** | On by default. When the last card of a goal is done, the orchestrator that planned it writes a final report from what its cards reported (§8). It does not research again, so it costs one short turn. Turn it off to skip it. |
| **Tools → Best-of-N** | Off by default. When on, a big card is raced by 2–3 agents; Kev keeps the best change and discards the rest. Costs several times the tokens. |
| **Tools → Tool grants** | Which extra tools (a headless browser, the desktop) cards may be given, and whether each needs your approval. |
| **Guardrails → Agent tool access** | Agents may use `/tmp`, everything on `PATH` and the toolchain folders in your home (`~/.platformio`, `~/.cargo`, `~/.nvm`, …) besides their worktree. Add an SDK in an unusual place under **More tool paths**. Turn sharing off to confine agents to their worktree. |

### 6a. MCP servers (tools that act outside the repository)

An **MCP server** gives agents extra tools, for example an open Roblox Studio place. Install or link them **once for the machine** in **Settings → MCP** (add a command or an address, press **Install** if it has an install command, **Start**). Then, per board, open the **MCP** view:

- **Switch a server on** for this board. Presets (`Roblox dev`) switch a set on together; *Save what is on now as…* makes your own, for different scenarios.
- **Who may use it.** *Workers by default* and one line per agent: **Full**, **Read only** (only the tools the server marks as reading; you can overrule a tool's mark in Settings → MCP) or **Off**. Planners get nothing unless you give it.
- The server runs **once**, in the harness. Agents reach it through it, and it never gives an agent the server's own address or keys. Every call is checked against these settings, so lowering access works at the next tool call; switching a server on applies to sessions that start afterwards. A server that drives one shared real thing (a Studio place) serves changes one at a time.
- The orchestrator is told which servers are on and which agents may use them, and a card that needs one says so (`needs_mcp`): only agents allowed to use it take it, and a plan with nobody able to do the work is refused while it is being made.
- **Tools granted to a card** (a headless browser, the desktop) are listed on the same page: they are started per card, and their mode (given when asked / ask me first / off) is set there.

#### Add-ons (off by default)

At the top of the MCP view, an **add-on** switches on a whole set of servers and, where it needs one, a helper process that runs in the board's folder, in one go. The first is **Roblox Studio**, for a **direct board** (agents edit the project folder itself):

1. Switch it on. It sets the folder up for [RbxSync](https://docs.rbxsync.dev) if needed (`rbxsync init`: it creates `rbxsync.json`, `src/`, `assets/`, `terrain/`, `sourcemap.json` and appends to `.gitignore`; nothing already there is overwritten, and you are asked first), starts `rbxsync serve` **in that folder**, and switches on three servers for the board: Roblox Studio's MCP server, RbxSync's MCP server and the sync.
2. In Studio, press **MCP Server** in the plugin toolbar for the Studio server, and **Connect** in the RbxSync plugin. (On Vinegar, Studio reads plugins from the folder inside its Wine prefix, `prefixes/studio/drive_c/users/<you>/AppData/Local/Roblox/Plugins`, which is what Studio's *Plugins → Plugins Folder* opens; a plugin placed in Vinegar's `appdata/Roblox/Plugins` is never loaded unless linked from there, as RbxSync's is. The add-on installs into the prefix folder and says so when the file is missing.) Studio edits are written into the folder; agents' edits to `.luau` files are pushed to Studio. Agents use the servers for what files can't do: playtests, logs, running Luau, checking the result.
3. **Live link status.** While the add-on is on, a **Links** chip sits in the strip under the goal bar, next to the pools: a joined chain icon in green when everything is connected, a broken one in red when something is not, dashed while it is still being read. It has a dot for each part: the sync process, **Studio** (the Studio MCP plugin) and **RbxSync** (its plugin). It changes the moment something drops or comes back, without reloading the page; hover for what each part is doing and what to press, click to open the MCP tab. If the page loses its connection to the harness it dims, since it can no longer be trusted.
4. Switch it off and the sync process and RbxSync's server stop. Files it made stay.

Only **one folder can be served at a time** (RbxSync's plugin looks for one fixed port): a second board is offered *Move sync here*, which stops it for the first. A worktree board can't have it: a live sync serves one folder, while worktree cards each work on a separate copy. If port 44755 is already held (you started `rbxsync serve` yourself, from a terminal or VS Code), the add-on says so and does not start; stop that one first. `IH_RBXSYNC_PORT` moves the harness's sync to another port (for a second harness instance; Studio's plugin only looks on 44755). The folder having a Rojo project is a warning: use one sync tool per folder. `ih addon` does the same from a terminal.

#### Keeping agents from burning tokens

- **Fewer tools per server.** Every tool an agent is offered is listed on every step (the Roblox servers advertise 98 tools, about 22k tokens; the agents used 17). Roblox Studio ships offering 27 of its 50 tools and RbxSync only 2 (`sync_to_studio`, because the sync does not push by itself, and `extract_game`); the rest overlap the Studio server and are hidden. **Settings → MCP → a server → tools** lets you click any tool *shown* or *hidden*, or *Show all tools*. Agents are told to prefer the Studio server. To take RbxSync away from workers entirely, set its *Workers by default* to **Off** in the MCP tab (they can then not push files: you would push from the RbxSync plugin yourself).
- **Waiting instead of probing.** While Studio's plugins are not connected, cards that need the Roblox add-on wait in Ready, and you are told once (Settings → Tools → *Hold cards while an add-on's other half is down*). Agents are given `addon_status` and told not to investigate the machine; a server that fails twice in a row is answered at once for about 20 seconds.
- **Asking early.** A worker that is stuck calls `ask_parent`: the agent that planned its card answers, changes the card or tells you. Planners are told to expect it.
- **Stop means stop.** Stopping a card from the web, VS Code, the TUI or `ih cancel` now leaves it stopped (Blocked, with a message). It used to go straight back to Ready and start again. Press Run to continue: it picks its conversation up where it stopped, and is told that you stopped it.
- **Where it went.** *Metrics → Where the effort went*, or `ih report [card]`, shows per card the steps, how many times it started, who stopped it, failed MCP calls, calls that only probed, shell commands that look like diagnosing the machine, refused calls and tokens, with a flag when something looks wasteful.

**Roblox Studio** ships in the library. It runs the `@chrrxs/robloxstudio-mcp` server (pinned version): `mcp/_installed` holds it (press **Install** if it is missing; it is not part of the repository), and on start it copies its Studio plugin into your Vinegar plugins folder. Open Studio, make sure the **MCP Server** plugin shows *Connected* (restart Studio once after the first install), and switch the server on in the board's MCP view. `ih mcp` does the same from a terminal.

## 7. Give it work: two ways

### A. A goal (recommended for anything bigger than one change)

1. Type it in the bar at the top, e.g. "Add a CSV and a JSON export to inventory.py with tests and a README section", and press **Plan**.
2. An **orchestrator** card is created and its agent reads the repo **without editing**. It creates child cards with acceptance criteria, work types, dependencies ("tests wait for code") and, optionally, **lead** cards that a lead agent breaks down further.
3. Child cards start by themselves, as soon as an agent with free capacity and quota is available and their dependencies have finished.

**This is what the Tree view is for.** It draws the plan as it grows:
- the goal at the top, its cards underneath, and a lead's cards under the lead;
- **solid lines**: parent → child; a **dotted orange** line means the child is working now;
- **dashed grey arrows**: "waits for" dependencies;
- **blue lines with a count**: agents messaging each other; dots flow along them while the talk is recent (2 minutes), ⇅ means both ways;
- **each node**: its role (Orchestrator, Lead, Worker), status, the agent with its pool, **model and reasoning level**, work type, complexity and the narrator's one-line "what it's doing now".

You can **drag cards** to untangle the tree; the layout is remembered per board, and **Tidy layout** resets it. The toolbar also has **Fit**, **Follow running** (keeps running cards in view), **Fold finished** (collapses subtrees that are all done; click "+N done" to open one) and **By status / By agent** colouring. The legend explains every line and badge.

If you only add cards by hand, each card is its own root and the tree is just a row of boxes. Use the Board view then.

### A2. A goal planned by a council (two or more orchestrators)

When two or more orchestrator agents are enabled (Agents view) and their pools are open, the goal bar says "a council of N orchestrators plans it together". Pressing Plan then works like this:

1. **Proposals.** The goal card gets one planning card per orchestrator underneath it. Each orchestrator reads the repo and proposes how to split the goal into one share per member.
2. **Kev picks a split.** Kev scores the proposals and the best one wins. The goal card shows each member's score and the chosen split; the split is saved as a note.
3. **Shares.** Each orchestrator creates the cards for its share under its own planning card. The tree shows goal → members → their cards.
4. **Cross-check.** When everything has landed, each orchestrator checks another member's share on the latest code and adds fix-up cards if something is missing. Fix-ups land, then there is another round, up to the limit in Settings → Guardrails → Council verification rounds.
5. **Done.** The goal and member cards close when a round needs no fix-ups.

The goal card's activity log shows each council step.

### B. Cards by hand

1. **Board** view → **+ Add card** (in Backlog). Write a title and a description with acceptance criteria.
2. Cards in **Backlog** do nothing. Move a card to **Ready** (status menu in its panel) and the scheduler routes it to the best agent automatically.
3. To pick the agent yourself, open the card and use **Run** with an agent and model.

## 8. What happens to a card

```
Backlog → Ready → In progress → Review → (cross-provider review) → Merging → Done
                        ↘ Blocked (failed, or the agent said it can't continue)
```

1. **Ready → In progress.**
   - **Kev classifies** the card: work type, complexity 0–4, needs-review, front-end. **Routing ranks every agent**: free slots, quota state, routing rules, and expected success (prior blended with past outcomes).
   - The daemon creates a worktree at `.infinity-harness/worktrees/<board>/<card>` on branch `ih/<title>-<id>`, merges in the branches of cards it waited for, and starts the agent there.
   - Agents reserve files before editing (**leases**), so two agents don't edit the same file. They can message each other and you.
2. **In progress → Review.** When the agent ends its turn, the daemon commits everything in the worktree (build output excluded) and saves the agent's summary as a note.
3. **Review → Merging → Done.** This is the refinery.
   - Optional cross-provider review comes first.
   - Then, one card at a time per board: merge the default branch into the card, run the test command, then land it.
     - **Local:** a merge commit on your default branch.
     - **PR:** push, open, merge on GitHub; your local branch follows.
   - Commit and PR text are written by the fast lane.
   - **You can be the reviewer** (card panel → **Your review**, or VS Code): **Approve** sends the card to the queue without an agent review; **Request changes** sends your notes (and line comments from VS Code) back to the author; **Land now** skips the review and goes first (tests still run); **Check out here** / **Apply diff** put its work in your own checkout so you can try it (your checkout must have no uncommitted changes). With **Hold cards in Review for me** on, a card waits for your verdict.
4. **Failures.**
   - A conflict or failing tests go back to the same agent first, then to a different agent with a **handoff note**, then to you (Blocked, plus a message).
   - A run that fails is reassigned the same way.
   - An agent that calls `report_blocked` is reassigned too, and its block waits for you to weigh it (§10).
   - A run that fails because the model's endpoint **could not be reached** (a local server that is down, a provider outage) is not counted against the model. The daemon checks the endpoint, takes it **out of rotation** if it really is down, and hands the card to another agent (§9, Agents view).
5. **A goal finishes → final summary.** When the last card under a goal is done, the orchestrator that planned it gets **one more turn on the goal card, in its own conversation** (it already holds the reports its cards sent it). It writes the report **only from what the cards reported**; it is told not to read the project, run anything, search or check things again, and to write "not reported" where a card did not say. The report has **Outcome**, **What was done**, **How to run and verify it** (what the cards said they ran), **Decisions and interfaces**, **Open issues and follow-ups**, and **Reference documentation** (the files and references the cards reported, as reported, not checked, or "None"). It is the last message on the goal card (shown as "Being written…" under *Final summary* in the card's details meanwhile), is saved on the goal (card panel → **Context**, titled "Final summary: …") and posted to **Messages for you**, where a click opens the goal card. No extra card appears. If the orchestrator's session has closed (after 15 idle minutes, or a restart), the same goal card runs again with its cards' reports in the prompt. It runs once per goal, and again only if more cards finished since. If it cannot be written, you are told to message the goal card asking for the report (do not press Run on a goal card: that plans it again).

## 9. Watching and steering

**Card panel** (click a card):
- **Facts:** status (you can move it), branch, worktree path, PR link, landed commit, attempts, and outcomes.
- **Routing:**
  - Kev's classification and dependencies;
  - **routing rules**: require or avoid agents and pools, inherited by child cards;
  - "How would it route now?", with each agent's score and why.
- **Run / Cancel:** run by hand on any agent and model, or stop a running card.
- **Activity tab:** the agent's messages, thinking, tool calls, permission refusals, refinery steps, saved notes and outcomes.
  - Each tool call shows what it **printed** under it (an expandable "output · N lines" block, with the exit code), for Kimi, Agy, Codex and OpenCode. Kimi and Agy deliver a command's output when it finishes, Codex streams the tail of it, and Claude's live session is in the Terminal tab.
  - A harness that retries a dead provider by itself says so here ("Provider problem, retrying…") instead of looking stuck.
  - It follows new output only while you are at the bottom; scroll up to read and a **↓ New activity** button appears.
  - The facts, routing and rules above it are folded under **Details, routing and rules** (the choice is remembered), so the Activity list always has room.
- **Changes tab:** the files the card changed, with added/removed line counts.
  - Click a file for its diff, or **File** for the whole file at that version.
  - For a landed card it shows what its merge brought into the default branch; otherwise its branch against where it started.
  - Edits from a turn still in progress appear when the turn ends and is committed.
- **Context tab:** the card's notes (spec, decisions, contracts, findings, handoffs, summaries), board-wide search, and **Add a note** to tell agents something.
- **Terminal tab** (Claude cards): the live Claude session. Typing goes straight to the agent.
- **Message box:** send the agent a note. It's delivered at the next turn boundary. Start with `!urgent`, or tick Urgent, to interrupt the turn.

**Tree view: the live box.** Every card in the tree has a small **▾** in its header. It opens a box under the card with the same live activity (messages, tool calls and their output), so you can watch several agents at once without opening each. Drag the box's corner to resize it (the size is remembered); it follows the latest output until you scroll up, and **Open card** opens the full panel. Which boxes are open is remembered per board.

**Status strip** (under the top bar):
- Pool gauges: rate limits, Claude's and Codex's 5-hour and weekly usage, sessions working.
- Active file leases.
- **Approvals** waiting for you (§10).
- **Blocks to weigh** (§10).
- **Messages for you:** agents asking for help, escalations, refinery notices and final summaries. **Click a message** to go to what it is about (its card, or Approvals, Swarms, the Agents view or the settings tab that fixes it). **✕** clears one and **Clear all** clears the list; a cleared message stays in the card's own log. The TUI (`x` and `X` on a message), VS Code (the ✕ on the message and the title-bar button) and `ih messages clear` do the same.

**Agents view: is the model answering?** Each agent shows its pool's health: **online** with the answer time, **no response**, or **not checked**. API and local endpoints (NIM, the local model) are checked every minute; **Test** checks any pool now (for a subscription harness it starts it and asks what it offers, which shows it is installed and signed in). When a card's run fails because the endpoint could not be reached, the daemon checks it and, if it is really down, takes the pool **out of rotation**: no cards are routed to it, cards already running on it move to another agent, one message tells you, and **none of it is held against the model**. It stays out, even if it comes back up, until you press **Put back in rotation** (it survives restarts). The same is in the TUI Pools screen (`t` test, `b` put back), VS Code (*Infinity Harness: Pools…*) and `ih pool test|restore <pool>`; `ih pools` has a MODEL column.

**Pools view:** every pool grouped by harness, with each usage window and when it resets, slots in use, the agents on it and what they're working on across all boards. Each pool also charts its last 24 hours: its fullest window over time (with the 80% and 95% lines), the stretches it was halted or locked, and requests and tokens per hour. **Force 95%** halts a pool so new work flows elsewhere, e.g. to save quota.

**Metrics view:** what the board's agents used, for the last hour, day, week or month. Total tokens and cost, tokens over time, your budgets with their gauges, and tables by agent, model, pool and card. A goal or lead shows what its whole sub-agent tree used. Claude Code reports tokens and cost through its telemetry (set up by the daemon, nothing to do); API pools are counted at the gateway; other agents appear when they report a turn's usage. Cost is shown only where an agent reports it.

**From VS Code:** install the extension once (`pnpm --filter infinity-harness install-local` in the Infinity Harness checkout) and open your repository in VS Code.
- The **Infinity Harness** view in the activity bar finds the board for the folder, or offers **Create board** (or **Start Daemon** if the daemon isn't running).
- **Cards** shows the tree. Click a card to open it on the board, or use its buttons: **Show Changes** opens every changed file in VS Code's diff editor, **Attach Terminal** joins a Claude session, **Message Agent** sends a note.
- **Needs you** collects messages for you, blocks to weigh and blocked cards. The status bar shows the count. Each message has a ✕ to clear it (and a button in the view's title bar clears them all); a message that names a card, such as a final summary, opens it. **Pools…** (the pulse button, or the command palette) tests a pool's model or puts a pool back in rotation.
- **Chat** (top of the view) is one conversation per goal: what the agents say, status changes, and your messages. A card's question to you appears inline with a reply box. Pick the goal with the list button, and the card a message goes to with the menu under the box.
- **Review in the diff editor:** **Show Changes**, then comment on lines of the "after" side. While the card is still being worked a comment goes to its agent at once; once it is in Review, comments are collected. **Approve** and **Request Changes…** (inline and in the card's menu) send your verdict; **Land Now** and **Try Locally** (check out the branch, or apply its diff) are in the same menu.
- **Approvals** show in **Needs you** with Approve and Deny buttons, and as a pop-up when one arrives.
- **The IDE bridge:** while this window is attached to the board, agents can ask you a quick question (a pick list that appears in the window), read the editor's errors and warnings for their files, and show you a proposed change in the diff editor. `infinityHarness.ideBridge` turns it off. The status bar tooltip lists the pools and the last day's usage.
- Plan from the editor: the ✨ button, or right-click a selection → **Plan a Goal About the Selection…**. **Plan a Fix for This File's Problems** turns the file's errors and warnings into a goal.
- **Open Board** shows this whole web UI in an editor tab.

**Themes:** the picker in the top bar switches between Clean (default), Frutiger Aero, Metro, Metalheart and Glassmorphism. Light and dark follow your system (Metalheart is always dark). The choice is remembered in your browser.

### 9a. Budgets

Settings → Budgets caps a board, or an agent, in tokens or US dollars per day, per week or in total (day and week are rolling). A budget works like a pool's rate limit: at **80%** you get a message and the agent ranks lower; at **95%** the agent gets no new cards (the card's Routing section says "budget used up"), or, for the board's budget, no new card starts and no new goal is planned. Turns already running finish; nothing is killed. Raise the limit, or wait for the window to roll over, and work resumes. Tokens are input plus output; cache tokens aren't counted. Dollars count only for agents that report a cost (Claude).

## 10. Your decisions

- **Blocked cards.**
  - Read the card's Activity and the message in "Messages for you".
  - Fix the cause: add a note, message the agent, change the repo or settings.
  - Then move the card back to **Ready**. Moving it out of Blocked by hand resets its retry counters.
- **Blocks to weigh.** When an agent reports itself blocked, routing doesn't hold that against the model until you decide:
  - **Pass**: the block was justified; counts as a success.
  - **Fail**: it should have done the work; counts as a failure.
  - **Ignore**: leave it out.
- **Approvals** (status strip, or **Needs you** in VS Code). Agents may not do these on their own, so they ask and wait for you:
  - **Needs an answer**: an agent or the refinery escalated a card. Type your answer and **Answer and resume**: the card runs again with your note.
  - **New agent**: an agent asked for another agent on the board (a pool and model). Needs the role's *Spawn agents* permission (Agents view); off by default.
  - **MCP server** / **Skill**: an agent proposed one for the board (needs *Propose MCP / skills*). Approved MCP servers are given to every new session; skills are added to worker prompts. They are listed, and removable, under Settings → Tools. An MCP server runs on your machine with your permissions: read the command before you approve.
  - **Tool grant**: a card wants an extra tool, such as the headless browser, for UI checks. A card whose grant is waiting doesn't start until you decide.
  - **Install a tool**: a card holds a grant whose tool isn't installed on this machine. The approval shows the exact install command; approving runs it (it can take a few minutes: the browser downloads Chrome), and the card starts afterwards. Deny to let it run without the tool. Settings → Tools shows what is installed and has an Install button too.
- **Priors** (Settings → Learning): if you know a model is better or worse at some kind of work than the table says, edit the cell. Observed results build up under each value.

### 10a. Other swarms (federation)

A **swarm** is one daemon with its boards and agents. Two swarms (yours on two machines, or yours and a colleague's) can cooperate: each publishes the projects it is willing to share, and one can send the other a **request**, a bug report or a piece of work, that the other's operator decides on. Only structured data crosses: project cards and requests. Never chat and never code; a fix reaches you the way any change does (a commit, a PR, a new package version), and the request tells you which.

Open the **Swarms** view (or `ih swarm`, `ih peer`, `ih project`, `ih request`).

1. **Compare fingerprints.** *This swarm* shows your name, id and **fingerprint**. Read yours to the other operator and have them read theirs; this is the check that you are talking to who you think.
2. **Connect.** *Connect to another swarm*: a label, and either an SSH target (`user@host`, their federation port is 7422) or a local URL of your own tunnel (`http://127.0.0.1:PORT`). Your daemon calls out; nothing needs to listen for you. Typing the fingerprint you expect makes a different key refused. The federation port serves only signed `/fed` routes, so an SSH account for a peer can be limited to it with `PermitOpen 127.0.0.1:7422`.
3. **They accept you.** The other swarm says nothing until its operator accepts: they see "Swarm X wants to connect" under *Waiting for you* (web), *Needs you* (VS Code, TUI, `ih needs`) with your fingerprint to compare. Until they accept, what you sent is shown to them as plain text and reaches none of their agents. **Accept swarm** pins your key; **Deny** lets you knock again; **Block** ignores you.
4. **Share projects.** *Projects you share* → **Draft a card**: a card (what it is, what it **provides**: package names, repository URLs, commands; what it uses) is written from the repository's README and manifests by the fast lane, or by the orchestrator if you switch *Project cards are drafted by*. Edit it, choose whether the project **takes requests** (never on by default), then **Publish** at *basic* (name, one line, what it provides) or *full*. A peer gets at most basic until you mark it **Trusted**; **Preview what it gets** shows the exact text. What you publish ends up in your peers' agents' prompts and so with their model vendors.
5. **Use what peers share.** Their cards are searchable (`ih peer projects <words>`), appear in orchestrators' prompts ("swarms you know and what they maintain") and agents can look them up with `find_peer_projects`. Agents cannot contact a peer.
6. **Send a request.** *Send a request…* (or `ih peer request <peer> "<title>" --description …`): a title, the details (repro and logs, or a spec), optional acceptance criteria. It is delivered on the next round and shows as *waiting for approval* over there. **Nothing runs on their side before their operator approves it, whoever the sender is.**
7. **Deciding a request** (the receiving side). *Approve* turns it into a goal for that board's orchestrator, marked "EXTERNAL REQUEST … untrusted text" so agents treat it as a description of work and nothing more; *Ask a question* parks it as *needs information* until the sender answers; *Decline* needs a reason the sender reads. When every card of the goal is done the request is marked **landed** with the PR or commit; you can also mark it landed, "cannot reproduce" or declined by hand. The sender sees each step, and **confirms** a landed request is what they needed (done) or comments.

**Letting your agents ask peers (F3).** An agent that is blocked by a dependency another swarm maintains can use the `request_peer` tool. It is sent at once; *Settings → Tools → Agents' requests to other swarms wait for me* makes each one wait for your approval first (*Request to another swarm*, with the full text the agent wrote), and the *Ask other swarms* column in the Agents view says which roles may ask. If the agent said the request is blocking, its card is parked in Ready (work so far committed on its branch) and does not start until the peer answers. When the peer lands it, the card runs again with their answer and **your acceptance criteria** in its prompt; when the card is done, the request is confirmed for you. If the card finds the result wanting it says so, and you can **Send back…** (`ih request reopen <id> <what is still wrong>`): the request returns to the peer's operator. If you declined to send, or the peer declines, the card is told and carries on or reports itself blocked. A request that came to you from swarm X cannot be sent back to X (loops), and a card may have three open.

**Orchestrators talking to each other.** The receiving swarm's orchestrator gets the request as its goal and answers it: a simple question it answers itself (it can read its project) with the `reply_to_requester` tool; real work it plans into cards and replies with the result. That reply reaches the asking card word for word, and the card carries on with it. If the goal finishes without an explicit reply, what its cards said when they finished is sent. A peer that connected to you has no address on your side yet: the peer card has a **Connect back** box (or `ih peer address <peer> --ssh user@host | --peer-url URL`).

**Trusted peers and auto-accept (F3).** Mark a peer **Trusted** (full visibility) and tick *Start its requests without asking me* (`ih peer auto-accept <peer> on`). Limits come with it so a peer cannot spend your quota without bound: 300k tokens a request and 2M a day unless you say otherwise (`--per-request-tokens N --per-day-tokens N`; dollars count only for agents that report a cost). A request that names more than the per-request limit still waits for you, as does one arriving after most of the day's limit is used; a request without a budget is given the per-request limit as its budget. You are told of every auto-accepted request (a message on the board, which VS Code shows as a pop-up) and can **Decline** it afterwards, which stops its work and tells the sender. An untrusted peer can never be auto-accepted, and taking trust away turns it off.

**Budgets, milestones and what you are asked (F4).** The goal an approved request became is held to its budget the way a board budget works: at **80%** you get a message; from **95%** its cards that have not started stay held (turns already running finish) until you raise it (**Change budget…**, `ih request budget <id> --max-tokens N`) or decline. A trusted peer's *per day* limit holds all of its requests at once. The request shows what it has used. If the sender listed **milestones**, tick them as they are reached (`ih request milestone <id> <n>`, or the goal's orchestrator reports them with `report_milestone`); the sender sees them on its next round. For the swarm that sent a request, *Waiting for you* lists questions from the peer (answer them there) and landed results nobody is confirming (**It works** or **Send back…**). The hop list, the per-peer limits and the loop refusal are in place from F2.

Limits that protect you: text from a peer is size-capped and stripped of control characters; a request cannot ask for tool grants or touch other boards; each peer may file 20 requests an hour and 10 may wait at once; a request that already passed through your swarm is refused (loops); a peer you block is silent from then on. Everything is an event in your own log.

## 11. See the result

- **In the app:** the card's **Changes** tab.
- **In git:** your repo's default branch holds everything that has landed, one merge commit per card:
  ```sh
  cd /path/to/repo
  git log --first-parent --oneline main      # one line per card; the body names the card id and agent
  git show --stat <sha>                      # files a card changed (drop --stat for the full diff)
  ```
- **Work not landed yet** lives in the card's worktree (path in the card panel) and branch `ih/…`:
  `git log -p main..ih/<branch>`. Ignore the `_refinery` worktree; the merge queue uses it.
- **PR mode:** each card's PR is linked in its panel.

## 12. Stopping and starting again

- **Ctrl-C** stops the daemon. Running agent turns are cancelled. Their committed work stays on their branches.
- On the next start, cards in Ready route again and cards in Review continue to land. **This includes old boards:** if you don't want an old board's Review cards to land, turn off **Land automatically** on that board first, or use a separate instance (`IH_STATE_DIR`).
- Worktrees and branches stay until you delete them. To clean up a finished board's leftovers: `git worktree prune` and delete the `ih/*` branches you no longer need.

### The file tree and `@` mentions

**Files.** The left side of the web UI is the project folder of the current board. Click a folder to open it in place (subfolders load as you open them), click a file to read it on the right; arrow keys move, → opens a folder, ← closes it or goes up, Enter opens. Changes git knows about are marked: `M` modified, `A` added, `U` new and not tracked yet, `D` deleted, and a dot on a folder with changes inside. It refreshes while you look and whenever a card finishes. Select a card and the tree offers **This card's worktree**, to read what an agent has done before it lands. The TUI's **Files** tab (`4`) does the same: Enter or → opens a folder, ← closes it, Enter on a file opens a reader (↑ ↓ PgUp PgDn scroll, Esc closes). It is read-only, shows `.git` never, and cannot reach outside the project (`..` and links that leave it are refused).

**`@swarm/project`.** In the goal bar, and in the message box of a card, typing `@` offers the projects your accepted peers share (`@beta/beta-lib` for the swarm labelled *beta*); arrow keys and Enter or Tab pick one, Esc dismisses. When you send a prompt that names one, the daemon adds what that project is (their one-line description and what it provides, as data) to what the planner is given, and reminds it that it cannot read their code: to get something from that swarm (say, which versions it needs) it has to file a request, which you approve first. A name that matches nothing stays plain text, and this works from any client that sends the text (`ih plan "check @beta/beta-lib for the newest dependencies"`).

### Removing a board

Web: **Remove board…** in the top bar. VS Code: *Infinity Harness: Remove This Board…*. TUI: the board menu (click the board name), last item. Command line: `ih board remove`. It first shows what the board holds (cards, agents working, card worktrees, uncommitted changes, branches that have not landed), then asks which you mean:

- **Remove from Infinity Harness.** The board, its cards, notes, messages, settings and usage are forgotten, running agents are stopped, and the card worktrees it made are deleted (one with uncommitted changes is kept on disk, and you are told). **Your project folder, its branches and its history stay exactly as they are.** Open requests from other swarms about it are declined and its project card is withdrawn from your peers.
- **Delete on system…** Also deletes the project folder from the disk, with everything in it. This is irreversible, so it asks a second time: you type the board's name back (`ih board remove --delete-files --confirm "<name>"`). The daemon refuses to delete a folder that is your home folder or holds it, is too near the top of the disk, holds Infinity Harness or its data, is a symbolic link, or overlaps another board's folder; for those only the first option is offered.

A board whose card is in the merge queue right now cannot be removed until the merge finishes.

## 13. Troubleshooting

| Symptom | Likely cause |
|---|---|
| The New board form refuses a folder | It's a file, or a subfolder of a repository (choose the repository's top folder). |
| A pool is missing from the strip | Its CLI isn't found or isn't signed in, or its key isn't in `.env`. Check the startup lines. |
| A card stays in **Ready** | No eligible agent: all slots busy, pool halted or locked, routing rules exclude everyone, or its dependencies haven't finished. "How would it route now?" says which. |
| A card stays in **Merging** with "waiting" | It waits for a card it depends on to land, a file another card has leased, or your default branch's checkout to be clean. |
| Every card lands with no tests | The test command is empty (Settings → Refinery). |
| Research cards never go to NIM or local | By design: those models have no web access. |
| Search finds nothing by meaning | The embeddings endpoint is down; search falls back to keywords and fills in vectors later. |
| An agent says it couldn't build, test or run a tool | Look in "Messages for you" (or **Needs you** in VS Code) for a "refused … outside its worktree" notice. If the path is a toolchain or SDK, add its folder under Settings → Guardrails → More tool paths, then message the card to retry. Check that **Share toolchains** is on. |
| A Codex card can't install packages | Codex's shell has no network inside its sandbox (its web search still works, so research is fine). Pre-install what the project needs, or route such cards to another agent with the card's routing rules. |
| An MCP server shows **error** or **not installed** | Settings → MCP shows its last log lines. *Not installed*: press Install (or run its install command yourself). Roblox Studio: the plugin must say *Connected* in Studio's toolbar; `get_connected_instances` returns nothing until it does. Restart the server after changing its settings. |
| A pool is **out of rotation** | Its endpoint stopped answering while a card ran on it (a message said so). Fix the endpoint (for the local model, start its server), press **Test** in the Agents view, then **Put back in rotation**. It is never put back by itself. |
| Kimi (or another agent) is slow | Look at its reasoning level in the Agents view: Kimi defaults to `max`. In the card's Activity, compare the time between steps (model thinking) with the time tools run. |
| A direct board runs up to three cards at once | Its agents share your folder. Kimi and Codex edit without asking, so the planner is told to give each card its own files. Lower Settings → Guardrails → Workers at once to 1 if cards keep touching the same files. |
| A card stays in **Ready** and its panel mentions a grant | A tool grant it asked for is waiting in Approvals. Decide it, or remove the grant from the card. |
| Nothing starts on a board | Its budget may be used up (Metrics view, Settings → Budgets), or all its agents' budgets are. |
| After a restart a card went back to Ready | The daemon was stopped or crashed while it was being worked. Its worktree and commits are kept; it runs again and, where the agent's tool allows, continues the same conversation. A planning card is Blocked instead: answer in the goal chat or plan again if you want to. |
| Metrics shows no Claude usage | Usage is reported by Claude sessions the daemon starts, to the daemon's address. A daemon restarted on another port only affects new sessions. |
| Agents don't get `ide_*` tools | No VS Code window is attached to this board (open the repository in VS Code with the extension), or `infinityHarness.ideBridge` is off. |
| Check out here / Apply diff refuses | Your checkout has uncommitted changes to tracked files. Commit or stash them first. |
| VS Code says the daemon isn't reachable | Start it (`pnpm start`, or **Start Daemon**), or set `infinityHarness.daemonUrl` if it runs on another port. |
