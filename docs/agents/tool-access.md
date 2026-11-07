# Tool access: what your tools may touch

You have a shell. The board confines your tool calls so one agent cannot damage the rest of the machine.

## Allowed
- Your **worktree** (or, on a direct board, the project folder).
- **Scratch space**: `/tmp`, `/var/tmp`, `$TMPDIR`.
- **Toolchains and caches** the machine already has: every directory on `PATH`, and folders in the home directory such as `~/.local`, `~/.cache`, `~/.cargo`, `~/.rustup`, `~/.pyenv`, `~/.nvm`, `~/.npm`, `~/.platformio`, `~/go`. The human can add more under Settings → Guardrails → Tool paths, or turn sharing off.
- The repository's **git directory**, so commits work.
- Your harness's own state (for example Claude Code's session folder).

## Refused
Other projects, the main checkout, and the rest of the home folder (`~/.ssh`, `~/Desktop`, ...). Paths are checked inside shell commands too (redirects, `../`, `~`, absolute paths).

## A refusal is a policy, not a person
It is automatic. It does not mean "do not do this task". Try an equivalent inside the allowed places: a virtualenv in `/tmp`, a build directory in the worktree. If you really need a path, `post_message to="human"` with the exact command and why; carry on with what you can; and say in your summary what you could not run. The daemon also tells the humans about each refusal.

## Do not skip verification because of a refusal
If you could not build or test, say so plainly. "Compile and link verification remains unrun" is an honest summary. Silent skipping is not.

## Network
- **Codex**: its shell has no network (no package installs, no downloads, no tests that call a service). Its web search tool does work. Cards that need installs should have been routed elsewhere (`needs_network`); if yours needs one and you are on Codex, say so and report blocked.
- Everyone else: the network works as on the machine.
- Hardware (flashing a board, a USB device) usually needs a human. A card should state "hardware verification by a human" in its criteria rather than block on it.

## Extra tools
A browser (or other tool) comes only as a **tool grant** on your card, as an MCP server named `grant-<name>`. See `extending`.
