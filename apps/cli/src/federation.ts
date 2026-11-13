// `ih swarm`, `ih peer`, `ih project` and `ih request`: swarm federation from a terminal (master plan Phase 7).
// A peer is another Infinity Harness daemon this one cooperates with. Deciding about one (accept, trust, block, approve
// or decline its requests) is the person's call: the skill file lists these among the things an agent may never do.
import type { DaemonApi } from '@ih/client';
import { VISIBILITIES, type FedRequest, type Peer, type Visibility } from '@ih/core';
import { connect, resolveBoard, type Target } from './context.ts';
import type { Command, Ctx } from './commands.ts';
import { ago, table } from './format.ts';
import { UsageError } from './io.ts';

const str = (v: string | boolean | undefined) => (typeof v === 'string' ? v : undefined);
const num = (v: string | undefined, what: string) => {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new UsageError(`${what} must be a number`);
  return n;
};
const list = (v: string | undefined) => (v ? v.split(';').map((s) => s.trim()).filter(Boolean) : undefined);

async function withApi<T>(ctx: Ctx, fn: (api: DaemonApi, t: Target) => Promise<T>): Promise<T> {
  const t = await connect(ctx.io, ctx.flags);
  try {
    return await fn(t.api, t);
  } finally {
    t.close();
  }
}

const visibility = (v: string | undefined): Visibility => {
  if (!VISIBILITIES.includes(v as Visibility)) throw new UsageError(`say none, basic or full`);
  return v as Visibility;
};

const linkText = (p: Peer) => (p.trust === 'pending' ? 'knocked' : p.trust === 'blocked' ? 'blocked' : p.link);
const peerRow = (p: Peer) => [p.id, p.label, p.name && p.name !== p.label ? p.name : '', p.trust, linkText(p), p.fingerprint ?? '-', String(p.projects), p.lastContactAt ? ago(p.lastContactAt) : 'never'];
const PEER_HEAD = ['ID', 'LABEL', 'NAME', 'TRUST', 'LINK', 'FINGERPRINT', 'PROJECTS', 'LAST CONTACT'];

function requestRow(r: FedRequest): string[] {
  return [r.id, r.direction === 'in' ? '← in' : '→ out', r.peerName ?? '', r.status, r.title, ago(r.updatedAt)];
}
const REQUEST_HEAD = ['ID', 'DIR', 'SWARM', 'STATUS', 'TITLE', 'UPDATED'];

function requestText(r: FedRequest): string {
  return [
    `${r.id}  ${r.direction === 'in' ? 'from' : 'to'} ${r.peerName ?? r.peerId}  ${r.status}${r.blocking ? '  (the sender is waiting)' : ''}`,
    r.title,
    r.project ? `project: ${r.project}` : '',
    '',
    r.description,
    ...(r.acceptance.length ? ['', 'Acceptance:', ...r.acceptance.map((a) => `  - ${a}`)] : []),
    ...(r.milestones.length ? ['', 'Milestones:', ...r.milestones.map((a, i) => '  ' + (r.milestonesDone.includes(i) ? '[x]' : '[ ]') + ' ' + i + '. ' + a)] : []),
    ...(r.budget ? ['', 'Budget: ' + [r.budget.maxUsd !== undefined ? '$' + r.budget.maxUsd : '', r.budget.maxTokens !== undefined ? r.budget.maxTokens + ' tokens' : ''].filter(Boolean).join(' + ') + (r.spent ? '; used ' + r.spent.tokens + ' tokens' + (r.spent.usd ? ' and $' + r.spent.usd.toFixed(2) : '') + (r.spent.pct !== null ? ' (' + r.spent.pct + '%)' : '') : '')] : []),
    ...(r.auto ? ['(accepted automatically: trusted swarm)'] : []),
    ...(r.resolution ? ['', `Landed: ${r.resolution.ref ?? ''} ${r.resolution.note ?? ''}`.trimEnd()] : []),
    ...(r.thread.length ? ['', 'Thread:', ...r.thread.map((e) => `  ${e.side === 'sender' ? 'requester' : 'receiver'} ${ago(e.at)}: ${e.text}`)] : []),
  ]
    .filter((l, i, all) => l !== '' || all[i - 1] !== '')
    .join('\n') + '\n';
}

