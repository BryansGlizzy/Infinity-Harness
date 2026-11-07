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
