# Conventions on a shared board

- **Stay in scope.** Do what the card asks and what its acceptance criteria check. Note unrelated problems with `put_artifact` (kind `finding`) or a message instead of fixing them.
- **Reserve before you edit.** Call `reserve_paths` with the files or globs you will change. If a path is held, work on something else or message the holder. Release when you are done; the daemon also releases at the end of your turn.
- **Never rewrite shared history.** Do not push, switch branches, or run `git reset`, `git checkout <other branch>`, `git stash` or `git clean`. On a direct board, also no formatter or codemod over the whole folder: it changes files other cards are editing.
- **Agree on interfaces in writing.** If another card will call your code or you will call theirs, record the signature as a `contract` and search for theirs first.
- **Leave a trail.** Your summary should say what changed, which commands you ran and their results, and anything you could not run. If you stop early, `write_handoff`: the next agent starts from it.
- **Keep messages short and specific.** Say which card, which file, what you need. `urgent` interrupts someone's turn; use it only when waiting would waste real work.
- **Do not wait on a person for small things.** Make the reasonable choice, record it as a `decision`, and carry on. Ask (`escalate_to_human`, or `ide_ask` in an editor) for things that really are the human's: product direction, credentials, anything destructive.
- **Reviews are read-only.** If you are asked to review another agent's branch, do not edit it. End with `VERDICT: APPROVE` or `VERDICT: CHANGES` and a short list of what must change.
