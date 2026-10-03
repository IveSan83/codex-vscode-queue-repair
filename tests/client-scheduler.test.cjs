'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {createQueueClient} = require('../queue-client.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const snapshot = (revision=0, queue={}) => ({epoch:'test', revision, queue});
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve=yes; reject=no; });
  return {promise, resolve, reject};
}
async function bounded(promise) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Test operation did not complete')), 1500);
    })]);
  } finally { clearTimeout(timer); }
}

// Control copied from the original client's scheduling path: each interval
// appends load() to the same Promise tail used by a foreground update. Keep the
// real serial/read/CAS ordering, without unrelated cache and notification code.
function createOriginalSchedulingControl(fetchFromHost, options) {
  let tail = Promise.resolve();
  const serial = operation => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  const load = () => serial(() => fetchFromHost('queue-repair-read', {params:{}}));
  return {
    subscribeQueuedFollowUps() {
      const timer = setInterval(() => { load().catch(() => {}); }, options.pollMs);
      return () => clearInterval(timer);
    },
    updateQueuedFollowUps: updater => serial(async () => {
      const current = await fetchFromHost('queue-repair-read', {params:{}});
      return fetchFromHost('queue-repair-cas', {params:{
        epoch:current.epoch, revision:current.revision, queue:updater(current.queue)
      }});
    })
  };
}

async function pollingBacklogProbe(t, factory) {
  const firstRead = deferred();
  const started = deferred();
  let reads = 0;
  let writes = 0;
  const client = factory(async method => {
    if (method === 'queue-repair-read') {
      reads++;
      if (reads === 1) { started.resolve(); return firstRead.promise; }
      return snapshot();
    }
    writes++;
    return {applied:true, epoch:'test', revision:1};
  }, {pollMs:10, readTimeoutMs:1000});
  const stop = client.subscribeQueuedFollowUps(() => {});
  t.after(stop);
  t.after(() => firstRead.resolve(snapshot()));
  await bounded(started.promise);
  await sleep(80);
  stop();
  const write = client.updateQueuedFollowUps(queue => queue);
  firstRead.resolve(snapshot());
  await bounded(write);
  return {reads, writes};
}

test('control: original interval scheduler accumulates reads ahead of a user write', async t => {
  const result = await pollingBacklogProbe(t, createOriginalSchedulingControl);
  assert.ok(result.reads >= 4, `Expected queued polling reads, got ${result.reads}`);
  assert.equal(result.writes, 1);
});

test('a slow background read produces no polling backlog ahead of a user write', async t => {
  assert.deepEqual(await pollingBacklogProbe(t, createQueueClient), {reads:2, writes:1});
});

test('simultaneous explicit loads share one RPC and return independent queue copies', async () => {
  const read = deferred();
  let reads = 0;
  const client = createQueueClient(() => { reads++; return read.promise; });
  const waiting = Array.from({length:12}, () => client.loadQueuedFollowUps());
  await sleep(0);
  assert.equal(reads, 1);
  read.resolve(snapshot(1, {thread:[{id:'A'}]}));
  const results = await bounded(Promise.all(waiting));
  results[0].thread.push({id:'B'});
  assert.deepEqual(results[1].thread, [{id:'A'}]);
  assert.deepEqual(client.readQueuedFollowUps().value.thread, [{id:'A'}]);
});

test('a load requested after a write cannot coalesce with a preceding stale read', async () => {
  let doc = snapshot();
  const firstRead = deferred();
  let reads = 0;
  const client = createQueueClient(async (method, {params}) => {
    if (method === 'queue-repair-read') {
      if (++reads === 1) return firstRead.promise;
      return structuredClone(doc);
    }
    doc = snapshot(doc.revision+1, structuredClone(params.queue));
    return {applied:true, epoch:doc.epoch, revision:doc.revision};
  });
  const before = client.loadQueuedFollowUps();
  const write = client.updateQueuedFollowUps(() => ({thread:[{id:'A'}]}));
  const after = client.loadQueuedFollowUps();
  firstRead.resolve(snapshot());
  assert.deepEqual(await bounded(before), {});
  await bounded(write);
  assert.deepEqual(await bounded(after), {thread:[{id:'A'}]});
  assert.equal(reads, 3);
});

