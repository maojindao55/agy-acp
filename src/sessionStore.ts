import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";

/** Separate atomic records prevent different bridge processes overwriting each other's sessions. */
export class SessionStore<T extends { sessionId: string }> {
  private directory: string;
  constructor(private home: string, private migrate: (raw: any) => T) {
    this.directory = path.join(home, ".agy-acp", "sessions");
  }

  private file(id: string): string {
    return path.join(this.directory, createHash("sha256").update(id).digest("hex") + ".json");
  }

  private async legacy(): Promise<Record<string, any>> {
    try { return JSON.parse(await fs.readFile(path.join(this.home, ".agy-acp-state.json"), "utf8")).sessions ?? {}; }
    catch { return {}; }
  }

  async get(id: string): Promise<T | undefined> {
    try {
      const record = JSON.parse(await fs.readFile(this.file(id), "utf8"));
      if (record.sessionId !== id || record.deleted) return;
      return this.migrate(record);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const raw = (await this.legacy())[id];
    return raw ? this.migrate(raw) : undefined;
  }

  private async write(record: T | { sessionId: string; deleted: true }): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = this.file(record.sessionId), temp = file + "." + randomUUID() + ".tmp";
    try {
      await fs.writeFile(temp, JSON.stringify(record, null, 2), { mode: 0o600 });
      await fs.rename(temp, file);
    } finally { await fs.rm(temp, { force: true }); }
  }

  set(session: T): Promise<void> { return this.write(session); }
  // A tombstone prevents a deleted legacy session reappearing on the next bridge restart.
  delete(id: string): Promise<void> { return this.write({ sessionId: id, deleted: true }); }

  async list(): Promise<T[]> {
    const sessions = new Map<string, T>();
    for (const [id, raw] of Object.entries(await this.legacy())) sessions.set(id, this.migrate(raw));
    let files: string[];
    try { files = await fs.readdir(this.directory); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...sessions.values()];
      throw error;
    }
    for (const file of files.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const record = JSON.parse(await fs.readFile(path.join(this.directory, file), "utf8"));
      if (typeof record.sessionId !== "string" || path.basename(this.file(record.sessionId)) !== file) continue;
      if (record.deleted) sessions.delete(record.sessionId);
      else sessions.set(record.sessionId, this.migrate(record));
    }
    return [...sessions.values()];
  }
}
