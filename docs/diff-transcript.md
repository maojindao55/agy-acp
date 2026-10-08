# Truncated file-edit arguments

Investigation date: 2026-10-08. Baseline: agy-acp-bridge 0.3.8.

## Cause and evidence

Antigravity writes two JSONL transcripts under
`brain/<conversation-id>/.system_generated/logs/`:

| File | Argument representation | Suitable for diff content |
| --- | --- | --- |
| `transcript.jsonl` | Each argument is JSON-encoded into a display string; long arguments end with a native `<truncated N bytes>` marker | Only when complete and decoded once |
| `transcript_full.jsonl` | Original typed JSON values, including full strings and replacement arrays | Yes; do not JSON-decode the individual arguments again |

The old bridge read only the display transcript. When a shortened string lost
its closing quote, `parseAgyArgValue` returned it unchanged. `buildToolCallDiffs`
then sent that display string as `oldText`/`newText`. This explains both the
literal `\\n` characters and the trailing truncation marker in FreeBuddy.
The bytes were already absent before the ACP notification reached FreeBuddy.

A read-only audit of local Antigravity logs found 1,455 file-edit tool calls.
446 calls had 626 shortened arguments: 477 replace arguments, 141 write
arguments, and 8 replacement-array arguments. Display prefixes were 2,048 bytes
in 613 cases, 2,047 bytes in 6 cases, and 2,046 bytes in 7 cases, consistent with
a 2 KiB display limit and UTF-8 character boundaries. Every shortened argument
had an unshortened counterpart in the full transcript.

This establishes the mechanism using actual local logs; the Windows session
from the original screenshot was not available on this machine.

## Fix

- Recover missing or shortened edit fields from `transcript_full.jsonl` using
  the tool name, planner step bound, and target path when available.
- Preserve typed full-log values exactly, including literal backslashes,
  JSON document contents, empty strings, booleans, and replacement arrays.
- Read the display transcript as a compatibility fallback and decode each
  complete argument once. Never repair incomplete JSON by guessing its tail.
- Compare candidate step indices across both logs. A full log that lags behind
  the display log must not replace the current edit with an earlier one.
- Stop at the latest matching tool-call batch. Path mismatches or ambiguous
  same-name calls must not fall through to an older edit.
- Read records backwards in 64 KiB blocks, stopping at the relevant planner
  batch instead of copying the entire conversation log. Individual records
  above 16 MiB are unavailable. For a gap between planner and tool steps,
  require evidence of the current tool step; two stale logs must not reuse an
  old edit of the same path.
- Preserve complete stream fields when merging recovered parameters. An empty
  replacement string is valid and does not require fallback.
- If only shortened edit fields remain but a complete output diff block exists,
  send that patch without the unusable snippets.

## Bounded ACP transport

Reading complete arguments must not restore the earlier oversized-message
problem. `BoundedUpdates` limits each JSON-RPC `session/update` notification,
including its envelope, to 64 KiB of UTF-8 JSON. Tool text and raw arguments are
bounded separately, and duplicated `rawOutput` is removed. Oversized assistant
text chunks are split losslessly at Unicode boundaries.

Small updates (up to 40 KiB) stay inline. A local client can advertise
`clientCapabilities._meta.freebuddy.localDiffFiles: 1` during initialization.
For a larger diff update the bridge writes `{version: 1, diffs: [...]}` to a
private `agy-acp-diffs-*` directory under the OS temporary directory, sending
only its absolute path, SHA-256 and byte length in
`content[]._meta.freebuddy.localDiffFile`. Each notification gets a distinct
file, including identical queued edits. Directory/file modes are 0700/0600
where supported.

FreeBuddy validates the location, owner, regular-file type, size, checksum and
payload shape, then imports the content into its existing SQLite blob storage
before emitting renderer events. It unlinks the artifact after persistence;
the bridge also removes its own temporary directory on normal shutdown.
The renderer receives blob references and reads the content on demand in
64 KiB chunks. Neither ACP nor renderer events carry the full large diff.

Each artifact is limited to 8 MiB and 4,096 diff entries, with at most 32 MiB
outstanding per bridge process. Clients without the capability, oversized
artifacts and artifact-creation failures receive an explicit incomplete-diff
notice instead of an unbounded body. A failed host import likewise produces
an incomplete record, and a storage failure cannot forward the imported body
to the renderer. The capability is for a same-host stdio connection; remote
clients should not advertise it.

## Validation and limitations

The changed parameter resolver recovered all 446 affected local calls, matching
the relevant full-transcript fields exactly. A recovered diff was also passed
through FreeBuddy's ACP conversion and diff builder: its new text changed from
2 recorded lines with a truncation notice to 77 original lines, producing an
80-row diff with 33 additions and 3 deletions.

`test/tool-diff.test.mjs` covers long Unicode Markdown, literal escape sequences,
JSON document contents, legacy logs, malformed trailing writes, lagging logs,
path disambiguation, empty replacements, shortened stream fields, structured
multi-replacements, and output-patch fallback. `test/transcript-diff.test.mjs`
launches the bridge over real JSON-RPC stdio with a mock native CLI, covering
three editing tools and failed-edit suppression without a model/network call.
It covers both inline updates and megabyte-scale negotiated artifacts through
the actual JSON-RPC SDK, asserting the notification byte limit and exact full
text. `test/bounded-updates.test.mjs` covers legacy fallback, raw arguments,
duplicate outputs, Unicode chunking, artifact limits and independent files for
identical queued notifications. FreeBuddy's importer and SQLite integration
tests cover invalid/missing artifacts, path and symlink checks, bounded
renderer metadata and exact lazy reads after artifact deletion.

Older CLI versions may not create a full transcript. If both the full arguments
and output patch are unavailable, omitted bytes cannot be reconstructed safely.
Existing FreeBuddy SQLite blobs are not rewritten by this bridge change. Source
changes also do not update an independently installed global bridge package;
that runtime must be rebuilt/reinstalled or receive a package release.
