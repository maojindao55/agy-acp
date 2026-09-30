import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildToolCallDiffs,
  extractDiffBlock,
  readStepOutputText,
  readTranscriptToolCallArgs
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
