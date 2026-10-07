#!/usr/bin/env node
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  ContentBlock,
  McpServer,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import crypto from "node:crypto";
import { resolveAgyExecutable } from "./agyExecutable.js";
import { AgyTurnUsage } from "./turnUsage.js";
import { NativeSession, NativeTurnCancelled } from "./nativeSession.js";
import { cachedModels } from "./modelCache.js";
import { SessionStore } from "./sessionStore.js";
import { SessionMcpConfigs } from "./sessionMcpConfig.js";
import {
  EFFORTS,
  type Effort,
  MODE_ACCEPT_EDITS,
  MODE_PLAN,
  MODE_IDS,
  type ModeId,
  DEFAULT_MODE_ID,
  buildAgyArgs,
} from "./agyArgs.js";
import {
  buildToolCallDiffs,
  readStepOutputText,
  readTranscriptToolCallArgs,
} from "./toolDiff.js";
export {
  buildToolCallDiffs,
  readStepOutputText,
  readTranscriptToolCallArgs,
} from "./toolDiff.js";

const { version: VERSION } = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf-8"),
) as { version: string };

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

const AGY_EXECUTABLE = resolveAgyExecutable();

function spawnAgy(args: string[], options: any = {}): ChildProcessWithoutNullStreams {
  const isWindows = process.platform === "win32";
  const isJsScript = /\.(mjs|js|cjs)$/i.test(AGY_EXECUTABLE);
  const isBatchScript = isWindows && /\.(cmd|bat)$/i.test(AGY_EXECUTABLE);

  const command = isWindows && isJsScript ? process.execPath : AGY_EXECUTABLE;
  const commandArgs = isWindows && isJsScript ? [AGY_EXECUTABLE, ...args] : args;

  return spawn(command, commandArgs, {
    ...options,
    shell: options?.shell ?? isBatchScript,
  }) as ChildProcessWithoutNullStreams;
}

// --- Models ----------------------------------------------------------------
// agy exposes models via `agy models`. Some embed reasoning effort in the id
// (gemini-*-high/medium/low), others accept a separate `--effort` flag, and a
// few (Claude) reject effort entirely. Verified against agy:
//   - gemini-*, gpt-oss-120b: `--model <base> --effort <e>` works; base REQUIRES --effort.
//   - claude-*: no effort; `--model <base>` only.
//   - a full effort-baked id CONFLICTS with `--effort`, so we always split.


interface ModelDef {
  base: string;
  name: string;
  contextWindow: number;
  supportsEffort: boolean;
  defaultEffort: Effort | null;
}

const FALLBACK_MODELS: ModelDef[] = [
  { base: "gemini-3.7-flash", name: "Gemini 3.7 Flash", contextWindow: 1_000_000, supportsEffort: true, defaultEffort: "high" },
  { base: "gemini-3.6-flash", name: "Gemini 3.6 Flash", contextWindow: 1_000_000, supportsEffort: true, defaultEffort: "high" },
  { base: "gemini-3.5-flash", name: "Gemini 3.5 Flash", contextWindow: 1_000_000, supportsEffort: true, defaultEffort: "high" },
  { base: "gemini-3.1-pro", name: "Gemini 3.1 Pro", contextWindow: 2_000_000, supportsEffort: true, defaultEffort: "high" },
  { base: "gpt-oss-120b", name: "GPT-OSS 120B", contextWindow: 128_000, supportsEffort: true, defaultEffort: "medium" },
  { base: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", contextWindow: 200_000, supportsEffort: false, defaultEffort: null },
  { base: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)", contextWindow: 200_000, supportsEffort: false, defaultEffort: null },
];

let dynamicModels: ModelDef[] = [...FALLBACK_MODELS];
let modelsFetchPromise: Promise<ModelDef[]> | null = null;

function fetchAgyModels(): Promise<ModelDef[] | null> {
  return new Promise((resolve) => {
    const child = spawnAgy(["models"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const timeout = setTimeout(() => { child.kill("SIGTERM"); resolve(null); }, 30_000);
    child.once("close", () => clearTimeout(timeout));
    child.once("error", () => clearTimeout(timeout));
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf-8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 0 && out.trim()) {
        const lines = out.trim().split("\n");
        const map = new Map<string, ModelDef>();
        for (const raw of lines) {
          const line = raw.trim();
          if (!line) continue;
          const [id, name] = line.split("\t").map((s) => s.trim());
          if (!id) continue;
          const m = id.match(/^(.+)-(high|medium|low)$/);
          if (m) {
            const base = m[1];
            const effort = m[2] as Effort;
            const cleanName = (name || base).replace(/\s*\((High|Medium|Low)\)\s*$/i, "").trim();
            const existing = map.get(base);
            if (existing) {
              if (effort === "high") existing.defaultEffort = "high";
            } else {
              map.set(base, {
                base,
                name: cleanName,
                contextWindow: base.includes("pro") ? 2_000_000 : (base.includes("gpt") ? 128_000 : 1_000_000),
                supportsEffort: true,
                defaultEffort: effort === "high" ? "high" : effort,
              });
            }
          } else {
            const cleanName = (name || id).replace(/\s*\(Thinking\)\s*$/i, "").trim();
            if (!map.has(id)) {
              map.set(id, {
                base: id,
                name: cleanName,
                contextWindow: 200_000,
                supportsEffort: false,
                defaultEffort: null,
              });
            }
          }
        }
        if (map.size > 0) {
          resolve(Array.from(map.values()));
          return;
        }
      }
      resolve(null);
    });
  });
}

