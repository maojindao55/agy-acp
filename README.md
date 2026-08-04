# agy-acp-custom

Custom Agent Client Protocol (ACP) adapter bridge for the Google Antigravity CLI (`agy`) built on native JSON-stream output.

Unlike older adapters that rely on polling and parsing local SQLite database states (`StreamPoller`), this adapter uses `agy`'s native `--output-format stream-json` print mode. It is entirely event-driven, streaming message chunks and tool states in real-time.

## Features

- **No DB Polling**: Listens to the structured JSON events streamed directly on `agy`'s stdout.
- **Session History Preservation**: Maps ACP session IDs to `agy`'s `--conversation <id>` context and persists them under `~/.agy-acp-custom-state.json`.
- **Cancellation**: Gracefully handles `session/cancel` by terminating active sub-processes using `SIGINT`.
- **Clean Output Channel**: Routes all internal logging and CLI stderr to `stderr` to avoid polluting the JSON-RPC pipe.
- **Pass-through Configuration**: Forwards command-line flags (like `--dangerously-skip-permissions` or `--sandbox`) to child processes.

## Prerequisites

- **Node.js** (v18+)
- **Antigravity CLI** (`agy`) installed and authenticated locally.

## Setup

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
    "Google Antigravity Custom": {
      "command": "node",
      "args": [
        "/Users/hongbin9/www/agy-acp/dist/index.js",
        "--dangerously-skip-permissions"
      ]
    }
  }
}
```

> [!NOTE]
> Since the adapter runs the CLI in headless print mode (`--print`), any tool execution that requires user confirmation will automatically fail unless `--dangerously-skip-permissions` is supplied. Alternatively, you can whitelist actions in your Antigravity `settings.json` file.
