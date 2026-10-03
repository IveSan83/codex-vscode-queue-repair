'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const watchFs = require('node:fs');
const {EventEmitter} = require('node:events');
const os = require('node:os');
const path = require('node:path');
const {QueueProtocolStore} = require('../queue-protocol.cjs');
const {createQueueClient} = require('../queue-client.cjs');

const clone = value => structuredClone(value);
const message = (id, text=id) => ({id, text, context:{}, submission:{hostId:'local', status:'pending'}});
const operation = (id, generation=0) => ({conversationId:'thread', id, generation});
const ids = state => (state.thread ?? []).map(item => item.id);

async function fixture(t, options={}) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'codex-queue-protocol-'));
  const stores = [];
  const makeStore = extra => {
    const store = new QueueProtocolStore(directory, () => ({}), {...options, ...extra});
    stores.push(store);
    return store;
  };
  const makeClient = store => createQueueClient(
    (method, {params}) => method === 'queue-repair-read' ? store.read() : store.compareAndSet(params),
    {protocolVersion:2}
  );
  const host = makeStore();
  const client = makeClient(host);
  t.after(async () => {
    for (const store of stores) store.dispose();
    // Resolve and verify the exact unique test directory before recursive cleanup.
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('codex-queue-protocol-'));
    await fs.rm(resolved, {recursive:true, force:true, maxRetries:3, retryDelay:30});
  });
  return {directory, host, client, makeStore, makeClient};
}

async function seedAndRetire(client) {
  const old = await client.updateQueuedFollowUps(() => ({thread:[message('A'), message('B')]}));
  await client.updateQueuedFollowUps(
    state => ({...state, thread:state.thread.filter(item => item.id !== 'A')}),
    {removals:[operation('A')]}
  );
  return old;
}

async function restore(client, old) {
  return client.updateQueuedFollowUps(
    state => ({...state, thread:[...state.thread, clone(old.thread[0])]}),
    {restores:[operation('A')]}
  );
}

test('retirement blocks a stale payload even when the client reads a fresh CAS revision', async t => {
  const {host, client, makeClient} = await fixture(t);
  const old = await seedAndRetire(client);
  const follower = makeClient(host);
  const canonical = await follower.updateQueuedFollowUps(() => clone(old));
  assert.deepEqual(ids(canonical), ['B']);
  assert.deepEqual(follower.readQueuedFollowUps().value, canonical);
  assert.deepEqual((await host.read()).queue, canonical);
  const document = JSON.parse(await fs.readFile(host.file, 'utf8'));
  assert.equal(document.retired.thread.A.generation, 0);
});

test('explicit Undo advances generation and an old snapshot cannot overwrite the restored entry', async t => {
  const {client} = await fixture(t);
  const old = await seedAndRetire(client);
  const restored = await restore(client, old);
  const expected = restored.thread.find(item => item.id === 'A');
  assert.equal(expected.queueRepairGeneration, 1);
  const stale = clone(old);
  stale.thread[0].text = 'stale edit before Undo';
  const result = await client.updateQueuedFollowUps(() => stale);
  assert.deepEqual(result.thread.find(item => item.id === 'A'), expected);
});

test('an explicit removal from generation zero cannot remove an Undo at generation one', async t => {
  const {client} = await fixture(t);
  const old = await seedAndRetire(client);
  await restore(client, old);
  const result = await client.updateQueuedFollowUps(
    state => ({...state, thread:state.thread.filter(item => item.id !== 'A')}),
    {removals:[operation('A', 0)]}
  );
  assert.equal(result.thread.find(item => item.id === 'A').queueRepairGeneration, 1);
});

test('incorrect restore metadata or incoming generations are rejected without changing the document', async t => {
  const {host, client} = await fixture(t);
  const old = await seedAndRetire(client);
  const before = await fs.readFile(host.file, 'utf8');
  for (const [metadataGeneration, incomingGeneration] of [[1,0], [-1,0], [0.5,0], [0,1]]) {
    const incoming = {...clone(old.thread[0]), queueRepairGeneration:incomingGeneration};
    await assert.rejects(client.updateQueuedFollowUps(
      state => ({...state, thread:[...state.thread, incoming]}),
      {restores:[operation('A', metadataGeneration)]}
    ), /generation|newer removal/);
    assert.equal(await fs.readFile(host.file, 'utf8'), before);
  }
});

