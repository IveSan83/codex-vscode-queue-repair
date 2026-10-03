"""Package the verified repair sources and sanitized evidence, never user data."""
from pathlib import Path
import hashlib
import json
import re
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parent.parent
ARTIFACTS = ROOT / 'artifacts'
VERSION = '2.2.0'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def main():
    subprocess.run(['node', 'tools/verify.cjs', '--check'], cwd=ROOT, check=True)
    verification = json.loads((ARTIFACTS / 'verify-report.json').read_text())
    build = json.loads((ARTIFACTS / 'build-report.json').read_text())
    if build['sourceFingerprint'] != verification['fingerprint']['digest']:
        raise RuntimeError('Build/source verification mismatch')
    if build['baseVersion'] != '26.930.31730' or build['patchVersion'] != '2.2':
        raise RuntimeError('Wrong release identity')
    if not build['packagedStartup']['passed']:
        raise RuntimeError('Finished VSIX startup did not pass')
    patched = Path(build['patched']['path'])
    if sha(patched.read_bytes()) != build['patched']['sha256']:
        raise RuntimeError('Finished VSIX changed')
    replacements = [(str(ROOT), '<PROJECT>')]
    for runtime in verification['runtimes'].values():
        replacements.append((runtime['command']['executable'], '<RUNTIME_EXECUTABLE>'))
    replacements.append((str(Path(build['official']['path']).parent), '<LOCAL_ARTIFACTS>'))

    def clean(value):
        if isinstance(value, dict):
            return {key: clean(item) for key, item in value.items()}
        if isinstance(value, list):
            return [clean(item) for item in value]
        if isinstance(value, str):
            for original, replacement in sorted(replacements, key=lambda item: -len(item[0])):
                for form in (original, original.replace('\\', '/'), original.replace('\\', '\\\\')):
                    value = value.replace(form, replacement)
            return value
        return value

    def inspect(name, data):
        text = data.decode('utf-8-sig')
        if re.search(r'(?i)[a-z]:[\\/]', text):
            raise RuntimeError('Machine-specific absolute path in publication: ' + name)
        if re.search(r'(?im)^(?:co-authored-by|generated-by):', text) or re.search(r'(?i)sk-(?:proj-)?[a-z0-9_-]{20,}|gh[pousr]_[a-z0-9]{20,}|github_pat_[a-z0-9_]{20,}', text):
            raise RuntimeError('Credential or unwanted attribution marker: ' + name)

    output = ARTIFACTS / 'publication'
    output.mkdir(exist_ok=True)
    kit = output / ('codex-vscode-queue-repair-' + VERSION + '.zip')
    source_manifest = {}
    with zipfile.ZipFile(kit, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for relative, expected in verification['fingerprint']['files'].items():
            if any(part in {'.git', 'artifacts', 'node_modules', 'inspection', '__pycache__'} for part in Path(relative).parts):
                raise RuntimeError('Forbidden source entry: ' + relative)
            data = (ROOT / relative).read_bytes()
            if sha(data) != expected:
                raise RuntimeError('Source changed: ' + relative)
            inspect(relative, data)
            archive.writestr('codex-vscode-queue-repair-' + VERSION + '/' + relative, data)
            source_manifest[relative] = sha(data)

    evidence = {'verification-report.json': clean(verification), 'build-report.json': clean(build),
                'source-sha256.json': source_manifest}
    for name in ['archive-static-audit.json', 'archive-metadata-audit.json', 'critical-component-comparison.json']:
        file = ARTIFACTS / name
        if file.exists():
            evidence[name] = clean(json.loads(file.read_text()))
    result_zip = output / ('codex-vscode-queue-test-results-' + VERSION + '.zip')
    with zipfile.ZipFile(result_zip, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as archive:
        for name, value in evidence.items():
            data = (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode('utf-8')
            inspect(name, data)
            archive.writestr(name, data)
        for runtime in ['node', 'electron']:
            name = 'verify-' + runtime + '.txt'
            original = (ARTIFACTS / name).read_bytes()
            if sha(original) != verification['runtimes'][runtime]['logSha256']:
                raise RuntimeError('TAP log changed: ' + runtime)
            data = clean(original.decode('utf-8')).encode('utf-8')
            inspect(name, data)
            archive.writestr(name, data)
        data = (ROOT / 'reports/release-31730.md').read_bytes()
        inspect('release-31730.md', data)
        archive.writestr('release-31730.md', data)
    checksums = output / ('SHA256SUMS-' + VERSION + '.txt')
    checksums.write_text(''.join(sha(file.read_bytes()) + '  ' + file.name + '\n'
                                 for file in [kit, result_zip]), encoding='utf-8')
    print(json.dumps({'sourceKit': str(kit), 'testResults': str(result_zip),
                      'checksums': str(checksums), 'sourceFiles': len(source_manifest)}, indent=2))


if __name__ == '__main__':
    main()
