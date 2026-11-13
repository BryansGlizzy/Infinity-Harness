# Infinity Harness: Master Plan

_2026-10-31, last revised 2026-11-05 (Phases 5–5.5 built, 5.6 in progress, Phase 6 planned; 6.1 first slice and 6.2 built). Built on [research-landscape.md](research-landscape.md), [questions.md](questions.md) and [clarifications.md](clarifications.md). This is the plan of record; when a decision changes, update it here._

## 1. What we're building

A local-first **daemon + web UI** that runs the vendor coding harnesses already installed on the machine (Claude Code, Antigravity `agy`, Kimi Code, OpenCode) as workers on a **live, growing kanban tree**.

- **Opus plans:** it decomposes work into cards.
- **Kev classifies:** it scores each card's work type and complexity.
- **Deterministic code assigns:** it combines availability, quota and learned success.

Agents share one board MCP server. Through it they claim work, message each other, lease files, and read and write shared context. Each card runs in its own git worktree and lands through a self-resolving merge queue as a GitHub PR. The UI shows, live, who is working on what, how agents talk, sub-agent trees, tokens and quota.

## 2. Principles

1. **Drive the real CLIs; never reimplement them or touch their credentials.** Each harness runs as itself, logged in by its owner. This keeps native features and subscription billing, and stays inside vendor terms.
2. **The model classifies, code routes.** No LLM in the scheduling loop. Opus proposes structure, Kev scores it, and policy code decides.
3. **Pull, don't dump.** Agents get a small starting prompt and query the board for context.
4. **Everything is an event.** An append-only event log drives the UI, replay, audit and metrics.
5. **Transport-agnostic executors.** `local` now; `ssh` and `docker` later behind the same interface.
6. **Configurable by default.** Retries, budgets, thresholds, permissions, depth limits and reserves are all UI settings.

## 3. Locked decisions

| Area | Decision |
|---|---|
| Scope | Local team tool; open-source once it works. One repo per board. Multi-board "swarm" later. |
| Users | v1: a single local owner, no login. Data model carries `user_id` everywhere. Later: accounts placed in a hierarchy that can act on **their subtree and nothing above it**. |
| Pools | Subscriptions: Claude **Pro**, Kimi **Plus**, Google AI **Pro** (Antigravity). **Codex** (ChatGPT plan; added in Phase 5). API pools: **NVIDIA NIM** (40 RPM; coding worker via OpenCode), **local Qwen 3.8 Flash** (slow, unlimited; coding worker via OpenCode), **Groq free** (~8k TPM / 1k RPD; **fast-lane utility jobs only**, §5.11). |
| Rate limits | One limiter for every pool (§5.10). Each limit window (RPM, TPM, RPD, 5-hour, weekly) **warns at 80% and halts new work at 95%**. Work then load-balances to other pools. API traffic goes through the daemon's LLM gateway so every request is counted. |
| Judge | Self-hosted **Kev** (`kev-9b`, Unsloth Decision API) at `$KEV_URL` |
| Embeddings | `$EMBEDDINGS_BASE_URL` (`:8889`), model `unsloth/embeddinggemma-2-GGUF` (BF16, **768-dim**, 8k context). Tested: 4/4 correct top-1 on a decision/handoff/contract/finding retrieval check, ~0.2 s per 4-text batch, ~4 s for a 20k-char input. Use the EmbeddingGemma prefixes: queries `task: search result \| query: `, documents `title: none \| text: `. |
| Inference host | `intelarc` (LAN host; Ubuntu 26.04 VM, Intel Arc Pro B50, Vulkan llama.cpp). Two `systemd --user` services with linger, so they start at boot: **`unsloth-kev`** on `:8888` (home `~/.unsloth/studio`) and **`unsloth-embed`** on `:8889` (home `~/.unsloth/studio-embed`; code, venv and model cache are symlinked; `ExecStartPost` loads EmbeddingGemma BF16). Two processes are needed because one Studio instance refuses to serve a decision model on the GPU while another model is resident (`gpu_busy`). Same API key on both. fail2ban is active on SSH, so automation should use one multiplexed connection. |
| Orchestrator | Opus, in an interactive Claude Code session. Plans and writes specs only, because Pro is the scarcest pool. |
| Claude integration | **Interactive PTY + Channels** for input, **hooks + transcript + status line** for output. ACP or `-p` only as a fallback. |
| Availability | Idle + remaining quota |
| Autonomy | Fully automatic: auto-start unless blocked, auto-approve. Retry and escalation counts set in the UI. Done criteria are delegated to the parent agent. |
| Spawning | Per-agent toggles (Paperclip-style). Budgets warn at 80% and pause at 95%. |
| Messaging | Queued to the next turn boundary. `!urgent` interrupts. Live comms view in the UI; no group chat. |
| Git | Worktree per card, automatic PRs, **enforced** leases, self-resolving merge queue |
| Context | Board MCP memory blended with Memorix-style cross-agent memory and handoff-mcp-style handoff notes |
| Storage | SQLite (later Postgres for multi-user) |
| Stack | Fresh TypeScript core; Vibe Kanban used as reference only |
| Notifications | UI only for v1 |
| Integrations | GitHub (PRs, then issues). No Linear. JSONL board export, Beads-style. |

## 4. Installed harnesses (verified 2026-10-31)

| Harness | Version | Interactive | Headless / structured | ACP | Notable flags |
|---|---|---|---|---|---|
| **Claude Code** (`~/.local/bin/claude`) | 2.1.316 | yes (PTY) | `-p --output-format stream-json --input-format stream-json` | `npx @agentclientprotocol/claude-agent-acp@0.99.1` | hooks, `--mcp-config`, `--resume`, `--remote-control`; Channels via `--dangerously-load-development-channels` (hidden flag) |
| **Antigravity** (`~/.local/bin/agy`) | 1.4.12 | yes | `-p --output-format stream-json --input-format stream-json` (**multi-turn over stdin**) | separate `agy-acp-server` 1.4.5 binary (ACP registry) | `--dangerously-skip-permissions`, `--mode auto\|accept-edits\|plan`, `--sandbox`, `--settings <json>`, `--conversation <id>`, `agy mcp`, `agy plugin` |
| **Kimi Code** (`kimi`, npm `@moonshot-ai/kimi-code`) | 2.4.1 | yes | `-p --output-format stream-json` | `kimi acp` | `--auto` (never ask), `--yolo`, `--skills-dir`, `--agent-file`, `session`/`fork`/`export`, `import-sessions` (pulls Claude/Codex sessions), `kimi web` |
| **OpenCode** (`~/.opencode/bin/opencode`) | 2.2.5 | yes | `run`, `serve` (v2 API + web server) | `opencode acp` | `auth`, `mcp`. The lane for NIM, Qwen and OpenAI-compatible endpoints. |
| Support | gh 2.103.3 · tmux 3.8 · pnpm 12.16.1 · Node 26.5 · git 2.50 | | | | |

**Linux (CachyOS x86-64), reinstalled 2026-11-02.** The project moved from the Mac to this machine. Everything installs into the home directory, no sudo:
- `claude` 2.1.317 (`claude.ai/install.sh` → `~/.local/bin`)
- `agy` 1.4.12 (`antigravity.google/cli/install.sh` → `~/.local/bin`)
- `kimi` 2.4.1 (`npm i -g @moonshot-ai/kimi-code`)
- OpenCode 2.2.5 (`opencode.ai/v2/install` → `~/.opencode/bin`; the unversioned `opencode.ai/install` installs OpenCode 1)
- `gh` 2.103.3 (release tarball, checksum verified, → `~/.local/bin`)
- `tmux` is not installed (needs sudo; nothing uses it yet).
- The agy ACP server (`scripts/install-agy-acp.sh`, which now records the platform so a Mac build is replaced) **does not reuse the agy CLI login on Linux**: it runs its own Google OAuth flow. Run `node scripts/agy-acp-login.mjs` once and open the printed link; the server caches the login afterwards.

**Sign-ins needed** (the daemon checks these at startup and shows any that are missing):
- `claude` → `/login` (Pro)
- `agy` → first run (Google AI Pro)
- `kimi login` (Kimi Plus)
- `gh auth login`
- Not needed for OpenCode: NIM, Groq and local keys come from `.env` through the gateway.
- Status 2026-11-02 (Linux): `claude`, `agy` (CLI and ACP server), `kimi` and `gh` are signed in.

## 5. Architecture

```
 Web UI (React) ─ board · tree (React Flow) · live sessions · xterm terminals · diffs · comms graph · lease map · metrics · settings
   │ WebSocket (event stream) + REST
 ┌─┴───────────────────────────────────────────────────────────────────────────────────────┐
 │ Daemon (Node/TS)                                                                         │
 │  Event log ─► projections (board, sessions, usage)          Settings/permissions engine  │
 │  Scheduler (policy) ◄─ Router (Kev client) ◄─ Limiter/quota service (all pools, §5.10)    │
 │  LLM gateway (OpenAI-compatible proxy: NIM, Groq, local) · Fast lane (Groq jobs, §5.11)   │
 │  Session manager ─► Executors [local | ssh* | docker*] ─► Adapters [claude|agy|kimi|opencode]│
 │  Worktree manager · Lease manager · Message bus (queue + urgent) · Refinery (merge queue) │
 │  Context store (artifacts, FTS5, vectors*, handoffs) · Telemetry (OTel receiver, parsers)  │
 │  Board MCP server (HTTP) · Claude channel server (stdio, per session) · Hook receiver      │
 └──────────────────────────────────────────────────────────────────────────────────────────┘
          * later
 Every worker: own worktree + branch · board MCP injected · shared skills dir · AGENTS.md
```

### 5.1 Adapters

Every adapter implements one interface; the daemon never special-cases a vendor outside its adapter.

```ts
// As built (packages/adapters/src/types.ts).
interface HarnessAdapter {
  readonly id: string;
  readonly strayPaths?: string[];          // files the harness drops into every workspace; removed before commit
  startSession(opts: {
    cwd: string; model?: string; reasoning?: string;   // reasoning: one of the levels probe() reports
    mcpServers?: McpServerConfig[]; onEvent: (e: HarnessEvent) => void;
    policy?: (paths: string[], toolCall: unknown) => PermissionDecision | null;   // leases, read-only reviews
  }): Promise<AgentSession>;
  listModels?(cwd: string): Promise<ModelOption[]>;
  probe?(cwd: string): Promise<{ models: ModelOption[]; reasoning: ReasoningOptions | null }>;
  shutdown(): void;
}
interface AgentSession {
  readonly vendorSessionId: string;
  readonly pty?: Pty;                      // Claude: the live TUI, attachable from the UI
  prompt(text: string): Promise<string>;   // one turn → stop reason
  cancel(): Promise<void>;                 // urgent messages interrupt with this
  close(): void;
}
// HarnessEvent: message | thought | tool_call | tool_update | plan | permission | turn_end | error
```

