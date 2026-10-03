# Official release comparison: 26.930.21537 → 26.930.31428

The new package contains a newer native runtime and changes outside the VS Code
message queue. The frontend queue implementation and Memento storage path remain
unchanged in the inspected queue-specific comparisons. A new native release does
not establish a repair of the extension's queued-message race.

## Verified package changes

| Item | 26.930.21537 | 26.930.31428 |
| --- | --- | --- |
| VSIX entries | 19,382 | 19,378 |
| VSIX size | 536,384,607 bytes | 538,037,224 bytes |
| `codex-package.json`, Windows and Linux | `0.159.0-alpha.12.1` | `0.160.0` |
| Extracted Windows `codex.exe --version` | `codex-cli 0.159.0-alpha.12.1` | `codex-cli 0.160.0` |
| Windows `codex.exe` size | 324,622,128 bytes | 326,872,368 bytes |

Only `/version` changes in the extension's `package.json`; commands, settings,
activation events and required VS Code version are unchanged there. The VSIX
manifest likewise changes the extension version. The native binaries are
different files, independently verified by SHA-256 and `--version`.

The old local test fixture's extension host, four initial bundles and Windows
native executable match the official old VSIX byte for byte. Its `package.json`
differs only by the installation `__metadata` added by VS Code; the remaining
package data is equal. This fixture check is recorded separately in
`artifacts/old-fixture-match.json`.

Archive SHA-256:

- Old: `9eacd2fa590119245ae0a71eddf9f8f5310d070343a5586801fae99f62086251`
- New: `7a5b1484c0f994ef12f96865568abc6648862082edb433fafd4321d4a7cb5fea`

Windows native SHA-256:

- Old: `c057fc84bb0d76fc6710e3c82b88ae47464239bd41db89b9b84cc6bbac3265bb`
- New: `fdda5fa3cf3fb3d000b876720742857676293e4315e4b045fae6f8bd7e866d1d`

## Concrete JavaScript changes found by inspection

- **Code Review links:** the hidden `githubLinkTarget` default changes from
  `code-review-tab` to `github`. Its enum is narrowed to those two values, dropping
  `in-app-browser` and `external-browser`. The link interception bridge changes
  alongside that setting. The host's remaining token differences after this
  setting substitution were identifier renames in the inspected comparison.
- **GitHub setup and connection recovery:** a separate repository-installation
  check is introduced at `/aip/connectors/github/has_installations`. The setup
  flow handles account reauthentication, pending browser setup, cancellation,
  stale setup attempts and callback state tied to a fresh UUID. The Code Review
  onboarding UI gains browser-pending and cancel-setup states.
- **Connector reauthentication:** the connection sheet now carries authentication
  reasons, required scopes and a specific link ID; asynchronous completion checks
  whether cancellation or a replacement request made the result stale.
- **Pages realtime:** the native `pagesRealtime.connect` socket wrapper in the
  document state module is replaced by a direct `WebSocket`. A new endpoint
  validator restricts permitted gateway/broker destinations; local development
  endpoints require an explicit flag. This is document collaboration code, not
  the Codex chat follow-up queue.
- **Bundle placement:** cloud-environment language definitions and API-query
  helpers, plus shared request/state helpers, move into initial bundles. Their
  standalone chunks disappear. Additional language/API strings in an initial
  bundle therefore do not establish new language support.

This is inspection of packaged JavaScript, not a reconstruction of the original
source or a claim that every remaining changed candidate has been fully audited.

## Upstream native changes and their scope

The official `0.160.0` notes announce several runtime changes useful to keep in
the next local repair:

- SQLite connection/logging stalls and initialization errors:
  https://github.com/openai/codex/pull/49032 and
  https://github.com/openai/codex/pull/49102
- Incremental app-server tracking of running turns:
  https://github.com/openai/codex/pull/49084
- Parsed plugin manifest caching and HTTP connection reuse:
  https://github.com/openai/codex/pull/49099 and
  https://github.com/openai/codex/pull/49100
- Windows PowerShell fallback, long-path ACL repair and background console fixes:
  https://github.com/openai/codex/pull/49019,
  https://github.com/openai/codex/pull/49058,
  https://github.com/openai/codex/pull/49098,
  https://github.com/openai/codex/pull/49164 and
  https://github.com/openai/codex/pull/49386
- Subagent environment startup handling:
  https://github.com/openai/codex/pull/49075

The queued-input reconnect repair
https://github.com/openai/codex/pull/49105 changes only `codex-rs/tui/` files.
It reconciles exact client message IDs, resumes messages never sent and preserves
uncertain submissions without replaying them. It addresses the terminal client;
it does not change VS Code's Memento queue or webview coordinator.

Official release notes:
https://github.com/openai/codex/releases/tag/rust-v0.160.0

The exact old-alpha/new-stable tag comparison is **diverged**, with 59 commits
ahead and 2 behind:
https://github.com/openai/codex/compare/rust-v0.159.0-alpha.12.1...rust-v0.160.0

The release notes' comparison against stable `0.159.0` must not be described as
the exact delta from the packaged `0.159.0-alpha.12.1` runtime. Runtime improvements
are upstream claims and inspected source changes; no model response-time
improvement was measured here.

## Method and reproducibility

`tools/compare-release.py` hashes every archive entry, compares package metadata,
runs extracted binaries with `--version` only, and tokenizes changed JavaScript
with Acorn. It masks asset hash suffixes and ordinary minified identifiers while
retaining literals and property accesses. The output reports:

- 8,308 same-named files with identical SHA-256;
- 68 same-named files with different contents;
- 3,537 exactly identical same-named JavaScript files;
- 10,925 further JavaScript pairs identical under coarse normalization;
- 76 changed JavaScript candidates and 4 unpaired removed JavaScript chunks.

Equal coarse fingerprints are **not a formal proof of semantic equivalence**.
Variants sharing a basename are paired by fingerprint first and then by size.
Native binary content hashes do not reveal their complete behavioral differences.

Run from the task worktree after installing its development dependencies:

```powershell
python tools/compare-release.py --old OLD-OFFICIAL.vsix --new NEW-OFFICIAL.vsix
```

The machine-readable evidence is `artifacts/release-diff.json`; separately
retrieved official GitHub release/PR metadata is in
`artifacts/native-release-notes.json`. No extension host, GUI test or model request
was run for this comparison. No package was installed or production file changed.
