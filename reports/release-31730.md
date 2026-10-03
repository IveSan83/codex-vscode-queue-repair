# Official 26.930.31730 review and queue repair 2.2

Date: 2026-10-03. Platform: Windows x64. Repair author: **IveSan83**.

Repository: https://github.com/IveSan83/codex-vscode-queue-repair

## Result

The official **26.930.31730** package retains the tested local queue defects.
Repair 2.2 ports the reviewed persistence/receipt repair to its exact bundle
hashes. It keeps the existing journal format and does not automatically replay
saved uncertain messages. The installer preserves a private local queue backup.

The release requires **88 distinct tests in each runtime**, standalone Node and
VS Code's Electron in Node mode: **176 executions**, no skipped or cancelled
tests. Original-bug controls pass when they reproduce the expected bug;
repair scenarios exercise the patched code. These are headless filesystem,
packaged-module and controlled-transport checks, not live UI/model delivery.

Download the source/installer ZIP and sanitized test-results ZIP from:
https://github.com/IveSan83/codex-vscode-queue-repair/releases/tag/v2.2.0

## Verified input

Official package: `openai.chatgpt`, `win32-x64`, stable `26.930.31730`.
Marketplace updated it at **2026-10-03T03:36:24.943Z**. Download size: 538,040,402 bytes.
The downloaded SHA-256 matches the Marketplace checksum:
`de39fdeeb6707d55a5f797426d4871adcf8a1e5d3d7d2d128957b43e88c2576b`.

Official download:
https://openai.gallerycdn.vsassets.io/extensions/openai/chatgpt/26.930.31730/1790996661385/Microsoft.VisualStudio.Services.VSIXPackage

The comparison baseline is the unmodified official `26.930.31428` package,
SHA-256 `7a5b1484c0f994ef12f96865568abc6648862082edb433fafd4321d4a7cb5fea`.

## Defects reproduced in shipped code

### Lost queued message

The actual unmodified coordinator accepts a queued message while execution is
disabled. After its writes settle, the harness injects an empty storage snapshot
and invokes the refresh path. The in-memory queue changes from one entry to zero;
the transport receives zero sends. The snapshot models stale Memento delivery;
this new run does not execute VS Code's own Memento implementation.

With the revisioned journal, the message survives the same stale-state event and
is submitted once after execution becomes available.

### Replayed message despite a positive receipt

The original coordinator receives a restored pending message A while the loaded
receipt callback already confirms A. It sends A again. The repair reconciles the
positive receipt before acquiring the send lock and continues with waiting B.
Missing or incomplete history does not authorize replay of an uncertain send.

### Invalid void-response contract

The shipped `queued-follow-up-send-lock-release` handler invokes `release(...)`
and returns `undefined`. The shipped bridge emits `JSON.stringify(o)`, which does
not produce a JSON string for that return value. The actual webview parser calls
`JSON.parse(e.bodyJsonString)` and rejects the response with a SyntaxError.

The release side effect occurs before the error. This warning alone does not
prove that the lock remained held, and normalizing it is not sufficient evidence
that persistence and replay defects are fixed. The repair uses
`JSON.stringify(o ?? null)`; the same actual parser accepts that response.

## Queue-component comparison

| Component | 31428 symbol | 31730 symbol | After identifier normalization |
| --- | --- | --- | --- |
| Host storage class | XF | ZF | Same structure |
| Storage adapter | wen | Oen | Same structure |
| Queue coordinator | DAn | EAn | Same structure |
| Submission preparation | CAn | SAn | Same structure |

The comparison retains literals, operators, property names and private fields.
The symbol map is consistent for these components. This is not a formal proof
of semantic equivalence of the entire application.

## Other upstream changes

- **Hosted Git metadata:** a separate memoized operation with a 1,000 ms lifetime
  replaces unconditional metadata/root-cache deletion on every hosted request.
  Global invalidation clears this cache too. Real remote-project speed was not
  benchmarked.
