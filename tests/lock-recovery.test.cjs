'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {fork} = require('node:child_process');
const {randomUUID} = require('node:crypto');
const {QueueStore} = require('../queue-store.cjs');
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const message = id => ({id, text: id, context: {}, submission: {hostId: 'local', status: 'pending'}});

// Child scenarios exercise actual process death and actual filesystem locking.
// Only processes forked by this file are terminated by the parent tests.
async function childMain() {
  const [mode, directory, id = 'child'] = process.argv.slice(3);
  const waiting = new Map();
  process.on('message', value => {
    if (value?.type === 'continue') waiting.get(value.key)?.();
  });
  const emit = value => new Promise((resolve, reject) => process.send(value, error => error ? reject(error) : resolve()));
  const pause = async (type, extra = {}) => {
    let resolve;
    const ready = new Promise(r => { resolve = r; });
    waiting.set(type, resolve);
    await emit({type, ...extra});
    await ready;
    waiting.delete(type);
  };
  let observed = false;
  const hooks = {
    afterCandidatePrepared: mode === 'prepare' ? owner => pause('candidate-prepared', {token: owner.token}) : undefined,
    beforeJournalCommit: mode === 'before' ? () => pause('before-commit') : undefined,
    afterJournalCommit: mode === 'after' ? () => pause('after-commit') : undefined,
    afterLockAcquired: mode === 'hold' ? owner => pause('acquired', {token: owner.token}) :
      mode === 'recover-paused' ? owner => emit({type: 'acquired', token: owner.token}) : undefined,
    beforeRemoveOwner: mode === 'recover-paused' ? async owner => {
      if (!observed && owner.pid !== process.pid) {
        observed = true;
        await pause('old-observed', {token: owner.token});
      }
    } : undefined
  };
  const host = new QueueStore(directory, () => ({}), {hooks, timeoutMs: 10000});
  for (;;) {
    const snapshot = await host.read();
    const queue = {...snapshot.queue, thread: [...(snapshot.queue.thread ?? []), message(id)]};
    const result = await host.compareAndSet({...snapshot, queue});
    if (result.applied) break;
  }
  await emit({type: 'done', snapshot: await host.read()});
  process.disconnect();
}

