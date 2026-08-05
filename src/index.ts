#!/usr/bin/env node
import { agent, ndJsonStream, PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  ContentBlock,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import crypto from "node:crypto";

const VERSION = "0.2.2";

if (process.argv.includes("--version") || process.argv.includes("-v") || process.argv.includes("version")) {
  process.stdout.write(`${VERSION}\n`);
  process.exit(0);
}

// Keep stdout exclusively for the JSON-RPC pipe; debug logs go to stderr only when requested.
const DEBUG = Boolean(process.env.DEBUG || process.env.AGY_ACP_DEBUG);
const logDebug = (...args: unknown[]) => {
  if (DEBUG) console.error("[agy-acp]", ...args);
};
const logError = (...args: unknown[]) => {
  console.error("[agy-acp]", ...args);
};
console.log = logDebug;

const STATE_FILE = path.join(os.homedir(), ".agy-acp-state.json");

// --- Models ----------------------------------------------------------------
// agy exposes models via `agy models`. Some embed reasoning effort in the id
// (gemini-*-high/medium/low), others accept a separate `--effort` flag, and a
// few (Claude) reject effort entirely. Verified against agy:
//   - gemini-*, gpt-oss-120b: `--model <base> --effort <e>` works; base REQUIRES --effort.
//   - claude-*: no effort; `--model <base>` only.
//   - a full effort-baked id CONFLICTS with `--effort`, so we always split.

const EFFORTS = ["low", "medium", "high"] as const;
type Effort = (typeof EFFORTS)[number];

interface ModelDef {
  base: string;
  name: string;
  contextWindow: number;
  supportsEffort: boolean;
  defaultEffort: Effort | null;
}

const MODELS: ModelDef[] = [
  { base: "gemini-3.6-flash", name: "Gemini 3.6 Flash", contextWindow: 1_000_000, supportsEffort: true, defaultEffort: "high" },
  { base: "gemini-3.5-flash", name: "Gemini 3.5 Flash", contextWindow: 1_000_000, supportsEffort: true, defaultEffort: "high" },
  { base: "gemini-3.1-pro", name: "Gemini 3.1 Pro", contextWindow: 2_000_000, supportsEffort: true, defaultEffort: "high" },
  { base: "gpt-oss-120b", name: "GPT-OSS 120B", contextWindow: 128_000, supportsEffort: true, defaultEffort: "medium" },
  { base: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000, supportsEffort: false, defaultEffort: null },
  { base: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", contextWindow: 200_000, supportsEffort: false, defaultEffort: null },
];

const DEFAULT_MODEL_BASE = "gemini-3.6-flash";

function findModel(base: string): ModelDef | undefined {
  return MODELS.find((m) => m.base === base);
}

function contextWindowFor(base: string): number {
  return findModel(base)?.contextWindow ?? 200_000;
}

// --- Backward compatibility (agy-acp <= 0.1.x) -----------------------------
// Older versions used display-name model ids such as "Gemini 3.6 Flash (High)"
// (effort baked into the name) and stored them under `modelId`. The adapter now
// works in split form (base id + separate --effort). These helpers upgrade old
// state and accept old model ids from clients that may have persisted them.

const LEGACY_MODEL_MAP: Record<string, { base: string; effort: Effort | null }> = {
  "Gemini 3.6 Flash (High)": { base: "gemini-3.6-flash", effort: "high" },
  "Gemini 3.6 Flash (Medium)": { base: "gemini-3.6-flash", effort: "medium" },
  "Gemini 3.6 Flash (Low)": { base: "gemini-3.6-flash", effort: "low" },
  "Gemini 3.5 Flash (High)": { base: "gemini-3.5-flash", effort: "high" },
  "Gemini 3.5 Flash (Medium)": { base: "gemini-3.5-flash", effort: "medium" },
  "Gemini 3.5 Flash (Low)": { base: "gemini-3.5-flash", effort: "low" },
  "Gemini 3.1 Pro (High)": { base: "gemini-3.1-pro", effort: "high" },
  "Gemini 3.1 Pro (Low)": { base: "gemini-3.1-pro", effort: "low" },
  "Claude Sonnet 4.6 (Thinking)": { base: "claude-sonnet-4-6", effort: null },
  "Claude Opus 4.6 (Thinking)": { base: "claude-opus-4-6-thinking", effort: null },
  "GPT-OSS 120B (Medium)": { base: "gpt-oss-120b", effort: "medium" },
};

// Resolves any supported model id form (new base id, legacy display name, or a
// legacy effort-baked canonical id) to { base, effort }.
function resolveModel(value: string): { base: string; effort: Effort | null } | null {
  if (findModel(value)) {
    return { base: value, effort: findModel(value)!.defaultEffort };
  }
  if (LEGACY_MODEL_MAP[value]) return LEGACY_MODEL_MAP[value];
  const m = value.match(/^(.+)-(high|medium|low)$/);
  if (m && findModel(m[1])) return { base: m[1], effort: m[2] as Effort };
  return null;
}

// --- Modes -----------------------------------------------------------------

const MODE_ACCEPT_EDITS = "accept-edits";
const MODE_PLAN = "plan";
const MODE_IDS = [MODE_ACCEPT_EDITS, MODE_PLAN] as const;
type ModeId = (typeof MODE_IDS)[number];
const DEFAULT_MODE_ID: ModeId = MODE_ACCEPT_EDITS;

function modeState(currentModeId: ModeId): SessionModeState {
  return {
    currentModeId,
    availableModes: [
      { id: MODE_ACCEPT_EDITS, name: "Accept Edits" },
      { id: MODE_PLAN, name: "Plan Mode" },
    ],
  };
}

// --- Session state ---------------------------------------------------------

interface SessionState {
  sessionId: string;
  cwd: string;
  conversationId?: string;
  modelBase: string;
  effort: Effort | null;
  modeId: ModeId;
  additionalDirectories: string[];
}

interface StateData {
  sessions: Record<string, SessionState>;
}

// Upgrades a raw (possibly legacy) session record to the current schema.
function migrateSession(raw: any): SessionState {
  if (raw.modelBase) {
    return {
      sessionId: raw.sessionId,
      cwd: raw.cwd,
      conversationId: raw.conversationId,
      modelBase: raw.modelBase,
      effort: raw.effort ?? null,
      modeId: (raw.modeId as ModeId) ?? DEFAULT_MODE_ID,
      additionalDirectories: raw.additionalDirectories ?? [],
    };
  }
  // Legacy schema: modelId held a display name or an effort-baked canonical id.
  const resolved = raw.modelId ? resolveModel(raw.modelId) : null;
  return {
    sessionId: raw.sessionId,
    cwd: raw.cwd,
    conversationId: raw.conversationId,
    modelBase: resolved?.base ?? DEFAULT_MODEL_BASE,
    effort: resolved?.effort ?? null,
    modeId: DEFAULT_MODE_ID,
    additionalDirectories: [],
  };
}

async function readState(): Promise<StateData> {
  try {
    const data = await fs.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(data) as { sessions: Record<string, any> };
    const sessions: Record<string, SessionState> = {};
    for (const [id, raw] of Object.entries(parsed.sessions ?? {})) {
      sessions[id] = migrateSession(raw);
    }
    return { sessions };
  } catch {
    return { sessions: {} };
  }
}

async function writeState(state: StateData): Promise<void> {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    logError("Failed to write state file:", err);
  }
}

// Active child processes keyed by sessionId, for cancellation/close.
const activeProcesses: Record<string, ReturnType<typeof spawn>> = {};

// --- Config options --------------------------------------------------------

function effectiveEffort(session: SessionState): Effort | null {
  return session.effort ?? findModel(session.modelBase)?.defaultEffort ?? null;
}

function buildConfigOptions(session: SessionState): SessionConfigOption[] {
  const options: SessionConfigOption[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: session.modelBase,
      options: MODELS.map((m) => ({ value: m.base, name: m.name })),
    },
  ];

  const model = findModel(session.modelBase);
  if (model?.supportsEffort) {
    const current = effectiveEffort(session) ?? model.defaultEffort ?? "high";
    options.push({
      id: "effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue: current,
      options: EFFORTS.map((e) => ({ value: e, name: e[0].toUpperCase() + e.slice(1) })),
    });
  }

  return options;
}

