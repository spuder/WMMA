/**
 * JournalStore owns the /data layout and is the only code that writes journal
 * files (SPEC §2). Writes are serialised and atomic (temp file + rename), so
 * hledger-web never sees a half-written journal.
 */
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { parseBudgets, renderBudgets, validateChange, type BudgetChange } from "./budgets";
import { formatAccountDirective, formatTags, formatTransaction, parseTagComment, validateAccount, validateDate, validateTags, type AccountType, type Tags, type Transaction } from "./format";

export const IMPORT_SOURCES = ["ynab", "qfx", "csv", "simplefin", "reihub"] as const;

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

const HEADER = "; Managed by WMMA. Do not edit by hand: changes may be overwritten.\n";

export interface DataPaths {
  root: string;
  imports: string;
  journals: string;
  accountsDir: string;
  main: string;
  accounts: string;
  prices: string;
  budgets: string;
  db: string;
  audit: string;
}

export function dataPaths(root: string): DataPaths {
  const journals = join(root, "journals");
  return {
    root,
    imports: join(root, "imports"),
    journals,
    accountsDir: join(journals, "accounts"),
    main: join(journals, "main.journal"),
    accounts: join(journals, "accounts.journal"),
    prices: join(journals, "prices.journal"),
    budgets: join(journals, "budgets.journal"),
    db: join(root, "wmma.db"),
    audit: join(root, "audit.log"),
  };
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

async function readOrEmpty(p: string): Promise<string> {
  try {
    return await readFile(p, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw e;
  }
}

/** Write a file atomically: temp file in the same directory, fsync, rename. */
export async function atomicWrite(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${crypto.randomUUID()}`;
  const fh = await open(tmp, "w", 0o640);
  try {
    await fh.writeFile(content, "utf8");
    await fh.sync();
  } catch (e) {
    await fh.close();
    await rm(tmp, { force: true });
    throw e;
  }
  await fh.close();
  await rename(tmp, path);
}

export function validateSlug(slug: string): void {
  if (!SLUG_RE.test(slug)) throw new Error(`invalid account slug ${JSON.stringify(slug)}`);
}

export class JournalStore {
  readonly paths: DataPaths;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(dataDir: string) {
    this.paths = dataPaths(dataDir);
  }

  /** Run fn after all previously queued writes; failures don't poison the queue. */
  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(fn, fn);
    this.#queue = run.catch(() => {});
    return run;
  }

  /** Create the data folder layout (idempotent). */
  init(): Promise<void> {
    return this.#serial(async () => {
      const p = this.paths;
      for (const src of IMPORT_SOURCES) await mkdir(join(p.imports, src), { recursive: true });
      await mkdir(p.accountsDir, { recursive: true });
      for (const f of [p.accounts, p.prices, p.budgets]) {
        if (!(await exists(f))) await atomicWrite(f, HEADER);
      }
      await this.#writeMain();
    });
  }

  accountJournalPath(slug: string): string {
    validateSlug(slug);
    return join(this.paths.accountsDir, `${slug}.journal`);
  }

  async listAccountJournals(): Promise<string[]> {
    const names = await readdir(this.paths.accountsDir).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [] as string[];
      throw e;
    });
    return names
      .filter((n) => n.endsWith(".journal") && SLUG_RE.test(n.slice(0, -".journal".length)))
      .sort();
  }

  /** main.journal lists every include explicitly: hledger errors on globs that match nothing. */
  async #writeMain(): Promise<void> {
    // USD only in V1 (SPEC §1). Declaring it also satisfies `hledger check --strict`.
    const lines = [HEADER, "commodity $1000.00", "include accounts.journal", "include prices.journal", "include budgets.journal"];
    for (const f of await this.listAccountJournals()) lines.push(`include accounts/${f}`);
    const content = lines.join("\n") + "\n";
    if ((await readOrEmpty(this.paths.main)) !== content) await atomicWrite(this.paths.main, content);
  }

  /** Append transactions to an account's journal, creating it (and its include) if needed. */
  async appendTransactions(slug: string, txns: readonly Transaction[]): Promise<void> {
    const path = this.accountJournalPath(slug);
    // Format (and validate) everything before touching disk: all or nothing.
    const text = txns.map(formatTransaction).join("\n");
    return this.#serial(async () => {
      const existing = await readOrEmpty(path);
      const isNew = existing === "";
      const base = isNew ? HEADER : existing.endsWith("\n") ? existing : existing + "\n";
      if (txns.length > 0 || isNew) await atomicWrite(path, `${base}\n${text}`);
      if (isNew) await this.#writeMain();
    });
  }

  /**
   * Rewrite the header of the transaction tagged wmma_id:<id> in `file`:
   * optionally change its date and set/replace tags. Postings are untouched.
   */
  async updateTransactionHeader(file: string, wmmaId: string, update: { date?: string; setTags?: Tags }): Promise<void> {
    return this.updateTransaction(file, wmmaId, update);
  }

  /**
   * Edit the transaction tagged wmma_id:<id> in `file`: header date/tags, and
   * optionally move one posting from account `from` to `to`.
   */
  async updateTransaction(
    file: string,
    wmmaId: string,
    update: { date?: string; setTags?: Tags; replaceAccount?: { from: string; to: string } },
  ): Promise<void> {
    const path = resolve(file);
    if (!path.startsWith(resolve(this.paths.journals) + sep)) throw new Error(`refusing to edit a file outside the journals folder: ${file}`);
    if (update.date) validateDate(update.date);
    return this.#serial(async () => {
      const lines = (await readFile(path, "utf8")).split("\n");
      const idx = lines.findIndex((l) => /^\d{4}-\d{2}-\d{2} /.test(l) && new RegExp(`[;,] ?wmma_id:${wmmaId.replace(/[^A-Za-z0-9_-]/g, "")}(,|$)`).test(l));
      if (idx < 0) throw new Error(`transaction ${wmmaId} not found in ${file}`);
      const line = lines[idx]!;
      const semi = line.indexOf("  ; ");
      const head = semi < 0 ? line : line.slice(0, semi);
      const tags = { ...parseTagComment(semi < 0 ? "" : line.slice(semi + 4)), ...(update.setTags ?? {}) };
      validateTags(tags);
      lines[idx] = `${update.date ?? head.slice(0, 10)}${head.slice(10)}  ; ${formatTags(tags)}`;
      if (update.replaceAccount) {
        const { from, to } = update.replaceAccount;
        validateAccount(to);
        let replaced = 0;
        for (let i = idx + 1; i < lines.length && lines[i]!.startsWith("    "); i++) {
          const m = /^ {4}(\S(?:.*?\S)?)( {2,}.*)$/.exec(lines[i]!);
          if (m && m[1] === from && replaced === 0) {
            lines[i] = `    ${to}${m[2]}`;
            replaced++;
          }
        }
        if (replaced === 0) throw new Error(`transaction ${wmmaId} has no posting to ${from}`);
      }
      await atomicWrite(path, lines.join("\n"));
    });
  }

  /** Declare an account in accounts.journal. Returns false if it was already declared. */
  async declareAccount(name: string, opts: { type?: AccountType; tags?: Tags } = {}): Promise<boolean> {
    return (await this.declareAccounts([{ name, ...opts }])) === 1;
  }

  async readBudgets(): Promise<BudgetChange[]> {
    return parseBudgets(await readOrEmpty(this.paths.budgets));
  }

  /** Read-modify-write budgets.journal under the write lock. */
  async updateBudgets(fn: (changes: BudgetChange[]) => BudgetChange[]): Promise<BudgetChange[]> {
    return this.#serial(async () => {
      const next = fn(parseBudgets(await readOrEmpty(this.paths.budgets)));
      for (const c of next) validateChange(c);
      const text = renderBudgets(next, HEADER);
      await atomicWrite(this.paths.budgets, text);
      return parseBudgets(text);
    });
  }

  /**
   * Declare several accounts in one write. Tags on an already-declared
   * account are merged into its directive. Returns how many were newly declared.
   */
  async declareAccounts(list: ReadonlyArray<{ name: string; type?: AccountType; tags?: Tags }>): Promise<number> {
    for (const a of list) formatAccountDirective(a.name, a); // validate up front
    return this.#serial(async () => {
      const existing = await readOrEmpty(this.paths.accounts);
      const lines = existing === "" ? [HEADER.trimEnd()] : existing.replace(/\n$/, "").split("\n");
      const index = new Map<string, number>();
      lines.forEach((l, i) => {
        const m = /^account (.+?)(?: {2}.*)?$/.exec(l);
        if (m) index.set(m[1]!, i);
      });
      let added = 0;
      let changed = false;
      for (const a of list) {
        const i = index.get(a.name);
        if (i === undefined) {
          index.set(a.name, lines.length);
          lines.push(formatAccountDirective(a.name, a).trimEnd());
          added++;
          changed = true;
          continue;
        }
        if (!a.tags || Object.keys(a.tags).length === 0) continue;
        const line = lines[i]!;
        const semi = line.indexOf("  ; ");
        const current = parseTagComment(semi < 0 ? "" : line.slice(semi + 4));
        const merged = { ...current, ...a.tags };
        if (Object.entries(a.tags).every(([k, v]) => current[k] === v)) continue;
        const { type, ...rest } = merged;
        lines[i] = formatAccountDirective(a.name, { ...(type ? { type: type as AccountType } : {}), tags: rest }).trimEnd();
        changed = true;
      }
      if (changed) await atomicWrite(this.paths.accounts, lines.join("\n") + "\n");
      return added;
    });
  }
}
