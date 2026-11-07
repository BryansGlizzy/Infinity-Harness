import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cardAgent, delegationTargets, effectiveAgents, validateAgents, type AgentProfile } from '../src/index.ts';

const agent = (id: string, poolId: string, role: AgentProfile['role'] = 'worker', delegatesTo: string[] = []): AgentProfile => ({
  id,
  poolId,
  model: '',
  role,
  delegatesTo,
  enabled: true,
});

test('effectiveAgents: saved agents on configured pools, plus a default worker for pools without a worker or lead', () => {
  const pools = [{ id: 'claude' }, { id: 'agy' }, { id: 'nim' }];
  const agents = effectiveAgents(
    { agents: [agent('orchestrator', 'claude', 'orchestrator'), agent('agy-argon', 'agy'), agent('gone', 'kimi')] },
    pools,
  );
  assert.deepEqual(
    agents.map((a) => [a.id, a.poolId, a.role, !!a.implicit]),
    [
      ['orchestrator', 'claude', 'orchestrator', false],
      ['agy-argon', 'agy', 'worker', false],
      // An orchestrator doesn't cover its pool: Claude still gets a worker. agy has one, so no default is added.
      ['claude', 'claude', 'worker', true],
      ['nim', 'nim', 'worker', true],
    ],
  );
  // A default worker never clashes with a saved id.
  const clash = effectiveAgents({ agents: [agent('nim', 'claude', 'orchestrator')] }, [{ id: 'claude' }, { id: 'nim' }]);
  assert.deepEqual(clash.map((a) => a.id), ['nim', 'claude', 'nim-worker']);
});

test('validateAgents: unknown or orchestrator targets, delegating workers, duplicate ids and cycles are refused', () => {
  const ok = [agent('o', 'claude', 'orchestrator', ['lead', 'agy']), agent('lead', 'claude', 'lead', ['nim']), agent('agy', 'agy'), agent('nim', 'nim')];
  assert.equal(validateAgents(ok), null);
  assert.match(validateAgents([agent('o', 'claude', 'orchestrator', ['x'])])!, /unknown agent "x"/);
  assert.match(validateAgents([agent('w', 'agy', 'worker', ['o']), agent('o', 'claude', 'orchestrator')])!, /is a worker/);
  assert.match(validateAgents([agent('l', 'claude', 'lead', ['o']), agent('o', 'claude', 'orchestrator')])!, /cannot delegate to the orchestrator/);
  assert.match(validateAgents([agent('a', 'agy'), agent('a', 'nim')])!, /two agents are called "a"/);
  assert.match(validateAgents([agent('bad id', 'agy')])!, /must be 1–40/);
  assert.match(
    validateAgents([agent('a', 'claude', 'lead', ['b']), agent('b', 'kimi', 'lead', ['c']), agent('c', 'agy', 'lead', ['a'])])!,
    /delegation cycle: a → b → c → a/,
  );
});

test('delegationTargets and cardAgent: explicit targets, the default team, and the orchestrator fallback', () => {
  const agents = [
    agent('o', 'claude', 'orchestrator'),
    agent('lead', 'claude', 'lead', ['nim']),
    agent('agy', 'agy'),
    agent('nim', 'nim'),
    { ...agent('off', 'kimi'), enabled: false },
  ];
  const ids = (list: AgentProfile[]) => list.map((a) => a.id);
  assert.deepEqual(ids(delegationTargets(agents[1], 'lead', agents)), ['nim']);
  // No targets set: every enabled worker, and leads too for the orchestrator.
  assert.deepEqual(ids(delegationTargets(agents[0], 'orchestrator', agents)), ['lead', 'agy', 'nim']);
  assert.deepEqual(ids(delegationTargets(undefined, 'lead', agents)), ['agy', 'nim']);
  // An orchestrator card that ran on a fallback pool still plans as the orchestrator; a role mismatch is ignored.
  assert.equal(cardAgent({ agentId: 'agy', role: 'orchestrator' }, agents)?.id, 'o');
  assert.equal(cardAgent({ agentId: 'lead', role: 'lead' }, agents)?.id, 'lead');
  assert.equal(cardAgent({ agentId: 'agy', role: 'lead' }, agents), undefined);
});
