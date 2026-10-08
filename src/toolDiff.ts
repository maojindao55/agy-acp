import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AcpToolDiff {
  type: "diff";
  path: string;
  patch?: string;
  oldText?: string | null;
  newText?: string;
}

export function extractDiffBlock(text: string): string | null {
  if (!text) return null;
  const match = text.match(/\[diff_block_start\]\s*([\s\S]*?)\s*\[diff_block_end\]/);
  return match ? match[1].trim() : null;
}

export function getAgyBrainDir(conversationId: string): string {
  const baseDir =
    process.env.ANTIGRAVITY_APP_DATA_DIR ||
    path.join(os.homedir(), ".gemini", "antigravity-cli");
  return path.join(baseDir, "brain", conversationId);
}

export function readStepOutputText(conversationId: string, stepIndex: number): string | null {
  try {
    const brainDir = getAgyBrainDir(conversationId);
    const outputFile = path.join(brainDir, ".system_generated", "steps", String(stepIndex), "output.txt");
    if (fs.existsSync(outputFile)) {
      return fs.readFileSync(outputFile, "utf-8");
    }
  } catch {
    // ignore
  }
  return null;
}

function parseAgyArgValue(val: unknown): unknown {
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      // A display transcript can contain an incomplete JSON value followed by
      // <truncated N bytes>. Never attempt to unescape that incomplete value.
      return val;
    }
  }
  return val;
}

/** Read recent records without rereading/copying the entire conversation log. */
function* transcriptLines(file: string): Generator<string> {
  const fd = fs.openSync(file, "r");
  try {
    let end = fs.fstatSync(fd).size;
    let carry = Buffer.alloc(0);
    while (end > 0) {
      const length = Math.min(end, 64 * 1024);
      end -= length;
      const chunk = Buffer.alloc(length);
      if (fs.readSync(fd, chunk, 0, length, end) !== length) throw new Error("Transcript changed during read");
      const data = Buffer.concat([chunk, carry]);
      const first = end > 0 ? data.indexOf(10) : -1;
      if (end > 0 && first < 0) {
        if (data.length > 16 * 1024 * 1024) throw new Error("Transcript record exceeds read limit");
        carry = data;
        continue;
      }
      const lines = data.subarray(first + 1).toString("utf8").split("\n");
      carry = end > 0 ? data.subarray(0, first) : Buffer.alloc(0);
      for (let i = lines.length - 1; i >= 0; i--) if (lines[i].trim()) yield lines[i];
    }
  } finally { fs.closeSync(fd); }
}

export function readTranscriptToolCallArgs(
  conversationId: string,
  toolName: string,
  stepIndex?: number,
  targetFile?: string,
): Record<string, unknown> | null {
  const logsDir = path.join(getAgyBrainDir(conversationId), ".system_generated", "logs");
  let selected: { step: number; args?: Record<string, unknown> } | undefined;
  let observedToolStep = false;
  // The full transcript contains native JSON values. The display transcript
  // JSON-encodes each argument again and truncates it at about 2 KiB.
  for (const filename of ["transcript_full.jsonl", "transcript.jsonl"]) {
    try {
      for (const line of transcriptLines(path.join(logsDir, filename))) {
        try {
          const obj = JSON.parse(line);
          const step = typeof obj.step_index === "number" ? obj.step_index : -1;
          if (stepIndex !== undefined && step > stepIndex) continue;
          if (step === stepIndex && ["GENERIC", "CODE_ACTION"].includes(obj.type)) observedToolStep = true;
          if (!Array.isArray(obj.tool_calls) || !obj.tool_calls.length) continue;
          const calls = obj.tool_calls.filter((tc: any) => tc?.name === toolName);
          const matches = calls.filter((tc: any) => tc.args && typeof tc.args === "object" && !Array.isArray(tc.args))
            .map((tc: any) => filename === "transcript_full.jsonl" ? tc.args as Record<string, unknown> : Object.fromEntries(
              Object.entries(tc.args).map(([key, value]) => [key, parseAgyArgValue(value)])
            ))
            .filter((args: Record<string, unknown>) => !targetFile || toolFilePath(args) === targetFile);
          // A missing/ambiguous path in the latest batch must not make us fall
          // back to an older edit of the same file.
          if (!selected || step > selected.step) selected = { step, args: matches.length === 1 ? matches[0] : undefined };
          break;
        } catch {
          // A native process may still be writing the last JSONL record.
        }
      }
    } catch {
      // Older CLI versions may not produce the full transcript.
    }
  }
  // A planner normally immediately precedes its tool step. For gaps, require
  // the current tool record as evidence; otherwise both logs may be stale.
  if (selected && stepIndex !== undefined && selected.step < stepIndex - 1 && !observedToolStep) return null;
  return selected?.args ?? null;
}

