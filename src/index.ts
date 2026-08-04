#!/usr/bin/env node
import { agent, ndJsonStream } from "@agentclientprotocol/sdk";
import type { AgentContext } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import crypto from "node:crypto";

if (process.argv.includes("--version") || process.argv.includes("-v") || process.argv.includes("version")) {
  process.stdout.write("0.1.1\n");
  process.exit(0);
}

// Redirect all standard console.log output to console.error (stderr)
// to prevent polluting the JSON-RPC stdio channel on stdout.
console.log = console.error;

const STATE_FILE = path.join(os.homedir(), ".agy-acp-state.json");

interface SessionState {
  sessionId: string;
  cwd: string;
  conversationId?: string; // Resumes the exact agy CLI history
  modelId?: string;
}

const DEFAULT_MODELS = [
  { modelId: "Gemini 3.6 Flash (High)", name: "Gemini 3.6 Flash (High)" },
  { modelId: "Gemini 3.6 Flash (Medium)", name: "Gemini 3.6 Flash (Medium)" },
  { modelId: "Gemini 3.6 Flash (Low)", name: "Gemini 3.6 Flash (Low)" },
  { modelId: "Gemini 3.5 Flash (High)", name: "Gemini 3.5 Flash (High)" },
  { modelId: "Gemini 3.5 Flash (Medium)", name: "Gemini 3.5 Flash (Medium)" },
  { modelId: "Gemini 3.5 Flash (Low)", name: "Gemini 3.5 Flash (Low)" },
  { modelId: "Gemini 3.1 Pro (High)", name: "Gemini 3.1 Pro (High)" },
  { modelId: "Gemini 3.1 Pro (Low)", name: "Gemini 3.1 Pro (Low)" },
  { modelId: "Claude Sonnet 4.6 (Thinking)", name: "Claude Sonnet 4.6 (Thinking)" },
  { modelId: "Claude Opus 4.6 (Thinking)", name: "Claude Opus 4.6 (Thinking)" },
  { modelId: "GPT-OSS 120B (Medium)", name: "GPT-OSS 120B (Medium)" }
];

interface StateData {
  sessions: { [sessionId: string]: SessionState };
}

async function readState(): Promise<StateData> {
  try {
    const data = await fs.readFile(STATE_FILE, "utf-8");
    return JSON.parse(data);
  } catch {
    return { sessions: {} };
  }
}

async function writeState(state: StateData) {
  try {
    await fs.mkdir(path.dirname(STATE_FILE), { recursive: true });
    await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
  } catch (err) {
    console.error("[agy-acp] Failed to write state file:", err);
  }
}

// Track active child processes by sessionId to support cancellations
const activeProcesses: { [sessionId: string]: ReturnType<typeof spawn> } = {};

function mapToolKind(toolName: string): any {
  if (!toolName) return "other";
  if (toolName.includes("read") || toolName.includes("view") || toolName.includes("list")) return "read";
  if (toolName.includes("write") || toolName.includes("replace") || toolName.includes("edit") || toolName.includes("sed")) return "edit";
  if (toolName.includes("delete")) return "delete";
  if (toolName.includes("search") || toolName.includes("find") || toolName.includes("grep")) return "search";
  if (toolName.includes("run_command") || toolName.includes("execute")) return "execute";
  if (toolName.includes("subagent")) return "think";
  return "other";
}

function handleAgyEvent(
  eventData: any,
  client: AgentContext,
  session: SessionState,
  onTextDelta: (text: string) => void
) {
  const { event } = eventData;
  if (!event) return;

  if (event === "init") {
    const conversationId = eventData.conversation_id;
    if (conversationId && !session.conversationId) {
      session.conversationId = conversationId;
      console.error(`[agy-acp] Learned conversation ID: ${conversationId}`);
    }
  } else if (event === "step_update") {
    const step = eventData.step_update;
    if (!step) return;

    const { step_type, state, text_delta, tool_name, tool_info } = step;

    if (step_type === "agent_response" && text_delta) {
      onTextDelta(text_delta);
      
      // Emit text chunk to client
      client.notify("session/update", {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: text_delta
          },
          messageId: `msg-${step.step_index}`
        }
      } as any);
    } else if (step_type === "tool") {
      const toolCallId = `tool-${step.step_index}`;
      
      if (state === "ACTIVE") {
        client.notify("session/update", {
          update: {
            sessionUpdate: "tool_call",
            toolCallId,
            title: `Executing ${tool_name}...`,
            name: tool_name,
            kind: mapToolKind(tool_name)
          }
        } as any);
      } else if (state === "DONE" || state === "ERROR") {
        const isError = state === "ERROR";
        const outputText = isError 
          ? (tool_info?.error?.message || "Tool execution failed") 
          : (tool_info?.output || "");
          
        client.notify("session/update", {
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId,
            outcome: isError ? "failure" : "success",
            output: [
              {
                type: "text",
                text: outputText
              }
            ]
          }
        } as any);
      }
    }
  }
}

