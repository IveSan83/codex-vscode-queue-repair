'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {QueueProtocolStore} = require('../queue-protocol.cjs');
const {createQueueClient} = require('../queue-client.cjs');
const {engine, message, json, until, wait} = require('./coordinator-harness.cjs');

async function fixture(t) {
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(temporaryRoot, 'codex-coordinator-v2-review-'));
  const stores = [];
  const engines = [];
  const requests = [];
  let beforeCas;
  const makeStore = () => {
    const store = new QueueProtocolStore(directory);
    stores.push(store);
    return store;
  };
  const makeClient = store => createQueueClient((method, {params}) => method === 'queue-repair-read' ? store.read() : store.compareAndSet(params), {protocolVersion: 2});
  const host = makeStore();
  const client = createQueueClient(async (method, {params}) => {
    if (method === 'queue-repair-read') return host.read();
    requests.push(json(params));
    const barrier = beforeCas;
    beforeCas = undefined;
    await barrier?.();
    return host.compareAndSet(params);
  }, {protocolVersion: 2});
  const storage = {read: client.readQueuedFollowUps, load: client.loadQueuedFollowUps, update: client.updateQueuedFollowUps};
  const makeEngine = (options, alternateClient) => {
    const alternateStorage = alternateClient && {read: alternateClient.readQueuedFollowUps, load: alternateClient.loadQueuedFollowUps, update: alternateClient.updateQueuedFollowUps};
    const coordinator = engine(true, alternateStorage ?? storage, options);
    engines.push(coordinator);
    return coordinator;
  };
  t.after(async () => {
    for (const coordinator of engines) coordinator.instance.dispose();
    for (const store of stores) store.dispose();
    // Verify our unique direct child of the real system temp root before any
    // recursive Windows cleanup. No shared extension or profile files are used.
    const resolved = await fs.realpath(directory);
    assert.equal(path.dirname(resolved), temporaryRoot);
    assert.ok(path.basename(resolved).startsWith('codex-coordinator-v2-review-'));
    await fs.rm(resolved, {recursive: true, force: true, maxRetries: 3, retryDelay: 30});
  });
  return {directory, host, client, makeStore, makeClient, makeEngine, requests, beforeCas: callback => { beforeCas = callback; }};
}

async function retireAndRestore(client, previous) {
  await client.updateQueuedFollowUps(
    state => ({...state, thread: state.thread.filter(item => item.id !== previous.id)}),
    {removals: [{conversationId: 'thread', id: previous.id, generation: previous.queueRepairGeneration ?? 0}]}
  );
  return client.updateQueuedFollowUps(
    state => ({...state, thread: [...(state.thread ?? []), {...previous, text: 'fresh after Undo'}]}),
    {restores: [{conversationId: 'thread', id: previous.id, generation: previous.queueRepairGeneration ?? 0}]}
  );
}

test('an implicit generation-zero removal cannot delete a restored generation-one message after CAS retry', async t => {
  const f = await fixture(t);
  const coordinator = f.makeEngine({ready: false});
  await coordinator.instance.acceptFromFollower('thread', [message('A')]);
  const previous = (await f.host.read()).queue.thread[0];
  const external = f.makeClient(f.makeStore());
  f.requests.length = 0;
  f.beforeCas(() => retireAndRestore(external, previous));
  // Same private mutation path as receipt/send-completion removal, without the
  // explicit discardedMessageIds argument used by user delete and clear.
  coordinator.instance.mutate('thread', queue => queue.filter(item => item.id !== 'A'));
  await until(() => coordinator.quiet(), 'implicit removal CAS retry');
  const canonical = (await f.host.read()).queue.thread[0];
  assert.equal(canonical.id, 'A');
  assert.equal(canonical.queueRepairGeneration, 1);
  assert.equal(canonical.text, 'fresh after Undo');
  assert.deepEqual(json(coordinator.instance.readMessages('thread')), [canonical]);
  assert.equal(f.requests.length, 2);
  assert.deepEqual(f.requests.map(request => request.removals), [
    [{conversationId: 'thread', id: 'A', generation: 0}],
    [{conversationId: 'thread', id: 'A', generation: 0}]
  ]);
  assert.equal(coordinator.calls.length, 0);
});

for (const operation of ['remove', 'clear']) {
  test(`a stale ${operation} does not report a restored message as removed when canonical storage keeps it`, async t => {
    const f = await fixture(t);
    const coordinator = f.makeEngine({ready: false});
    await coordinator.instance.acceptFromFollower('thread', [message('A')]);
    const previous = (await f.host.read()).queue.thread[0];
    await retireAndRestore(f.makeClient(f.makeStore()), previous);
    const result = operation === 'remove' ?
      await coordinator.instance.removeQueuedMessage('thread', 'A') :
      await coordinator.instance.clearQueuedMessages('thread');
    const canonical = (await f.host.read()).queue.thread[0];
    assert.equal(canonical.id, 'A');
    assert.equal(canonical.queueRepairGeneration, 1);
    assert.deepEqual(json(coordinator.instance.readMessages('thread')), [canonical]);
    if (operation === 'remove') assert.equal(result, null);
    else assert.deepEqual(json(result), []);
    assert.equal(coordinator.calls.length, 0);
  });
}

