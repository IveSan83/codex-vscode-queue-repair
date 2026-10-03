'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {spawnSync} = require('node:child_process');
const {apply, files} = require('../patch.cjs');

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'codex-packaging-test-'));
  t.after(async () => {
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('codex-packaging-test-'));
    await fs.rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 30});
  });
  const original = process.env.CODEX_QUEUE_TEST_EXTENSION || path.resolve(__dirname, '../artifacts/base/extension');
  for (const relative of ['package.json', ...Object.values(files)]) {
    await fs.mkdir(path.dirname(path.join(directory, relative)), {recursive: true});
    await fs.copyFile(path.join(original, relative), path.join(directory, relative));
  }
  apply(directory);
  return directory;
}

function run(directory) {
  return spawnSync(process.execPath, [path.resolve(__dirname, '../tools/package-smoke.cjs'), '--single', directory], {
    cwd: os.tmpdir(), env: {...process.env, NODE_OPTIONS: ''},
    encoding: 'utf8', shell: false, windowsHide: true, timeout: 20000,
  });
}

test('the packaged host starts with real relative imports and writes and reads an isolated journal', async t => {
  const directory = await fixture(t);
  const result = run(directory);
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  assert.equal(JSON.parse(result.stdout).passed, true);
  assert.ok(JSON.parse(result.stdout).helpers.includes('out/queue-store.cjs'));
});

test('CONTROL: shipping the store under the old wrong filename fails packaged host startup', async t => {
  const directory = await fixture(t);
  await fs.rename(path.join(directory, 'out', 'queue-store.cjs'), path.join(directory, 'out', 'codex-queue-store.cjs'));
  const result = run(directory);
  assert.equal(result.status, 1, 'The wrong filename must fail, not resolve to project source or a cached module');
  assert.match(result.stderr, /Cannot find module '\.\/queue-store\.cjs'/);
});
