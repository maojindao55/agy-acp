// End-to-end test for the agy-acp adapter.
//
// Spawns the built adapter as a real ACP server over stdio and drives it with
// the official SDK client. Run after `npm run build`:
//
//   node test/client.mjs "<prompt>"            # tools will fail (no skip-perms)
//   node test/client.mjs "<prompt>" --skip      # pass --dangerously-skip-permissions
//   node test/client.mjs                        # default prompt
//
// Requires the `agy` CLI to be installed and authenticated.

import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import os from "node:os";
import { client, ndJsonStream } from "@agentclientprotocol/sdk";

const argv = process.argv.slice(2);
const skip = argv.includes("--skip");
const prompt = argv.find((a) => !a.startsWith("-"));
const cwd = os.tmpdir();

const child = spawn(
  "node",
  ["dist/index.js", ...(skip ? ["--dangerously-skip-permissions"] : [])],
  { cwd: process.cwd(), env: { ...process.env } },
);
child.stderr.on("data", (c) => process.stderr.write(`\x1b[2m[adapter] ${c}\x1b[0m`));

// Bridge the child's stdio to an ACP stream. From the client's side:
//   output -> agent stdin (requests we send)
//   input  <- agent stdout (responses/notifications we receive)
const stream = ndJsonStream(
  Writable.toWeb(child.stdin),
  Readable.toWeb(child.stdout),
);

const cli = client({ name: "test-client", version: "1.0" });

let toolCalls = 0;
let usageUpdates = 0;

await cli.connectWith(stream, async (ctx) => {
  console.log("initialize ->", JSON.stringify((await ctx.request("initialize", {
    protocolVersion: 1,
    clientInfo: { name: "test-client", version: "1.0" },
    clientCapabilities: {},
  })).agentCapabilities));

  const session = await ctx.buildSession(cwd).start();
  console.log("session/new ->", session.sessionId);
  console.log("modes      ->", JSON.stringify(session.modes));
  console.log("config     ->", JSON.stringify(session.newSessionResponse.configOptions));

  const message = prompt || "say hi in one word";
  console.log("\nprompt     ->", JSON.stringify(message));

  const done = session.prompt(message);
  while (true) {
    const msg = await session.nextUpdate();
    if (msg.kind === "session_update") {
      const u = msg.update;
      switch (u.sessionUpdate) {
        case "agent_message_chunk":
          process.stdout.write(u.content.type === "text" ? u.content.text : "");
          break;
        case "tool_call":
          toolCalls++;
          console.log(`\n  [tool_call] ${u.toolCallId} name=${u.name} kind=${u.kind} status=${u.status}` +
            (u.locations?.length ? ` file=${u.locations[0].path}` : ""));
          break;
        case "tool_call_update":
          console.log(`  [tool_call_update] ${u.toolCallId} status=${u.status}`);
          break;
        case "usage_update":
          usageUpdates++;
          console.log(`  [usage_update] used=${u.used}/${u.size}`);
          break;
        default:
          console.log(`  [${u.sessionUpdate}]`);
      }
    } else {
      // kind === "stop"
      console.log("\n\nstop       ->", msg.stopReason);
      break;
    }
  }

  console.log(`\nsummary    -> tool_calls=${toolCalls} usage_updates=${usageUpdates}`);
  session.dispose();
});

child.stdin.end();
child.kill();
process.exit(0);
