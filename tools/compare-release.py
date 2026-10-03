#!/usr/bin/env python3
"""Compare official VSIX archives without installing or launching an extension host.

Inventory equality is based on SHA-256. JS fingerprints below are a deliberately
coarse triage tool: they retain tokens, literals and property access names, but
mask ordinary minified identifiers and content hashes in asset references.
Equal fingerprints are not a formal proof of semantic equivalence.
"""
from __future__ import annotations

import argparse
import collections
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import tempfile
import zipfile


ASSET_HASH = re.compile(r"-(?:[0-9a-f]{12}|[0-9a-f]{16})(?=\.(?:js|css|map|png|svg|jpg|jpeg|webp|gif|woff2?|ttf|mp3|mp4))")

JS_NORMALIZER = r"""
'use strict';
const fs = require('node:fs');
const readline = require('node:readline');
const crypto = require('node:crypto');
const acorn = require(process.argv[2]);
const hash = x => crypto.createHash('sha256').update(x).digest('hex');
const asset = x => x.replace(/-(?:[0-9a-f]{12}|[0-9a-f]{16})(?=\.(?:js|css|map|png|svg|jpg|jpeg|webp|gif|woff2?|ttf|mp3|mp4))/g,'-HASH');
const globals = new Set(['undefined','NaN','Infinity','globalThis','window','document','navigator','location','self','console','process','require','module','exports','JSON','Object','Array','String','Number','Boolean','Promise','Symbol','Map','Set','WeakMap','WeakSet','Error','TypeError','SyntaxError','ReferenceError','RangeError','Date','Math','RegExp','Reflect','Proxy','BigInt','Buffer','URL','URLSearchParams','AbortController','AbortSignal','TextEncoder','TextDecoder','ReadableStream','WritableStream','TransformStream','Response','Request','Headers','crypto','fetch','setTimeout','clearTimeout','setInterval','clearInterval','queueMicrotask','performance','WebSocket','Worker','indexedDB','localStorage','sessionStorage','Intl','Uint8Array','ArrayBuffer']);
function normalize(code) {
  const all = [];
  const literalCounts = new Map();
  for(const token of acorn.tokenizer(code,{ecmaVersion:'latest',sourceType:'module',allowReturnOutsideFunction:true})) all.push(token);
  const normalized = [];
  for(let i=0;i<all.length;i++) {
    const t=all[i], label=t.type.label, before=all[i-1]?.type.label;
    let value=t.value;
    if(label==='name') {
      // Property access names are runtime API names, not local bindings.
      value=before==='.'||before==='?.'||globals.has(value)?value:'$ID';
    } else if(label==='privateId') value='$PRIVATE';
    else if(label==='string'||label==='template') {
      value=asset(String(value));
      if(value.length>500) value='$LONG:'+value.length+':'+hash(value);
      literalCounts.set(value,(literalCounts.get(value)||0)+1);
    } else if(value && typeof value==='object') value=JSON.stringify(value);
    normalized.push(label+':'+String(value??''));
  }
  return {coarseTokenSha256:hash(normalized.join('\n')),tokenCount:all.length,literals:[...literalCounts]};
}
const rl=readline.createInterface({input:process.stdin,crlfDelay:Infinity});
rl.on('line',line=>{
  if(!line)return;
  const record=JSON.parse(line);
  try { process.stdout.write(JSON.stringify({id:record.id,...normalize(record.code)})+'\n'); }
  catch(e){ process.stdout.write(JSON.stringify({id:record.id,error:e.message})+'\n'); }
});
"""


def sha_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def inventory(archive: zipfile.ZipFile) -> dict:
    result = {}
    for info in archive.infolist():
        if info.is_dir():
            continue
        digest = hashlib.sha256()
        with archive.open(info) as stream:
            for block in iter(lambda: stream.read(4 * 1024 * 1024), b""):
                digest.update(block)
        result[info.filename] = {"size": info.file_size, "sha256": digest.hexdigest()}
    return result


def object_diff(old, new, path="") -> list:
    if old == new:
        return []
    if isinstance(old, dict) and isinstance(new, dict):
        result = []
        for key in sorted(old.keys() | new.keys()):
            result.extend(object_diff(old.get(key), new.get(key), f"{path}/{key}"))
        return result
    return [{"path": path or "/", "old": old, "new": new}]


