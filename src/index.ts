#!/usr/bin/env node
import { agent, ndJsonStream, PROTOCOL_VERSION, RequestError } from "@agentclientprotocol/sdk";
import type {
  AgentContext,
  ContentBlock,
  McpServer,
  McpServerHttp,
  McpServerSse,
  McpServerStdio,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  StopReason,
  ToolCallLocation,
  ToolKind,
} from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import crypto from "node:crypto";
import { resolveAgyExecutable } from "./agyExecutable.js";
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

const STATE_FILE = path.join(os.homedir(), ".agy-acp-state.json");
const AGY_EXECUTABLE = resolveAgyExecutable();

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
    const child = spawn(AGY_EXECUTABLE, ["models"], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
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
    modelsFetchPromise = fetchAgyModels()
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

interface AgyMcpServerStdio {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface AgyMcpServerSse {
  serverUrl: string;
  headers?: Record<string, string>;
}

type AgyMcpServer = AgyMcpServerStdio | AgyMcpServerSse;

interface AgyMcpConfig {
  mcpServers: Record<string, AgyMcpServer>;
}

function convertToAgyMcpConfig(mcpServers: McpServer[]): Record<string, AgyMcpServer> {
  const result: Record<string, AgyMcpServer> = {};
  for (const s of mcpServers) {
    if (!s || typeof s !== "object") continue;
    const name = s.name;
    if (!name) continue;

    if ("type" in s && (s.type === "sse" || s.type === "http")) {
      const sseServer = s as McpServerSse | McpServerHttp;
      let headers: Record<string, string> | undefined = undefined;
      if (Array.isArray(sseServer.headers)) {
        headers = {};
        for (const h of sseServer.headers) {
          if (h && typeof h === "object" && h.name && h.value !== undefined) {
            headers[h.name] = String(h.value);
          }
        }
      } else if (sseServer.headers && typeof sseServer.headers === "object") {
        headers = sseServer.headers as Record<string, string>;
      }

      result[name] = {
        serverUrl: sseServer.url,
        ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
      };
    } else {
      // Stdio server (type === "stdio" or McpServerStdio)
      const stdioServer = s as McpServerStdio;
      let env: Record<string, string> | undefined = undefined;
      if (Array.isArray(stdioServer.env)) {
        env = {};
        for (const e of stdioServer.env) {
          if (e && typeof e === "object" && e.name && e.value !== undefined) {
            env[e.name] = String(e.value);
          }
        }
      } else if (stdioServer.env && typeof stdioServer.env === "object") {
        env = stdioServer.env as Record<string, string>;
      }

      result[name] = {
        command: stdioServer.command,
        args: Array.isArray(stdioServer.args) ? stdioServer.args : [],
        ...(env && Object.keys(env).length > 0 ? { env } : {}),
      };
    }
  }
  return result;
}

function sanitizeCwd(cwd: string | undefined): string {
  if (!cwd || cwd === "/" || cwd === ".") {
    return os.homedir();
  }
  return cwd;
}

async function syncSessionMcpConfig(session: SessionState): Promise<void> {
  if (!session.mcpServers || session.mcpServers.length === 0) return;
  const convertedServers = convertToAgyMcpConfig(session.mcpServers);
  if (Object.keys(convertedServers).length === 0) return;

  const targetDirs = [
    path.join(sanitizeCwd(session.cwd), ".agents"),
    path.join(os.homedir(), ".gemini", "config"),
  ];

  for (const dir of targetDirs) {
    try {
      const configFile = path.join(dir, "mcp_config.json");
      let existingConfig: AgyMcpConfig = { mcpServers: {} };
      try {
        const content = await fs.readFile(configFile, "utf-8");
        const parsed = JSON.parse(content);
        if (parsed && typeof parsed === "object" && parsed.mcpServers) {
          existingConfig = parsed;
        }
      } catch {
        // No existing config file or invalid JSON, start fresh
      }

      const mergedConfig: AgyMcpConfig = {
        ...existingConfig,
        mcpServers: {
          ...(existingConfig.mcpServers || {}),
          ...convertedServers,
        },
      };

      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(configFile, JSON.stringify(mergedConfig, null, 2), "utf-8");
      logDebug("Synchronized MCP servers into", configFile);
    } catch (err) {
      logError(`Failed to synchronize MCP config into ${dir}:`, err);
    }
  }
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
  onTurnError?: (err: string) => void,
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
    if (result.status && result.status !== "SUCCESS") {
      const errorMessage = result.error || `Execution finished with status ${result.status}`;
      onTurnError?.(errorMessage);
      // Surface agy errors (e.g. invalid model/effort, stream interruption) to the user.
      emit(client, session.sessionId, {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: `Error: ${errorMessage}\n` },
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
    };
  })
  .onRequest("session/new", async (ctx) => {
    const { cwd, additionalDirectories, mcpServers } = ctx.params;
    const sessionId = crypto.randomUUID();

    await getAvailableModels();

    const state = await readState();
    const session: SessionState = {
      sessionId,
      cwd: sanitizeCwd(cwd),
      modelBase: dynamicModels[0]?.base ?? DEFAULT_MODEL_BASE,
      effort: null,
      modeId: DEFAULT_MODE_ID,
      additionalDirectories: additionalDirectories ?? [],
      mcpServers: mcpServers ?? [],
    };
    state.sessions[sessionId] = session;
    await writeState(state);
    await syncSessionMcpConfig(session);

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
  .onRequest("session/load", async (ctx) => {
    const { sessionId, cwd, additionalDirectories, mcpServers } = ctx.params;
    await getAvailableModels();
    const state = await readState();
    const session = state.sessions[sessionId];
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
    await writeState(state);
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
    const state = await readState();
    const session = state.sessions[sessionId];
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
    await writeState(state);
    await syncSessionMcpConfig(session);

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
    await getAvailableModels();
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

    await syncSessionMcpConfig(session);

    const userPrompt = serializePrompt(prompt);
    const agyArgs = buildAgyArgs(session, userPrompt, {
      effectiveEffort,
    });

    return new Promise((resolve, reject) => {
      const child = spawn(AGY_EXECUTABLE, agyArgs, {
        cwd: session.cwd,
        env: { ...process.env },
      });
      activeProcesses[sessionId] = child;

      const turn: PromptTurnResult = { stopReason: "end_turn" };
      let turnError: string | null = null;
      let stderrOutput = "";
      // Accumulate raw bytes and split on newline boundaries. Splitting on the
      // data chunk boundary (chunk.toString("utf-8")) corrupts multi-byte
      // UTF-8 characters (e.g. Chinese): a chunk can end mid-character, and
      // toString replaces the dangling bytes with U+FFFD irreversibly. "\n"
      // (0x0a) is a single-byte ASCII value that can never fall inside a
      // multi-byte sequence, so it is always safe to split on.
      let buffer = Buffer.alloc(0);

      child.stdout.on("data", (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        let newlineIdx: number;
        while ((newlineIdx = buffer.indexOf(0x0a)) >= 0) {
          const line = buffer.subarray(0, newlineIdx).toString("utf-8");
          buffer = buffer.subarray(newlineIdx + 1);
          if (!line.trim()) continue;
          try {
            handleAgyEvent(JSON.parse(line), ctx.client, session, (err) => {
              turnError = err;
            });
          } catch {
            logDebug("raw output:", line);
          }
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
        delete activeProcesses[sessionId];
        await writeState(state);

        const wasKilled = child.killed || code === null;
        if (wasKilled) {
          resolve({ stopReason: "cancelled" });
        } else if (turnError) {
          reject(new RequestError(-32603, turnError));
        } else if (code !== 0) {
          const detail = stderrOutput.trim() ? `: ${stderrOutput.trim()}` : "";
          reject(new RequestError(-32603, `Antigravity process exited with code ${code}${detail}`));
        } else {
          resolve({ stopReason: turn.stopReason });
        }
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
