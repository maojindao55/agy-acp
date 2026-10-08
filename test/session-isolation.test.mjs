import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable, Writable } from "node:stream";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { SessionMcpConfigs, parseMcpConfig } from "../dist/sessionMcpConfig.js";
import { SessionStore } from "../dist/sessionStore.js";

const exists = async file => fs.access(file).then(() => true, () => false);
const browser = owner => ({ name: "freebuddy-browser", command: "node", args: ["browserMcpServer.js"], env: [{ name: "FREEBUDDY_BROWSER_TOKEN", value: owner }] });

test("MCP roots isolate credentials, remove stale host tools, preserve user configuration, and clean up safely", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-config-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = path.join(home, ".gemini", "config"), data = path.join(home, ".gemini", "antigravity-cli");
  await fs.mkdir(config, { recursive: true }); await fs.mkdir(data);
  await fs.writeFile(path.join(data, "history"), "keep history");
  await fs.writeFile(path.join(config, "rules.md"), "user rules");
  await fs.symlink(path.join(home, "missing"), path.join(config, "broken-link"));
  const globalText = JSON.stringify({ customField: true, mcpServers: { userTool: { command: "user-tool", env: { USER_TOKEN: "user" } }, "freebuddy-browser": { env: { FREEBUDDY_BROWSER_TOKEN: "stale" } }, "freebuddy-skills": { env: { FREEBUDDY_SKILL_MANIFEST: "stale-manifest" } } } });
  await fs.writeFile(path.join(config, "mcp_config.json"), globalText);
  const roots = new SessionMcpConfigs(home); t.after(() => roots.dispose());
  const [a, b] = await Promise.all([roots.prepare("../../outside", [browser("A")]), roots.prepare("B", [browser("B")])]);
  assert.notEqual(a, b);
  const read = async dir => JSON.parse(await fs.readFile(path.join(dir, "config", "mcp_config.json"), "utf8"));
  assert.equal((await read(a)).mcpServers["freebuddy-browser"].env.FREEBUDDY_BROWSER_TOKEN, "A");
  assert.equal((await read(b)).mcpServers["freebuddy-browser"].env.FREEBUDDY_BROWSER_TOKEN, "B");
  assert.equal((await read(a)).mcpServers["freebuddy-skills"], undefined);
  assert.equal((await read(a)).mcpServers.userTool.command, "user-tool");
  assert.equal((await read(a)).customField, true);
  assert.equal(await fs.realpath(path.join(a, "antigravity-cli")), await fs.realpath(data));
  assert.equal(await fs.readFile(path.join(a, "config", "rules.md"), "utf8"), "user rules");
  const file = path.join(a, "config", "mcp_config.json"), before = (await fs.stat(file)).mtimeMs;
  assert.equal(await roots.prepare("../../outside", [browser("A")]), a);
  assert.equal((await fs.stat(file)).mtimeMs, before); // no watcher reload on identical config
  await roots.prepare("B", []);
  assert.equal((await read(b)).mcpServers["freebuddy-browser"], undefined);
  assert.equal((await read(a)).mcpServers["freebuddy-browser"].env.FREEBUDDY_BROWSER_TOKEN, "A");
  assert.equal(await fs.readFile(path.join(config, "mcp_config.json"), "utf8"), globalText);
  if (process.platform !== "win32") assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  roots.release("B"); assert.equal(await exists(b), false); assert.equal(await exists(a), true);
  roots.dispose(); assert.equal(await exists(a), false);
  assert.equal(await fs.readFile(path.join(data, "history"), "utf8"), "keep history");
});

test("MCP import preserves JSONC strings and fails rather than silently dropping malformed user tools", async t => {
  const parsed = parseMcpConfig('\uFEFF{ /* header */ "mcpServers": { "api": { "url": "https://a/b//c", "args": ["comma,}", /* tail */], }, }, // end\n}');
  assert.equal(parsed.mcpServers.api.url, "https://a/b//c");
  assert.deepEqual(parsed.mcpServers.api.args, ["comma,}"]);
  assert.throws(() => parseMcpConfig('{ /* never closes'), /Unterminated/);
  assert.throws(() => parseMcpConfig('{"mcpServers":[]}'), /Invalid/);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-bad-config-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const config = path.join(home, ".gemini/config"); await fs.mkdir(config, { recursive: true });
  await fs.writeFile(path.join(config, "mcp_config.json"), "broken");
  const roots = new SessionMcpConfigs(home); t.after(() => roots.dispose());
  await assert.rejects(roots.prepare("A", [browser("A")]));
  await fs.writeFile(path.join(config, "mcp_config.json"), "{}");
  assert.ok(await roots.prepare("A", [browser("A")]));
});