def js_fingerprints(archives: dict, names: dict, output: Path, acorn: str) -> dict:
    script = output / "release-token-normalizer.cjs"
    script.write_text(JS_NORMALIZER, encoding="utf-8")
    records = []
    for side, archive in archives.items():
        for name in names[side]:
            records.append(json.dumps({"id": f"{side}:{name}", "code": archive.read(name).decode("utf-8")}, ensure_ascii=True))
    proc = subprocess.run(["node", str(script), acorn], input="\n".join(records), text=True,
                          encoding="utf-8", capture_output=True, check=True)
    # JSON.stringify leaves U+2028/U+2029 intact; splitlines() would break those
    # legal JSON string contents. The protocol delimiter is ASCII LF only.
    (output / "release-js-fingerprints.jsonl").write_text(proc.stdout, encoding="utf-8")
    return {record["id"]: record for record in map(json.loads, filter(None, proc.stdout.split("\n")))}


def descriptor(side: str, name: str, inv: dict, token: dict) -> dict:
    return {"path": name, **inv[side][name], **{k: v for k, v in token[f"{side}:{name}"].items() if k != "id"}}


def compare_js(archives: dict, inv: dict, output: Path, acorn: str) -> dict:
    groups = {side: collections.defaultdict(list) for side in archives}
    exact = []
    common = inv["old"].keys() & inv["new"].keys()
    for name in sorted(common):
        if name.endswith(".js") and inv["old"][name]["sha256"] == inv["new"][name]["sha256"]:
            exact.append(name)
    exact_set = set(exact)
    names = {}
    for side in archives:
        names[side] = [name for name in inv[side] if name.endswith(".js") and name not in exact_set]
        for name in names[side]:
            groups[side][ASSET_HASH.sub("-HASH", name)].append(name)
    token = js_fingerprints(archives, names, output, acorn)
    unchanged, changed, added, removed = [], [], [], []
    for key in sorted(groups["old"].keys() | groups["new"].keys()):
        left, right = list(groups["old"][key]), list(groups["new"][key])
        # A logical basename may contain several chunks; match equal fingerprints first.
        for old_name in list(left):
            old_token = token[f"old:{old_name}"]
            new_name = next((n for n in right if "error" not in old_token and
                             token[f"new:{n}"].get("coarseTokenSha256") == old_token.get("coarseTokenSha256")), None)
            if new_name:
                unchanged.append({"logicalPath": key, "old": old_name, "new": new_name,
                                  "coarseTokenSha256": old_token["coarseTokenSha256"]})
                left.remove(old_name)
                right.remove(new_name)
        # Remaining size-nearest pairs are candidates for manual inspection, not asserted identity.
        while left and right:
            old_name, new_name = min(((a, b) for a in left for b in right),
                                    key=lambda pair: abs(math.log((inv["old"][pair[0]]["size"] + 1) /
                                                                 (inv["new"][pair[1]]["size"] + 1))))
            a, b = descriptor("old", old_name, inv, token), descriptor("new", new_name, inv, token)
            ca, cb = collections.Counter(dict(a.pop("literals", []))), collections.Counter(dict(b.pop("literals", [])))
            changed.append({"logicalPath": key, "pairing": "closest size within logical basename",
                            "old": a, "new": b,
                            "addedLiterals": dict(cb - ca), "removedLiterals": dict(ca - cb)})
            left.remove(old_name)
            right.remove(new_name)
        removed.extend(left)
        added.extend(right)
    return {"method": "Acorn tokens; ordinary identifiers/private names masked, property accesses/globals/literals retained; asset hex suffixes masked; comments ignored",
            "warning": "Equal coarse fingerprints are not formal semantic equivalence. Chunk pairing is heuristic where several variants share a basename.",
            "exactSameNamedFiles": exact, "unchangedUnderCoarseNormalization": unchanged,
            "changedCandidates": changed, "addedUnpaired": added, "removedUnpaired": removed}


