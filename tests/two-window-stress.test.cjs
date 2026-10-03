'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {QueueProtocolStore} = require('../queue-protocol.cjs');
const {createQueueClient} = require('../queue-client.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const has = (queue, id) => queue.conv?.some(message => message.id === id) ?? false;
function rng(seed) { let state = seed >>> 0; return () => (state = (state * 1664525 + 1013904223) >>> 0) / 2 ** 32; }

async function scenario(seed) {
  const random = rng(seed);
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'codex-two-window-stress-'));
  const stores = [], unsubscribers = [], errors = [];
  const legacy = {oldthread: [{id: 'old', text: 'legacy', submission: {status: 'sending'}}]};
  const makeWindow = () => {
    const store = new QueueProtocolStore(directory, () => legacy);
    stores.push(store);
    const client = createQueueClient(async (method, {params}) => {
      await sleep(random() * 4);
      if (method === 'queue-repair-read') return store.read();
      if (method === 'queue-repair-cas') return store.compareAndSet(params);
      throw Error('Unexpected queue RPC');
    }, {protocolVersion: 2, pollMs: 50, onError: error => errors.push(error)});
    unsubscribers.push(client.subscribeQueuedFollowUps(() => {}));
    return {store, client};
  };
  const a = makeWindow(), b = makeWindow();
  let stopped = false, concurrentWrites = 0;
  const other = (async () => {
    while (!stopped) {
      await sleep(random() * 25);
      try {
        await b.client.updateQueuedFollowUps(queue => ({...queue, otherwin: [{id: 'other-' + concurrentWrites}]}));
        concurrentWrites++;
      } catch (error) { errors.push(error); }
    }
  })();
  try {
    for (let index = 0; index < 60; index++) {
      const id = 'message-' + index;
      await a.client.updateQueuedFollowUps(queue => ({...queue, conv: [...(queue.conv ?? []), {id, text: 'test'}]}));
      assert.ok(has(await a.client.loadQueuedFollowUps(), id), 'Read after add');
      await sleep(10 + random() * 30);
      assert.ok(has(JSON.parse(await fs.readFile(a.store.file, 'utf8')).queue, id), 'Add persisted during competing writes');
      assert.ok(has(await b.client.loadQueuedFollowUps(), id), 'Other window sees added message');
      await a.client.updateQueuedFollowUps(queue => ({...queue, conv: (queue.conv ?? []).filter(message => message.id !== id)}));
      assert.equal(has(await a.client.loadQueuedFollowUps(), id), false, 'Read after removal');
      await sleep(10 + random() * 30);
      assert.equal(has(JSON.parse(await fs.readFile(a.store.file, 'utf8')).queue, id), false, 'Removed message stays removed');
    }
    stopped = true;
    await other;
    const document = JSON.parse(await fs.readFile(a.store.file, 'utf8'));
    assert.equal(document.queue.conv?.length ?? 0, 0);
    assert.equal(document.queue.oldthread[0].submission.status, 'outcome-unknown');
    assert.match(document.queue.oldthread[0].pausedReason, /Recovered/);
    assert.equal(Object.keys(document.retired.conv).length, 60);
    assert.ok(concurrentWrites > 0);
    assert.deepEqual(errors, []);
    return {seed, cycles: 60, concurrentWrites, lost: 0, resurrected: 0, incorrectReads: 0};
  } finally {
    stopped = true;
    await other;
    for (const unsubscribe of unsubscribers) unsubscribe();
    for (const store of stores) store.dispose();
    await sleep(70);
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('codex-two-window-stress-'));
    await fs.rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 30});
  }
}

test('180 two-window protocol cycles preserve additions and removals during competing writes', async t => {
  for (const seed of [1, 2, 3]) t.diagnostic(JSON.stringify(await scenario(seed)));
});
