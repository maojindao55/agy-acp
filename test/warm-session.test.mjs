import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { cachedModels } from "../dist/modelCache.js";

test("model cache survives bridge restarts, refreshes stale data and rejects changed executables", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-model-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const executable = path.join(root, "agy"); await fs.writeFile(executable, "one");
  let count = 0, now = 100;
  const options = { file: path.join(root, "models.json"), executable, valid: value => Array.isArray(value) && value.every(v => typeof v === "string"),
    fetch: async () => { count++; return [`model-${count}`]; }, fallback: ["fallback"], now: () => now, ttlMs: 10 };
  assert.deepEqual(await cachedModels(options), ["model-1"]);
  assert.deepEqual(await cachedModels({ ...options }), ["model-1"]);
  assert.equal(count, 1);
  now = 200;
  assert.deepEqual(await cachedModels(options), ["model-1"]); // stale data does not block the next prompt
  for (let i = 0; i < 50; i++) {
    const cached = JSON.parse(await fs.readFile(options.file, "utf8"));
    if (cached.models[0] === "model-2") break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await cachedModels(options), ["model-2"]);
  await fs.writeFile(executable, "updated executable");
  assert.deepEqual(await cachedModels(options), ["model-3"]);
  await fs.writeFile(options.file, "broken");
  assert.deepEqual(await cachedModels({ ...options, fetch: async () => null }), ["fallback"]);
});

test("persistent ACP turns share one native process, reset metrics, rebuild on config/cancel, and cache models across restarts", { timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-warm-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"); await fs.mkdir(home);
  const preload = path.join(root, "home.mjs"), mock = path.join(root, "agy.mjs"), audit = path.join(root, "audit.jsonl");
  await fs.writeFile(preload, `import os from 'node:os'; import { syncBuiltinESMExports } from 'node:module'; os.homedir = () => ${JSON.stringify(home)}; syncBuiltinESMExports();`);
  await fs.writeFile(mock, `#!${process.execPath}
import fs from 'node:fs'; import readline from 'node:readline';
const audit = ${JSON.stringify(audit)};
const record = event => fs.appendFileSync(audit, JSON.stringify({ event, pid: process.pid })+'\\n');
if (process.argv.includes('--help')) { console.error('--input-format stream-json'); process.exit(0); }
if (process.argv.includes('models')) { record('models'); console.log('gemini-3.8-flash-high\\tGemini 3.8 Flash (High)'); process.exit(0); }
const emit = event => process.stdout.write(JSON.stringify(event)+'\\n');
if (!process.argv.includes('--input-format')) {
  record('oneshot'); emit({event:'step_update',step_update:{step_type:'agent_response',step_index:99,state:'DONE',text_delta:'CLI help'}});
  emit({event:'result',result:{status:'SUCCESS'}}); process.exit(0);
}
record('spawn'); let turn = 0;
readline.createInterface({ input: process.stdin }).on('line', line => {
  const input = JSON.parse(line); if(input.event !== 'user' || typeof input.message?.content !== 'string') process.exit(2);
  record('prompt'); ++turn;
  if(turn === 1) emit({event:'init',conversation_id:'native-warm'});
  if(input.message.content === 'crash') process.exit(7);
  emit({event:'step_update',step_update:{step_type:'agent_response',step_index:turn*2-1,state:'ACTIVE',text_delta:'Reply'}});
  if(input.message.content === 'hold') return;
  const usage = {input_tokens:100,output_tokens:turn*10,total_tokens:100+turn*10,thinking_tokens:turn,cache_read_tokens:0};
  const done = {event:'step_update',step_update:{step_type:'agent_response',step_index:turn*2-1,state:'DONE',duration_seconds:turn*2,usage}};
  emit(done); emit(done); // duplicate snapshots must not double count
  emit({event:'result',result:{status:'SUCCESS',usage:{input_tokens:999,output_tokens:999,total_tokens:1998}}});
});
`, { mode: 0o755 });
  const records = async () => (await fs.readFile(audit, "utf8")).trim().split("\n").map(JSON.parse);
  const runBridge = async action => {
    const child = spawn(process.execPath, ["--import", preload, "dist/index.js"], { cwd: process.cwd(), env: { ...process.env, AGY_ACP_COMMAND: mock } });
    let stderr = ""; child.stderr.on("data", d => { stderr += d; });
    try {
      await client({ name: "warm-test", version: "1" }).connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async ctx => {
        const init = await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        assert.equal(init._meta.freebuddy.persistentSession, true);
        await action(ctx);
      });
    } catch (error) { error.message += `\n${stderr}`; throw error; }
    finally { const exited = once(child, "close"); child.stdin.end(); child.kill(); await exited; }
  };
  let id;
  await runBridge(async ctx => {
    const created = await ctx.request("session/new", { cwd: root, mcpServers: [] }); id = created.sessionId;
    const prompt = text => ctx.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text }] });
    const first = await prompt("one"), second = await prompt("two");
    assert.equal(first.usage.outputTokens, 10); assert.equal(second.usage.outputTokens, 20);
    assert.equal(second.usage.thoughtTokens, 2);
    assert.equal(second._meta.metrics.modelCallDurationMs, 4000);
    assert.equal((await records()).filter(r => r.event === "spawn").length, 1);
    assert.equal((await prompt("/help")).stopReason, "end_turn");
    assert.equal((await records()).filter(r => r.event === "oneshot").length, 1);
    await ctx.request("session/set_config_option", { sessionId: id, configId: "effort", value: "low" });
    assert.equal((await prompt("three")).usage.outputTokens, 10);
    assert.equal((await records()).filter(r => r.event === "spawn").length, 2);
    const held = prompt("hold");
    for (let i = 0; i < 50 && (await records()).filter(r => r.event === "prompt").length < 4; i++) await new Promise(resolve => setTimeout(resolve, 10));
    await assert.rejects(prompt("overlapping"), /already has an active turn/);
    await ctx.notify("session/cancel", { sessionId: id });
    assert.equal((await held).stopReason, "cancelled");
    assert.equal((await prompt("after cancel")).usage.outputTokens, 10);
    await assert.rejects(prompt("crash"), /exited before the turn completed/);
    assert.equal((await prompt("after crash")).usage.outputTokens, 10);
    await ctx.request("session/close", { sessionId: id });
  });
  await runBridge(async ctx => {
    await ctx.request("session/load", { sessionId: id, cwd: root, mcpServers: [] });
    const result = await ctx.request("session/prompt", { sessionId: id, prompt: [{ type: "text", text: "restart" }] });
    assert.equal(result.usage.outputTokens, 10);
    await ctx.request("session/close", { sessionId: id });
  });
  assert.equal((await records()).filter(r => r.event === "models").length, 1);
});
