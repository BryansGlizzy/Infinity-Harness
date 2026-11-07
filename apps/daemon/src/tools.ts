import type { BoardMcp, Card, Settings, ToolGrant } from '@mh/core';
import type { McpServerConfig } from '@mh/adapters';

// Extra MCP servers an agent session gets besides the board's own (master plan Phases 6.4 and 6.5): servers a human
// approved for the whole board (`propose_mcp`), and tool grants given to this card (a browser for UI checks).

const pairs = (env: Record<string, string> | undefined) => Object.entries(env ?? {}).map(([name, value]) => ({ name, value }));

/** `{card}` and `{worktree}` in a grant's arguments and environment become this card's id and folder. */
export function expandGrant(grant: ToolGrant, card: Pick<Card, 'id'>, worktree: string): ToolGrant {
  const fill = (s: string) => s.replaceAll('{card}', card.id).replaceAll('{worktree}', worktree);
  return { ...grant, args: grant.args.map(fill), env: Object.fromEntries(Object.entries(grant.env).map(([k, v]) => [k, fill(v)])) };
}

export function boardMcpServer(m: BoardMcp): McpServerConfig | null {
  if (m.url) return { type: 'http', name: m.name, url: m.url, headers: [] };
  if (m.command) return { name: m.name, command: m.command, args: m.args ?? [], env: pairs(m.env) };
  return null;
}

/** A grant the card holds that can be switched on: it exists, isn't off, and has a command to run. */
export function activeGrants(settings: Pick<Settings, 'grants'>, card: Pick<Card, 'grants'>): [string, ToolGrant][] {
  return card.grants.flatMap((name) => {
    const g = settings.grants[name];
    return g && g.mode !== 'off' && g.command.trim() ? ([[name, g]] as [string, ToolGrant][]) : [];
  });
}

/** Servers for a card's session: the board's approved MCP servers, then the card's tool grants (named `grant-<name>`). */
export function extraMcpServers(settings: Settings, card: Pick<Card, 'id' | 'grants'>, worktree: string): McpServerConfig[] {
  const servers: McpServerConfig[] = settings.mcpServers.flatMap((m) => boardMcpServer(m) ?? []);
  for (const [name, grant] of activeGrants(settings, card)) {
    const g = expandGrant(grant, card, worktree);
    servers.push({ name: `grant-${name}`, command: g.command, args: g.args, env: pairs(g.env) });
  }
  return servers;
}

/** What a worker is told about the tools it was granted, for its prompt. */
export function grantsSection(settings: Pick<Settings, 'grants'>, card: Pick<Card, 'grants'>): string[] {
  const active = activeGrants(settings, card);
  if (!active.length) return [];
  return [
    '',
    'You were granted extra tools for this card, as MCP servers:',
    ...active.map(([name, g]) => `- grant-${name} (${g.label}): ${g.description}${g.usage ? ` ${g.usage}` : ''}`),
    'Use them to verify your work the way a person would (run the app, open the page, check what renders) and say what you saw in your summary. Keep files they produce out of the worktree.',
  ];
}

/**
 * Splits a card's grants into those whose command is installed and those whose command isn't (a missing CLI would only
 * give the session a failing MCP server). `installed` answers for one command name.
 */
export function splitInstalled(settings: Pick<Settings, 'grants'>, card: Pick<Card, 'grants'>, installed: (command: string) => boolean): { usable: string[]; missing: [string, ToolGrant][] } {
  const usable: string[] = [];
  const missing: [string, ToolGrant][] = [];
  for (const [name, g] of activeGrants(settings, card)) {
    if (installed(g.command)) usable.push(name);
    else missing.push([name, g]);
  }
  return { usable, missing };
}

/** The message that tells the humans a granted tool isn't installed. */
export function missingGrantText(cardTitle: string, missing: [string, ToolGrant][]): string {
  return missing
    .map(([name, g]) => `"${cardTitle}" was granted ${g.label} (grant-${name}) but \`${g.command}\` isn't installed on this machine, so the session started without it.${g.install ? ` Install it with: ${g.install}` : ''}`)
    .join('\n');
}

/** Approved board skills, for a worker's prompt. */
export function skillsSection(skills: Settings['skills']): string[] {
  if (!skills.length) return [];
  return ['', 'Skills this board approved. Follow them where they apply:', ...skills.flatMap((s) => [`### ${s.name}: ${s.description}`, s.body.trim().slice(0, 4000)])];
}
