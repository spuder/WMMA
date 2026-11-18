/**
 * Secrets set from the UI (SPEC §13.4): an AES-256-GCM encrypted JSON file
 * (`/data/secrets.enc`, mode 0600). A random key is kept in a separate
 * persistent key directory; WMMA_SECRET_KEY is supported for legacy migration.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { atomicWrite } from "./journal/store";

export class SecretsError extends Error {
  override name = "SecretsError";
}

export const SECRET_NAMES = ["jev_api_key", "simplefin_access_url"] as const;
export type SecretName = (typeof SECRET_NAMES)[number];

export class SecretStore {
  readonly #key: Buffer | null;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(readonly path: string, passphrase: string | null, rawKey = false) {
    if (passphrase !== null && passphrase.length < 16) throw new SecretsError("WMMA_SECRET_KEY must be at least 16 characters");
    if (rawKey && passphrase) {
      const key = Buffer.from(passphrase, "base64");
      if (key.length !== 32) throw new SecretsError("invalid generated secret key file");
      this.#key = key;
    } else {
      this.#key = passphrase ? createHash("sha256").update(`wmma-secrets-v1\u0000${passphrase}`).digest() : null;
    }
  }

  /** Open using a protected persistent key file, generating it on first run. */
  static async open(path: string, passphrase: string | null, keyPath: string): Promise<SecretStore> {
    try {
      const key = (await readFile(keyPath, "utf8")).trim();
      await chmod(keyPath, 0o600);
      return new SecretStore(path, key, true);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }

    const store = passphrase ? new SecretStore(path, passphrase) : null;
    if (store) await store.#readAll(); // validate a legacy secrets file before persisting the migrated key
    else {
      try {
        await readFile(path);
        throw new SecretsError("encrypted secrets exist but their key file is missing; restore the secret-key volume or set the legacy WMMA_SECRET_KEY");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
    }

    const key = store ? store.#key! : randomBytes(32);
    await mkdir(dirname(keyPath), { recursive: true, mode: 0o700 });
    try {
      await writeFile(keyPath, key.toString("base64"), { flag: "wx", mode: 0o600 });
      await chmod(keyPath, 0o600);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const winnerKey = (await readFile(keyPath, "utf8")).trim();
      return new SecretStore(path, winnerKey, true);
    }
    return store ?? new SecretStore(path, key.toString("base64"), true);
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
    if (!this.#key) throw new SecretsError("secret storage is not available");
    const f = JSON.parse(raw) as { v: number; iv: string; tag: string; data: string };
    if (f.v !== 1) throw new SecretsError(`unsupported secrets file version ${f.v}`);
    try {
      const d = createDecipheriv("aes-256-gcm", this.#key, Buffer.from(f.iv, "base64"));
      d.setAuthTag(Buffer.from(f.tag, "base64"));
      const plain = Buffer.concat([d.update(Buffer.from(f.data, "base64")), d.final()]).toString("utf8");
      return JSON.parse(plain) as Record<string, string>;
    } catch {
      throw new SecretsError("cannot decrypt secrets file (wrong key or missing secret-key volume?)");
    }
  }

  async get(name: SecretName): Promise<string | null> {
    if (!this.#key) return null;
    return (await this.#readAll())[name] ?? null;
  }

  /** Set (or with null, remove) a secret. */
  set(name: SecretName, value: string | null): Promise<void> {
    const run = this.#queue.then(async () => {
      if (!this.#key) throw new SecretsError("secret storage is not available");
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
