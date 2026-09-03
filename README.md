# agy-acp-bridge

Agent Client Protocol (ACP) adapter bridge for the Google Antigravity CLI (`agy`) built on native JSON-stream output.

Unlike older adapters that rely on polling and parsing local SQLite database states (`StreamPoller`), this adapter uses `agy`'s native `--output-format stream-json` print mode. It is entirely event-driven, streaming message chunks and tool states in real-time.

## Installation

Install globally via npm:

```bash
npm install -g agy-acp-bridge
```

If the official Antigravity CLI (`agy`) is not already installed, the npm
package downloads and runs Google's installer for the current platform. The
official installer selects the latest release and verifies its SHA-512 checksum
before installing it. Existing `agy` installations are left in place because
the CLI keeps itself up to date.

The bridge does not redistribute Google's platform binaries inside the npm
tarball. To install only the ACP bridge (for example in an offline build or when
provisioning `agy` separately), disable the automatic installer:

```bash
AGY_ACP_SKIP_CLI_INSTALL=1 npm install -g agy-acp-bridge
```

On Windows PowerShell:

```powershell
$env:AGY_ACP_SKIP_CLI_INSTALL = "1"
npm install -g agy-acp-bridge
```

If `agy` is installed in a non-standard location, point the bridge at it with
`AGY_ACP_COMMAND=/absolute/path/to/agy`.

To customize the CLI prompt execution timeout (default: `30m` to prevent premature stream cutoffs on long tasks), pass `--print-timeout <duration>` or set `AGY_ACP_PRINT_TIMEOUT=<duration>`:

```bash
AGY_ACP_PRINT_TIMEOUT=1h agy-acp
```

Or run directly via `npx`:

```bash
npx agy-acp-bridge
```

## Features

- **No DB Polling**: Listens to the structured JSON events streamed directly on `agy`'s stdout.
- **MCP Server Support**: Full Agent Client Protocol MCP integration (`stdio`, `sse`, `http`), dynamically synced into `<cwd>/.agents/mcp_config.json`.
- **Session History Preservation**: Maps ACP session IDs to `agy`'s `--conversation <id>` context and persists them under `~/.agy-acp-state.json`. Supports `session/new`, `session/load`, `session/resume`, `session/list`, and `session/delete`.
- **Robust UTF-8 Streaming**: Accurately buffers streaming chunks across multi-byte character boundaries without corrupting non-ASCII (e.g., Chinese) outputs.
- **Cancellation**: Gracefully handles `session/cancel` by terminating active sub-processes using `SIGINT`.
- **Clean Output Channel**: Routes all internal logging and CLI stderr to `stderr` to avoid polluting the JSON-RPC pipe.
- **Pass-through Configuration**: Forwards command-line flags (like `--dangerously-skip-permissions` or `--sandbox`) to child processes.

## Development

1. Install dependencies:
   ```bash
   npm install
   ```
2. Build the project:
   ```bash
   npm run build
   ```

## Editor Integration

### Zed Configuration

Add the adapter as a custom agent in your Zed `settings.json`:

```json
{
  "agent_servers": {
    "Google Antigravity": {
      "command": "agy-acp",
      "args": [
        "--dangerously-skip-permissions"
      ]
    }
  }
}
```

Or using `npx`:

```json
{
  "agent_servers": {
    "Google Antigravity": {
      "command": "npx",
      "args": [
        "agy-acp-bridge",
        "--dangerously-skip-permissions"
      ]
    }
  }
}
```

> [!NOTE]
> Since the adapter runs the CLI in headless print mode (`--print`), any tool execution that requires user confirmation will automatically fail unless `--dangerously-skip-permissions` is supplied. Alternatively, you can whitelist actions in your Antigravity `settings.json` file.
