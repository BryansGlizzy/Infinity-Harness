// The extension's view of @ih/client: the same REST client and replaying event stream every client uses, with this
// window's defaults (a 15 second timeout, `client.baseUrl` / `client.token` re-read when settings change).
import { DaemonApi, DaemonHttp } from '@ih/client';

export { EventStream, HttpError } from '@ih/client';
export type { CardChanges, FolderInfo, PoolSummary, ReviewComment, UsageSummary } from '@ih/client';

/** The daemon's REST API (the same one the web UI uses). */
export class DaemonClient extends DaemonApi {
  constructor(baseUrl: string, token = '') {
    super(new DaemonHttp({ baseUrl, token, timeoutMs: 15_000 }));
  }
}
