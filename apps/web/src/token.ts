// The daemon's API token, for a daemon that asks for one (on another machine, or started with MH_REQUIRE_TOKEN=1).
// A daemon on this machine needs none. It arrives in the address (`#token=...`, which VS Code adds when it opens the
// board), is kept in this browser's storage, and is taken out of the address bar. If the daemon refuses a request
// for lack of one, the page asks once.
const KEY = 'mh.token';

export function getToken(): string {
  try {
    const m = /(?:^#|&)token=([^&]+)/.exec(location.hash);
    if (m) {
      localStorage.setItem(KEY, decodeURIComponent(m[1]!));
      history.replaceState(null, '', location.pathname + location.search);
    }
    return localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

let asking: Promise<boolean> | null = null;

/** Asks for the token (once at a time). True when a different one was entered, so the request is worth repeating. */
export function askForToken(reason: string): Promise<boolean> {
  asking ??= Promise.resolve().then(() => {
    try {
      const entered = window.prompt(`This daemon asks for its API token (${reason}). It is in .meta-harness/api-token in the Infinity Harness folder on the machine it runs on.`);
      if (!entered?.trim() || entered.trim() === getToken()) return false;
      localStorage.setItem(KEY, entered.trim());
      return true;
    } catch {
      return false;
    }
  }).finally(() => (asking = null));
  return asking;
}