// --- Prompt serialization --------------------------------------------------
// agy `--print` takes a single string, so non-text prompt blocks (embedded
// context, resource links) are serialized into the prompt text.

function serializePrompt(prompt: ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of prompt) {
    if (block.type === "text") {
      parts.push(block.text);
    } else if (block.type === "resource_link") {
      const label = block.name || block.title || block.uri;
      parts.push(block.description ? `${block.description}\n(${label})` : label);
    } else if (block.type === "resource") {
      const res = block.resource;
      if ("text" in res) {
        const uri = res.uri ? ` (${res.uri})` : "";
        parts.push("```\n" + res.text + "\n```" + uri);
      }
      // Binary resources cannot be inlined into a text prompt; skip them.
    }
    // image/audio blocks are intentionally ignored: agy --print has no way to
    // receive them (the protocol does not advertise image/audio support).
  }
  return parts.join("\n\n");
}

// --- Tool call mapping -----------------------------------------------------

function mapToolKind(toolName: string): ToolKind {
  const t = toolName || "";
  if (t === "run_command" || t === "send_command_input" || t === "notebook_execution") return "execute";
  if (
    t === "write_to_file" ||
    t === "replace_file_content" ||
    t === "multi_replace_file_content" ||
    t === "sed_file" ||
    t === "notebook_edit"
  ) {
    return "edit";
  }
  if (
    t === "view_file" ||
    t === "list_dir" ||
    t === "read_resource" ||
    t === "list_resources" ||
    t === "read_url_content" ||
    t === "list_permissions"
  ) {
    return "read";
  }
  if (t === "grep_search" || t === "find_by_name" || t === "search_web") return "search";
  if (
    t === "invoke_subagent" ||
    t === "define_subagent" ||
    t === "manage_subagents" ||
    t === "manage_task" ||
    t === "browser_subagent"
  ) {
    return "think";
  }
  return "other";
}

