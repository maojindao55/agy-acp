import * as fs from "node:fs/promises";
import { rmSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { McpServer } from "@agentclientprotocol/sdk";

type Config = { mcpServers?: Record<string, any>; [key: string]: any };

/** JSON-with-comments is supported by native AGY; do not discard user tools on import. */
export function parseMcpConfig(text: string): Config {
  let stripped = "", quoted = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i + 1];
    if (quoted) {
      stripped += c;
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') { quoted = true; stripped += c; }
    else if (c === "/" && n === "/") {
      while (i + 1 < text.length && text[i + 1] !== "\n") i++;
      stripped += " ";
    } else if (c === "/" && n === "*") {
      const end = text.indexOf("*/", i + 2);
      if (end === -1) throw new Error("Unterminated MCP configuration comment");
      i = end + 1; stripped += " ";
    } else stripped += c;
  }
  let clean = ""; quoted = false; escaped = false;
  for (let i = 0; i < stripped.length; i++) {
    const c = stripped[i];
    if (!quoted && c === "," && /^[\s]*[}\]]/.test(stripped.slice(i + 1))) continue;
    clean += c;
    if (escaped) escaped = false;
    else if (quoted && c === "\\") escaped = true;
    else if (c === '"') quoted = !quoted;
  }
  const config = JSON.parse(clean.replace(/^\uFEFF/, ""));
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      (config.mcpServers !== undefined && (!config.mcpServers || typeof config.mcpServers !== "object" || Array.isArray(config.mcpServers)))) {
    throw new Error("Invalid MCP configuration object");
  }
  return config;
}

function isHostBinding(name: string, server: any): boolean {
  return name.startsWith("freebuddy-") && server?.env && typeof server.env === "object" &&
    Object.keys(server.env).some(key => /^FREEBUDDY_.*(?:TOKEN|ENDPOINT|MANIFEST)$/.test(key));
}

export function convertMcpServers(servers: McpServer[]): Record<string, any> {
  const converted: Record<string, any> = Object.create(null);
  const dictionary = (value: any) => Array.isArray(value)
    ? Object.fromEntries(value.filter(v => v && typeof v.name === "string" && v.value !== undefined).map(v => [v.name, String(v.value)]))
    : value && typeof value === "object" ? value : {};
  for (const server of servers) {
    if (!server?.name) continue;
    if ("type" in server && (server.type === "http" || server.type === "sse")) {
      converted[server.name] = { serverUrl: server.url, headers: dictionary(server.headers) };
    } else {
      const stdio = server as any;
      converted[server.name] = { command: stdio.command, args: stdio.args ?? [], env: dictionary(stdio.env) };
    }
  }
  return converted;
}

/** Private Gemini config roots; native data/auth and non-MCP customizations retain their user locations. */
export class SessionMcpConfigs {
  private root?: string;
  private rootPromise?: Promise<string>;
  private directories = new Map<string, string>();
  private preparing = new Map<string, Promise<string>>();
  constructor(private home = os.homedir()) {}

  async prepare(id: string, servers: McpServer[]): Promise<string> {
    const previous = this.preparing.get(id);
    const task = (async () => {
      await previous?.catch(() => {});
      const root = await (this.rootPromise ??= fs.mkdtemp(path.join(os.tmpdir(), "agy-acp-mcp-")).then(value => this.root = value));
      let dir = this.directories.get(id);
      if (!dir) {
        dir = await fs.mkdtemp(path.join(root, "session-"));
        this.directories.set(id, dir);
      }
      const source = path.join(this.home, ".gemini");
      await fs.mkdir(path.join(source, "antigravity-cli"), { recursive: true });
      await this.linkChildren(source, dir, new Set(["config"]));
      const configDir = path.join(dir, "config");
      await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
      await this.linkChildren(path.join(source, "config"), configDir, new Set(["mcp_config.json"]));
      let base: Config = {};
      try { base = parseMcpConfig(await fs.readFile(path.join(source, "config", "mcp_config.json"), "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const inherited = Object.fromEntries(Object.entries(base.mcpServers ?? {}).filter(([name, server]) => !isHostBinding(name, server)));
      const content = JSON.stringify({ ...base, mcpServers: { ...inherited, ...convertMcpServers(servers) } }, null, 2);
      const file = path.join(configDir, "mcp_config.json");
      let current = "";
      try { current = await fs.readFile(file, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      if (current !== content) {
        const temp = file + ".tmp";
        try { await fs.writeFile(temp, content, { mode: 0o600 }); await fs.rename(temp, file); }
        finally { await fs.rm(temp, { force: true }); }
      }
      return dir;
    })();
    this.preparing.set(id, task);
    try { return await task; }
    finally { if (this.preparing.get(id) === task) this.preparing.delete(id); }
  }

  private async linkChildren(source: string, target: string, excluded: Set<string>): Promise<void> {
    let children;
    try { children = await fs.readdir(source, { withFileTypes: true }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const child of children) {
      if (excluded.has(child.name)) continue;
      const from = path.join(source, child.name), to = path.join(target, child.name);
      try { await fs.lstat(to); continue; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      let stat;
      try { stat = await fs.stat(from); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      try { await fs.symlink(from, to, stat.isDirectory() ? "junction" : "file"); }
      catch (error) {
        if (process.platform !== "win32" || stat.isDirectory()) throw error;
        // Windows file symlinks can require developer mode; retain a private copy instead.
        await fs.copyFile(from, to); await fs.chmod(to, 0o600);
      }
    }
  }

  release(id: string): void {
    const dir = this.directories.get(id);
    this.directories.delete(id);
    if (dir) rmSync(dir, { recursive: true, force: true });
  }

  dispose(): void {
    if (this.root) rmSync(this.root, { recursive: true, force: true });
    this.directories.clear();
  }
}
