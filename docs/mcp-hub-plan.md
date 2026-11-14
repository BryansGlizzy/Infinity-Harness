# MCP Hub and agent notes: plan (Phase 9)

_Written 2026-11-13. Plan of record for letting Infinity Harness host MCP servers and share them with every agent, plus the "notes on agents" idea. Pointer from [master-plan.md](master-plan.md) §12. Background: the Roblox Studio server cloned in `mcp/robloxstudio-mcp` is the first real server to go through it._

## 0. Status (built 2026-11-13)

**Built and tested** (302 automated tests pass; the hub, levels, write lock, routing and notes run through the real daemon layers with a fake stdio MCP server): the library and supervisor (`apps/daemon/src/mcp-hub.ts`, migration 16), the `/hub/<id>` endpoint on session tokens, per-board switches and presets, access levels with annotation-based read, refusals, call log, the one-at-a-time lock, planner and worker prompts, `needs_mcp`, the router filter, agent notes (field, chips, planner display, `prefers`, Kev questions, bounded router weight), the web **MCP** tab and **Settings → MCP**, `ih mcp`, agent and user docs, the skill file.

**Add-ons (added later on 2026-11-13).** The MCP tab has an **Add-ons** section. The Roblox add-on (off by default, direct boards only) switches on the Studio MCP server and RbxSync's MCP server and runs `rbxsync serve` in the board's folder (`rbxsync init` first, only when `rbxsync.json` is missing). One board holds the sync (RbxSync's plugin has no documented port setting, so one fixed port, 44755); *Move sync here* takes it over; a port already held is reported. Checked with the real `rbxsync` 1.4.0 and `rbxsync-mcp` on a scratch daemon at port 44791 (so Studio's plugin could not connect): the real `init` kept an existing script and `.gitignore`, `serve` ran with the board's folder as its working directory, RbxSync's server listed 48 tools through the hub, and switching off stopped everything and kept the files. **Not checked: the RbxSync plugin connecting to a live Studio, a sync actually moving a file into or out of a place, and whether the RbxSync and MCP Server plugins coexist in Studio.** RbxSync marks none of its tools read-only, so the plainly reading ones are listed by name for Read only access. Worktree boards are not supported (a live sync serves one folder); the worktree variant (push-only sync into the main checkout, an explicit pull from Studio) is not designed in detail or built.

**Token-burn work (added 2026-11-13, after reading the first real Roblox run).** The first run (3 workers, a block and a colour button, 27 minutes) cost 475 tool calls: the two Roblox servers' 98 tools (about 21.8k tokens) were listed on every step and 17 were used; agents probed whether Studio was connected 39 times, ran 60 diagnostic shell commands (one ran `strings` on the rbxsync binary to learn its file layout) and had 8 calls refused; Studio's crash caused Kimi's card to be reassigned to an agent in the same broken world; and a person's Cancel restarted the card at once, three times, because a cancelled run was put back to Ready. Built in response: **per-server tool allowlists** (Studio 27 of 50, RbxSync 2 of 48; measured 21.8k to 6.5k tokens, about 15k saved per step, all allowlisted names checked against the real servers); **a guide for the add-on's agents** (file layout, which server for what, the stuck rule) and an **`addon_status`** tool (Studio's plugin connection from the bridge's health, RbxSync's from `connection_status`, including which folder it syncs); a **health gate** (cards needing the add-on wait while its outside half is known to be down, told once; Settings → Tools); a **circuit breaker in the hub** (two failures that say the server cannot reach what it drives open it for 20 s; calls are answered at once with the server's hint); **`ask_parent`** (a stuck worker asks the agent that planned its card; the human is told if it cannot answer) with a stuck rule in every worker prompt; **cancel fixed** (a person's stop leaves the card Blocked, resumes its conversation on Run, and the cancel is recorded with who and why); and **`/api/boards/:id/efficiency`, `ih report` and a Metrics table**. Checked on the real run's data: the report reproduces the hand analysis (Agy's card: started over 3 times, 10 MCP failures, 16 probes, 20 diagnosing, 5 refused, 154 steps). **Not checked on a live Studio:** whether agents actually follow the guide and use the Studio server more than RbxSync, whether `ask_parent` gets a useful answer from a real orchestrator, and the gate against a real Studio disconnect. RbxSync's `autoSync` is off in its own config, so `sync_to_studio` stays; making the harness push after each worker turn is an option that was not built. Not built: attributing every kind of cancel (stall, pool eviction) with a reason, and resuming rather than restarting after those.