test("parallel session records preserve native conversation IDs across bridge instances and migrate legacy state", async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "agy-state-isolation-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const legacy = JSON.stringify({ sessions: { old: { sessionId: "old", conversationId: "native-old" } } });
  await fs.writeFile(path.join(home, ".agy-acp-state.json"), legacy);
  const a = new SessionStore(home, value => value), b = new SessionStore(home, value => value);
  assert.equal((await a.get("old")).conversationId, "native-old");
  await Promise.all(Array.from({ length: 30 }, (_, i) => (i % 2 ? a : b).set({ sessionId: `id-${i}`, conversationId: `native-${i}` })));
  await Promise.all([a.set({ sessionId: "id-0", conversationId: "updated-A" }), b.set({ sessionId: "id-1", conversationId: "updated-B" })]);
  assert.equal((await a.get("id-1")).conversationId, "updated-B");
  assert.equal((await b.get("id-0")).conversationId, "updated-A");
  assert.equal((await a.list()).length, 31);
  await a.delete("old"); assert.equal(await b.get("old"), undefined);
  assert.equal((await b.list()).length, 30);
  assert.equal(await fs.readFile(path.join(home, ".agy-acp-state.json"), "utf8"), legacy);
  assert.equal((await fs.readdir(path.join(home, ".agy-acp/sessions"))).some(f => f.endsWith(".tmp")), false);
});