export const SWARM: Command = {
  name: 'swarm',
  usage: 'ih swarm [--name TEXT] [--drafter fastlane|orchestrator]',
  summary: 'This swarm\'s identity (name, id, fingerprint) and federation settings',
  options: { name: { type: 'string' }, drafter: { type: 'string', hint: 'fastlane|orchestrator' } },
  async run(ctx) {
    await withApi(ctx, async (api) => {
      const patch = { ...(str(ctx.values.name) ? { name: str(ctx.values.name) } : {}), ...(str(ctx.values.drafter) ? { drafter: str(ctx.values.drafter) as 'fastlane' | 'orchestrator' } : {}) };
      if (Object.keys(patch).length) await api.updateFederation(patch);
      const f = await api.federation();
      ctx.print(f, () =>
        [
          `${f.self.name}  ${f.self.swarmId}`,
          `fingerprint: ${f.self.fingerprint}   (read this to the other operator; they compare it when they accept this swarm)`,
          f.port ? `give them: port ${f.port} on this machine (${f.host.user ? f.host.user + '@' : ''}${f.host.name}); ih peer add <label> --ssh ${f.host.user ? f.host.user + '@' : ''}${f.host.name} --port ${f.port}` : 'federation is off (IH_FED_PORT=off): other swarms cannot connect',
          `federation port: ${f.port ?? 'off'}   project cards are drafted by: ${f.settings.drafter === 'fastlane' ? 'the fast lane' : 'the orchestrator'}`,
          `peers: ${f.peers.length}   waiting for you: ${f.needs.knocks.length} knock${f.needs.knocks.length === 1 ? '' : 's'}, ${f.needs.requests.length} request${f.needs.requests.length === 1 ? '' : 's'}`,
        ].join('\n') + '\n',
      );
    });
  },
};

