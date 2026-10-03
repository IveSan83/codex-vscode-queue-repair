'use strict';

// Headless release gate. --check never starts VS Code or reruns tests.
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {spawn, spawnSync} = require('node:child_process');
const acorn = require('acorn');

const ROOT = path.resolve(__dirname, '..');
const ARTIFACTS = path.join(ROOT, 'artifacts');
const REPORT = path.join(ARTIFACTS, 'verify-report.json');
const REGISTRY = path.join(ROOT, 'REGRESSIONS.json');
const sha256 = value => createHash('sha256').update(value).digest('hex');
const relative = filename => path.relative(ROOT, filename).split(path.sep).join('/');
const excluded = new Set(['.git', 'node_modules', 'artifacts', 'inspection', '__pycache__']);

function sourceFiles() {
  const location = spawnSync('git', ['rev-parse', '--show-toplevel'], {cwd:ROOT, encoding:'utf8', windowsHide:true, shell:false});
  if (location.status !== 0 || path.resolve(location.stdout.trim()).toLowerCase() !== ROOT.toLowerCase()) {
    // GitHub source ZIPs have no .git directory. Bind checks to their actual
    // source files, excluding only generated dependency/build directories.
    const files = [];
    const visit = directory => {
      for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
        if (excluded.has(entry.name) || entry.name.endsWith('.vsix')) continue;
        const full = path.join(directory, entry.name);
        if (entry.isSymbolicLink()) throw new Error('Source symlinks are not supported');
        if (entry.isDirectory()) visit(full);
        else if (entry.isFile()) files.push(relative(full));
      }
    };
    visit(ROOT);
    return files.sort();
  }
  const result = spawnSync('git', ['-c', 'core.hooksPath=NUL', '-c', 'core.fsmonitor=', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd:ROOT, encoding:'utf8', windowsHide:true, shell:false
  });
  if (result.error || result.status !== 0) throw new Error(`Cannot enumerate source inputs: ${result.error?.message ?? result.stderr}`);
  const files = [...new Set(result.stdout.split('\0').filter(Boolean))]
    .filter(filename => !filename.split('/').some(part => excluded.has(part))).sort();
  for (const filename of files) {
    const absolute = path.resolve(ROOT, filename);
    if (!absolute.startsWith(ROOT + path.sep)) throw new Error(`Source path escapes repository: ${filename}`);
    if (!fs.statSync(absolute).isFile()) throw new Error(`Missing source file: ${filename}`);
  }
  return files;
}

function staticValue(node, environment) {
  if (!node) throw new Error('Missing static test-name expression');
  if (node.type === 'Literal') return node.value;
  if (node.type === 'Identifier' && Object.hasOwn(environment, node.name)) return environment[node.name];
  if (node.type === 'ArrayExpression') return node.elements.map(item => staticValue(item, environment));
  if (node.type === 'TemplateLiteral') return node.quasis.reduce((text, part, index) =>
    text + part.value.cooked + (index < node.expressions.length ? staticValue(node.expressions[index], environment) : ''), '');
  throw new Error(`Cannot enumerate dynamic test name (${node.type}); add explicit finite names before release`);
}

