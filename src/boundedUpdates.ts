import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";

export const MAX_UPDATE_BYTES = 64 * 1024;
export const MAX_DIFF_FILE_BYTES = 8 * 1024 * 1024;
const INLINE_BYTES = 40 * 1024;
const TEXT_BYTES = 8 * 1024;
const marker = "\n[output truncated by agy-acp]";
const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");

function boundary(text: string, end: number): number {
  return end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]) ? end - 1 : end;
}

function prefix(text: string, budget: number): string {
  let low = 0, high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (jsonBytes(text.slice(0, mid)) <= budget) low = mid;
    else high = mid - 1;
  }
  return text.slice(0, boundary(text, low));
}

function compact(value: unknown): unknown {
  if (value === undefined || jsonBytes(value) <= TEXT_BYTES) return value;
  return prefix(typeof value === "string" ? value : JSON.stringify(value), TEXT_BYTES - 128) + marker;
}

/** Local capability negotiated through initialize; no file paths are sent to other clients. */
export class BoundedUpdates {
  localDiffFiles = false;
  private root?: string;
  private filesBytes = 0;

  dispose(): void {
    if (this.root) fs.rmSync(this.root, { recursive: true, force: true });
    this.root = undefined;
    this.filesBytes = 0;
  }

  prepare(sessionId: string, update: any): any[] {
    const size = (value: any) => jsonBytes({ jsonrpc: "2.0", method: "session/update", params: { sessionId, update: value } });
    if (size(update) <= INLINE_BYTES) return [update];
    // Text chunks remain lossless; tools use a bounded display summary instead.
    if (["agent_message_chunk", "agent_thought_chunk"].includes(update.sessionUpdate) && update.content?.type === "text") {
      const result = [];
      let text = update.content.text;
      while (text.length) {
        const piece = prefix(text, INLINE_BYTES / 2);
        if (!piece) throw new Error("Unable to bound ACP text update");
        result.push({ ...update, content: { ...update.content, text: piece } });
        text = text.slice(piece.length);
      }
      if (result.every(value => size(value) <= MAX_UPDATE_BYTES)) return result;
      throw new Error("ACP text metadata exceeds update limit");
    }
    if (!["tool_call", "tool_call_update"].includes(update.sessionUpdate)) {
      if (size(update) <= MAX_UPDATE_BYTES) return [update];
      throw new Error("ACP update metadata exceeds limit");
    }
    const next = { ...update };
    const content: any[] = Array.isArray(update.content) ? update.content : [];
    const diffs = content.filter(entry => entry.type === "diff");
    if (diffs.length) {
      const payload = Buffer.from(JSON.stringify({ version: 1, diffs }));
      const first = diffs[0];
      const action = first.action ?? (first.oldText === null && !first.patch ? "create" : "update");
      let file: { path: string; sha256: string; bytes: number } | undefined;
      if (this.localDiffFiles && payload.length <= MAX_DIFF_FILE_BYTES && diffs.length <= 4096) {
        try {
          // Account for files already imported/unlinked by the client. Limit
          // outstanding artifacts as well as each individual artifact.
          if (this.root) this.filesBytes = fs.readdirSync(this.root).reduce((sum, name) => {
            try { return sum + fs.statSync(path.join(this.root!, name)).size; } catch { return sum; }
          }, 0);
          if (this.filesBytes + payload.length <= 32 * 1024 * 1024) {
            this.root ??= fs.mkdtempSync(path.join(os.tmpdir(), "agy-acp-diffs-"));
            fs.chmodSync(this.root, 0o700);
            const sha256 = createHash("sha256").update(payload).digest("hex");
            // Each notification owns a file. A client may consume/unlink one
            // before a duplicate notification is read from the pipe.
            const filename = path.join(this.root, `${sha256}-${randomBytes(8).toString("hex")}.json`);
            fs.writeFileSync(filename, payload, { mode: 0o600 });
            this.filesBytes += payload.length;
            file = { path: filename, sha256, bytes: payload.length };
          }
        } catch {
          // Artifact creation failure must never remove the wire-size bound.
        }
      }
      next.content = [{ type: "diff", path: first.path, oldText: action === "create" ? null : "",
        newText: file ? "" : `<truncated ${payload.length} bytes>`,
        _meta: { freebuddy: { action, ...(file ? { localDiffFile: file } : { truncated: true }) } }
      }, ...content.filter(entry => entry.type !== "diff").slice(0, 16)];
      if (!file) next.content.push({ type: "content", content: { type: "text", text: "Full diff exceeds the ACP inline limit and is unavailable to this client." } });
    } else if (Array.isArray(update.content)) next.content = content.slice(0, 16);
    if (next.rawInput !== undefined) next.rawInput = compact(next.rawInput);
    if (next.rawOutput !== undefined) {
      const duplicated = content.some(entry => entry.type === "content" && entry.content?.type === "text" && entry.content.text === next.rawOutput);
      if (duplicated) delete next.rawOutput;
      else next.rawOutput = compact(next.rawOutput);
    }
    if (Array.isArray(next.content)) next.content = next.content.map((entry: any) => entry.type === "content" && entry.content?.type === "text"
      ? { ...entry, content: { ...entry.content, text: compact(entry.content.text) } } : entry);
    if (Array.isArray(next.locations)) next.locations = next.locations.slice(0, 16);
    if (size(next) <= MAX_UPDATE_BYTES) return [next];
    // Last-resort tool summary retains identity/status, never an incomplete
    // JSON string disguised as a file body. File references remain available.
    const fallback = { sessionUpdate: next.sessionUpdate, toolCallId: next.toolCallId,
      status: next.status, kind: next.kind, title: compact(next.title),
      content: [...(next.content ?? []).filter((entry: any) => entry.type === "diff").slice(0, 1),
        { type: "content", content: { type: "text", text: "Tool output exceeded the ACP message limit." } }] };
    if (size(fallback) > MAX_UPDATE_BYTES) throw new Error("ACP update metadata exceeds limit");
    return [fallback];
  }
}
