# Codex VS Code 26.930.61225 inspection and repair 2.4

Reviewed October 6, 2026. Target: openai.chatgpt 26.930.61225, Windows x64.

## Verified input and actual changes

The official VSIX is 538060406 bytes. Its SHA-256 matches Marketplace:
9f5b4b06fa38828029e647abcec95cb153f3ea24d4bfab0d58bd045529bba12f.
Marketplace publication time: 2026-10-06T01:22:26.653Z.

Bundled CLI changed from 0.160.0 to 0.160.1. The official fix preserves
SYSTEMROOT, TEMP and TMP when a Unix host launches remote stdio MCP servers on
Windows with explicit remote environment settings.
https://github.com/openai/codex/pull/51121

The extension host out/extension.js is byte-identical to 26.930.51102. The queue
coordinator, host storage class, storage adapter and submission-preparation
function match after identifier normalization. All 68 coordinator members match.
This comparison is inspection evidence, not a proof of equivalence of the entire
product.

The complete archive comparison found six JavaScript candidates after coarse
normalization: build-commit literals in two app-initial bundles, the CLI version
string in automation-dialog, analytics grouping of aeon_child as
agent_created_thread, and changed string identifiers in control-dialog and
placement. UI behavior of the latter modules was not tested. package.json changes
only its version.

## Reproduced original failures and repair verification

Controlled tests against extracted official code still reproduce an undelivered
message disappearing after an empty storage refresh, a restored pending message
being dispatched despite positive delivery evidence, and successful lock release
returning undefined that the actual response parser rejects as JSON.

The canonical suite passed 94/94 in Node and 94/94 in Electron. It includes
negative controls that pass when the original defect is reproduced, repair
regressions, compatibility tests and packaging checks. Passing this mixed suite
does not mean the official build is fixed.

Coverage includes two-window contention across 180 cycles and three seeds,
compare-and-set retries, stale snapshots, message retirement and Undo generations,
same text under distinct IDs, interrupt and resume cases, four writers, dead PID
recovery, process death during lock preparation, delayed lock removers, Windows
owner-metadata read retries, canonical owner/follower state, server queue receipts,
cloud history completion and plugin pagination.

The real CLI 0.160.1 app-server passed 16 protocol checks against a local synthetic
Responses provider and an isolated home. They cover queue CRUD, identity,
ordering, pagination, process restart persistence and thread resume. No production
account or model calls were involved.

An independent review of VitalOverdose's public 26.930.21537 patch passed 19
checks in Node and 19 in Electron, including tests reproducing four limitations.
These are independent tests, not a rerun of the author's unavailable 25 tests.
Durable exact-ID receipts work, but the original Memento queue remains vulnerable
to stale empty snapshots and competing whole-state writers. Historical accepted
pending entries without the omitted private seed remain eligible, and receipt
persistence failure can leave the send lock held.
https://github.com/openai/codex/issues/50404#issuecomment-6006050062

Total: 242 successful check executions (188 + 16 + 38), not 242 distinct tests.

An initial review run failed two packaging fixtures because they selected file
names from the previous release. The fixture now reads the input package version
and selects its matching profile. The complete subsequent run passed. The
deliberately wrong queue-store filename remains a negative startup control.

The built package preserves all 19378 original entries, with six declared
modifications and six additions, for 19384 entries. There are no missing or
unexpected files. Native CLI and all unrelated entries are hash-verified. Both
the completed VSIX and the installed host passed isolated Node/Electron startup
and journal read/write checks. Activation after restart was confirmed locally;
the initial live log sample contained no send-lock, undefined-JSON or journal
errors. This is a startup sample, not comprehensive live UI certification.

## Scope and limitations

The repair is a port of the existing revisioned journal/CAS implementation to
the new hash-pinned release. It does not change model inference speed and does
not provide exactly-once external side effects across an uncertain network
outcome. Retired IDs are not a complete independent delivery ledger.

New reports include WSL sidebar flicker explicitly on 61225, missing approval
controls, Remote SSH app-server socket/lifecycle issues, Desktop command dispatch
stalls, and native crashes on an older AMD processor. These environments and UI
paths were not reproduced by the local Windows headless queue suite; this patch
does not claim to fix them.
https://github.com/openai/codex/issues/50783#issuecomment-6010044326
https://github.com/openai/codex/issues/51278
https://github.com/openai/codex/issues/51345
https://github.com/openai/codex/issues/50725#issuecomment-6011061867
https://github.com/openai/codex/issues/51354

Repair author: IveSan83 (Eugene Bondarenko).
https://github.com/IveSan83/codex-vscode-queue-repair