test('retirement persists across a new host and client instance', async t => {
  const {host, client, makeStore, makeClient} = await fixture(t);
  const old = await seedAndRetire(client);
  host.dispose();
  const restarted = makeStore();
  const nextClient = makeClient(restarted);
  assert.deepEqual(ids(await nextClient.updateQueuedFollowUps(() => clone(old))), ['B']);
  assert.equal((await restarted.readExisting()).retired.thread.A.generation, 0);
});

test('corrupt or missing retirement records in a v2 journal are errors, never empty success', async t => {
  const {host, client, makeStore} = await fixture(t);
  await seedAndRetire(client);
  const original = await host.readExisting();
  for (const invalid of [null, [], {thread:{A:{generation:-1, revision:1}}}, undefined]) {
    const broken = clone(original);
    if (invalid === undefined) delete broken.retired;
    else broken.retired = invalid;
    await fs.writeFile(host.file, JSON.stringify(broken));
    await assert.rejects(makeStore().read(), /retired/);
  }
});

test('a proposal carrying a foreign epoch cannot implicitly retire the current message', async t => {
  const {host, client} = await fixture(t);
  const original = await client.updateQueuedFollowUps(() => ({thread:[message('A')]}));
  const stale = clone(original);
  stale.thread[0].queueRepairEpoch = 'different-storage-epoch';
  // Either reject the invalid proposal or keep the existing message; dropping
  // its payload must never be interpreted as explicit deletion of the live ID.
  await client.updateQueuedFollowUps(() => stale).catch(() => {});
  assert.deepEqual(ids((await host.read()).queue), ['A']);
});

test('throwing hint listeners and their diagnostics cannot turn a committed write into failure', async t => {
  let notifications = 0;
  const {host, client} = await fixture(t, {
    onHint:hint => { if (hint.revision > 0) { notifications++; throw new Error('Listener failure'); } },
    onHintError:() => { throw new Error('Diagnostics failure'); }
  });
  // Isolate the synchronous post-commit notification path from fs.watch events.
  host.startWatcher = () => {};
  await client.loadQueuedFollowUps();
  notifications=0;
  const result = await client.updateQueuedFollowUps(() => ({thread:[message('A')]}));
  assert.deepEqual(ids(result), ['A']);
  assert.deepEqual(ids((await host.read()).queue), ['A']);
  assert.equal(notifications, 1);
});

test('watcher errors close the watcher even when diagnostics throw', async t => {
  const watcher = new EventEmitter();
  watcher.unref = () => {};
  watcher.close = () => { watcher.closed = true; };
  t.mock.method(watchFs, 'watch', () => watcher);
  const {host} = await fixture(t, {onHint:() => {}, onHintError:() => { throw new Error('Diagnostics failure'); }});
  await host.read();
  assert.doesNotThrow(() => watcher.emit('error', new Error('Watcher failure')));
  assert.equal(watcher.closed, true);
  assert.equal(host.watcher, undefined);
});

test('watcher read errors do not create an unhandled rejection when diagnostics throw', async t => {
  const watcher = new EventEmitter();
  watcher.unref = () => {};
  watcher.close = () => {};
  let event;
  t.mock.method(watchFs, 'watch', (_directory, callback) => { event=callback; return watcher; });
  const {host} = await fixture(t, {onHint:() => {}, onHintError:() => { throw new Error('Diagnostics failure'); }});
  await host.read();
  await fs.writeFile(host.file, '{broken');
  event('rename', 'queue.json');
  assert.ok(host.hintFlight);
  await assert.doesNotReject(host.hintFlight);
  assert.equal(host.hintFlight, undefined);
});

test('a CAS conflict cannot upgrade an earlier removal intent to a concurrently restored generation', async t => {
  const {host, client} = await fixture(t);
  const initial = await client.updateQueuedFollowUps(() => ({thread:[message('A'), message('B')]}));
  let attempts = 0;
  const racingClient = createQueueClient(async (method, {params}) => {
    if (method === 'queue-repair-read') return host.read();
    attempts++;
    if (attempts === 1) {
      await client.updateQueuedFollowUps(state => ({...state, thread:state.thread.filter(item => item.id !== 'A')}));
      await restore(client, initial);
    }
    return host.compareAndSet(params);
  }, {protocolVersion:2});
  const result = await racingClient.updateQueuedFollowUps(state => ({...state, thread:state.thread.filter(item => item.id !== 'A')}));
  assert.equal(attempts, 2);
  assert.equal(result.thread.find(item => item.id === 'A').queueRepairGeneration, 1);
  assert.deepEqual(racingClient.readQueuedFollowUps().value, (await host.read()).queue);
});
