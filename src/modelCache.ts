import * as fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Cache only public model metadata, bound to the exact CLI executable. */
export async function cachedModels<T>(options: {
  file: string; executable: string; valid: (value: unknown) => value is T[];
  fetch: () => Promise<T[] | null>; fallback: T[]; now?: () => number; ttlMs?: number;
}): Promise<T[]> {
  const now = options.now ?? Date.now;
  let fingerprint: string;
  try {
    const stat = await fs.stat(options.executable);
    fingerprint = JSON.stringify([await fs.realpath(options.executable), stat.size, stat.mtimeMs]);
  } catch { return await options.fetch() ?? options.fallback; }
  const refresh = async () => {
    const models = await options.fetch();
    if (!models || !options.valid(models)) return null;
    const temp = `${options.file}.${randomUUID()}.tmp`;
    try {
      await fs.mkdir(path.dirname(options.file), { recursive: true });
      await fs.writeFile(temp, JSON.stringify({ version: 1, fingerprint, fetchedAt: now(), models }), { mode: 0o600 });
      await fs.rename(temp, options.file);
    } catch { /* A read-only cache must not prevent running the CLI. */ }
    finally { await fs.rm(temp, { force: true }).catch(() => {}); }
    return models;
  };
  try {
    const cache = JSON.parse(await fs.readFile(options.file, "utf8"));
    if (cache.version === 1 && cache.fingerprint === fingerprint && Number.isFinite(cache.fetchedAt) &&
        cache.fetchedAt <= now() && options.valid(cache.models)) {
      if (now() - cache.fetchedAt > (options.ttlMs ?? 24 * 60 * 60_000)) void refresh().catch(() => {});
      return cache.models;
    }
  } catch { /* Cold or invalid cache. */ }
  return await refresh() ?? options.fallback;
}
