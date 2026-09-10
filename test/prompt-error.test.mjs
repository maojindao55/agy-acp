import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

test("session/prompt rejects when agy outputs a failed result even with exit code 0", async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-err-test-"));
  const mockAgy = path.join(testRoot, "mock-agy.mjs");
  const testHome = path.join(testRoot, "home");
  await fs.mkdir(testHome, { recursive: true });

  const mockContent = `#!/usr/bin/env node
console.log(JSON.stringify({ event: "init", conversation_id: "mock-conv-err" }));
console.log(JSON.stringify({
  event: "result",
  result: { status: "ERROR", error: "The stream was interrupted. Please continue the task you were working on." }
}));
process.exit(0);
`;
  await fs.writeFile(mockAgy, mockContent, { mode: 0o755 });

  const child = spawn(
    "node",
    ["dist/index.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        AGY_ACP_COMMAND: mockAgy,
      },
    },
  );

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );

  const updates = [];
  const cli = client({ name: "error-test-client", version: "1.0" });

  try {
    await cli.connectWith(stream, async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0" },
        clientCapabilities: {},
      });

      const session = await ctx.buildSession(testRoot).start();

      await assert.rejects(
        async () => {
          await ctx.request("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "trigger timeout" }],
          });
        },
        (err) => {
          assert.match(
            err.message,
            /The stream was interrupted\. Please continue the task you were working on\./,
          );
          return true;
        },
      );

      session.dispose();
    });
  } finally {
    child.stdin.end();
    child.kill();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test("session/prompt ignores stale stream interruption error when agent response was delivered", async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-stale-err-test-"));
  const mockAgy = path.join(testRoot, "mock-stale-agy.mjs");
  const testHome = path.join(testRoot, "home");
  await fs.mkdir(testHome, { recursive: true });

  const mockContent = `#!/usr/bin/env node
console.log(JSON.stringify({ event: "init", conversation_id: "mock-conv-stale-err" }));
console.log(JSON.stringify({
  event: "step_update",
  step_update: { step_index: 0, state: "DONE", step_type: "agent_response", text_delta: "Task completed successfully!" }
}));
console.log(JSON.stringify({
  event: "result",
  result: { status: "ERROR", error: "The stream was interrupted. Please continue the task you were working on." }
}));
process.exit(0);
`;
  await fs.writeFile(mockAgy, mockContent, { mode: 0o755 });

  const child = spawn(
    "node",
    ["dist/index.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        AGY_ACP_COMMAND: mockAgy,
      },
    },
  );

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );

  const receivedUpdates = [];
  const cli = client({ name: "stale-error-test-client", version: "1.0" });

  try {
    await cli.connectWith(stream, async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0" },
        clientCapabilities: {},
      });

      const session = await ctx.buildSession(testRoot).start();

      const res = await ctx.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "say hello" }],
      });

      assert.equal(res.stopReason, "end_turn");

      session.dispose();
    });
  } finally {
    child.stdin.end();
    child.kill();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test("session/prompt rejects when agy process exits with non-zero exit code", async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-crash-test-"));
  const mockAgy = path.join(testRoot, "mock-crash-agy.mjs");
  const testHome = path.join(testRoot, "home");
  await fs.mkdir(testHome, { recursive: true });

  const mockContent = `#!/usr/bin/env node
console.error("Fatal: unexpected crash in Antigravity CLI");
process.exit(1);
`;
  await fs.writeFile(mockAgy, mockContent, { mode: 0o755 });

  const child = spawn(
    "node",
    ["dist/index.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        AGY_ACP_COMMAND: mockAgy,
      },
    },
  );

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );

  const cli = client({ name: "crash-test-client", version: "1.0" });

  try {
    await cli.connectWith(stream, async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0" },
        clientCapabilities: {},
      });

      const session = await ctx.buildSession(testRoot).start();

      await assert.rejects(
        async () => {
          await ctx.request("session/prompt", {
            sessionId: session.sessionId,
            prompt: [{ type: "text", text: "trigger crash" }],
          });
        },
        (err) => {
          assert.match(err.message, /Antigravity process exited with code 1/);
          assert.match(err.message, /unexpected crash in Antigravity CLI/);
          return true;
        },
      );

      session.dispose();
    });
  } finally {
    child.stdin.end();
    child.kill();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});

test("session/prompt resolves with end_turn on success", async () => {
  const testRoot = await fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-success-test-"));
  const mockAgy = path.join(testRoot, "mock-success-agy.mjs");
  const testHome = path.join(testRoot, "home");
  await fs.mkdir(testHome, { recursive: true });

  const mockContent = `#!/usr/bin/env node
console.log(JSON.stringify({ event: "init", conversation_id: "mock-conv-success" }));
console.log(JSON.stringify({
  event: "step_update",
  step_update: { step_index: 0, state: "DONE", step_type: "agent_response", text_delta: "All done!" }
}));
console.log(JSON.stringify({
  event: "result",
  result: { status: "SUCCESS", response: "All done!" }
}));
process.exit(0);
`;
  await fs.writeFile(mockAgy, mockContent, { mode: 0o755 });

  const child = spawn(
    "node",
    ["dist/index.js"],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: testHome,
        USERPROFILE: testHome,
        AGY_ACP_COMMAND: mockAgy,
      },
    },
  );

  const stream = ndJsonStream(
    Writable.toWeb(child.stdin),
    Readable.toWeb(child.stdout),
  );

  const cli = client({ name: "success-test-client", version: "1.0" });

  try {
    await cli.connectWith(stream, async (ctx) => {
      await ctx.request("initialize", {
        protocolVersion: 1,
        clientInfo: { name: "test-client", version: "1.0" },
        clientCapabilities: {},
      });

      const session = await ctx.buildSession(testRoot).start();

      const result = await ctx.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "say hello" }],
      });

      assert.equal(result.stopReason, "end_turn");
      session.dispose();
    });
  } finally {
    child.stdin.end();
    child.kill();
    await fs.rm(testRoot, { recursive: true, force: true });
  }
});