test("two real ACP bridge processes share a workspace without sharing MCP credentials, history IDs, or warm native children", { timeout: 30_000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-parallel-bridge-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), workspace = path.join(root, "workspace");
  await fs.mkdir(path.join(workspace, ".agents"), { recursive: true }); await fs.mkdir(home);
  const original = '{"mcpServers":{"workspaceTool":{"command":"unchanged"}}}';
  const workspaceConfig = path.join(workspace, ".agents/mcp_config.json"); await fs.writeFile(workspaceConfig, original);
  const preload = path.join(root, "home.mjs"), mock = path.join(root, "agy.mjs"), audit = path.join(root, "audit.jsonl"), barrier = path.join(root, "go");
  await fs.writeFile(preload, `import os from 'node:os'; import {syncBuiltinESMExports} from 'node:module'; os.homedir=()=>${JSON.stringify(home)}; syncBuiltinESMExports();`);
  await fs.writeFile(mock, `#!${process.execPath}
import fs from 'node:fs'; import path from 'node:path'; import readline from 'node:readline';
if(process.argv.includes('--help')) {console.error('--input-format stream-json');process.exit(0);}
if(process.argv.includes('models')) {console.log('gemini-3.8-flash-high\\tGemini 3.8 Flash (High)');process.exit(0);}
const dir=process.argv[process.argv.indexOf('--gemini_dir')+1];
if(!dir || dir.startsWith('--')) process.exit(8);
const owner=()=>JSON.parse(fs.readFileSync(path.join(dir,'config/mcp_config.json'))).mcpServers['freebuddy-browser'].env.FREEBUDDY_BROWSER_TOKEN;
const record=event=>fs.appendFileSync(${JSON.stringify(audit)},JSON.stringify({event,pid:process.pid,dir,owner:owner(),resume:process.argv[process.argv.indexOf('--conversation')+1]})+'\\n');
const emit=x=>console.log(JSON.stringify(x));
if(!process.argv.includes('--input-format')) {
 record('oneshot');emit({event:'step_update',step_update:{step_type:'agent_response',step_index:1,state:'DONE',text_delta:'identity='+owner()}});
 emit({event:'result',result:{status:'SUCCESS'}});process.exit(0);
}
record('spawn');let turn=0;
readline.createInterface({input:process.stdin}).on('line',async line=>{
 const prompt=JSON.parse(line).message.content; ++turn;
 while(prompt==='hold' && !fs.existsSync(${JSON.stringify(barrier)})) await new Promise(r=>setTimeout(r,10));
 const identity=owner();record('prompt');emit({event:'init',conversation_id:'native-'+identity});
 emit({event:'step_update',step_update:{step_type:'agent_response',step_index:turn,state:'DONE',text_delta:'identity='+identity,duration_seconds:1,usage:{input_tokens:100,output_tokens:1,total_tokens:101,thinking_tokens:0}}});
 emit({event:'result',result:{status:'SUCCESS'}});
});
`, { mode: 0o755 });
  const records = async () => (await fs.readFile(audit, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const contexts = [];
  const bridges = [];
  let finish; const done = new Promise(resolve => finish = resolve);
  const run = async index => {
    const child = spawn(process.execPath, ["--import", preload, "dist/index.js"], { cwd: process.cwd(), env: { ...process.env, AGY_ACP_COMMAND: mock } }); bridges.push(child);
    let errors = ""; child.stderr.on("data", d => errors += d);
    const app = client({ name: `isolation-${index}`, version: "1" });
    const text = []; app.onNotification("session/update", ctx => { if (ctx.params.update.sessionUpdate === "agent_message_chunk") text.push(ctx.params.update.content.text); });
    try {
      await app.connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async ctx => {
        await ctx.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
        contexts[index] = { ctx, text };
        await done;
      });
    } catch(error) { error.message += errors; throw error; }
    finally { const closed = once(child, "close"); child.stdin.end(); child.kill(); await closed; }
  };
  const tasks = [run(0), run(1)];
  try {
    for (let i = 0; i < 200 && contexts.filter(Boolean).length !== 2; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(contexts.filter(Boolean).length, 2);
    const ids = await Promise.all(contexts.map(async ({ ctx }, i) => (await ctx.request("session/new", { cwd: workspace, mcpServers: [browser(i ? "B" : "A")] })).sessionId));
    const prompt = (i, text) => contexts[i].ctx.request("session/prompt", { sessionId: ids[i], prompt: [{ type: "text", text }] });
    const held = [prompt(0, "hold"), prompt(1, "hold")];
    for (let i = 0; i < 200 && (await records()).filter(r => r.event === "spawn").length !== 2; i++) await new Promise(r => setTimeout(r, 10));
    const spawned = (await records()).filter(r => r.event === "spawn");
    assert.equal(spawned.length, 2); assert.notEqual(spawned[0].dir, spawned[1].dir);
    await fs.writeFile(barrier, "go"); await Promise.all(held);
    await Promise.all([prompt(0, "again"), prompt(1, "again")]);
    assert.deepEqual(contexts[0].text, ["identity=A", "identity=A"]);
    assert.deepEqual(contexts[1].text, ["identity=B", "identity=B"]);
    assert.equal((await records()).filter(r => r.event === "spawn").length, 2);
    const store = new SessionStore(home, value => value);
    assert.equal((await store.get(ids[0])).conversationId, "native-A");
    assert.equal((await store.get(ids[1])).conversationId, "native-B");
    await prompt(0, "/help");
    assert.equal((await records()).filter(r => r.event === "oneshot").at(-1).owner, "A");
    await prompt(1, "still B");
    assert.equal(contexts[1].text.at(-1), "identity=B");
    assert.equal((await records()).filter(r => r.event === "spawn").length, 2);
    await contexts[0].ctx.request("session/close", { sessionId: ids[0] });
    assert.equal(await exists(spawned.find(r => r.owner === "A").dir), false);
    assert.equal(await exists(spawned.find(r => r.owner === "B").dir), true);
    await prompt(0, "resume");
    assert.equal((await records()).filter(r => r.event === "spawn").at(-1).resume, "native-A");
    assert.equal(await fs.readFile(workspaceConfig, "utf8"), original);
    assert.equal(await exists(path.join(home, ".gemini/config/mcp_config.json")), false);
    await contexts[0].ctx.request("session/close", { sessionId: ids[0] });
    // Leave B warm: bridge shutdown must dispose its private credential files too.
  } finally { finish(); await Promise.all(tasks); }
  for (const record of await records()) assert.equal(await exists(record.dir), false);
});
