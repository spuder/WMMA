/** Which commit this server was built from, shown in Settings → About. */
declare const WMMA_COMMIT: string | undefined; // replaced by `bun build --define` in the Docker image and `bun run build`

function gitHead(): string | null {
  try {
    const r = Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: import.meta.dir, stderr: "ignore" });
    return r.success ? r.stdout.toString().trim() || null : null;
  } catch {
    return null;
  }
}

export const buildCommit: string | null =
  process.env.WMMA_COMMIT?.trim() || (typeof WMMA_COMMIT === "string" && WMMA_COMMIT ? WMMA_COMMIT : null) || gitHead();
