import { DaemonApi, DaemonHttp } from '@ih/client';
import { askForToken, getToken } from './token.ts';

// Every shape the views import from here lives in @ih/client, shared with VS Code, the CLI and the TUI.
export type {
  ActiveSession,
  AgentPrior,
  BudgetStatus,
  Candidate,
  CardChanges,
  FederationOverview,
  PeerDetail,
  PeerHit,
  PeerPreview,
  FolderInfo,
  MetricsReport,
  ModelCatalog,
  PoolHistoryData,
  PoolStatus,
  PoolWithStatus,
  RepoSetup,
  SearchHit,
  SystemHarnessId,
  SystemHarnessStatus,
  HarnessLoginFlow,
  UsageSum,
  WindowUsage,
} from '@ih/client';

/** The daemon this page came from; the token is read from browser storage on each call, and a 401 asks for it once. */
export const api = new DaemonApi(new DaemonHttp({ baseUrl: location.origin, tokenProvider: getToken, onUnauthorized: askForToken }));
