# Meta-Harness: Research Landscape & Initial Architecture

_Researched 2026-10-30. Items marked **(unverified)** come from third-party write-ups only. Check them against primary docs before building on them._

## 1. What we're building (one paragraph)

A local-first daemon + web UI that drives multiple **vendor coding harnesses** (Claude Code, Codex, Antigravity `agy`, Kimi Code, OpenCode, …) as first-class workers on a **hierarchical, dynamically growing kanban tree**. An orchestrator (Claude Opus by default) decomposes work. A judge/router model (Jev-style) scores work type and complexity, and deterministic policy assigns cards using user rules, agent availability, and remaining subscription quota. Agents share MCP servers, skills, and an artifact store. They message each other through a coordination bus and hold file leases so they don't collide. Everything streams live to the UI: who's working on what, sub-agent trees, tokens, quota.

## 2. Findings that shape the design

### 2.1 Subscriptions only work through the official clients
- Anthropic added server-side blocks on 2026-01-09 and updated its docs on 2026-02-19. Using Free/Pro/Max OAuth tokens in any other product, **including the Agent SDK**, violates the Consumer ToS. Third-party products must use API keys.
- **Consequence:** the meta-harness must **drive the user's installed, logged-in `claude` binary**. It must never extract or proxy tokens, and it must never reimplement Claude Code. This applies even more if the tool is ever distributed: each user brings their own CLI login.
- OpenCode-as-universal-runtime therefore **doesn't work for Claude subscriptions**. OpenCode v2.2.3 reportedly added a "Claude Agent" provider that signs in via Claude Code, and Anthropic hasn't publicly blessed it **(unverified)**. OpenCode stays useful as the lane for API keys, OpenAI-compatible endpoints, and local models.
- **Headless billing (resolved 2026-10-31):** the planned 2026-06-15 "Agent SDK credit" was **paused**. Anthropic's support article (updated 2026-10-07) says plan-signed-in `claude -p` and Agent SDK usage draw from normal plan limits. Every route to the real `claude` binary, including ACP's Claude adapter, uses the subscription.
- **Claude Code Channels** (research preview): an MCP server can push messages into a running **interactive** session (`notifications/claude/channel`) and relay permission prompts. This is how the daemon injects messages without `-p`. See [clarifications.md](clarifications.md#q7-leverage-the-subscription-plug-into-claude-code-somehow).

### 2.2 ACP is the universal adapter, so we don't need OpenCode-for-everything
The **Agent Client Protocol** (Zed; JSON-RPC over stdio) is what editors like Zed and JetBrains use to drive arbitrary agents. The official registry includes **Claude Agent, Codex, Google Antigravity, Kimi CLI, goose, Gemini, GitHub Copilot, Cursor, Cline, Junie, Kilo, Auggie**. Machine-readable index: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`.
- ACP gives sessions, prompt turns, streamed tool calls/plans/diffs, permission requests, and **MCP servers passed in at `session/new`**. The last one is how we inject shared MCP plus our coordination MCP into every agent uniformly.
- The meta-harness becomes an **ACP client that drives N agents**, the way Zed drives one. Native protocols are used where they expose more, such as Codex app-server rate limits.
- **"Don't lose native abilities":** ACP does not carry everything a vendor's TUI does. Plan for two modes per session: **Structured (ACP)** as the default, and **Native terminal (PTY + xterm.js)** as an escape hatch. The terminal mode still gets telemetry via OTel and transcript parsing.

### 2.3 Antigravity changed a lot in 2026
- **Antigravity 2.0** (2026-05-19) has five surfaces: desktop app (multi-agent), **`agy` CLI** (Go, headless/CI capable), SDK, **Managed Agents API** in the Gemini API (preview id `antigravity-preview-09-2026`), and enterprise.
- **The legacy Gemini CLI is deprecated and stopped serving requests on 2026-06-18.** Use `agy`.
- Headless: `agy -p … --output-format stream-json --non-interactive` **(unverified; check `agy --help`)**. MCP via `/mcp` manager; project config reportedly `.antigravity/settings.json` **(unverified)**.
- Antigravity also serves Claude models through Google's backend. That is another quota pool for Claude-model work.

### 2.4 Kimi Code
- Moonshot's terminal agent: MIT, TypeScript, first release May 2026 (successor to Kimi CLI). Has **`kimi acp`**, a web UI, and a headless mode.
- Auth: Kimi subscription via OAuth (quota reportedly refreshes **weekly**) or a pay-as-you-go API key. The MCP config location conflicts across sources (`~/.kimi-code/mcp.json` vs conversational `/mcp-config`).

### 2.5 "Jev" is TypeSafe's decision model
- A non-autoregressive "System One" judge. You supply the outcomes, and it returns a **probability distribution over them**. It does not generate text. Pitched for intent/complexity routing ("**the model classifies, code routes**"), for guardrails (continue / verify / escalate), and as a cheaper LLM-as-judge.
- No primary docs or independent benchmarks were found. The "80% orchestration cost cut" figure is a single secondary claim.
- **The user's self-hosted "Kev" (tested 2026-10-31)** is Unsloth Studio's Decision API: `POST /v1/systemone` with question types `noul` (yes/no probability), `choice`, and `score`, plus an MCP `decide` tool at `/mcp/decisions/`. `kev-9b` responds in about 1s warm and 13s cold. It is used instead of a clone. Details are in clarifications Q9.
- **Jev-clone on any OpenAI-compatible endpoint (fallback):** prompt with an enumerated label set, force a single-token label (or structured output), and read **logprobs** to get a distribution. This works on OpenAI, OpenRouter, LiteLLM, vLLM, Ollama, and LM Studio. A small local router model is the other option.

### 2.6 Shared skills and MCP are mostly solved by standards
- **Agent Skills (`SKILL.md`)**, published at agentskills.io in Dec 2025, is read by 30+ tools. Paths: Claude `~/.claude/skills` / `.claude/skills`, Codex `.agents/skills`, Antigravity `~/.gemini/antigravity/skills`. OpenCode gets skills via `npx skills add`. Kimi is unconfirmed.
  → Keep **one canonical skills dir** and symlink/sync it into each harness.
- **MCP gateway** (e.g. MetaMCP, MIT): many servers behind one endpoint with namespaces and auth. Caveats: Codex remote MCP needs **Streamable HTTP over HTTPS**, and naive aggregation bloats tool lists. Use per-role tool filtering.
- **AGENTS.md** as the shared project-instructions file, with CLAUDE.md importing or symlinking it.

### 2.7 Metrics and quota signals exist per vendor, but nothing aggregates them all
| Signal | Claude Code | Codex | Antigravity | Kimi |
|---|---|---|---|---|
| Telemetry | OTel (`CLAUDE_CODE_ENABLE_TELEMETRY`) | OTel (`[otel]` in config) | TBD | TBD |
| Transcripts | `~/.claude/projects/**.jsonl` | `~/.codex/sessions` | TBD | TBD |
| Subscription quota | status-line JSON `rate_limits.five_hour/seven_day.used_percentage` + `resets_at` (subscription only; flaky in some versions; `resets_at` format varies) | app-server `account/rateLimits/read` + `account/rateLimits/updated` notifications | TBD | weekly quota (API TBD) |
| Sub-agents | Task/Agent tool calls (`parent_tool_use_id`), subagent hooks, agent-teams files (`~/.claude/teams`, `~/.claude/tasks`) | TBD | desktop multi-agent; CLI TBD | TBD |

Existing aggregators: **AI Observer** (tobilg, self-hosted OTel backend for Claude/Codex/Gemini), **Coding Agent Usage** (npm, local dashboard reading session files), **ccusage**, and Grafana dashboards 25052 (Claude) and 25266 (Codex).
→ Embed an **OTel collector**, add transcript parsers and quota pollers, and normalize into one `usage_events` table.

## 3. Prior art: what to take from each project

| Project | What it is | License | Take this |
|---|---|---|---|
| **Vibe Kanban** (BloopAI) | Kanban for 10+ agents (Claude, Codex, Gemini, Copilot, Amp, Cursor, OpenCode, Droid, CCR, Qwen). Rust + React, SQLite workflow state, git for code state, worktree + branch + terminal + dev server per task. **Bloop shut down 2026-04-10; board feature retired upstream; community-maintained.** | Apache-2.0 | Executor abstraction (incl. `acp/`), worktree lifecycle, dev-server-per-task, its MCP server. **Study, don't fork** (see clarifications Q28). |
| **Paperclip** | "AI company" control plane: org chart, per-agent `canCreateAgents`, approval queue for agent hires, atomic task checkout, per-agent budgets, heartbeats; adapters incl. Claude Code, Codex, Kimi Code | MIT | Spawn-permission and governance model (clarifications Q17) |
| **Agor** (Preset) | Figma-like multiplayer canvas of worktrees and sessions; Claude/Codex/Gemini; session **fork/spawn genealogy**; internal MCP so agents see each other; auto port assignment | OSS | Session-tree visualization, zones that trigger templated prompts, multiplayer cursors/comments |
| **mcp_agent_mail** | HTTP FastMCP server: agent identities, inbox/outbox, threads, **advisory file reservations (leases on files/globs)**, git-auditable | OSS | Messaging and lease model, nearly verbatim |
| **Beads** (Yegge) | Git-backed, dependency-aware issue graph; `bd ready` returns unblocked work; `.beads/issues.jsonl` | OSS | Tree/DAG semantics, "ready work" query, JSONL import/export |
| **Gas Town** (Yegge) | Mayor coordinates 20–30 workers ("polecats") in tmux; convoys = bundles of beads; Refinery/Witness/Deacon roles | OSS | Role taxonomy; **Refinery = merge queue**; Witness = health monitor. Warning: users report the Mayor doing the work itself instead of delegating. |
| **Claude Code Agent Teams** | Experimental (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`, ≥ v2.1.32): lead + teammates, **shared task list + per-agent mailbox**, file-based | Proprietary | Proof the task-list + mailbox model works; known flaw is that two teammates on one file overwrite each other, so leases are required |
| **Bernstein** | Deterministic orchestrator, **no LLM in the scheduling loop**; 40+ CLI adapters; worktree per task + merge gates; janitor verification; HMAC-chained audit log | Apache-2.0 | Deterministic scheduler, adapter catalog, audit log |
| **Emdash** (YC W26) | Desktop app: 23 CLI agents in parallel worktrees; SSH/SFTP remote | MIT/Apache (sources conflict) | Broad agent catalog, remote execution |
| **Orchestrator.inc / AO** | Kanban where a worker = task + agent + workspace; persistent planning agent; board tracks PRs, CI, review feedback, merge conflicts | TBD | **PR/CI-aware columns** |
| **Auto-Claude** | Kanban + spec → plan → build → validate; up to 12 terminals; worktree per task | AGPL-3.0 | Spec-first pipeline (but Claude-only, and AGPL is viral) |
| **Claude Squad** | tmux + worktrees session manager | AGPL-3.0 | Native-TUI-in-PTY approach |
| **kodo** | Directs Claude/Codex/Gemini through cycles with independent architect + tester verification | MIT | Cross-agent verification roles |
| **AI Observer / Coding Agent Usage** | Multi-agent usage/OTel dashboards | OSS | Metrics normalization, cost tables |
| **MetaMCP** | MCP aggregation gateway | MIT | Shared MCP endpoint |
| **A2A** (Linux Foundation; reportedly under AAIF since Aug 2026) | Cross-vendor agent-to-agent protocol, 150+ orgs | Apache-2.0 | Later: cross-machine or remote agents. Overkill for v1, where every agent is local and speaks MCP. |

Directories to mine: `bradAGI/awesome-cli-coding-agents`, `Agent-Analytics/awesome-multi-agent-orchestrators`, the ACP registry.

## 4. Proposed architecture (v0 sketch)

```
 Web UI ─ board/tree · live sessions · terminals · diffs · agent chat · metrics · lock map
   │  WebSocket/SSE (event stream)
 ┌─┴──────────────────────────────────────────────────────────────────────────┐
 │ Meta-Harness daemon                                                        │
 │  Board/Tree store (DAG) · Scheduler (deterministic) · Router (judge model) │
 │  Lease manager · Message bus · Artifact store · Append-only event log      │
 │  Usage: OTel receiver + transcript parsers + quota pollers                 │
 │  Coordination MCP server ("board" tools) · MCP gateway · Skills sync       │
 └──┬───────────┬───────────┬───────────┬───────────┬─────────────────────────┘
  ACP/native  ACP/app-srv  ACP/agy    kimi acp   ACP / OpenAI-compatible
  claude      codex        antigravity kimi       opencode (API keys, local)
  ▲ Opus orchestrator is itself a Claude Code session using the board MCP
  Every worker: own git worktree · shared MCP gateway + board MCP · synced skills · AGENTS.md
```

**Coordination MCP ("board") tools:** `list_ready`, `claim_task`, `update_task`, `create_subtask`, `post_message`, `read_inbox`, `ask_agent` (blocking), `reserve_paths` / `release_paths`, `put_artifact` / `get_artifact` / `search_artifacts`, `request_review`, `report_blocked`.

**Message delivery:** agents can't be interrupted mid-turn over MCP. Deliver at **turn boundaries**: either as the next ACP prompt, or injected via hooks (e.g. Claude Code `UserPromptSubmit`/`PostToolUse` context injection). `ask_agent` routes to an idle target session, or forks one, and returns the answer.

**Conflict avoidance (layers):** worktree per task → path leases with TTL (enforced where hooks allow, e.g. Claude Code `PreToolUse` blocks edits to paths leased by another agent; advisory elsewhere) → single-writer per card → merge queue ("refinery") that runs tests and rebases.

**Routing:**
1. Orchestrator (Opus) decomposes and writes spec artifacts.
2. Judge scores each card: `{work_type, complexity 1–5, risk, est_size}` as probabilities.
3. Deterministic policy picks the agent: user rules on the tree node (inherited down the tree) → capability filter → availability (idle, concurrency caps) → quota headroom and reset time → historical success per (agent, work_type, complexity).
4. Verification gate: tests, plus a cross-provider review for complexity ≥ N.
5. Escalate or reassign on failure, with a context-handoff artifact.

**Data model (first cut):** `boards`, `nodes` (cards; parent_id for the tree), `edges` (blocked_by), `routing_rules`, `agents` (harness, plan, caps), `sessions` (agent, node, worktree, parent_session for sub-agent trees, mode acp|pty), `leases`, `threads`, `messages`, `artifacts` (versioned, author, node), `usage_events`, `quota_snapshots`, `events` (append-only; drives the UI and replay).

## 5. Sources
- Vibe Kanban: https://github.com/BloopAI/vibe-kanban · https://virtuslab.com/blog/ai/vibe-kanban/
- ACP registry: https://github.com/agentclientprotocol/registry · https://agentclientprotocol.com/get-started/registry
- Antigravity: https://ai.google.dev/gemini-api/docs/antigravity-agent · https://en.wikipedia.org/wiki/Google_Antigravity · https://docs.rs/crate/atomr-agents-coding-cli-vendor-antigravity/latest
- Anthropic subscription ToS: https://www.theregister.com/2026/02/20/anthropic_clarifies_ban_third_party_claude_access · https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/ · https://cellcog.ai/blog/opencode-claude-subscription/
- Agent SDK credit: https://code.claude.com/docs/ja/agent-sdk/overview · https://www.digitalapplied.com/blog/anthropic-claude-credit-overhaul-june-15-2026
- Jev: https://wavect.io/blog/jev-ai-decision-model-review/ · https://www.besthub.dev/articles/jev-decision-model-extracting-structured-judgments-from-llms-for-code-driven-routing-044d92bc4bf4
- Kimi Code: https://innfactory.ai/en/ai-harness/kimi-code/ · https://claudelog.com/faqs/what-is-kimi-code/
- Codex app-server rate limits: https://forge.lthn.ai/core/core-agent-ide/commit/8ae394907203e249dc355b3670ed5c697608c481 · https://hexdocs.pm/codex_sdk/Codex.Events.AccountRateLimitsUpdated.html
- mcp_agent_mail: https://github.com/Dicklesworthstone/mcp_agent_mail
- Gas Town: https://dark-factory-kb.pages.dev/steve-yegge-gas-town.html · https://johncodes.com/archive/2026/01-16-a-glimpse-into-the-future
- Claude Code agent teams: https://dev.to/nwyin/reverse-engineering-claude-code-agent-teams-architecture-and-protocol-o49 · https://www.morphllm.com/claude-code-agent-teams
- Agor: https://dev.to/maxime_beauchemin/i-built-figma-for-ai-coding-using-itself-9j4
- Bernstein: https://bernstein.readthedocs.io/en/latest/architecture/ARCHITECTURE/
- Emdash: https://www.morphllm.com/emdash-ai-coding-agent · Auto-Claude: https://korben.info/en/auto-claude-army-of-ai-developers-parallel-agents.html · AO: https://github.com/OrchestratorInc/agent-orchestrator/wiki
- Orchestrator roundup: https://www.augmentcode.com/tools/open-source-agent-orchestrators · https://github.com/bradagi/awesome-cli-coding-agents
- Metrics: https://awesome.ecosyste.ms/projects/github.com%2Ftobilg%2Fai-observer · https://socket.dev/npm/package/coding-agent-usage/overview/1.0.1 · https://grafana.com/grafana/dashboards/25052/
- Claude status-line rate limits: https://wmedia.es/en/tips/claude-code-usage-limit-status-line · https://github.com/anthropics/claude-code/issues/45133
- MCP gateway: https://mcp.directory/blog/metamcp-complete-guide-2026
- Agent Skills: https://codex.danielvaughan.com/2026/05/05/agent-skills-open-standard-portable-skills-codex-cli-cross-agent/ · https://blog.devgenius.io/google-antigravity-adds-skills-04ab11d8497c
- A2A: https://www.linuxfoundation.org/press/a2a-protocol-surpasses-150-organizations-lands-in-major-cloud-platforms-and-sees-enterprise-production-use-in-first-year
