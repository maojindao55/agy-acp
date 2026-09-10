export const EFFORTS = ["low", "medium", "high"] as const;
export type Effort = (typeof EFFORTS)[number];

export const MODE_ACCEPT_EDITS = "accept-edits";
export const MODE_PLAN = "plan";
export const MODE_IDS = [MODE_ACCEPT_EDITS, MODE_PLAN] as const;
export type ModeId = (typeof MODE_IDS)[number];
export const DEFAULT_MODE_ID: ModeId = MODE_ACCEPT_EDITS;

export interface SessionArgsState {
  conversationId?: string;
  cwd?: string;
  modelBase: string;
  effort: Effort | null;
  modeId: ModeId;
  additionalDirectories: string[];
}

export interface BuildAgyArgsOptions {
  argv?: string[];
  env?: NodeJS.ProcessEnv;
  effectiveEffort?: (session: SessionArgsState) => Effort | null;
}

/**
 * Resolve the --print-timeout duration.
 * Priority:
 * 1. CLI flag passed to agy-acp: `--print-timeout <val>` or `--print-timeout=<val>`
 * 2. Environment variable: `AGY_ACP_PRINT_TIMEOUT` or `AGY_PRINT_TIMEOUT`
 * 3. Default fallback: "30m" (to avoid hitting agy's default 5m timeout on long tasks)
 */
export function resolvePrintTimeout(
  argv: string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env,
): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--print-timeout" && i + 1 < argv.length) {
      return argv[i + 1].trim();
    }
    if (arg.startsWith("--print-timeout=")) {
      return arg.slice("--print-timeout=".length).trim();
    }
  }
  const envTimeout = env.AGY_ACP_PRINT_TIMEOUT ?? env.AGY_PRINT_TIMEOUT;
  if (envTimeout && envTimeout.trim()) {
    return envTimeout.trim();
  }
  return "30m";
}

/**
 * Build arguments to spawn `agy --print`.
 */
export function buildAgyArgs(
  session: SessionArgsState,
  userPrompt: string,
  options: BuildAgyArgsOptions = {},
): string[] {
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;

  const args: string[] = ["--print", userPrompt, "--output-format", "stream-json"];

  const printTimeout = resolvePrintTimeout(argv, env);
  if (printTimeout) {
    args.push("--print-timeout", printTimeout);
  }

  if (session.conversationId) {
    args.push("--conversation", session.conversationId);
  }

  // Model + effort: split form is required (a full effort-baked id conflicts
  // with --effort, and a base id requires --effort when supported).
  args.push("--model", session.modelBase);
  const effort = options.effectiveEffort ? options.effectiveEffort(session) : session.effort;
  if (effort) {
    args.push("--effort", effort);
  }

  if (session.modeId !== DEFAULT_MODE_ID) {
    args.push("--mode", session.modeId);
  }

  const additionalDirs = session.additionalDirectories ?? [];
  if (session.cwd && !additionalDirs.includes(session.cwd)) {
    args.push("--add-dir", session.cwd);
  }

  for (const dir of additionalDirs) {
    args.push("--add-dir", dir);
  }

  // agy runs headlessly under --print; without auto-approval every command
  // tool fails silently ("a tool required the 'command' permission that
  // headless mode cannot prompt for"). Default to skipping permissions unless
  // --sandbox is set or the caller opts out via AGY_ACP_NO_SKIP_PERMISSIONS=1.
  const sandbox = argv.includes("--sandbox");
  const optOut = ["1", "true", "yes"].includes(
    (env.AGY_ACP_NO_SKIP_PERMISSIONS ?? "").toLowerCase(),
  );
  if (!sandbox && !optOut) {
    args.push("--dangerously-skip-permissions");
  }
  if (sandbox) {
    args.push("--sandbox");
  }

  return args;
}