async function getAvailableModels(): Promise<ModelDef[]> {
  if (!modelsFetchPromise) {
    modelsFetchPromise = cachedModels<ModelDef>({
      file: path.join(os.homedir(), ".agy-acp-models.json"), executable: AGY_EXECUTABLE,
      fallback: dynamicModels, fetch: fetchAgyModels,
      valid: (value): value is ModelDef[] => Array.isArray(value) && value.length > 0 && value.every(m =>
        m && typeof m.base === "string" && typeof m.name === "string" && Number.isFinite(m.contextWindow) &&
        m.contextWindow > 0 && typeof m.supportsEffort === "boolean" &&
        (m.defaultEffort === null || EFFORTS.includes(m.defaultEffort))),
    })
      .then((models) => {
        if (models && models.length > 0) {
          dynamicModels = models;
        }
        return dynamicModels;
      })
      .catch(() => dynamicModels);
  }
  return modelsFetchPromise;
}

// Start discovery immediately in background
void getAvailableModels();

const DEFAULT_MODEL_BASE = "gemini-3.7-flash";

function findModel(base: string): ModelDef | undefined {
  return dynamicModels.find((m) => m.base === base);
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
  "Gemini 3.7 Flash (High)": { base: "gemini-3.7-flash", effort: "high" },
  "Gemini 3.7 Flash (Medium)": { base: "gemini-3.7-flash", effort: "medium" },
  "Gemini 3.7 Flash (Low)": { base: "gemini-3.7-flash", effort: "low" },
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
  mcpServers?: McpServer[];
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
      mcpServers: raw.mcpServers ?? [],
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
    mcpServers: raw.mcpServers ?? [],
  };
}

// --- MCP Server synchronization --------------------------------------------

const sessions = new SessionStore<SessionState>(os.homedir(), migrateSession);
const mcpConfigs = new SessionMcpConfigs();

function sanitizeCwd(cwd: string | undefined): string {
  if (!cwd || cwd === "/" || cwd === ".") return os.homedir();
  return cwd;
}

function syncSessionMcpConfig(session: SessionState): Promise<string> {
  return mcpConfigs.prepare(session.sessionId, session.mcpServers ?? []);
}

// Active child processes keyed by sessionId, for cancellation/close.
const activeProcesses: Record<string, ReturnType<typeof spawn>> = {};

const nativeSessions = new Map<string, NativeSession>();
let persistentSupport: Promise<boolean> | undefined;
function supportsPersistentInput(): Promise<boolean> {
  if (process.env.AGY_ACP_PERSISTENT === "0") return Promise.resolve(false);
  return persistentSupport ??= new Promise(resolve => {
    const child = spawnAgy(["--help"], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const timeout = setTimeout(() => { child.kill(); resolve(false); }, 3000);
    const collect = (chunk: Buffer) => { output = (output + chunk).slice(-64_000); };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", () => { clearTimeout(timeout); resolve(false); });
    child.on("close", code => { clearTimeout(timeout); resolve(code === 0 && output.includes("--input-format") && output.includes("stream-json")); });
  });
}
function closeNativeSession(sessionId: string, cancel = false): void {
  nativeSessions.get(sessionId)?.dispose(cancel);
  nativeSessions.delete(sessionId);
}
function closeAllNativeSessions(): void {
  for (const sessionId of nativeSessions.keys()) closeNativeSession(sessionId, true);
  for (const child of Object.values(activeProcesses)) child.kill("SIGTERM");
  mcpConfigs.dispose();
}
process.stdin.once("end", closeAllNativeSessions);
process.once("exit", closeAllNativeSessions);
for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
  closeAllNativeSessions();
  process.exit(0);
});


