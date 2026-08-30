import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveAgyExecutable } from "../dist/agyExecutable.js";

test("AGY_ACP_COMMAND overrides automatic discovery", () => {
  assert.equal(
    resolveAgyExecutable({
      env: { AGY_ACP_COMMAND: "/opt/custom/agy" },
      platform: "linux",
      homedir: "/home/user",
    }),
    "/opt/custom/agy",
  );
});

test("official Unix install path works even when it is absent from PATH", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agy-acp-home-"));
  const executable = path.join(home, ".local", "bin", "agy");
  try {
    await mkdir(path.dirname(executable), { recursive: true });
    await writeFile(executable, "#!/bin/sh\n", "utf8");
    await chmod(executable, 0o755);

    assert.equal(
      resolveAgyExecutable({ env: { PATH: "" }, platform: "linux", homedir: home }),
      executable,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("official Windows install path uses LOCALAPPDATA", () => {
  const expected = "C:\\Users\\tester\\AppData\\Local\\agy\\bin\\agy.exe";
  assert.equal(
    resolveAgyExecutable({
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local", PATH: "" },
      platform: "win32",
      homedir: "C:\\Users\\tester",
      isExecutableFile: (candidate) => candidate === expected,
    }),
    expected,
  );
});

test("missing executables fall back to PATH-based spawning", () => {
  assert.equal(
    resolveAgyExecutable({ env: { PATH: "" }, platform: "linux", homedir: "" }),
    "agy",
  );
});