def native_probe(archive: zipfile.ZipFile, side: str, output: Path) -> dict:
    # This is --version only: no app-server/extension host, account access or model request.
    with tempfile.TemporaryDirectory(prefix=f"codex-release-{side}-") as tmp:
        exe = Path(tmp) / "codex.exe"
        exe.write_bytes(archive.read("extension/bin/windows-x86_64/codex.exe"))
        proc = subprocess.run([str(exe), "--version"], capture_output=True, text=True,
                              encoding="utf-8", timeout=20)
        return {"arguments": ["--version"], "exitCode": proc.returncode,
                "stdout": proc.stdout.strip(), "stderr": proc.stderr.strip()}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--old", type=Path, required=True, help="Official old win32-x64 VSIX")
    parser.add_argument("--new", type=Path, required=True, help="Official new win32-x64 VSIX")
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "artifacts")
    parser.add_argument("--acorn", default="acorn")
    parser.add_argument("--skip-version-probe", action="store_true")
    parser.add_argument("--native-notes", type=Path, help="Previously fetched official release/PR/tag-comparison JSON; this tool does not fetch it")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    archives = {"old": zipfile.ZipFile(args.old), "new": zipfile.ZipFile(args.new)}
    print("Hashing official archive contents...", flush=True)
    inv = {side: inventory(archive) for side, archive in archives.items()}
    common = inv["old"].keys() & inv["new"].keys()
    same = sorted(n for n in common if inv["old"][n]["sha256"] == inv["new"][n]["sha256"])
    changed = sorted(common - set(same))
    report = {
        "scope": "Official packaged files, manifests, native version probes and coarse JS token triage; not recovered original source and not a native binary semantic diff.",
        "archives": {side: {"path": str(path), "size": path.stat().st_size, "sha256": sha_file(path),
                             "entries": len(inv[side])} for side, path in [("old", args.old), ("new", args.new)]},
        "inventory": {"sameNamedIdenticalCount": len(same), "sameNamedChanged": [{"path": n, "old": inv["old"][n], "new": inv["new"][n]} for n in changed],
                      "oldOnlyNames": sorted(inv["old"].keys() - inv["new"].keys()),
                      "newOnlyNames": sorted(inv["new"].keys() - inv["old"].keys())},
        "packageJsonChanges": object_diff(json.loads(archives["old"].read("extension/package.json")), json.loads(archives["new"].read("extension/package.json"))),
        "native": {"packages": {target: {side: json.loads(archive.read(f"extension/bin/{target}/codex-package.json")) for side, archive in archives.items()} for target in ["windows-x86_64", "linux-x86_64"]},
                   "windowsCodex": {side: inv[side]["extension/bin/windows-x86_64/codex.exe"] for side in archives}}
    }
    if not args.skip_version_probe:
        report["native"]["versionProbes"] = {side: native_probe(archive, side, args.output) for side, archive in archives.items()}
    print("Normalizing changed JS modules...", flush=True)
    report["javascript"] = compare_js(archives, inv, args.output, args.acorn)
    notes_path = args.native_notes or args.output / "native-release-notes.json"
    if notes_path.exists():
        notes = json.loads(notes_path.read_text(encoding="utf-8"))
        pr = notes.get("queueReconnectPR", {})
        paths = [entry["path"] for entry in pr.get("files", [])]
        comparison = notes.get("tagComparison", {})
        report["externalSources"] = {
            "scope": "Official release notes and PR metadata, separately fetched; they do not establish a VS Code frontend queue fix",
            "artifact": str(notes_path),
            "releases": [{"url": notes[tag]["url"], "tagName": tag, "publishedAt": notes[tag]["publishedAt"]}
                         for tag in ["rust-v0.159.0-alpha.12.1", "rust-v0.160.0"] if tag in notes],
            "queueReconnectPR": {"url": pr.get("url"), "title": pr.get("title"), "changedPaths": paths,
                                 "onlyTuiPaths": bool(paths) and all(path.startswith("codex-rs/tui/") for path in paths)},
            "tagComparison": {key: comparison.get(key) for key in ["url", "status", "aheadBy", "behindBy", "totalCommits"]},
        }
    path = args.output / "release-diff.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    js = report["javascript"]
    print(json.dumps({"written": str(path), "sameNamedIdentical": len(same), "sameNamedChanged": len(changed),
                      "jsExactIdentical": len(js["exactSameNamedFiles"]), "jsCoarseIdentical": len(js["unchangedUnderCoarseNormalization"]),
                      "jsChangedCandidates": len(js["changedCandidates"]), "jsAddedUnpaired": len(js["addedUnpaired"]),
                      "jsRemovedUnpaired": len(js["removedUnpaired"])}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