test('read deadline retains cache, ignores a late reply, and avoids duplicate hung RPCs', async () => {
  const hung = deferred();
  let reads = 0;
  let writes = 0;
  const client = createQueueClient(async method => {
    if (method !== 'queue-repair-read') { writes++; throw new Error('Unexpected write'); }
    reads++;
    if (reads === 2) return hung.promise;
    return snapshot(reads, {thread:[{id:reads === 1 ? 'saved' : 'fresh'}]});
  }, {readTimeoutMs:20});
  await client.loadQueuedFollowUps();
  await assert.rejects(client.loadQueuedFollowUps(), {code:'QUEUE_READ_TIMEOUT'});
  await assert.rejects(client.updateQueuedFollowUps(() => ({})), {code:'QUEUE_READ_TIMEOUT'});
  assert.equal(reads, 2);
  assert.equal(writes, 0);
  assert.deepEqual(client.readQueuedFollowUps().value, {thread:[{id:'saved'}]});
  hung.resolve(snapshot(99, {thread:[{id:'late'}]}));
  await sleep(0);
  assert.deepEqual(client.readQueuedFollowUps().value, {thread:[{id:'saved'}]});
  assert.deepEqual(await client.loadQueuedFollowUps(), {thread:[{id:'fresh'}]});
});

test('unsubscribing during an in-flight poll prevents late listener delivery and rescheduling', async t => {
  const read = deferred();
  const started = deferred();
  let reads = 0;
  let changes = 0;
  const client = createQueueClient(() => { reads++; started.resolve(); return read.promise; }, {pollMs:10});
  const stop = client.subscribeQueuedFollowUps(() => changes++);
  t.after(stop);
  t.after(() => read.resolve(snapshot()));
  await bounded(started.promise);
  stop();
  read.resolve(snapshot());
  await sleep(50);
  assert.equal(changes, 0);
  assert.equal(reads, 1);
});

test('disposing a listener during notification suppresses its queued callback', async t => {
  const client = createQueueClient(async () => snapshot());
  let secondCalls = 0;
  let stopSecond;
  const stopFirst = client.subscribeQueuedFollowUps(() => stopSecond());
  stopSecond = client.subscribeQueuedFollowUps(() => secondCalls++);
  t.after(stopFirst);
  t.after(stopSecond);
  await client.loadQueuedFollowUps();
  await sleep(0);
  assert.equal(secondCalls, 0);
});

test('repeated polling errors preserve cache and report the same failure once', async t => {
  let fail = false;
  let reads = 0;
  const repeatedRead = deferred();
  const errors = [];
  const client = createQueueClient(async () => {
    reads++;
    if (reads >= 3) repeatedRead.resolve();
    if (fail) throw new Error('Temporary read failure');
    return snapshot(1, {thread:[{id:'saved'}]});
  }, {pollMs:10, onError:error => errors.push(error.message)});
  await client.loadQueuedFollowUps();
  fail = true;
  const stop = client.subscribeQueuedFollowUps(() => {});
  t.after(stop);
  await bounded(repeatedRead.promise);
  stop();
  assert.ok(reads >= 3);
  assert.deepEqual(errors, ['Temporary read failure']);
  assert.deepEqual(client.readQueuedFollowUps().value, {thread:[{id:'saved'}]});
});

