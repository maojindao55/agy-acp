import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable, Writable } from "node:stream";
import test from "node:test";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { AgyTurnUsage } from "../dist/turnUsage.js";

const nativeUsage = (input, output, extra = {}) => ({
  input_tokens: input, output_tokens: output, total_tokens: input + output,
  thinking_tokens: 0, cache_read_tokens: 0, ...extra,
});
const response = (index, usage, state = "DONE") => ({
  step_type: "agent_response", step_index: index, state, ...(usage === undefined ? {} : { usage }),
});

test("maps real native token counters to standard ACP turn usage", () => {
  const turn = new AgyTurnUsage();
  turn.observeStep(response(1, nativeUsage(12_942, 534, { thinking_tokens: 52 })));
  assert.deepEqual(turn.snapshot(), {
    inputTokens: 12_942, outputTokens: 534, totalTokens: 13_476,
    thoughtTokens: 52, cachedReadTokens: 0,
  });
});

test("sums distinct model steps across tools and replaces duplicate usage snapshots", () => {
  const turn = new AgyTurnUsage();
  const first = response(1, nativeUsage(100, 10, { thinking_tokens: 2, cache_read_tokens: 50 }));
  turn.observeStep(first);
  turn.observeStep(first);
  turn.observeStep({ step_type: "tool", step_index: 2, state: "DONE", usage: nativeUsage(999, 999) });
  turn.observeStep(response(3, undefined, "ACTIVE"));
  assert.equal(turn.snapshot(), undefined);
  turn.observeStep(response(3, nativeUsage(200, 20, { thinking_tokens: 3, cache_read_tokens: 80 })));
  turn.observeStep(response(3, nativeUsage(200, 25, { thinking_tokens: 4, cache_read_tokens: 80 })));
  turn.observeStep(response(3)); // A repeated DONE without usage must not erase the snapshot.
  assert.deepEqual(turn.snapshot(), {
    inputTokens: 300, outputTokens: 35, totalTokens: 335,
    thoughtTokens: 6, cachedReadTokens: 130,
  });
});

test("each prompt has independent totals, and an empty turn has no fabricated usage", () => {
  const previous = new AgyTurnUsage();
  previous.observeStep(response(1, nativeUsage(100, 10)));
  const current = new AgyTurnUsage();
  assert.equal(current.snapshot(), undefined);
  current.observeStep(response(4, nativeUsage(200, 7)));
  assert.equal(current.snapshot().outputTokens, 7);
  assert.equal(previous.snapshot().outputTokens, 10);
});

test("missing usage on any response prevents reporting a partial turn as complete", () => {
  for (const missing of [undefined, {}, { input_tokens: 100, total_tokens: 100 }, { output_tokens: 20 }]) {
    const turn = new AgyTurnUsage();
    turn.observeStep(response(1, nativeUsage(100, 10)));
    turn.observeStep(response(3, missing));
    assert.equal(turn.snapshot(), undefined);
  }
});

test("preserves genuine zero counters and omits optional counters absent on a step", () => {
  const turn = new AgyTurnUsage();
  turn.observeStep(response(1, nativeUsage(0, 0)));
  turn.observeStep(response(3, { input_tokens: 1, output_tokens: 0, total_tokens: 1 }));
  assert.deepEqual(turn.snapshot(), { inputTokens: 1, outputTokens: 0, totalTokens: 1 });
});

test("forwards native totals without adding thinking or cache counters a second time", () => {
  const turn = new AgyTurnUsage();
  turn.observeStep(response(1, nativeUsage(100, 10, {
    total_tokens: 140, thinking_tokens: 30, cache_read_tokens: 50, cache_write_tokens: 4,
  })));
  assert.deepEqual(turn.snapshot(), {
    inputTokens: 100, outputTokens: 10, totalTokens: 140,
    thoughtTokens: 30, cachedReadTokens: 50, cachedWriteTokens: 4,
  });
});

test("rejects malformed, negative, fractional and unsafe token counters", () => {
  for (const field of ["input_tokens", "output_tokens", "total_tokens", "thinking_tokens", "cache_read_tokens", "cache_write_tokens"]) {
    for (const invalid of [-1, 1.5, NaN, Infinity, "20", null, Number.MAX_SAFE_INTEGER + 1]) {
      const turn = new AgyTurnUsage();
      turn.observeStep(response(1, nativeUsage(100, 10, { [field]: invalid })));
      assert.equal(turn.snapshot(), undefined, `${field}: ${String(invalid)}`);
    }
  }
});

test("rejects ambiguous step IDs and overflowing aggregated counts", () => {
  for (const index of [undefined, -1, "1", 1.5, NaN]) {
    const turn = new AgyTurnUsage();
    turn.observeStep(response(index, nativeUsage(100, 10)));
    assert.equal(turn.snapshot(), undefined);
  }
  const turn = new AgyTurnUsage();
  turn.observeStep(response(1, nativeUsage(0, Number.MAX_SAFE_INTEGER)));
  turn.observeStep(response(3, nativeUsage(0, 1)));
  assert.equal(turn.snapshot(), undefined);
});

test("model call time includes hidden reasoning and deduplicates each completed response", () => {
  const turn = new AgyTurnUsage();
  const first = { ...response(1, nativeUsage(100, 339, { thinking_tokens: 334 })), duration_seconds: 5.873064 };
  turn.observeStep(first);
  turn.observeStep(first);
  turn.observeStep({ step_type: "tool", step_index: 2, state: "DONE", duration_seconds: 90 });
  turn.observeStep({ ...response(3, nativeUsage(200, 61)), duration_seconds: 4.126936 });
  assert.equal(turn.snapshot().outputTokens, 400);
  assert.equal(turn.modelCallDurationMs(), 10_000);
  turn.observeStep({ ...response(3, nativeUsage(200, 61)), duration_seconds: 3.126936 });
  assert.equal(turn.modelCallDurationMs(), 9_000);
});

