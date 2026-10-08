import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildToolCallDiffs,
  extractDiffBlock,
  readStepOutputText,
  readTranscriptToolCallArgs,
  resolveToolCallParameters
} from "../dist/toolDiff.js";

test("buildToolCallDiffs generates ACP diff for replace_file_content with parameters", () => {
  const diffs = buildToolCallDiffs("replace_file_content", {
    TargetFile: "/path/to/file.ts",
    TargetContent: "const a = 1;",
    ReplacementContent: "const a = 2;"
  });
  assert.deepEqual(diffs, [
    {
      type: "diff",
      path: "/path/to/file.ts",
      oldText: "const a = 1;",
      newText: "const a = 2;"
    }
  ]);
});

test("buildToolCallDiffs generates ACP diff with patch from outputText even when parameters are stripped", () => {
  const outputText = `The following changes were made by the replace_file_content tool to: /path/to/file.ts
[diff_block_start]
@@ -1,3 +1,3 @@
-Hello World
+Hello FreeBuddy
 Line 2
-Line 3
[diff_block_end]
`;
  const diffs = buildToolCallDiffs("replace_file_content", {
    TargetFile: "/path/to/file.ts"
  }, outputText);

  assert.deepEqual(diffs, [
    {
      type: "diff",
      path: "/path/to/file.ts",
      patch: "@@ -1,3 +1,3 @@\n-Hello World\n+Hello FreeBuddy\n Line 2\n-Line 3"
    }
  ]);
});

test("buildToolCallDiffs generates ACP diff for write_to_file creation and overwrite", () => {
  const created = buildToolCallDiffs("write_to_file", {
    TargetFile: "/path/to/new.ts",
    CodeContent: "export const x = 1;"
  });
  assert.deepEqual(created, [
    {
      type: "diff",
      path: "/path/to/new.ts",
      oldText: null,
      newText: "export const x = 1;"
    }
  ]);

  const overwritten = buildToolCallDiffs("write_to_file", {
    TargetFile: "/path/to/existing.ts",
    CodeContent: "export const x = 2;",
    Overwrite: true
  });
  assert.deepEqual(overwritten, [
    {
      type: "diff",
      path: "/path/to/existing.ts",
      oldText: "",
      newText: "export const x = 2;"
    }
  ]);
});

test("buildToolCallDiffs generates ACP diffs for multi_replace_file_content", () => {
  const diffs = buildToolCallDiffs("multi_replace_file_content", {
    TargetFile: "/path/to/file.ts",
    Replacements: [
      { TargetContent: "one", ReplacementContent: "two" },
      { TargetContent: "three", ReplacementContent: "four" }
    ]
  });
  assert.deepEqual(diffs, [
    {
      type: "diff",
      path: "/path/to/file.ts",
      oldText: "one",
      newText: "two"
    },
    {
      type: "diff",
      path: "/path/to/file.ts",
      oldText: "three",
      newText: "four"
    }
  ]);
});

test("extractDiffBlock extracts patch between diff_block_start and diff_block_end", () => {
  const text = `Header
[diff_block_start]
@@ -1 +1 @@
-a
+b
[diff_block_end]
Footer`;
  assert.equal(extractDiffBlock(text), "@@ -1 +1 @@\n-a\n+b");
  assert.equal(extractDiffBlock("No diff block here"), null);
});