if (process.argv[2] === '--child') {
  childMain().catch(error => {
    process.stderr.write(error.stack + '\n');
    if (process.connected) process.send({type: 'error', error: error.message}, () => { process.exitCode = 1; process.disconnect(); });
    else process.exitCode = 1;
  });
} else {
  const {test} = require('node:test');

  async function fixture(t, options = {}) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-lock-recovery-'));
    const host = new QueueStore(directory, () => ({}), options);
    t.after(async () => {
      clearTimeout(host.cleanupTimer);
      if (host.cleanupTask) await host.cleanupTask;
      // Recursive cleanup applies exclusively to our own unique direct child
      // of the system temp directory, checked before every removal on Windows.
      const resolved = path.resolve(directory);
      assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
      assert.ok(path.basename(resolved).startsWith('codex-lock-recovery-'));
      await fs.rm(resolved, {recursive: true, force: true});
    });
    return {directory, host};
  }

  function launch(t, mode, directory, id) {
    const child = fork(__filename, ['--child', mode, directory, id], {stdio: ['ignore', 'ignore', 'pipe', 'ipc']});
    child.messages = [];
    child.diagnostics = '';
    child.stderr.on('data', chunk => { child.diagnostics += chunk; });
    child.on('message', value => child.messages.push(value));
    child.exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({code, signal})));
    t.after(async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await child.exited;
    });
    return child;
  }

  async function event(child, type) {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      const failed = child.messages.find(value => value.type === 'error');
      assert.ok(!failed, failed?.error + '\n' + child.diagnostics);
      const found = child.messages.find(value => value.type === type);
      if (found) return found;
      assert.ok(child.exitCode === null && child.signalCode === null, `Child exited before ${type}: ${child.diagnostics}`);
      await sleep(10);
    }
    assert.fail(`Timeout waiting for ${type}: ${child.diagnostics}`);
  }

  async function killOwn(child) {
    assert.equal(child.kill('SIGKILL'), true);
    await child.exited;
  }

  async function writeOwner(host, value = {}) {
    const token = value.token ?? randomUUID();
    const owner = {format: 2, token, pid: process.pid, created: new Date().toISOString(), ...value};
    await fs.mkdir(host.lock);
    await fs.writeFile(path.join(host.lock, `owner-${token}.json`), JSON.stringify(owner));
    return owner;
  }

  for (const mode of ['before', 'after']) {
    test(`a killed real writer ${mode} journal commit is recovered without losing committed state`, {timeout: 15000}, async t => {
      const {directory, host} = await fixture(t);
      await host.read();
      const child = launch(t, mode, directory, 'A');
      await event(child, `${mode}-commit`);
      await killOwn(child);
      const restarted = new QueueStore(directory);
      const snapshot = await restarted.read();
      assert.deepEqual((snapshot.queue.thread ?? []).map(item => item.id), mode === 'after' ? ['A'] : []);
      const result = await restarted.compareAndSet({...snapshot, queue: {...snapshot.queue, other: [message('B')]}});
      assert.equal(result.applied, true);
      assert.deepEqual((await restarted.read()).queue.other.map(item => item.id), ['B']);
      await assert.rejects(fs.stat(host.lock), {code: 'ENOENT'});
      assert.equal((await fs.stat(host.compatibilityLock)).isDirectory(), true);
    });
  }

  test('two real recovery competitors cannot let a delayed remover delete a new owner', {timeout: 20000}, async t => {
    const {directory, host} = await fixture(t);
    await host.read();
    const dead = launch(t, 'before', directory, 'uncommitted');
    await event(dead, 'before-commit');
    await killOwn(dead);

    const delayed = launch(t, 'recover-paused', directory, 'A');
    const old = await event(delayed, 'old-observed');
    const replacement = launch(t, 'hold', directory, 'B');
    const fresh = await event(replacement, 'acquired');
    assert.notEqual(old.token, fresh.token);
    delayed.send({type: 'continue', key: 'old-observed'});
    await sleep(150);
    assert.equal(delayed.messages.some(value => value.type === 'acquired'), false);
    const protectedOwner = JSON.parse(await fs.readFile(path.join(host.lock, `owner-${fresh.token}.json`), 'utf8'));
    assert.equal(protectedOwner.pid, replacement.pid);

    replacement.send({type: 'continue', key: 'acquired'});
    await event(replacement, 'done');
    await event(delayed, 'done');
    assert.deepEqual((await host.read()).queue.thread.map(item => item.id).sort(), ['A', 'B']);
    await assert.rejects(fs.stat(host.lock), {code: 'ENOENT'});
  });

  test('a crash while preparing metadata leaves no shared active lock', {timeout: 15000}, async t => {
    const {directory, host} = await fixture(t);
    await host.read();
    const child = launch(t, 'prepare', directory, 'uncommitted');
    await event(child, 'candidate-prepared');
    await killOwn(child);
    await assert.rejects(fs.stat(host.lock), {code: 'ENOENT'});
    const snapshot = await host.read();
    assert.equal((await host.compareAndSet({...snapshot, queue: {thread: [message('A')]}})).applied, true);
  });

  test('an empty active directory is recoverable without using age as a lease', async t => {
    const {host} = await fixture(t);
    const snapshot = await host.read();
    await fs.mkdir(host.lock);
    assert.equal((await host.compareAndSet({...snapshot, queue: {thread: [message('A')]}})).applied, true);
    await assert.rejects(fs.stat(host.lock), {code: 'ENOENT'});
  });

  test('the permanent compatibility gate blocks v1 open(wx) writers', async t => {
    const {host} = await fixture(t);
    await host.read();
    await assert.rejects(fs.open(host.compatibilityLock, 'wx'), error => ['EEXIST', 'EPERM', 'EISDIR'].includes(error.code));
    await assert.rejects(fs.stat(host.lock), {code: 'ENOENT'});
  });

  test('an existing legacy writer.lock file is never overwritten by Windows directory rename', async t => {
    const {host} = await fixture(t);
    await fs.mkdir(host.directory, {recursive: true});
    const original = JSON.stringify({pid: process.pid, created: 'legacy'});
    await fs.writeFile(host.compatibilityLock, original);
    await assert.rejects(host.read(), /locked.*legacy writer.lock/);
    assert.equal(await fs.readFile(host.compatibilityLock, 'utf8'), original);
    await assert.rejects(fs.stat(host.file), {code: 'ENOENT'});
  });

  test('an unsupported active lock file is rejected and preserved', async t => {
    const {host} = await fixture(t);
    const snapshot = await host.read();
    await fs.writeFile(host.lock, '{"pid":0}');
    await assert.rejects(host.compareAndSet({...snapshot, queue: {}}), /locked/);
    assert.equal(await fs.readFile(host.lock, 'utf8'), '{"pid":0}');
  });

  test('a live or reused PID remains protected even with ancient metadata', async t => {
    const {host} = await fixture(t, {timeoutMs: 35});
    const snapshot = await host.read();
    const owner = await writeOwner(host, {created: '1970-01-01T00:00:00.000Z'});
    await assert.rejects(host.compareAndSet({...snapshot, queue: {}}), /locked/);
    assert.equal(JSON.parse(await fs.readFile(path.join(host.lock, `owner-${owner.token}.json`), 'utf8')).pid, process.pid);
  });

  test('an unverifiable PID or malformed owner is never automatically removed', async t => {
    const {host} = await fixture(t, {
      timeoutMs: 35,
      probePid: () => { throw Object.assign(new Error('permission denied'), {code: 'EPERM'}); }
    });
    const snapshot = await host.read();
    const owner = await writeOwner(host);
    const ownerPath = path.join(host.lock, `owner-${owner.token}.json`);
    await assert.rejects(host.compareAndSet({...snapshot, queue: {}}), /locked/);
    await fs.writeFile(ownerPath, '{broken');
    await assert.rejects(host.compareAndSet({...snapshot, queue: {}}), /Invalid active lock JSON/);
    assert.equal(await fs.readFile(ownerPath, 'utf8'), '{broken');
    await fs.writeFile(ownerPath, 'null');
    await assert.rejects(host.compareAndSet({...snapshot, queue: {}}), /Invalid active lock owner/);
    assert.equal(await fs.readFile(ownerPath, 'utf8'), 'null');
  });

  test('Windows transient journal rename and owner unlink errors are retried', async t => {
    let host, armed = false, renameFaults = 0, unlinkFaults = 0;
    const codes = ['EPERM', 'EACCES', 'EBUSY'];
    const injected = {
      ...fs,
      rename: async (from, to) => {
        if (armed && to === host.file && renameFaults < codes.length) throw Object.assign(new Error('busy journal'), {code: codes[renameFaults++]});
        return fs.rename(from, to);
      },
      unlink: async target => {
        if (armed && path.dirname(target) === host.lock && unlinkFaults < codes.length) throw Object.assign(new Error('busy owner'), {code: codes[unlinkFaults++]});
        return fs.unlink(target);
      }
    };
    ({host} = await fixture(t, {fs: injected, retryAttempts: 4, retryDelay: () => 0}));
    const snapshot = await host.read();
    armed = true;
    const result = await host.compareAndSet({...snapshot, queue: {thread: [message('A')]}});
    assert.equal(result.applied, true);
    assert.equal(renameFaults, 3);
    assert.equal(unlinkFaults, 3);
    await assert.rejects(fs.stat(host.lock), {code: 'ENOENT'});
  });

  test('transient owner inspection failures retry without removing a live lock', async t => {
    let host,armed=false;
    const faults={lstat:0,readdir:0,readFile:0};
    const injected={...fs};
    for(const method of Object.keys(faults))injected[method]=async(...args)=>{
      if(armed&&(args[0]===host.lock||path.dirname(args[0])===host.lock)&&faults[method]++===0)
        throw Object.assign(new Error('delete pending'),{code:'EPERM'});
      return fs[method](...args);
    };
    ({host}=await fixture(t,{fs:injected,retryAttempts:2,retryDelay:()=>0}));
    await host.read();const owner=await writeOwner(host);armed=true;
    await host.recoverDeadOwner();
    assert.ok(Object.values(faults).every(count=>count===2));
    assert.equal(JSON.parse(await fs.readFile(path.join(host.lock,`owner-${owner.token}.json`),'utf8')).pid,process.pid);
  });

  test('delete-pending owner read retries to absence and permits one subsequent commit', async t => {
    let host,ownerPath,attempts=0;
    const injected={...fs,readFile:async(...args)=>{
      if(args[0]===ownerPath){
        attempts++;
        if(attempts===1){await fs.unlink(ownerPath);await fs.rmdir(host.lock);throw Object.assign(new Error('delete pending'),{code:'EPERM'});}
      }
      return fs.readFile(...args);
    }};
    ({host}=await fixture(t,{fs:injected,retryAttempts:2,retryDelay:()=>0}));
    const before=await host.read(),owner=await writeOwner(host);
    ownerPath=path.join(host.lock,`owner-${owner.token}.json`);
    const committed=await host.compareAndSet({...before,queue:{thread:[message('after-release')]}});
    assert.equal(attempts,2);assert.equal(committed.applied,true);
    assert.equal(committed.revision,before.revision+1);
    assert.equal((await host.read()).queue.thread[0].id,'after-release');
  });

  test('persistent owner read denial fails closed and preserves the owner and journal', async t => {
    let host,ownerPath;
    const injected={...fs,readFile:async(...args)=>{
      if(args[0]===ownerPath)throw Object.assign(new Error('owner denied'),{code:'EACCES'});
      return fs.readFile(...args);
    }};
    ({host}=await fixture(t,{fs:injected,retryAttempts:2,retryDelay:()=>0}));
    const before=await host.read(),owner=await writeOwner(host);
    ownerPath=path.join(host.lock,`owner-${owner.token}.json`);
    await assert.rejects(host.compareAndSet({...before,queue:{thread:[message('not-committed')]}}),{code:'EACCES'});
    assert.deepEqual(await host.read(),before);
    assert.equal(JSON.parse(await fs.readFile(ownerPath,'utf8')).token,owner.token);
  });

  test('cleanup failure after commit reports success and retries the same owner before the next write', async t => {
    let host, denyCleanup = false;
    const warnings = [];
    const injected = {
      ...fs,
      unlink: async target => {
        if (denyCleanup && path.dirname(target) === host.lock) throw Object.assign(new Error('owner permission denied'), {code: 'EACCES'});
        return fs.unlink(target);
      }
    };
    ({host} = await fixture(t, {fs: injected, retryAttempts: 0, onCleanupError: error => warnings.push(error.message)}));
    const before = await host.read();
    denyCleanup = true;
    const result = await host.compareAndSet({...before, queue: {thread: [message('A')]}});
    assert.equal(result.applied, true);
    assert.equal(warnings.length, 1);
    assert.equal((await host.read()).revision, before.revision + 1);
    assert.equal((await host.read()).queue.thread[0].id, 'A');
    assert.ok(host.pendingCleanup);
    denyCleanup = false;
    const after = await host.read();
    assert.equal((await host.compareAndSet({...after, queue: {thread: [message('A'), message('B')]}})).applied, true);
    assert.equal(host.pendingCleanup, undefined);
    await assert.rejects(fs.stat(host.lock), {code: 'ENOENT'});
  });

  test('cleanup failure never replaces the primary operation failure', async t => {
    let host, denyCleanup = false;
    const injected = {
      ...fs,
      unlink: async target => {
        if (denyCleanup && path.dirname(target) === host.lock) throw Object.assign(new Error('owner permission denied'), {code: 'EPERM'});
        return fs.unlink(target);
      }
    };
    ({host} = await fixture(t, {fs: injected, retryAttempts: 0, onCleanupError: () => {}}));
    await host.read();
    denyCleanup = true;
    const original = new Error('primary operation failed');
    await assert.rejects(host.transaction(async () => { throw original; }), error => error === original);
    denyCleanup = false;
    await host.retryOwnCleanup();
    await assert.rejects(fs.stat(host.lock), {code: 'ENOENT'});
  });

  test('background cleanup frees followers without requiring another request from the owner', async t => {
    let host, denyCleanup = false;
    const injected = {
      ...fs,
      rmdir: async target => {
        if (denyCleanup && target === host.lock) throw Object.assign(new Error('directory busy'), {code: 'EBUSY'});
        return fs.rmdir(target);
      }
    };
    const {directory, host: created} = await fixture(t, {fs: injected, retryAttempts: 0, onCleanupError: () => {}});
    host = created;
    const before = await host.read();
    denyCleanup = true;
    assert.equal((await host.compareAndSet({...before, queue: {thread: [message('A')]}})).applied, true);
    assert.ok(host.pendingCleanup);
    assert.deepEqual(await fs.readdir(host.lock), []);
    denyCleanup = false;
    const deadline = Date.now() + 1500;
    while (host.pendingCleanup && Date.now() < deadline) await sleep(10);
    assert.equal(host.pendingCleanup, undefined);
    await assert.rejects(fs.stat(host.lock), {code: 'ENOENT'});
    const follower = new QueueStore(directory);
    const current = await follower.read();
    assert.equal((await follower.compareAndSet({...current, queue: {thread: [message('A'), message('B')]}})).applied, true);
  });

  test('the optional proposal reconciler persists and returns its document without changing the default API', async t => {
    const {host} = await fixture(t, {reconcileProposal: (current, request) => ({...current, revision: current.revision + 1, queue: request.queue, marker: 'reconciled'})});
    const snapshot = await host.read();
    const result = await host.compareAndSet({...snapshot, queue: {thread: [message('A')]}, custom: true});
    assert.equal(result.applied, true);
    assert.equal(result.queue.thread[0].id, 'A');
    assert.equal(JSON.parse(await fs.readFile(host.file, 'utf8')).marker, 'reconciled');
  });
}
