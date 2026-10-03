"""Prepare verified fixtures or build a gated repair from an official VSIX."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import urllib.request
import os
import zipfile

ROOT = Path(__file__).resolve().parent
VERSION = '26.930.31730'
PATCH_VERSION = '2.2'
OFFICIAL = ROOT / 'artifacts' / ('official-' + VERSION + '-win32-x64.vsix')
NATIVE = 'extension/bin/windows-x86_64/codex.exe'
NATIVE_SHA = 'fdda5fa3cf3fb3d000b876720742857676293e4315e4b045fae6f8bd7e866d1d'

def sha_file(file):
    with file.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def sha_entry(archive, name):
    with archive.open(name) as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def metadata(file):
    return {'path': str(file), 'bytes': file.stat().st_size, 'sha256': sha_file(file)}

def download_official():
    profile = json.loads((ROOT / 'releases.json').read_text(encoding='utf-8'))[VERSION]
    if OFFICIAL.exists():
        if sha_file(OFFICIAL) != profile['vsixSha256']:
            raise RuntimeError('Cached official archive checksum mismatch')
        return
    descriptor, temporary_name = tempfile.mkstemp(prefix='official-download-', suffix='.vsix', dir=OFFICIAL.parent)
    temporary = Path(temporary_name)
    print('Downloading the pinned official Windows x64 VSIX...', flush=True)
    request = urllib.request.Request(profile['downloadUrl'], headers={'User-Agent': 'codex-vscode-queue-repair/2.2', 'Accept-Encoding': 'identity'})
    try:
        with os.fdopen(descriptor, 'wb') as output, urllib.request.urlopen(request, timeout=60) as response:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        if sha_file(temporary) != profile['vsixSha256']:
            raise RuntimeError('Downloaded archive checksum mismatch')
        os.replace(temporary, OFFICIAL)
    finally:
        temporary.unlink(missing_ok=True)

def verified_official(file):
    profile = json.loads((ROOT / 'releases.json').read_text(encoding='utf-8'))[VERSION]
    if sha_file(file) != profile['vsixSha256']:
        raise RuntimeError('Unrecognized official VSIX checksum')
    archive = zipfile.ZipFile(file)
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise RuntimeError('Duplicate official VSIX entries')
    pkg = json.loads(archive.read('extension/package.json'))
    if (pkg['publisher'], pkg['name'], pkg['version']) != ('openai', 'chatgpt', VERSION):
        raise RuntimeError('Unexpected official package identity')
    for key, relative in {**profile['files'], **profile.get('testFiles', {})}.items():
        if sha_entry(archive, 'extension/' + relative) != (profile['hashes'].get(key) or profile.get('testHashes', {}).get(key)):
            raise RuntimeError('Unexpected official bundle: ' + relative)
    if sha_entry(archive, NATIVE) != NATIVE_SHA:
        raise RuntimeError('Unexpected official native runtime')
    return archive, profile

def prepare(archive, profile):
    fixture = ROOT / 'artifacts/base/extension'
    for relative in [*profile['files'].values(), *profile.get('testFiles', {}).values(), 'package.json']:
        target = fixture / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.read('extension/' + relative))
    print('Prepared original test fixtures: ' + str(fixture), flush=True)

def verify_archive(archive, manifest):
    bad = archive.testzip()
    if bad:
        raise RuntimeError('Invalid VSIX entry: ' + bad)
    names = archive.namelist()
    if len(names) != len(set(names)):
        raise RuntimeError('Duplicate repaired VSIX entries')
    for relative, hashes in manifest['files'].items():
        if sha_entry(archive, 'extension/' + relative) != hashes['patched']:
            raise RuntimeError('Packaged patch hash mismatch: ' + relative)
    for relative, expected in manifest['helpers'].items():
        if sha_entry(archive, 'extension/' + relative) != expected:
            raise RuntimeError('Packaged helper hash mismatch: ' + relative)
    if sha_entry(archive, NATIVE) != NATIVE_SHA:
        raise RuntimeError('Repair changed the official native runtime')

def smoke_vsix(file):
    """Load the real module chain from fresh archive contents, never source aliases."""
    temporary_root = Path(tempfile.gettempdir()).resolve()
    temporary = Path(tempfile.mkdtemp(prefix='codex-vsix-startup-', dir=temporary_root))
    try:
        with zipfile.ZipFile(file) as archive:
            for name in archive.namelist():
                if not (name.startswith('extension/out/') or name in ('extension/package.json', 'extension/queue-repair-manifest.json')):
                    continue
                if name.endswith('/'):
                    continue
                target = (temporary / name).resolve()
                if not target.is_relative_to(temporary.resolve()):
                    raise RuntimeError('Unsafe archive entry: ' + name)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.read(name))
        execution = subprocess.run(
            ['node', str(ROOT / 'tools/package-smoke.cjs'), '--all', str(temporary / 'extension')],
            check=True, cwd=ROOT, capture_output=True, text=True, encoding='utf-8',
        )
        result = json.loads(execution.stdout)
        result.pop('extensionDirectory', None)
        result['vsixSha256'] = sha_file(file)
        return result
    except subprocess.CalledProcessError as error:
        raise RuntimeError('Packaged host startup failed: ' + error.stderr) from error
    finally:
        resolved = temporary.resolve()
        if resolved.parent != temporary_root or not resolved.name.startswith('codex-vsix-startup-'):
            raise RuntimeError('Refusing cleanup outside the smoke-test temporary directory')
        shutil.rmtree(resolved)

def build(archive, profile):
    subprocess.run(['node', 'tools/verify.cjs', '--check'], check=True, cwd=ROOT)
    artifacts = ROOT / 'artifacts'
    stage = artifacts / ('stage-' + VERSION + '-repair-' + PATCH_VERSION)
    destination = artifacts / ('openai.chatgpt-' + VERSION + '-queue-repair-' + PATCH_VERSION + '.vsix')
    if stage.exists() or destination.exists():
        raise RuntimeError('Build outputs already exist; use a fresh reviewed worktree')
    stage.mkdir()
    # Stage modified inputs; every other entry is streamed from the original.
    for relative in [*profile['files'].values(), *profile.get('testFiles', {}).values(), 'package.json']:
        target = stage / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(archive.read('extension/' + relative))
    subprocess.run(['node', str(ROOT / 'patch.cjs'), str(stage)], check=True, cwd=ROOT)
    manifest = json.loads((stage / 'queue-repair-manifest.json').read_text())
    pkg = json.loads((stage / 'package.json').read_text(encoding='utf-8'))
    pkg.pop('__metadata', None)
    pkg['displayName'] = 'Codex (local queue repair ' + PATCH_VERSION + ')'
    verification = json.loads((artifacts / 'verify-report.json').read_text())
    pkg['codexLocalQueueRepair'] = {
        'version': PATCH_VERSION, 'baseVersion': VERSION, 'sourceProject': 'https://github.com/IveSan83/codex-vscode-queue-repair',
        'sourceFingerprint': verification['fingerprint']['digest'],
        'repairAuthor': 'IveSan83',
        'repository': 'https://github.com/IveSan83/codex-vscode-queue-repair',
    }
    (stage / 'package.json').write_text(json.dumps(pkg, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    vsix_manifest = archive.read('extension.vsixmanifest').decode('utf-8')
    start = vsix_manifest.index('<DisplayName>') + len('<DisplayName>')
    end = vsix_manifest.index('</DisplayName>', start)
    overrides = {'extension/' + f.relative_to(stage).as_posix(): f.read_bytes()
                 for f in stage.rglob('*') if f.is_file()}
    overrides['extension.vsixmanifest'] = (vsix_manifest[:start] + pkg['displayName'] + vsix_manifest[end:]).encode('utf-8')
    types = archive.read('[Content_Types].xml').decode('utf-8')
    if 'Extension="cjs"' not in types:
        types = types.replace('</Types>', '<Default Extension="cjs" ContentType="application/javascript"/></Types>')
    overrides['[Content_Types].xml'] = types.encode('utf-8')
    original_names = set(archive.namelist())
    expected_names = original_names | set(overrides)
    if 'extension/out/codex-queue-store.cjs' in expected_names:
        raise RuntimeError('Obsolete duplicate store filename in package')
    with zipfile.ZipFile(destination, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=1, allowZip64=True) as output:
        for info in archive.infolist():
            if info.filename in overrides:
                output.writestr(info.filename, overrides.pop(info.filename))
            else:
                with archive.open(info) as source, output.open(info.filename, 'w', force_zip64=True) as target:
                    shutil.copyfileobj(source, target, length=1024 * 1024)
        for name, data in overrides.items():
            output.writestr(name, data)
    with zipfile.ZipFile(destination) as output:
        verify_archive(output, manifest)
        if set(output.namelist()) != expected_names:
            raise RuntimeError('Package file inventory differs from the original plus declared repair files')
        modified = {'extension/' + relative for relative in profile['files'].values()}
        modified.update({'extension/package.json', 'extension.vsixmanifest', '[Content_Types].xml'})
        for info in archive.infolist():
            if info.filename not in modified and sha_entry(archive, info.filename) != sha_entry(output, info.filename):
                raise RuntimeError('Unrelated archive entry changed: ' + info.filename)
        archive_audit = {
            'officialEntries': len(original_names), 'packagedEntries': len(expected_names),
            'unchangedEntries': len(original_names - modified),
            'modifiedEntries': sorted(modified), 'addedEntries': sorted(expected_names - original_names),
            'noMissingFiles': True, 'noUnexpectedFiles': True,
        }
    print('Checking host storage startup from the completed VSIX in Node and Electron...', flush=True)
    packaged_startup = smoke_vsix(destination)
    report = {
        'baseVersion': VERSION, 'patchVersion': PATCH_VERSION,
        'sourceFingerprint': verification['fingerprint']['digest'],
        'official': metadata(Path(archive.filename)), 'patched': metadata(destination),
        'rollback': {'officialVersion': '26.917.62051', 'journalRetained': True},
        'native': {'version': '0.160.0', 'path': NATIVE, 'sha256': NATIVE_SHA},
        'manifest': manifest, 'verificationReport': str(artifacts / 'verify-report.json'),
        'packagedStartup': packaged_startup,
        'archiveAudit': archive_audit,
    }
    (artifacts / 'build-report.json').write_text(json.dumps(report, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(report, indent=2), flush=True)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--official', type=Path, default=OFFICIAL)
    parser.add_argument('--prepare', action='store_true', help='Prepare original fixtures without building/installing')
    parser.add_argument('--smoke-vsix', type=Path, help='Check startup from freshly extracted VSIX contents in both runtimes')
    options = parser.parse_args()
    if options.smoke_vsix:
        print(json.dumps(smoke_vsix(options.smoke_vsix.resolve()), indent=2), flush=True)
        return
    (ROOT / 'artifacts').mkdir(exist_ok=True)
    if options.official.resolve() == OFFICIAL.resolve():
        download_official()
    archive, profile = verified_official(options.official.resolve())
    with archive:
        if options.prepare:
            prepare(archive, profile)
        else:
            build(archive, profile)

if __name__ == '__main__':
    main()
