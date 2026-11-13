import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import type { Approval, Card, DaemonEvent, FedRequest, Message, Outcome, Peer } from '@ih/core';
import { disposeBoard, initBoardPanel, openBoard } from './boardPanel.ts';
import { SCHEME, showChanges, VersionProvider } from './changes.ts';
import { ChatView } from './chat.ts';
import { problemsContext, selectionContext } from './editorContext.ts';
import { IdeConnection, PROPOSAL_SCHEME, proposals } from './ide.ts';
import { ReviewComments } from './review.ts';
import { HarnessModel, folderInRepo } from './state.ts';
import { boardTooltip, goalsOf } from './summary.ts';
import { attachTerminal, disposeTerminals } from './terminal.ts';
import { APPROVAL_LABEL, AttentionProvider, CardItem, CardsProvider, statusLabel } from './views.ts';

const config = () => vscode.workspace.getConfiguration('infinityHarness');

/** True when `dir` is an Infinity Harness checkout (where `pnpm start` runs the daemon). */
const isCheckout = (dir: string) => !!dir && existsSync(join(dir, 'apps', 'daemon', 'src', 'main.ts'));

export function activate(context: vscode.ExtensionContext) {
  initBoardPanel(context.extensionUri);
  const model = new HarnessModel(context);
  const cards = new CardsProvider(model);
  const attention = new AttentionProvider(model, context);
  const cardsView = vscode.window.createTreeView('infinityHarness.cards', { treeDataProvider: cards, showCollapseAll: true });
  const attentionView = vscode.window.createTreeView('infinityHarness.attention', { treeDataProvider: attention });
  attention.attach(attentionView);
  const chat = new ChatView(model);
  const review = new ReviewComments(model);
  const ide = new IdeConnection(model);

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  const updateStatus = () => {
    if (model.state === 'offline') {
      status.text = '$(debug-disconnect) Harness offline';
      status.tooltip = `The Infinity Harness daemon isn't reachable at ${model.daemonUrl()}. Click to start it.`;
      status.command = 'infinityHarness.startDaemon';
    } else if (model.state !== 'ready' || !model.board) {
      status.text = '$(infinity) No board';
      status.tooltip = 'This workspace has no Infinity Harness board. Click to create one.';
      status.command = model.state === 'noBoard' ? 'infinityHarness.createBoard' : undefined;
    } else {
      const working = model.cards.filter((c) => c.status === 'in_progress').length;
      const need = attention.count();
      status.text = `$(infinity) ${working ? `$(sync~spin) ${working}` : model.board.name}${need ? `  $(bell-dot) ${need}` : ''}`;
      status.tooltip = new vscode.MarkdownString(boardTooltip(model.board, model.cards, need, model.pools, model.usage), true);
      status.command = 'infinityHarness.openBoard';
    }
    status.show();
  };
  model.onDidChange(updateStatus);
  updateStatus();

  model.onEvent((e) => notify(model, e));

  /** A card id from a tree item, a command argument, or a quick pick. */
  const pickCard = async (arg: unknown, filter: (c: Card) => boolean = () => true, placeHolder = 'Pick a card'): Promise<string | undefined> => {
    if (typeof arg === 'string') return arg;
    if (arg instanceof CardItem) return arg.card.id;
    const items = model.cards.filter(filter).map((c) => ({ label: c.title, description: `${statusLabel(c.status)}${c.agentId ? ` · ${c.agentId}` : ''}`, id: c.id }));
    if (!items.length) {
      void vscode.window.showInformationMessage('No cards to pick from.');
      return undefined;
    }
    return (await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true }))?.id;
  };

  const requireBoard = async (): Promise<boolean> => {
    if (model.state === 'ready' && model.board) return true;
    await model.refresh();
    if (model.state === 'ready' && model.board) return true;
    if (model.state === 'offline') {
      const choice = await vscode.window.showWarningMessage('The Infinity Harness daemon is not running.', 'Start Daemon');
      if (choice) await vscode.commands.executeCommand('infinityHarness.startDaemon');
    } else if (model.state === 'noBoard') {
      const choice = await vscode.window.showInformationMessage('This workspace has no board yet.', 'Create Board');
      if (choice) await vscode.commands.executeCommand('infinityHarness.createBoard');
    }
    return false;
  };

  /** Plans a goal: the orchestrator (or a council) splits it into cards for the board's agents. */
  const plan = async (opts: { goal?: string; description?: string; prompt?: string } = {}) => {
    if (!(await requireBoard())) return;
    const goal =
      opts.goal ??
      (await vscode.window.showInputBox({
        title: `Plan a goal on ${model.board!.name}`,
        prompt: opts.prompt ?? 'Describe the outcome you want. The orchestrator reads the repo and splits it into cards.',
        placeHolder: 'e.g. Add a CSV export to the inventory page, with tests',
        ignoreFocusOut: true,
      }));
    if (!goal?.trim()) return;
    try {
      const card = await model.client.goal(model.board!.id, goal.trim(), opts.description ?? '');
      void model.refresh();
      const choice = await vscode.window.showInformationMessage(`Planning "${goal.trim()}"…`, 'Open Board');
      if (choice) await openBoard(model, { cardId: card.id });
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not plan the goal: ${(err as Error).message}`);
    }
  };

  const run = (fn: (...args: any[]) => unknown) => async (...args: any[]) => {
    try {
      await fn(...args);
    } catch (err) {
      void vscode.window.showErrorMessage(`Infinity Harness: ${(err as Error).message}`);
    }
  };

  const commands: Record<string, (...args: any[]) => unknown> = {
    'infinityHarness.refresh': () => model.reconfigure(),

    'infinityHarness.plan': () => {
      const ctx = config().get<boolean>('editorContext') ? selectionContext(undefined, true) : '';
      return plan({ description: ctx });
    },

    'infinityHarness.planFromSelection': () => {
      const ctx = selectionContext(undefined, true);
      if (!ctx) return vscode.window.showInformationMessage('Select some code in a workspace file first.');
      return plan({ description: ctx, prompt: 'What should happen with the selected code? It is attached to the goal.' });
    },

    'infinityHarness.fixProblems': () => {
      const problems = problemsContext();
      if (!problems) return vscode.window.showInformationMessage('The active file has no errors or warnings.');
      return plan({ goal: `Fix the ${problems.count} problem${problems.count === 1 ? '' : 's'} in ${problems.path}`, description: problems.text });
    },

    'infinityHarness.openBoard': async () => {
      if (model.state === 'offline' && !(await requireBoard())) return;
      await openBoard(model);
    },

    'infinityHarness.openCard': async (arg: unknown) => {
      const id = await pickCard(arg);
      if (id) await openBoard(model, { cardId: id });
    },

    'infinityHarness.selectBoard': async () => {
      await model.refresh();
      if (model.candidates.length < 2) return vscode.window.showInformationMessage(model.board ? `This workspace has one board: ${model.board.name}.` : 'This workspace has no board.');
      const pick = await vscode.window.showQuickPick(
        model.candidates.map((b) => ({ label: b.name, description: b.repoPath, picked: b.id === model.board?.id, id: b.id })),
        { placeHolder: 'Board for this workspace' },
      );
      if (pick) await model.chooseBoard(pick.id);
    },

    'infinityHarness.createBoard': async () => {
      await model.refresh();
      if (model.state === 'offline') return requireBoard();
      const folders = model.folders();
      if (!folders.length) return vscode.window.showInformationMessage('Open a folder first.');
      let folder = folders[0]!;
      if (folders.length > 1) {
        const pick = await vscode.window.showQuickPick(folders.map((f) => ({ label: basename(f), description: f, f })), { placeHolder: 'Which folder gets the board?' });
        if (!pick) return;
        folder = pick.f;
      }
      const info = await model.client.folder(folder);
      let repoPath = folder;
      let setup: object | undefined;
      let mode: 'worktree' | 'direct' = 'worktree';
      if (!info.git) {
        // Not a git repository: direct mode by default, like the vendor IDE assistants; worktrees need git set up first.
        const pick = await vscode.window.showQuickPick(
          [
            { label: '$(edit) Work directly in this folder', description: 'Recommended', detail: 'Agents edit the files here as they go, like an IDE assistant. No git, branches, reviews or landing; up to three workers at once by default.', mode: 'direct' as const },
            { label: '$(git-branch) Set up git and use worktrees', detail: 'git init, README, .gitignore and a first commit; then each card works on its own branch and lands through the merge queue.', mode: 'worktree' as const },
          ],
          { title: `${basename(folder)} isn't a git repository`, placeHolder: 'How should agents work on it?' },
        );
        if (!pick) return;
        mode = pick.mode;
        if (mode === 'worktree') setup = { branch: 'main', gitignore: 'general', github: 'none' };
      } else if (!folderInRepo(info.git.root, folder)) {
        // A subfolder of a repository: the board belongs to the repository root.
        const ok = await vscode.window.showInformationMessage(`${basename(folder)} is inside the repository at ${info.git.root}. Create the board for that repository?`, { modal: true }, 'Create Board');
        if (!ok) return;
        repoPath = info.git.root;
      } else if (!info.git.commits) {
        const ok = await vscode.window.showInformationMessage(
          `${basename(folder)} is a git repository without commits. Make a first commit (adding a README and .gitignore if missing) and create the board?`,
          { modal: true },
          'Commit and Create',
        );
        if (!ok) return;
        setup = { branch: info.git.branch || 'main', gitignore: 'general', github: 'none' };
      }
      const board = await model.client.createBoard(basename(repoPath), repoPath, setup, mode);
      await model.chooseBoard(board.id);
      const next = await vscode.window.showInformationMessage(
        `Board "${board.name}" created${board.setup.length ? ` (${board.setup.join(', ')})` : ''}. Set up which agents plan and work, and the test command, before planning.`,
        'Open Agent Settings',
      );
      if (next) await openBoard(model, { view: 'agents' });
    },

    'infinityHarness.startDaemon': async () => {
      if (await model.client.healthy()) {
        model.reconfigure();
        return vscode.window.showInformationMessage(`The daemon is already running at ${model.daemonUrl()}.`);
      }
      let dir = config().get<string>('installPath') || '';
      if (!isCheckout(dir)) {
        // An open workspace folder that is the checkout (e.g. while developing the harness) needs no question.
        dir = model.folders().find(isCheckout) ?? '';
      }
      if (!dir) {
        const choice = await vscode.window.showInformationMessage(
          'Start Daemon runs `pnpm start` in your Infinity Harness checkout: the folder you cloned it into, with package.json and apps/daemon in it. Where is it?',
          { modal: true },
          'Choose Folder…',
        );
        if (!choice) return;
        const picked = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Use This Checkout', title: 'Infinity Harness checkout (the folder with apps/daemon)' });
        if (!picked?.[0]) return;
        if (!isCheckout(picked[0].fsPath)) {
          void vscode.window.showErrorMessage(`${picked[0].fsPath} isn't an Infinity Harness checkout (no apps/daemon/src/main.ts). Pick the folder you cloned the harness into.`);
          return;
        }
        dir = picked[0].fsPath;
      }
      if (dir !== config().get<string>('installPath')) await config().update('installPath', dir, vscode.ConfigurationTarget.Global);
      const terminal = vscode.window.createTerminal({ name: 'Infinity Harness daemon', cwd: dir, iconPath: new vscode.ThemeIcon('infinity') });
      terminal.sendText('pnpm start');
      terminal.show(true);
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Starting the Infinity Harness daemon…' }, async () => {
        for (let i = 0; i < 90; i++) {
          if (await model.client.healthy()) return;
          await new Promise((r) => setTimeout(r, 1000));
        }
        throw new Error('the daemon did not answer within 90 s; check the "Infinity Harness daemon" terminal');
      });
      model.reconfigure();
    },

    'infinityHarness.showChanges': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => !!c.branch, 'Show the changes of which card?');
      if (id) await showChanges(model, id);
    },

    'infinityHarness.openTerminal': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => model.terminals.has(c.id), 'Attach to which agent?');
      if (id) await attachTerminal(model, id);
    },

    'infinityHarness.messageCard': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => c.status !== 'done', 'Message which card?');
      if (!id) return;
      const text = await vscode.window.showInputBox({
        title: `Message ${model.card(id)?.title ?? id}`,
        prompt: 'Delivered at the agent\'s next turn. Start with !urgent to interrupt its current turn.',
        ignoreFocusOut: true,
      });
      if (!text?.trim()) return;
      const urgent = text.trim().startsWith('!urgent');
      await model.client.sendMessage(id, urgent ? text.trim().slice(7).trim() : text.trim(), urgent);
      void vscode.window.setStatusBarMessage(`$(comment) Sent${urgent ? ' (urgent)' : ''}`, 3000);
    },

    'infinityHarness.sendSelection': async () => {
      const ctx = selectionContext(undefined, true);
      if (!ctx) return vscode.window.showInformationMessage('Select some code in a workspace file first.');
      const id = await pickCard(undefined, (c) => ['in_progress', 'review', 'blocked', 'ready'].includes(c.status), 'Send the selection to which card?');
      if (!id) return;
      const note = await vscode.window.showInputBox({ title: 'Add a note (optional)', prompt: 'What should the agent do with this code?', ignoreFocusOut: true });
      if (note === undefined) return;
      await model.client.sendMessage(id, [note.trim(), ctx].filter(Boolean).join('\n\n'), false);
      void vscode.window.setStatusBarMessage('$(comment) Selection sent', 3000);
    },

    'infinityHarness.runCard': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => ['backlog', 'ready', 'blocked'].includes(c.status), 'Run which card?');
      if (id) await model.client.moveCard(id, 'ready'); // Ready cards are routed to the best agent with capacity.
    },

    'infinityHarness.cancelCard': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => c.status === 'in_progress', 'Stop which agent?');
      if (id) await model.client.cancel(id);
    },

    'infinityHarness.openWorktree': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => !!c.worktree, 'Open the worktree of which card?');
      const wt = id ? model.card(id)?.worktree : null;
      if (wt) await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(wt), { forceNewWindow: true });
    },

    'infinityHarness.weighBlock': async (outcome?: Outcome) => {
      const o = outcome ?? (await vscode.window.showQuickPick(model.pending.map((p) => ({ label: model.card(p.cardId)?.title ?? p.cardId, description: p.agentId, p })), { placeHolder: 'Weigh which block?' }))?.p;
      if (!o) return;
      const card = model.card(o.cardId);
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(pass) Pass', description: 'The block was justified (counts as a success for the model)', v: 'pass' as const },
          { label: '$(error) Fail', description: 'It should have done the work (counts as a failure)', v: 'fail' as const },
          { label: '$(circle-slash) Ignore', description: 'Leave it out of routing', v: 'ignore' as const },
        ],
        { title: `${card?.title ?? o.cardId} — ${o.agentId}`, placeHolder: o.note ?? 'Reported blocked' },
      );
      if (pick) {
        await model.client.reviewOutcome(o.id, pick.v);
        void model.refresh();
      }
    },

    'infinityHarness.approve': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => c.role === 'worker' && c.status === 'review', 'Approve which card?');
      if (id) await review.verdict(id, 'approve');
    },

    'infinityHarness.requestChanges': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => c.role === 'worker' && (c.status === 'review' || c.status === 'merging'), 'Request changes on which card?');
      if (id) await review.verdict(id, 'changes');
    },

    'infinityHarness.reviewComment': (reply: vscode.CommentReply) => review.submit(reply),

    'infinityHarness.landNow': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => c.role === 'worker' && (c.status === 'review' || c.status === 'merging'), 'Land which card now?');
      if (!id) return;
      const ok = await vscode.window.showWarningMessage(`Land "${model.card(id)?.title ?? id}" now? It skips the review and goes to the front of the merge queue (its tests still run).`, { modal: true }, 'Land Now');
      if (ok) {
        await model.client.land(id);
        void vscode.window.setStatusBarMessage('$(git-merge) Queued to land', 4000);
      }
    },

    'infinityHarness.tryCheckout': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => !!c.branch, 'Check out which card’s work?');
      if (!id) return;
      const r = await model.client.tryLocally(id, 'checkout');
      void vscode.window.showInformationMessage(r.summary);
    },

    'infinityHarness.tryApply': async (arg: unknown) => {
      const id = await pickCard(arg, (c) => !!c.branch, 'Apply which card’s diff?');
      if (!id) return;
      const r = await model.client.tryLocally(id, 'apply');
      void vscode.window.showInformationMessage(r.summary);
    },

    'infinityHarness.decideApproval': async (approval?: Approval) => {
      const a = approval ?? (await vscode.window.showQuickPick(model.approvals.map((x) => ({ label: x.summary.split('\n')[0] ?? x.id, description: APPROVAL_LABEL[x.kind], x })), { placeHolder: 'Decide which request?' }))?.x;
      if (!a) return;
      const pick = await vscode.window.showQuickPick(
        [
          { label: a.kind === 'escalation' ? '$(comment) Answer and resume' : '$(check) Approve', detail: a.kind === 'escalation' ? 'Your answer goes to the agent and the card runs again.' : undefined, v: 'approve' as const },
          { label: '$(close) Deny', v: 'deny' as const },
        ],
        { title: a.summary.split('\n')[0], placeHolder: APPROVAL_LABEL[a.kind] },
      );
      if (!pick) return;
      let note: string | undefined;
      if (a.kind === 'escalation' || pick.v === 'deny') {
        note = await vscode.window.showInputBox({ title: a.kind === 'escalation' && pick.v === 'approve' ? 'Your answer to the agent' : 'Why? (optional)', ignoreFocusOut: true });
        if (note === undefined) return;
      }
      await model.client.decide(a.id, pick.v, note?.trim() || undefined);
      void model.refresh();
    },

    'infinityHarness.decidePeer': async (peer?: Peer) => {
      const p = peer ?? (await vscode.window.showQuickPick(model.federation.knocks.map((x) => ({ label: x.knock?.name ?? x.name ?? x.label, description: x.fingerprint ?? '', x })), { placeHolder: 'Which swarm?' }))?.x;
      if (!p) return;
      const name = p.knock?.name ?? p.name ?? p.label;
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(check) Accept this swarm', detail: 'Pins its key. What it says reaches your agents as data, and so your model vendors. Compare the fingerprint with its operator first.', v: 'approve' as const },
          { label: '$(close) Deny', detail: 'It may knock again.', v: 'deny' as const },
          { label: '$(circle-slash) Block', detail: 'Ignore its knocks from now on.', v: 'block' as const },
        ],
        { title: `"${name}" wants to connect. Fingerprint: ${p.fingerprint ?? '?'}`, ignoreFocusOut: true },
      );
      if (!pick) return;
      if (pick.v === 'approve') {
        const sure = await vscode.window.showWarningMessage(`Accept "${name}"? Fingerprint ${p.fingerprint ?? '?'}. Does it match what its operator reads out?`, { modal: true }, 'Accept');
        if (sure !== 'Accept') return;
      }
      await model.client.decidePeer(p.id, pick.v);
      void model.refresh();
    },

    'infinityHarness.decidePeerRequest': async (request?: FedRequest) => {
      const r = request ?? (await vscode.window.showQuickPick(model.federation.requests.map((x) => ({ label: x.title, description: x.peerName ?? '', x })), { placeHolder: 'Which request?' }))?.x;
      if (!r) return;
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(check) Approve', detail: 'The board\'s orchestrator plans it as a goal. It is marked as coming from outside.', v: 'approve' as const },
          { label: '$(question) Ask a question', detail: 'The request waits until they answer.', v: 'ask' as const },
          { label: '$(close) Decline', v: 'decline' as const },
          { label: '$(go-to-file) Read it in full', v: 'read' as const },
        ],
        { title: `From ${r.peerName ?? 'a peer'}: ${r.title}`, placeHolder: r.description.split('\n')[0]?.slice(0, 120) },
      );
      if (!pick) return;
      if (pick.v === 'read') {
        const doc = await vscode.workspace.openTextDocument({ content: `# ${r.title}\n\nFrom ${r.peerName ?? 'a peer'} (their words, untrusted)\n\n${r.description}\n${r.acceptance.length ? `\nAcceptance:\n${r.acceptance.map((a) => `- ${a}`).join('\n')}\n` : ''}`, language: 'markdown' });
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      if (pick.v === 'approve') {
        const note = await vscode.window.showInputBox({ title: 'A note for the orchestrator and the requester (optional)', ignoreFocusOut: true });
        if (note === undefined) return;
        await model.client.approvePeerRequest(r.id, note.trim() || undefined);
      } else {
        const text = await vscode.window.showInputBox({ title: pick.v === 'ask' ? 'Your question' : 'Why are you declining? The requester reads this', ignoreFocusOut: true });
        if (!text?.trim()) return;
        await (pick.v === 'ask' ? model.client.askPeerInfo(r.id, text.trim()) : model.client.declinePeerRequest(r.id, text.trim()));
      }
      void model.refresh();
    },

    'infinityHarness.decidePeerReply': async (request?: FedRequest) => {
      const r = request ?? (await vscode.window.showQuickPick(model.federation.replies.map((x) => ({ label: x.title, description: x.peerName ?? '', x })), { placeHolder: 'Which request?' }))?.x;
      if (!r) return;
      if (r.status === 'needs_info') {
        const answer = await vscode.window.showInputBox({ title: `${r.peerName ?? 'They'} ask: ${[...r.thread].reverse().find((e) => e.side === 'receiver')?.text ?? ''}`, prompt: 'Your answer', ignoreFocusOut: true });
        if (!answer?.trim()) return;
        await model.client.commentPeerRequest(r.id, answer.trim());
      } else {
        const pick = await vscode.window.showQuickPick(
          [
            { label: '$(check) It works: mark done', v: 'confirm' as const },
            { label: '$(close) Send it back', detail: 'Tell them what is still wrong; the request waits for their decision again.', v: 'reopen' as const },
          ],
          { title: `${r.peerName ?? 'They'} landed "${r.title}": ${r.resolution?.ref ?? ''}`, ignoreFocusOut: true },
        );
        if (!pick) return;
        if (pick.v === 'confirm') await model.client.confirmPeerRequest(r.id);
        else {
          const why = await vscode.window.showInputBox({ title: 'What is still wrong? They read this.', ignoreFocusOut: true });
          if (!why?.trim()) return;
          await model.client.reopenPeerRequest(r.id, why.trim());
        }
      }
      void model.refresh();
    },

    'infinityHarness.removeBoard': async () => {
      const board = model.board;
      if (!board) return vscode.window.showInformationMessage('This workspace has no board to remove.');
      const info = await model.client.boardRemoval(board.id);
      if (info.blocked) return vscode.window.showWarningMessage(info.blocked);
      const facts = [`${info.cards} card(s)`, info.running ? `${info.running} agent(s) working` : '', info.dirtyWorktrees ? `${info.dirtyWorktrees} worktree(s) with unsaved changes` : '', info.folder.unlandedBranches ? `${info.folder.unlandedBranches} branch(es) not landed` : ''].filter(Boolean).join(', ');
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(close) Remove from Infinity Harness', detail: `Forgets the board and its cards, notes and settings. Your folder, branches and history stay. (${facts})`, v: 'forget' as const },
          { label: '$(trash) Delete on system…', detail: info.deleteBlocked ?? `Also deletes ${board.repoPath} from the disk. You will be asked to confirm.`, v: 'delete' as const },
        ],
        { title: `Remove "${board.name}"`, ignoreFocusOut: true },
      );
      if (!pick) return;
      if (pick.v === 'delete') {
        if (info.deleteBlocked) return vscode.window.showWarningMessage(info.deleteBlocked);
        const sure = await vscode.window.showWarningMessage(`Delete ${board.repoPath} from the disk, with everything in it? This cannot be undone.`, { modal: true }, 'Delete the folder');
        if (sure !== 'Delete the folder') return;
        const typed = await vscode.window.showInputBox({ title: `Type the board's name to confirm: ${board.name}`, ignoreFocusOut: true });
        if (typed === undefined) return;
        if (typed !== board.name) return vscode.window.showWarningMessage("That is not the board's name; nothing was deleted.");
        await model.client.removeBoard(board.id, 'delete', typed);
        void vscode.window.showInformationMessage(`Deleted "${board.name}" and its folder.`);
      } else {
        await model.client.removeBoard(board.id, 'forget');
        void vscode.window.showInformationMessage(`Removed "${board.name}" from Infinity Harness. The folder is untouched.`);
      }
      void model.refresh();
    },

    'infinityHarness.openSwarms': async () => {
      if (model.state === 'offline' && !(await requireBoard())) return;
      await openBoard(model, { view: 'swarms' });
    },

    'infinityHarness.approveApproval': async (a?: Approval) => {
      if (!a) return vscode.commands.executeCommand('infinityHarness.decideApproval');
      const note = a.kind === 'escalation' ? await vscode.window.showInputBox({ title: 'Your answer to the agent', ignoreFocusOut: true }) : undefined;
      if (a.kind === 'escalation' && note === undefined) return;
      await model.client.decide(a.id, 'approve', note?.trim() || undefined);
      void model.refresh();
    },

    'infinityHarness.denyApproval': async (a?: Approval) => {
      if (!a) return vscode.commands.executeCommand('infinityHarness.decideApproval');
      const note = await vscode.window.showInputBox({ title: 'Why? (optional)', ignoreFocusOut: true });
      if (note === undefined) return;
      await model.client.decide(a.id, 'deny', note.trim() || undefined);
      void model.refresh();
    },

    'infinityHarness.chat.selectGoal': async () => {
      const goals = goalsOf(model.cards);
      if (!goals.length) return vscode.window.showInformationMessage('No goals yet. Plan one first.');
      const pick = await vscode.window.showQuickPick(goals.map((g) => ({ label: g.title, description: statusLabel(g.status), id: g.id })), { placeHolder: 'Show the conversation of which goal?' });
      if (pick) chat.select(pick.id);
    },

    'infinityHarness.openChat': () => vscode.commands.executeCommand('infinityHarness.chat.focus'),

    // Messages for you: clear one (its inline button), or all of them. They stay in the card's own log.
    'infinityHarness.clearMessage': async (item?: { kind?: string; message?: Message }) => {
      if (!model.board || !item?.message) return;
      await model.client.dismissMessages(model.board.id, [item.message.id]);
      void model.refresh();
    },
    'infinityHarness.clearMessages': async () => {
      if (!model.board || !model.inbox.length) return;
      await model.client.dismissMessages(model.board.id, model.inbox.map((m) => m.id));
      void model.refresh();
    },

    // Is each pool's model answering? Test one now; a pool that was taken out of rotation goes back on request.
    'infinityHarness.pools': async () => {
      const pools = await model.client.pools();
      const label = (p: (typeof pools)[number]) => (p.health?.ejected ? 'out of rotation' : p.health?.reachable === 'online' ? `online${p.health.latencyMs !== null ? ` ${p.health.latencyMs} ms` : ''}` : p.health?.reachable === 'offline' ? 'no response' : 'not checked');
      const pick = await vscode.window.showQuickPick(
        pools.map((p) => ({ label: `${p.health?.ejected ? '$(circle-slash)' : p.health?.reachable === 'offline' ? '$(error)' : p.health?.reachable === 'online' ? '$(pass)' : '$(question)'} ${p.label}`, description: label(p), detail: p.health?.ejected ? `Out since ${new Date(p.health.ejected.since).toLocaleTimeString()}: ${p.health.ejected.reason}. Not held against the model.` : p.health?.detail ?? undefined, p })),
        { placeHolder: 'Pools: pick one to test whether its model answers' },
      );
      if (!pick) return;
      const actions = [{ label: '$(pulse) Test now', v: 'test' as const }, ...(pick.p.health?.ejected ? [{ label: '$(debug-restart) Put back in rotation', v: 'restore' as const }] : [])];
      const act = actions.length === 1 ? actions[0] : await vscode.window.showQuickPick(actions, { title: pick.p.label });
      if (!act) return;
      if (act.v === 'restore') {
        await model.client.restorePool(pick.p.id);
        vscode.window.showInformationMessage(`${pick.p.label} is back in rotation.`);
      } else {
        const v = await model.client.testPool(pick.p.id);
        const text = v.reachable === 'online' ? `${pick.p.label}: online${v.latencyMs !== null ? `, ${v.latencyMs} ms` : ''}.` : `${pick.p.label}: no response${v.detail ? ` (${v.detail})` : ''}.`;
        if (v.reachable === 'online') vscode.window.showInformationMessage(text);
        else vscode.window.showWarningMessage(text);
      }
      void model.refresh();
    },

    'infinityHarness.showText': (text: string) => vscode.window.showInformationMessage(text, { modal: true }),
  };
  for (const [id, fn] of Object.entries(commands)) context.subscriptions.push(vscode.commands.registerCommand(id, run(fn)));

  context.subscriptions.push(
    model,
    cardsView,
    attentionView,
    status,
    chat,
    review,
    ide,
    vscode.window.registerWebviewViewProvider(ChatView.viewType, chat, { webviewOptions: { retainContextWhenHidden: true } }),
    vscode.workspace.registerTextDocumentContentProvider(SCHEME, new VersionProvider(model)),
    vscode.workspace.registerTextDocumentContentProvider(PROPOSAL_SCHEME, proposals),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('infinityHarness.daemonUrl') || e.affectsConfiguration('infinityHarness.apiToken')) model.reconfigure();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void model.refresh()),
    { dispose: () => (disposeTerminals(), disposeBoard()) },
  );
  void model.refresh();
}

