// This machine plus every saved machine, as one set of daemons a client can list, switch between and ask in turn.
// Ids belong to one daemon: two machines can hold the same card id (a copied database, say), so anything shown
// across machines is addressed as (machine label, id), written `label:id`.
import { DaemonApi } from '../api.ts';
import { DaemonHttp } from '../http.ts';
import type { MachineCatalog, MachineProfile } from './catalog.ts';
import { MachineConnection, type ConnectionOptions, type ConnectionState } from './tunnel.ts';

export const LOCAL = 'local';

export interface Endpoint {
  /** `local` or a saved machine's label. */
  label: string;
  state: ConnectionState;
  /** Why it is not online, in words for a person. */
  error: string | null;
  /** Null until reachable. Do not keep it across a reconnect: the local port changes. */
  api: DaemonApi | null;
  baseUrl: string | null;
}

export interface FleetOptions {
  /** This machine's daemon. Default `IH_URL` or http://127.0.0.1:7420. */
  localUrl?: string;
  localToken?: string;
  catalog: MachineCatalog;
  connection?: ConnectionOptions;
}

export function localEndpointFromEnv(env: NodeJS.ProcessEnv = process.env): { url: string; token: string } {
  return { url: env.IH_URL || 'http://127.0.0.1:7420', token: env.IH_TOKEN || '' };
}

/** `laptop:c_123` → machine "laptop", id "c_123"; a bare id belongs to `fallback`. */
export function parseScoped(ref: string, fallback = LOCAL): { machine: string; id: string } {
  const at = ref.indexOf(':');
  return at > 0 ? { machine: ref.slice(0, at), id: ref.slice(at + 1) } : { machine: fallback, id: ref };
}
export const scoped = (machine: string, id: string) => (machine === LOCAL ? id : `${machine}:${id}`);

export class Fleet {
  private local: { api: DaemonApi };
  private connections = new Map<string, MachineConnection>();
  private listeners = new Set<() => void>();
  private opts: FleetOptions;

  constructor(opts: FleetOptions) {
    this.opts = opts;
    const env = localEndpointFromEnv();
    this.local = { api: new DaemonApi(new DaemonHttp({ baseUrl: opts.localUrl ?? env.url, token: opts.localToken ?? env.token, timeoutMs: 15_000 })) };
  }

  /** Starts connecting to every enabled saved machine (those already connected are left alone). */
  start() {
    const profiles = this.opts.catalog.list().filter((m) => m.enabled);
    for (const [label, c] of this.connections) {
      if (!profiles.some((p) => p.label === label)) {
        c.stop();
        this.connections.delete(label);
      }
    }
    for (const profile of profiles) {
      if (this.connections.has(profile.label)) continue;
      const c = new MachineConnection(profile, this.opts.connection);
      c.onChange(() => this.changed());
      this.connections.set(profile.label, c);
      c.start();
    }
    this.changed();
  }

  stop() {
    for (const c of this.connections.values()) c.stop();
    this.connections.clear();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  /** This machine first, then saved machines in catalog order. */
  endpoints(): Endpoint[] {
    const local: Endpoint = { label: LOCAL, state: 'online', error: null, api: this.local.api, baseUrl: this.local.api.baseUrl };
    const saved = this.opts.catalog.list().map((p: MachineProfile): Endpoint => {
      const c = this.connections.get(p.label);
      if (!p.enabled || !c) return { label: p.label, state: 'stopped', error: p.enabled ? null : 'disabled', api: null, baseUrl: null };
      return { label: p.label, state: c.state, error: c.error, api: c.state === 'online' ? c.api : null, baseUrl: c.baseUrl };
    });
    return [local, ...saved];
  }

  get(label: string): Endpoint | undefined {
    return this.endpoints().find((e) => e.label === label);
  }

  connection(label: string): MachineConnection | undefined {
    return this.connections.get(label);
  }

  /** Retry a machine that needed attention. */
  retry(label: string) {
    this.connections.get(label)?.retry();
  }
}
