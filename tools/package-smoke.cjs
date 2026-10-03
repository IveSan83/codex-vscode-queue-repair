'use strict';

// Execute the shipped host storage class with real CommonJS module resolution.
// Only VS Code's EventEmitter and unrelated Memento helpers are test doubles.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const {createRequire} = require('node:module');
const {spawnSync} = require('node:child_process');
const {expression} = require('../patch.cjs');

class EventEmitter {
  listeners = new Set();
  event = callback => { this.listeners.add(callback); return {dispose: () => this.listeners.delete(callback)}; };
  fire(value) { for (const listener of this.listeners) listener(value); }
  dispose() { this.listeners.clear(); }
}

async function smoke(extensionDirectory) {
  const directory = fs.realpathSync(extensionDirectory);
  const hostPath = path.join(directory, 'out', 'extension.js');
  const requireFromHost = createRequire(hostPath);
  const hostSource = fs.readFileSync(hostPath, 'utf8');
  const version=JSON.parse(fs.readFileSync(path.join(directory,'package.json'),'utf8')).version;
  const release=require('../releases.json')[version];
  if(!release)throw Error('Unsupported smoke-test release '+version);
  const className=release.hostClass??'XF';
  const aliases=release.hostSandboxAliases??{namespace:'QF',isRemote:'wX',unrelatedHelper:'Soe'};
  const hostClass = expression(hostSource, className+'=class', className.length+1).code;
  const XF = vm.runInNewContext(`(${hostClass})`, {
    require: requireFromHost,
    [aliases.namespace]: {EventEmitter},
    [aliases.isRemote]: () => false,
    [aliases.unrelatedHelper]: () => undefined,
    console,
  });
  const temporaryRoot = await fsp.realpath(os.tmpdir());
  const profile = await fsp.mkdtemp(path.join(temporaryRoot, 'codex-package-startup-'));
  let state;
  try {
    let memento = {theme: 'dark'};
    // This constructor follows the exact require() chain used on activation.
    // It must fail if any packaged helper was omitted or renamed incorrectly.
    state = new XF({get: key => memento[key], update: async (key, value) => { memento[key] = value; }}, profile);
    assert.ok(state.queueRepair, 'The shipped host did not construct its queue store');
    await state.update('theme', 'light');
    assert.equal(await state.get('theme'), 'light');
    const initial = await state.queueRepair.read();
    const added = await state.queueRepair.compareAndSet({
      ...initial, protocolVersion: 2,
      queue: {smoke: [{id: 'package-startup', text: 'isolated package smoke test'}]},
    });
    assert.equal(added.applied, true);
    const saved = await state.queueRepair.read();
    assert.equal(saved.queue.smoke[0].id, 'package-startup');
    assert.equal(saved.queue.smoke[0].queueRepairGeneration, 0);
    const removed = await state.queueRepair.compareAndSet({
      ...saved, protocolVersion: 2, queue: {},
      removals: [{conversationId: 'smoke', id: 'package-startup', generation: 0}],
    });
    assert.equal(removed.applied, true);
    assert.deepEqual((await state.queueRepair.read()).queue, {});
    const protocolPath = requireFromHost.resolve('./codex-queue-protocol.cjs');
    const storePath = createRequire(protocolPath).resolve('./queue-store.cjs');
    for (const modulePath of [protocolPath, storePath]) {
      assert.equal(path.dirname(fs.realpathSync(modulePath)), path.join(directory, 'out'));
    }
    return {
      passed: true, scope: 'packaged-host-storage-startup-and-journal-read-write',
      runtime: {node: process.versions.node, electron: process.versions.electron ?? null},
      helpers: [protocolPath, storePath].map(file => path.relative(directory, file).split(path.sep).join('/')),
    };
  } finally {
    state?.dispose();
    const resolved = await fsp.realpath(profile);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('codex-package-startup-'));
    await fsp.rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 30});
  }
}

function runAll(directory) {
  const {findExecutable, runtimeEnvironment, runtimeVersion} = require('./verify.cjs');
  const results = {};
  for (const runtime of ['node', 'electron']) {
    const executable = findExecutable(runtime);
    const environment = runtimeEnvironment(runtime, path.resolve(directory));
    runtimeVersion(executable, environment, runtime);
    const child = spawnSync(executable, [__filename, '--single', path.resolve(directory)], {
      cwd: os.tmpdir(), env: environment, encoding: 'utf8', shell: false, windowsHide: true, timeout: 20000,
    });
    if (child.error || child.status !== 0) throw new Error(`${runtime} packaged startup failed: ${child.error?.message ?? child.stderr}`);
    results[runtime] = JSON.parse(child.stdout);
    assert.equal(results[runtime].passed, true);
  }
  return {passed: true, extensionDirectory: path.resolve(directory), runtimes: results};
}

module.exports = {smoke, runAll};
if (require.main === module) {
  const [mode, directory] = process.argv.slice(2);
  if (!['--single', '--all'].includes(mode) || !directory || !path.isAbsolute(directory)) {
    process.stderr.write('Usage: node tools/package-smoke.cjs --single|--all ABSOLUTE_EXTENSION_DIRECTORY\n');
    process.exitCode = 1;
  } else Promise.resolve().then(() => mode === '--all' ? runAll(directory) : smoke(directory))
    .then(result => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
}