test("readStepOutputText and readTranscriptToolCallArgs read real brain files", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-brain-test-"));
  const prevEnv = process.env.ANTIGRAVITY_APP_DATA_DIR;
  try {
    process.env.ANTIGRAVITY_APP_DATA_DIR = tmpDir;
    const convId = "test-conv-123";
    const brainDir = path.join(tmpDir, "brain", convId);
    fs.mkdirSync(path.join(brainDir, ".system_generated", "steps", "4"), { recursive: true });
    fs.mkdirSync(path.join(brainDir, ".system_generated", "logs"), { recursive: true });

    fs.writeFileSync(
      path.join(brainDir, ".system_generated", "steps", "4", "output.txt"),
      "Step 4 Output Content"
    );

    const transcriptLines = [
      JSON.stringify({ step_index: 0, type: "USER_INPUT" }),
      JSON.stringify({
        step_index: 3,
        type: "PLANNER_RESPONSE",
        tool_calls: [
          {
            name: "replace_file_content",
            args: {
              TargetFile: '"/tmp/test.txt"',
              TargetContent: '"old content"',
              ReplacementContent: '"new content"'
            }
          }
        ]
      }),
      JSON.stringify({ step_index: 4, type: "GENERIC" })
    ];
    fs.writeFileSync(
      path.join(brainDir, ".system_generated", "logs", "transcript.jsonl"),
      transcriptLines.join("\n")
    );

    const stepOutput = readStepOutputText(convId, 4);
    assert.equal(stepOutput, "Step 4 Output Content");

    const toolArgs = readTranscriptToolCallArgs(convId, "replace_file_content", 4);
    assert.deepEqual(toolArgs, {
      TargetFile: "/tmp/test.txt",
      TargetContent: "old content",
      ReplacementContent: "new content"
    });
  } finally {
    if (prevEnv !== undefined) {
      process.env.ANTIGRAVITY_APP_DATA_DIR = prevEnv;
    } else {
      delete process.env.ANTIGRAVITY_APP_DATA_DIR;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildToolCallDiffs returns empty array for non-edit tools or invalid params", () => {
  assert.deepEqual(buildToolCallDiffs("view_file", { TargetFile: "/path/to/file.ts" }), []);
  assert.deepEqual(buildToolCallDiffs("run_command", { CommandLine: "ls" }), []);
  assert.deepEqual(buildToolCallDiffs("replace_file_content", {}), []);
});

function withTranscripts(records, run) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-full-transcript-test-"));
  const prevEnv = process.env.ANTIGRAVITY_APP_DATA_DIR;
  process.env.ANTIGRAVITY_APP_DATA_DIR = tmpDir;
  const logsDir = path.join(tmpDir, "brain", "test-conv", ".system_generated", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  try {
    for (const [filename, lines] of Object.entries(records)) {
      fs.writeFileSync(path.join(logsDir, filename), lines.map(line => typeof line === "string" ? line : JSON.stringify(line)).join("\n"));
    }
    return run();
  } finally {
    if (prevEnv === undefined) delete process.env.ANTIGRAVITY_APP_DATA_DIR;
    else process.env.ANTIGRAVITY_APP_DATA_DIR = prevEnv;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

const call = (step, tool, args) => ({ step_index: step, tool_calls: [{ name: tool, args }] });
const displayArgs = args => Object.fromEntries(Object.entries(args).map(([key, value]) => [key, JSON.stringify(value)]));
const shortened = text => JSON.stringify(text).slice(0, 2048) + "\n<truncated 1127 bytes>";

test("full transcript recovers long Unicode Markdown and preserves literal escapes", () => {
  const content = '# 任务列表\n\n- [ ] 检查权限\\n保留字面转义\n'.repeat(150);
  const args = { TargetFile: "/tmp/task.md", CodeContent: content, Overwrite: true };
  withTranscripts({
    "transcript.jsonl": [call(3, "write_to_file", { ...displayArgs(args), CodeContent: shortened(content) })],
    "transcript_full.jsonl": [call(3, "write_to_file", args)]
  }, () => {
    assert.deepEqual(readTranscriptToolCallArgs("test-conv", "write_to_file", 4), args);
    const resolved = resolveToolCallParameters("test-conv", "write_to_file", 4, { TargetFile: args.TargetFile });
    assert.equal(buildToolCallDiffs("write_to_file", resolved)[0].newText, content);
    assert.equal(resolved.Overwrite, true);
  });
});

test("full transcript arguments are already decoded, including JSON document contents", () => {
  for (const content of ['"literal string"', '["one", "two"]', '{"path":"C:\\\\repo"}', 'true', '123', '']) {
    const args = { TargetFile: "/tmp/data.json", CodeContent: content };
    withTranscripts({ "transcript_full.jsonl": [call(2, "write_to_file", args)] }, () => {
      assert.deepEqual(readTranscriptToolCallArgs("test-conv", "write_to_file", 3), args);
    });
  }
});

test("display-only fallback decodes scalar arguments and skips malformed trailing writes", () => {
  const args = { TargetFile: "/tmp/task.md", CodeContent: "# Task\n", Overwrite: true, StartLine: 3 };
  withTranscripts({
    "transcript.jsonl": [call(2, "write_to_file", displayArgs(args)), '{"step_index":4,'],
    "transcript_full.jsonl": ['{"step_index":2,']
  }, () => assert.deepEqual(readTranscriptToolCallArgs("test-conv", "write_to_file", 3), args));
});

test("a lagging full transcript cannot replace a newer call with stale content", () => {
  const oldArgs = { TargetFile: "/tmp/task.md", CodeContent: "old" };
  const newArgs = { ...oldArgs, CodeContent: "new" };
  withTranscripts({
    "transcript_full.jsonl": [call(2, "write_to_file", oldArgs)],
    "transcript.jsonl": [call(2, "write_to_file", displayArgs(oldArgs)), call(5, "write_to_file", displayArgs(newArgs))]
  }, () => {
    assert.deepEqual(readTranscriptToolCallArgs("test-conv", "write_to_file", 6), newArgs);
    assert.deepEqual(readTranscriptToolCallArgs("test-conv", "write_to_file", 3), oldArgs);
  });
});

test("same-name calls are disambiguated by the stream target path", () => {
  const a = { TargetFile: "/tmp/a.md", CodeContent: "A" };
  const b = { TargetFile: "/tmp/b.md", CodeContent: "B" };
  withTranscripts({
    "transcript_full.jsonl": [{ step_index: 2, tool_calls: [
      { name: "write_to_file", args: a }, { name: "write_to_file", args: b }
    ] }]
  }, () => {
    assert.equal(readTranscriptToolCallArgs("test-conv", "write_to_file", 3), null);
    assert.deepEqual(resolveToolCallParameters("test-conv", "write_to_file", 3, { TargetFile: b.TargetFile }), b);
  });
});

test("a path mismatch in the latest call never reuses an earlier edit", () => {
  const a = { TargetFile: "/tmp/a.md", CodeContent: "old A" };
  const b = { TargetFile: "/tmp/b.md", CodeContent: "current B" };
  withTranscripts({
    "transcript_full.jsonl": [call(2, "write_to_file", a)],
    "transcript.jsonl": [call(2, "write_to_file", displayArgs(a)), call(5, "write_to_file", displayArgs(b))]
  }, () => assert.equal(readTranscriptToolCallArgs("test-conv", "write_to_file", 6, a.TargetFile), null));
});

test("both lagging logs cannot supply a previous same-path edit", () => {
  const args = { TargetFile: "/tmp/task.md", CodeContent: "previous edit" };
  withTranscripts({ "transcript_full.jsonl": [call(2, "write_to_file", args)] }, () => {
    assert.equal(resolveToolCallParameters("test-conv", "write_to_file", 9, { TargetFile: args.TargetFile }).CodeContent, undefined);
  });
});

test("a gapped tool step requires its own output record and the latest planner batch", () => {
  const args = { TargetFile: "/tmp/task.md", CodeContent: "correct" };
  withTranscripts({ "transcript_full.jsonl": [call(2, "write_to_file", args), { step_index: 4, type: "GENERIC" }] }, () => {
    assert.deepEqual(resolveToolCallParameters("test-conv", "write_to_file", 4, { TargetFile: args.TargetFile }), args);
  });
  withTranscripts({ "transcript_full.jsonl": [call(2, "write_to_file", args), call(3, "view_file", { TargetFile: args.TargetFile }), { step_index: 4, type: "GENERIC" }] }, () => {
    assert.equal(resolveToolCallParameters("test-conv", "write_to_file", 4, { TargetFile: args.TargetFile }).CodeContent, undefined);
  });
});

test("tail reader preserves Unicode records spanning multiple read chunks", () => {
  const args = { TargetFile: "/tmp/task.md", CodeContent: "中文🙂\\n\n".repeat(45000) };
  withTranscripts({ "transcript_full.jsonl": [call(1, "view_file", {}), call(2, "write_to_file", args), '{"step_index":4,'] }, () => {
    assert.deepEqual(readTranscriptToolCallArgs("test-conv", "write_to_file", 3), args);
  });
});

test("missing and truncated stream fields are recovered without replacing complete stream values", () => {
  const args = { TargetFile: "/tmp/task.md", TargetContent: "old\n", ReplacementContent: "new\n" };
  withTranscripts({ "transcript_full.jsonl": [call(2, "replace_file_content", args)] }, () => {
    assert.deepEqual(resolveToolCallParameters("test-conv", "replace_file_content", 3, {
      ...args, ReplacementContent: shortened("new\n")
    }), args);
    assert.deepEqual(resolveToolCallParameters("test-conv", "replace_file_content", 3, {
      TargetFile: args.TargetFile, TargetContent: "stream old\n"
    }), { ...args, TargetContent: "stream old\n" });
    const complete = { ...args, ReplacementContent: "" };
    assert.equal(resolveToolCallParameters("test-conv", "replace_file_content", 3, complete), complete);
    assert.deepEqual(resolveToolCallParameters("test-conv", "replace_file_content", 3, { TargetContent: "old\n", ReplacementContent: "new\n" }), args);
  });
});

test("full transcript recovers structured multi-replacements from shortened display arrays", () => {
  const args = { TargetFile: "/tmp/task.md", Replacements: [
    { TargetContent: "old", ReplacementContent: "new\n".repeat(2000) },
    { TargetContent: "remove", ReplacementContent: "" }
  ] };
  withTranscripts({
    "transcript.jsonl": [call(2, "multi_replace_file_content", { ...displayArgs(args), Replacements: shortened(args.Replacements) })],
    "transcript_full.jsonl": [call(2, "multi_replace_file_content", args)]
  }, () => {
    const recovered = resolveToolCallParameters("test-conv", "multi_replace_file_content", 3, { TargetFile: args.TargetFile });
    assert.equal(buildToolCallDiffs("multi_replace_file_content", recovered)[0].newText, args.Replacements[0].ReplacementContent);
    assert.equal(buildToolCallDiffs("multi_replace_file_content", recovered)[1].newText, "");
  });
});

test("complete output patch takes precedence over unrecoverable shortened arguments", () => {
  const output = "[diff_block_start]\n@@ -1 +1 @@\n-old\n+new\n[diff_block_end]";
  for (const [tool, params] of [
    ["replace_file_content", { TargetContent: shortened("old"), ReplacementContent: "new" }],
    ["write_to_file", { CodeContent: shortened("new") }],
    ["multi_replace_file_content", { Replacements: shortened([]) }]
  ]) {
    assert.deepEqual(buildToolCallDiffs(tool, { TargetFile: "/tmp/task.md", ...params }, output), [{
      type: "diff", path: "/tmp/task.md", patch: "@@ -1 +1 @@\n-old\n+new"
    }]);
  }
  const diff = buildToolCallDiffs("write_to_file", {
    TargetFile: "/tmp/task.md", CodeContent: "new", Description: shortened("description")
  }, output)[0];
  assert.equal(diff.oldText, null);
  assert.equal(diff.newText, "new");
});