test("missing, incomplete and invalid call time never prevents true token reporting", () => {
  for (const duration of [undefined, null, "2", 0, -1, 0.0001, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    const turn = new AgyTurnUsage();
    turn.observeStep({ ...response(1, nativeUsage(100, 10)), duration_seconds: 2 });
    turn.observeStep({ ...response(3, nativeUsage(200, 20)), duration_seconds: duration });
    assert.equal(turn.snapshot().outputTokens, 30);
    assert.equal(turn.modelCallDurationMs(), undefined, String(duration));
  }
  const turn = new AgyTurnUsage();
  turn.observeStep({ ...response(1, nativeUsage(100, 10)), duration_seconds: 2 });
  turn.observeStep(response(3, undefined, "ACTIVE"));
  assert.equal(turn.modelCallDurationMs(), undefined);
});

test("ACP pipe returns per-turn usage, ignores cumulative results, and flushes the final line", { timeout: 20_000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-usage-test-"));
  const testHome = path.join(root, "home");
  const mockAgy = path.join(root, "mock-agy.mjs");
  const preload = path.join(root, "test-home.mjs");
  await fs.mkdir(testHome);
  // Isolate the subprocess's state without changing HOME or USERPROFILE.
  await fs.writeFile(preload, `import os from 'node:os';
import { syncBuiltinESMExports } from 'node:module';
os.homedir = () => ${JSON.stringify(testHome)};
syncBuiltinESMExports();\n`);
  const event = step => ({ event: "step_update", step_update: step });
  const first = { ...response(1, nativeUsage(100, 10)), duration_seconds: 2 };
  const fixtures = {
    first: [
      { event: "init", conversation_id: "mock-conversation" },
      event({ ...response(1, undefined, "ACTIVE"), text_delta: "First" }),
      event(first), event(first),
      event({ step_type: "tool", step_index: 2, state: "ACTIVE", tool_name: "run_command", tool_info: {} }),
      event({ step_type: "tool", step_index: 2, state: "DONE", tool_name: "run_command", tool_info: {} }),
      event({ ...response(3, nativeUsage(200, 20)), text_delta: "Done", duration_seconds: 4 }),
      { event: "result", result: { status: "SUCCESS", usage: nativeUsage(300, 30) } },
    ],
    second: [
      { event: "init", conversation_id: "mock-conversation" },
      event({ ...response(5, nativeUsage(400, 7)), text_delta: "Again", duration_seconds: 1.25 }),
      { event: "result", result: { status: "SUCCESS", usage: nativeUsage(700, 37) } },
    ],
    missing: [
      event({ ...response(7), text_delta: "Unknown tokens" }),
      { event: "result", result: { status: "SUCCESS", usage: nativeUsage(900, 50) } },
    ],
    unterminated: [event({ ...response(9, nativeUsage(500, 9)), text_delta: "Last line" })],
  };
  await fs.writeFile(mockAgy, `#!${process.execPath}
if (process.argv.includes('models')) { console.log('[]'); process.exit(0); }
const fixtures = ${JSON.stringify(fixtures)};
const name = process.argv[process.argv.indexOf('--print') + 1];
process.stdout.write(fixtures[name].map(event => JSON.stringify(event)).join('\\n'));
`, { mode: 0o755 });

  const child = spawn(process.execPath, ["--import", preload, "dist/index.js"], {
    cwd: process.cwd(), env: { ...process.env, AGY_ACP_COMMAND: mockAgy },
  });
  let stderr = "";
  child.stderr.on("data", chunk => { stderr += chunk; });
  const messages = [];
  let output = "";
  child.stdout.on("data", chunk => {
    output += chunk;
    let newline;
    while ((newline = output.indexOf("\n")) >= 0) {
      messages.push(JSON.parse(output.slice(0, newline)));
      output = output.slice(newline + 1);
    }
  });
  try {
    const cli = client({ name: "usage-test", version: "1" });
    await cli.connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async ctx => {
      await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const session = await ctx.buildSession(root).start();
      try {
        const prompt = text => ctx.request("session/prompt", {
          sessionId: session.sessionId, prompt: [{ type: "text", text }],
        });
        const firstResult = await prompt("first");
        assert.deepEqual(firstResult._meta, { metrics: { usageScope: "turn", modelCallDurationMs: 6_000 } });
        assert.deepEqual(firstResult.usage, {
          inputTokens: 300, outputTokens: 30, totalTokens: 330,
          thoughtTokens: 0, cachedReadTokens: 0,
        });
        const secondResult = await prompt("second");
        assert.deepEqual(secondResult._meta, { metrics: { usageScope: "turn", modelCallDurationMs: 1_250 } });
        assert.deepEqual(secondResult.usage, {
          inputTokens: 400, outputTokens: 7, totalTokens: 407,
          thoughtTokens: 0, cachedReadTokens: 0,
        });
        assert.equal((await prompt("missing")).usage, undefined);
        assert.equal((await prompt("unterminated")).usage.outputTokens, 9);
        const occupancy = messages.filter(message => message.params?.update?.sessionUpdate === "usage_update")
          .map(message => message.params.update.used);
        assert.deepEqual(occupancy, [100, 100, 200, 400, 500]);
      } finally {
        session.dispose();
      }
    });
  } catch (error) {
    error.message += `\nBridge stderr: ${stderr}`;
    throw error;
  } finally {
    const exited = once(child, "close");
    child.stdin.end();
    child.kill();
    await exited;
    await fs.rm(root, { recursive: true, force: true });
  }
});
