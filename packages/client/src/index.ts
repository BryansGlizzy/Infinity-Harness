// @ih/client: how anything talks to an Infinity Harness daemon. Isomorphic (browser and Node 22+); the Node-only
// parts (saved machines, SSH forwards) are in '@ih/client/node'.
export { DaemonHttp, HttpError, type HttpOptions } from './http.ts';
export { DaemonApi } from './api.ts';
export { EventStream, REPLAY_WITHIN_MS, isLive, type StreamMessage, type StreamStatus } from './stream.ts';
export { needsFrom, loadNeeds, type Need, type NeedKind, type NeedsInput } from './needs.ts';
export * from './types.ts';
