// The operator's side of federation: REST routes on the main daemon port for the web UI, VS Code, `ih` and the TUI.
// (Peers never see these; they use the federation listener, routes.ts.)
import type { FastifyInstance } from 'fastify';
import type { Visibility } from '@ih/core';
import { Federation, FederationError } from './service.ts';

const body = (req: { body?: unknown }) => (req.body ?? {}) as Record<string, any>;

export function registerFederationApi(app: FastifyInstance, fed: Federation) {
  const E = FederationError;

  app.get('/api/federation', async () => ({
    ...fed.state(),
    peers: fed.listPeers(),
    shared: fed.listShared(),
    needs: fed.needs(),
  }));
  app.patch('/api/federation/settings', async (req) => fed.updateSettings(body(req)));

  // --- peers
  app.get('/api/federation/peers', async () => fed.listPeers());
  app.post('/api/federation/peers', async (req) => {
    const b = body(req);
    if (typeof b.label !== 'string') throw new E(400, 'label is required');
    return fed.addPeer({
      label: b.label,
      ssh: b.ssh && typeof b.ssh === 'object' ? b.ssh : undefined,
      url: typeof b.url === 'string' ? b.url : undefined,
      expectedFingerprint: typeof b.expectedFingerprint === 'string' ? b.expectedFingerprint : undefined,
      shares: b.shares as Visibility | undefined,
    });
  });
  app.get<{ Params: { id: string } }>('/api/federation/peers/:id', async (req) => {
    const peer = fed.getPeer(req.params.id);
    return { peer, projects: fed.peerProjects(peer.id), requests: fed.listRequests({ peer: peer.id }) };
  });
  app.patch<{ Params: { id: string } }>('/api/federation/peers/:id', async (req) => {
    const b = body(req);
    let peer = fed.getPeer(req.params.id);
    if (typeof b.label === 'string') peer = fed.renamePeer(peer.id, b.label);
    if (b.ssh || b.url) peer = fed.setPeerAddress(peer.id, { ssh: b.ssh, url: b.url });
    if (b.trust !== undefined) peer = fed.setTrust(peer.id, b.trust);
    if (b.autoAccept !== undefined || b.caps !== undefined) peer = fed.setAutoAccept(peer.id, b.autoAccept ?? peer.autoAccept, b.caps);
    if (b.shares !== undefined) peer = fed.setShares(peer.id, b.shares);
    if (typeof b.enabled === 'boolean') peer = fed.setEnabled(peer.id, b.enabled);
    return peer;
  });
  app.delete<{ Params: { id: string } }>('/api/federation/peers/:id', async (req) => {
    fed.removePeer(req.params.id);
    return { ok: true };
  });
  app.post<{ Params: { id: string } }>('/api/federation/peers/:id/decide', async (req) => {
    const decision = body(req).decision;
    if (decision !== 'approve' && decision !== 'deny' && decision !== 'block') throw new E(400, 'decision is approve, deny or block');
    return { peer: fed.decideKnock(req.params.id, decision) };
  });
  app.post<{ Params: { id: string } }>('/api/federation/peers/:id/poll', async (req) => {
    const peer = fed.getPeer(req.params.id);
    await fed.pollPeer(peer.id);
    return fed.getPeer(peer.id);
  });
  app.get<{ Params: { id: string } }>('/api/federation/peers/:id/preview', async (req) => fed.preview(req.params.id));
  app.get<{ Querystring: { q?: string } }>('/api/federation/projects', async (req) =>
    req.query.q ? fed.searchPeerProjects(req.query.q, 20) : fed.peerProjects().map((p) => ({ peer: fed.getPeer(p.peerId), card: p.card, score: 0 })),
  );

  // Projects that can be named in a prompt with @swarm/project
  app.get('/api/federation/mentions', async () => fed.mentions());

  // --- the projects we share
  app.get('/api/federation/shared', async () => fed.listShared());
  app.post<{ Params: { board: string } }>('/api/federation/shared/:board/draft', async (req) => fed.draft(req.params.board, body(req).mode));
  app.put<{ Params: { board: string } }>('/api/federation/shared/:board/draft', async (req) => fed.saveDraft(req.params.board, body(req).card, 'manual'));
  app.post<{ Params: { board: string } }>('/api/federation/shared/:board/publish', async (req) => fed.publish(req.params.board, body(req).visibility ?? 'basic'));
  app.post<{ Params: { board: string } }>('/api/federation/shared/:board/unpublish', async (req) => fed.unpublish(req.params.board));

  // --- requests
  app.get<{ Querystring: { direction?: string; peer?: string; open?: string } }>('/api/federation/requests', async (req) =>
    fed.listRequests({ direction: req.query.direction === 'in' || req.query.direction === 'out' ? req.query.direction : undefined, peer: req.query.peer, open: req.query.open === '1' }),
  );
  app.post('/api/federation/requests', async (req) => {
    const b = body(req);
    if (typeof b.peer !== 'string') throw new E(400, 'peer is required');
    return fed.sendRequest(b.peer, { title: String(b.title ?? ''), description: String(b.description ?? ''), project: b.project ?? null, blocking: b.blocking === true, acceptance: b.acceptance, milestones: b.milestones, budget: b.budget ?? null, cardId: b.cardId ?? null });
  });
  app.get<{ Params: { id: string } }>('/api/federation/requests/:id', async (req) => fed.getRequest(req.params.id));
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/approve', async (req) => fed.approveRequest(req.params.id, body(req).note));
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/decline', async (req) => fed.declineRequest(req.params.id, String(body(req).reason ?? '')));
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/info', async (req) => fed.askForInfo(req.params.id, String(body(req).question ?? '')));
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/cannot-reproduce', async (req) => fed.cannotReproduce(req.params.id, String(body(req).note ?? '')));
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/landed', async (req) => fed.markLanded(req.params.id, { ref: body(req).ref, note: body(req).note }));
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/comment', async (req) => {
    const r = fed.getRequest(req.params.id);
    const text = String(body(req).text ?? '');
    return r.direction === 'in' ? fed.receiverComment(r.id, text) : fed.commentOnRequest(r.id, text);
  });
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/reopen', async (req) => fed.reopenRequest(req.params.id, String(body(req).reason ?? '')));
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/milestone', async (req) => fed.markMilestone(req.params.id, Number(body(req).index), body(req).done !== false));
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/budget', async (req) => {
    const b = body(req);
    return fed.setBudget(req.params.id, b.maxUsd === undefined && b.maxTokens === undefined ? null : { maxUsd: b.maxUsd, maxTokens: b.maxTokens });
  });
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/cancel', async (req) => fed.cancelRequest(req.params.id));
  app.post<{ Params: { id: string } }>('/api/federation/requests/:id/confirm', async (req) => fed.confirmRequest(req.params.id));
}
