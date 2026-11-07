import { DaemonApi, DaemonHttp } from '@mh/client';
import { askForToken, getToken } from './token.ts';

// Every shape the views import from here lives in @mh/client, shared with VS Code, the CLI and the TUI.
export type {
  ActiveSession,
  AgentPrior,
  BudgetStatus,
  Candidate,
  CardChanges,
  FolderInfo,
  MetricsReport,
  ModelCatalog,
  PoolHistoryData,
  PoolStatus,
  PoolWithStatus,
  RepoSetup,
  SearchHit,
  UsageSum,
  WindowUsage,
} from '@mh/client';

/** The daemon this page came from; the token is read from browser storage on each call, and a 401 asks for it once. */
export const api = new DaemonApi(new DaemonHttp({ baseUrl: location.origin, tokenProvider: getToken, onUnauthorized: askForToken }));