// --- Config options --------------------------------------------------------

function effectiveEffort(session: { modelBase: string; effort: Effort | null }): Effort | null {
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
      options: dynamicModels.map((m) => ({ value: m.base, name: m.name })),
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
  if (t === "call_mcp_tool" || t.startsWith("mcp__") || t.startsWith("mcp_")) {
    return "other";
  }
  return "other";
}

function extractLocation(parameters: unknown): ToolCallLocation | null {
  const p = (parameters ?? {}) as Record<string, unknown>;
  const filePath =
    p.TargetFile ?? p.targetFile ?? p.Path ?? p.path ?? p.FilePath ?? p.filePath ?? p.SearchPath;
  return typeof filePath === "string" ? { path: filePath } : null;
}


const activeToolCallsBySession = new Map<string, Map<string, { toolName?: string; parameters?: unknown }>>();

function getSessionToolCalls(sessionId: string): Map<string, { toolName?: string; parameters?: unknown }> {
  let map = activeToolCallsBySession.get(sessionId);
  if (!map) {
    map = new Map();
    activeToolCallsBySession.set(sessionId, map);
  }
  return map;
}

// --- agy event handling ----------------------------------------------------

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

interface TurnContext {
  hasOutputText?: boolean;
  usage: AgyTurnUsage;
}

function handleAgyEvent(
  eventData: any,
  client: AgentContext,
  session: SessionState,
  onTurnError?: (err: string) => void,
  turnContext?: TurnContext,
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
    // result.usage is cumulative across the native conversation, so it cannot
    // represent this turn's tokens or the latest model context occupancy.
    if (result.status && result.status !== "SUCCESS") {
      const errorMessage = result.error || `Execution finished with status ${result.status}`;
      const hasDeliveredResponse = Boolean(
        turnContext?.hasOutputText ||
        (typeof result.response === "string" && result.response.trim().length > 0)
      );

      // When a valid assistant response has already been delivered to the client
      // in this turn, any trailing errors in `result` (such as historical stream
      // interruptions, post-turn 429 quota exhaustion, 503 capacity limits, or
      // connection teardown glitches) are benign trailing errors. We log them for
      // debugging but do not fail the turn or inject an error block that invalidates
      // the completed assistant reply.
      if (hasDeliveredResponse) {
        logDebug(
          "Ignoring trailing agy result error since valid response was produced in this turn:",
          errorMessage,
        );
      } else {
        onTurnError?.(errorMessage);
        // Surface agy errors (e.g. invalid model/effort, early quota exhaustion) to the user.
        emit(client, session.sessionId, {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: `Error: ${errorMessage}\n` },
        });
      }
    }
    return;
  }

  if (event !== "step_update") return;

  const step = eventData.step_update;
  if (!step) return;
  turnContext?.usage.observeStep(step);
  const { step_type, state, text_delta, tool_name, tool_info } = step;

  if (step_type === "agent_response") {
    if (text_delta) {
      if (turnContext) {
        turnContext.hasOutputText = true;
      }
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
    const sessionTools = getSessionToolCalls(session.sessionId);

    if (state === "ACTIVE") {
      sessionTools.set(toolCallId, { toolName: tool_name, parameters });
      const location = extractLocation(parameters);
      let title = tool_name ? tool_name : "Running tool";
      if (tool_name === "call_mcp_tool") {
        const mcpServer = parameters?.server_name || parameters?.server || parameters?.name;
        const mcpTool = parameters?.tool_name || parameters?.tool;
        if (mcpTool) {
          title = mcpServer ? `MCP [${mcpServer}]: ${mcpTool}` : `MCP: ${mcpTool}`;
        }
      }
      emit(client, session.sessionId, {
        sessionUpdate: "tool_call",
        toolCallId,
        title,
        name: tool_name ?? undefined,
        kind: mapToolKind(tool_name),
        status: "in_progress",
        rawInput: parameters,
        locations: location ? [location] : undefined,
      });
    } else if (state === "DONE" || state === "ERROR") {
      const saved = sessionTools.get(toolCallId);
      sessionTools.delete(toolCallId);
      const effectiveToolName = tool_name || saved?.toolName || "";
      let effectiveParams = (parameters ?? saved?.parameters) as Record<string, unknown> | undefined;

      const failed = state === "ERROR";
      let outputText = failed
        ? info?.error?.message ?? "Tool execution failed"
        : (info?.output ?? "");

      const convId = step.conversation_id || session.conversationId;
      if (!failed && convId) {
        if (!outputText) {
          const diskOutput = readStepOutputText(convId, step.step_index);
          if (diskOutput) {
            outputText = diskOutput;
          }
        }
        const hasSnippet =
          effectiveParams?.TargetContent ||
          effectiveParams?.CodeContent ||
          effectiveParams?.Replacements;
        if (!hasSnippet) {
          const transcriptArgs = readTranscriptToolCallArgs(convId, effectiveToolName, step.step_index);
          if (transcriptArgs) {
            effectiveParams = { ...transcriptArgs, ...effectiveParams };
          }
        }
      }

      const contentItems: any[] = [];
      if (!failed) {
        const diffs = buildToolCallDiffs(effectiveToolName, effectiveParams, outputText);
        contentItems.push(...diffs);
      }
      if (outputText) {
        contentItems.push({ type: "content", content: { type: "text", text: outputText } });
      }

      const location = extractLocation(effectiveParams);

      emit(client, session.sessionId, {
        sessionUpdate: "tool_call_update",
        toolCallId,
        title: effectiveToolName ? effectiveToolName : undefined,
        kind: mapToolKind(effectiveToolName),
        status: failed ? "failed" : "completed",
        rawOutput: failed ? info.error : outputText,
        locations: location ? [location] : undefined,
        content: contentItems.length ? contentItems : undefined,
      });
    }
  }
}