| Adapter | Default mode (confirmed by Spike 0) | Input path | Output path | Auto-approve | Lease enforcement |
|---|---|---|---|---|---|
| claude | **pty** (built) | Typed prompt (bracketed paste) at turn boundaries; Esc for urgent | hooks → daemon `/hooks/claude` (`Stop.last_assistant_message`), status line → 5h/7d windows | `PreToolUse` hook allow/deny, worktree + leases + shell paths | `PreToolUse` deny |
| agy | **ACP** (built): Google's `agy_acp_server`, `authenticate(oauth-personal)` | `session/prompt` | ACP updates incl. usage | ACP permission requests (default mode asks for every edit and command) | ACP permission step |
| kimi | **ACP** (built) | `session/prompt`; urgent = `session/cancel` + prompt | ACP updates | asks for outside writes + all shell; inside-cwd edits auto-approved by Kimi | `reserve_paths` + merge-time (inside edits don't ask) |
| opencode | **ACP** (built) | same as kimi | ACP updates | `ask` rules → ACP permission requests | ACP permission step |

Every adapter also keeps a **PTY fallback**, so the UI can always attach a real terminal.

#### OpenCode as the multi-endpoint lane (verified 2026-10-31)

- **One `opencode acp` process can host many concurrent sessions, each on a different model.**
  - `session/new` returns a `model` config option.
  - `session/set_config_option {configId:"model", value:"<provider>/<model>"}` switches a session's model.
  - Tested: two sessions on different models prompted at the same time and answered in parallel (1.5 s and 4.0 s).
- **Each endpoint is one pool** for the scheduler (limits are per API key): `nim` and `local-qwen` are OpenCode coding pools. Groq is not an OpenCode pool (§5.11). Each pool gets its own concurrency cap and rate-limit tracking.
- **Built-in providers** (from the models.dev catalog):
  - `groq`: env `GROQ_API_KEY`, 7 tool-capable models.
  - `nvidia` (NIM, `integrate.api.nvidia.com/v1`): env `NVIDIA_API_KEY`, 25 tool-capable models.
- **Local and other OpenAI-compatible endpoints** are added as a custom provider in `opencode.json`. The daemon generates it from `.env` (`opencodeConfig()` in [`apps/daemon/src/config.ts`](../apps/daemon/src/config.ts)) into `.meta-harness/opencode/opencode.json`.
- **Routing:** use only models flagged tool-capable as coding workers; the rest can do summaries.
- **Configured models** (`.env` `*_MODEL`). Tested 2026-11-01: both made correct tool calls over the raw API in under 1 s.
  - **NIM:** `nvidia/nemotron-3.5-super-vl-120b-a12b`. Ran a full OpenCode ACP turn. ✅ Coding worker.
  - **Groq:** `qwen/qwen3.8-27b`. On the current (free/on-demand) tier the org limit is **~7–8k tokens/min and 1,000 requests/day**. OpenCode's first turn alone is ~8.2k input tokens, so Groq **rejects OpenCode agent sessions** (`ITPM: Limit 7000, Requested 8172`).
    - Groq is **not an OpenCode pool**. It powers the daemon's fast lane (§5.11) through direct API calls.
    - A paid Groq tier would make it a fast coding worker.
  - **Local:** `local/qwen3.8-flash-next-iq3_s`, 262k context. Tested 2026-11-01:
    - correct tool call over the raw API in 2.6 s;
    - a full OpenCode ACP turn in **~18 s**, versus 3.5 s for NIM in the same concurrent run. Slow but free and unlimited.
    - Route it background and low-priority work: summaries, docs, tests, low-complexity cards.
  - The generated config holds no secrets: values come from `.env` via `{env:…}`. It reaches OpenCode through **`OPENCODE_CONFIG`**, so nothing is written into the target repo or the user's global config. From Phase 2 on, every `baseURL` will point at the gateway.
- **Permissions (verified 2026-11-02):** OpenCode v2's base policy allows everything, so tool calls never reach the client.
  - The generated config adds `permissions` rules with `effect: "ask"` for `edit`, `shell`, `webfetch`, `websearch` and `external_directory`. Each such call then arrives as ACP `session/request_permission` and goes through the worktree policy.
  - OpenCode **ends the turn as `cancelled` when a permission is rejected**. The runner detects that (a cancelled turn with policy rejections and no user cancel). It resumes with a follow-up prompt listing the refused calls, up to 3 times.
  - Verified live: a NIM agent's write outside the worktree was refused, the agent was resumed, and it finished the in-worktree work.
- **Groq's Cloudflare** rejects requests without a normal User-Agent (`403 / error 1010`). Our HTTP clients must set one.
- **Keys:** `opencode auth login <provider> --method key`, or `opencode service set env NAME VALUE` for the shared background server. The daemon can also start `opencode --standalone` with its own env.
- **All OpenCode providers route through the LLM gateway** (§5.10): the generated `opencode.json` sets each provider's `baseURL` to `http://127.0.0.1:<gw>/p/<pool>/v1`. That lets the daemon count and pace every request OpenCode makes. The keys stay on the gateway side, so OpenCode only gets a local token.
- **Open question for Phase 0:** whether several `opencode acp` processes share one background server, or whether we use one process with many sessions. The daemon should default to one process per board.

### 5.2 Data model (SQLite, Drizzle)

```
users(id, name, role, scope_node_id)                     -- scope = subtree they may act on
boards(id, repo_path, default_branch, settings_json)
nodes(id, board_id, parent_id, title, spec_artifact_id, status, column, work_type, complexity,
      kev_json, routing_rules_json, depth, created_by, assigned_agent_id, attempt, created_at)
edges(from_node, to_node, kind='blocked_by')             -- DAG, cycle-checked
agents(id, harness, pool_id, display_name, parent_agent_id, permissions_json, budget_json, caps_json)
pools(id, vendor, plan, kind, limits_json, warn_pct=80, halt_pct=95)   -- kind: subscription|api|local; claude-pro, kimi-plus, google-ai-pro, nim, groq, local-qwen
rate_windows(pool_id, window, limit, used, resets_at, locked_until, source, updated_at) -- current state; window: rpm|tpm|rpd|5h|7d; source: counted|header|status_line|observed_429; history lives in events
sessions(id, agent_id, node_id, mode, worktree, branch, parent_session_id, vendor_session_id, state, started_at)
leases(id, session_id, glob, expires_at, released_at)
threads(id, node_id, kind)   messages(id, thread_id, from_actor, to_actor, body, priority, delivered_at)
artifacts(id, node_id, kind, title, body, author, commit_sha, superseded_by, version)
artifacts_fts (FTS5)   artifact_vectors (sqlite-vec, later)
outcomes(node_id, agent_id, work_type, complexity_bucket, kev_score, kev_in_scope, tests_passed, attempts)
usage_events(ts, session_id, pool_id, input_tokens, output_tokens, cost_est, source)
approvals(id, kind, requested_by, payload_json, status, decided_by)
events(seq, ts, actor, type, subject, payload_json)      -- append-only; everything above is a projection or side table
```

### 5.3 Board MCP tools (one server; tools filtered per agent permissions)

_Built (as of 2026-11-06): `whoami`, `list_cards`, `create_subtask` (also `needs_network` and `grants`), `update_subtask`, `add_dependency`, `post_message`, `read_inbox`, `ask_agent`, `reserve_paths`, `release_paths`, `who_holds`, `report_blocked`, `escalate_to_human` (also an approval), `search_context`, `get_artifact`, `put_artifact`, `write_handoff`, `get_docs`, plus `propose_split` for council members; from Phase 6: `spawn_agent`, `propose_mcp`, `propose_skill`, `request_grant` (each waits for a human, see 6.4) and, while a VS Code window is attached, `ide_ask`, `ide_diagnostics`, `ide_show_diff` (6.1). The table is the original plan. Not built: `list_ready`/`claim_task` (the scheduler assigns cards), `assign`, `request_review` (the refinery reviews)._

| Group | Tools |
|---|---|
| Work | `list_ready`, `claim_task` (atomic, `expected_status` → 409), `update_task`, `complete_task(summary)`, `report_blocked(reason, needs)` |
| Tree | `create_subtask` (needs `can_create_cards`, depth/fan-out caps), `add_dependency`, `assign` (needs `can_assign`, scoped), `spawn_agent` (needs `can_spawn_agents`, maybe approval) |
| Messaging | `post_message(to, body, urgent?)`, `read_inbox`, `ask_agent(to, question, timeout)` (blocking) |
| Files | `reserve_paths(globs, ttl)`, `release_paths`, `who_holds(path)` |
| Context | `search_context(query, scope)`, `get_artifact`, `put_artifact`, `write_handoff` (the daemon also writes one on every reassignment) |
| Council | `propose_split(shares, rationale)` (council member cards only, while the council is proposing) |
| Quality | `request_review(node, by?)`, `escalate_to_human(reason)` |
| Self-extension | `propose_mcp(config)`, `propose_skill(body)`, `spawn_agent`, `request_grant` (gated by permissions and the approval queue; built in 6.4) |

### 5.4 Routing and scheduling

1. **Decompose:** the Opus orchestrator creates child cards, each with a spec artifact, a proposed `work_type`, and acceptance criteria.
2. **Classify:** one Kev call per card (`choice` work_type with ≤4 options or Opus's tag + `noul` confirm, `score` complexity, `noul` needs_review). Store the full probability vectors.
3. **Eligible:** routing rules (inherited down the tree, overridable) → capability filter → `idle_slots > 0` → pool state is `open` or `warn` (§5.10; never `halted`) → `quota_headroom > reserve` → not blocked by dependencies.
4. **Score:**
   ```
   score = success(agent, work_type, complexity)     # Kev-weighted outcome history, prior when no data
         × headroom(pool)                            # more remaining / sooner reset ⇒ higher; observed lockouts override advertised resets
         × scarcity(pool)                            # Claude Pro heavily penalised; local Qwen cheap but slow
   ```
   A Claude Pro **reserve** is kept for the orchestrator.
5. **Start immediately** when assigned and unblocked.
6. **Verify:** done criteria are up to the parent agent. When `needs_review` is high, the parent may `request_review` from a different provider (Kimi ↔ Antigravity).
7. **Learn:** on completion, Kev `score`s the result against the acceptance criteria and gives `noul` for "in scope". Both are written to `outcomes`.
8. **Fail:** retry on another agent with a handoff artifact, up to N attempts (UI setting). Then `escalate`.
9. **Best-of-N mode** (toggle, off by default): run one card on 2–3 agents and have Kev pick the winner. _Built in Phase 6.5._

### 5.5 Messaging

- **Normal:** messages queue and are delivered at the target's turn boundary (Claude via channel; ACP/stream-json as the next prompt).
- **`!urgent` / UI "push now":** `interrupt()` then deliver. Rate-limited per sender.
- **`ask_agent`:**
  - if the target is idle, it's prompted directly;
  - if busy, the reply comes from its latest artifacts, or a short-lived fork (`kimi fork`, `claude --resume` fork, or `agy --conversation`) answers.
- **Humans** use the same bus from the UI.

### 5.6 Git, leases, refinery

- **Worktrees:** `.meta-harness/worktrees/<card>`, branch `mh/<card-slug>`. The daemon allocates ports and env, and runs a per-board setup script.
- **Leases:**
  - agents call `reserve_paths` before editing;
  - Claude is hard-blocked by its hook;
  - other harnesses are checked at the ACP permission step where possible and always at merge.
- **Refinery** (serial queue per board):
  1. rebase onto the default branch;
  2. lease-violation check;
  3. tests (board-configured command);
  4. open or merge the PR via `gh`.
  - A conflict or failure sends the card back to its author with the diff. A second failure goes to a merge agent. Humans hear only via `escalate_to_human`.

### 5.7 Context and memory

**Built into the board MCP:**
- Artifacts (spec, decision, contract, handoff, finding) attached to nodes.
- `commit_sha` and `superseded_by` handle staleness.
- Hybrid search: FTS5 plus `sqlite-vec`, with embeddings from the Unsloth box's `/v1/embeddings`. FTS5 alone works whenever that endpoint is down.
- Search is scoped to card, subtree or board.

**Borrowed ideas:**
- **handoff-mcp:** a structured handoff note (state, decisions, blockers, file pointers, next steps). Required on every reassignment.
- **Memorix:** cross-session, cross-harness project memory with an autopilot capture step. We'll evaluate it as a pluggable backend behind the same `search_context` tool in Phase 5.
- **Kimi's `import-sessions`:** worth testing as a native Claude → Kimi handoff path.

### 5.8 Telemetry and quota

| Pool | Source |
|---|---|
| Claude | OTel (`CLAUDE_CODE_ENABLE_TELEMETRY`) → embedded OTLP receiver. Also transcript JSONL parser, and a status-line script that posts `rate_limits` to the daemon. |
| Kimi, Antigravity | stream-json/ACP usage fields, plus whatever quota source Spike 0 finds; otherwise **observed** 429/lockout messages update `rate_windows` (`locked_until`). |
| NIM, Groq, local | LLM gateway: counted requests and tokens, `x-ratelimit-*` headers where sent, 429s, latency |

All of this is normalized into `usage_events` and `rate_windows`. ccusage-style cost tables are for the dashboards.

_Built in 6.3 (2026-11-06): Claude's OTel metrics → the daemon's OTLP receiver, ACP usage blocks, and the gateway's counts, all attributed to board, card, agent and model in `usage_events`; windows stay in the limiter, with a minute-by-minute history in `pool_samples` rather than a `rate_windows` table. Cost comes only from Claude's telemetry; there is no price table for other harnesses. The transcript parser was not built._

### 5.9 Permissions

- **Agents:** `can_create_cards`, `can_assign` (scope: own subtree / board), `can_spawn_agents` (auto or require-human), `can_install_mcp` (default off, require-human), and a budget (warn 80%, pause 95%). _Built: `canCreateCards`, `canAddDependencies`, `canSpawnAgents`, `canInstallMcp`, `canRequestGrants` per role (Agents view → Permissions); budgets per agent and board (6.3); approvals (6.4). Not built: `can_assign`._
- **Guardrails:**
  - max depth 5 and max 12 children per card (configurable);
  - no delegating to the holder of an open ancestor;
  - a per-turn cap on card writes.
- **Humans:** the same engine. A user's `scope_node_id` limits them to that subtree. Roles are owner, operator and viewer.
- **Safety:** auto-approval is confined to the card's worktree plus the shared roots of Phase 6.2 (scratch space, the machine's toolchains, the repo's git dir, each harness's own state). Anything else outside it is refused and reported to the humans. The Docker executor becomes the "unattended overnight" mode.

### 5.10 Unified rate limiting and load balancing

Every pool, subscription or API, is modelled the same way: a set of **windows**, each with a limit, current usage and reset time.

| Pool | Windows | Where usage comes from |
|---|---|---|
| Claude Pro | 5h, 7d (% used) | status-line `rate_limits` |
| Kimi Plus | 5h (+7d if still enforced) | Phase 0 source / observed 429s |
| Google AI Pro | 5h, 7d | Phase 0 source / observed lockouts |
| **NVIDIA NIM** | **rpm = 40, per API key** (shared by all models; configurable) | gateway counts every request (rolling 60 s) |
| Groq free | tpm ≈ 8000, rpd = 1000, **per API key** (shared by all models) | gateway counts + `x-ratelimit-*` headers |
| Local Qwen | concurrency only (slots) | gateway in-flight count |

**Pool state** comes from its most-used window:
- **`open`** below 80%.
- **`warn`** at ≥ 80%. The pool still takes work, but its scheduler score drops (the `headroom` term), so new cards prefer other pools.
- **`halted`** at ≥ 95%.
  - **API pools:** the gateway **queues** further requests until the window has room. For NIM that means at most 38 requests in any rolling minute. In-flight agent turns slow down instead of failing.
  - **Subscriptions:** no new cards are assigned to the pool. Running sessions finish their current turn and are then parked or handed off.
  - In both cases the scheduler **routes new and waiting cards to the next eligible pool**: load balancing.
- **`locked`**: an observed lockout or 429 with a reset time. Treated as halted until the observed reset, which overrides the advertised one.

**Rebalancing:**
- A card waiting more than N seconds (UI setting) on a halted pool is re-routed. Its session gets a `write_handoff`, and a new agent on another pool resumes from the handoff.
- Per-window thresholds (80/95), the NIM RPM and per-pool concurrency caps are UI settings. The UI shows each pool's windows as live gauges.

**LLM gateway** (`packages/gateway`):
- A tiny OpenAI-compatible reverse proxy in the daemon at `/p/<pool>/v1/*`.
- It owns the provider keys and sets a `User-Agent` (Groq requires one).
- Per pool it applies the limiter, records `usage_events`, and reads rate-limit headers.
- On a 429 it backs off and marks the window.

### 5.11 Fast lane (Groq free tier)

Groq is very fast, but the free tier allows only ~8k tokens/min and 1k requests/day. The daemon uses it for **small, latency-sensitive utility jobs**, never coding sessions.

**Rules:**
- Each job has a hard input cap (trimmed before sending) and a priority.
- A token-bucket scheduler shares the budget across jobs.
- Every job **falls back** Groq → NIM → local Qwen when Groq is warn/halted.
- Limits are **per key**, so all Groq models share one budget. Use one model (`$GROQ_MODEL`).

| # | Job | Input cap | Trigger | Priority | Phase |
|---|---|---|---|---|---|
| 1 | **Live narrator**: one-line "who is doing what" status from each session's recent events | ~600 tok | every few events per active session (debounced) | 1 (highest) | 3 |
| 2 | **`ask_agent` quick answer**: answer from the busy target's top `search_context` hits instead of interrupting or forking it | ~3k tok | `ask_agent` to a busy agent | 1 | 5 |
| 3 | **Query rewrite**: expand an agent's `search_context` query and add a hypothetical answer for embedding | ~300 tok | every `search_context` call | 2 | 5 |
| 4 | **Artifact tagging**: title, tags and a one-line summary for every saved artifact or handoff | ~2k tok | `put_artifact` / `write_handoff` | 3 | 5 |
| 5 | **Commit message + PR description** from a trimmed diff (stat + hunks) | ~4k tok | refinery, before PR | 2 | 4 |
| 6 | **CI/test failure triage**: root-cause line, likely file, flaky or not, from the log tail | ~3k tok | failed test run in the refinery | 2 | 4 |
| 7 | **Card spec lint**: acceptance criteria present? Scope clear? Bounce it to the orchestrator if not | ~1.5k tok | before assignment | 2 | 3 |
| 8 | **Notification text** for escalations and approvals (built in 6.4) | ~500 tok | `escalate_to_human`, approval created | 3 | 6 |

The two models split the work: **Kev decides** (yes/no, scores, choices) and **Groq writes** short text.

### 5.12 Harness isolation (decided 2026-11-02)

Board workers must see only what the router gives them. The user's own interactive setup must not leak into worker sessions: global MCP servers, hooks, skills and settings. The router's config must not leak out either. Other agents on the machine, with their own configs and MCP servers, must not interfere.

Two modes, same adapter interface:
- **Local, isolated (default).** Each harness runs on the host with a config home under `.meta-harness/`, holding only router-managed config: its own MCP servers (the board MCP plus whatever the router adds), skills and settings. The login is the one thing shared with the user's install, symlinked or reused, never copied.
- **Container (later, with the Docker executor of §5.9).** An ultra-lightweight image per harness with the worktree and the router's config mounted. Logins come in through mounted credential stores.

Status by harness:

| Harness | Isolation now | Still to do |
|---|---|---|
| Claude | `--strict-mcp-config` (only the board MCP), `--setting-sources project,local` (no user hooks, status line or settings), daemon-written `--settings` | router-managed skills/agents dir |
| agy | isolated `HOME` (`.meta-harness/agy-home`) with `~/.gemini/antigravity-acp` (login), the toolchain folders and git config symlinked (Phase 6.2); the server's stray built-in skill file is removed before commit | — |
| OpenCode | daemon-generated config via `OPENCODE_CONFIG`; keys only in the gateway | stop merging the global `~/.config/opencode` |
| Kimi | none yet (reads `~/.kimi-code`) | isolated config dir with the login shared |

Found the hard way: Google's ACP server loaded the user's Antigravity IDE MCP servers (`~/.gemini/config/mcp_config.json`). One of them failed to start, and agy answered every card with only that error and ended the turn "successfully". The live smoke test now checks each branch's diff, not just the card status.

## 6. Repository layout

```
apps/
  daemon/            # HTTP+WS server, scheduler, session manager, refinery
  web/               # React + Vite + React Flow + xterm.js
  vscode/            # VS Code extension (Phase 6.1): a client of the daemon, bundled with esbuild
packages/
  core/              # types, event schema, settings, permission engine
  db/                # Drizzle schema + migrations (SQLite)
  adapters/          # claude/, agy/, kimi/, opencode/, acp-client/ (shared), pty/
  board-mcp/         # board MCP server (HTTP, per-agent tool filtering)
  claude-channel/    # stdio channel server spawned per Claude session; bridges to daemon
  router/            # Kev client, scoring policy, outcome learning
  telemetry/         # OTLP receiver, transcript parsers, quota pollers
  gateway/           # OpenAI-compatible proxy + unified limiter (windows, 80/95 states, queueing)
  fast-lane/         # Groq utility jobs with token budget and fallback chain
  context/           # artifact store, FTS/vector search, handoffs
docs/
  agents/            # agent-facing docs (tools, conventions, how to add MCP/skills)
  spikes/            # spike reports
.meta-harness/       # runtime state: sqlite db, worktrees, logs (gitignored)
```

_As built: the board MCP server, the OTLP receiver and metrics (6.3), budgets, approvals, best-of-N, tool grants and the IDE bridge (6.1–6.5) live in `apps/daemon/src/`, not in packages of their own, and the database package uses `node:sqlite` rather than Drizzle. `docs/agents/` exists (6.4). The README's Layout table is the current map._

Libraries (as built): Node 24+ running TypeScript directly via type stripping (no build step for the daemon) · pnpm workspaces · Fastify 5 + `@fastify/websocket` · **`node:sqlite`** (built in, with FTS5; embeddings stored as BLOBs and searched by brute force, no `sqlite-vec`) with hand-written SQL migrations · a small in-repo ACP client (JSON-RPC over stdio) · `@modelcontextprotocol/sdk` (board MCP) · `node-pty` + `@xterm/xterm` (Claude sessions) · `@xyflow/react` (tree view) · `git` and `gh` CLIs · React 19 + Vite · **`node:test`**. Planned: Playwright (UI tests, Phase 5.6).

## 7. Phases

Each phase ends with something runnable and a short demo.

### Phase 0: Spike (harness probe)
_OpenCode is already done (2026-11-01: ACP, concurrent multi-model sessions, NIM and local verified). The rest needs the sign-ins from §4, and runs in parallel with Phase 1._
- For each of `claude`, `agy`, `kimi`, `opencode`:
  - run a scripted task in each mode (PTY, stream-json, ACP);
  - record streaming tool calls, sub-agent events, permission flow, resume, usage/quota fields, MCP injection and skills.
- **Claude PoC:** an interactive `claude` in a PTY with a dev channel server. Push a message, auto-answer a permission request through the relay, block an edit with `PreToolUse`, and read rate limits from the status line.
- Find the quota sources for Kimi and Antigravity.
- **Output:** `docs/spikes/00-harness-matrix.md`, and a default mode per adapter.
- **Exit:** every adapter can start, take a prompt, stream events and stop.

### Phase 1: Skeleton (one agent, one card)
_Status 2026-11-02: **done, except the attachable terminal**. That moves to Phase 2 with the Claude PTY adapter, since ACP sessions have no terminal. Verified live: a NIM card and a local-LLM card ran concurrently and landed as commits on their own branches (25 s). 12 automated tests cover the store, the ACP adapter (via a scripted fake agent) and the runner._
- ✅ Monorepo, DB schema, event log, daemon WS stream.
- ✅ Worktree manager.
- ✅ One adapter end to end: **OpenCode via ACP** on NIM or local Qwen.
- ✅ Worktree-only permission policy, plus resume after a policy-cancelled turn.
- ✅ UI: board columns, add/move cards, card detail with a live event log, run/cancel per pool.
- ⏭ Attachable terminal: moved to Phase 2.
- **Exit:** create a card in the UI → an OpenCode agent works it in a worktree → a branch with commits, all visible live.

### Phase 2: All harnesses + board MCP
_Status 2026-11-02: **done**, and re-verified on the Linux machine the same day:_
- _All five pools (Claude, Kimi, agy, NIM, local) ran a card end to end and committed on their own branch (9–33 s each)._
- _The exit scenario passed live with Kimi and NIM: Kimi leased `calc.py` and messaged NIM; NIM's edits were refused by the lease._
- _It also exposed a gap, now fixed. Kimi's "done" message arrived before its lease release. NIM was refused again, ended its turn, and nothing woke it once the file was free. The runner now tells every card refused a leased file when that lease is released._
- **Exit test passed live:** Kimi reserved `calc.py` and messaged the NIM card; NIM was refused edits to the leased file twice, replied, waited for Kimi's "done" message, then edited and committed. NIM requests are paced through the gateway.
- **Automated:** 26 tests cover the limiter, gateway, leases, the shell policy, messaging (idle wake, urgent interrupt, queued delivery) and board MCP tools end to end via the fake agent.

**What was built, by harness:**
- **Kimi:** `kimi acp`, on your Kimi Plus login.
- **agy:** Google's ACP server, installed by `scripts/install-agy-acp.sh` with a checksum check. It reuses the CLI's Google login via `authenticate(oauth-personal)`.
- **Claude:** an interactive TUI in a PTY.
  - Prompts are typed with bracketed paste.
  - `PreToolUse` hooks decide every tool call; `Stop` carries `last_assistant_message`; the status line feeds the 5h/7d windows into the limiter.
  - The worktree trust dialog is answered automatically (Down, then Enter; the default is "No, exit").
  - The terminal can be attached from the UI.

**Findings:**
- **Channels are not used yet.** Typed prompts at turn boundaries plus Esc for urgent cover the messaging model without the research-preview flag. Channels remain an option for delivering a message mid-turn without an interrupt.
- **Shell commands are now checked for outside paths** (redirect targets, `../`, `~`, `--x=/path`) on every harness, with a small allowlist of system locations. Without this, a Claude test wrote outside its worktree with `echo > /path`.
- **Kimi auto-approves edits inside its cwd without asking,** so leases are not enforced at edit time for Kimi. It still sees them via `reserve_paths`, and the Phase 4 merge check covers the rest. Its outside writes and all shell commands do ask.
- **Child agents must not inherit Claude Code session markers** (`CLAUDECODE`, `CLAUDE_CODE_*`). The daemon strips them, along with provider keys.
- The remaining adapters: Kimi (ACP), Claude (PTY + channel + hooks), agy.
- PTY sessions and an attachable xterm terminal in the card panel (carried over from Phase 1).
- Board MCP: work, messaging and lease tools.
- Message queue and urgent.
- Lease map in the UI.
- LLM gateway and the unified limiter for API pools. OpenCode's NIM and local providers point at the gateway; NIM is capped at 38 requests per rolling minute.
- **Exit:** two agents on different harnesses work sibling cards, exchange a message, and one is blocked from a file leased by the other. A burst of NIM requests is queued at 95%, not rejected.

### Phase 3: Orchestrator + routing
_Status 2026-11-02: **done.** Exit test passed live twice on the Linux machine._
- _**Run 1** (Kimi forced to 95%): the Opus orchestrator on Claude planned 3 cards (code; docs; tests waiting on code). Kev classified them, and they routed to agy; Kimi got 0 cards._
- _**Run 2** (agy forced to 95%): the same goal routed to Kimi, and agy got 0 cards. The tests card started with the code card's branch merged. The output was checked: correct `calc.py`, 15 agent-written pytest tests passing, README usage section._
- _Automated: 45 tests (router policy and Kev parsing, fast lane, tree store, limiter override, and scheduler end to end: goal→plan→route, dependency gating and merge, re-route, caps and permissions, spec lint, lease wake-up, stall watchdog)._

**What was built:**
- **Data:** cards have a role (orchestrator or worker), work type, Kev classification, routing rules (inherited), depth, creator and narration. Blocked-by edges are cycle-checked. Settings are per board.
- **Router** (`packages/router`): a Kev client. One call returns work type (a `choice` of 4 options for untagged cards, a `noul` confirmation of the orchestrator's tag), complexity (`score`, 0–4) and needs-review (`noul`), with defaults when Kev is down. The policy filters on rules, a hard complexity cap, free slots, pool state and the Claude and Codex reserves. It then scores success prior × headroom × scarcity × load, with a bonus for the previous pool.
- **Scheduler** (daemon):
  - classifies new cards, lints agent-written specs, and holds cards until their blockers reach Review;
  - starts ready cards on the top pool and logs `card.routed` with every candidate's reasons;
  - waits `rerouteAfterSec` for a card's previous pool, then re-routes;
  - keeps Kev warm and runs the narrator.
- **Orchestrator:** `POST /api/boards/:id/goals` creates a planning card on Claude/Opus, or the first open subscription pool when Claude is halted. Board MCP tree tools are `create_subtask`, `update_subtask` and `add_dependency`, gated by role permissions, max depth, max children and cards per turn.
- **Limiter:**
  - **Claude's 5h/7d** windows come from the status line.
  - **Observed lockouts:** agent errors matching quota or rate-limit text lock the pool.
  - **Stall watchdog:** no agent activity for `stallMinutes` (default 5) cancels the turn, locks the pool for 10 minutes, and re-routes the card with its partial work committed. Found live: Kimi retried an overloaded upstream (429) silently for about 8 minutes.
  - **Operator override:** `POST /api/pools/:id/force`.
- **Fast lane** (`packages/fast-lane`): narrator (#1) and spec lint (#7) on Groq, falling back to NIM, then local; pools that aren't open are skipped. Lint fails open.
- **UI:** Tree view (React Flow) with parent/child, blocked-by and animated comms edges and narration on each node. Also a goal bar, a card Routing section (Kev scores and per-pool reasons), and a Settings drawer (routing, slots and scarcity, Force 95%, guardrails, permissions, fast lane).

**Notes for later phases:**
- A turn that ends "successfully" without doing the task is not detected yet. Phase 4's verification (tests, Kev scoring against acceptance criteria) has to catch it.
- Routing uses priors until Phase 5 records outcomes. (Done in Phase 5.)

**Original scope:**
- Opus orchestrator session with tree tools.
- Kev client and classification.
- Subscription windows wired into the unified limiter.
- Scheduler policy with reserves, `warn`/`halted` pool states, and re-routing of cards stuck on halted pools.
- Tree view (React Flow) with a comms graph and live pool gauges.
- Agent permission toggles and depth/fan-out caps.
- Fast lane: live narrator (#1) and card spec lint (#7).
- **Exit:** type a goal → Opus decomposes it → Kev scores the cards → cards are auto-routed across pools → the tree grows live with narrated statuses. When a pool is forced to 95%, new cards visibly flow to other pools.

### Phase 3.5: Delegation hierarchy (lead pools)
_Planned 2026-11-02. Pulls part of the per-agent permissions and assignment (§5.9, Phase 6) forward. Small; it reuses the Phase 3 tree tools, inherited routing rules and scheduler._

_Status 2026-11-03: **done.** Exit test passed live on the Linux machine:_
- _An agy orchestrator on **Gemini 4 Argon** planned "turn calc.py into a small calculator project". It marked the library as a lead card, which routed to `sonnet-lead` (Claude, Sonnet). It gave the README to Kimi and the CLI to agy._
- _Sonnet split its chunk into a code card and a tests card (tests waiting on code). Both ran on NIM, within the lead's `[local, nim]` targets. Every branch held real work; the 14 agent-written pytest tests pass._
- _With NIM forced to 95%, the routing preview for a lead child offers only `local`._
- _Automated: 53 tests._

**Built differently from the plan: agents, not pool roles.** A role per pool could not express "Opus orchestrates and Sonnet leads, both on Claude Pro", which the target diagram needs. So the hierarchy is made of **agent profiles**:
- **What an agent is:** `{id, poolId, model, role, delegatesTo, enabled}`, kept in board settings (`agents`).
- **What stays per pool:** quota, slots, scarcity, limiter state and the harness process. Agents on one pool share them.
- **Implicit workers:** every configured pool without its own worker or lead gets a worker on its default model. Boards saved before this behave as before; the old `orchestrator: {poolId, model}` setting migrates to the orchestrator agent.
- **Routing rules** name agents or pools (`agy` matches every agent on agy, `agy-argon` only that one). `card.agentId` records which agent ran a card.
- **Delegation:**
  - `delegatesTo` empty means any worker, and for the orchestrator any lead too.
  - `create_subtask` refuses a card no target can take, e.g. `delegate=true` with no lead on the team.
  - Settings saves are validated: known targets, no delegating workers, no targets that are orchestrators, no cycles.
- **Models are discovered from the harnesses:**
  - ACP harnesses list them in `session/new` → `configOptions.model`, probed once per harness at daemon start (`GET /api/models`, `?refresh=1`).
  - OpenCode's list is narrowed per pool by provider prefix.
  - Claude has no listing, so it offers its `--model` aliases: fable, opus, sonnet, haiku.
  - Found 2026-11-03: Kimi has 6 models (K2.8 Preview, K2.7 Highspeed, K3, K3-256k, K3.1 Pro, K3.1 Pro Highspeed), agy has Gemini 4 Argon and Gemini 3.8 Flash, and NIM has 20 (including non-chat guard and voice models, so pick coding models by hand).
- **UI:**
  - Settings has an agent editor: per-agent pool, model picker, role, on/off and delegation checkboxes, with a hierarchy preview.
  - The card panel runs a card on any agent, optionally with another model on its pool. It also has a routing-rules editor (any / only / avoid per agent or pool, showing where inherited rules come from).
  - The tree marks lead cards and shows the agent on each card.

**Found live, fixed:** the orchestrator made the CLI card wait for the lead card. A lead finishes as soon as it has planned, so the CLI started before the library existed. A planning card (lead or orchestrator) now satisfies a dependency only once its whole subtree has finished, and the waiting card merges the subtree's worker branches.

**Open:**
- Agents commit whatever they leave untracked: NIM committed `__pycache__/*.pyc` in a repo without a `.gitignore`. Phase 4's merge checks should filter build output.
- Priors (`PRIORS` in the router) are still per pool, not per model. Phase 5 outcomes should be keyed by agent. (Done in Phase 5: per-model priors, outcomes keyed by pool + model.)

**Goal:** the tree of *who may delegate to whom* is configurable, not just the tree of cards. Example target structure:
```
request → primary orchestrator (any pool/model, not only Opus) + Kev
            ├─ agy      (worker)
            ├─ kimi     (worker)
            └─ sonnet   (lead) ─┬─ local Qwen (worker)
                                └─ NIM        (worker)
```

**What exists already:**
- The orchestrator's pool and model are a setting.
- Kev classifies every card.
- Routing rules (`pools` / `avoid`) are inherited down the tree.
- Tree guardrails and the tree view render any depth.

**To build:**
1. **Pool roles + delegation targets** in board settings. Each pool gets a role (`orchestrator` | `lead` | `worker`) and a list of pools its child cards may go to, e.g. `claude: lead → [local, nim]`; the orchestrator → `[agy, kimi, claude]`. This replaces the role-wide "workers may create cards" toggle as the main control; the toggle stays for edge cases.
2. **Lead cards:**
   - `create_subtask` gets `delegate: true` (or `role: "lead"`) so the orchestrator can mark a big chunk to be broken down further.
   - Lead cards route only to pools whose role is `lead`.
   - A lead card's session gets the planning prompt (decompose, don't code) plus the tree tools; worker cards don't get them.
3. **Automatic routing rules on children:**
   - Cards created by a lead's session get `routing.pools = <that pool's delegation targets>`.
   - Cards created by the orchestrator get the orchestrator's targets.
   - These are inherited down, so Sonnet's children fan out only to Qwen and NIM.
4. **Permissions follow the pool role:** `create_subtask` / `add_dependency` are allowed when the calling card's role (or its pool's role) is orchestrator or lead; workers are refused as today.
5. **UI:**
   - A delegation editor in Settings: per-pool role and target checkboxes, with a small preview diagram of the hierarchy.
   - A routing-rules editor on the card panel (allowed and avoided pools, showing what is inherited and from where).
   - Lead cards are marked in the tree view.
6. **Guardrails:**
   - Existing depth, fan-out and per-turn caps apply.
   - A lead may not delegate to a pool above it in the hierarchy (no cycles: validated when settings are saved).
   - If every delegation target is halted, the card waits and then follows the normal re-route rule, staying within its allowed pools.

**Exit:** a goal is planned by a non-Opus orchestrator. At least one chunk is marked as a lead card and routes to Sonnet, which splits it into children that run only on Qwen and NIM. Sibling worker cards run on agy and Kimi. The tree view shows all three levels with the right pools. Forcing NIM to 95% sends the lead's children to Qwen only.

### Phase 4: Refinery + GitHub
_Status 2026-11-03: **done.** Exit test passed live on GitHub. The repo was a throwaway private one, `BryansGlizzy/mh-refinery-demo`. Automated: 62 tests._
- _The goal was "extend wordstats with word frequency and a CLI". An agy orchestrator on Gemini 4 Argon planned 3 cards: `top_words` with tests; a CLI with tests that waits on it; README docs. All three routed to Kimi._
- _Each landed with no human input, as a PR that was opened, given a fast-lane-written title and body, and merged: #1 docs, #2 `top_words`, #3 the CLI, after #2. Each card's steps were queued → updating → testing → pr → landed._
- _On a fresh clone of `origin/main`, `git log --first-parent` shows one commit per card, all 8 tests pass, and the CLI works. The PR branches were deleted, and the local `main` checkout followed `origin`._
- _No card reached the review threshold (Kev scored them all below 0.6), so cross-provider review was verified in the local run below and in the tests._

_Live local run (the Phase 3.5 demo board, 7 cards):_
- _Every card landed, and the lead and orchestrator closed after their cards. The order was README, the Argon `add` card, the NIM library (after a conflict NIM resolved itself), the tests (after a `.pyc` conflict NIM resolved), then the CLI, which waited for the lead's chunk._
- _`git log --first-parent main` shows one fast-lane-titled commit per card, and the clean checkout was fast-forwarded._
- _The 14 tests pass on `main`, and `cli.py` works._

**What was built** (`apps/daemon/src/refinery.ts`, `github.ts`, landing helpers in `git.ts`):
- **Pipeline per worker card:** Review → (cross-provider review) → Merging (queue) → Done. State is kept in `card.pipeline`: review rounds, landing attempts, reassignments, agents to avoid, escalation, PR URL and landed sha. Every step is a `card.refinery` event, shown in the card's log.
- **Cross-provider review:**
  - **When:** a card's Kev needs-review score is at least `reviewThreshold` (default 0.6; Kev's fallback is 0.5, so an unreachable Kev doesn't review everything).
  - **Who:** the best free worker agent on a different pool from the author.
  - **How:** it reads a detached copy of the branch with edits refused, and ends with `VERDICT: APPROVE|CHANGES`.
  - **Outcome:** requested changes go to the author. A new branch head is reviewed again, up to `maxReviewRounds`; after that the card lands anyway, because tests still gate it. A reviewer that fails or gives no verdict doesn't hold the card.
- **Merge queue:** serial per board, first in first out. Before landing, a card:
  1. waits until its blockers have landed;
  2. waits while another card leases a file it changes;
  3. merges the base branch into its own;
  4. runs the board's `testCommand` in its worktree.
  It then lands with commit/PR text from fast-lane #5, falling back to the card's title and description.
- **Landing modes:**
  - `pr`: push, `gh pr create`, `gh pr merge --merge`, then delete the remote branch. Local `main` follows `origin` when its checkout is clean.
  - `local`: a merge commit made in a scratch worktree. The default branch is fast-forwarded, but only when its checkout is clean; otherwise the card waits and says why.
  - `auto` picks `pr` for a GitHub remote when `gh` is installed.
- **Failures:**
  - A conflict or failing tests (with fast-lane #6 triage: cause, file, flaky) goes back to the author first. If the author's session has closed, the card runs again on the same agent.
  - The second failure goes to a different agent (the merge agent), with a handoff note: reason, the last agent's summary, recent errors, and how to see the work so far.
  - At `mergeAttempts` failures, a human is asked.
- **Reassign-on-failure:** a failed run (startup error, failed turn, `report_blocked`) is handed to another agent with a handoff, up to `maxRetries`, then escalated. Agents that failed a card rank ×0.2 for it.
- **`escalate_to_human`** board MCP tool: the card goes to Blocked with no automatic retries. Moving a card out of Blocked by hand resets its counters.
- **Planning cards** (lead, orchestrator) become Done once everything below them has landed.
- **Build output is never committed:** `__pycache__`, `*.pyc`, `.pytest_cache`, `node_modules` and similar caches are left out, even without a `.gitignore`.
- **UI:** a Refinery section in Settings (auto-land, mode, test command and timeout, attempt limits, review threshold and rounds), PR link, landed sha and attempt counts on the card, and refinery steps in the activity log.

**Built differently from the plan:**
- **Merge, not rebase, and merge commits, not squashes.** Cards that waited for another one start with its branch merged in. If that card then lands as a squash, git doesn't know the squash holds the same changes, and every dependent card conflicts with it. The first live-style test caught this. So branches are brought up to date by merging the base, and cards land as `--no-ff` merges (GitHub's "merge" method). `git log --first-parent main` still reads as one commit per card.
- **The merge agent is a reassignment** to a different agent with a handoff, not a dedicated agent type.

**Found live (demo board, real agents):**
- agy reviewed two NIM cards and approved both.
- The NIM library card then conflicted on `calc.py` with a card that had already landed. It went back to NIM, which merged `main`, kept both sides and landed.
- The reviewer's second round flagged that NIM had committed `__pycache__/*.pyc`. That led to the build-output exclusion.
- A tests card was blocked by an untracked `.pyc` that `main` now tracked; git refuses to overwrite such files. The merge now removes exactly the untracked files git names and tries once more. That's safe because agents' work is committed at the end of every turn.

**Original scope:**
- Merge queue: rebase, test, lease check, PR via `gh`.
- Conflict loop and merge agent.
- Reassign-on-failure with handoff.
- Retry settings.
- Cross-provider review.
- Fast lane: commit/PR text (#5) and CI triage (#6).
- **Exit:** a multi-card goal lands as merged PRs without human input.

### Phase 5: Context and learning
_Status 2026-11-04: **done.** Exit test passed live on the Linux machine with a separate daemon instance (`MH_STATE_DIR`) on a scratch repo. Automated: 74 tests._
- _The card "Add a CSV export of the inventory" was allowed only on NIM or Kimi and split into two stages. Kimi (K3.1 Pro), routed first by its prior, recorded the decision "Inventory CSV format" with `put_artifact`, wrote its own handoff, and reported blocked._
- _The daemon recorded Kimi's outcome (`failed_run`) and saved the required structured handoff, which supersedes Kimi's own handoff and keeps it inside. It then reassigned the card to NIM._
- _NIM called `search_context`, found decision `a_9fe2f0865b09`, read it with `get_artifact`, implemented it exactly, and the card landed. Kev scored the landed work 0.92 with in-scope 0.86._
- _Routing for the next feature card visibly changed. Kimi's success estimate fell from its 0.877 prior to 0.658 (observed 0, n=1). NIM's rose from 0.598 to 0.679 (observed 0.922, n=1)._
- _Tagging (#4) gave every artifact tags and a one-line summary._

**What was built:**
- **Context store** (`packages/context`, migration 7):
  - **Artifacts.** Kinds are spec, decision, contract, handoff, finding, summary and note. Each attaches to a card, is versioned with `superseded_by`, and is stamped with the branch head.
  - **Search.** FTS5 (porter stemming) and EmbeddingGemma vectors, fused by reciprocal rank. Vectors are stored as SQLite BLOBs and searched by brute force, which is fine at board size; there is no native `sqlite-vec`. EmbeddingGemma's query and document prefixes are used.
  - **Similarity floor (0.65).** Measured: unrelated notes score 0.50–0.67 and real matches 0.69–0.82, so a 0.3 floor returned everything for an off-topic query. Override with `EMBEDDINGS_MIN_SIMILARITY`.
  - **Embeddings down.** Search falls back to FTS, the endpoint is retried after 60 s, and a backfill embeds what was missed. The embeddings key defaults to `KEV_API_KEY` (one key on the Unsloth box).
  - **Scopes:** card · subtree (the parent card and everything under it, i.e. siblings) · board.
- **Capture** (`apps/daemon/src/context.ts`), Memorix-style autopilot, the same for every harness:
  - each card's spec when it is created or rewritten;
  - the agent's closing message as a summary whenever a turn ends in Review;
  - a structured handoff (state, decisions, blockers, files edited, next steps) on **every** reassignment. It includes the previous agent's own `write_handoff` note, and is saved as an artifact and sent as the new agent's first message.
  - A re-run's prompt lists the card's earlier notes.
- **Board MCP tools:** `search_context`, `get_artifact`, `put_artifact` (decision, contract, finding, note), `write_handoff`, and `ask_agent`.
  - `ask_agent` to an idle agent prompts it and waits for its reply.
  - To a busy one, fast-lane #2 answers from the target's notes without interrupting it. Otherwise the question waits in its inbox.
  - `report_blocked` asks for a handoff when none was written.
- **Learning:**
  - **Kev scores landed work:** a 0–1 quality score against the acceptance criteria and an in-scope probability, in one call (live: 0.91 for a correct diff, 0.16 for an unrelated one).
  - **Outcomes** are recorded per agent as pool + model:
    - landed: Kev quality × scope × 0.9^(change requests);
    - failed landing: 0.4 for a conflict, 0.2 for failing tests;
    - failed run or escalation: 0;
    - a reported block: pending until a human weighs it (pass 1, fail 0, ignore).
    - Quota lockouts and refinery/GitHub errors are not counted.
  - **Routing history** is per pool + model and work type. It is weighted by complexity distance and blended with the prior, which counts as 3 outcomes. The reasons show prior, observed and n. Toggle: `learnFromOutcomes`.
- **Per-model priors** (`packages/router/src/priors.ts`), from the operator's model strengths:
  - **Skills:** each work type plus `review`, plus a front-end modifier from a new Kev question (live: 0.93 for a landing page, 0.02 for a DB migration).
  - **Research never goes to NIM or local:** they run without web access.
  - **Reviewers** are ranked on `review`.
  - **Overrides:** per-agent overrides in Settings (`priorOverrides`).
- **Fast lane:** query rewrite (#3; extra keywords plus a hypothetical answer, also embedded), artifact tagging (#4) and quick answers (#2), each with a toggle.
- **UI:**
  - The card panel has a **Context** tab: the card's notes, board-wide search showing how each hit matched, older versions and add-a-note. It also shows the card's outcomes and its front-end probability, and saved notes and outcomes appear in the activity log.
  - Settings → **Learning** has the toggles and an editable prior table per agent × skill, with observed outcomes under each value.
- **Memorix:** evaluated, not adopted ([memorix-evaluation.md](memorix-evaluation.md)). Its global agent-config setup and per-user store conflict with §5.12 isolation, and the card is our unit of memory. Its git-commit facts are worth copying later.

**Found live:**
- **OpenCode lists MCP tools in a truncated catalog** ("Code Mode", called through `execute`), and `search_context` was not in the visible part. NIM found it because the prompt names it. Keep naming the board tools in prompts; the board MCP now has 17 tools.
- **`report_blocked` was counted as a failed run**, even when the block was legitimate (missing keys). Changed per the operator:
  - A block now records a `blocked` outcome with review `pending`, which routing ignores, and tells the humans.
  - The human weighs it from **Blocks to weigh** in the status strip, or on the card. **Pass** means the block was justified (counts 1 for the model), **fail** means it should have done the work (counts 0), and **ignore** leaves it out.
  - A block that also used up the retries escalates without a second, automatic outcome. `escalate_to_human` still records nothing.

**Open:**
- Reviewers' own outcomes (did the approved card land cleanly?) are not recorded yet.
- GLM 5.3 Flash on the local box is not daemonized; its prior family is ready (`local:*glm*`).
- Codex is wired in as the `codex` pool (ACP via the `codex-acp` bridge; priors: GPT 6 Astra ≈ Opus, GPT 6.1 Sol ≈ Sonnet, other GPT models Sonnet-class). Its 5-hour and weekly usage (the numbers behind Codex's `/status`) are read from `codex app-server` (`account/rateLimits/read`) every minute into the same limiter as Claude's; an out-of-usage report locks the pool until the full window resets.

**Original scope:**
- Artifact store, FTS search, `search_context`, required handoffs.
- Memorix evaluation and handoff format.
- Kev outcome scoring feeding the router.
- Vector search via Unsloth embeddings.
- Fast lane: `ask_agent` quick answers (#2), query rewrite (#3), artifact tagging (#4).
- **Exit:** a reassigned card's new agent finds the prior decisions through search; routing scores visibly change with outcomes.

### Phase 5.5: Usability, reasoning levels, councils
_Added 2026-11-04 at the operator's request. Automated: 83 tests._

- **New board flow:**
  - A folder browser with a status line saying what the chosen folder is.
  - The daemon sets up a repository when needed (folder, `git init`, README, .gitignore, first commit), optionally creates a GitHub repo with `gh`, and refuses subfolders of a repo.
  - Settings opens right after, with an intro, at the agent layout.
  - Code: `apps/daemon/src/projects.ts`.
- **Changes tab** on cards: files changed with line counts, per-file diff or whole file. A landed card shows its merge into the default branch; otherwise its branch against where it forked.
- **Reasoning level per agent**, read from what each harness publishes:

  | Harness | Setting | Levels |
  |---|---|---|
  | Claude | `--effort` | low · medium · high · xhigh · max |
  | Kimi | ACP `thinking` | low · high · max |
  | agy | ACP `thinking_level` | low · medium · high |
  | OpenCode | ACP `effort` | minimal … max, default |

  - Set on every session of the agent, reviews included.
  - A level the harness doesn't offer is reported in the card log and skipped.
  - ACP options are found by the `thought_level` category or a known id.
- **Councils** (`apps/daemon/src/council.ts`): a goal on a board with **two or more enabled orchestrators** (pools not halted) is planned by all of them. The goal card holds the council state; each member gets a planning card under it.
  1. **Proposing.** Each member reads the repo and calls `propose_split`: one share per member, with scope and expected cards, plus a rationale. `create_subtask` is refused until the split is chosen.
  2. **Kev decides.** One call scores every proposal 0–1 (coverage, overlap, fit to each member's team), and the best becomes the "Council split" decision. Without Kev, the first proposal is used.
  3. **Planning.** Each member creates the cards for its own share under its own card. Delegation targets apply as usual. Shared interfaces go through `put_artifact` contracts and messages.
  4. **Working.** Cards run and land through the refinery.
  5. **Verifying.** Each member's worktree is reset to the latest default branch, and member *i* cross-checks member *i+1*'s share, creating fix-up cards under its own card if something is missing. It ends with a verdict.
  6. **Fixing.** Fix-ups land, then another round, up to `councilVerifyRounds` (default 2).
  7. **Done** when a round needs no fix-ups or the round limit is reached. Changes requested without fix-ups are sent to the humans.

### Phase 5.6: UI refinement
_Planned 2026-11-04. The features work; this phase makes them easy to read and use. Each item is small; together they should make the app feel finished out of the box._

**Progress (2026-11-04, first pass: the operator's list):**
- Done: rebrand in the UI and docs (package names and `.meta-harness/` keep the old name); Agents view (agent cards with family strengths and live pool state, hierarchy, permissions) and Pools view (by harness: windows with reset times, slots, agents, sessions across boards, via `GET /api/sessions/active`); Settings in tabs with hints, defaults, checks shown beside the field and Reset per tab; role, agent, model and reasoning level on tree nodes, board cards and the card panel header (live session first, then the agent profile); tree with draggable nodes remembered per board, Tidy layout, Fit, Follow running, Fold finished, colour by status or agent with an agent legend, a full legend, mini-map, side-to-side links for same-row dependencies, one two-way message edge per pair; live animations (running glow, talking ring, flowing dots on recent message edges, a flash on each new message, flowing parent edges for running children, edges drawing in); themes Clean, Frutiger Aero, Metro, Metalheart, Glassmorphism (`apps/web/src/themes.css`); empty states for the tree, board columns, pools and no board; a reconnecting banner; narrow-window layout with panels over the view below 900 px; `?theme=`, `?view=`, `?card=`, `?settings=<tab>` URL options.
- Next: board switcher with details, the attention inbox, keyboard shortcuts and a resizable panel, card panel filters/edit/duplicate, Changes tab upgrades, agent presets and the test button, pool usage history, toasts, the council timeline, Playwright smoke tests and the accessibility pass.

**Project Rebranding**
- It is now called the Infinity Harness - A meta harness for all of your agents to work together.

**UI Elements need clean up / redoing**
- Settings page is too cluttered and UI breaks/clips at times. The Agents/Permissions should be in its own menu; everything else can stay in settings. 
- The tree view should be manipulatable by the user as sometimes the cards overlap causing hard visibility. 
- Orchestrators do NOT show the model its using in the card / The cards should clearly visibly show orchestrator/lead/worker tags; including the agent they are running - Its also too abstract it will show claude / agy for example but not the underlying model. It should also show the model. 
- We can dress up the charts as well with a much more aesthetic UI - dynamic live animations when cards link / when they start communicating between. -- We can have themes that apply over the UI; the current clean basic one. Fruitiger Aero; Metro; Metalheart; Glassmorphism; 
- Pools can have its own view that expands to see the individual models/ slots used. All organized cleanly by the harness they are from. Showing the projects they are working on currently etc. 
**Navigation and layout**
- **Board switcher with details:** each board's repo path, default branch, landing mode (PR or local) and card counts by status. Rename, archive and delete a board (delete leaves the repo alone and offers to prune its worktrees and `mh/*` branches).
- **Resizable, remembered card panel.** Keyboard: Esc closes, ↑/↓ move between cards, `/` focuses the goal bar.
- **One place for attention:** messages for you, blocks to weigh, escalations and failed cards in one inbox with counts in the top bar, each item linked to its card. Today they are spread over the status strip and the card log.
- **Empty states that say what to do next:** no boards, no agents enabled, no cards, Kev or embeddings unreachable.

**Tree view**
- **Zoom to fit, follow the running card,** and collapse finished subtrees.
- **A legend** for edge styles (parent, waits-for, messages) and badges (plan, lead, council).
- **Colour by agent or by status** (toggle), with an agent legend.
- **Council goals:** members side by side, the chosen split visible on the goal node, verification rounds shown as a small timeline.

**Card panel**
- **Header summary:** status, agent and model with reasoning level, branch, PR, and the landed commit in one line. Facts that don't apply are hidden.
- **Activity filters:** messages only, tools, errors, refinery and council steps. Collapse long prompts. Jump to the latest. Search the log.
- **Changes tab:** a side-by-side diff option, syntax highlighting, and a file tree for large changes.
- **Context tab:** filter by kind, and click from a search hit to its card.
- **Edit a card** in place (title, description, acceptance criteria), and **duplicate** one.

**Settings**
- **Split into tabs:** Agents · Routing & pools · Refinery · Learning · Fast lane · Guardrails. Today it is one long page.
- **Agents editor:**
  - a card per agent showing the model family's strengths (from the priors) and its pool's live state;
  - **user made presets** ("Opus plans, Kimi and agy code, NIM reviews") and a **Council** preset;
  - a **test button** that starts a tiny session to check login, model and reasoning level.
- **Validation in place** (red field plus message) instead of an error toast after saving.
- **Explain each knob** with a one-line hint and its default; a **Reset to defaults** per section.

**Status and feedback**
- **Pool gauges:** hover shows every window with reset times; click opens a per-pool usage history (requests, tokens, lockouts) for the last day.
- **Toasts for important events** (a card landed, escalated or blocked; a council decided). Optional desktop notifications.
- **Connection state:** show when the daemon is unreachable and reconnect the event stream automatically.

**Quality**
- **Playwright smoke tests** for the main flows: new board (all folder states), goal → cards, card tabs, settings save, blocks to weigh.
- **Accessibility pass:** focus order, labels, contrast in both themes.
- **Narrow-window layout** (panel over the board below ~900 px).

**Exit:** a new user goes from **New board** to a merged change with only the user guide's first page. Every view has an empty state and a legend where needed. The Playwright smoke suite passes.

### Phase 6: The IDE, tool access, metrics and governance
_Planned 2026-11-05. Phase 6 runs in this order: 6.1 and 6.2 first (the operator hits them daily), then metrics and budgets, then governance. Each sub-phase ends with something runnable._

_**Status 2026-11-06: 6.1 (both stages), 6.2, 6.3, 6.4, 6.5 and 6.6 are built.** 6.6 was done after studying herdr ([research-herdr.md](research-herdr.md)): see its eight steps below. 198 automated tests pass (up from 102), plus a live check of Claude Code's telemetry (2.1.318) and screenshots of the new web views. What the automated tests cannot cover, because they run fake agents and a stand-in `vscode` API, is listed per sub-phase under "Not verified live"._

#### Phase 6.1: VS Code extension
_Status 2026-11-05: **first slice built** (`apps/vscode`, packaged as `infinity-harness.vsix`). Automated: the client against a live in-process daemon, and the bundled extension activated with a stand-in `vscode` API (commands, views, notifications)._

**Goal:** work from the workspace you have open, the way the vendor extensions (Claude Code, Codex) do. The open folder is the board's repository. Editor context goes into goals and messages. Agents' work comes back as native diffs. Live sessions can be attached, and agents' questions reach you where you are.

**Design:**
- **A client, not a second daemon.** The extension talks to the local daemon over the same REST and WebSocket API as the web UI. Agents still run in the daemon, each card in its own worktree and branch, and land through the refinery. Nothing about routing, leases or isolation changes.
- **Workspace ↔ board.** The board whose repository holds a workspace folder (closest match first) is bound to the window. The choice is remembered per workspace and can be switched. A folder without a board gets **Create board**. A folder that isn't a repository yet is set up through the same `prepareRepo` path as the New board form. A subfolder gets its repository's board.
- **Native where VS Code is better, the web UI where it already exists.** Cards, attention, diffs, terminals and notifications are native. The full board UI (tree, card panel, Agents, Pools, Settings) opens in an editor tab that frames the daemon's page (`?board=`, `?card=`, `?view=`), like VS Code's Simple Browser. `asExternalUri` keeps that working over Remote-SSH and port forwarding.

**Built (first slice):**
- Activity-bar container with two views:
  - **Cards:** the parent/child tree with status icons, role, agent and the narrator's line. Inline actions: Show Changes, Attach Terminal, Message Agent. Context menu: Run on Best Agent (moves the card to Ready), Stop Agent, Open Worktree in New Window.
  - **Needs you:** messages to humans, blocks to weigh (Pass, Fail or Ignore in a quick pick) and blocked cards, with a badge for what's new. Policy notices (6.2) open the card they name.
- **Planning from the editor:** Plan a Goal (the active file and selection are attached when `editorContext` is on), **Plan a Goal About the Selection**, and **Plan a Fix for This File's Problems** (the file's errors and warnings become the goal).
- **Send Selection to a Card's Agent:** the code, its path and line range, and a note, as a message.
- **Show Changes:** every file a card changed, before ↔ after, in VS Code's multi-file diff editor (`vscode.changes`). Contents come from the daemon (`/api/cards/:id/file?side=from|to`), so nothing needs to be checked out.
- **Attach Terminal:** a VS Code pseudoterminal on `/ws/terminal/<card>` for Claude cards. You get the scrollback, live output and resize, and you can type to take over.
- **Status bar** (cards working, items that need you) and notifications (`all`, `attention` or `off`).
- **Direct mode** (decided 2026-11-05; the operator's rule: a git repository defaults to worktrees, any other folder to direct). The board's `mode` is set when it is created:
  - **Defaults:** a folder inside a git repository gets worktree mode. Any other folder gets direct mode, with no git set up. Either can be chosen explicitly: New board form, the extension's Create Board, or `mode` on `POST /api/boards`.
  - **How cards run:** agents work in the folder itself, with no worktree, branch, merge, commit, review or landing. A worker card ends **Done**. Planning cards close when their children are done, as before.
  - **Concurrency:** **Workers at once** (`directParallel`, default 1) caps the cards editing the folder. Leases keep Claude, OpenCode and agy apart, but Kimi and Codex edit inside their cwd without asking.
  - **Councils are off.** Their verification resets each member's checkout, which here is the user's folder. It's guarded twice: in `members()` and at the reset.
  - **Prompts:** workers are told the folder is shared and live, and are forbidden commands that discard others' work (`git checkout/reset/stash/clean`, folder-wide formatters).
  - **Changes:** the files the agent's edit tools touched, from the event log, with current contents only. Edits made through shell commands aren't listed. In VS Code, Show Changes opens those files.
  - **Stray files:** files a harness drops (agy's `skills/system`) are removed after the session, unless they were already there.
- **Daemon lifecycle:** an offline state with **Start Daemon** (runs `pnpm start` in `infinityHarness.installPath` and waits for health), and reconnection with backoff.
- Daemon changes for it: `?board=` in the web UI; `side=from` on the card file endpoint; `fileAt` returns exact bytes (it trimmed, which also broke leading indentation in the web UI's whole-file view).

**Built (6.1, stage 2), 2026-11-06:**
- **The operator as reviewer** (daemon: `POST /api/cards/:id/review`, `humanVerdict` in the refinery; web UI: the card panel's "Your review"; VS Code: Approve and Request Changes).
  - **Approve** records a verdict on the card (`pipeline.humanReview`) and sends it to the queue, skipping the agent review. **Request changes** sends the notes, plus any line comments (`- path:line-endLine: text`), to the author as a message, drops the old verdict and counts a requested change (it lowers the author's outcome score, as an agent reviewer's would). The author's idle session wakes, or the card runs again; its new head is reviewed afresh.
  - **Settings → Tools → Hold cards in Review for me** (`humanReview`, off by default) makes a card wait in Review for a verdict ("waiting for your review" in its log). A verdict given while it is off still counts.
  - Refused while a best-of-N card is still racing, and for non-worker cards.
- **Comments on the diff** (VS Code Comments API on the "after" side of a card's diff; `POST /api/cards/:id/comments`). While the card is being worked, a comment goes to its agent at once. Once it is in Review, comments are collected into your review and go with **Request Changes**.
- **Land now** (`POST /api/cards/:id/land`): approves and moves the card to the front of the queue. It still waits for the cards it depends on to land and still runs the tests.
- **Try it locally** (`POST /api/cards/:id/try`): `checkout` detaches the main checkout at the card's branch head (the branch itself is checked out in the card's worktree and can't be checked out twice); `apply` applies the card's diff to the working tree with `git apply`. Both refuse a checkout with uncommitted tracked changes. Not offered on direct boards.
- **Chat view** (VS Code webview, `GET /api/cards/:id/chat`). One conversation per goal over its whole card tree, in time order: agents' messages, status changes, board notices naming a card of the goal, your messages, and cards' questions to you (`post_message to="human"`) with an inline reply box (answered once you wrote to that card). A target menu sends your message to the goal's planner or to any card in the goal. A message to a card with no live session waits until the card next runs.
- **IDE bridge** (`apps/daemon/src/ide.ts`, `apps/vscode/src/ide.ts`). A window bound to a board connects to `/ws/ide?board=`; the daemon sends it the agents' requests and the newest window answers. While one is attached, agents get:
  - `ide_ask(question, options?, timeout_seconds?)`: a quick pick (with options) or an input box. No answer (dismissed, closed, timed out) becomes a message to the humans and `answered: false`.
  - `ide_diagnostics(paths)`: errors and warnings the language server has for files in the card's worktree. Paths outside the worktree are refused. The window opens each file and waits up to 1.5 s for diagnostics to settle. A worktree lies outside the open workspace folder, so a language server may not analyse it; on direct boards the files are the workspace's own and this works as expected.
  - `ide_show_diff(path, proposed, title?)`: opens a diff of the file against the proposed text (nothing is written); falls back to a message when no window can show it.
  - The tools are listed per request, so they disappear when the last window detaches. `infinityHarness.ideBridge` turns it off per window.
- **Approvals in Needs you**, with inline Approve and Deny, a pop-up with a Decide button, and the badge (see 6.4). A blocked card whose escalation is already listed is not listed twice.
- **Pools and usage** in the status bar tooltip: each pool's state and fullest window, the last 24 hours' tokens and cost, and any budget that warns or has run out.
- **Distribution:** a generated PNG icon (`apps/vscode/scripts/make-icon.mjs`, committed as `media/icon.png`), repository, homepage and bugs fields, `.vscodeignore`, and a GitHub Actions workflow (`.github/workflows/vsix.yml`) that typechecks, runs the extension tests, packages the `.vsix` and attaches it to the run; a `vscode-v*` tag also publishes to the Visual Studio Marketplace and Open VSX when `VSCE_PAT` / `OVSX_PAT` are set (skipped without them). The publisher id is still the placeholder `infinity-harness` and the license field `UNLICENSED`; both need the real values before a public listing.

**Not verified live (6.1, stage 2):** the extension ran against a live daemon with a stand-in `vscode` API (every command, view, the review flow, approvals, the IDE bridge over a real WebSocket), not inside a VS Code window. The webview's HTML and the Comments API gutter are therefore unexercised, as is the language server's behaviour for worktree files. The workflow file was not run on GitHub.

**Not built (from the original 6.1 list):** agent presets and the test button, which belong to the unbuilt part of 5.6 (they appear in VS Code through the web UI once they exist there). A Marketplace/Open VSX listing needs the project to be public.

**Exit (6.1):** from a fresh VS Code window on a repository, a user creates the board, plans a goal from a selection, watches the cards, reviews a change in the diff editor, answers an agent, and sees the landed change in their checkout, without opening the browser.

#### Phase 6.2: Agent tool access
_Status 2026-11-05: **built**, after the operator's report that an agent "couldn't test" on 2026-11-04. Automated: 9 new tests, including last night's refused commands replayed through the policy._

**What happened (AnyMouse-Vectoring board, read from the event log):**

| Agent | Refused | Cause |
|---|---|---|
| Kimi (Teensy vendor-HID card) | `~/.platformio/penv/bin/pio run`, twice | Our path policy refused every path outside the worktree, toolchains included. Kimi read the refusal as a human "no", skipped the build and reported "compile/link verification remains unrun". |
| Codex (same card, retry) | PlatformIO's lock file, then `git merge` | Codex's own sandbox (ACP mode `agent`: workspace-write, network off) makes everything but the cwd and `/tmp` read-only. That includes `~/.platformio` and the worktree's git metadata, which lives in the main repo's `.git/worktrees/…`. Codex worked around it by copying the toolchain to `/tmp`. |
| NIM (pytest card) | `/tmp/opencode/pytest-venv`, `/tmp/opencode/venv-calc`, `~/.local/bin` | Scratch venvs and user-installed tools: the same policy. |
| Claude (orchestrator) | Read of `~/.claude/projects/…/tool-results/*.txt` | Claude Code saves large tool output there and reads it back. That's its own state, not the user's. |
| agy (orchestrators) | `ls …/agy-home/.gemini/antigravity-acp/brain/<id>/mcp/board` | agy lists the board MCP's tool files there to discover the tools. |
| agy (shell) | — | Its isolated `HOME` hid `~/.cargo`, `~/.platformio`, nvm, pip's user site and git config from every command it ran. |

**Built:**
- **Shared roots** (`packages/adapters/src/environment.ts`). Besides its worktree, an agent's tools may use:
  - scratch space: `/tmp`, `/var/tmp`, `$TMPDIR`;
  - toolchains and caches in the home, when they exist: `~/.local/{bin,lib,…}`, `~/.cache`, `~/.npm`, `~/.cargo`, `~/.rustup`, `~/.pyenv`, `~/.nvm`, `~/.platformio`, `~/.arduino15`, `~/.espressif`, `~/go`, `~/.gradle`, `~/.m2`, and more;
  - every directory on `PATH`;
  - extra **Tool paths** from settings;
  - the repo's git dirs (always, so commits and merges work);
  - each harness's own state: Claude's session folder (from the hook's `transcript_path`) and agy's `brain/`.
- **Bounds that stay:** a root is never `/` or the home folder itself. Under a root that contains the worktree (state dir in `/tmp`), the folder holding it stays refused, so sibling worktrees and the main checkout do too. Other projects, the main checkout and the rest of the home folder (`~/.ssh`, `~/Desktop`, …) are refused as before.
- **Codex:** the shared roots go to `session/new` as ACP `additionalDirectories`, which codex-acp turns into writable roots for its sandbox.
- **agy:** the isolated `HOME` links the toolchain folders and git config from the real home. It still leaves out `~/.gemini/config` (the IDE's MCP servers, §5.12) and everything private.
- **Prompts:**
  - Workers are told they have a shell, the board's test command, where they may work, and that a refusal is the board's automatic policy, not a human. They're told to try an equivalent, then `post_message to="human"` and say what they couldn't run.
  - Orchestrators put verification commands in acceptance criteria.
  - The resume prompt after a refusal says the same.
- **Humans hear about refusals.** One "Needs you" message per work cycle lists the refused paths and where to allow them.
- **Settings → Guardrails → Agent tool access:** **Share toolchains and scratch space** (default on; off means worktree and git dir only) and **More tool paths** (one per line, absolute or `~/`).

**Open:**
- **Codex shell commands have no network; Codex research does.** Measured live on 2026-11-05 through codex-acp 2.5.0:
  - `curl https://example.com` from Codex's shell → `Could not resolve host`.
  - Its **web search tool** worked in the same turn. It runs on OpenAI's side, outside the sandbox.
  - So Codex can research. It can't `pip`/`npm install`, `git fetch`, download SDKs or run tests that call a network service.
  - **Why:** the bridge sends `networkAccess: false` with every turn in its workspace-write modes, overriding config. `CODEX_CONFIG={"sandbox_workspace_write":{"network_access":true}}` was tried and had no effect. Codex's own auto-review may grant network per command; those grants never reach our policy.
  - **The alternative:** mode `agent-full-access` opens the network, but it asks for nothing, so our worktree policy would see none of Codex's commands.
  - **Done:** board sessions get `web_search: "live"` (Codex's default is a cached index); a user's own `CODEX_CONFIG` wins.
  - **Done 2026-11-06:** a routing rule `needsNetwork` (`RoutingRules`). The orchestrator sets it with `needs_network` on `create_subtask` (merged with the rules the card would inherit, since a card with its own rules doesn't inherit its parent's); routing then skips agents whose pool harness is `codex`, with the reason "its shell has no network" in the card's Routing section. It is set by the orchestrator only: Kev doesn't classify it yet.
  - **Still open:**
    - pre-install dependencies before such cards;
    - a per-board "Codex full access" switch for trusted repos once the Docker executor contains it;
    - ask the bridge's maintainers for a network option.
- **Shell checks are lexical.** `$HOME/…`, variables and paths inside scripts aren't seen. The real boundary is the container executor (§5.9, Later).
- **ACP `terminal` capability is off.** Harnesses run commands themselves. Offering it would let the daemon run, stream and confine every command, but at the cost of each harness's own sandbox. Revisit with the Docker executor.
- **Hardware.** Flashing a board or using a USB device needs the device and often a human. Cards should name "hardware verification by a human" in their criteria rather than block on it.

#### Phase 6.3: Metrics and budgets
_Status 2026-11-06: **built.** Automated: `apps/daemon/test/metrics.test.ts` (10 tests). Verified live: Claude Code 2.1.318 exporting to the receiver._

**Usage records.** `usage_events` gained `board_id`, `card_id`, `agent_id`, `model`, `cache_tokens` and `cost_usd` (migration 9). Sources:
- **Claude Code → OTLP receiver** (`apps/daemon/src/telemetry.ts`: `POST /v1/metrics`, JSON). The Claude adapter sets, per session, `CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_METRICS_EXPORTER=otlp`, `OTEL_EXPORTER_OTLP_PROTOCOL=http/json`, the endpoint (the daemon), delta temporality, a 15 s export interval and `OTEL_RESOURCE_ATTRIBUTES=mh.session=<id>,mh.card=<id>`. The receiver maps `claude_code.token.usage` (by `type`: `input`, `output`, `cacheRead`, `cacheCreation`) and `claude_code.cost.usage` to records on the card of the session named, with the model Claude reports. Unknown sessions are dropped; cumulative series become increments. A live probe with a one-line `claude -p` call confirmed the metric names, the attribute names, the JSON encoding and that the resource attribute arrives; the payload also carries the account's email and ids, which are ignored and never stored. `/v1/logs` and `/v1/traces` are accepted and dropped.
- **ACP harnesses:** a `session/prompt` result's `usage` block (camelCase, snake_case or `_meta.usage`; cache fields read too) is recorded through `SessionOptions.onUsage`. Whether a given harness sends it was not checked live.
- **API pools:** the gateway counts every request. It names no card, so usage is credited to the one session working on the pool when there is exactly one (`Runner.soleSession`); otherwise it stays on the pool with no card.
- Cost is only what a harness reports (Claude). There is no price table for the others.

**Metrics** (`GET /api/boards/:id/metrics?hours=`, `apps/daemon/src/metrics.ts`): totals, tokens over time (hourly, daily above 72 h), usage by agent, model and pool, usage by card with each card's **subtree** total (rolled up through its ancestors), usage on no card, and the board's budgets. The web UI's **Metrics** view renders it (range picker, stat tiles, bars, budget gauges, tables, the card tree); the VS Code status bar tooltip shows the headline.

**Budgets** (`apps/daemon/src/budgets.ts`, Settings → Budgets). `Settings.budgets = { board, agents }`, each `{ limit, unit: tokens | usd, period: day | week | total }` (day and week roll).
- Each budget is a scope in the **same `RateLimiter`** as the pools (`budget:<board>:<scope>`, window kind `budget`), re-evaluated on every usage record, on settings changes and every minute. So `warn` is at 80% and `halted` at 95% by the limiter's own rules.
- **Agent budget:** `PoolView.budget` → `rankPools`: halted agents are ineligible ("budget used up (97%)"), warning ones score ×0.5 headroom. Orchestrator selection and councils skip halted agents.
- **Board budget:** the scheduler starts no card on a halted board, and `startGoal` refuses ("this board's budget is used up").
- Turns already running finish; nothing is killed or parked. Crossing 80% and 95% each posts one message to the humans.
- Dollars count only where cost is reported; tokens are input plus output, with cache tokens apart.

**Pool usage history** (`apps/daemon/src/history.ts`, `GET /api/pools/:id/history?hours=`). Each pool's state, windows and running sessions are sampled every minute and stored when something changed (or every 5 minutes), for a week (`pool_samples`). The response has the samples, the stretches the pool was halted or locked, and requests, tokens and 429s per hour from `usage_events`. The Pools view charts the last 24 hours per pool.

**Not verified live (6.3):** that Kimi, agy, Codex and OpenCode send a usage block; the Metrics view against real data beyond seeded demo data; Claude telemetry from an interactive (TUI) session, as opposed to the `-p` probe (the same variables apply).

#### Phase 6.4: Governance
_Status 2026-11-06: **built.** Automated: `apps/daemon/test/governance.test.ts` (10 tests) and the fast-lane and extension tests._

**Approval queue** (`apps/daemon/src/approvals.ts`, table `approvals`, events `approval.created` / `approval.decided`). `Approval = { kind, cardId, summary, payload, status, requestedBy, decidedBy, note }`. API: `GET /api/boards/:id/approvals?status=`, `POST /api/approvals/:id/decide { decision: approve | deny, note }`. Web UI: the status strip's **Approvals** panel; VS Code: Needs you (inline Approve and Deny, pop-up). A decision is final; applying an approval that can't be applied (an invalid agent profile) leaves it pending and returns the error. Asking again for the same pending thing returns the pending request. The asking agent gets a message with the decision.

| Kind | Created by | Approving applies |
|---|---|---|
| `escalation` | `escalate_to_human`; the refinery when it gives up on a card (the usual messages are still sent) | The card moves to Ready with its escalation flag and retry counters reset; the human's note reaches the agent first. Denying leaves it blocked. |
| `spawn_agent` | `spawn_agent(id, pool, model?, reasoning?, role?, reason)`; needs `canSpawnAgents` (off for every role by default) | The profile is added to `Settings.agents`, validated with the implicit workers (delegation cycles, unknown pool). `autoApproveSpawn` approves at once, still leaving a record. |
| `install_mcp` | `propose_mcp(name, command? \| url?, args?, env?, reason)`; needs `canInstallMcp` (off by default); always waits; `board` and `grant-*` are reserved | Added to `Settings.mcpServers`; every **new** session gets it (stdio or Streamable HTTP). |
| `install_skill` | `propose_skill(name, description, body)`; same permission; always waits | Added to `Settings.skills`; worker prompts carry it (4000 characters each at most). |
| `grant` | `request_grant(grant, reason)`, or `grants` on `create_subtask`; needs `canRequestGrants` (on by default) | The grant name is added to the card's `grants`. |

**Fast lane #8** (`notificationJob`, `readNotification`): a one- or two-sentence plain-language notification for each request (what is asked, by whom, what approving does). Falls back to the plain summary when the fast lane is unavailable or `notificationText` is off.

**Agent-facing docs** (`docs/agents/`: `overview`, `board-tools`, `conventions`, `tool-access`, `extending`). The board MCP's `get_docs(topic?)` serves them, and worker prompts point to it. They cover the board tools, shared-board conventions, what an agent's shell may touch (6.2), and how to ask for an agent, MCP server, skill or tool grant.

**Not verified live (6.4):** an MCP server approved here being used by a real harness session (the daemon passes it in `session/new` and the Claude `--mcp-config` file, as it does the board server; the tests check the servers handed over and the prompt, with fake agents).

#### Phase 6.5: Deeper verification
_Status 2026-11-06: **built**; the browser server itself is **not verified live**. Automated: `governance.test.ts` (grants) and `bestof.test.ts` (3 tests)._

**Tool grants** (`apps/daemon/src/tools.ts`). `Settings.grants` maps a name to `{ label, description, command, args, env, mode: off | approval | auto }`; `Card.grants` lists the ones a card holds (migration 9, `nodes.grants_json`; editable with `PATCH /api/cards/:id { grants }`). At session start each active grant (it exists, isn't `off`, has a command) becomes an MCP server named `grant-<name>`, with `{card}` and `{worktree}` filled in, next to the board server and the board's approved MCP servers. The worker's prompt lists them and says to verify like a person would and keep produced files out of the worktree.
- Defaults (changed 2026-11-06 from Playwright MCP to Vercel's tools, which are CLIs with a stdio MCP mode):
  - **`browser`** = [agent-browser](https://github.com/vercel-labs/agent-browser), `agent-browser mcp`, mode `approval`. Env per card: `AGENT_BROWSER_SESSION=mh-{card}` (one daemon and browser per session), `AGENT_BROWSER_SCREENSHOT_DIR` and `AGENT_BROWSER_DOWNLOAD_PATH` under `/tmp/mh-browser/{card}`, `AGENT_BROWSER_IDLE_TIMEOUT_MS=300000` (its default is an hour). Headless is its default. Install: `npm install -g agent-browser && agent-browser install`.
  - **`computer`** = [agent-desktop](https://github.com/vercel-labs/agent-desktop), `agent-desktop mcp`, mode `off`. It drives the real desktop through the OS accessibility tree (macOS 13+, Windows 10 1809+, Ubuntu 24.04+ with AT-SPI), so it is opt-in. Install: `npm install -g agent-desktop`.
  - Each grant has a `usage` line for the prompt (both tools publish a version-matched guide: `agent-browser skills get core`; `agent-desktop skills get desktop` and `skills get platform`, also the `desktop_skills_get` MCP tool) and an `install` line (`npm install -g --allow-scripts=<pkg> <pkg>`, plus `agent-browser install` for Chrome; npm blocks install scripts by default).
  - **Install on request (2026-11-06).** `Approvals.installGate` runs in the scheduler for every ready worker card that holds grants. The first time it meets a grant whose command isn't on the machine and that has an `install` command, it creates an `install_tool` approval (once per board and grant; the summary names the exact command) and holds the card; a pending approval or a running install keeps holding it. Approving runs the **grant's own `install` text** from the board's settings through `sh -c` (`apps/daemon/src/installer.ts`, 15-minute limit, last 4000 characters of output kept) and posts the outcome to the humans; the payload only names the grant, so no agent can supply a command. Denied or failed, the card goes on without the tool: the runner leaves the missing grant out of the session and prompt and posts a message. `create_subtask` tells the orchestrator when a requested tool isn't installed yet. `GET /api/boards/:id/tools` and `POST /api/boards/:id/tools/:grant/install` back Settings → Tools (installed badge, Install button; the click is the approval). Asked-for installs run with the daemon's own permissions, which is why they wait for a human. `.playwright-mcp/` and `.agent-browser/` are never committed.
  - A board whose saved settings still hold the Playwright grant is migrated to agent-browser on load (its mode is kept).
- Giving a grant: `create_subtask` with `grants` (auto ones are given, approval ones queue an approval and the scheduler **does not start the card** until it is decided), or `request_grant` for the agent's own card (takes effect the next time the card runs), or by hand through the API. Unknown, `off` or command-less grants are refused with the list of what is available.
- Grants run a process on the operator's machine with their permissions, outside the path policy (an MCP tool call names no paths). That is why `browser` defaults to approval.

**Best-of-N** (`apps/daemon/src/bestof.ts`, §5.4 step 9). Settings → Tools: `bestOfN = { enabled: false, n: 2, minComplexity: 2 }`.
- **Start.** The scheduler offers each ready, classified, never-run worker card on a worktree board to `BestOf.intercept` before routing it. It applies when enabled, the card's complexity reaches `minComplexity`, and at least two different agents are eligible. The card becomes candidate 1 (`pipeline.bestOf = { group, candidate, of, state: running }`) and n−1 clones (titled "… (candidate k)", same parent, spec, routing, grants, classification and dependencies) are created. Each is routed normally; routing prefers a different agent for each sibling (the siblings' agents count as "failed" at ×0.2, a soft rule).
- **Judge.** When every running candidate has stopped (Review, blocked or done), Kev scores each finished candidate's diff against the card (`scoreOutcome`; scaled by 0.7 when out of scope). Without Kev, or if it fails, the smaller diff wins. The highest score wins.
- **Settle.** The winner's state becomes `won` and it continues through review and landing as usual. Losers become `lost`: session closed, worktree and branch deleted, `branch` and `worktree` cleared so nothing downstream can merge them, status Done, and an outcome recorded for their agent with their score (note "lost a best-of-N"). Candidates that never reached Review are out too. Cards that waited for the original are moved to wait for the winner (`moveDependents`). While racing, a candidate isn't a "finished" blocker, can't be reviewed or landed by hand, and the refinery skips it. If every candidate is blocked, a human takes over.
- Not used on direct boards. It costs n times the tokens: off by default.

**Verified by hand (6.5), 2026-11-06, on the operator's machine (CachyOS):** both packages install with the commands above (after the npm script block was lifted for just those packages); `agent-browser install` fetched Chrome 157; `agent-browser mcp` listed its tools (`agent_browser_*`), opened a page, snapshotted it and saved a screenshot into `AGENT_BROWSER_SCREENSHOT_DIR`; `agent-desktop mcp` answered `tools/list` (`desktop_*`), and `agent-desktop status` reported the accessibility permission granted. **Not verified:** an agent session actually calling those tools through a harness; agent-desktop driving real apps (it lists Ubuntu 24.04+ as its Linux target; CachyOS is untested); the Chrome `--with-deps` step on systems that need it. Best-of-N with real agents (tested with two fake agents whose changes Kev stands-in scores).

#### Phase 6.6: TUI and Remote Session Linking
- Review the underlying technology being used by herdr; Its a project that is similar to ours; we can use it for the tui implementation / ideas / remote session linking. How it does worktrees with multiple agents working compared to ours. Implementing a skill file like how herdr does so the agents have better understanding of how Infinity Harness works. https://github.com/herdrdev/herdr

_Status 2026-11-06: **built**, all eight steps, in the order below. Findings, a worktree comparison and the reasoning are in [research-herdr.md](research-herdr.md); the clone is in `research/herdr` (git-ignored). Nothing here has run a day of real unattended work yet; the Phase 6 exit is still the natural first use. What each step did not verify is stated under it._

Build order (decided 2026-11-06, done in this order):
1. **Remote prerequisites. Built.** `apps/daemon/src/auth.ts`: an API token (`.meta-harness/api-token`, 0600; `MH_API_TOKEN`, `MH_REQUIRE_TOKEN`, `MH_ALLOWED_HOSTS`), required from non-loopback peers or from everyone on request, plus Host and Origin checks that stop other websites (DNS rebinding, cross-site WebSockets) from driving a local daemon. A wrong token is always refused. Agent endpoints (`/mcp`, telemetry, Claude's hook) stay open to local processes. `/ws?since=<seq>|now` replays missed events with a `stream.status` `{ latest, replayed, lost }` answer; the store now delivers events in sequence order even when a listener appends one (it did not before). Web UI (`token.ts`: `#token=`, one prompt on 401) and the VS Code extension (`infinityHarness.apiToken`, replay on reconnect within 10 minutes) use both. Tests: `apps/daemon/test/auth.test.ts` (access rules, real HTTP and WebSocket, replay, order), an extension client test. Checked on the real daemon process: token file mode 600, no token 401, token 200, forged Host 403. **Not covered:** an agent can still call the REST API without a token from this machine (unless `MH_REQUIRE_TOKEN=1`, which does not apply to agent endpoints); the token file sits outside the agents' worktrees but only the tool-access policy keeps a shell from reading it.
2. **`packages/client` (`@mh/client`). Built.** `DaemonHttp` (token, per-call timeouts, `onUnauthorized` retry), `DaemonApi` (every endpoint the web UI and the extension used, one typed method each; arrow properties), `EventStream` (replay-aware, `onResync` when continuity is lost or the drop outlasted 10 minutes), `loadNeeds` ("needs you" in one place). The web UI (`api.ts`, `useEventStream.ts`, terminal) and the VS Code extension (`client.ts` is now a 10-line subclass) run on it, which also fixes the web UI losing state across a reconnect (it now replays, and reloads when it cannot). Tests: `packages/client/test`.
3. **Remote linking over SSH, not our own network layer. Built** (`@mh/client/node`: `MachineCatalog`, `MachineConnection`, `Fleet`). Profiles (id, label, SSH target, ssh and daemon ports, optional remote folder; no secrets; validated so a target can never be read as an ssh option) in `~/.config/infinity-harness/machines.json` (0600). One `ssh -N -L` forward per machine on a free local port, `BatchMode` (never prompts), dead-peer options, a health check every 15 s (two misses rebuild it, because a dead forward keeps its local port open), retry delay 1 s doubling to 2 min and reset only after a connection stayed healthy for a minute. A refused login or unknown host key is `attention` (not retried until `retry()`), a daemon that is not running there is reported in words and retried quietly, a daemon that requires its token has it read over SSH from `<remote folder>/.meta-harness/api-token`. Ids are scoped `machine:id`. Nothing is installed or started on the other machine. **Checked by hand 2026-11-06 against a real `sshd` on a high port as a normal user** (host key refused → attention, trusted → online with a real `ssh -L`, the ssh process killed → back on a new port, stop). Tests use a stand-in for `ssh -L` (`packages/client/test/fake-ssh.ts`). **Not done:** a machine switcher in the web UI and VS Code (use `ih machine forward` and set the daemon URL), the TUI's dimmed cached state (step 6), ControlMaster reuse, Windows.
4. **`ih` CLI. Built** (`apps/cli`). Commands: status, boards, cards, card, plan, add, needs, approvals, approve, deny, message, review, land, move, cancel, changes, diff, events, pools, metrics, watch, terminal, machine (list, add, remove, rename, enable, disable, status, forward). JSON when piped, tables at a terminal; id prefixes; `--machine` or `machine:id`; board by flag, only board, or current folder; exit codes 0/1/2. Tests: `apps/cli/test` (in-process against a real daemon; machines through the ssh stand-in) and `packages/client/test/terminal.test.ts`. **Not done:** board creation, settings, agents and grants (web UI / VS Code only for now), shell completions.
5. **Worktree setup command and worktree root. Built** (`apps/daemon/src/setup.ts`, `git.ts`). Settings → Refinery: `worktreeSetup` and `worktreeSetupTimeoutSec` (900). Runs in the new worktree before the agent starts, with `MH_REPO_PATH`, `MH_WORKTREE`, `MH_BRANCH`, `MH_BOARD` added to the agent-safe environment (provider keys removed); at most two at once; a "done for this command" marker lives in the worktree's own git directory (never committed), so it runs again when the text changes and a failed setup is retried on the next run. Logged as a `card.setup` event (shown on the card); on failure the first prompt carries the end of the output and the humans get a `daemon:setup` message, but the card still runs. `MH_WORKTREES_DIR` moves the checkouts. `ensureWorktree` now tells a real worktree from a folder in its way (moves the folder aside as `.leftover-<time>`) and prunes a stale registration; git's "dubious ownership" is explained, not trusted for the person. `POST /api/cards/:id/worktree/remove` (`ih worktree remove`) refuses uncommitted changes unless `force`, keeps the branch. Tests: `apps/daemon/test/worktree.test.ts`. **Not done:** hard-linked or cached installs across worktrees (use `--prefer-offline` or a shared store such as pnpm's), a button for removal in the web UI, setup for the read-only review and landing scratch worktrees (they need no dependencies). **Known gap:** the setup command is a setting any caller of the REST API on this machine can change, as every other setting is (see step 1's note about agents and the REST API).
6. **`apps/tui`. Built** (`ih tui`). Needs you, Board, Pools; card dialog with message, move, stop, terminal attach, approve, request changes, land; machine and board switchers; dimmed read-only cached state when the machine drops; per-device seen markers; install approvals ask twice. **Mouse-first (requirement, met):** the TUI turns on terminal mouse reporting (xterm 1000/1002 and SGR 1006), parses the reports itself, and every action is a visible clickable control with its key printed on it, so people who don't know vim or tmux keys can use it, over SSH and on a phone. Mouse reporting is switched off on exit, on Ctrl+C, on SIGTERM/SIGHUP and when attaching an agent session; `IH_TUI_MOUSE=0` / `--no-mouse` leaves it off.
   - **Decision: no Ink.** Ink gives no screen coordinates for the boxes it draws, which clicks need; its JSX would not run under Node's type-stripping without adding a build step; and a small renderer (`canvas.ts`: cells plus click regions registered while drawing, so what is drawn and what a click lands on cannot disagree) is a few hundred lines and testable by feeding it bytes. No dependencies were added. If a richer layout is wanted later, Ink could replace `views.ts` only.
   - **Terminal attach** is a hand-over, not an emulator: the TUI leaves its screen, pipes the real terminal to `/ws/terminal/:id`, and comes back on Ctrl+] (`@mh/client/node` `attachTerminal`, also behind `ih terminal`).
   - Tests: `apps/tui/test/tui.test.ts` (input parser, canvas, real-terminal escape sequences, and the app driven by keys and clicks against a real daemon: approve, deny with a note, answer, confirm installs, human review through to landing, board folding and card actions, pools, per-device seen, keys-only mode, switching to another machine and losing it). **Checked by hand 2026-11-06** in a real pseudo-terminal against a real daemon: alternate screen and mouse reporting on, clicks and keys work, quit restores everything with exit 0, and `SIGTERM` restores the terminal too. **Not done:** card creation and planning from the TUI (`ih plan` / the web UI), settings, a terminal-bell alternative (OSC 9/777 notifications), Windows terminals, resize-aware reflow of an open dialog beyond redrawing, right-click menus, and testing in terminals other than xterm-compatible ones.
7. **`skills/infinity-harness/SKILL.md` and `ih skill`. Built.** Gated like herdr's (the description says when not to use it; an agent holding the `board` MCP tools is sent to those; `ih status` must answer first, and it never starts the daemon or goes looking for the token), concepts in a paragraph, `ih help` as the syntax authority, a list of the decisions that stay with the person (approve, deny, review, land, move, cancel, worktree remove/--force, machine add/remove/forward, answering an agent's question), and working rules (read state before repeating anything; `ih watch` needs `--count`; planning can take a minute, so check `ih cards` before planning again). `ih skill show|path|status|install` (`--target claude|agents`, `--dir PARENT`, `--force`; never overwrites a differing file silently). A test fails if the skill names a command or flag that does not exist. **Not verified:** that Claude Code, Codex and others actually load the skill from those folders and follow it (the paths are the documented conventions for Claude and the `.agents` convention herdr uses; I could not run another tool's loader here), and agent behaviour with it. **Not done:** publishing it for `npx skills add`, a separate skill for card agents (they already have `get_docs`).
8. **Restart audit and resume. Built.** **Audit finding:** nothing recovered anything. After a stop or crash, sessions stayed marked running, cards stayed In Progress with no process, the scheduler counted them against the board's worker slots (and on a direct board they blocked every other worker), and nothing would ever pick them up. **Fix** (`Runner.recoverInterrupted`, called in `main.ts` before the scheduler starts): open sessions with no live process are marked failed with a `session.interrupted` event; in-progress workers go to Ready (worktree and branch kept; not counted as a retry); in-progress orchestrators and leads are Blocked for a human; cards waiting in Review or Merging are untouched (the refinery already redoes those); one `daemon:recovery` message tells the humans; a card being worked right now is left alone. A graceful `shutdown()` now records the sessions it cuts off (`daemon_shutdown`) instead of marking them ended. **Resume** (`SessionOptions.resume`, `AgentSession.resumed`): when a recovered card runs again on the same pool, ACP agents that advertise `loadSession` get `session/load` (the history replay is dropped because the session is registered only after the load) and Claude gets `--resume <id>`; the agent is sent a short "the daemon restarted, check git status and carry on" prompt instead of the task. If the harness cannot, or the load fails, the adapter says so in the card log and starts fresh, with the existing "earlier session stopped" note. Tests: `apps/daemon/test/recovery.test.ts` (seeded crash states, a live card left alone, graceful restart then resume with the fake agent extended with `session/load`, load refused, no `loadSession`, a different pool, and the Claude argument list). **Checked by hand** on a real daemon: a card left In Progress, SIGTERM, start again: logged `recovered after restart`, card Ready, one message, no session started. **Not verified:** resume against real Claude Code, Codex, Kimi or agy (the fake agent models the ACP handshake; whether a given real agent honours `session/load` after its own process restarted, keeps its model setting, or keeps tool permissions is unknown, and Claude `--resume` after a worktree change is untested), cards interrupted while in Review by a reviewer agent (the refinery reviews them again from scratch), and best-of-N candidates (they simply return to Ready like any worker).

Not planned: a generic screen-scraping adapter for agents without ACP or hooks, a plugin system, an embedded terminal emulator.

**Exit (Phase 6):** a full day of unattended work, driven from VS Code, with quota respected, no agent skipping a build or test for lack of access, and a readable audit trail.

_Where that stands (2026-11-06): every piece the exit names now exists (VS Code driving, quota windows and budgets, tool access, the event log plus approvals and metrics as the audit trail). The exit itself, a real day-long unattended run on real agents, has not been tried; it is the natural first use once 6.6 is done. Everything automated here runs on fake agents._

### Phase 7: Swarm federation (F1 to F4 built 2026-11-07)

_The north star behind 6.6's saved machines: harnesses cooperating. Several swarms (a harness with its boards and agents) work on parts of a larger goal, and one can call on another. Example: swarm A is building an app on a framework swarm B made; A hits a critical bug in the framework; A's agent files a request with B's orchestrator; B fixes and lands it; A's blocked card resumes. Written down 2026-11-06 from the operator's description; nothing below is built or agreed._

_Status 2026-11-07: **F1 (identity, knock, directory), F2 (requests), F3 (agents ask peers, cards wait and resume, auto-accept) and F4 (budgets, milestones, acceptance, loop guards) are built**, with the operator surface in the web UI, `ih`, the TUI and VS Code (a few settings are web and `ih` only, see below). What was decided while building, and what is and is not verified, follows. The text after it is the original plan; where it differs, this block wins._

**Decided while building (2026-11-07, with the operator)**
- **A separate federation port.** An SSH forward to the daemon port reaches the whole loopback API, operator routes included, so a peer's SSH access would have been far wider than "federation". The daemon runs a second loopback listener (`MH_FED_PORT`, default **7422**; `off` disables it) that serves only `/fed/*`. Peers forward to that port, and an sshd account can be limited to it with `PermitOpen`. The main port does not serve `/fed` (tested both ways). Nothing the plan needs is lost: federation is daemon to daemon, and an agent only ever reaches a peer through its own daemon. A second instance on one machine needs its own `MH_FED_PORT`.
- **Project cards are drafted by the fast lane by default, by the orchestrator on request** (`ih swarm --drafter`, or the Swarms view). The fast lane path reads the README and manifests (package.json, pyproject.toml, Cargo.toml, go.mod), takes *provides*, *uses*, stack, version and last commit from them without a model, and only words the one-liner and the paragraph. The orchestrator path runs the orchestrator agent on a one-off prompt (`Scheduler.startTask`) and it saves the card with the board tool `propose_project_card`. Either way the result is a draft the operator edits and publishes; "takes requests" is never on by default and the agent tool cannot change it.
- **All clients in the same pass:** daemon, `@mh/client`, `ih`, web UI, TUI, VS Code. The peer pieces appear in each client's existing "Needs you".
- **Identity.** The swarm id and the fingerprint are derived from the ed25519 public key (`sw_` + 16 hex of its hash; 32 hex characters in groups of four), so a claimed id cannot disagree with its key. The key lives in `swarm-key.json` (mode 0600) next to the database, so `MH_STATE_DIR` gives a second instance its own identity.
- **Signatures.** Every request is signed over method, path and query, timestamp (5-minute window), nonce, intended recipient and a hash of the body; nonces are kept in the database, so a restart does not reopen replays. Every answer except the silent `pending` is signed over the request's nonce, so a caller knows who answered. The only unsigned reply is the knock's `pending`, which carries nothing about the receiver.
- **Project id = the board id.** Requests name a project by it; a peer sees only projects published to it.
- **Peer address** is an SSH target (our own `MachineConnection`, with a new `healthPath` so the forward is checked on `/fed/health`) or a plain URL, which must be `http` on this machine: it is the address of the operator's own tunnel, never another host.
- **A swarm known two ways** (we added it; it also knocked) becomes one record when the first signed answer pins its key. `expectedFingerprint` (typed by the operator) makes a different key refused, and the peer is paused with the reason.
- **Request states:** `pending` (waiting for the receiving operator) → `in_progress` (approved; a goal exists) → `landed` (all of the goal's cards done, with the PR or the default branch's commit; or marked by hand) → `done` (the sender confirms). Also `needs_info`, `declined`, `cannot_reproduce`, `cancelled`. A question parks the request; the sender's answer returns it to `pending` if it was never approved. `accepted` exists in the type but nothing sets it yet.
- **Delivery** is by id: the sender's request id is the idempotency key, so a retry after a lost answer creates nothing new. A request the receiver refused for good (no such project, a project that takes none, a loop) comes back as `declined` with the reason; one refused for now (rate limit) stays queued on the sender.
- **From F4, built in F2:** the hop list is checked on receipt (last hop must be the signer, the receiver must not be in it, at most 6), and per-peer limits (20 requests an hour, 10 waiting; knocks: 20 waiting, 30 stranger knocks per ten minutes).
- **Agents' view.** Cached cards reach agents as data through the board tool `find_peer_projects` and a paragraph in the orchestrator's prompt, only for peers the operator accepted. They are not in `search_context` (a separate tool keeps swarm-wide data apart from a board's notes). An approved request's goal text starts with a warning that what follows is untrusted text from another swarm.

**Built (F1 + F2).** Daemon: `apps/daemon/src/federation/` (`identity.ts`, `protocol.ts` cleaning and redaction, `service.ts`, `routes.ts` the listener, `api.ts` the operator routes, `cards.ts` drafting), storage in `packages/db/src/federation.ts` (migration 11: peers, shared projects, cached peer projects, requests, nonces, settings), types in `packages/core/src/federation.ts`. Clients: `DaemonApi` methods and "Needs you" kinds `peer` and `peer_request` in `@mh/client`; `ih swarm | peer | project | request`; the web **Swarms** view; the TUI's Needs-you actions (accepting a swarm asks once, with the fingerprint); VS Code's Needs-you items, `decidePeer`, `decidePeerRequest`, `openSwarms`. The skill file lists the new commands and puts every deciding one among the things an agent may not do. Tests: `apps/daemon/test/federation.test.ts` (signatures and tampering, quarantine, silence, caps and replay, fingerprint pinning, merging, visibility and preview, requests end to end, loops and floods, auto-landing, drafting, an SSH-addressed peer through a stand-in for `ssh -L`), `federation-agent.test.ts` (the board tools and the prompt, with fake agents), `apps/cli/test/federation.test.ts` (two real daemons driven with `ih`), and cases in the TUI and VS Code tests.

**Checked by hand 2026-11-07:** two real daemon processes with separate state (each its own identity file, mode 0600, distinct fingerprints); the poll timer delivered a knock; the other operator saw the fingerprint in `ih needs` and accepted; the project (worded by the real fast lane from a toy README) was found by `ih peer projects`; a request was sent, a question asked and answered, and the request declined with a reason, each side seeing it; the federation port answered `/fed/health` and 404'd `/api/*`.

**Not verified:** a real SSH connection to another machine for a peer (the stand-in `ssh -L` and the same `MachineConnection` code paths 6.6 checked against a real sshd were used, but this phase did not repeat that); a real orchestrator planning an approved request (fake agents only; in the manual run the request was declined, because approving would have started real agents on the machine); the web Swarms view in a browser (it type-checks and builds; nobody has looked at it), the VS Code items in a real window, the TUI in a real terminal; clock skew beyond the 5-minute window between machines; many peers or large directories.

**Not done (F1 and F2):** the peer profile's counted history (requests filed and received, outcomes, typical time to land) and its markdown rendering; matching a project's dependencies to a peer's *provides* automatically, and the reverse view. A swarm's default name is the machine's hostname (the operator can set it; labels stay unique per swarm). The expected fingerprint is compared as a prefix of the 32 hex characters.

**F3 and F4: decided while building (2026-11-07)**
- **Agents ask through `request_peer`** (with `list_peers`, `peer_request_status`; role permission `canRequestPeers`, on by default, and a Settings toggle `peerRequestApproval`, on by default). With approval on, the tool creates an approval of kind `peer_request` holding the exact text the agent wrote and the outbound request row at the same time; the row is **not delivered until the approval is granted** (delivery checks it), and declining withdraws it (`cancelled`) and tells the card. A card may have three open requests, a board five waiting approvals. The request carries the trail of the work behind the card (an inbound request's hops plus this swarm), so asking back where the work came from is refused here, and again by the receiver.
- **A blocking request parks the card.** `pipeline.waitingOn` lists the request ids; at the end of its turn the runner commits, closes the session and leaves the card in Ready; the scheduler's new `hold` hook keeps it there while any request is unresolved. When the peer answers (landed, done, declined, could not reproduce, withdrawn) the federation clears the wait, posts the answer as a message to the card (their words marked as information, not instructions; the acceptance criteria listed) and wakes it; the scheduler starts it again as any ready card. Orchestrators cannot wait (their turn is the plan), so their requests never hold them. Not session resume: the card starts a new session with its notes, as any rerun does.
- **Acceptance is checked by the resumed agent and the humans, not by a model:** the card's prompt carries the criteria; when the card reaches Done the requests it checked (`pipeline.confirms`) are confirmed `done` at the peer. A card that finds the result wanting says so with `report_blocked`. The sender's operator can **send a landed result back** (`reopen`): the receiver's request returns to `pending`, with no goal, and waits for its operator (or restarts by itself for an auto-accepted peer).
- **Auto-accept** is per peer, only for a **trusted** peer, and needs a limit per request **and** a limit per day, each in tokens, dollars or both. A request whose budget exceeds the per-request limit, or arriving once 80% of the day's limit is used, or beyond 10 auto-accepted an hour, waits for a person as before. A request without a budget is given the per-request limit; a smaller budget stands. Each start posts a message from `daemon:federation` to the project's board (which every client already shows: a pop-up in VS Code, an item in Needs you) and a note in the thread; declining it later stops the goal and tells the sender. Taking trust away or blocking turns it off; the check is repeated at receipt, so a flag set by hand on an untrusted peer does nothing.
- **Budgets for requests from peers** (F4): a request's budget (from the sender; the receiving operator can change it) and the peer's per-day limit are compared with the usage of the goal's cards (usage is attributed to cards already). Evaluated on every usage record (debounced), every minute, and when limits change. 80%: a message. 95%: the goal's cards that have not started are held by the scheduler hook; turns already running finish (as for board budgets); a thread note tells the sender. The day's limit holds **all** of that peer's open requests. Raising the budget releases the hold. Dollars count only for harnesses that report a cost (Claude), tokens for all that report usage, so give tokens.
- **Milestones:** the sender lists them; the receiver ticks them (`ih request milestone`, the web view) or the goal's orchestrator reports them with `report_milestone`; the sender sees `milestonesDone` on its next round. Nothing detects them automatically.
- **"Needs you" for the sender:** `FederationNeeds.replies` lists outbound requests with a question to answer (`needs_info`) or a landed result nobody is confirming (not one a waiting card will confirm); clients show them as `peer_reply` items.
- Storage: migration 12 (`auto_accept`, `caps_json` on peers; `approval_id`, `auto`, `milestones_done_json` on requests).

**F3 and F4: built and tested.** `apps/daemon/src/federation/spend.ts` (budget arithmetic), additions in `service.ts`, `routes.ts` (`/fed/requests/:id/reopen`), `api.ts`, the board tools in `board-mcp.ts`, `Scheduler.hold`, the runner's park-on-wait, `Approvals` kind `peer_request`; `ih peer auto-accept`, `ih request reopen|milestone|budget`; the web Swarms view (auto-accept limits, budget and spent, milestone checkboxes, change budget, send back, replies under *Waiting for you*, the approval's full text), the Agents permission column and the Settings toggle; TUI and VS Code items for replies and the approval kind. Tests: `federation-f3.test.ts` (auto-accept rules, budgets and holds, the day's limit across requests, milestones, reopening, replies), `federation-agent.test.ts` (an agent files a blocking request: approval, parked card, sent on approval, landed at the peer, card released with the answer, confirmed done when the card is; declined approval; approval off; permission; unknown project; loop; per-card limit, all with fake agents), `apps/cli/test/federation.test.ts` (auto-accept through `ih`, the sender's smaller budget kept, milestones, budget, send back restarting an auto-accepted request), and cases in the TUI and VS Code tests.

**F3 and F4: not verified.** A real agent (Claude, Codex, Kimi, agy) choosing to call `request_peer` sensibly, writing a request another swarm's agents can act on, and handling the resumed prompt; the park-and-resume path against real harnesses (the fake agent replays whatever a card's text says, so the tests prove the plumbing, not the judgement); the budget numbers against real usage reports (ACP harnesses report tokens only when they publish them, cost only Claude); the web view's new controls in a browser; a real SSH link for these flows.

**F3 and F4: not done.** Auto-accept limits, request budgets, milestones and "send back" are web and `ih` only (the TUI and VS Code answer the sender's questions and confirm or send back results, but do not edit limits). Per-peer spend is not in the Metrics view or Settings → Budgets (it has its own rolling 24-hour window). Turns already running are not stopped by a used-up budget. Kev does not check a landed result against the criteria. Milestones are not detected automatically. A card that waits is not resumed into its old session.

**What crosses between swarms: structured requests and their status, never chat and never code.** Code moves the way it already does (B lands to its repo or registry, A's agent updates its dependency); the request carries the landed commit, PR or version. Free-form agent-to-agent chat was considered and rejected: it cannot be approved, budgeted or audited.

**One kind of request (decided 2026-11-06).** An issue and a delegated sub-goal are both "a task for a peer"; they differ in scope, not in type. A single `request` has a title and a description (a bug report with repro and logs, or a goal with a spec) and optional fields: `project` (which of the peer's projects it is for), `blocking` (the sender's card waits and resumes, the default for a bug report), `acceptance` (criteria the sender checks the result against), `milestones`, and a `budget` cap. Outcomes: `landed` (with sha, PR or version), `declined` (with a reason), `cannot reproduce`, `needs info` (the peer asks a question back), then `done`. The sender may cancel. A small request is the whole of what was called an issue; a large one is what was called a delegated goal.

**Knowing who builds what: the project directory.** A peer can only be asked to fix X if the sender knows the peer owns X. There is no shared database; instead each swarm *publishes* a directory of the projects it is willing to share, and its linked peers *pull and cache* it. No swarm's directory is authoritative for another's.
- **Swarm identity.** Each daemon has a stable `swarmId` and a name. Machine labels are only local aliases; requests and hop lists name swarms by id.
- **Project card** (one per shared board, written by the swarm's orchestrator from the board's specs, decisions, contracts and summaries and the repo's README and manifests, then **reviewed and approved by the operator before it is published**): name, a paragraph on what it is, what it **provides** (package names, repo URLs, module paths, APIs: the identities other projects depend on), what it **uses**, stack, whether and how it accepts requests, version and last landed commit, and optionally recent landed work (titles only). Local paths and anything unshared never leave.
- **Visibility.** Per project: not shared, basic (name, one line, provides) or full. An untrusted peer sees at most basic; full needs a trusted peer. The operator sees exactly what a peer will receive before it is published. Whatever is shared ends up in the peer's agents' prompts, and so with the peer's model vendors; that is stated where sharing is switched on.
- **First contact is harness to harness, not orchestrator to orchestrator (decided 2026-11-06).** The handshake is deterministic code: no model reads anything, nothing costs tokens, and nothing can be talked into anything. Orchestrators join in only inside a request (for example answering `needs info`). The swarm that connects first is the *knocker*:
  1. **Knock.** A's daemon connects out to B and sends `hello`: A's swarm id, name, public key and A's directory at the visibility A's operator set for B (basic by default; none if A prefers). The message is signed.
  2. **Silence.** B has not seen A's key, so B's reply is only `pending`. It carries nothing about B: no name, no projects. B stores A's `hello` *quarantined*: it is shown to B's operator and to no agent, and is not searchable.
  3. **Verification.** B's operator sees "swarm A wants to connect" in Needs you with A's name, key fingerprint and the project list as inert text, and chooses approve, deny or block. Approve pins A's key and releases A's directory into B's context (as peer-supplied data, not instructions). Block makes B ignore A's later knocks; deny lets A knock again.
  4. **Reply.** Only now does B answer A's next poll with its own directory (at the visibility B's operator set for A: basic until A is marked trusted). A needs no inbound port: both directions travel over the one link A opened.
  A's side needs no separate approval: A's operator added B on purpose. The rule is that a swarm's agents never read a peer's text before that swarm's own operator has accepted the peer.
- **Ongoing exchange.** After verification each poll compares directory versions and pulls what changed, in both directions. Each swarm keeps a *peer profile* for every verified peer: its cached project cards (read-only, source-tagged, marked stale when unreachable), when contact last happened, and a short history the harness maintains by counting, not by asking a model (requests filed and received, outcomes, typical time to land). The profile is stored as structured records in the context store, with a markdown rendering for orchestrators' prompts and for the operator to read; the file format is an implementation detail, not a promise.
- **Use.** The cached cards are searchable with `search_context` and summarised in orchestrators' prompts ("swarms you know and what they maintain"). An agent that hits a bug in `@acme/framework` finds the owning swarm and project, then files a request naming both, instead of guessing at free text. Matching a project's own dependencies to a peer's `provides` starts as the agent or the model doing it by name; parsing manifests automatically is later.
- **Reverse view.** Because each card lists what a project *uses*, a swarm can also see who depends on it, which is what makes "your change breaks a dependent" notices possible later.

**Trust (decided 2026-11-06)**
- A peer is *untrusted* until the operator marks it trusted. **Every inbound request from an untrusted peer waits for a human**, with no exceptions and no setting that changes that.
- Only a *trusted* peer can be given **auto-accept**. A request from such a peer starts work at once; the human gets a notification (a message and a non-blocking item in Needs you, a toast in the clients) that never halts anything, and can still cancel or decline it afterwards, which reports a decline to the sender.
- Peer states on a swarm: `unknown` (never seen), `pending` (knocked, waiting for a human), `verified` (identity accepted: directories flow both ways at basic visibility, requests allowed but each needs a human), `trusted` (verified plus the operator's flag: full visibility, auto-accept may be enabled), `blocked`. An unknown machine can do exactly one thing, knock; the knock is signed, length-limited and rate-limited, a fingerprint can have only one pending knock, and the number of pending knocks is capped, so it cannot spam the operator or reach an agent.
- My proposed defaults, open to change: auto-accept needs a per-peer budget cap (a maximum spend per request and per day); an outbound request from an agent needs approval on the sender's side by default.

**Sketch**
- **Request.** From a card on A to a project on B: title, description (repro and logs, or a spec), the optional fields above, origin (swarm, card id) and a hop list. On B it lands as an *external request*, subject to the trust rules above; approving it (or auto-accepting it) hands it to B's orchestrator as a goal.
- **Status.** B reports received, accepted or declined, in progress, landed (with sha, PR url or version), done. A *polls or streams it over its own outbound link*, so no inbound port or webhook is needed on A; B asking A back uses B's own link to A.
- **Resume.** A's card gets an *external dependency* on the request, which the scheduler treats like `blockedBy`. When B reports landed or done, A's card returns to Ready with B's note (what changed, which version to take).
- **Agent surface.** A `board` MCP tool to list peers and file a request, gated by role permission and, by default, by a human approval on A's side too.
- **Identity and trust.** Each swarm has an ed25519 key pair (Node's built-in crypto; no new dependency). Every federation message is signed, with a timestamp and nonce against replay. A swarm verifies a peer once, by its operator comparing the key fingerprint (the same one A's operator can read on A's side), and the key is then pinned. There are no shared secrets to copy between operators. A verified peer can create a request, read that request's status, comment on it and cancel it, and read the shared directory; nothing else on the board. Its key is never the operator token.
- **Transport (decided 2026-11-06): SSH only.** Outbound SSH forwards, as `@mh/client/node` does today. There is no HTTPS peering; a person whose swarms are on networks with no SSH between them builds their own tunnel. To make that easy a peer may be given as a plain local URL instead of an SSH target (the address of their own forward), with the same peer token. This is also why the local daemon, not only each client, must own the machine links: agents run inside the daemon.
- **Coordinating swarms.** A swarm with a large goal files a large request (spec, acceptance criteria, milestones, budget) with the swarms the directory says own the parts; nothing more is needed than the request above.

**Risks that decide the design**
- A request is *untrusted text that becomes an agent's input*: a prompt-injection path between swarms. It is marked external in the card, needs approval by default, cannot ask for grants or touch other boards, and is size- and rate-limited.
- Loops and runaway cost: a request chain A→B→A, or swarms spawning work for each other. The hop list caps depth and rejects cycles; each peer gets a budget in the existing limiter.
- Every step is an event in each swarm's own log; a per-peer kill switch drops a misbehaving peer.
- The operator API token must not be the only gate: every federation route except the knock requires a valid signature from a pinned key, whatever `MH_REQUIRE_TOKEN` says. The local daemon sees SSH forwards as loopback callers, so the key, not the connection, is what identifies a peer.

**Staging:** F1 swarm identity (id, key pair), peer states, the knock and verification flow with its Needs-you item, the project directory (draft, operator review, publish at a visibility, pull both ways, cache, peer profile, context and prompts), signed federation routes. Read-only and low risk, and useful before any request exists. F2 requests: the endpoints, inbound approval (always for peers that are not trusted), status, and `ih peer request`. F3 the agent tool and file-a-request flow, the external dependency and automatic resume, the trusted flag with auto-accept and its notification. F4 budgets, milestones, acceptance, loop guards. (HTTPS peering is dropped: own tunnels instead.)

### Orchestrators answer each other (added 2026-11-07, after the first live try)

The first live attempt (Beta asking Alpha for a README) showed two things. (1) **A bug:** the access layer treated every `Authorization: Bearer` token that was not the API token as wrong, including the per-session token agents use for the board MCP server, so with the daemon running normally no real agent could use any board tool (since Phase 6.6; the tests ran without that layer). Fixed: the agent endpoints (`/mcp`, telemetry) accept their own token from this machine (`auth.ts`, tested through the real layer, and confirmed live: Kimi then listed all 28 board tools). (2) **The answer could not come back.** A request returned a status, a ref and a generic note. Now the receiving orchestrator answers: the request reaches it as its goal with instructions to answer simple things itself and send the answer with `reply_to_requester(answer, done?)` (landed with the answer as the resolution note, up to 20000 characters), or plan cards and reply with the result; a goal that finishes without a reply sends its cards' summaries. The waiting card on the other side is resumed with the answer word for word. **Decided with the operator: less friction.** Agents' requests go out without approval (Settings `peerRequestApproval`, now off by default; on makes each wait). Auto-accept no longer demands limits: switching it on fills 300k tokens a request and 2M a day (still capped, still told of each). A peer that connected to us can be given an address in one step (`PATCH /api/federation/peers/:id {ssh|url}`, the peer card's *Connect back*, `ih peer address`). Tested with two daemons and fake agents end to end (`federation-agent.test.ts`: Alpha's card asks, Beta's orchestrator answers with no human, Alpha's card resumes with the text). **Not verified:** real agents doing this on the demo pair.

### File tree and `@` mentions (added 2026-11-07)

**File tree.** `GET /api/boards/:id/files?path=&card=` lists a folder of the project (or of one card's worktree), `GET /api/boards/:id/file?path=&card=` reads a file: read-only, `.git` hidden, folders first, git's changes marked (a folder is marked when something inside changed), at most 3000 entries a folder and 1 MB a file (binary files are reported, not sent). Paths are resolved with symlinks followed and must stay inside the root: `..`, absolute paths and links that leave the project are refused (400/403). The web UI shows it down the left side (lazy folders, keyboard navigation, refresh every 8 s and on card status changes, collapsible, hidden below 820 px) with a read-only viewer on the right; the TUI has a **Files** tab (key `4`) with a reader modal. VS Code has its own explorer, so it gets none. **Known gap:** like every operator route, these are reachable without a token from other processes on this machine (see Phase 6.6 step 1), so an agent could read project files through them that its confinement would not let its tools read; nothing outside the project folder.

**`@swarm/project`.** `GET /api/federation/mentions` lists what can be typed (`@<peer label>/<project name>`, lower-cased, spaces and punctuation as dashes, numbered when two projects collide; only accepted peers). The web UI completes it after an `@` in the goal bar and in a card's message box. The daemon, not the client, resolves names in a goal or card message (`Federation.mentionContext`) and appends a paragraph with each named project's card, marked as data, saying the agent cannot read their files and must use `request_peer`; e-mail-like text and unknown names are left alone. Tests: `apps/daemon/test/files.test.ts`, `apps/web/test/mentions.test.ts`, the TUI test. **Not verified:** the web UI in a browser (file tree, viewer, completion list); the TUI in a real terminal; very large folders (node_modules) in the tree. **Not done:** completion in VS Code's input boxes and in the TUI, syntax highlighting in the viewer, opening a file in the editor from the viewer, mentions of this swarm's own other boards.

### Removing boards (added 2026-11-07)

Every client (web, VS Code, TUI, `ih board remove`) can remove a board, in two ways chosen by the person: **forget** (the board, its cards, notes, settings, usage and events go; running sessions are stopped; the card worktrees the harness made are deleted, a dirty one is kept and reported; the project folder and its branches are untouched; open requests from peers about it are declined or withdrawn and its project card is unpublished) or **delete on system** (the same, plus the project folder is deleted from the disk). Delete needs the board's name typed back (checked by the daemon, not only the client) and is refused for the home folder or anything holding it, a folder with fewer than two path parts, anything holding the harness or its data, a symbolic link, and any folder overlapping another board's. The irreversible step comes before the records are deleted, so a failure leaves the board in place. A board with a card in the merge queue cannot be removed. API: `GET /api/boards/:id/removal` (what it touches), `POST /api/boards/:id/remove {mode, confirmName}`. Tests: `apps/daemon/test/boards.test.ts` and cases in the CLI, TUI and VS Code tests. **Not verified:** the web dialog in a browser; removing a board whose agents are mid-turn on a real harness (the fake agents were stopped); a repository on a network drive or with unusual permissions.

### Later
- SSH and Docker executors.
- Multi-user accounts with subtree scopes.
- GitHub Issues sync and JSONL board export.
- Phone/Slack/Discord notifications.
- Multi-board swarm.
- Postgres.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Channels is a research preview; the protocol or flag may change | Isolate it in `packages/claude-channel`. Keep the ACP/`-p` Claude adapter working as a fallback. |
| Claude Pro quota too small even for orchestration | Reserve plus a small orchestrator prompt. Allow running the orchestrator on Antigravity-served Claude models. |
| Antigravity quota lockouts | Trust observed lockouts and route around them |
| API rate limits (NIM 40 RPM, Groq ~8k TPM) cause failed turns | All API traffic goes through the gateway: queue at 95%, back off on 429, re-route to other pools |
| Harnesses without hooks can't hard-enforce leases | Check at ACP permission time plus a merge-time rejection |
| Prompt injection with auto-approve | Confine approvals to the worktree; MCP installs off by default; Docker mode |
| Runaway decomposition or token burn | Depth/fan-out/per-turn caps, budgets, best-of-N off by default |
| Vendor CLI updates break parsing | Adapter contract tests per harness in CI; version shown in the UI |

## 9. Open items (not blocking Phase 0–1)

- Whether NIM 429s carry reset headers. If they don't, the gateway uses its own rolling-window count. -- Unsure
- Whether Pro's Claude Code includes Opus. Check with `/model` after login. If it doesn't, the orchestrator runs -- Yes opus; fable No. 

