# Codex VS Code queue repair

An independent repair for disappearing, restored and stalled follow-up messages
in **openai.chatgpt 26.930.31730 on Windows x64**.

**Repair author: IveSan83 (Eugene Bondarenko)**

Repository: https://github.com/IveSan83/codex-vscode-queue-repair

Download: https://github.com/IveSan83/codex-vscode-queue-repair/releases/latest

The download contains this project's repair code, tests and installer. The
installer downloads the pinned original extension from its official distribution
URL, verifies its SHA-256, and builds the repaired VSIX on your computer. OpenAI's
extension bundles, personal settings, queue contents and credentials are not
included in the public source or release ZIP.

## Install

Requirements: Windows x64, the stable VS Code installation with `code` available
in PATH, Node.js 22 or newer with npm, Python 3.11 or newer, internet access and
approximately 3 GB of free disk space. Git is optional. A custom VS Code location
can be specified through `CODEX_QUEUE_VERIFY_CODE_EXE`.

1. Download `codex-vscode-queue-repair-2.2.0.zip` from the release page and extract
   it into a new folder.
2. Close all VS Code windows so that old extension hosts stop.
3. Double-click **START.cmd**. It downloads the official extension, checks it,
   runs the registered tests in Node and VS Code's Electron runtime, builds and
   checks the finished VSIX, and installs it. The Electron checks run as Node
   processes without opening the editor.
4. Open VS Code. The extension appears as **Codex (local queue repair 2.2)**.
   Check normal messages, follow-ups, Stop, Steer and two-window use.

For a terminal installation from the extracted folder:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1
```

To perform the same download, build and package checks without installing:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\setup.ps1 -VerifyOnly
```

The installer uses your existing Codex authentication. It does not request API
keys, change MCP configuration or copy this project's developer settings. Before
installation it saves an existing repair journal into the local, ignored
`artifacts` folder. That private backup contains your messages; do not upload it.
The locally installed VSIX is pinned because an automatic extension update would
replace the repair.

If a build was interrupted before its report was written, extract the release
into a new folder and rerun it. Existing complete builds are verified before
reuse. Read `artifacts/setup.log` if installation reports an error.

## What changes

- Queued follow-ups use a separate atomic JSON journal with revisions and a
  cross-process owner lock. Queue reads no longer depend on a whole-extension
  Memento snapshot that can contain older state.
- Concurrent writers check the current revision before saving. Retired message
  IDs survive restarts so that stale snapshots cannot restore removed messages.
  Explicit Undo creates a new generation.
- A confirmed dead lock owner is recovered automatically. Live, reused or
  unverifiable PIDs are not removed based on elapsed time.
- Positive delivery receipts are checked by message ID before and after the
  send lock. Unknown delivery remains paused for review rather than being
  automatically retried. Identical text with a new ID is a separate message.
- A pending-to-sending transition must actually update the expected pending
  entry. A competing writer's sending state cannot be adopted after a no-op
  revision retry.
- Followers receive canonical local state from the owner, including after a
  missed broadcast. Reads coalesce and polling cannot accumulate behind writes.
- Successful void bridge responses serialize as JSON null, preventing the
  separate `"undefined" is not valid JSON` error.

Queue, Steer and Interrupt remain available. The official native
**codex-cli 0.160.0** executable and all unrelated archive entries are preserved
and verified by SHA-256. No increase in model generation speed is claimed.

The persistence repair addresses a different failure than only normalizing the
JSON response or disabling follow-ups. Receipt checks and the persistence journal
are both needed to cover the tested stale-state and replay scenarios.

## Verification and packaging

`REGRESSIONS.json` records every required test and its assertion. Packaging and
installation require all registered tests to pass in both Node and VS Code's
Electron/Node runtime. The gate binds results to source, dependencies, test
fixtures and TAP log hashes; changed inputs invalidate it.

The suite covers the extracted official queue coordinator, storage protocol,
separate writer processes, dead-owner recovery, uncertain RPC outcomes, identical
text with different IDs, Undo, restart and 180 two-window add/remove cycles with
competing writes. See `reports/verification.md` for the checked scope.

Repair 2 originally packaged its store under a different filename from the
protocol's import. Repair 2.1 uses **out/queue-store.cjs** consistently. A regression
test requires the old mismatch to fail. The builder and installer now exercise
the actual module dependency chain from a fresh extraction of the completed
VSIX in both runtimes; this checks the shipped storage component without
activating VS Code or contacting a model.

The builder checks every archive entry: no official file may disappear, only
the declared repair files may be added or changed, and the native executable
must remain identical. Original copies of the three modified bundles and a
hash manifest are included in the locally built VSIX.

Local reports: `artifacts/verify-report.json`, `artifacts/verify-node.txt`,
`artifacts/verify-electron.txt`, `artifacts/build-report.json` and, after installing,
`artifacts/install-report.json`. These are generated on your computer and are
excluded from publication.

## Saved messages and recovery

The stable VS Code profile journal is under
`%APPDATA%\Code\User\globalStorage\openai.chatgpt\queue-repair-v1`.

The first import from legacy Memento storage is paused for review. Existing
uncertain or interrupted sends remain paused. Do not delete `queue.json` to fix
a lock or upload it with a bug report.

`writer.lock` is a permanent directory that blocks incompatible old repair
writers. The active owner is `writer.lock\active\owner-UUID.json`; the permanent
directory alone does not indicate a stuck writer. Close all old windows before
installation. A pre-existing lock **file** from the earlier repair requires a
stopped-host migration; the installer reports this condition instead of deleting
potentially active ownership.

For rollback, close all VS Code windows and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\rollback.ps1
```

This requests official `openai.chatgpt@26.917.62051` from the Marketplace, retains
the repair journal and requires opening VS Code again. Older releases may lack
newer models and features. The official extension does not read the repair
journal; returning to this repair preserves it.

## Scope and limitations

Only **26.930.31730 win32-x64** is supported by this package. Different official
archive or bundle hashes are rejected until a release profile and patch anchors
are reviewed. User reports also describe the regression in 26.928.31416,
26.928.40906, 26.930.21537 and 26.930.31428; this download does not patch those packages.

Transport callbacks in the automated coordinator tests are controlled doubles.
These tests do not guarantee exactly-once external actions, resolve network or
server failures, or replace a live UI check. An unresolved delivery is preserved
for review. Retired IDs are retained and the journal grows over time. A hung
host RPC can require reloading the window.

The new comparison is in `reports/release-31730.md`; the previous comparison
is retained in `reports/release-diff.md`. The 31730 package retains the affected
queue components and the same native runtime. Repair 2.2 ports the hash-pinned
repair to this package and requires 88 tests in each runtime (176 executions).
Download the sanitized test-results ZIP from the release for TAP logs, the
verification summary, package audit and source hashes.

## Build manually

```powershell
npm ci --ignore-scripts
python build.py --prepare
node tools/verify.cjs --runtime all
python build.py
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
```

`python build.py --official PATH --prepare` can use another verified copy of the
same pinned official archive. No repair is applied to an unrecognized version.

MIT license applies to this project's independently written repair, tools and
tests. See `LICENSE` and `NOTICE.md` for scope. This is an independent project.

Investigation:

- https://github.com/openai/codex/issues/49834
- https://github.com/openai/codex/issues/49834#issuecomment-5956717563
- https://github.com/openai/codex/issues/49834#issuecomment-5951419759
- https://github.com/openai/codex/issues/49834#issuecomment-5962820792
- https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/api/common/extHostMemento.ts
- https://github.com/openai/codex/releases/tag/rust-v0.160.0
