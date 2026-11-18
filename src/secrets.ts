/**
 * Secrets set from the UI (SPEC §13.4): an AES-256-GCM encrypted JSON file
 * (`/data/secrets.enc`, mode 0600). The key is derived from WMMA_SECRET_KEY,
 * which lives with the other secrets in the environment (e.g. 1Password),
 * never in /data. Environment variables still take precedence over this file.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, readFile } from "node:fs/promises";
import { atomicWrite } from "./journal/store";

export class SecretsError extends Error {
  override name = "SecretsError";
}

export const SECRET_NAMES = ["jev_api_key"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export class SecretStore {
  readonly #key: Buffer | null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly path: string,
    passphrase: string | null,
  ) {
    if (passphrase !== null && passphrase.length < 16) throw new SecretsError("WMMA_SECRET_KEY must be at least 16 characters");
    this.#key = passphrase ? createHash("sha256").update(`wmma-secrets-v1\u0000${passphrase}`).digest() : null;
  }

  get enabled(): boolean {
    return this.#key !== null;
  }

  async #readAll(): Promise<Record<string, string>> {
    let raw: string;
    try {
      raw = await readFile(this.path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw e;
    }
    if (!this.#key) throw new SecretsError("secrets file exists but WMMA_SECRET_KEY is not set");
    const f = JSON.parse(raw) as { v: number; iv: string; tag: string; data: string };
    if (f.v !== 1) throw new SecretsError(`unsupported secrets file version ${f.v}`);
    try {
      const d = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(f.iv, "base64"));
      d.setAuthTag(Buffer.from(f.tag, "base64"));
      const plain = Buffer.concat([d.update(Buffer.from(f.data, "base64")), d.final()]).toString("utf8");
      return JSON.parse(plain) as Record<string, string>;
    } catch {
      throw new SecretsError("cannot decrypt secrets file (wrong WMMA_SECRET_KEY?)");
    }
  }

  async get(name: SecretName): Promise<string | null> {
    if (!this.#key) return null;
    return (await this.#readAll())[name] ?? null;
  }

  /** Set (or with null, remove) a secret. */
  set(name: SecretName, value: string | null): Promise<void> {
    const run = this.#queue.then(async () => {
      if (!this.#key) throw new SecretsError("set WMMA_SECRET_KEY to store secrets from the UI");
      const all = await this.#readAll();
      if (value === null) delete all[name];
      else all[name] = value;
      const iv = randomBytes(12);
      const c = createCipheriv("aes-256-gcm", this.#key, iv);
      const data = Buffer.concat([c.update(JSON.stringify(all), "utf8"), c.final()]);
      await atomicWrite(this.path, JSON.stringify({ v: 1, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), data: data.toString("base64") }));
      await chmod(this.path, 0o600);
    });
    this.#queue = run.catch(() => {});
    return run;
  }
}