function extractLocation(parameters: unknown): ToolCallLocation | null {
  const p = (parameters ?? {}) as Record<string, unknown>;
  const filePath =
    p.TargetFile ?? p.targetFile ?? p.Path ?? p.path ?? p.FilePath ?? p.filePath ?? p.SearchPath;
  return typeof filePath === "string" ? { path: filePath } : null;
}

// --- agy event handling ----------------------------------------------------

interface PromptTurnResult {
  stopReason: StopReason;
}

function emit(client: AgentContext, sessionId: string, update: SessionUpdate): void {
  void client.notify("session/update", { sessionId, update });
}

function emitUsage(client: AgentContext, sessionId: string, usage: any, modelBase: string): void {
  const input = usage?.input_tokens ?? 0;
  const cacheRead = usage?.cache_read_tokens ?? 0;
  const used = input + cacheRead;
  if (used <= 0) return;
  emit(client, sessionId, {
    sessionUpdate: "usage_update",
    used,
    size: contextWindowFor(modelBase),
  });
}

function handleAgyEvent(
  eventData: any,
  client: AgentContext,
  session: SessionState,
): void {
  const { event } = eventData;
  if (!event) return;

  if (event === "init") {
    const conversationId = eventData.conversation_id;
    if (conversationId && !session.conversationId) {
      session.conversationId = conversationId;
      logDebug("Learned conversation ID:", conversationId);
    }
    return;
  }

  if (event === "result") {
    const result = eventData.result ?? {};
    if (result.usage) emitUsage(client, session.sessionId, result.usage, session.modelBase);
    if (result.status && result.status !== "SUCCESS" && result.error) {
      // Surface agy errors (e.g. invalid model/effort) to the user.
      emit(client, session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Error: ${result.error}\n` },
      });
    }
    return;
  }

  if (event !== "step_update") return;

  const step = eventData.step_update;
  if (!step) return;
  const { step_type, state, text_delta, tool_name, tool_info } = step;

  if (step_type === "agent_response") {
    if (text_delta) {
      emit(client, session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: text_delta },
        messageId: `msg-${step.step_index}`,
      });
    }
    if (state === "DONE" && step.usage) {
      emitUsage(client, session.sessionId, step.usage, session.modelBase);
    }
    return;
  }

  if (step_type === "tool") {
    const toolCallId = `tool-${step.step_index}`;
    const info = tool_info ?? {};
    const parameters = info.parameters;

    if (state === "ACTIVE") {
      const location = extractLocation(parameters);
      emit(client, session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title: tool_name ? tool_name : "Running tool",
        name: tool_name ?? undefined,
        kind: mapToolKind(tool_name),
        status: "in_progress",
        rawInput: parameters,
        locations: location ? [location] : undefined,
      });
    } else if (state === "DONE" || state === "ERROR") {
      const failed = state === "ERROR";
      const outputText = failed
        ? info?.error?.message ?? "Tool execution failed"
        : (info?.output ?? "");
      emit(client, session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        status: failed ? "failed" : "completed",
        rawOutput: failed ? info.error : outputText,
        content: outputText ? [{ type: "content", content: { type: "text", text: outputText } }] : undefined,
      });
    }
  }
}

// --- agy argument builder --------------------------------------------------

function buildAgyArgs(session: SessionState, userPrompt: string): string[] {
  const args: string[] = ["--print", userPrompt, "--output-format", "stream-json"];

  if (session.conversationId) {
    args.push("--conversation", session.conversationId);
  }

  // Model + effort: split form is required (a full effort-baked id conflicts
  // with --effort, and a base id requires --effort when supported).
  args.push("--model", session.modelBase);
  const effort = effectiveEffort(session);
  if (effort) {
    args.push("--effort", effort);
  }

  if (session.modeId !== DEFAULT_MODE_ID) {
    args.push("--mode", session.modeId);
  }

  for (const dir of session.additionalDirectories) {
    args.push("--add-dir", dir);
  }

  // agy runs headlessly under --print; without auto-approval every command
  // tool fails silently ("a tool required the 'command' permission that
  // headless mode cannot prompt for"). Default to skipping permissions unless
  // --sandbox is set or the caller opts out via AGY_ACP_NO_SKIP_PERMISSIONS=1.
  const sandbox = process.argv.includes("--sandbox");
  const optOut = ["1", "true", "yes"].includes(
    (process.env.AGY_ACP_NO_SKIP_PERMISSIONS ?? "").toLowerCase(),
  );
  if (!sandbox && !optOut) {
    args.push("--dangerously-skip-permissions");
  }
  if (sandbox) {
    args.push("--sandbox");
  }

  return args;
}

// --- ACP agent -------------------------------------------------------------

const app = agent({ name: "agy-acp" })
  .onRequest("initialize", () => {
    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: "agy-acp",
        title: "Google Antigravity",
        version: VERSION,
      },
      agentCapabilities: {
        // embeddedContext is honored by serializing resource blocks into the
        // text prompt (agy --print is text-only).
        promptCapabilities: {
          embeddedContext: true,
        },
        sessionCapabilities: {
          resume: {},
          list: {},
          close: {},
          delete: {},
          additionalDirectories: {},
        },
      },
    };
  })
  .onRequest("session/new", async (ctx) => {
    const { cwd, additionalDirectories } = ctx.params;
    const sessionId = crypto.randomUUID();

    const state = await readState();
    const session: SessionState = {
      sessionId,
      cwd,
      modelBase: DEFAULT_MODEL_BASE,
      effort: null,
      modeId: DEFAULT_MODE_ID,
      additionalDirectories: additionalDirectories ?? [],
    };
    state.sessions[sessionId] = session;
    await writeState(state);

    return {
      sessionId,
      modes: modeState(session.modeId),
      configOptions: buildConfigOptions(session),
    };
  })
  .onRequest("session/list", async () => {
    const state = await readState();
    return {
      sessions: Object.values(state.sessions).map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
      })),
    };
  })
  .onRequest("session/delete", async (ctx) => {
    const { sessionId } = ctx.params;
    const state = await readState();
    delete state.sessions[sessionId];
    await writeState(state);
  })
  .onRequest("session/resume", async (ctx) => {
    const { sessionId, additionalDirectories } = ctx.params;
    const state = await readState();
    const session = state.sessions[sessionId];
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (additionalDirectories) {
      session.additionalDirectories = additionalDirectories;
      await writeState(state);
    }
    return {
      sessionId,
      modes: modeState(session.modeId),
      configOptions: buildConfigOptions(session),
    };
  })
  .onRequest("session/set_mode", async (ctx) => {
    const { sessionId, modeId } = ctx.params;
    const state = await readState();
    const session = state.sessions[sessionId];
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!MODE_IDS.includes(modeId as ModeId)) {
      throw new Error(`Unknown mode ${modeId}`);
    }
    session.modeId = modeId as ModeId;
    await writeState(state);

    emit(ctx.client, sessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: session.modeId,
    });
  })
  .onRequest("session/set_config_option", async (ctx) => {
    const { sessionId, configId } = ctx.params;
    const state = await readState();
    const session = state.sessions[sessionId];
    if (!session) throw new Error(`Session ${sessionId} not found`);

    if (configId === "model") {
      const value = ctx.params.value as string;
      const resolved = resolveModel(value);
      if (!resolved) throw new Error(`Unknown model ${value}`);
      session.modelBase = resolved.base;
      const model = findModel(resolved.base);
      // Reset effort override when switching models so the model default applies.
      session.effort = model?.supportsEffort ? model.defaultEffort : null;
    } else if (configId === "effort") {
      const value = ctx.params.value as string;
      if (!EFFORTS.includes(value as Effort)) throw new Error(`Unknown effort ${value}`);
      session.effort = value as Effort;
    }
    await writeState(state);

    return { configOptions: buildConfigOptions(session) };
  })
  .onRequest("session/close", async (ctx) => {
    const { sessionId } = ctx.params;
    const child = activeProcesses[sessionId];
    if (child) {
      child.kill("SIGINT");
      delete activeProcesses[sessionId];
    }
  })
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt } = ctx.params;
    const state = await readState();
    const session = state.sessions[sessionId];
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const userPrompt = serializePrompt(prompt);
    const agyArgs = buildAgyArgs(session, userPrompt);

    return new Promise((resolve, reject) => {
      const child = spawn("agy", agyArgs, {
        cwd: session.cwd,
        env: { ...process.env },
      });
      activeProcesses[sessionId] = child;

      const turn: PromptTurnResult = { stopReason: "end_turn" };
      let buffer = "";

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            handleAgyEvent(JSON.parse(line), ctx.client, session);
          } catch {
            logDebug("raw output:", line);
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
      });

      child.on("error", (err) => {
        delete activeProcesses[sessionId];
        const errno = err as NodeJS.ErrnoException;
        reject(
          errno.code === "ENOENT"
            ? new Error("Failed to start `agy`. Is the Antigravity CLI installed and on PATH?")
            : err
        );
      });

      child.on("close", async (code) => {
        delete activeProcesses[sessionId];
        await writeState(state);

        const wasKilled = child.killed || code === null;
        resolve({ stopReason: wasKilled ? "cancelled" : turn.stopReason });
      });
    });
  })
  .onNotification("session/cancel", async (ctx) => {
    const { sessionId } = ctx.params;
    const child = activeProcesses[sessionId];
    if (child) {
      logDebug("Cancelling active process for session", sessionId);
      child.kill("SIGINT");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, 2000);
    }
  });

// --- stdio streaming -------------------------------------------------------

const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as any,
  Readable.toWeb(process.stdin) as any,
);

app.connect(stream);
