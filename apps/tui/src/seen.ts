// What this terminal has already looked at. "Seen" belongs to the device: the phone and the desk each keep their own,
// so reading the list on one does not clear the other's markers (the same rule herdr's Done badge follows).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export class SeenStore {
  private file: string | null;
  private data: Record<string, string[]> = {};

  constructor(file: string | null) {
    this.file = file;
    if (!file) return;
    try {
      this.data = (JSON.parse(readFileSync(file, 'utf8')) as { seen?: Record<string, string[]> }).seen ?? {};
    } catch {
      // first run, or unreadable: nothing is seen yet
    }
  }

  isSeen(scope: string, key: string): boolean {
    return this.data[scope]?.includes(key) ?? false;
  }

  mark(scope: string, keys: string[]) {
    const have = new Set(this.data[scope] ?? []);
    let changed = false;
    for (const k of keys) if (!have.has(k)) (have.add(k), (changed = true));
    if (changed) {
      this.data[scope] = [...have];
      this.save();
    }
  }

  /** Forget markers for things that no longer wait, so the file does not grow forever. */
  retain(scope: string, keys: string[]) {
    const keep = new Set(keys);
    const before = this.data[scope] ?? [];
    const after = before.filter((k) => keep.has(k));
    if (after.length !== before.length) {
      this.data[scope] = after;
      this.save();
    }
  }

  private save() {
    if (!this.file) return;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify({ seen: this.data }) + '\n', { mode: 0o600 });
      renameSync(tmp, this.file);
    } catch {
      // not worth failing the screen over
    }
  }
}
