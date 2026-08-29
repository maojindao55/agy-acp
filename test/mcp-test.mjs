// Test MCP Server injection via ACP protocol
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-mcp-test-"));
const testDir = path.join(testRoot, "workspace-initial");
const resumedDir = path.join(testRoot, "workspace-resumed");
const testHome = path.join(testRoot, "home");
await Promise.all([
  fs.mkdir(testDir, { recursive: true }),
  fs.mkdir(resumedDir, { recursive: true }),
  fs.mkdir(testHome, { recursive: true }),
]);

try {
  console.log("Using test workspace:", testDir);

  const child = spawn(
    "node",
    ["dist/index.js"],
    {
      cwd: process.cwd(),
      env: { ...process.env, HOME: testHome, DEBUG: "1" },
    },
  );

  child.stderr.on("data", (c) => process.stderr.write(`\x1b[2m[adapter] ${c}\x1b[0m`));

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );

  const cli = client({ name: "mcp-test-client", version: "1.0" });

  await cli.connectWith(stream, async (ctx) => {
    // 1. Check initialize capabilities
    const initRes = await ctx.request("initialize", {
      protocolVersion: 1,
      clientInfo: { name: "test-client", version: "1.0" },
      clientCapabilities: {},
    });

    console.log("agentCapabilities:", JSON.stringify(initRes.agentCapabilities, null, 2));
    if (!initRes.agentCapabilities?.mcpCapabilities?.sse) {
      throw new Error("Expected mcpCapabilities.sse to be true");
    }

    // 2. Start session with MCP servers injected
    const session = await ctx.buildSession(testDir)
      .withMcpServer({
        name: "test-stdio-server",
        command: "echo",
        args: ["hello"],
        env: [{ name: "ENV_A", value: "1" }],
      })
      .withMcpServer({
        type: "sse",
        name: "test-sse-server",
        url: "https://example.com/sse",
        headers: [{ name: "Authorization", value: "Bearer secret" }],
      })
      .start();

    console.log("Session started:", session.sessionId);

    // 3. Verify .agents/mcp_config.json was created and populated
    const mcpConfigFile = path.join(testDir, ".agents", "mcp_config.json");
    const mcpConfigContent = await fs.readFile(mcpConfigFile, "utf-8");
    const parsedMcpConfig = JSON.parse(mcpConfigContent);
    console.log("Generated mcp_config.json content:", JSON.stringify(parsedMcpConfig, null, 2));

    if (!parsedMcpConfig.mcpServers?.["test-stdio-server"]) {
      throw new Error("Missing test-stdio-server in mcp_config.json");
    }
    if (parsedMcpConfig.mcpServers["test-stdio-server"].command !== "echo") {
      throw new Error("Unexpected command in stdio config");
    }
    if (parsedMcpConfig.mcpServers["test-stdio-server"].env?.ENV_A !== "1") {
      throw new Error("Unexpected env in stdio config");
    }
    if (!parsedMcpConfig.mcpServers?.["test-sse-server"]) {
      throw new Error("Missing test-sse-server in mcp_config.json");
    }
    if (parsedMcpConfig.mcpServers["test-sse-server"].serverUrl !== "https://example.com/sse") {
      throw new Error("Unexpected serverUrl in sse config");
    }

    // 4. Resuming in a different workspace must update both the live session
    // listing and the state used by subsequent bridge processes.
    await ctx.request("session/resume", {
      sessionId: session.sessionId,
      cwd: resumedDir,
    });

    const listedSessions = await ctx.request("session/list", {});
    const resumedSession = listedSessions.sessions.find(
      (candidate) => candidate.sessionId === session.sessionId,
    );
    assert.equal(resumedSession?.cwd, resumedDir);

    const stateFile = path.join(testHome, ".agy-acp-state.json");
    const persistedState = JSON.parse(await fs.readFile(stateFile, "utf-8"));
    assert.equal(persistedState.sessions[session.sessionId]?.cwd, resumedDir);

    console.log(" All MCP injection and session resume assertions passed successfully!");
    session.dispose();
  });

  child.stdin.end();
  child.kill();
} finally {
  await fs.rm(testRoot, { recursive: true, force: true });
}
