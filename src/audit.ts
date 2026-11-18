/** Append-only audit log (SPEC §2): one JSON object per line. */
import { appendFile } from "node:fs/promises";

export interface AuditEntry {
  actor: string;
  operation: string;
  inputs: unknown;
  before: unknown;
  after: unknown;
}

export class AuditLog {
  #queue: Promise<unknown> = Promise.resolve();
  constructor(readonly path: string) {}

  append(entry: AuditEntry): Promise<void> {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n";
    const run = this.#queue.then(() => appendFile(this.path, line, { mode: 0o640 }));
    this.#queue = run.catch(() => {});
    return run;
  }
}
