// The federation listener (master plan Phase 7): a second, loopback-only HTTP server that serves ONLY /fed/*.
//
// Peers reach it through an SSH forward they (or we) open. A forward to the main daemon port would expose the whole
// operator API to anyone who may SSH in; this port exposes nothing but signed federation routes, and an sshd account
// can be limited to it with `PermitOpen`. The connection says nothing about who is calling: SSH forwards arrive from
// loopback. Identity is the signature alone, and every route but the knock needs a signer we have accepted.
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { Peer } from '@ih/core';
import { signResponse, verifyRequest } from './identity.ts';
import { cleanHello, cleanRequestWire, cleanText, validId } from './protocol.ts';
import { Federation, FederationError } from './service.ts';

interface Authenticated {
  nonce: string;
  swarmId: string;
  publicKey: string;
}

export async function buildFedServer(fed: Federation): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  // The signature covers the exact bytes, so the body is kept as text and parsed only after it checks out.
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => done(null, body));
  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    reply.status(err.statusCode && err.statusCode < 500 ? err.statusCode : 500).send({ error: err.statusCode && err.statusCode < 500 ? err.message : 'error' });
  });

  /** Answers with a signature over the exact text sent, bound to the request's nonce. */
  const answer = (reply: FastifyReply, auth: Authenticated, status: number, body: unknown) => {
    const text = JSON.stringify(body);
    return reply.status(status).headers(signResponse(fed.identity, { nonce: auth.nonce, status, body: text })).type('application/json').send(text);
  };

  /** Checks the signature, the rate and the nonce. Returns the caller, or sends the refusal itself. */
  const authenticate = (req: FastifyRequest, reply: FastifyReply): Authenticated | null => {
    const body = typeof req.body === 'string' ? req.body : '';
    const verified = verifyRequest(req.headers, { method: req.method, path: req.url, body }, { swarmId: fed.identity.swarmId });
    if (typeof verified === 'string') {
      reply.status(401).send({ error: verified });
      return null;
    }
    const known = !!fed.store.fed.peerBySwarm(verified.swarmId);
    if (!fed.allowCall(verified.swarmId, known)) {
      reply.status(429).send({ error: 'slow down' });
      return null;
    }
    if (!fed.store.fed.useNonce(verified.nonce, verified.ts)) {
      reply.status(401).send({ error: 'replayed' });
      return null;
    }
    return { nonce: verified.nonce, swarmId: verified.swarmId, publicKey: verified.publicKey };
  };

  const parse = (req: FastifyRequest): unknown => {
    const text = typeof req.body === 'string' ? req.body : '';
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      throw new FederationError(400, 'the body is not JSON');
    }
  };

  /** Routes for accepted peers: the handler gets the peer and the parsed body; errors are answered signed. */
  const route = (method: 'GET' | 'POST', url: string, handler: (peer: Peer, req: FastifyRequest<{ Params: { id: string } }>, body: unknown) => unknown) => {
    app.route<{ Params: { id: string } }>({
      method,
      url,
      handler: async (req, reply) => {
        const auth = authenticate(req, reply);
        if (!auth) return reply;
        try {
          const peer = fed.callerPeer(auth.swarmId);
          // Unknown, waiting and blocked callers all get the same answer.
          if (!peer) return answer(reply, auth, 403, { error: 'not an accepted peer' });
          if (req.params?.id !== undefined && !validId(req.params.id)) throw new FederationError(400, 'bad id');
          return answer(reply, auth, 200, handler(peer, req, method === 'POST' ? parse(req) : {}));
        } catch (err) {
          if (err instanceof FederationError) return answer(reply, auth, err.statusCode, { error: err.message });
          throw err;
        }
      },
    });
  };

  // Proves something is listening (the SSH forward's own health check). Says nothing else.
  app.get('/fed/health', async () => ({ ok: true }));

  // The knock, and every later round: our directory for theirs. An unknown swarm gets silence.
  app.post('/fed/hello', async (req, reply) => {
    const auth = authenticate(req, reply);
    if (!auth) return reply;
    try {
      const hello = cleanHello(parse(req));
      if (!hello) throw new FederationError(400, 'a hello carries the swarm\'s name');
      const out = fed.handleHello({ swarmId: auth.swarmId, publicKey: auth.publicKey }, hello);
      // "pending" carries nothing about us and is not signed: we have not agreed to be identified to this swarm yet.
      if (out.state === 'pending') return reply.status(200).send({ state: 'pending' });
      return answer(reply, auth, 200, out);
    } catch (err) {
      if (err instanceof FederationError) return reply.status(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  route('POST', '/fed/requests', (peer, _req, body) => {
    const wire = cleanRequestWire(body);
    if (typeof wire === 'string') throw new FederationError(400, wire);
    return fed.receiveRequest(peer, wire);
  });
  route('GET', '/fed/requests/:id', (peer, req) => fed.status(peer, req.params.id));
  route('POST', '/fed/requests/:id/comment', (peer, req, body) => fed.senderComment(peer, req.params.id, cleanText((body as { text?: string }).text, 4000)));
  route('POST', '/fed/requests/:id/cancel', (peer, req) => fed.senderCancel(peer, req.params.id));
  route('POST', '/fed/requests/:id/done', (peer, req) => fed.senderDone(peer, req.params.id));
  route('POST', '/fed/requests/:id/reopen', (peer, req, body) => fed.senderReopen(peer, req.params.id, cleanText((body as { text?: string }).text, 4000)));

  app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'not found' }));
  return app;
}
