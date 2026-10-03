# Verification scope for repair 2.1

Repair author: **IveSan83 (Eugene Bondarenko)**.

Repository: https://github.com/IveSan83/codex-vscode-queue-repair

Base: official **26.930.31428 win32-x64**, SHA-256
`7a5b1484c0f994ef12f96865568abc6648862082edb433fafd4321d4a7cb5fea`.
Native runtime: unchanged **codex-cli 0.160.0**.

## Required automated checks

The release registry requires **76 tests** in each of two runtimes: standalone
Node and the Node runtime embedded in the installed VS Code Electron executable.
The release cannot build or install unless both sets pass with no skipped,
cancelled or missing tests and the current source/fixture fingerprint matches.

Assertions include:

- original undefined-response failure and null normalization;
- extracted original coordinator behavior and positive delivery reconciliation;
- queued, sending, paused and outcome-unknown transitions;
- concurrent processes, revision conflicts and durable retired message IDs;
- dead-owner recovery, live/invalid owners and delayed cleanup;
- restart, explicit Undo, new IDs carrying identical text and stale generations;
- foreground priority, coalesced reads and uncertain RPC results;
- packaged dependency resolution with Node's real CommonJS loader, including a
  negative control for the earlier wrong store filename.

## Two-window stress check

`tests/two-window-stress.test.cjs` adapts a separate stress scenario into the
required suite. It creates two storage/client instances on one journal. One
continuously changes another thread while the other adds and removes messages;
RPC delays, refresh timers and filesystem notifications create overlap.

Three deterministic seeds run 60 add/remove cycles each: **180 cycles** per
runtime. Every addition is checked through the originating client, persisted
journal and second client. Every removal must remain absent during competing
writes. Final state, 60 retired IDs per seed and paused legacy migration are
also checked. A successful result requires **0 lost, 0 resurrected and 0 incorrect
reads**, with competing writes actually occurring and no background errors.

An isolated run on 2026-10-03 passed all 180 cycles with respectively 212, 255
and 266 competing writes. Timing-dependent write counts vary between runs;
the assertions and seeds remain fixed. This measures journal/client behavior,
not actual model sends or 180 live editor conversations.

## Package audit

The build audits all **19,378** original archive entries. It permits changes to
three JavaScript bundles, package metadata, the VSIX display name and content
type declaration. It adds only the two helper modules, three original bundle
backups and the repair manifest. **19,372** original entries must remain byte
identical. No original file may disappear and the native executable must keep
its pinned SHA-256.

The finished VSIX is extracted into a fresh temporary directory. Its actual
host storage class is loaded through real relative imports and performs journal
add/read/remove operations in a separate temporary profile in both runtimes.
The installer repeats this check before installation and against the installed
directory afterward. Unrelated Memento helpers and VS Code's event emitter are
doubles; the editor is not activated.

## Publication check

The release kit is checked again after extraction without a Git directory,
using its portable setup command. The publication assets contain only repair
source, scripts, documentation, dependency lockfile and tests. Official VSIX
archives, runtime executables, extracted bundles, user queues, raw local logs
and machine-specific build reports are excluded.

## Limits

Automated transport is a controlled double. No live UI automation or model
request is part of these gates. A user still checks sequential and queued
messages, Steer, Stop, identical-text retry with a new ID, Undo, two windows and
reload after installation. Headless package checks establish storage startup,
not full editor activation or every composer/rendering state.

The repair does not guarantee exactly-once external actions. A delivery with an
unknown outcome stays paused for review; absence from partial history alone is
not permission to resend. It does not fix unrelated network, backend or stream
failures and does not establish faster model generation.
