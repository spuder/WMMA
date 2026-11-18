import type { Database } from "bun:sqlite";
import type { AuditLog } from "../audit";
import type { Config } from "../config";
import type { HledgerWebClient } from "../hledger/web";
import type { JournalStore } from "../journal/store";
import type { JevClient } from "../jev";

/** Everything the service layer needs. REST and MCP both call services with this. */
export interface ServiceContext {
  config: Config;
  db: Database;
  store: JournalStore;
  hledger: HledgerWebClient;
  audit: AuditLog;
  /** null/undefined when no Jev key is configured. */
  jev?: JevClient | null;
}

export class ServiceError extends Error {
  override name = "ServiceError";
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422 | 502 = 400,
  ) {
    super(message);
  }
}
