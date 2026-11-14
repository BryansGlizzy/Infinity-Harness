// The link chip in the status strip: what it says for an add-on's connection state.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddonView } from '@ih/core';
import { applyAddonView, linkSummaries } from '../src/addonLink.ts';

const view = (over: Partial<AddonView> = {}, components: AddonView['components'] = []): AddonView => ({
  id: 'roblox', label: 'Roblox Studio', description: '', enabled: true, available: true, reasons: [], warnings: [], heldBy: null, willCreate: [], ready: null, advice: null, components, ...over,
});
const mcp = { id: 'roblox-studio', label: 'Roblox Studio', kind: 'mcp' as const, state: 'running' as const };
const sync = (state: 'running' | 'error' | 'starting') => ({ id: 'rbxsync-serve', label: 'RbxSync file sync', kind: 'service' as const, state, ...(state === 'running' ? { detail: 'serving /p on port 44755' } : {}) });
const plugin = (id: string, label: string, connected: boolean) => ({ id: `roblox:${id}`, label, kind: 'plugin' as const, state: (connected ? 'running' : 'stopped') as 'running' | 'stopped', detail: connected ? '1 place connected' : 'press Connect' });

test('nothing is shown for an add-on that is off, or one with nothing to watch', () => {
  assert.deepEqual(linkSummaries([view({ enabled: false }, [sync('running')])]), []);
  assert.deepEqual(linkSummaries([view({}, [mcp])]), [], 'MCP servers alone are not a link');
});

test('all connected is ok, with short names for the parts', () => {
  const [s] = linkSummaries([view({ ready: true }, [mcp, sync('running'), plugin('studio-plugin', 'Studio MCP plugin', true), plugin('rbxsync-plugin', 'RbxSync plugin', true)])]);
  assert.equal(s!.state, 'ok');
  assert.deepEqual(s!.parts.map((p) => p.label), ['RbxSync sync', 'Studio', 'RbxSync']);
  assert.equal(s!.advice, null);
});

test('one part down makes the whole link bad and carries the advice; the part says why', () => {
  const [s] = linkSummaries([view({ ready: false, advice: 'RbxSync plugin: press Connect.' }, [sync('running'), plugin('studio-plugin', 'Studio MCP plugin', true), plugin('rbxsync-plugin', 'RbxSync plugin', false)])]);
  assert.equal(s!.state, 'bad');
  assert.equal(s!.advice, 'RbxSync plugin: press Connect.');
  assert.match(s!.parts.find((p) => p.label === 'RbxSync')!.detail, /not connected: press Connect/);
  assert.equal(s!.parts.find((p) => p.label === 'Studio')!.state, 'ok');
});

test('a stopped sync process is bad even before the plugins are read; starting and unread are unknown, not bad', () => {
  assert.equal(linkSummaries([view({}, [sync('error')])])[0]!.state, 'bad');
  assert.equal(linkSummaries([view({}, [sync('starting')])])[0]!.state, 'unknown');
  assert.equal(linkSummaries([view({}, [sync('running')])])[0]!.state, 'unknown', 'running, but Studio\'s side not read yet');
});

test('a pushed view replaces that add-on in the list, or joins it', () => {
  const a = view({ id: 'a' });
  const b = view({ id: 'b' });
  assert.deepEqual(applyAddonView([a, b], { ...a, enabled: false }).map((x) => [x.id, x.enabled]), [['a', false], ['b', true]]);
  assert.equal(applyAddonView([a], b).length, 2);
});
