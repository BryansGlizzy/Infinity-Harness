import type { HarnessEvent, ModelOption, ReasoningOptions } from '@ih/core';
import type { Pty } from './pty.ts';

/** MCP servers handed to the agent at session start (ACP `mcpServers`). */
export type McpServerConfig =
  | { name: string; command: string; args: string[]; env: { name: string; value: string }[] }
  | { type: 'http'; name: string; url: string; headers: { name: string; value: string }[] };

/** Tokens a turn used, as the harness reported them. */
export interface UsageReport {
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  costUsd?: number;
}

export interface PermissionDecision {
  allow: boolean;
  reason: string;
}

export interface SessionOptions {
  /** The card's worktree; auto-approval is confined to it. */
  cwd: string;
  /** Harness-specific model id, e.g. `nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b`. */
  model?: string;
  /** Reasoning level, one of the harness's published levels; unset keeps its default. */
  reasoning?: string;
  mcpServers?: McpServerConfig[];
  /**
   * The vendor session id of an earlier session to pick up (after the daemon restarted). The adapter resumes it when the
   * harness can, and otherwise starts a fresh session; `AgentSession.resumed` says which happened.
   */
  resume?: string;
  /**
   * Directories outside the worktree that tool calls may still use: scratch space, the machine's toolchains and
   * caches, and the repo's git dir (see environment.ts). Unset: the worktree only.
   */
  sharedRoots?: string[];
  onEvent: (event: HarnessEvent) => void;
  /** Reports tokens (and cost, when the harness says) a turn used. Harnesses that publish usage call it; others never do. */
  onUsage?: (usage: UsageReport) => void;
  /**
   * Where the harness should send its OpenTelemetry metrics, and the resource attributes that say whose they are
   * (Claude Code only; the daemon's receiver turns them into usage records, Phase 6.3).
   */
  telemetry?: { endpoint: string; attributes: Record<string, string> };
  /**
   * Extra check after the worktree policy allows a request, e.g. file leases held by other cards.
   * Receives every path the request names; return a decision to override, or null to keep "allow".
   */
  policy?: (paths: string[], toolCall: unknown) => PermissionDecision | null;
}

export interface AgentSession {
  readonly vendorSessionId: string;
  /** True when this is the earlier conversation picked up again (`SessionOptions.resume`), not a new one. */
  readonly resumed?: boolean;
  /** Present for terminal-based harnesses (Claude): the live TUI, attachable from the UI. */
  readonly pty?: Pty;
  /** Runs one turn; resolves with the stop reason. */
  prompt(text: string): Promise<string>;
  cancel(): Promise<void>;
  close(): void;
}

export interface HarnessAdapter {
  readonly id: string;
  /** Repo-relative paths the harness writes into every workspace on its own; removed before commit while untracked. */
  readonly strayPaths?: string[];
  startSession(opts: SessionOptions): Promise<AgentSession>;
  /** Models the harness offers on this login, for choosing one per agent. `cwd` is a scratch directory. */
  listModels?(cwd: string): Promise<ModelOption[]>;
  /** Models and the reasoning setting the harness publishes, in one probe. `cwd` is a scratch directory. */
  probe?(cwd: string): Promise<{ models: ModelOption[]; reasoning: ReasoningOptions | null }>;
  shutdown(): void;
}