const app = agent({ name: "agy-acp" })
  .onRequest("initialize", (ctx) => {
    return {
      protocolVersion: ctx.params.protocolVersion,
      capabilities: {
        sessionCapabilities: {
          resume: {}
        }
      },
      agentCapabilities: {
        sessionCapabilities: {
          resume: {}
        }
      },
      agentInfo: {
        name: "Google Antigravity JSON-Stream Bridge",
        version: "0.1.0"
      }
    };
  })
  .onRequest("session/new", async (ctx) => {
    const { cwd } = ctx.params;
    const sessionId = crypto.randomUUID();
    
    const state = await readState();
    state.sessions[sessionId] = {
      sessionId,
      cwd,
      modelId: "Gemini 3.6 Flash (High)"
    };
    await writeState(state);

    return {
      sessionId,
      modes: {
        availableModes: [
          { id: "accept-edits", name: "Accept Edits" },
          { id: "plan", name: "Plan Mode" }
        ],
        currentModeId: "accept-edits"
      },
      models: {
        availableModels: DEFAULT_MODELS,
        currentModelId: "Gemini 3.6 Flash (High)"
      }
    };
  })
  .onRequest("session/list", async () => {
    const state = await readState();
    return {
      sessions: Object.values(state.sessions).map((s) => ({
        sessionId: s.sessionId,
        cwd: s.cwd
      }))
    };
  })
  .onRequest("session/delete", async (ctx) => {
    const { sessionId } = ctx.params;
    const state = await readState();
    delete state.sessions[sessionId];
    await writeState(state);
  })
  .onRequest("session/resume", async (ctx) => {
    const { sessionId } = ctx.params;
    const state = await readState();
    const session = state.sessions[sessionId];
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    return {
      sessionId,
      modes: {
        availableModes: [
          { id: "accept-edits", name: "Accept Edits" },
          { id: "plan", name: "Plan Mode" }
        ],
        currentModeId: "accept-edits"
      },
      models: {
        availableModels: DEFAULT_MODELS,
        currentModelId: session.modelId || "Gemini 3.6 Flash (High)"
      }
    };
  })
  .onRequest("session/set_config_option", async (ctx) => {
    const { sessionId, configId, value } = ctx.params as any;
    const state = await readState();
    const session = state.sessions[sessionId];
    if (session) {
      if (configId === "model") {
        session.modelId = value;
      }
      await writeState(state);
    }
    return {
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: session?.modelId || "Gemini 3.6 Flash (High)",
          options: DEFAULT_MODELS.map((m) => ({ value: m.modelId, name: m.name }))
        }
      ]
    };
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

    const userPrompt = prompt
      .filter((block: any) => block.type === "text")
      .map((block: any) => block.text)
      .join("\n");

    // Headless print execution with structured JSON streaming
    const agyArgs: string[] = ["--print", userPrompt, "--output-format", "stream-json"];

    if (session.conversationId) {
      agyArgs.push("--conversation", session.conversationId);
    }
    if (session.modelId) {
      agyArgs.push("--model", session.modelId);
    }
    
    // Check and pass configuration arguments to the sub-process
    const processArgs = process.argv;
    if (processArgs.includes("--dangerously-skip-permissions")) {
      agyArgs.push("--dangerously-skip-permissions");
    }
    if (processArgs.includes("--sandbox")) {
      agyArgs.push("--sandbox");
    }

    // console.error(`[agy-acp] Spawning: agy ${agyArgs.map(x => x.includes(' ') ? `"${x}"` : x).join(' ')}`);

    return new Promise((resolve, reject) => {
      const child = spawn("agy", agyArgs, {
        cwd: session.cwd,
        env: { ...process.env }
      });

      activeProcesses[sessionId] = child;

      let responseText = "";
      let buffer = "";

      child.stdout.on("data", (chunk: Buffer) => {
        buffer += chunk.toString("utf-8");
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            handleAgyEvent(data, ctx.client, session, (text) => {
              responseText += text;
            });
          } catch (e) {
            console.error("[agy-acp raw output]:", line);
          }
        }
      });

      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
      });

      child.on("error", (err) => {
        delete activeProcesses[sessionId];
        reject(err);
      });

      child.on("close", async (code) => {
        delete activeProcesses[sessionId];
        
        // Save the updated state including any conversationId we learned
        await writeState(state);

        if (code !== 0 && code !== null) {
          reject(new Error(`agy process exited with code ${code}`));
        } else {
          const wasKilled = code === null;
          resolve({
            stopReason: wasKilled ? "cancelled" : "end_turn"
          });
        }
      });
    });
  })
  .onNotification("session/cancel", async (ctx) => {
    const { sessionId } = ctx.params;
    const child = activeProcesses[sessionId];
    if (child) {
      console.error(`[agy-acp] Cancelling active process for session ${sessionId}`);
      child.kill("SIGINT");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {}
      }, 2000);
    }
  });

// Set up bidirectional stdio streaming
const stream = ndJsonStream(
  Writable.toWeb(process.stdout) as any,
  Readable.toWeb(process.stdin) as any
);

app.connect(stream);
// Connected over stdio.
