// Loads the bundled extension (dist/extension.cjs, built first) with a stand-in `vscode` module and activates it
// against a real in-process daemon: every contributed command is registered, the workspace binds to its board,
// the Cards and Needs-you views fill from the API, and the status bar follows. No VS Code window needed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import Module from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { setup, status, waitFor } from '../../daemon/test/harness.ts';

const dir = fileURLToPath(new URL('..', import.meta.url));
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

class EventEmitter<T> {
  private listeners: ((e: T) => void)[] = [];
  event = (fn: (e: T) => void) => {
    this.listeners.push(fn);
    return { dispose: () => (this.listeners = this.listeners.filter((l) => l !== fn)) };
  };
  fire(e: T) {
    for (const l of this.listeners) l(e);
  }
  dispose() {
    this.listeners = [];
  }
}

/** Just enough of the vscode API for activation, the views and the commands this test runs. */
function fakeVscode(opts: { folder: string; daemonUrl: string }) {
  const commands = new Map<string, (...a: any[]) => unknown>();
  const views = new Map<string, { provider: any; view: any }>();
  const webviews = new Map<string, any>();
  const controllers: any[] = [];
  /** What the human does when the extension asks: each hook returns the pick / typed answer / button. */
  const hooks = {
    pick: (_items: any, _opts: any): unknown => undefined,
    input: (_opts: any): string | undefined => undefined,
    warn: undefined as string | undefined,
  };
  const diagnostics = new Map<string, any[]>();
  const diagnosticListeners: ((e: { uris: unknown[] }) => void)[] = [];
  const diffs: unknown[][] = [];
  const context = new Map<string, unknown>();
  const shown: string[] = [];
  const uri = (fsPath: string) => ({ scheme: 'file', fsPath, path: fsPath, toString: () => `file://${fsPath}` });
  const statusItem = { text: '', tooltip: '' as any, command: undefined as string | undefined, show() {}, dispose() {} };
  const vscode = {
    EventEmitter,
    TreeItem: class {
      label: string;
      collapsibleState: number;
      constructor(label: string, state = 0) {
        this.label = label;
        this.collapsibleState = state;
      }
    },
    ThemeIcon: class {
      id: string;
      constructor(id: string) {
        this.id = id;
      }
    },
    ThemeColor: class {
      constructor(_id: string) {}
    },
    MarkdownString: class {
      value = '';
      constructor(v = '') {
        this.value = v;
      }
      appendMarkdown(s: string) {
        this.value += s;
        return this;
      }
    },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ViewColumn: { Active: -1 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    CommentMode: { Editing: 0, Preview: 1 },
    Range: class {
      start: { line: number; character: number };
      end: { line: number; character: number };
      constructor(a: number, b: number, c: number, d: number) {
        this.start = { line: a, character: b };
        this.end = { line: c, character: d };
      }
    },
    Uri: {
      file: uri,
      parse: (s: string) => ({ toString: () => s }),
      joinPath: (base: { fsPath: string }, ...parts: string[]) => uri([base.fsPath, ...parts].join('/')),
      from: (c: object) => c,
    },
    env: { asExternalUri: async (u: unknown) => u },
    languages: {
      getDiagnostics: (uri?: { fsPath: string }) => (uri ? (diagnostics.get(uri.fsPath) ?? []) : []),
      onDidChangeDiagnostics: (fn: (e: { uris: unknown[] }) => void) => (diagnosticListeners.push(fn), { dispose() {} }),
    },
    comments: {
      createCommentController: (id: string, label: string) => {
        const c = { id, label, options: undefined as unknown, commentingRangeProvider: undefined as any, dispose() {} };
        controllers.push(c);
        return c;
      },
    },
    window: {
      createTreeView: (id: string, o: { treeDataProvider: any }) => {
        const view = { badge: undefined as unknown, onDidChangeVisibility: () => ({ dispose() {} }), dispose() {} };
        views.set(id, { provider: o.treeDataProvider, view });
        return view;
      },
      createStatusBarItem: () => statusItem,
      registerWebviewViewProvider: (id: string, provider: unknown) => (webviews.set(id, provider), { dispose() {} }),
      showInformationMessage: async (m: string) => (shown.push(m), undefined),
      showWarningMessage: async (m: string) => (shown.push(m), hooks.warn),
      showErrorMessage: async (m: string) => (shown.push(`ERROR ${m}`), undefined),
      setStatusBarMessage: () => ({ dispose() {} }),
      showInputBox: async (o: unknown) => hooks.input(o),
      showQuickPick: async (items: unknown, o: unknown) => hooks.pick(items, o),
      activeTextEditor: undefined,
    },
    commands: {
      registerCommand: (id: string, fn: (...a: any[]) => unknown) => (commands.set(id, fn), { dispose() {} }),
      executeCommand: async (id: string, ...args: unknown[]) => {
        if (id === 'setContext') return void context.set(String(args[0]), args[1]);
        if (id === 'vscode.diff') return void diffs.push(args);
        return commands.get(id)?.(...args);
      },
    },
    workspace: {
      name: 'demo',
      workspaceFolders: [{ uri: uri(opts.folder) }],
      getConfiguration: () => ({ get: (k: string, d?: unknown) => ({ daemonUrl: opts.daemonUrl, notifications: 'all', editorContext: true } as Record<string, unknown>)[k] ?? d }),
      openTextDocument: async (u: { fsPath: string }) => ({ uri: u, lineCount: 10 }),
      registerTextDocumentContentProvider: () => ({ dispose() {} }),
      onDidChangeConfiguration: () => ({ dispose() {} }),
      onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
      asRelativePath: (u: { fsPath: string }) => u.fsPath,
    },
  };
  const memento = () => {
    const m = new Map<string, unknown>();
    return { get: (k: string) => m.get(k), update: async (k: string, v: unknown) => void m.set(k, v) };
  };
  const extContext = { subscriptions: [] as { dispose(): void }[], workspaceState: memento(), globalState: memento(), extensionUri: uri(dir) };
  return { vscode, commands, views, webviews, controllers, hooks, diagnostics, diagnosticListeners, diffs, context, shown, statusItem, extContext };
}

/** Requires the bundle with `vscode` resolved to the fake. */
function loadExtension(fake: object) {
  const require = createRequire(import.meta.url);
  const M = Module as unknown as { _resolveFilename: (r: string, ...a: unknown[]) => string };
  const original = M._resolveFilename;
  const stub = resolve(dir, 'test', '__vscode_stub__.cjs');
  M._resolveFilename = function (request: string, ...rest: unknown[]) {
    return request === 'vscode' ? stub : original.call(this, request, ...rest);
  };
  require.cache[stub] = { id: stub, filename: stub, loaded: true, exports: fake } as never;
  // Normalised, so the cache entry of an earlier load is really dropped (a doubled slash would miss it).
  const bundle = resolve(dir, 'dist', 'extension.cjs');
  delete require.cache[bundle];
  try {
    return require(bundle) as { activate(ctx: unknown): void; deactivate(): void };
  } finally {
    M._resolveFilename = original;
  }
}

async function until(fn: () => boolean, ms = 5000) {
  for (let t = 0; t < ms && !fn(); t += 25) await new Promise((r) => setTimeout(r, 25));
  assert.ok(fn(), 'timed out');
}

test('the bundled extension activates, binds the workspace to its board and drives the views and commands', async () => {
  // Same options as the package's build script.
  await build({ absWorkingDir: dir, entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true, outfile: 'dist/extension.cjs', logLevel: 'silent' });
  const { store, runner, board, repo, cfg, close } = await setup();
  const fake = fakeVscode({ folder: repo, daemonUrl: `http://127.0.0.1:${cfg.port}` });
  const ext = loadExtension(fake.vscode);
  try {
    ext.activate(fake.extContext);

    // Every command the manifest contributes is registered (and nothing the manifest doesn't know about, bar helpers).
    const contributed = manifest.contributes.commands.map((c: { command: string }) => c.command).sort();
    for (const id of contributed) assert.ok(fake.commands.has(id), `command ${id} is registered`);
    assert.deepEqual([...fake.commands.keys()].filter((id) => !contributed.includes(id)), ['infinityHarness.showText']);
    const treeViews = manifest.contributes.views.infinityHarness.filter((v: { type?: string }) => v.type !== 'webview').map((v: { id: string }) => v.id);
    assert.deepEqual([...fake.views.keys()].sort(), treeViews.sort());
    assert.deepEqual([...fake.webviews.keys()], ['infinityHarness.chat'], 'the chat view is a webview');
    assert.equal(fake.controllers[0].id, 'infinityHarness.review', 'the review comment controller is registered');

    await until(() => fake.context.get('infinityHarness.state') === 'ready');
    const cards = fake.views.get('infinityHarness.cards')!.provider;
    assert.deepEqual(cards.getChildren(), [], 'no cards yet');
    assert.match(fake.statusItem.text, /Demo/);

    // A parent with a worked child: the tree nests it, flags its branch for Show Changes, and the badge counts the notice.
    const parent = store.createCard({ boardId: board.id, title: 'Goal' });
    const child = store.createCard({ boardId: board.id, title: 'Write notes', parentId: parent.id });
    const done = waitFor(store, status(store, child.id, 'review'));
    await runner.run(child.id, 'fa');
    await done;
    await until(() => cards.getChildren().length === 1 && cards.getChildren()[0].collapsibleState === 2);
    const [top] = cards.getChildren();
    assert.equal(top.label, 'Goal');
    const [item] = cards.getChildren(top);
    assert.equal(item.label, 'Write notes');
    assert.match(item.contextValue, /\bcard\b.*\bbranch\b/);
    assert.match(item.description, /Review · fa/);
    assert.deepEqual(item.command, { command: 'infinityHarness.openCard', title: 'Open Card', arguments: [child.id] });

    const attention = fake.views.get('infinityHarness.attention')!;
    await until(() => attention.provider.getChildren().some((a: any) => a.kind === 'message' && a.message.fromActor === 'daemon:policy'));
    const notice = attention.provider.getTreeItem(attention.provider.getChildren().find((a: any) => a.kind === 'message'));
    assert.equal(notice.iconPath.id, 'shield');
    assert.deepEqual(notice.command.arguments, [child.id], 'a policy notice opens the card it names');
    await until(() => ((attention.view.badge as { value: number } | undefined)?.value ?? 0) >= 1);
    assert.ok(fake.shown.some((m) => m.startsWith('The board: "Write notes"')), 'the notice popped up (notifications: all)');

    // Blocked cards show up as needing a human, and the status bar keeps count.
    store.updateCard(parent.id, { status: 'blocked' });
    await until(() => attention.provider.getChildren().some((a: any) => a.kind === 'blocked'));
    assert.match(fake.statusItem.text, /bell-dot/);
    assert.ok(fake.shown.includes('Blocked: Goal'));
  } finally {
    ext.deactivate();
    for (const d of fake.extContext.subscriptions) d.dispose();
    await close();
  }
});

test('stage 2: the window answers agents over the IDE bridge, lists approvals, fills the chat view, and reviews cards', async () => {
  await build({ absWorkingDir: dir, entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true, outfile: 'dist/extension.cjs', logLevel: 'silent' });
  const { store, runner, board, repo, cfg, bridge, approvals, close } = await setup();
  const fake = fakeVscode({ folder: repo, daemonUrl: `http://127.0.0.1:${cfg.port}` });
  const ext = loadExtension(fake.vscode);
  const run = async (id: string) => {
    const done = waitFor(store, status(store, id, 'review'));
    await runner.run(id, 'fa', { agentId: 'fa' });
    await done;
  };
  try {
    ext.activate(fake.extContext);
    await until(() => fake.context.get('infinityHarness.state') === 'ready').catch((e) => { throw new Error(`state ${String(fake.context.get('infinityHarness.state'))}; shown ${fake.shown.join('|')}; ${e.message}`); });

    // --- the bridge: this window attaches to the board and answers the daemon's requests
    await until(() => bridge.attached(board.id));
    fake.hooks.pick = (items) => (items as string[])[1];
    assert.deepEqual(await bridge.request(board.id, 'ask', { question: 'Which database?', options: ['Postgres', 'SQLite'], title: 'Storage' }, 5000), { answer: 'SQLite' });
    fake.hooks.pick = () => undefined;
    assert.deepEqual(await bridge.request(board.id, 'ask', { question: 'Which database?', options: ['a', 'b'] }, 5000), { error: 'the human dismissed the question' });
    fake.hooks.input = () => 'whatever you like';
    assert.deepEqual(await bridge.request(board.id, 'ask', { question: 'Name?' }, 5000), { answer: 'whatever you like' });

    fake.diagnostics.set('/work/a.ts', [
      { severity: 0, range: { start: { line: 2, character: 4 } }, message: 'Cannot find name x', source: 'ts', code: 2304 },
      { severity: 2, range: { start: { line: 0, character: 0 } }, message: 'just info' },
    ]);
    assert.deepEqual(await bridge.request(board.id, 'diagnostics', { paths: ['/work/a.ts'] }, 5000), {
      files: [{ path: '/work/a.ts', problems: [{ severity: 'error', line: 3, column: 5, message: 'Cannot find name x', source: 'ts', code: 2304 }] }],
    });
    assert.deepEqual(await bridge.request(board.id, 'show_diff', { path: '/work/a.ts', proposed: 'new text\n', title: 'Proposed change: a.ts' }, 5000), { shown: true });
    const [left, right, title] = fake.diffs[0] as any[];
    assert.deepEqual([left.fsPath, right.scheme, title], ['/work/a.ts', 'infinity-harness-proposal', 'Proposed change: a.ts']);

    // --- approvals: listed in Needs you with a badge, decided from the window
    const card = store.createCard({ boardId: board.id, title: 'Worker', description: 'tidy' });
    await approvals.request({ boardId: board.id, cardId: card.id, kind: 'install_skill', payload: { skill: { name: 'tests', description: 'Run tests', body: 'Run pytest -q from the root.' } }, requestedBy: `card:${card.id}`, summary: 'Worker proposes the skill "tests"' });
    const attention = fake.views.get('infinityHarness.attention')!;
    await until(() => attention.provider.getChildren().some((a: any) => a.kind === 'approval'));
    const item = attention.provider.getChildren().find((a: any) => a.kind === 'approval');
    const treeItem = attention.provider.getTreeItem(item);
    assert.equal(treeItem.contextValue, 'approval');
    assert.equal(treeItem.description, 'Skill');
    assert.ok(fake.shown.some((m) => m.startsWith('Skill: Worker proposes the skill')), 'a pop-up with Decide');
    assert.ok(!fake.shown.some((m) => m.startsWith('The board: Approval needed')), 'not announced twice');
    fake.hooks.pick = (items) => (items as any[])[0];
    await fake.commands.get('infinityHarness.decideApproval')!(item.approval);
    assert.equal(store.getApproval(item.approval.id)!.status, 'approved');
    assert.equal(store.getSettings(board.id).skills[0]!.name, 'tests');
    await until(() => !attention.provider.getChildren().some((a: any) => a.kind === 'approval'));

    // An escalated card shows once, as the request to answer, not also as a blocked card.
    const stuck = store.createCard({ boardId: board.id, title: 'Stuck' });
    store.updateCard(stuck.id, { status: 'blocked', pipeline: { escalated: true } });
    await approvals.request({ boardId: board.id, cardId: stuck.id, kind: 'escalation', payload: { reason: 'which db?' }, requestedBy: `card:${stuck.id}`, summary: 'Stuck needs a human: which db?', announce: false });
    await until(() => attention.provider.getChildren().some((a: any) => a.kind === 'approval'));
    assert.ok(!attention.provider.getChildren().some((a: any) => a.kind === 'blocked' && a.card.id === stuck.id));
    const answer = attention.provider.getChildren().find((a: any) => a.kind === 'approval').approval;
    fake.hooks.input = () => 'SQLite.';
    await fake.commands.get('infinityHarness.approveApproval')!(answer);
    assert.equal(store.getApproval(answer.id)!.note, 'SQLite.');
    assert.notEqual(store.getCard(stuck.id)!.status, 'blocked', 'answering resumes the card');

    // --- the status bar tooltip lists pools and usage
    store.recordUsage({ poolId: 'fa', source: 'otel', boardId: board.id, inputTokens: 12_000, outputTokens: 3000, costUsd: 0.42 });
    await fake.commands.get('infinityHarness.refresh')!();
    await until(() => /Last 24h: 15k tokens · \$0\.42/.test(fake.statusItem.tooltip.value));
    assert.match(fake.statusItem.tooltip.value, /\*\*Fake A\*\* open/);

    // --- reviewing a card in the diff editor
    const goal = store.createCard({ boardId: board.id, title: 'The goal', role: 'orchestrator' });
    const worker = store.createCard({ boardId: board.id, parentId: goal.id, title: 'Write notes' });
    await run(worker.id);
    await until(() => fake.commands.has('infinityHarness.reviewComment') && store.getCard(worker.id)!.status === 'review');

    const provider = fake.webviews.get('infinityHarness.chat');
    const posted: any[] = [];
    let receive!: (m: unknown) => void;
    provider.resolveWebviewView({
      webview: { options: {}, html: '', postMessage: async (m: unknown) => (posted.push(m), true), onDidReceiveMessage: (fn: (m: unknown) => void) => (receive = fn) },
      visible: true,
      onDidDispose: () => ({ dispose() {} }),
      onDidChangeVisibility: () => ({ dispose() {} }),
    });
    receive({ type: 'ready' });
    await until(() => posted.some((m) => m.type === 'state' && m.goal?.title === 'The goal' && m.items.some((i: any) => i.kind === 'agent' && /Done with/.test(i.text))));
    const state = posted.filter((m) => m.type === 'state').pop();
    assert.deepEqual(state.targets.map((t: any) => t.title).sort(), ['The goal', 'Write notes']);
    receive({ type: 'send', cardId: worker.id, text: 'Keep it short, please.' });
    await until(() => store.boardMessages(board.id).some((m) => m.fromActor === 'user:local' && m.body === 'Keep it short, please.'));

    // A comment while the card is in Review is kept for the review; Request Changes sends it along with the notes.
    const thread = { uri: { scheme: 'infinity-harness', path: '/notes.md', query: `card=${worker.id}&side=to` }, range: new (fake.vscode.Range as any)(3, 0, 4, 0), comments: [] as unknown[], dispose() {} };
    await fake.commands.get('infinityHarness.reviewComment')!({ text: 'Too terse', thread });
    assert.equal(thread.comments.length, 1);
    assert.ok(!store.boardMessages(board.id).some((m) => /Comment on your changes/.test(m.body)), 'not sent yet');
    fake.hooks.input = () => 'Please rework the wording.';
    await fake.commands.get('infinityHarness.requestChanges')!(worker.id);
    const sent = store.boardMessages(board.id).filter((m) => m.toCard === worker.id).map((m) => m.body).join('\n');
    assert.match(sent, /The operator reviewed your branch and asked for changes:\n\nPlease rework the wording\.\n\nComments on the code:\n- notes\.md:4-5: Too terse/);
    // The author reworks it; the new head is reviewed again.
    await until(() => store.getCard(worker.id)!.pipeline.changesRequested === 1);
    await until(() => store.getCard(worker.id)!.status === 'review' && runner.sessionState(worker.id) === 'idle');

    // Try locally, approve, land now.
    await fake.commands.get('infinityHarness.tryApply')!(worker.id);
    assert.equal(readFileSync(`${repo}/notes.md`, 'utf8'), 'written by fake/two\n');
    await fake.commands.get('infinityHarness.approve')!(worker.id);
    assert.equal(store.getCard(worker.id)!.pipeline.humanReview?.verdict, 'approve');
    assert.equal(store.getCard(worker.id)!.status, 'merging');
    fake.hooks.warn = 'Land Now';
    await fake.commands.get('infinityHarness.landNow')!(worker.id);
    assert.ok(store.eventsFor(worker.id).some((e) => (e.payload as any).step === 'land_now'));
  } finally {
    ext.deactivate();
    for (const d of fake.extContext.subscriptions) d.dispose();
    await close();
  }
});

test('stage 3: a swarm that knocks and a request from a peer appear in Needs you and are decided from the window', async () => {
  await build({ absWorkingDir: dir, entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true, outfile: 'dist/extension.cjs', logLevel: 'silent' });
  const { store, board, repo, cfg, federation, close } = await setup({ federation: true });
  const fed = federation!;
  const fake = fakeVscode({ folder: repo, daemonUrl: `http://127.0.0.1:${cfg.port}` });
  const ext = loadExtension(fake.vscode);
  try {
    ext.activate(fake.extContext);
    await until(() => fake.context.get('infinityHarness.state') === 'ready');
    for (const id of ['infinityHarness.decidePeer', 'infinityHarness.decidePeerRequest', 'infinityHarness.openSwarms']) assert.ok(fake.commands.has(id), `${id} is registered`);
    assert.ok(manifest.contributes.commands.some((c: any) => c.command === 'infinityHarness.decidePeer'), 'and declared');

    // A stranger knocks. It shows up with its fingerprint, and nothing about it reaches an agent.
    const { generateIdentity } = await import('../../daemon/src/federation/identity.ts');
    const stranger = generateIdentity();
    fed.handleHello({ swarmId: stranger.swarmId, publicKey: stranger.publicKey }, { name: 'Gamma', projects: [] });
    const attention = fake.views.get('infinityHarness.attention')!;
    await until(() => attention.provider.getChildren().some((a: any) => a.kind === 'peer'));
    const knock = attention.provider.getChildren().find((a: any) => a.kind === 'peer');
    const item = attention.provider.getTreeItem(knock);
    assert.match(item.label, /Swarm "Gamma" wants to connect/);
    assert.match(item.tooltip.value, new RegExp(stranger.fingerprint));
    await until(() => ((attention.view.badge as { value: number } | undefined)?.value ?? 0) >= 1);

    // Accepting asks for a confirmation that names the fingerprint; declining it changes nothing.
    fake.hooks.pick = (items) => (items as any[]).find((i) => i.v === 'approve');
    fake.hooks.warn = undefined;
    await fake.commands.get('infinityHarness.decidePeer')!(knock.peer);
    assert.equal(store.fed.getPeer(knock.peer.id)!.trust, 'pending', 'not accepted without the confirmation');
    assert.ok(fake.shown.some((m) => m.includes(stranger.fingerprint)), 'the confirmation shows the fingerprint');
    fake.hooks.warn = 'Accept';
    await fake.commands.get('infinityHarness.decidePeer')!(knock.peer);
    assert.equal(store.fed.getPeer(knock.peer.id)!.trust, 'verified');
    await until(() => !attention.provider.getChildren().some((a: any) => a.kind === 'peer'));

    // The accepted swarm files a request against a published project that takes them.
    fed.saveDraft(board.id, { name: 'Demo', oneLine: 'Demo project', provides: ['demo'], accepts: { requests: true, note: '' } }, 'manual');
    fed.publish(board.id, 'basic');
    const peer = store.fed.getPeer(knock.peer.id)!;
    fed.receiveRequest(peer, { id: 'req00001', title: 'Crash on empty input', description: 'parse("") throws', project: board.id, blocking: true, acceptance: [], milestones: [], budget: null, origin: { cardId: null, hops: [peer.swarmId!] } });
    await until(() => attention.provider.getChildren().some((a: any) => a.kind === 'peerRequest'));
    const req = attention.provider.getChildren().find((a: any) => a.kind === 'peerRequest');
    assert.match(attention.provider.getTreeItem(req).label, /Request from Gamma: Crash on empty input/);
    assert.equal(attention.provider.getTreeItem(req).description, 'they are waiting');

    // Declining needs a reason, which the requester reads.
    fake.hooks.pick = (items) => (items as any[]).find((i) => i.v === 'decline');
    fake.hooks.input = () => 'not this quarter';
    await fake.commands.get('infinityHarness.decidePeerRequest')!(req.request);
    const after = store.fed.getRequest(req.request.id)!;
    assert.equal(after.status, 'declined');
    assert.equal(after.thread.at(-1)?.text, 'not this quarter');
    await until(() => !attention.provider.getChildren().some((a: any) => a.kind === 'peerRequest'));

    // A question from a swarm we asked, and a landed result to check: Needs-you items with their own command.
    const asked = store.fed.createRequest({ direction: 'out', peerId: peer.id, remoteId: 'r_q', title: 'Which node version', description: 'x', status: 'pending', origin: { swarmId: 'me', cardId: null, hops: ['me'] }, boardId: board.id });
    store.fed.updateRequest(asked.id, { status: 'needs_info', thread: [{ side: 'receiver', at: new Date().toISOString(), text: 'Which node version do you run?' }] });
    await until(() => attention.provider.getChildren().some((a: any) => a.kind === 'peerReply'));
    const reply = attention.provider.getChildren().find((a: any) => a.kind === 'peerReply');
    const replyItem = attention.provider.getTreeItem(reply);
    assert.match(replyItem.label, /Gamma asks about "Which node version"|asks about "Which node version"/);
    assert.equal(replyItem.command.command, 'infinityHarness.decidePeerReply');
    assert.ok(fake.commands.has('infinityHarness.decidePeerReply'));
  } finally {
    ext.deactivate();
    for (const d of fake.extContext.subscriptions) d.dispose();
    await close();
  }
});

test('stage 4: Remove This Board offers forget or delete; delete asks twice and needs the name typed back', async () => {
  await build({ absWorkingDir: dir, entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true, outfile: 'dist/extension.cjs', logLevel: 'silent' });
  const { store, board, repo, cfg, close } = await setup();
  const { existsSync } = await import('node:fs');
  const fake = fakeVscode({ folder: repo, daemonUrl: `http://127.0.0.1:${cfg.port}` });
  const ext = loadExtension(fake.vscode);
  try {
    ext.activate(fake.extContext);
    await until(() => fake.context.get('infinityHarness.state') === 'ready');
    assert.ok(manifest.contributes.commands.some((c: any) => c.command === 'infinityHarness.removeBoard'));
    const remove = fake.commands.get('infinityHarness.removeBoard')!;

    // Delete: the modal warning must be accepted, and then the name typed exactly.
    fake.hooks.pick = (items) => (items as any[]).find((i) => i.v === 'delete');
    fake.hooks.warn = undefined;
    await remove();
    assert.ok(store.getBoard(board.id), 'declining the warning deletes nothing');
    fake.hooks.warn = 'Delete the folder';
    fake.hooks.input = () => 'demo';
    await remove();
    assert.ok(store.getBoard(board.id) && existsSync(repo), 'a wrong name deletes nothing');

    // Forget: no questions; the folder stays and the window finds itself without a board.
    fake.hooks.pick = (items) => (items as any[]).find((i) => i.v === 'forget');
    await remove();
    assert.equal(store.getBoard(board.id), undefined);
    assert.ok(existsSync(repo));
    await until(() => fake.context.get('infinityHarness.state') === 'noBoard');
  } finally {
    ext.deactivate();
    for (const d of fake.extContext.subscriptions) d.dispose();
    await close();
  }
});

test('stage 5: messages for you can be cleared and open what they name; pools can be tested and put back from the window', async () => {
  await build({ absWorkingDir: dir, entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['vscode'], sourcemap: true, outfile: 'dist/extension.cjs', logLevel: 'silent' });
  const { store, board, repo, cfg, health, close } = await setup();
  const fake = fakeVscode({ folder: repo, daemonUrl: `http://127.0.0.1:${cfg.port}` });
  const ext = loadExtension(fake.vscode);
  try {
    ext.activate(fake.extContext);
    await until(() => fake.context.get('infinityHarness.state') === 'ready');
    const attention = fake.views.get('infinityHarness.attention')!;
    const messages = () => attention.provider.getChildren().filter((a: any) => a.kind === 'message');

    const worker = store.createCard({ boardId: board.id, title: 'Chatty worker' });
    const summaryCard = store.createCard({ boardId: board.id, title: 'Summary: a goal' });
    store.postMessage({ boardId: board.id, fromActor: `card:${worker.id}`, toCard: null, body: 'a question for you', urgent: false });
    store.postMessage({ boardId: board.id, fromActor: 'daemon:summary', toCard: null, body: `Final summary ready for "a goal": open card ${summaryCard.id} for the full report.\n\nIt went well.`, urgent: false });
    store.postMessage({ boardId: board.id, fromActor: 'daemon:health', toCard: null, body: 'Fake A stopped answering', urgent: false });
    await until(() => messages().length === 3);

    // Each has a Clear button, and the ones that name a card open it.
    const items = messages();
    const forSummary = items.find((i: any) => i.message.fromActor === 'daemon:summary');
    const tree = attention.provider.getTreeItem(forSummary);
    assert.equal(tree.contextValue, 'message');
    assert.deepEqual([tree.command.command, tree.command.arguments[0]], ['infinityHarness.openCard', summaryCard.id], 'the final summary opens its card');
    assert.equal(attention.provider.getTreeItem(items.find((i: any) => i.message.fromActor === 'daemon:health')).command.command, 'infinityHarness.showText');

    await fake.commands.get('infinityHarness.clearMessage')!(items.find((i: any) => i.message.fromActor === `card:${worker.id}`));
    await until(() => messages().length === 2);
    assert.equal(store.boardMessages(board.id).filter((m) => m.dismissedAt).length, 1);
    await fake.commands.get('infinityHarness.clearMessages')!();
    await until(() => messages().length === 0);
    assert.equal(store.boardMessages(board.id).length, 3, 'nothing was deleted');

    // Pools: one taken out of rotation shows why, is tested, and goes back on request.
    health.eject('fa', 'no answer within 8 s');
    let picks = 0;
    fake.hooks.pick = (list) => {
      picks++;
      const arr = list as any[];
      return arr[0]?.p ? arr.find((x) => x.p.id === 'fa') : arr.find((x) => x.v === 'test');
    };
    await fake.commands.get('infinityHarness.pools')!();
    assert.equal(picks, 2, 'pick the pool, then what to do with it');
    assert.ok(fake.shown.some((m) => /^Fake A: online/.test(m)));
    assert.ok(health.ejection('fa'), 'a passing test does not put it back');
    fake.hooks.pick = (list) => {
      const arr = list as any[];
      return arr[0]?.p ? arr.find((x) => x.p.id === 'fa') : arr.find((x) => x.v === 'restore');
    };
    await fake.commands.get('infinityHarness.pools')!();
    assert.equal(health.ejection('fa'), null);
    assert.ok(fake.shown.some((m) => m === 'Fake A is back in rotation.'));
  } finally {
    ext.deactivate();
    for (const d of fake.extContext.subscriptions) d.dispose();
    await close();
  }
});