test('a pending v1 journal entry is canonical before sending and does not become uncertain without a model call', async t => {
  const f = await fixture(t);
  await fs.mkdir(f.host.directory, {recursive: true});
  await fs.writeFile(f.host.file, JSON.stringify({format: 1, epoch: 'legacy-epoch', revision: 0, queue: {thread: [message('legacy-pending')]}}));
  await f.client.loadQueuedFollowUps();
  const coordinator = f.makeEngine({ready: true});
  await until(() => coordinator.calls.length === 1, 'pending v1 entry sends once');
  await until(() => coordinator.quiet(), 'pending v1 entry reconciliation');
  assert.equal(coordinator.calls[0].id, 'legacy-pending');
  assert.deepEqual((await f.host.read()).queue, {});
  assert.equal(coordinator.errors.length, 0);
});

test('partial history does not replay an uncertain message, and a later positive receipt removes it without sending', async t => {
  const f = await fixture(t);
  const uncertain = {...message('accepted-earlier'), pausedReason: 'submission-outcome-unknown', submission: {hostId: 'local', status: 'outcome-unknown'}};
  await f.client.updateQueuedFollowUps(() => ({thread: [uncertain]}));
  const accepted = new Set();
  const coordinator = f.makeEngine({ready: true, accepted});
  await wait(50);
  assert.equal(coordinator.calls.length, 0);
  assert.equal((await f.host.read()).queue.thread[0].submission.status, 'outcome-unknown');
  accepted.add('accepted-earlier');
  coordinator.setReady(true);
  await until(() => coordinator.instance.readMessages('thread')?.length === 0, 'later positive receipt removes saved entry');
  await until(() => coordinator.quiet(), 'receipt reconciliation completes');
  assert.deepEqual((await f.host.read()).queue, {});
  assert.equal(coordinator.calls.length, 0);
});

test('a follower receives canonical restored state through RPC even when every owner broadcast is lost', async t => {
  const f = await fixture(t);
  let broadcasts = 0, requests = 0;
  const lostBroadcasts = {
    registerBroadcastHandler: () => () => {},
    broadcast: async () => { broadcasts++; }
  };
  const owner = f.makeEngine({ready: false, coordination: lostBroadcasts});
  await owner.instance.acceptFromFollower('thread', [message('A'), message('B')]);
  const followerClient = f.makeClient(f.makeStore());
  await followerClient.loadQueuedFollowUps();
  const follower = f.makeEngine({
    ready: false, initialRole: 'follower', coordination: lostBroadcasts,
    requestFollower: async (thread, state, ownerClientId, discarded, restores, removals) => {
      requests++;
      assert.equal(ownerClientId, 'owner');
      await owner.instance.acceptFromFollower(thread, state[thread] ?? [], discarded, restores, removals);
      // Same canonical local response as the patched RPC handler. No broadcast
      // is delivered, no polling subscriber exists, and no extra refresh runs.
      return {resultType: 'success', result: {ok: true, messages: json(owner.instance.readLocalMessages(thread))}};
    }
  }, followerClient);

  const removed = await owner.instance.removeQueuedMessage('thread', 'A');
  await owner.instance.restoreQueuedMessage('thread', {...removed, message: {...removed.message, text: 'restored after stale follower snapshot'}});
  await owner.instance.removeQueuedMessage('thread', 'B');
  assert.deepEqual(follower.instance.readMessages('thread').map(item => item.id), ['A', 'B']);
  assert.equal(follower.instance.readMessages('thread')[0].queueRepairGeneration, 0);

  const staleRemoval = await follower.instance.removeQueuedMessage('thread', 'A');
  const canonical = (await f.host.read()).queue.thread;
  assert.equal(staleRemoval, null);
  assert.equal(requests, 1);
  assert.ok(broadcasts >= 4);
  assert.deepEqual(json(follower.instance.readLocalMessages('thread')), canonical);
  assert.deepEqual(canonical.map(item => item.id), ['A']);
  assert.equal(canonical[0].queueRepairGeneration, 1);
  assert.equal(canonical[0].text, 'restored after stale follower snapshot');
  assert.equal(owner.calls.length + follower.calls.length, 0);
});

test('a sender with stale pending state does not send after a different writer already persisted sending during CAS retry', async t => {
  const f = await fixture(t);
  const coordinator = f.makeEngine({ready: false});
  await coordinator.instance.acceptFromFollower('thread', [message('A')]);
  const external = f.makeClient(f.makeStore());
  f.beforeCas(() => external.updateQueuedFollowUps(state => ({
    ...state,
    thread: state.thread.map(item => ({...item, submission: {...item.submission, status: 'sending'}}))
  })));
  // Another writer's persisted sending status is uncertain even when the
  // conversation history has not loaded a positive receipt yet. A no-op retry
  // must not count as this sender successfully claiming that transition.
  coordinator.setReady(true);
  await until(() => coordinator.quiet(), 'sending transition conflict reconciled');
  assert.equal(coordinator.calls.length, 0);
  const saved = (await f.host.read()).queue.thread[0];
  assert.equal(saved.id, 'A');
  assert.ok(['sending', 'outcome-unknown'].includes(saved.submission.status));
});