- **Cloud history:** the readiness waiter now subscribes to both
  `compactHistoryComplete` and `boundedCloudHistoryReady`, disposing both on
  completion or failure. Tests cover both events, failure cleanup and incomplete
  history. Cloud pagination and `notLoaded` handling also changed; some full-item
  requests use an item limit of 30. Ancestor refresh and subagent background
  history loading use narrower paths. Live cloud-server behavior was not tested.
- **Used-plugin history:** scanning keeps continuation state and processes up
  to four scans at a time rather than exhaustively traversing every page in one
  query. It requests descending order and rejects an unchanged non-null cursor.
  Tests cover cursor repetition, final/continued pages, ID deduplication and
  cancellation before transport. Older-activity search controls were added.
- **Cloud configuration:** a shared `settings-configs` module replaces a
  `search-refresh` module and paginates saved environment configurations.
- **Activity state:** several conditions stop treating `sleeping` plus a
  background-work flag as active. No visual checks were performed.
- **Shared product code:** a Pages realtime-host header, websocket hostnames and
  Codex discovery logic were added. Their presence in a shared bundle does not
  establish availability in this IDE or a specific account.

In `package.json`, only the version changed. Declared VS Code settings, commands
and engine requirements are unchanged. The Windows native executable is byte
identical to 31428 and both probes report **codex-cli 0.160.0**, SHA-256:
`fdda5fa3cf3fb3d000b876720742857676293e4315e4b045fae6f8bd7e866d1d`.
No improvement in model generation speed is claimed.

## Archive and syntax audit

Both official packages contain 19,378 files. All entry contents were read with
ZIP CRC verification. No duplicate filenames, Windows case collisions or paths
escaping extraction were found. Acorn parsed **14,538 JS/CJS files** without
syntax errors. **46,027** static local import/export/import references resolved.
Across 313 CSS files, 67 local URL references resolved. This does not resolve
arbitrary dynamically computed paths or prove absence of all runtime bugs.

There are 8,373 same-named byte-identical files and four same-named changed files:
the host bundle, package metadata, VSIX manifest and webview index. Asset hashes
account for many renamed files. Coarse JS triage classified 3,538 exact matches,
10,959 normalized pairs, 40 changed candidates and one added/removed module
group. Coarse normalization and heuristic pairing are not semantic proofs.

## Repair and packaging checks

The durable repair covers revisions, cross-process ownership, dead-owner
recovery, retirement generations, explicit Undo, positive receipts, uncertain
submissions and canonical owner/follower state. Identical text with a new ID is
treated as a new message. Queue, Steer and Interrupt remain available.

The mandatory suite includes four writer processes appending 48 IDs and three
seeded two-client schedules totaling 180 add/read/remove cycles per runtime.
The prior wrong store filename is a negative control: changing
`queue-store.cjs` to `codex-queue-store.cjs` must fail the real require chain.

The completed repaired VSIX must preserve every original entry, change only
declared repair/metadata entries, retain the native executable checksum, and
load its actual packaged host storage through real relative imports in both
runtimes. Installation repeats startup and hash checks against the installed
directory and pins the VSIX against replacement by an automatic update.

See `REGRESSIONS.json` for the exact assertions and the test-results release
asset for runtime versions, TAP output, source hashes and the full-package audit.
Raw user queues, authentication, machine paths and personal settings are excluded.

## Regression lineage and requested upstream fix

Affected versions in the current report sequence are **26.928.31416,
26.928.40906, 26.930.21537, 26.930.31428 and 26.930.31730**. Evidence scope differs:
the first two are supported by user reports; personal reproductions and packaged
code inspection cover the later builds. This is not five identical complete
test runs. The earlier 26.917 rollback restored reliable submissions in previous
tests and used the earlier submission/persistence path.

Previous detailed report:
https://github.com/openai/codex/issues/49834#issuecomment-5965302072

The requested architectural correction is authoritative, revisioned queue
persistence and explicit reconciliation. A stale whole-extension snapshot must
not overwrite a newer queue mutation. An accepted/retired ID must not silently
become pending again. Unknown transport outcomes require a safe recovery state.
A successful void handler must emit a valid, documented response.

Please add deterministic regressions for these invariants, alongside real IDE
follow-up-after-completion coverage. Backend failures and unrelated UI state
problems still require their own investigation.
