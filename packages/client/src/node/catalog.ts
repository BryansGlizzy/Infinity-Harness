// Saved machines: where other Infinity Harness daemons are and how to reach them over SSH. A profile holds only an
// opaque id, a label, an SSH target and a few ports; no passwords, keys or tokens. Authentication is OpenSSH's.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export interface MachineProfile {
  id: string;
  label: string;
  /** What you would type after `ssh`: `host`, `user@host`, or an alias from ~/.ssh/config. */
  target: string;
  /** SSH port, when it is not the default (or set in ~/.ssh/config). */
  sshPort?: number;
  /** The port the daemon listens on, on that machine. */
  remotePort: number;
  /** The Infinity Harness folder on that machine; lets a client read `.infinity-harness/api-token` over SSH when the daemon requires one. */
  remoteRoot?: string;
  enabled: boolean;
}

export interface NewMachine {
  label: string;
  target: string;
  sshPort?: number;
  remotePort?: number;
  remoteRoot?: string;
}

export const DEFAULT_REMOTE_PORT = 7420;

export function defaultCatalogFile(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'infinity-harness', 'machines.json');
}

const LABEL = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;
// An SSH destination: never something ssh could read as an option, and no spaces or shell characters.
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9_.@:%\[\]-]{0,252}$/;
const ROOT = /^[A-Za-z0-9_@%+=:,./~ -]{1,500}$/;

function port(n: unknown, what: string): number {
  if (!Number.isInteger(n) || (n as number) < 1 || (n as number) > 65535) throw new Error(`${what} must be a port number (1-65535)`);
  return n as number;
}

/** Checks a new machine's fields and fills the defaults. Throws a sentence a person can act on. */
export function validateMachine(input: NewMachine): Omit<MachineProfile, 'id' | 'enabled'> {
  if (!LABEL.test(input.label)) throw new Error('a label is 1-40 characters: letters, digits, spaces, dots, dashes, underscores');
  if (!TARGET.test(input.target)) throw new Error('the SSH target looks wrong: use host, user@host or an alias from ~/.ssh/config');
  if (input.remoteRoot !== undefined && (!ROOT.test(input.remoteRoot) || input.remoteRoot.includes('..'))) throw new Error('the remote folder looks wrong: use a plain path such as ~/infinity-harness');
  return {
    label: input.label,
    target: input.target,
    ...(input.sshPort === undefined ? {} : { sshPort: port(input.sshPort, 'the SSH port') }),
    remotePort: port(input.remotePort ?? DEFAULT_REMOTE_PORT, 'the daemon port'),
    ...(input.remoteRoot === undefined ? {} : { remoteRoot: input.remoteRoot }),
  };
}

interface CatalogFile {
  version: 1;
  machines: MachineProfile[];
}

/** The saved machines, in one JSON file written atomically and readable by this user only. */
export class MachineCatalog {
  readonly file: string;
  constructor(file: string = defaultCatalogFile()) {
    this.file = file;
  }

  list(): MachineProfile[] {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as CatalogFile;
      return Array.isArray(data.machines) ? data.machines : [];
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw new Error(`cannot read ${this.file}: ${(err as Error).message}`);
    }
  }

  private save(machines: MachineProfile[]) {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, machines } satisfies CatalogFile, null, 2) + '\n', { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** A machine by id or by exact label (labels are unique). */
  find(selector: string): MachineProfile | undefined {
    const all = this.list();
    return all.find((m) => m.id === selector) ?? all.find((m) => m.label === selector);
  }

  add(input: NewMachine): MachineProfile {
    const fields = validateMachine(input);
    const all = this.list();
    if (all.some((m) => m.label.toLowerCase() === fields.label.toLowerCase())) throw new Error(`there is already a machine called "${fields.label}"`);
    if (fields.label.toLowerCase() === 'local') throw new Error('"local" is this machine');
    const profile: MachineProfile = { id: `m_${randomBytes(5).toString('hex')}`, ...fields, enabled: true };
    this.save([...all, profile]);
    return profile;
  }

  private update(selector: string, change: (m: MachineProfile) => MachineProfile): MachineProfile {
    const all = this.list();
    const at = all.findIndex((m) => m.id === selector || m.label === selector);
    if (at < 0) throw new Error(`no saved machine "${selector}"`);
    const next = change(all[at]!);
    if (all.some((m, i) => i !== at && m.label.toLowerCase() === next.label.toLowerCase())) throw new Error(`there is already a machine called "${next.label}"`);
    all[at] = next;
    this.save(all);
    return next;
  }

  rename(selector: string, label: string): MachineProfile {
    return this.update(selector, (m) => ({ ...m, label: validateMachine({ label, target: m.target }).label }));
  }

  setEnabled(selector: string, enabled: boolean): MachineProfile {
    return this.update(selector, (m) => ({ ...m, enabled }));
  }

  /** Forgets a machine. Its daemon and everything on it keep running. */
  remove(selector: string): MachineProfile {
    const all = this.list();
    const gone = all.find((m) => m.id === selector || m.label === selector);
    if (!gone) throw new Error(`no saved machine "${selector}"`);
    this.save(all.filter((m) => m !== gone));
    return gone;
  }
}
