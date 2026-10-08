import type { Usage } from "@agentclientprotocol/sdk";

function tokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function normalizeUsage(raw: unknown): Usage | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const native = raw as Record<string, unknown>;
  if (!tokenCount(native.input_tokens) || !tokenCount(native.output_tokens) ||
      !tokenCount(native.total_tokens)) return undefined;

  const usage: Usage = {
    inputTokens: native.input_tokens,
    outputTokens: native.output_tokens,
    totalTokens: native.total_tokens,
  };
  const optional = [
    ["thinking_tokens", "thoughtTokens"],
    ["cache_read_tokens", "cachedReadTokens"],
    ["cache_write_tokens", "cachedWriteTokens"],
  ] as const;
  for (const [source, target] of optional) {
    if (native[source] === undefined) continue;
    if (!tokenCount(native[source])) return undefined;
    usage[target] = native[source];
  }
  return usage;
}

/**
 * A fresh collector is created for each native --print invocation. AGY emits
 * only its new steps when resuming a conversation, but result.usage includes
 * earlier turns too. Only per-response step usage belongs in ACP turn usage.
 */
export class AgyTurnUsage {
  private readonly responses = new Map<number, { done: boolean; usage?: Usage; durationMs?: number }>();
  private ambiguous = false;

  observeStep(step: Record<string, unknown>): void {
    if (step.step_type !== "agent_response") return;
    if (!tokenCount(step.step_index)) {
      this.ambiguous = true;
      return;
    }
    const previous = this.responses.get(step.step_index);
    const done = step.state === "DONE";
    const durationMs = typeof step.duration_seconds === "number" ? step.duration_seconds * 1000 : NaN;
    this.responses.set(step.step_index, {
      done: done || previous?.done === true,
      usage: done && step.usage !== undefined
        ? normalizeUsage(step.usage)
        : previous?.usage,
      durationMs: done && step.duration_seconds !== undefined
        ? Number.isFinite(durationMs) && durationMs >= 1 && durationMs <= Number.MAX_SAFE_INTEGER
          ? durationMs : undefined
        : previous?.durationMs,
    });
  }

  /** Includes first-packet waiting, reasoning and text; excludes separate tool steps. */
  modelCallDurationMs(): number | undefined {
    if (!this.snapshot()) return undefined;
    let total = 0;
    for (const response of this.responses.values()) {
      if (response.durationMs === undefined) return undefined;
      total += response.durationMs;
      if (!Number.isFinite(total) || total > Number.MAX_SAFE_INTEGER) return undefined;
    }
    return total;
  }

  snapshot(): Usage | undefined {
    if (this.ambiguous || this.responses.size === 0) return undefined;
    const usages: Usage[] = [];
    for (const response of this.responses.values()) {
      if (!response.done || !response.usage) return undefined;
      usages.push(response.usage);
    }

    const sum = (field: keyof Usage): number | undefined => {
      let total = 0;
      for (const usage of usages) {
        const value = usage[field];
        if (!tokenCount(value) || !tokenCount(total + value)) return undefined;
        total += value;
      }
      return total;
    };
    const inputTokens = sum("inputTokens");
    const outputTokens = sum("outputTokens");
    const totalTokens = sum("totalTokens");
    if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) return undefined;

    const usage: Usage = { inputTokens, outputTokens, totalTokens };
    for (const field of ["thoughtTokens", "cachedReadTokens", "cachedWriteTokens"] as const) {
      const value = sum(field);
      if (value !== undefined) usage[field] = value;
    }
    return usage;
  }
}
