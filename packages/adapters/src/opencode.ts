import { homedir } from 'node:os';
import { join } from 'node:path';
import { AcpAgent } from './acp-agent.ts';

export interface OpenCodeOptions {
  /** Path to the opencode.json the daemon manages (providers, models, permissions). */
  configPath: string;
  /** Extra env for the agent process: provider keys and base URLs. */
  env: NodeJS.ProcessEnv;
  cwd: string;
  binary?: string;
}

/** OpenCode over ACP (`opencode acp`). Config is injected with OPENCODE_CONFIG so nothing is written into the repo. */
export function createOpenCodeAdapter(opts: OpenCodeOptions): AcpAgent {
  return new AcpAgent({
    id: 'opencode',
    command: opts.binary ?? join(homedir(), '.opencode', 'bin', 'opencode'),
    args: ['acp'],
    cwd: opts.cwd,
    env: { ...opts.env, OPENCODE_CONFIG: opts.configPath },
  });
}

export interface CliAgentOptions {
  env: NodeJS.ProcessEnv;
  cwd: string;
  binary?: string;
}

/**
 * Kimi Code over ACP (`kimi acp`), on the user's Kimi subscription login.
 * Kimi auto-approves edits inside the session cwd and asks for everything else (outside writes, shell).
 */
export function createKimiAdapter(opts: CliAgentOptions): AcpAgent {
  return new AcpAgent({ id: 'kimi', command: opts.binary ?? 'kimi', args: ['acp'], cwd: opts.cwd, env: opts.env });
}

/**
 * Codex over ACP, through the `codex-acp` bridge (`npm i -g @agentclientprotocol/codex-acp`), on the user's
 * Codex login (ChatGPT subscription or API key in ~/.codex).
 */
export function createCodexAdapter(opts: CliAgentOptions): AcpAgent {
  // Codex sandboxes its own commands (workspace-write: only the cwd and /tmp are writable, no network). The shared
  // roots go in as writable directories, so commits reach the repo's git dir and builds can use their tool caches.
  return new AcpAgent({ id: 'codex', command: opts.binary ?? 'codex-acp', args: [], cwd: opts.cwd, env: codexEnv(opts.env), additionalDirectories: true });
}

/**
 * Codex's web search runs on OpenAI's side, outside the sandbox, so research works even though shell commands have no
 * network. Its default is a cached index; board sessions get live results unless CODEX_CONFIG already says otherwise.
 */
export function codexEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let config: Record<string, unknown> = {};
  try {
    config = env.CODEX_CONFIG ? (JSON.parse(env.CODEX_CONFIG) as Record<string, unknown>) : {};
  } catch {
    return env; // the user's own value, even if we can't read it
  }
  return { ...env, CODEX_CONFIG: JSON.stringify({ web_search: 'live', ...config }) };
}

/**
 * Antigravity over Google's ACP server (installed by scripts/install-agy-acp.sh).
 * `oauth-personal` uses the server's own Google login (scripts/agy-acp-login.mjs on Linux); the default mode
 * asks before every edit and command. With `home`, the server runs on an isolated HOME (see isolatedAgyHome).
 */
export function createAgyAdapter(opts: CliAgentOptions & { binary: string; home?: string }): AcpAgent {
  // agy keeps each conversation's MCP tool descriptions as files (`brain/<id>/mcp/board/*.json`) and lists them to
  // find the board tools; reading them must not count as leaving the worktree. Both spellings: HOME link and target.
  const brain = (home: string) => join(home, '.gemini', 'antigravity-acp', 'brain');
  return new AcpAgent({
    id: 'agy',
    command: opts.binary,
    args: [],
    cwd: opts.cwd,
    env: opts.home ? { ...opts.env, HOME: opts.home } : opts.env,
    authMethod: 'oauth-personal',
    // The server writes its built-in run-workflow skill into every session's cwd.
    strayPaths: ['skills/system'],
    internalRoots: [...new Set([brain(homedir()), ...(opts.home ? [brain(opts.home)] : [])])],
  });
}