/** Pop-ups for what matters, per the `notifications` setting. */
function notify(model: HarnessModel, e: DaemonEvent) {
  const level = config().get<string>('notifications') ?? 'attention';
  if (level === 'off') return;
  const open = (cardId: string) => (choice: string | undefined) => {
    if (choice === 'Open') void openBoard(model, { cardId });
    if (choice === 'Show Changes') void showChanges(model, cardId);
  };
  if (e.type === 'card.updated') {
    const { patch, card } = e.payload as { patch: Partial<Card>; card: Card };
    if (patch.status === 'blocked') void vscode.window.showWarningMessage(`Blocked: ${card.title}`, 'Open').then(open(card.id));
    else if (patch.status === 'done' && level === 'all' && card.role === 'worker') void vscode.window.showInformationMessage(`Landed: ${card.title}`, 'Show Changes', 'Open').then(open(card.id));
  } else if (e.type === 'approval.created') {
    const a = e.payload as Approval;
    void vscode.window.showInformationMessage(`${APPROVAL_LABEL[a.kind]}: ${a.summary.length > 160 ? `${a.summary.slice(0, 160)}…` : a.summary}`, 'Decide').then((c) => c && vscode.commands.executeCommand('infinityHarness.decideApproval', a));
  } else if (e.type === 'peer.updated' && (e.payload as { created?: boolean; trust?: string }).created && (e.payload as { trust?: string }).trust === 'pending') {
    void vscode.window.showInformationMessage('A swarm wants to connect to this one.', 'Decide').then(async (c) => {
      if (!c) return;
      await model.refresh();
      void vscode.commands.executeCommand('infinityHarness.decidePeer');
    });
  } else if (e.type === 'request.updated' && (e.payload as { created?: boolean; direction?: string }).created && (e.payload as { direction?: string }).direction === 'in') {
    void vscode.window.showInformationMessage('Another swarm sent a request.', 'Decide').then(async (c) => {
      if (!c) return;
      await model.refresh();
      void vscode.commands.executeCommand('infinityHarness.decidePeerRequest');
    });
  } else if (e.type === 'message.posted') {
    const m = e.payload as Message;
    // Approvals pop up on their own (approval.created), with a Decide button.
    if (m.toCard !== null || m.fromActor.startsWith('user:') || m.fromActor === 'daemon:approvals') return;
    const from = m.fromActor.startsWith('card:') ? model.card(m.fromActor.slice(5))?.title ?? m.fromActor : 'The board';
    const first = m.body.split('\n')[0] ?? '';
    const cardId = m.fromActor.startsWith('card:') ? m.fromActor.slice(5) : /\((c_\w+)[,)]/.exec(m.body)?.[1];
    void vscode.window.showInformationMessage(`${from}: ${first.length > 160 ? `${first.slice(0, 160)}…` : first}`, ...(cardId ? ['Open'] : [])).then((c) => cardId && open(cardId)(c));
  }
}

export function deactivate() {
  disposeTerminals();
  disposeBoard();
}
