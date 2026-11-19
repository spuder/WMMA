/**
 * Jev (TypeSafe System One) client: one "choice" question per transaction.
 * API shape from the jevrb / jevper clients (no official docs found yet):
 *   POST {base}/v1/systemone  Authorization: Bearer <key>
 *   {state, model, questions: {id: {type: "choice", instructions, criteria}}}
 *   -> {model, usage, answers: {id: {type, choice, probabilities, confidence}}}
 */

export const JEV_MAX_OPTIONS = 255;

export interface JevChoice {
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
}

export class JevError extends Error {
  override name = "JevError";
  constructor(
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

/** Statuses that will fail the same way for every transaction, so a run should stop asking. */
export const isJevFatal = (status: number) => status === 401 || status === 402 || status === 403;

function jevHttpMessage(status: number): string {
  if (status === 401 || status === 403) return "Jev rejected the API key";
  if (status === 402) return "Jev: out of credits";
  if (status === 429) return "Jev: rate limited or over quota";
  return `Jev: HTTP ${status}`;
}

export interface JevOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class JevClient {
  readonly #key: string;
  readonly #base: string;
  readonly #model: string;
  readonly #timeout: number;
  readonly #fetch: typeof fetch;
  calls = 0;

  constructor(opts: JevOptions) {
    if (!opts.apiKey) throw new JevError("Jev API key is not set");
    this.#key = opts.apiKey;
    this.#base = (opts.baseUrl ?? "https://api.typesafe.ai").replace(/\/$/, "");
    this.#model = opts.model ?? "jev-latest";
    this.#timeout = opts.timeoutMs ?? 15_000;
    this.#fetch = opts.fetch ?? fetch;
  }

  /** Ask one choice question about `state`. */
  async choose(state: string, instructions: string, criteria: Record<string, string>): Promise<JevChoice> {
    const options = Object.keys(criteria);
    if (options.length === 0 || options.length > JEV_MAX_OPTIONS) throw new JevError(`choice needs 1..${JEV_MAX_OPTIONS} options, got ${options.length}`);
    this.calls++;
    let res: Response;
    try {
      res = await this.#fetch(`${this.#base}/v1/systemone`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.#key}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ state, model: this.#model, questions: { category: { type: "choice", instructions, criteria } } }),
        signal: AbortSignal.timeout(this.#timeout),
      });
    } catch (e) {
      throw new JevError(`Jev request failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    if (!res.ok) throw new JevError(jevHttpMessage(res.status), res.status);
    const body = (await res.json().catch(() => null)) as { answers?: Record<string, unknown> } | null;
    const a = body?.answers?.["category"] as Partial<JevChoice> | undefined;
    if (
      !a ||
      typeof a.choice !== "string" ||
      typeof a.confidence !== "number" ||
      a.confidence < 0 ||
      a.confidence > 1 ||
      typeof a.probabilities !== "object" ||
      a.probabilities === null
    ) {
      throw new JevError("Jev returned an unexpected response shape");
    }
    if (!options.includes(a.choice)) throw new JevError(`Jev chose an option that wasn't offered: ${a.choice}`);
    const probabilities: Record<string, number> = {};
    for (const [k, v] of Object.entries(a.probabilities)) if (options.includes(k) && typeof v === "number") probabilities[k] = v;
    return { choice: a.choice, probabilities, confidence: a.confidence };
  }
}
