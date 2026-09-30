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
    const trimmed = val.trim();
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    ) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return val;
      }
    }
  }
  return val;
}

export function readTranscriptToolCallArgs(
  conversationId: string,
  toolName: string,
  stepIndex?: number,
): Record<string, unknown> | null {
  try {
    const brainDir = getAgyBrainDir(conversationId);
    const transcriptFile = path.join(brainDir, ".system_generated", "logs", "transcript.jsonl");
    if (!fs.existsSync(transcriptFile)) return null;

    const content = fs.readFileSync(transcriptFile, "utf-8");
    const lines = content.trim().split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (stepIndex !== undefined && typeof obj.step_index === "number" && obj.step_index > stepIndex) {
          continue;
        }
        if (Array.isArray(obj.tool_calls)) {
          const match = obj.tool_calls.find((tc: any) => tc?.name === toolName);
          if (match?.args && typeof match.args === "object") {
            const parsedArgs: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(match.args)) {
              parsedArgs[k] = parseAgyArgValue(v);
            }
            return parsedArgs;
          }
        }
      } catch {
        // ignore malformed line
      }
    }
  } catch {
    // ignore
  }
  return null;
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
  const filePath =
    p.TargetFile ?? p.targetFile ?? p.Path ?? p.path ?? p.FilePath ?? p.filePath;
  if (typeof filePath !== "string" || !filePath) return [];

  const diffs: AcpToolDiff[] = [];
  const patch = outputText ? extractDiffBlock(outputText) : null;

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
        ...(hasTarget ? { oldText: targetContent } : {}),
        ...(hasReplacement ? { newText: replacementContent } : {}),
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
        oldText: isOverwrite ? "" : null,
        ...(hasCode ? { newText: codeContent } : {}),
      });
    }
  } else if (toolName === "multi_replace_file_content") {
    const replacements = p.Replacements ?? p.replacements;
    if (Array.isArray(replacements) && replacements.length > 0) {
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
