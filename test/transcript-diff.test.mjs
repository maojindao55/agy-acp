import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";
import { readFileSync } from "node:fs";

for (const localFiles of [false, true]) test(`native stream delivers complete diffs (${localFiles ? "large local artifacts" : "small inline"})`, { timeout: 15000 }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-full-diff-"));
  const home = path.join(root, "home");
  const brain = path.join(root, "brain-data");
  const mock = path.join(root, "mock-agy.mjs");
  await fs.mkdir(home, { recursive: true });
  const markdown = '# 任务列表\n\n- [ ] 校验分页与权限\n字面量：\\n，Windows 路径：C:\\repo\\task.md\n'.repeat(localFiles ? 12000 : 180);
  const calls = [
    { step: 3, name: "write_to_file", args: { TargetFile: "/tmp/task.md", CodeContent: markdown }, stream: { TargetFile: "/tmp/task.md" } },
    { step: 5, name: "replace_file_content", args: { TargetFile: "/tmp/task.md", TargetContent: "old\n", ReplacementContent: markdown }, stream: { TargetFile: "/tmp/task.md", TargetContent: "old\n" } },
    { step: 7, name: "multi_replace_file_content", args: { TargetFile: "/tmp/task.md", Replacements: [{ TargetContent: "old\n", ReplacementContent: markdown }] }, stream: { TargetFile: "/tmp/task.md", Replacements: '[{"TargetContent":"old\\n"\n<truncated 1127 bytes>' } },
    { step: 9, name: "write_to_file", args: { TargetFile: "/tmp/failed.md", CodeContent: markdown }, stream: { TargetFile: "/tmp/failed.md" }, failed: true }
  ];
  await fs.writeFile(mock, `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
if (process.argv.includes("--help")) { console.log("usage"); process.exit(0); }
if (process.argv.includes("models")) {
  console.log("gemini-3.7-flash-high\\tGemini 3.7 Flash (High)");
  process.exit(0);
}
const calls = ${JSON.stringify(calls)};
const logs = path.join(process.env.ANTIGRAVITY_APP_DATA_DIR, "brain", "mock-conv", ".system_generated", "logs");
fs.mkdirSync(logs, { recursive: true });
const encode = args => Object.fromEntries(Object.entries(args).map(([key, value]) => {
  const json = JSON.stringify(value);
  return [key, json.length > 2048 ? json.slice(0, 2048) + "\\n<truncated 1127 bytes>" : json];
}));
fs.writeFileSync(path.join(logs, "transcript.jsonl"), calls.map(c => JSON.stringify({ step_index: c.step - 1, tool_calls: [{ name: c.name, args: encode(c.args) }] })).join("\\n"));
fs.writeFileSync(path.join(logs, "transcript_full.jsonl"), calls.map(c => JSON.stringify({ step_index: c.step - 1, tool_calls: [{ name: c.name, args: c.args }] })).join("\\n"));
const emit = value => console.log(JSON.stringify(value));
emit({ event: "init", conversation_id: "mock-conv" });
for (const c of calls) {
  emit({ event: "step_update", step_update: { step_index: c.step, step_type: "tool", state: "ACTIVE", tool_name: c.name, tool_info: { parameters: c.stream } } });
  emit({ event: "step_update", step_update: { step_index: c.step, step_type: "tool", state: c.failed ? "ERROR" : "DONE", tool_name: c.name, tool_info: { output: "Edit finished", ...(c.failed ? { error: { message: "denied" } } : {}) } } });
}
emit({ event: "result", result: { status: "SUCCESS", response: "done" } });
`, { mode: 0o755 });
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home, USERPROFILE: home, ANTIGRAVITY_APP_DATA_DIR: brain, AGY_ACP_COMMAND: mock }
  });
  const updates = [];
  let stderr = "";
  child.stderr.on("data", data => { stderr += data; });
  const cli = client({ name: "full-diff-test" }).onNotification("session/update", ({ params }) => {
    assert.ok(Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params })) <= 65536);
    const update = params.update;
    const content = Array.isArray(update.content) ? update.content.flatMap(entry => {
      const file = entry._meta?.freebuddy?.localDiffFile;
      return file ? JSON.parse(readFileSync(file.path, "utf8")).diffs : [entry];
    }) : update.content;
    updates.push({ ...update, content });
  });
  try {
    await cli.connectWith(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), async ctx => {
      await ctx.request("initialize", { protocolVersion: 1, clientInfo: { name: "test", version: "1" }, clientCapabilities: localFiles ? { _meta: { freebuddy: { localDiffFiles: 1 } } } : {} });
      const session = await ctx.buildSession(root).start();
      try {
        const result = await ctx.request("session/prompt", { sessionId: session.sessionId, prompt: [{ type: "text", text: "test edits" }] });
        assert.equal(result.stopReason, "end_turn");
      } finally {
        session.dispose();
      }
    });
    const completed = updates.filter(update => update.sessionUpdate === "tool_call_update" && update.status === "completed");
    assert.equal(completed.length, 3, stderr);
    for (const update of completed) {
      const diff = update.content.find(entry => entry.type === "diff");
      assert.equal(diff.newText, markdown);
      assert.equal(diff.path, "/tmp/task.md");
      assert.ok(!diff.newText.includes("<truncated"));
    }
    const failed = updates.find(update => update.status === "failed");
    assert.ok(failed);
    assert.ok(!failed.content.some(entry => entry.type === "diff"));
  } finally {
    child.stdin.end();
    child.kill();
    await fs.rm(root, { recursive: true, force: true });
  }
});