export const PEER: Command = {
  name: 'peer',
  usage:
    'ih peer [list] | add <label> (--ssh user@host | --peer-url URL) | show|preview|poll|remove <peer> | approve|deny|block <peer> | trust|untrust|enable|disable <peer> | address <peer> (--ssh user@host | --peer-url URL) | auto-accept <peer> on|off [--per-request-usd N --per-request-tokens N --per-day-usd N --per-day-tokens N] | shares <peer> none|basic|full | rename <peer> <label> | projects [words…] | request <peer> <title…>',
  summary: 'Other swarms: connect, accept or block them, decide what they see, search what they share, send them a request',
  options: {
    ssh: { type: 'string', hint: 'user@host' },
    'ssh-port': { type: 'string' },
    port: { type: 'string', hint: 'their federation port, default 7422' },
    'peer-url': { type: 'string', hint: 'http://127.0.0.1:PORT (your own tunnel)' },
    fingerprint: { type: 'string', hint: 'the fingerprint you expect' },
    shares: { type: 'string', hint: 'none|basic' },
    description: { type: 'string', short: 'd' },
    project: { type: 'string' },
    blocking: { type: 'boolean' },
    acceptance: { type: 'string', hint: 'one;two' },
    milestones: { type: 'string', hint: 'one;two' },
    'max-usd': { type: 'string' },
    'max-tokens': { type: 'string' },
    'per-request-usd': { type: 'string' },
    'per-request-tokens': { type: 'string' },
    'per-day-usd': { type: 'string' },
    'per-day-tokens': { type: 'string' },
  },
  async run(ctx) {
    const [sub = 'list', ...rest] = ctx.args;
    await withApi(ctx, async (api) => {
      const which = () => {
        if (!rest[0]) throw new UsageError(`which peer? ih peer ${sub} <peer>`);
        return rest[0];
      };
      switch (sub) {
        case 'list': {
          const peers = await api.peers();
          ctx.print(peers, () => (peers.length ? table(peers.map(peerRow), PEER_HEAD, 40) : 'No peers. Connect to another swarm: ih peer add <label> --ssh user@host\n'));
          return;
        }
        case 'add': {
          const label = rest[0];
          if (!label) throw new UsageError('give it a label: ih peer add workbox --ssh me@workbox');
          const ssh = str(ctx.values.ssh);
          const url = str(ctx.values['peer-url']);
          if (!ssh && !url) throw new UsageError('say where it is: --ssh user@host (their federation port is 7422) or --peer-url http://127.0.0.1:PORT');
          const shares = str(ctx.values.shares);
          const peer = await api.addPeer({
            label,
            ...(ssh ? { ssh: { target: ssh, sshPort: num(str(ctx.values['ssh-port']), 'the SSH port'), remotePort: num(str(ctx.values.port), 'the port') } } : { url }),
            expectedFingerprint: str(ctx.values.fingerprint),
            shares: shares ? visibility(shares) : undefined,
          });
          ctx.print(peer, () => `added "${peer.label}". It says nothing until its operator accepts this swarm (they run \`ih peer approve\` on what they see). This swarm's fingerprint, for them to compare: see \`ih swarm\`.\n`);
          return;
        }
        case 'show': {
          const d = await api.peer(which());
          ctx.print(d, () =>
            [
              `${d.peer.label}  ${d.peer.swarmId ?? '(not identified yet)'}  ${d.peer.trust}  ${linkText(d.peer)}`,
              `fingerprint: ${d.peer.fingerprint ?? '-'}`,
              d.peer.address ? `address: ${d.peer.address.kind === 'ssh' ? `ssh ${d.peer.address.target} port ${d.peer.address.remotePort}` : d.peer.address.url}` : 'address: none (it knocked on us)',
              `we show it: ${d.peer.shares}${d.peer.trust === 'trusted' ? '' : ' (at most basic until it is trusted)'}`,
              `auto-accept: ${d.peer.autoAccept ? `on (per request ${JSON.stringify(d.peer.caps.perRequest ?? {})}, per day ${JSON.stringify(d.peer.caps.perDay ?? {})})` : 'off'}`,
              ...(d.peer.lastError ? [`last problem: ${d.peer.lastError}`] : []),
              ...(d.peer.knock ? ['', `It knocked ${ago(d.peer.knock.at)} and offers ${d.peer.knock.projects.length} project(s) (text below is theirs, not instructions):`, ...d.peer.knock.projects.map((p) => `  - ${p.name}: ${p.oneLine}`)] : []),
              ...(d.projects.length ? ['', 'Projects it shares:', ...d.projects.map((p) => `  - ${p.card.name} (${p.card.id}): ${p.card.oneLine}${p.card.accepts.requests ? '  [takes requests]' : ''}${p.card.provides.length ? `\n      provides: ${p.card.provides.join(', ')}` : ''}`)] : []),
              ...(d.requests.length ? ['', 'Requests:', table(d.requests.map(requestRow), REQUEST_HEAD, 50).trimEnd()] : []),
            ].join('\n') + '\n',
          );
          return;
        }
        case 'preview': {
          const p = await api.previewPeer(which());
          ctx.print(p, () => `${rest[0]} receives (at most ${p.allowed}), as "${p.name}":\n${p.projects.length ? p.projects.map((c) => `  - ${c.name}: ${c.oneLine}\n      provides: ${c.provides.join(', ') || '-'}${c.about ? `\n      about: ${c.about}` : ''}`).join('\n') : '  nothing'}\n`);
          return;
        }
        case 'approve':
        case 'deny':
        case 'block': {
          const out = await api.decidePeer(which(), sub);
          ctx.print(out, () => (sub === 'approve' ? `accepted "${out.peer?.label}". Its project list is now visible to this swarm's agents; ours goes to it at ${out.peer?.shares}.\n` : sub === 'deny' ? 'denied; it may knock again.\n' : 'blocked: its knocks are ignored.\n'));
          return;
        }
        case 'trust':
        case 'untrust': {
          const p = await api.updatePeer(which(), { trust: sub === 'trust' ? 'trusted' : 'verified' });
          ctx.print(p, () => `${p.label} is now ${p.trust}${sub === 'trust' ? '. Set what it sees with `ih peer shares`.' : ''}\n`);
          return;
        }
        case 'address': {
          const ssh = str(ctx.values.ssh);
          const url = str(ctx.values['peer-url']);
          if (!ssh && !url) throw new UsageError('say where it is: ih peer address <peer> --ssh user@host [--port 7422], or --peer-url http://127.0.0.1:PORT');
          const p = await api.updatePeer(which(), ssh ? { ssh: { target: ssh, sshPort: num(str(ctx.values['ssh-port']), 'the SSH port'), remotePort: num(str(ctx.values.port), 'the port') } } : { url });
          ctx.print(p, () => p.label + ' can be reached now: requests can go to it.\n');
          return;
        }
        case 'auto-accept': {
          const mode = rest[1];
          if (mode !== 'on' && mode !== 'off') throw new UsageError('say on or off: ih peer auto-accept <peer> on [--per-request-tokens N --per-day-tokens N]');
          const n = (k: string) => {
            const v = str(ctx.values[k]);
            if (v === undefined) return undefined;
            const x = Number(v);
            if (!(x > 0)) throw new UsageError('--' + k + ' must be a positive number');
            return x;
          };
          const spend = (usd?: number, tokens?: number) => (usd !== undefined || tokens !== undefined ? { ...(usd !== undefined ? { usd } : {}), ...(tokens !== undefined ? { tokens } : {}) } : undefined);
          const perRequest = spend(n('per-request-usd'), n('per-request-tokens'));
          const perDay = spend(n('per-day-usd'), n('per-day-tokens'));
          const current = await api.peer(which());
          const caps = perRequest || perDay ? { ...current.peer.caps, ...(perRequest ? { perRequest } : {}), ...(perDay ? { perDay } : {}) } : undefined;
          const p = await api.updatePeer(which(), { autoAccept: mode === 'on', ...(caps ? { caps } : {}) });
          const lim = (s?: { usd?: number; tokens?: number }) => (s ? [s.usd !== undefined ? '$' + s.usd : '', s.tokens !== undefined ? s.tokens + ' tokens' : ''].filter(Boolean).join(' + ') : 'not set');
          ctx.print(p, () => p.label + ': auto-accept ' + (p.autoAccept ? 'on' : 'off') + ' (per request ' + lim(p.caps.perRequest) + ', per day ' + lim(p.caps.perDay) + '). ' + (p.autoAccept ? 'Its requests start without waiting for you; you are told of each and can decline it.' : '') + '\n');
          return;
        }
        case 'shares': {
          const p = await api.updatePeer(which(), { shares: visibility(rest[1]) });
          ctx.print(p, () => `${p.label} may see ${p.shares}${p.shares === 'full' && p.trust !== 'trusted' ? ' (in effect only once it is trusted: ih peer trust)' : ''}\n`);
          return;
        }
        case 'enable':
        case 'disable': {
          const p = await api.updatePeer(which(), { enabled: sub === 'enable' });
          ctx.print(p, () => `${p.label} ${sub}d\n`);
          return;
        }
        case 'rename': {
          if (!rest[1]) throw new UsageError('give the new label');
          const p = await api.updatePeer(which(), { label: rest[1] });
          ctx.print(p, () => `renamed to "${p.label}"\n`);
          return;
        }
        case 'remove': {
          await api.removePeer(which());
          ctx.print({ ok: true }, () => `removed ${rest[0]}\n`);
          return;
        }
        case 'poll': {
          const p = await api.pollPeer(which());
          ctx.print(p, () => `${p.label}: ${linkText(p)}${p.lastError ? ` (${p.lastError})` : ''}\n`);
          return;
        }
        case 'projects': {
          const hits = await api.peerProjects(rest.join(' ') || undefined);
          ctx.print(hits, () => (hits.length ? table(hits.map((h) => [h.peer.name ?? h.peer.label, h.card.id, h.card.name, h.card.accepts.requests ? 'yes' : 'no', h.card.provides.slice(0, 3).join(', '), h.card.oneLine]), ['SWARM', 'PROJECT', 'NAME', 'REQUESTS', 'PROVIDES', 'ABOUT'], 50) : 'No cached peer project matches.\n'));
          return;
        }
        case 'request': {
          const title = rest.slice(1).join(' ');
          if (!rest[0] || !title) throw new UsageError('ih peer request <peer> <title…> --description TEXT [--project ID] [--blocking]');
          const description = str(ctx.values.description);
          if (!description) throw new UsageError('describe it: --description "what is wrong, how to reproduce it, or the spec"');
          const maxUsd = str(ctx.values['max-usd']);
          const r = await api.sendPeerRequest({
            peer: rest[0],
            title,
            description,
            project: str(ctx.values.project),
            blocking: Boolean(ctx.values.blocking),
            acceptance: list(str(ctx.values.acceptance)),
            milestones: list(str(ctx.values.milestones)),
            ...(maxUsd || str(ctx.values['max-tokens']) ? { budget: { ...(maxUsd ? { maxUsd: Number(maxUsd) } : {}), ...(str(ctx.values['max-tokens']) ? { maxTokens: Number(str(ctx.values['max-tokens'])) } : {}) } } : {}),
          });
          ctx.print(r, () => `${r.id}: ${r.status}${r.remoteId ? '' : ' (not delivered yet; it is retried each round)'}. Follow it with \`ih request show ${r.id}\`.\n`);
          return;
        }
        default:
          throw new UsageError(`unknown peer command "${sub}"`);
      }
    });
  },
};

