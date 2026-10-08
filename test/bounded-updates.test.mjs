import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { BoundedUpdates, MAX_UPDATE_BYTES } from "../dist/boundedUpdates.js";

const size = update => Buffer.byteLength(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "test", update } }));
const tool = (diffs, text = "done") => ({ sessionUpdate: "tool_call_update", toolCallId: "tool-3", status: "completed",
  content: [...diffs, { type: "content", content: { type: "text", text } }], rawOutput: text });

test("negotiated large diffs cross ACP as bounded references with exact local bodies", () => {
  const transport = new BoundedUpdates(); transport.localDiffFiles = true;
  const diffs = [
    { type: "diff", path: "/tmp/task.md", oldText: null, newText: "# 文档🙂\\n\n".repeat(100000) },
    { type: "diff", path: "/tmp/app.ts", oldText: "before", newText: "after" }
  ];
  let file;
  try {
    const [update] = transport.prepare("test", tool(diffs, "output\n".repeat(300000)));
    assert.ok(size(update) <= MAX_UPDATE_BYTES);
    file = update.content[0]._meta.freebuddy.localDiffFile;
    const payload = fs.readFileSync(file.path);
    assert.equal(payload.length, file.bytes);
    assert.equal(createHash("sha256").update(payload).digest("hex"), file.sha256);
    assert.deepEqual(JSON.parse(payload).diffs, diffs);
    assert.ok(!JSON.stringify(update).includes(diffs[0].newText));
    assert.equal(update.rawOutput, undefined);
    if (process.platform !== "win32") assert.equal(fs.statSync(file.path).mode & 0o777, 0o600);
  } finally { transport.dispose(); }
  assert.ok(!fs.existsSync(file.path));
});

test("legacy clients get bounded, explicit truncation without local paths", () => {
  const transport = new BoundedUpdates();
  const [update] = transport.prepare("test", tool([{ type: "diff", path: "/tmp/task.md", oldText: null, newText: "x".repeat(2_000_000) }]));
  assert.ok(size(update) <= MAX_UPDATE_BYTES);
  assert.equal(update.content[0]._meta.freebuddy.truncated, true);
  assert.match(update.content[0].newText, /^<truncated \d+ bytes>$/);
  assert.equal(update.content[0]._meta.freebuddy.localDiffFile, undefined);
  transport.dispose();
});

test("identical queued diffs have independent artifacts and respect outstanding limits", () => {
  const transport = new BoundedUpdates(); transport.localDiffFiles = true;
  try {
    const update = tool([{ type: "diff", path: "/tmp/task.md", newText: "x".repeat(7 * 1024 * 1024) }]);
    const files = Array.from({ length: 4 }, () => transport.prepare("test", update)[0].content[0]._meta.freebuddy.localDiffFile);
    assert.ok(files.every(Boolean));
    assert.equal(new Set(files.map(file => file.path)).size, 4);
    const [limited] = transport.prepare("test", update);
    assert.equal(limited.content[0]._meta.freebuddy.truncated, true);
    fs.unlinkSync(files[0].path);
    assert.ok(fs.existsSync(files[1].path));
    assert.ok(transport.prepare("test", update)[0].content[0]._meta.freebuddy.localDiffFile);
  } finally { transport.dispose(); }
});

test("artifact and outstanding-file limits retain a bounded fallback", () => {
  const transport = new BoundedUpdates(); transport.localDiffFiles = true;
  try {
    const [update] = transport.prepare("test", tool([{ type: "diff", path: "/tmp/task.md", oldText: null, newText: "x".repeat(9 * 1024 * 1024) }]));
    assert.ok(size(update) <= MAX_UPDATE_BYTES);
    assert.equal(update.content[0]._meta.freebuddy.truncated, true);
  } finally { transport.dispose(); }
});

test("large tool arguments and repeated text cannot bypass the notification budget", () => {
  const transport = new BoundedUpdates();
  for (const update of [
    { sessionUpdate: "tool_call", toolCallId: "tool-1", title: "write", status: "in_progress", rawInput: { content: "\u0000🙂".repeat(200000) } },
    tool([], "\u0000🙂".repeat(200000)),
    { ...tool([]), content: Array.from({ length: 100 }, () => ({ type: "content", content: { type: "text", text: "x".repeat(100000) } })) }
  ]) for (const bounded of transport.prepare("test", update)) assert.ok(size(bounded) <= MAX_UPDATE_BYTES);
});

test("oversized assistant text is split losslessly at Unicode boundaries", () => {
  const transport = new BoundedUpdates();
  const text = "中文🙂\u0000\\\"\n".repeat(10000);
  const updates = transport.prepare("test", { sessionUpdate: "agent_message_chunk", messageId: "msg-1", content: { type: "text", text } });
  assert.ok(updates.length > 1);
  assert.equal(updates.map(update => update.content.text).join(""), text);
  assert.ok(updates.every(update => size(update) <= MAX_UPDATE_BYTES && update.messageId === "msg-1"));
});

test("metadata retains its schema within the budget and fails explicitly beyond it", () => {
  const transport = new BoundedUpdates();
  const update = { sessionUpdate: "config_option_update", configOptions: [{ id: "model", description: "x".repeat(45000) }] };
  assert.deepEqual(transport.prepare("test", update), [update]);
  assert.throws(() => transport.prepare("test", { ...update, extra: "x".repeat(70000) }), /metadata exceeds limit/);
});