function discoverTests(files=sourceFiles()) {
  const tests = [];
  for (const filename of files.filter(file => /^tests\/.*\.test\.cjs$/.test(file))) {
    const tree = acorn.parse(fs.readFileSync(path.join(ROOT, filename), 'utf8'), {ecmaVersion:'latest', sourceType:'script'});
    const walk = (node, environment={}) => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'ForOfStatement' && node.left.type === 'VariableDeclaration' && node.left.declarations.length === 1 && node.left.declarations[0].id.type === 'Identifier') {
        let values;
        try { values = staticValue(node.right, environment); } catch { /* Ordinary helper loop, not a parameterized test. */ }
        if (Array.isArray(values)) {
          for (const value of values) walk(node.body, {...environment, [node.left.declarations[0].id.name]:value});
          return;
        }
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'test') {
        const name = staticValue(node.arguments[0], environment);
        if (typeof name !== 'string' || !name) throw new Error(`Invalid test name in ${filename}`);
        tests.push({file:filename, name});
      }
      for (const value of Object.values(node)) {
        if (Array.isArray(value)) for (const child of value) walk(child, environment);
        else if (value && typeof value === 'object') walk(value, environment);
      }
    };
    walk(tree);
  }
  const names = tests.map(test => test.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate test names prevent unambiguous regression verification');
  return tests.sort((a,b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

function readRegistry(tests) {
  const registry = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  if (registry.schemaVersion !== 1 || !Array.isArray(registry.testsKnown) || !Array.isArray(registry.regressions)) throw new Error('Invalid regression registry');
  if (JSON.stringify(registry.requiredRuntimes) !== JSON.stringify(['node', 'electron'])) throw new Error('Regression registry must require both Node and Electron');
  const normalize = values => values.map(value => `${value.file}\0${value.name}`).sort();
  if (JSON.stringify(normalize(registry.testsKnown)) !== JSON.stringify(normalize(tests))) throw new Error('REGRESSIONS.json testsKnown does not exactly match test declarations; update the registry for added, removed, or renamed tests');
  const names = new Set(tests.map(test => test.name));
  const required = new Set();
  const ids = new Set();
  for (const regression of registry.regressions) {
    if (!regression.id || ids.has(regression.id) || typeof regression.assertion !== 'string' || !regression.assertion.trim() || !Array.isArray(regression.tests) || !regression.tests.length) throw new Error('Every regression needs a unique ID, an assertion, and exact test names');
    ids.add(regression.id);
    for (const name of regression.tests) {
      if (!names.has(name)) throw new Error(`Regression ${regression.id} refers to an unknown test: ${name}`);
      required.add(name);
    }
  }
  if (required.size !== names.size) throw new Error('Every known test must belong to a required regression assertion');
  if (!Array.isArray(registry.limitations) || !registry.limitations.length || !Array.isArray(registry.manualUserChecks) || !registry.manualUserChecks.length) throw new Error('Registry must retain limitations and manual user checks');
  return {registry, required:[...required].sort()};
}

function fingerprint(files=sourceFiles()) {
  const hashes = Object.fromEntries(files.map(filename => [filename, sha256(fs.readFileSync(path.join(ROOT, filename)))]));
  // The shipped fixture lives under ignored artifacts. Verify its release hashes
  // explicitly so changing that test input also invalidates the release gate.
  const fixturePath = path.resolve(process.env.CODEX_QUEUE_TEST_EXTENSION || path.join(ARTIFACTS, 'base', 'extension'));
  const packageBytes = fs.readFileSync(path.join(fixturePath, 'package.json'));
  const version = JSON.parse(packageBytes.toString('utf8')).version;
  const releases = JSON.parse(fs.readFileSync(path.join(ROOT, 'releases.json'), 'utf8'));
  const release = releases[version];
  if (!release) throw new Error(`Unsupported test-fixture version: ${version}`);
  const fixtureHashes = {'package.json':sha256(packageBytes)};
  for (const [key, filename] of Object.entries(release.files)) {
    const hash = sha256(fs.readFileSync(path.join(fixturePath, filename)));
    if (hash !== release.hashes[key]) throw new Error(`Test fixture does not match the pinned release: ${filename}`);
    fixtureHashes[filename] = hash;
  }
  const fixture = {path:fixturePath, version, files:fixtureHashes};
  const digest = sha256(JSON.stringify({files:hashes, fixture}));
  return {algorithm:'sha256', digest, files:hashes, fixture};
}

function parseTap(text) {
  const number = key => {
    const matches = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    return matches.length ? Number(matches.at(-1)[1]) : null;
  };
  const passedTests = [...text.matchAll(/^ok \d+ - (.+?)\r?$/gm)].map(match => match[1]);
  return {
    testCount:number('tests'), passCount:number('pass'), failCount:number('fail'),
    cancelledCount:number('cancelled'), skippedCount:number('skipped'), todoCount:number('todo'),
    passedTests, bailedOut:/^Bail out!/m.test(text)
  };
}

function assertSuccessful(result, required, testCount) {
  if (result.exitCode !== 0 || result.signal || result.timedOut || result.error) throw new Error('Test process did not exit successfully');
  if (result.bailedOut || result.testCount !== testCount || result.passCount !== testCount || result.failCount !== 0 || result.cancelledCount !== 0 || result.skippedCount !== 0 || result.todoCount !== 0) throw new Error('Tests failed, were skipped/cancelled, or the executed test count differs from the registry');
  const names = new Set(result.passedTests);
  if (names.size !== testCount || result.passedTests.length !== testCount) throw new Error('Test results do not contain each registered test exactly once');
  const missing = required.filter(name => !names.has(name));
  if (missing.length) throw new Error(`Required regressions did not pass: ${missing.join('; ')}`);
}

function findExecutable(runtime) {
  let candidates;
  if (runtime === 'node') {
    candidates = [!process.versions.electron && process.execPath,
      ...(process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, process.platform === 'win32' ? 'node.exe' : 'node'))];
  } else {
    candidates = [process.env.CODEX_QUEUE_VERIFY_CODE_EXE,
      process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code', 'Code.exe'),
      process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'),
      process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Microsoft VS Code', 'Code.exe')];
  }
  const executable = candidates.find(candidate => candidate && fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!executable) throw new Error(runtime === 'electron' ? 'Installed Code.exe was not found; set CODEX_QUEUE_VERIFY_CODE_EXE to its absolute path' : 'Node executable was not found');
  if (runtime === 'electron' && !/^Code(?: - Insiders)?\.exe$/i.test(path.basename(executable))) throw new Error('Electron runtime must be the installed VS Code Code.exe');
  return path.resolve(executable);
}

function runtimeEnvironment(runtime, fixturePath) {
  const environment = {...process.env, CODEX_QUEUE_TEST_EXTENSION:fixturePath, NO_COLOR:'1'};
  delete environment.NODE_OPTIONS;
  delete environment.NODE_TEST_CONTEXT;
  delete environment.FORCE_COLOR;
  if (runtime === 'electron') environment.ELECTRON_RUN_AS_NODE = '1';
  else delete environment.ELECTRON_RUN_AS_NODE;
  return environment;
}

function runtimeVersion(executable, environment, runtime) {
  // ELECTRON_RUN_AS_NODE is set even for this probe; Code.exe can never launch
  // its GUI through this verifier. No shell, extension host, or editor flags.
  const probe = spawnSync(executable, ['-p', 'JSON.stringify(process.versions)'], {
    cwd:ROOT, env:environment, encoding:'utf8', shell:false, windowsHide:true, timeout:10000
  });
  if (probe.error || probe.status !== 0) throw new Error(`Cannot inspect ${runtime} runtime: ${probe.error?.message ?? probe.stderr}`);
  const versions = JSON.parse(probe.stdout.trim());
  if (!versions.node || (runtime === 'electron' && !versions.electron) || (runtime === 'node' && versions.electron)) throw new Error(`Unexpected ${runtime} executable identity`);
  return versions;
}

async function executeTests(executable, args, environment) {
  return new Promise(resolve => {
    const child = spawn(executable, args, {cwd:ROOT, env:environment, shell:false, windowsHide:true, stdio:['ignore','pipe','pipe']});
    let stdout = '', stderr = '', error, timedOut = false;
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', failure => { error = failure.message; });
    const timer = setTimeout(() => {
      timedOut = true;
      // Terminate only the verifier's own test-process tree.
      if (child.pid && child.exitCode === null) {
        if (process.platform === 'win32') spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {windowsHide:true, shell:false, stdio:'ignore'});
        else child.kill('SIGKILL');
      }
    }, 180000);
    child.on('close', (exitCode, signal) => {
      clearTimeout(timer);
      resolve({stdout, stderr, exitCode, signal, timedOut, ...(error ? {error} : {})});
    });
  });
}

function existingReport() {
  try {
    const report = JSON.parse(fs.readFileSync(REPORT, 'utf8'));
    return report.schemaVersion === 1 ? report : null;
  } catch { return null; }
}

function writeReport(report) {
  fs.mkdirSync(ARTIFACTS, {recursive:true});
  const temporary = REPORT + `.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(report, null, 2) + '\n', 'utf8');
  fs.renameSync(temporary, REPORT);
}

function checkReport(current, tests, required) {
  const report = existingReport();
  if (!report || report.fingerprint?.digest !== current.digest) throw new Error('Verification results are missing or source/fixture fingerprints changed; run node tools/verify.cjs --runtime all');
  for (const runtime of ['node', 'electron']) {
    const result = report.runtimes?.[runtime];
    if (!result?.passed || result.sourceFingerprint !== current.digest) throw new Error(`Successful ${runtime} verification for these inputs is required`);
    const logPath = path.join(ARTIFACTS, `verify-${runtime}.txt`);
    const bytes = fs.readFileSync(logPath);
    if (sha256(bytes) !== result.logSha256) throw new Error(`${runtime} verification log changed`);
    // Re-read TAP; a report boolean alone cannot replace the regression results.
    assertSuccessful({...result, ...parseTap(bytes.toString('utf8'))}, required, tests.length);
  }
  process.stdout.write(`[verify] Both runtimes passed all ${tests.length} registered tests; fingerprint ${current.digest}\n`);
  return report;
}

async function main(argv=process.argv.slice(2)) {
  let runtime = 'all', check = false;
  for (let index=0; index<argv.length; index++) {
    if (argv[index] === '--check') check = true;
    else if (argv[index] === '--runtime') runtime = argv[++index];
    else if (argv[index] === '--help') {
      process.stdout.write('Usage: node tools/verify.cjs [--runtime node|electron|all] [--check]\n--check requires matching successful results from both runtimes and never launches them.\n');
      return;
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!['node', 'electron', 'all'].includes(runtime)) throw new Error('--runtime must be node, electron, or all');
  const files = sourceFiles();
  const tests = discoverTests(files);
  const {required} = readRegistry(tests);
  const initial = fingerprint(files);
  if (check) { checkReport(initial, tests, required); return; }
  const previous = existingReport();
  const report = {schemaVersion:1, fingerprint:initial, testsKnown:tests, requiredRegressionTests:required,
    runtimes:previous?.fingerprint?.digest === initial.digest ? {...previous.runtimes} : {}};
  const requested = runtime === 'all' ? ['node', 'electron'] : [runtime];
  let failed = false;
  for (const currentRuntime of requested) {
    if (fingerprint().digest !== initial.digest) throw new Error('Inputs changed before runtime verification; rerun after edits finish');
    const startedAt = new Date().toISOString();
    let result;
    try {
      const executable = findExecutable(currentRuntime);
      const environment = runtimeEnvironment(currentRuntime, initial.fixture.path);
      const versions = runtimeVersion(executable, environment, currentRuntime);
      const args = ['--test', '--test-reporter=tap', ...[...new Set(tests.map(test => path.join(ROOT, test.file)))].sort()];
      process.stdout.write(`[verify] Starting ${currentRuntime} (Node ${versions.node}${versions.electron ? `, Electron ${versions.electron}` : ''}); ${tests.length} registered tests\n`);
      const execution = await executeTests(executable, args, environment);
      const log = execution.stdout + (execution.stderr ? '\n# verifier stderr\n' + execution.stderr.split(/\r?\n/).map(line => '# ' + line).join('\n') + '\n' : '');
      const logPath = path.join(ARTIFACTS, `verify-${currentRuntime}.txt`);
      fs.mkdirSync(ARTIFACTS, {recursive:true});
      fs.writeFileSync(logPath, log, 'utf8');
      result = {...parseTap(execution.stdout), exitCode:execution.exitCode, signal:execution.signal, timedOut:execution.timedOut,
        ...(execution.error ? {error:execution.error} : {}), sourceFingerprint:initial.digest,
        command:{executable, args, environment:currentRuntime === 'electron' ? {ELECTRON_RUN_AS_NODE:'1'} : {}},
        runtimeVersion:versions, logPath:relative(logPath), logSha256:sha256(Buffer.from(log)), startedAt, finishedAt:new Date().toISOString()};
      result.missingRequiredTests = required.filter(name => !result.passedTests.includes(name));
      assertSuccessful(result, required, tests.length);
      if (fingerprint().digest !== initial.digest) throw new Error('Source or fixture inputs changed during tests; results cannot approve a release');
      result.passed = true;
    } catch (error) {
      result = {...result, passed:false, error:error.message, sourceFingerprint:initial.digest, startedAt, finishedAt:new Date().toISOString()};
      failed = true;
    }
    report.runtimes[currentRuntime] = result;
    report.updatedAt = new Date().toISOString();
    writeReport(report);
    process.stdout.write(`[verify] ${currentRuntime}: ${result.passed ? `${result.passCount}/${result.testCount} passed` : 'FAILED: ' + result.error}\n`);
  }
  if (failed) throw new Error('Release verification failed; inspect artifacts/verify-report.json and the runtime TAP logs');
  if (runtime === 'all') checkReport(fingerprint(), tests, required);
  else process.stdout.write('[verify] This runtime is recorded. --check still requires both runtimes on identical inputs.\n');
}

module.exports = {discoverTests, readRegistry, fingerprint, parseTap, assertSuccessful, findExecutable, runtimeEnvironment, runtimeVersion, main};
if (require.main === module) main().catch(error => { process.stderr.write(`[verify] ${error.message}\n`); process.exitCode = 1; });