// --- ACP agent -------------------------------------------------------------

const app = agent({ name: "agy-acp" })
  .onRequest("initialize", async () => {
    return {
      protocolVersion: PROTOCOL_VERSION,
      _meta: { freebuddy: { persistentSession: await supportsPersistentInput() } },
      agentInfo: {
        name: "agy-acp",
        title: "Google Antigravity",
        version: VERSION,
      },
      agentCapabilities: {
        loadSession: true,
        // embeddedContext is honored by serializing resource blocks into the
        // text prompt (agy --print is text-only).
        promptCapabilities: {
          embeddedContext: true,
        },
        mcpCapabilities: {
          http: true,
          sse: true,
        },
        sessionCapabilities: {
          resume: {},
          list: {},
          close: {},
          delete: {},
          additionalDirectories: {},
        },
      },
      authMethods: [
        {
          id: "google-account",
          name: "Google account",
          description:
            "agy signs in with your Google account. Run `agy-acp --login` (or launch `agy` interactively) to complete sign-in.",
        },
        {
          type: "terminal",
          id: "agy-login",
          name: "Terminal sign-in",
          description: "Launch the agy interactive CLI to complete Google sign-in",
          args: ["--login"],
        },
      ],
    };
  })
  .onRequest("session/new", async (ctx) => {
    const { cwd, additionalDirectories, mcpServers } = ctx.params;
    const sessionId = crypto.randomUUID();

    await getAvailableModels();

    const session: SessionState = {
      sessionId,
      cwd: sanitizeCwd(cwd),
      modelBase: dynamicModels[0]?.base ?? DEFAULT_MODEL_BASE,
      effort: null,
      modeId: DEFAULT_MODE_ID,
      additionalDirectories: additionalDirectories ?? [],
      mcpServers: mcpServers ?? [],
    };
    await sessions.set(session);
    await syncSessionMcpConfig(session);

    return {
      sessionId,
      modes: modeState(session.modeId),
      configOptions: buildConfigOptions(session),
    };
  })
  .onRequest("session/list", async () => {
    return {
      sessions: (await sessions.list()).map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd,
      })),
    };
  })
  .onRequest("session/delete", async (ctx) => {
    const { sessionId } = ctx.params;
    activeToolCallsBySession.delete(sessionId);
    closeNativeSession(sessionId, true);
    mcpConfigs.release(sessionId);
    await sessions.delete(sessionId);
  })
  .onRequest("session/load", async (ctx) => {
    const { sessionId, cwd, additionalDirectories, mcpServers } = ctx.params;
    await getAvailableModels();
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (cwd) {
      session.cwd = sanitizeCwd(cwd);
    }
    if (additionalDirectories) {
      session.additionalDirectories = additionalDirectories;
    }
    if (mcpServers !== undefined) {
      session.mcpServers = mcpServers;
    }
    await sessions.set(session);
    await syncSessionMcpConfig(session);

    return {
      sessionId,
      modes: modeState(session.modeId),
      configOptions: buildConfigOptions(session),
    };
  })
  .onRequest("session/resume", async (ctx) => {
    const { sessionId, cwd, additionalDirectories, mcpServers } = ctx.params;
    await getAvailableModels();
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    if (cwd) {
      session.cwd = sanitizeCwd(cwd);
    }
    if (additionalDirectories) {
      session.additionalDirectories = additionalDirectories;
    }
    if (mcpServers !== undefined) {
      session.mcpServers = mcpServers;
    }
    await sessions.set(session);
    await syncSessionMcpConfig(session);

    return {
      sessionId,
      modes: modeState(session.modeId),
      configOptions: buildConfigOptions(session),
    };
  })
  .onRequest("session/set_mode", async (ctx) => {
    const { sessionId, modeId } = ctx.params;
    const session = await sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);
    if (!MODE_IDS.includes(modeId as ModeId)) {
      throw new Error(`Unknown mode ${modeId}`);
    }
    session.modeId = modeId as ModeId;
    await sessions.set(session);

    emit(ctx.client, sessionId, {
      sessionUpdate: "current_mode_update",
      currentModeId: session.modeId,
    });
  })
  .onRequest("session/set_config_option", async (ctx) => {
    const { sessionId, configId } = ctx.params;
    await getAvailableModels();
    const session = await sessions.get(sessionId);
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
    await sessions.set(session);

    return { configOptions: buildConfigOptions(session) };
  })
  .onRequest("session/close", async (ctx) => {
    const { sessionId } = ctx.params;
    activeToolCallsBySession.delete(sessionId);
    closeNativeSession(sessionId, true);
    mcpConfigs.release(sessionId);
    const child = activeProcesses[sessionId];
    if (child) {
      child.kill("SIGINT");
      delete activeProcesses[sessionId];
    }
  })
  .onRequest("session/prompt", async (ctx) => {
    const { sessionId, prompt } = ctx.params;
    const session = await sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    const geminiDir = await syncSessionMcpConfig(session);

    const userPrompt = serializePrompt(prompt);
    // CLI-handled slash commands are unavailable in stream-input mode.
    // Close the warm process so a one-shot command cannot diverge its context.
    const cliCommand = userPrompt.trimStart().startsWith("/");
    if (cliCommand) closeNativeSession(sessionId);
    if (!cliCommand && await supportsPersistentInput()) {
      const signature = JSON.stringify({ cwd: session.cwd, mcpServers: session.mcpServers,
        args: buildAgyArgs({ ...session, conversationId: undefined }, "", { effectiveEffort, geminiDir }) });
      let native = nativeSessions.get(sessionId);
      if (native?.busy) throw new RequestError(-32603, "This AGY session already has an active turn.");
      if (!native?.alive || native.signature !== signature) {
        closeNativeSession(sessionId);
        native = new NativeSession(spawnAgy([
          ...buildAgyArgs(session, "", { effectiveEffort, geminiDir }), "--input-format", "stream-json",
        ], { cwd: session.cwd, env: { ...process.env } }), signature);
        nativeSessions.set(sessionId, native);
      }
      const turnContext: TurnContext = { hasOutputText: false, usage: new AgyTurnUsage() };
      let turnError: string | undefined;
      try {
        await native.run(userPrompt, event => handleAgyEvent(event, ctx.client, session,
          error => { turnError = error; }, turnContext));
        if (turnError) { closeNativeSession(sessionId); throw new RequestError(-32603, turnError); }
        const usage = turnContext.usage.snapshot();
        const modelCallDurationMs = turnContext.usage.modelCallDurationMs();
        return { stopReason: "end_turn", ...(usage ? { usage } : {}),
          ...(modelCallDurationMs === undefined ? {} : { _meta: { metrics: { usageScope: "turn", modelCallDurationMs } } }) };
      } catch (error) {
        if (error instanceof NativeTurnCancelled) return { stopReason: "cancelled" };
        closeNativeSession(sessionId);
        throw error instanceof RequestError ? error : new RequestError(-32603, (error as Error).message);
      } finally {
        const latest = await sessions.get(sessionId);
        if (latest && session.conversationId) {
          latest.conversationId = session.conversationId;
          await sessions.set(latest);
        }
      }
    }
    const agyArgs = buildAgyArgs(session, userPrompt, {
      effectiveEffort, geminiDir,
    });

    return new Promise((resolve, reject) => {
      const child = spawnAgy(agyArgs, {
        cwd: session.cwd,
        env: { ...process.env },
      });
      activeProcesses[sessionId] = child;

      let turnError: string | null = null;
      const turnContext: TurnContext = { hasOutputText: false, usage: new AgyTurnUsage() };
      let stderrOutput = "";
      // Accumulate raw bytes and split on newline boundaries. Splitting on the
      // data chunk boundary (chunk.toString("utf-8")) corrupts multi-byte
      // UTF-8 characters (e.g. Chinese): a chunk can end mid-character, and
      // toString replaces the dangling bytes with U+FFFD irreversibly. "\n"
      // (0x0a) is a single-byte ASCII value that can never fall inside a
      // multi-byte sequence, so it is always safe to split on.
      let buffer = Buffer.alloc(0);

      const consumeLine = (line: string) => {
        if (!line.trim()) return;
        try {
          handleAgyEvent(
            JSON.parse(line), ctx.client, session,
            (err) => { turnError = err; }, turnContext,
          );
        } catch {
          logDebug("raw output:", line);
        }
      };

      child.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf(0x0a)) >= 0) {
          const line = buffer.subarray(0, newlineIdx).toString("utf-8");
          buffer = buffer.subarray(newlineIdx + 1);
          consumeLine(line);
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        stderrOutput += chunk.toString("utf-8");
        if (stderrOutput.length > 4000) {
          stderrOutput = stderrOutput.slice(-4000);
        }
      });

      child.on("error", (err) => {
        delete activeProcesses[sessionId];
        const errno = err as NodeJS.ErrnoException;
        reject(
          errno.code === "ENOENT"
            ? new RequestError(-32603, "Failed to start `agy`. Is the Antigravity CLI installed and on PATH?")
            : new RequestError(-32603, err.message)
        );
      });

      child.on("close", async (code) => {
        if (buffer.length) consumeLine(buffer.toString("utf-8"));
        delete activeProcesses[sessionId];
        const latest = await sessions.get(sessionId);
        if (latest && session.conversationId) {
          latest.conversationId = session.conversationId;
          await sessions.set(latest);
        }

        const wasKilled = child.killed || code === null;
        if (wasKilled) {
          resolve({ stopReason: "cancelled" });
        } else if (turnError) {
          reject(new RequestError(-32603, turnError));
        } else if (code !== 0) {
          const detail = stderrOutput.trim() ? `: ${stderrOutput.trim()}` : "";
          reject(new RequestError(-32603, `Antigravity process exited with code ${code}${detail}`));
        } else {
          const usage = turnContext.usage.snapshot();
          const modelCallDurationMs = turnContext.usage.modelCallDurationMs();
          resolve({
            stopReason: "end_turn",
            ...(usage ? { usage } : {}),
            ...(modelCallDurationMs !== undefined ? {
              _meta: { metrics: { usageScope: "turn", modelCallDurationMs } },
            } : {}),
          });
        }
      });
    });
  })
  .onNotification("session/cancel", async (ctx) => {
    const { sessionId } = ctx.params;
    closeNativeSession(sessionId, true);
    mcpConfigs.release(sessionId);
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

if (process.argv.includes("--login")) {
  // Terminal-auth entry point: hand the terminal to the agy TUI so the user can
  // complete Google sign-in, then exit instead of starting the ACP loop.
  const child = spawn(AGY_EXECUTABLE, [], { stdio: "inherit" });
  child.on("error", (err) => {
    logError(`Failed to launch agy: ${err.message}`);
    process.exit(1);
  });
  child.on("exit", (code) => process.exit(code ?? 0));
} else {
  const stream = ndJsonStream(
    Writable.toWeb(process.stdout) as any,
    Readable.toWeb(process.stdin) as any,
  );

  app.connect(stream);
}