**Live link status (added 2026-11-13).** The daemon pushes an `addon.status` message (the add-on's view) over the existing socket whenever it really changes: a plugin connecting or dropping (read every 3 s from the Studio bridge's health and RbxSync's `connection_status`), the sync process dying, restarting or stopping, and switching on or off. The web strip shows it as a **Links** chip (`addonLink.ts`, tested without a browser); the page rereads after its socket reconnects, and dims while it is down. Checked in a real browser on a scratch daemon fed by your real Studio bridge and RbxSync: the chip showed the true state (Studio MCP plugin not connected, RbxSync connected), and killing the scratch sync process flipped its dot to red within 0.3 s with no reload and back to green after the supervisor restarted it. **Not done:** the VS Code status bar and the TUI do not show it yet (`ih addon` shows the same parts as text); and the check is every 3 seconds, so a plugin that drops and returns between two reads is not seen.

**Correction, found when the link chip showed Studio as not connected (2026-11-13).** The Studio MCP plugin had never loaded: Studio on Vinegar scans the Wine prefix's `…/users/<user>/AppData/Local/Roblox/Plugins`, and the plugin had been installed into Vinegar's `appdata/Roblox/Plugins`, which Studio does not scan (RbxSync works only because a symlink in the prefix folder points at its file there). Six Studio logs never mention the plugin. So in the first real Roblox run the Studio server was unreachable and agents used RbxSync's tools because only those worked: my earlier reading ("agents were not told which server to prefer") was incomplete. Fixed: the plugin is linked into the prefix folder, `vinegarPluginsDir()` prefers it, and the add-on's status names the missing file and folder. **Not yet verified: that the plugin connects after a Studio restart.**

**Checked on real things:** the real `@chrrxs/robloxstudio-mcp` 3.4.3 runs under the hub (50 tools, 21 marked read-only); a real Kimi card on a scratch board found its tools through the hub and called `get_connected_instances` (the hub logged it); the MCP tab was driven in headless Chrome (switch on, access matrix, presets).

**Not done, or not checked:**
- **The Roblox plugin has not connected to a live Studio.** Studio was already open and must be restarted once to load the plugin; until then `get_connected_instances` returns no places. No edit has been made to a real place.
- **Only Kimi was tried through the hub on a real harness.** Claude, Codex, Agy and OpenCode get the same HTTP entry the board server already uses, but none was run against the hub.
- **Grants are unified in the API and the UI, not in storage.** The MCP tab lists the tool grants (browser, desktop) beside the servers and edits their mode, but they are still stored as `settings.grants`, and servers an agent proposed with `propose_mcp` still live in `settings.mcpServers`, separate from the library. Moving both into the library table is a follow-up.
- **Per-card servers are on or off only.** A server each session starts itself cannot be limited to reads, so Read only means not given.
- **Reviewers get no MCP servers.** (A read-only reviewer on a hub server is not built.)
- **No card-level hold on exclusive servers, no spend metering in the Metrics view** (calls are in the card's event log as `mcp.call`: server, tool, time, size; never the arguments).
- **VS Code and the TUI have no MCP view.** `ih mcp` and the web UI do.
- **`tools/list_changed` is not forwarded:** an agent sees a server's new tools the next time it lists them.
- Studio's own `StudioMCP.exe` is not in the library.

## 1. Goal

A person installs or links MCP servers **once per machine** (Settings → MCP). On each board they open an **MCP** view and switch on the servers that board needs, and say **which agents may use each one, and how far**. The orchestrator is told what exists, so it never plans a card nobody can do. Separately, each agent can carry a few short **notes** (`UI DEV`, `CODE REVIEW`, `SECURITY AUDITOR`) that the orchestrator and Kev weigh when work is assigned.

## 2. Hosting versus connecting (the answer to "is #2 really hosting?")

| | Level 1: connect | Level 2: host | Level 3: hub (the target) |
|---|---|---|---|
| Who runs the server | Every agent session starts its own copy (stdio) | IH starts **one** copy and keeps it running | Same as 2 |
| What the agent talks to | Its own copy | The one server, over HTTP | **IH**, which forwards to the one server |
| Who holds the server's secrets | Each copy | The agent gets the server's token | **Only the daemon** |
| Per-agent limits | None | None | Yes: tools filtered and calls checked per agent |
| Toggle mid-session | Needs a new session | Needs a new session | Next `tools/list` |
| Works for any server | Only if copies tolerate each other | Only servers that speak HTTP | Any (stdio servers are wrapped) |

Yes: level 2 is the one that hosts. Level 1 only works for Roblox because that server has its own **primary/proxy mode** (the first copy binds port 58741, later copies forward to it); most servers have nothing like it. Level 2 on its own would hand the agents the server's auth token, which breaks "keys stay in the daemon", so we skip it as a product and build level 2 and 3 together: the daemon hosts, and agents only ever see the hub.

**Checked on 2026-11-13** (pinned `@chrrxs/robloxstudio-mcp@3.4.3`): the server runs headless under a supervisor with stdin held open, serves Streamable HTTP at `http://127.0.0.1:58741/mcp`, answers 401 without the token and a normal `initialize` with it, and its tools carry `readOnlyHint`/`destructiveHint`. So both hosting and hub-style forwarding are possible; the hub has not been written.

## 3. Design

### 3.1 The MCP library (per machine)
One entry per server: `id`, label, description (what an orchestrator should know), transport (`stdio` with command, args, env | `http` with url and header template), pinned version, `install` text (operator-set, runs only on approval, same rule as tool grants), `hosting` (`shared`: IH runs one copy | `per-session`: one copy per session, for servers that are stateless or per-card like the browser), `exclusive` (does it drive one shared real-world thing, like Studio), health, and the **tool catalog** discovered with `tools/list` (name, description, annotations). Stored in a new table (migration 16); settings keep only per-board choices.

The existing **tool grants** (`browser`, `computer`) become library entries with `hosting: per-session`, so there is one system, not two. Cards keep `grants`; the old setting is migrated on first start. Board `mcpServers` (approved via `propose_mcp`) migrate the same way.

### 3.2 Board MCP view (new tab beside Swarms)
Per board: a card for each library server with an **on/off switch**, status, tool count, and a matrix **agent × server** with `off | read | full | custom` (custom lists tools). Also **presets**: named sets of servers (`Roblox dev`, `Web QA`) switched on together, the "different MCP set per scenario" case. The Agents view shows the same permission as a column so either place edits it. Also in VS Code, TUI and `ih mcp` (parity rule from §5.10 of the master plan), the matrix at least.

### 3.3 The hub (daemon)
- Endpoint per upstream: `/hub/<server>` on the daemon, authenticated with the **session token** agents already get for `/mcp`. The session maps to an agent and a card, so the daemon knows who is calling.
- `tools/list` returns only the tools that agent may use; `tools/call` is checked again (an unlisted tool is refused with a reason that names the setting). `read` means tools annotated `readOnlyHint: true`; a server without annotations needs the operator to mark tools once in the catalog (default for unmarked tools: write).
- The upstream client uses the MCP SDK (`@modelcontextprotocol/sdk` is already a dependency). Supervisor: start on first use or on board enable, restart with backoff, health to the Agents-style pool status, logs kept, stdin held open for stdio servers. The server's own token never leaves the daemon.
- Metering: calls per server, agent and card go to `usage_events`-style records (Metrics), so you see who is using Studio.
- **Exclusive servers** (Studio): writes are serialized by a per-server mutex with a queue, reads run freely. The mutex is per call first; a card-level hold (like `reserve_paths`) comes later if interleaved edits from two cards prove a problem. The planner is told Studio cards should be chained or kept small.
- Passes through only tools at first; resources and prompts are off until needed.

### 3.4 The orchestrator and the router know about it
- The planning prompt gets a block per enabled server: label, what it is for, which agents can use it and at what level, and the tool names (clipped). Same place the team list is built in `apps/daemon/src/runner.ts`.
- `create_subtask` gets `needs_mcp: ['roblox']` (like `needs_network`). The router drops agents without permission; `create_subtask` refuses a card no enabled agent can take, and says why, so the plan is fixed while it is being built (the way `plan-shape.ts` already pushes back).
- Granting stays "ask, don't take": a server that is not yet enabled on the board is a request to a person, as `request_grant` is now.

### 3.5 Agent notes (your second idea)
- `AgentProfile.notes: string[]` (short, ~40 characters each, at most 6), edited in the Agents view as chips with suggestions (UI DEV, CODE REVIEW, SECURITY AUDITOR, ROBLOX, DOCS).
- **Planner:** the team list in the prompt shows each agent's notes, and `create_subtask` takes an optional `prefers` (a note) so the orchestrator can steer a card.
- **Kev:** one extra question per distinct note on the board, in the same classify call ("Does this card need *UI DEV*?"; Kev's API returns a probability per question). Cap of 6 notes per call.
- **Router (still code):** an agent's score is multiplied by `1 + w·p` for each of its notes with probability `p` (weight `w` a setting, default 0.5, bound ×1.5), so a note nudges rather than overrides; capability filters, quota and learned success still apply first. A card the orchestrator marked `prefers` uses p = 1. The Details panel shows which note moved a decision.
- Notes also gate nothing by themselves; MCP permission is the hard limit, notes are the soft preference.

## 4. Phases

| # | What | Exit test |
|---|---|---|
| **9.0** | **Done 2026-11-13; the Studio restart and the first real edit are still open:** `mcp/` ignored by git; server pinned in `mcp/_installed` (3.4.3); the plugin `MCPPlugin.rbxmx` installed into the Vinegar Plugins folder; headless hosting and the HTTP endpoint checked. **Still open here:** restart Studio so it loads the plugin, and a settings form to add a board MCP server by hand (the UI can only list and remove today). | Studio shows the plugin **Connected**; one Claude card changes something in the open place through the server |
| 9.1 (built) | Library table and supervisor; Settings → MCP (add, install on approval, link, health, catalog); `ih mcp` | A server added in Settings shows its tools without any agent running; a crash restarts it |
| 9.2 (built) | Hub endpoint and per-session auth; per-board enable; the **MCP view** with on/off and presets; migrate grants and `propose_mcp` entries | Two agents on different harnesses (Claude, Kimi) call Studio through the hub; turning it off removes it on the next list |
| 9.3 (built) | Permissions matrix (`off/read/full/custom`), annotation-based read level, refusals with reasons, metering, the exclusive mutex | A read-only reviewer can read the place and is refused a write; two writers queue instead of interleave |
| 9.4 (built) | Orchestrator awareness: planning prompt block, `needs_mcp`, router filter, refusal of unassignable cards | A goal that needs Studio is planned only onto agents allowed to use it, and a plan with no such agent is told so |
| 9.5 (built) | Agent notes: field, chips, planner display, `prefers`, Kev questions, bounded router weight, Details line | With notes `UI DEV` and `CODE REVIEW` on two workers, a UI card and a review card land on the expected agent in a real run, and the reason is visible |
| 9.6 (partly) | Docs (user guide, agent docs `docs/agents/`, master plan), skill file entry (enabling a server is a person's decision), tests through the real layers, a live run on all five harnesses and a real browser pass | Per the master plan's risk table: exercised through the same layers a running daemon has |

## 5. Risks and open questions

- **Harness differences:** each ACP harness handles HTTP MCP and notifications in its own way (Kimi accepts it; Codex, Agy, OpenCode via the board server already do). The hub must be tried on all five; Claude's strict MCP config needs the hub entry in its generated `mcp.json`.
- **Studio is a singleton.** Worktrees do not isolate it; two cards editing one place can collide. The mutex helps per call, the planner guidance per card; true isolation (one place per card) is not available.
- **Tool lists change at runtime** (`listChanged`); the hub must forward that or sessions keep stale lists.
- **Version coupling:** the Roblox plugin and server must match exactly. The library pins versions and shows the plugin's version beside the server's; updating is an explicit action.
- **Launching/closing Studio from the server** is not expected to work under Flatpak Vinegar (its Wine launcher needs Studio's own PID). Everything that goes through the plugin does.
- **Studio's built-in MCP** (`StudioMCP.exe` in the Vinegar version folder, run through Wine) could be a second library entry. Not tried; do after 9.2.
- **Open Cloud key:** an agent can use every permission it grants. The library stores it as a secret held by the daemon, and the catalog marks the tools that use it.
- **Kev cost:** one question per note per card. Bounded at 6; if Kev is down, notes simply do nothing.

## 6. Your Linux setup (what was done, what is left)

- Plugin installed: `~/.var/app/org.vinegarhq.Vinegar/data/vinegar/appdata/Roblox/Plugins/MCPPlugin.rbxmx` (the server's default target on Linux is `~/Documents/Roblox/Plugins`, which Vinegar does not read, hence `MCP_PLUGINS_DIR`). `RbxSync.rbxm` is the only other plugin there.
- Server: `node mcp/_installed/node_modules/@chrrxs/robloxstudio-mcp/dist/index.js` (3.4.3, pinned; `mcp/robloxstudio-mcp` is the source checkout for reading).
- Studio was already running, so **close and reopen it** to load the plugin (Studio needs a full restart). The plugin then connects to `http://localhost:58741` once the server is up (Flatpak Vinegar shares the host network).
- Until 9.2 exists, the interim way for an agent to use it is the board MCP entry `{ name: "robloxstudio", command: "node", args: ["<repo>/mcp/_installed/node_modules/@chrrxs/robloxstudio-mcp/dist/index.js"] }`. Several sessions will start several copies, which this server supports (first is primary, the rest forward).
