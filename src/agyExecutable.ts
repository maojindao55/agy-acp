import { accessSync, constants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function isExecutable(candidate: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    accessSync(candidate, platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the CLI from PATH plus the official installer's default directory.
 * The latter matters when agy was installed while a desktop app was already
 * running and that parent process has not reloaded its shell environment.
 */
export function resolveAgyExecutable({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  isExecutableFile = isExecutable,
}: {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  homedir?: string;
  isExecutableFile?: (candidate: string, platform: NodeJS.Platform) => boolean;
} = {}): string {
  const override = env.AGY_ACP_COMMAND?.trim();
  if (override) return override;

  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const delimiter = platform === "win32" ? ";" : ":";
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const directories = pathValue
    .split(delimiter)
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
  const names = platform === "win32"
    ? ["agy.exe", "agy.cmd", "agy.bat", "agy.com", "agy"]
    : ["agy"];

  if (platform === "win32" && env.LOCALAPPDATA) {
    directories.push(pathApi.join(env.LOCALAPPDATA, "agy", "bin"));
  } else if (platform !== "win32" && homedir) {
    directories.push(pathApi.join(homedir, ".local", "bin"));
  }

  for (const directory of new Set(directories)) {
    for (const name of names) {
      const candidate = pathApi.join(directory, name);
      if (isExecutableFile(candidate, platform)) return candidate;
    }
  }

  return "agy";
}
