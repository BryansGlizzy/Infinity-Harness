import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** What the refinery needs from GitHub (master plan §5.6 step 4). Tests swap in a fake. */
export interface GitHub {
  /** Opens a PR for `branch` into `base`, or returns the open one. Resolves with its URL. */
  openPr(repo: string, pr: { branch: string; base: string; title: string; body: string }): Promise<string>;
  /** Merges the PR with a merge commit (not a squash, so cards built on it still merge cleanly). */
  mergePr(repo: string, url: string, message: { subject: string; body: string }): Promise<void>;
}

/** True for remotes GitHub hosts (https or ssh). */
export function isGitHubRemote(url: string | null): boolean {
  return !!url && /(^|[@/])github\.com[:/]/.test(url);
}

/** GitHub through the `gh` CLI, on the user's own `gh auth login`. */
export function ghCli(binary: string): GitHub {
  const gh = async (repo: string, args: string[]) => (await run(binary, args, { cwd: repo, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  return {
    async openPr(repo, { branch, base, title, body }) {
      const open = JSON.parse((await gh(repo, ['pr', 'list', '--head', branch, '--state', 'open', '--json', 'url'])) || '[]') as { url: string }[];
      if (open[0]) {
        await gh(repo, ['pr', 'edit', open[0].url, '--title', title, '--body', body]).catch(() => {});
        return open[0].url;
      }
      const out = await gh(repo, ['pr', 'create', '--head', branch, '--base', base, '--title', title, '--body', body]);
      const url = out.split('\n').find((l) => /^https?:\/\//.test(l.trim()));
      if (!url) throw new Error(`gh pr create printed no URL: ${out.slice(0, 200)}`);
      return url.trim();
    },
    async mergePr(repo, url, { subject, body }) {
      // No --delete-branch: the branch is checked out in the card's worktree, which gh would try to switch away from.
      await gh(repo, ['pr', 'merge', url, '--merge', '--subject', subject, '--body', body]);
    },
  };
}