export const PROJECT: Command = {
  name: 'project',
  usage: 'ih project [list] | draft [--mode fastlane|orchestrator] | set --one-line … --provides a;b --accepts yes|no | publish [basic|full] | unpublish   (the board is --board)',
  summary: 'The projects this swarm shares with its peers: draft a card, review it, publish it',
  options: {
    mode: { type: 'string', hint: 'fastlane|orchestrator' },
    name: { type: 'string' },
    'one-line': { type: 'string' },
    about: { type: 'string' },
    provides: { type: 'string', hint: 'one;two' },
    uses: { type: 'string', hint: 'one;two' },
    accepts: { type: 'string', hint: 'yes|no' },
    note: { type: 'string' },
  },
  async run(ctx) {
    const [sub = 'list', ...rest] = ctx.args;
    await withApi(ctx, async (api) => {
      if (sub === 'list') {
        const shared = await api.sharedProjects();
        ctx.print(shared, () =>
          table(shared.map((s) => [s.boardId, s.boardName, s.visibility, s.published ? (s.dirty ? 'published (edited since)' : 'published') : s.draft ? 'draft' : '-', s.draft?.accepts.requests ? 'yes' : 'no']), ['BOARD', 'NAME', 'SHARED AT', 'STATE', 'TAKES REQUESTS']),
        );
        return;
      }
      const board = await resolveBoard(api, ctx.flags.board, ctx.io);
      const show = (s: { draft: unknown }) => (s.draft ? JSON.stringify(s.draft, null, 2) + '\n' : 'no draft yet\n');
      switch (sub) {
        case 'show': {
          const s = (await api.sharedProjects()).find((x) => x.boardId === board.id)!;
          ctx.print(s, () => show(s));
          return;
        }
        case 'draft': {
          const out = await api.draftProject(board.id, str(ctx.values.mode) as 'fastlane' | 'orchestrator' | undefined);
          ctx.print(out, () => (out.started ? `the orchestrator is writing it (card ${out.started.id}); check \`ih project show\` in a minute\n` : `drafted:\n${show(out.shared!)}Review it, then \`ih project publish\`.\n`));
          return;
        }
        case 'set': {
          const current = (await api.sharedProjects()).find((x) => x.boardId === board.id)?.draft;
          if (!current) throw new UsageError('there is no draft yet: ih project draft');
          const accepts = str(ctx.values.accepts);
          const next = {
            ...current,
            ...(str(ctx.values.name) ? { name: str(ctx.values.name) } : {}),
            ...(str(ctx.values['one-line']) ? { oneLine: str(ctx.values['one-line']) } : {}),
            ...(str(ctx.values.about) ? { about: str(ctx.values.about) } : {}),
            ...(list(str(ctx.values.provides)) ? { provides: list(str(ctx.values.provides)) } : {}),
            ...(list(str(ctx.values.uses)) ? { uses: list(str(ctx.values.uses)) } : {}),
            accepts: { requests: accepts ? accepts === 'yes' : current.accepts.requests, note: str(ctx.values.note) ?? current.accepts.note },
          };
          const s = await api.saveProjectDraft(board.id, next);
          ctx.print(s, () => `saved:\n${show(s)}`);
          return;
        }
        case 'publish': {
          const s = await api.publishProject(board.id, visibility(rest[0] ?? 'basic'));
          ctx.print(s, () => `published at ${s.visibility}. A peer gets at most that, and full only when it is trusted. \`ih peer preview <peer>\` shows exactly what one receives.\n`);
          return;
        }
        case 'unpublish': {
          const s = await api.unpublishProject(board.id);
          ctx.print(s, () => 'no longer shared.\n');
          return;
        }
        default:
          throw new UsageError(`unknown project command "${sub}"`);
      }
    });
  },
};