test('a lost CAS reply is explicitly ambiguous and neither storage mutation nor updater is repeated', async () => {
  let doc = snapshot();
  let writes = 0;
  let updaterCalls = 0;
  const client = createQueueClient(async (method, {params}) => {
    if (method === 'queue-repair-read') return structuredClone(doc);
    writes++;
    doc = snapshot(1, structuredClone(params.queue));
    throw new Error('Reply transport timed out after commit');
  });
  await assert.rejects(client.updateQueuedFollowUps(() => {
    updaterCalls++;
    return {thread:[{id:'A'}]};
  }), {code:'QUEUE_WRITE_OUTCOME_UNKNOWN'});
  assert.equal(writes, 1);
  assert.equal(updaterCalls, 1);
  assert.deepEqual(await client.loadQueuedFollowUps(), {thread:[{id:'A'}]});
});

test('the read deadline never times out an in-flight CAS', async () => {
  const response = deferred();
  const started = deferred();
  const client = createQueueClient(async method => {
    if (method === 'queue-repair-read') return snapshot();
    started.resolve();
    return response.promise;
  }, {readTimeoutMs:20});
  let settled = false;
  const update = client.updateQueuedFollowUps(() => ({}));
  update.then(() => { settled=true; }, () => { settled=true; });
  await bounded(started.promise);
  await sleep(50);
  assert.equal(settled, false);
  response.resolve({applied:true, epoch:'test', revision:1});
  await bounded(update);
});

test('canonical server queue replaces stale input, and protocol metadata is sent only in CAS parameters', async () => {
  const calls = [];
  const canonical = {thread:[{id:'kept'}]};
  const client = createQueueClient(async (method, {params}) => {
    calls.push({method, params});
    if (method === 'queue-repair-read') return snapshot(1, canonical);
    return {applied:true, epoch:'test', revision:2, queue:structuredClone(canonical)};
  }, {protocolVersion:2});
  const result = await client.updateQueuedFollowUps(
    () => ({thread:[{id:'kept'}, {id:'retired'}]}),
    {restores:['explicit-restore']}
  );
  assert.deepEqual(calls[0], {method:'queue-repair-read', params:{}});
  assert.equal(calls[1].params.protocolVersion, 2);
  assert.deepEqual(calls[1].params.restores, ['explicit-restore']);
  assert.equal(calls[1].params.queue.thread.length, 2);
  assert.deepEqual(result, canonical);
  assert.deepEqual(client.readQueuedFollowUps().value, canonical);
  assert.equal(Object.hasOwn(result, 'restores'), false);
});

test('a second protocol hint arriving during a read triggers a fresh read after that snapshot', async t => {
  let revision = 0;
  let reads = 0;
  let hint;
  const started = deferred();
  const delayed = deferred();
  const client = createQueueClient(async () => {
    reads++;
    const result = snapshot(revision, {thread:[{id:String(revision)}]});
    if (reads === 2) { started.resolve(); await delayed.promise; }
    return result;
  }, {
    protocolVersion:2, pollMs:100000,
    subscribeHints:callback => { hint=callback; return () => {}; }
  });
  t.after(() => delayed.resolve());
  await client.loadQueuedFollowUps();
  const stop = client.subscribeQueuedFollowUps(() => {});
  t.after(stop);
  hint();
  await bounded(started.promise);
  revision = 1;
  hint();
  delayed.resolve();
  await sleep(20);
  assert.equal(reads, 3);
  assert.deepEqual(client.readQueuedFollowUps().value.thread, [{id:'1'}]);
});

test('many synchronous hints coalesce and disposal prevents a scheduled hint refresh', async t => {
  let reads = 0;
  let hint;
  let stops = 0;
  const client = createQueueClient(async () => { reads++; return snapshot(reads); }, {
    pollMs:100000,
    subscribeHints:callback => { hint=callback; return () => { stops++; }; }
  });
  await client.loadQueuedFollowUps();
  const stop = client.subscribeQueuedFollowUps(() => {});
  t.after(stop);
  for (let index=0; index<20; index++) hint();
  await sleep(20);
  assert.equal(reads, 2);
  hint();
  stop();
  await sleep(20);
  assert.equal(reads, 2);
  assert.equal(stops, 1);
});
