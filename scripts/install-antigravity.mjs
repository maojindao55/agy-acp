#!/usr/bin/env node

import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ANTIGRAVITY_INSTALLER_URLS = Object.freeze({
  darwin: "https://antigravity.google/cli/install.sh",
  linux: "https://antigravity.google/cli/install.sh",
  win32: "https://antigravity.google/cli/install.ps1",
});

function enabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value ?? "").toLowerCase());
}

function isExecutable(candidate, platform) {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathEntries(env, platform) {
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  return pathValue
    .split(platform === "win32" ? ";" : ":")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
}

/** Find agy without launching it (which could trigger authentication or an update). */
export function findInstalledAgy({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const names = platform === "win32"
    ? ["agy.exe", "agy.cmd", "agy.bat", "agy.com", "agy"]
    : ["agy"];
  const directories = pathEntries(env, platform);

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) directories.push(pathApi.join(localAppData, "agy", "bin"));
  } else if (homedir) {
    directories.push(pathApi.join(homedir, ".local", "bin"));
  }

  for (const directory of new Set(directories)) {
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (isExecutable(candidate, platform)) return candidate;
    }
  }
  return undefined;
}

export function installerProcess(platform) {
  if (platform === "win32") {
    return {
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
    };
  }
  if (platform === "darwin" || platform === "linux") {
    return { command: "bash", args: ["-s", "--"] };
  }
  throw new Error(`Unsupported platform: ${platform}`);
}

async function fetchInstaller(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(url, {
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "agy-acp-bridge installer" },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not download the official Antigravity CLI installer: ${detail}`);
  } finally {
    clearTimeout(timeout);
  }
}

function runInstaller(source, platform) {
  const { command, args } = installerProcess(platform);
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env: process.env,
      stdio: ["pipe", "inherit", "inherit"],
      windowsHide: true,
    });
    child.once("error", (error) => {
      reject(new Error(`Could not start the official Antigravity CLI installer: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code ?? "unknown"}`;
      reject(new Error(`The official Antigravity CLI installer failed with ${reason}`));
    });
    child.stdin.on("error", () => {
      // A failing installer can close stdin before Node finishes writing. The
      // close handler above reports its useful exit status.
    });
    child.stdin.end(source);
  });
}

/**
 * Ensure the official agy executable exists after npm installs the ACP bridge.
 * Dependencies are injectable so this flow can be tested without network or
 * platform-specific processes.
 */
export async function ensureAntigravityCli({
  env = process.env,
  platform = process.platform,
  cwd = process.cwd(),
  findAgy = findInstalledAgy,
  isSourceCheckout = (directory) => existsSync(path.join(directory, ".git")),
  download = fetchInstaller,
  install = runInstaller,
  log = (message) => console.log(`[agy-acp] ${message}`),
} = {}) {
  if (enabled(env.AGY_ACP_SKIP_CLI_INSTALL)) {
    log("Skipping Antigravity CLI installation (AGY_ACP_SKIP_CLI_INSTALL is set).");
    return { status: "skipped" };
  }

  const installedPath = findAgy({ env, platform });
  if (installedPath) {
    log(`Antigravity CLI is already installed at ${installedPath}.`);
    return { status: "present", path: installedPath };
  }

  // Avoid changing a contributor's machine during a normal `npm install` in
  // this repository. Packed/global/npx installs do not include the .git entry.
  if (isSourceCheckout(cwd) && !enabled(env.AGY_ACP_FORCE_CLI_INSTALL)) {
    log("Source checkout detected; skipping Antigravity CLI installation.");
    return { status: "source-checkout" };
  }

  const url = ANTIGRAVITY_INSTALLER_URLS[platform];
  if (!url) {
    throw new Error(
      `Antigravity CLI does not support ${platform}. Set AGY_ACP_SKIP_CLI_INSTALL=1 to install only the ACP bridge.`,
    );
  }

  log("Antigravity CLI was not found; downloading the latest release from Google...");
  const source = await download(url);
  await install(source, platform);
  log("Antigravity CLI installation completed.");
  return { status: "installed", url };
}

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  ensureAntigravityCli().catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[agy-acp] ${detail}`);
    console.error(
      "[agy-acp] Set AGY_ACP_SKIP_CLI_INSTALL=1 to install the bridge without Antigravity CLI.",
    );
    process.exitCode = 1;
  });
}
