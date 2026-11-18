/**
 * Runs hledger-web as a supervised child bound to 127.0.0.1, read-only
 * (--allow=view, SPEC §13.5), and talks to its JSON API.
 */
import type { Subprocess } from "bun";

export interface HledgerWebOptions {
  bin: string;
  port: number;
  journal: string;
  log?: (msg: string) => void;
}

export class HledgerWebClient {
  constructor(readonly baseUrl: string) {}

  async #get<T>(path: string, timeoutMs = 5000): Promise<T> {
    const res = await fetch(this.baseUrl + path, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error(`hledger-web ${path}: HTTP ${res.status}`);
    return (await res.json()) as T;
  }

  version(): Promise<string> {
    return this.#get<string>("/version");
  }

  accountNames(): Promise<string[]> {
    return this.#get<string[]>("/accountnames");
  }

  /** Raw hledger transactions; amounts are read with money.fromHledgerQuantity. */
  transactions(): Promise<HledgerTransaction[]> {
    return this.#get<HledgerTransaction[]>("/transactions");
  }
}

export interface HledgerQuantity {
  decimalMantissa: number;
  decimalPlaces: number;
}

export interface HledgerPosting {
  paccount: string;
  pamount: Array<{ acommodity: string; aquantity: HledgerQuantity }>;
  ptags: Array<[string, string]>;
}

export interface HledgerTransaction {
  tindex: number;
  tdate: string;
  tdescription: string;
  ttags: Array<[string, string]>;
  tpostings: HledgerPosting[];
  tsourcepos: Array<{ sourceName: string; sourceLine: number }>;
}

export class HledgerWeb {
  readonly client: HledgerWebClient;
  #proc: Subprocess | null = null;
  #stopping = false;
  #restartDelay = 500;

  constructor(private readonly opts: HledgerWebOptions) {
    this.client = new HledgerWebClient(`http://127.0.0.1:${opts.port}`);
  }

  get running(): boolean {
    return this.#proc !== null && this.#proc.exitCode === null;
  }

  #log(msg: string): void {
    (this.opts.log ?? console.error)(`[hledger-web] ${msg}`);
  }

  #spawn(): void {
    const { bin, port, journal } = this.opts;
    const proc = Bun.spawn(
      [bin, "--serve-api", "--allow=view", "--host=127.0.0.1", `--port=${port}`, "-f", journal],
      { stdout: "inherit", stderr: "inherit", env: { ...process.env, LANG: process.env.LANG || "C.UTF-8" } },
    );
    this.#proc = proc;
    proc.exited.then((code) => {
      if (this.#proc === proc) this.#proc = null;
      if (this.#stopping) return;
      this.#log(`exited with code ${code}; restarting in ${this.#restartDelay}ms`);
      setTimeout(() => {
        if (!this.#stopping) this.#spawn();
      }, this.#restartDelay);
      this.#restartDelay = Math.min(this.#restartDelay * 2, 30_000);
    });
  }

  /** Start and wait until the API answers. */
  async start(timeoutMs = 30_000): Promise<string> {
    this.#stopping = false;
    this.#spawn();
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown;
    while (Date.now() < deadline) {
      try {
        const v = await this.client.version();
        this.#restartDelay = 500;
        return v;
      } catch (e) {
        lastErr = e;
        await Bun.sleep(200);
      }
    }
    await this.stop();
    throw new Error(`hledger-web did not become ready within ${timeoutMs}ms: ${String(lastErr)}`);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const p = this.#proc;
    if (!p) return;
    p.kill("SIGTERM");
    const killer = setTimeout(() => p.kill("SIGKILL"), 5000);
    await p.exited;
    clearTimeout(killer);
  }
}