function toolFilePath(p: Record<string, unknown>): unknown {
  return p.TargetFile ?? p.targetFile ?? p.Path ?? p.path ?? p.FilePath ?? p.filePath;
}

function hasTruncatedArg(value: unknown): boolean {
  if (typeof value === "string") return /(?:^|\r?\n)<truncated \d+ (?:bytes|lines)>\s*$/.test(value);
  if (Array.isArray(value)) return value.some(hasTruncatedArg);
  if (value && typeof value === "object") return Object.values(value).some(hasTruncatedArg);
  return false;
}

export function resolveToolCallParameters(
  conversationId: string,
  toolName: string,
  stepIndex: number,
  parameters: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!["write_to_file", "replace_file_content", "multi_replace_file_content"].includes(toolName)) return parameters;
  const p = parameters ?? {};
  const text = (value: unknown) => typeof value === "string" && !hasTruncatedArg(value);
  const replacements = p.Replacements ?? p.replacements;
  const complete = toolName === "write_to_file"
    ? text(p.CodeContent ?? p.codeContent ?? p.content)
    : toolName === "replace_file_content"
      ? text(p.TargetContent ?? p.targetContent) && text(p.ReplacementContent ?? p.replacementContent)
      : Array.isArray(replacements) && replacements.length > 0 && replacements.every(rep =>
        rep && text(rep.TargetContent) && text(rep.ReplacementContent));
  const file = toolFilePath(p);
  if (complete && typeof file === "string" && file) return parameters;
  const recorded = readTranscriptToolCallArgs(conversationId, toolName, stepIndex, typeof file === "string" ? file : undefined);
  if (!recorded) return parameters;
  // Keep complete stream parameters; fill missing/truncated fields from the
  // matching transcript call, rather than letting a shortened stream win.
  const merged = { ...recorded };
  for (const [key, value] of Object.entries(p)) {
    if (value !== undefined && value !== null && (!hasTruncatedArg(value) || merged[key] === undefined)) {
      merged[key] = value;
    }
  }
  return merged;
}

/**
 * Build standard ACP diff objects from Antigravity file editing tool parameters and output text.
 */
export function buildToolCallDiffs(
  toolName: string,
  parameters: unknown,
  outputText?: string,
): AcpToolDiff[] {
  if (!parameters || typeof parameters !== "object") return [];
  const p = parameters as Record<string, unknown>;
  const filePath = toolFilePath(p);
  if (typeof filePath !== "string" || !filePath) return [];

  const diffs: AcpToolDiff[] = [];
  const patch = outputText ? extractDiffBlock(outputText) : null;
  const useSnippets = !patch || !hasTruncatedArg([
    p.TargetContent ?? p.targetContent,
    p.ReplacementContent ?? p.replacementContent,
    p.CodeContent ?? p.codeContent ?? p.content,
    p.Replacements ?? p.replacements,
  ]);

  if (toolName === "replace_file_content") {
    const targetContent = p.TargetContent ?? p.targetContent;
    const replacementContent = p.ReplacementContent ?? p.replacementContent;
    const hasTarget = typeof targetContent === "string";
    const hasReplacement = typeof replacementContent === "string";

    if (patch || (hasTarget && hasReplacement)) {
      diffs.push({
        type: "diff",
        path: filePath,
        ...(patch ? { patch } : {}),
        ...(hasTarget && useSnippets ? { oldText: targetContent } : {}),
        ...(hasReplacement && useSnippets ? { newText: replacementContent } : {}),
      });
    }
  } else if (toolName === "write_to_file") {
    const codeContent =
      p.CodeContent ?? p.codeContent ?? (typeof p.content === "string" ? p.content : undefined);
    const hasCode = typeof codeContent === "string";
    if (hasCode || patch) {
      const isOverwrite =
        p.Overwrite === true || p.overwrite === true || p.Overwrite === "true";
      diffs.push({
        type: "diff",
        path: filePath,
        ...(patch ? { patch } : {}),
        ...(useSnippets ? { oldText: isOverwrite ? "" : null } : {}),
        ...(hasCode && useSnippets ? { newText: codeContent } : {}),
      });
    }
  } else if (toolName === "multi_replace_file_content") {
    const replacements = p.Replacements ?? p.replacements;
    if (useSnippets && Array.isArray(replacements) && replacements.length > 0) {
      for (const rep of replacements) {
        if (typeof rep?.TargetContent === "string" && typeof rep?.ReplacementContent === "string") {
          diffs.push({
            type: "diff",
            path: filePath,
            oldText: rep.TargetContent,
            newText: rep.ReplacementContent,
          });
        }
      }
    } else if (patch) {
      diffs.push({
        type: "diff",
        path: filePath,
        patch,
      });
    }
  }

  return diffs;
}
