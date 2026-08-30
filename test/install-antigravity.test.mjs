import assert from "node:assert/strict";
import test from "node:test";

import {
  ANTIGRAVITY_INSTALLER_URLS,
  ensureAntigravityCli,
  installerProcess,
} from "../scripts/install-antigravity.mjs";

const silent = () => {};

test("skip environment variable prevents discovery and network access", async () => {
  let called = false;
  const result = await ensureAntigravityCli({
    env: { AGY_ACP_SKIP_CLI_INSTALL: "true" },
    findAgy: () => {
      called = true;
    },
    download: async () => {
      called = true;
    },
    log: silent,
  });

  assert.deepEqual(result, { status: "skipped" });
  assert.equal(called, false);
});

test("an existing agy executable is preserved", async () => {
  const result = await ensureAntigravityCli({
    env: {},
    platform: "linux",
    findAgy: () => "/home/user/.local/bin/agy",
    isSourceCheckout: () => false,
    download: async () => assert.fail("installer should not be downloaded"),
    log: silent,
  });

  assert.deepEqual(result, {
    status: "present",
    path: "/home/user/.local/bin/agy",
  });
});

test("source checkouts do not modify contributor machines by default", async () => {
  const result = await ensureAntigravityCli({
    env: {},
    platform: "linux",
    findAgy: () => undefined,
    isSourceCheckout: () => true,
    download: async () => assert.fail("installer should not be downloaded"),
    log: silent,
  });

  assert.deepEqual(result, { status: "source-checkout" });
});

for (const platform of ["darwin", "linux", "win32"]) {
  test(`missing agy installs from Google's official URL on ${platform}`, async () => {
    const calls = [];
    const result = await ensureAntigravityCli({
      env: {},
      platform,
      findAgy: () => undefined,
      isSourceCheckout: () => false,
      download: async (url) => {
        calls.push(["download", url]);
        return "official installer source";
      },
      install: async (source, selectedPlatform) => {
        calls.push(["install", source, selectedPlatform]);
      },
      log: silent,
    });

    assert.deepEqual(calls, [
      ["download", ANTIGRAVITY_INSTALLER_URLS[platform]],
      ["install", "official installer source", platform],
    ]);
    assert.deepEqual(result, {
      status: "installed",
      url: ANTIGRAVITY_INSTALLER_URLS[platform],
    });
  });
}

test("force flag allows testing the installer from a source checkout", async () => {
  let installed = false;
  await ensureAntigravityCli({
    env: { AGY_ACP_FORCE_CLI_INSTALL: "1" },
    platform: "linux",
    findAgy: () => undefined,
    isSourceCheckout: () => true,
    download: async () => "installer",
    install: async () => {
      installed = true;
    },
    log: silent,
  });
  assert.equal(installed, true);
});

test("unsupported platforms fail with an actionable opt-out", async () => {
  await assert.rejects(
    ensureAntigravityCli({
      env: {},
      platform: "freebsd",
      findAgy: () => undefined,
      isSourceCheckout: () => false,
      log: silent,
    }),
    /AGY_ACP_SKIP_CLI_INSTALL=1/,
  );
});

test("installer processes avoid shell command interpolation", () => {
  assert.deepEqual(installerProcess("linux"), {
    command: "bash",
    args: ["-s", "--"],
  });
  assert.deepEqual(installerProcess("win32"), {
    command: "powershell.exe",
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      "-",
    ],
  });
});
