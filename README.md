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
- **MCP Server Support**: Full Agent Client Protocol MCP integration (`stdio`, `sse`, `http`). Each ACP session gets a private temporary Gemini configuration root, passed explicitly to native AGY with `--gemini_dir`. The bridge never injects credentials into workspace or user-global MCP files. User-defined global MCP tools are imported, while stale FreeBuddy runtime bindings are excluded. Native history/auth data and other user customizations retain their existing locations. Empty MCP lists remove previous session bindings; close/cancel/bridge shutdown removes private tool configuration.
- **Session History Preservation**: Maps ACP session IDs to `agy`'s `--conversation <id>` context and persists them under `~/.agy-acp-state.json`. Supports `session/new`, `session/load`, `session/resume`, `session/list`, and `session/delete`.
- **Warm Multi-turn Sessions**: On CLIs advertising `--input-format stream-json`, keeps one native AGY process per ACP session and sends NDJSON `event: "user"` messages through stdin. Native `result` completes only the current turn; real token counts and model call durations reset each turn. A configuration, workspace or MCP change rebuilds the native process. Cancel/close terminates it, and the next prompt resumes the saved conversation in a fresh process. Idle native processes expire after 10 minutes. `initialize._meta.freebuddy.persistentSession` advertises this capability so hosts can retain the ACP connection as well. CLI slash commands use one-shot mode and rebuild the warm session afterwards. Older CLIs fall back to one-shot print mode; set `AGY_ACP_PERSISTENT=0` to force that mode.
- **Model Catalog Cache**: Public model metadata is cached in `~/.agy-acp-models.json`, bound to the native executable path, size and modification time. Fresh cache entries avoid running `agy models` on every bridge startup; entries older than 24 hours refresh in the background. Missing/invalid cache performs bounded discovery, retaining built-in models if discovery fails. Credentials and prompts are never written to this cache.
- **Concurrent Session State**: Session metadata is stored as separate atomic records in `~/.agy-acp/sessions/`, so parallel bridge processes cannot overwrite another session's native conversation ID. Existing `~/.agy-acp-state.json` records remain readable and migrate on update. The native CLI must support `--gemini_dir`; an unsupported flag fails the run rather than falling back to shared tool credentials.
- **Turn Token Usage**: Returns real input, output, total, reasoning, and cache counters in `session/prompt`'s standard ACP `usage` field. Counts come from this invocation's completed model-response steps, deduplicated by step index. AGY's cumulative `result.usage` is excluded, including when resuming a conversation. Incomplete or invalid counters are left unavailable; token counts and generation speed are never estimated. Clients can combine the returned usage with their own streaming timings to measure speed. `usage_update` remains a separate update of the latest model context occupancy.
- **Model Call Timing**: Returns `_meta.metrics.modelCallDurationMs` with `usageScope: "turn"` when every completed model-response step has valid native `duration_seconds`. Durations are deduplicated and summed across this prompt's calls; separate tool steps, CLI startup, and conversation-wide result duration are excluded. This interval includes first-packet waiting, reasoning and text. Clients can divide the real turn output tokens by this time for a call-average rate, labelled as including first-packet waiting rather than a pure streaming/decode rate. Missing timing leaves token usage available without a rate.
- **Robust UTF-8 Streaming**: Accurately buffers streaming chunks across multi-byte character boundaries without corrupting non-ASCII (e.g., Chinese) outputs.
- **Cancellation**: Gracefully handles `session/cancel` by terminating active sub-processes using `SIGINT`.
- **Clean Output Channel**: Routes all internal logging and CLI stderr to `stderr` to avoid polluting the JSON-RPC pipe.
- **Pass-through Configuration**: Forwards command-line flags (like `--dangerously-skip-permissions` or `--sandbox`) to child processes.
- **Bounded File Diffs**: Recover full typed edit arguments from native transcripts. Large diffs use negotiated same-host artifacts with FreeBuddy; ACP notifications stay within 64 KiB, with explicit incomplete notices for unsupported clients or oversized artifacts.

## Development

File-diff capture and the native transcript truncation investigation are documented
in [docs/diff-transcript.md](docs/diff-transcript.md).

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
