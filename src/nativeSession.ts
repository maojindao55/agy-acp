import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export class NativeTurnCancelled extends Error {}

/** One serialized NDJSON conversation. A result ends a turn, not the process. */
export class NativeSession {
  private pending?: { event: (value: any) => void; resolve: () => void; reject: (error: Error) => void };
  private buffer = "";
  private decoder = new StringDecoder("utf8");
  private ended = false;
  private stderr = "";
  private idle?: ReturnType<typeof setTimeout>;

  constructor(readonly child: ChildProcessWithoutNullStreams, readonly signature: string) {
    child.stdin.on("error", error => this.fail(error));
    child.stdout.on("data", chunk => { this.buffer += this.decoder.write(chunk); this.consume(); });
    child.stderr.on("data", chunk => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000);
      process.stderr.write(chunk);
    });
    child.on("error", error => { this.ended = true; this.fail(error); });
    child.on("close", code => {
      this.ended = true;
      this.buffer += this.decoder.end();
      this.consume(true);
      this.fail(new Error(`Antigravity stream exited before the turn completed (code ${code ?? "signal"})${this.stderr.trim() ? `: ${this.stderr.trim()}` : ""}`));
      if (this.idle) clearTimeout(this.idle);
    });
  }

  get alive(): boolean {
    return !this.ended && this.child.exitCode === null && this.child.signalCode === null && !this.child.stdin.destroyed;
  }
  get busy(): boolean { return Boolean(this.pending); }

  run(prompt: string, event: (value: any) => void): Promise<void> {
    if (this.pending) return Promise.reject(new Error("This AGY session already has an active turn."));
    if (!this.alive) return Promise.reject(new Error("The AGY stream is closed."));
    if (this.idle) clearTimeout(this.idle);
    return new Promise((resolve, reject) => {
      this.pending = { event, resolve, reject };
      this.child.stdin.write(JSON.stringify({ event: "user", message: { content: prompt } }) + "\n", error => {
        if (error) this.fail(error);
      });
    });
  }

  dispose(cancel = false): void {
    this.ended = true;
    if (this.idle) clearTimeout(this.idle);
    this.fail(cancel ? new NativeTurnCancelled("Turn cancelled") : new Error("AGY session closed."));
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill("SIGKILL");
    }, 1000);
    timer.unref();
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(error);
  }

  private consume(flush = false): void {
    let newline;
    while ((newline = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      this.line(line);
    }
    if (flush && this.buffer.trim()) { const line = this.buffer; this.buffer = ""; this.line(line); }
  }

  private line(line: string): void {
    let value: any;
    try { value = JSON.parse(line); } catch { return; }
    const pending = this.pending;
    if (!pending) return;
    try { pending.event(value); } catch (error) { this.fail(error as Error); return; }
    if (value.event !== "result") return;
    this.pending = undefined;
    this.idle = setTimeout(() => this.dispose(), 10 * 60_000);
    this.idle.unref();
    pending.resolve();
  }
}
