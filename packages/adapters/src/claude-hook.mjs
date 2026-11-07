#!/usr/bin/env node
// Bridge from Claude Code hooks / status line to the meta-harness daemon.
// Claude runs this with the hook payload on stdin; it is forwarded to MH_HOOK_URL and the daemon's reply
// is printed back to Claude (a PreToolUse decision, or the status line text).
// Usage: claude-hook.mjs hook | status
const mode = process.argv[2] === 'status' ? 'status' : 'hook';
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', async () => {
  try {
    const res = await fetch(`${process.env.MH_HOOK_URL}?mode=${mode}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.MH_HOOK_TOKEN}` },
      body: input || '{}',
      signal: AbortSignal.timeout(20_000),
    });
    process.stdout.write(await res.text());
  } catch (err) {
    if (mode === 'status') return process.stdout.write('meta-harness: daemon unreachable');
    // Fail closed: without the daemon there is no lease or worktree check, so refuse tool use.
    let event = '';
    try {
      event = JSON.parse(input).hook_event_name;
    } catch {}
    if (event === 'PreToolUse') {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `meta-harness daemon unreachable (${err.message})`,
          },
        }),
      );
    }
  }
});
