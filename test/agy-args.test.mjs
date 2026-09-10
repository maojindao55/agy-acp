import test from "node:test";
import assert from "node:assert/strict";
import {
  resolvePrintTimeout,
  buildAgyArgs,
  DEFAULT_MODE_ID,
} from "../dist/agyArgs.js";

test("resolvePrintTimeout defaults to 30m when no option is provided", () => {
  assert.equal(resolvePrintTimeout([], {}), "30m");
});

test("resolvePrintTimeout honors --print-timeout CLI flag (space separated)", () => {
  assert.equal(
    resolvePrintTimeout(["node", "index.js", "--print-timeout", "45m"], {}),
    "45m",
  );
});

test("resolvePrintTimeout honors --print-timeout= CLI flag", () => {
  assert.equal(
    resolvePrintTimeout(["node", "index.js", "--print-timeout=1h"], {}),
    "1h",
  );
});

test("resolvePrintTimeout honors AGY_ACP_PRINT_TIMEOUT environment variable", () => {
  assert.equal(
    resolvePrintTimeout([], { AGY_ACP_PRINT_TIMEOUT: "15m" }),
    "15m",
  );
});

test("resolvePrintTimeout honors AGY_PRINT_TIMEOUT fallback environment variable", () => {
  assert.equal(
    resolvePrintTimeout([], { AGY_PRINT_TIMEOUT: "20m" }),
    "20m",
  );
});

test("CLI flag takes precedence over environment variable", () => {
  assert.equal(
    resolvePrintTimeout(
      ["node", "index.js", "--print-timeout", "10m"],
      { AGY_ACP_PRINT_TIMEOUT: "50m" },
    ),
    "10m",
  );
});

test("buildAgyArgs injects --print-timeout and basic flags", () => {
  const session = {
    modelBase: "gemini-3.7-flash",
    effort: "high",
    modeId: DEFAULT_MODE_ID,
    additionalDirectories: ["/extra/dir"],
  };

  const args = buildAgyArgs(session, "test prompt", {
    argv: ["node", "index.js"],
    env: { AGY_ACP_PRINT_TIMEOUT: "25m" },
  });

  assert.deepEqual(args, [
    "--print",
    "test prompt",
    "--output-format",
    "stream-json",
    "--print-timeout",
    "25m",
    "--model",
    "gemini-3.7-flash",
    "--effort",
    "high",
    "--add-dir",
    "/extra/dir",
    "--dangerously-skip-permissions",
  ]);
});

test("buildAgyArgs includes conversationId when present", () => {
  const session = {
    conversationId: "conv-12345",
    modelBase: "gemini-3.7-flash",
    effort: null,
    modeId: DEFAULT_MODE_ID,
    additionalDirectories: [],
  };

  const args = buildAgyArgs(session, "continue prompt", {
    argv: ["node", "index.js"],
    env: {},
  });

  assert.ok(args.includes("--conversation"));
  assert.equal(args[args.indexOf("--conversation") + 1], "conv-12345");
  assert.ok(args.includes("--print-timeout"));
  assert.equal(args[args.indexOf("--print-timeout") + 1], "30m");
});

test("buildAgyArgs injects cwd as --add-dir and deduplicates with additionalDirectories", () => {
  const session = {
    cwd: "/workspace/my-app",
    modelBase: "gemini-3.7-flash",
    effort: null,
    modeId: DEFAULT_MODE_ID,
    additionalDirectories: ["/workspace/my-app", "/workspace/docs"],
  };

  const args = buildAgyArgs(session, "test prompt", {
    argv: ["node", "index.js"],
    env: {},
  });

  const addDirArgs = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--add-dir") {
      addDirArgs.push(args[i + 1]);
    }
  }

  assert.deepEqual(addDirArgs, ["/workspace/my-app", "/workspace/docs"]);
});

