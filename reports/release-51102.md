# Official 26.930.51102 inspection and repair 2.3

Reviewed 2026-10-05. The repair targets only the latest stable Windows x64
extension, 26.930.51102. No repaired package is built for 26.930.41038.

## Input verification

Latest official VSIX: 538,038,978 bytes; Marketplace SHA-256:
`e60c3c4f5519af19025b6e401399ff4e14057d1d4950dd39c981d2aa364b883a`.
The downloaded archive matches this checksum. Published 2026-10-04T21:55:29.957Z.

https://openai.gallerycdn.vsassets.io/extensions/openai/chatgpt/26.930.51102/1791149098401/Microsoft.VisualStudio.Services.VSIXPackage

Both new extensions retain the same Windows CLI 0.160.0 binary as 26.930.31730:
`fdda5fa3cf3fb3d000b876720742857676293e4315e4b045fae6f8bd7e866d1d`.

## Changes observed in actual shipped code

The coordinator integrates an app-server queue. It can reconcile accepted
server queue receipts, remove their server entries, and notify the conversation
when an unconfirmed submission has been discarded. It also handles server queue
replacement and disposal, and tracks automatic turn deferrals. Queue submission
status can transition from queued to pending before sending. These mechanisms
were already present in 31730; they are not newly introduced by 51102. They are
retained: the repair changes specific storage and dispatch points rather than
replacing the coordinator with an older implementation.

Token comparison of the unmodified 31730, 41038 and 51102 packages found the
coordinator, submission preparation function, queue adapter and extension-host
storage class identical after identifier normalization. All 68 coordinator
members match in both adjacent comparisons. This comparison preserves property
names and literals but ignores minified identifier names. It is structural
inspection evidence; it does not establish that every external dependency or
every other part of the extension is unchanged. The sanitized comparison JSON
is included with the test-results package.

The frontend adapter still reads queued follow-ups through the global-state
atom. The host still stores it in VS Code Memento. The coordinator still adopts
incoming storage snapshots and does not check accepted pending messages before
dispatch. Its mutation path still discards the canonical return value of the
storage update. The release-lock handler still returns undefined, while the
response bridge serializes its result without a null fallback.

## Defects reproduced in latest shipped code

1. **Lost local prompt:** enqueue one message with execution disabled, settle
   the writes, inject an empty storage snapshot, refresh. The actual official
   coordinator drops the entry and sends nothing. This models stale storage
   delivery; it does not execute VS Code's Memento implementation.
2. **Duplicate accepted prompt:** restore a pending message while the controlled
   acceptance lookup returns a positive receipt. The official coordinator
   sends it again. The patched coordinator retires it before lock acquisition
   and continues to dispatch another waiting message.
3. **Invalid response JSON:** the actual release-lock handler releases the
   lock and returns undefined. The actual frontend response parser rejects
   its serialized response. Null fallback fixes the parser contract without
   changing valid false, zero or nonempty responses. This parsing error alone
   is not proof that the underlying send lock remained held.

## Repair and validation scope

Repair 2.3 ports the existing revisioned journal, compare-and-set mutations,
canonical owner/follower confirmation, retired message generations, crashed
writer recovery, acceptance checks and claim verification to the hash-pinned
51102 bundles. Helper module filenames are checked from the finished archive.

An additional repeated run exposed a repair-side Windows race: a contender can
list an owner's UUID file while that owner is unlinking it. Opening that file
can then return EPERM (delete-pending) rather than ENOENT. Before this change,
the stress case failed with a conservative write-outcome-unknown response in
both runtimes, despite an earlier 91/91 run passing in both. The repair now
retries transient lstat, readdir and UUID-specific owner reads using the existing
bounded filesystem retry policy. It still preserves live/unverifiable owners
and fails closed on persistent denial. Three deterministic fault-injection
tests cover transient inspection, EPERM followed by absence, and persistent
denial without changing the journal. No committed write is replayed to retry
owner inspection.

The release gate requires **94 tests in Node and 94 in VS Code's Electron**,
with no skipped or cancelled cases. Its generated report records actual results;
original-bug controls pass when the expected original failure is reproduced.
Three added compatibility cases exercise server receipt removal, follower
ownership boundaries and replacement/disposal of server queue subscriptions.
Cloud history readiness and plugin pagination checks execute the new shipped
functions rather than copies of previous release functions.

These are headless filesystem, shipped-class and controlled-transport tests.
They do not establish live model delivery, absence of every possible defect,
or immunity to network failures. No screenshots, UI clicks or UI tests are run.

## User reports for both releases

Search on 2026-10-05 found no exact 26.930.51102 issue/comment matches. Absence
of reports is not evidence that its known defects are fixed.

For 26.930.41038, a user reports rapid queued follow-ups failing with
`Queued follow-up changed before dispatch`, reproduced three times in a
seven-message test. This report also mentions the earlier undefined-JSON warning:
https://github.com/openai/codex/issues/50914

Other reports discuss pending, disappearing and repeated prompts:
https://github.com/openai/codex/issues/50653
https://github.com/openai/codex/issues/50705

One commenter says 41038 appears improved and is still testing it; another
reports similar problems on macOS. These observations are mixed and are not
controlled proof of either universal failure or a complete fix.

A pending-spinner report lists both 31730 and 41038 installations but explicitly
does not establish the active version:
https://github.com/openai/codex/issues/50968

Dictation's HTTP 403 Cloudflare challenge is reported separately and is outside
this queue repair:
https://github.com/openai/codex/issues/50935

The 41038 archive had already downloaded before the user's request to download
only the latest arrived. It is retained as inspection evidence; no further 41038
download or repaired build is required.