export const REQUEST: Command = {
  name: 'request',
  usage: 'ih request [list] [--in|--out] | show <id> | approve|decline|ask|landed|cannot-reproduce|comment|cancel|confirm <id> [text…] | reopen <id> <what is still wrong…> | milestone <id> <n> [--undo] | budget <id> [--max-usd N] [--max-tokens N]',
  summary: 'Requests between swarms: ones peers sent you (decide them) and ones you sent (follow them)',
  options: { in: { type: 'boolean' }, out: { type: 'boolean' }, all: { type: 'boolean' }, undo: { type: 'boolean' }, 'max-usd': { type: 'string' }, 'max-tokens': { type: 'string' }, note: { type: 'string', short: 'n' }, ref: { type: 'string', hint: 'commit, PR URL or version' } },
  async run(ctx) {
    const [sub = 'list', ...rest] = ctx.args;
    await withApi(ctx, async (api) => {
      const id = () => {
        if (!rest[0]) throw new UsageError(`which request? ih request ${sub} <id>`);
        return rest[0];
      };
      const text = (what: string) => {
        const t = rest.slice(1).join(' ') || str(ctx.values.note);
        if (!t) throw new UsageError(`give ${what}: ih request ${sub} <id> <text…>`);
        return t;
      };
      const done = (r: FedRequest, verb: string) => ctx.print(r, () => `${verb}: ${r.title} (${r.status})\n`);
      switch (sub) {
        case 'list': {
          const rows = await api.peerRequests({ direction: ctx.values.in ? 'in' : ctx.values.out ? 'out' : undefined, open: !ctx.values.all });
          ctx.print(rows, () => (rows.length ? table(rows.map(requestRow), REQUEST_HEAD, 50) : 'No open requests. (--all includes finished ones.)\n'));
          return;
        }
        case 'show': {
          const r = await api.peerRequest(id());
          ctx.print(r, () => requestText(r));
          return;
        }
        case 'approve':
          return done(await api.approvePeerRequest(id(), rest.slice(1).join(' ') || str(ctx.values.note)), 'approved; the orchestrator plans it');
        case 'decline':
          return done(await api.declinePeerRequest(id(), text('a reason the sender will read')), 'declined');
        case 'ask':
          return done(await api.askPeerInfo(id(), text('your question')), 'asked');
        case 'cannot-reproduce':
          return done(await api.cannotReproducePeerRequest(id(), rest.slice(1).join(' ') || str(ctx.values.note) || ''), 'reported');
        case 'landed': {
          const ref = str(ctx.values.ref);
          const note = rest.slice(1).join(' ') || str(ctx.values.note);
          return done(await api.landPeerRequest(id(), { ...(ref ? { ref } : {}), ...(note ? { note } : {}) }), 'marked landed');
        }
        case 'comment':
          return done(await api.commentPeerRequest(id(), text('your comment')), 'sent');
        case 'cancel':
          return done(await api.cancelPeerRequest(id()), 'cancelled');
        case 'confirm':
          return done(await api.confirmPeerRequest(id()), 'confirmed');
        case 'reopen':
          return done(await api.reopenPeerRequest(id(), text('what is still wrong')), 'sent back');
        case 'milestone': {
          const n = Number(rest[1]);
          if (!Number.isInteger(n)) throw new UsageError('which milestone? ih request milestone <id> <number from 0>');
          return done(await api.markPeerMilestone(id(), n, !ctx.values.undo), ctx.values.undo ? 'milestone taken back' : 'milestone reached');
        }
        case 'budget': {
          const usd = str(ctx.values['max-usd']);
          const tokens = str(ctx.values['max-tokens']);
          return done(await api.setPeerRequestBudget(id(), usd || tokens ? { ...(usd ? { maxUsd: Number(usd) } : {}), ...(tokens ? { maxTokens: Number(tokens) } : {}) } : null), 'budget set');
        }
        default:
          throw new UsageError(`unknown request command "${sub}"`);
      }
    });
  },
};
