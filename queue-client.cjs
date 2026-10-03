'use strict';

// Injected as a self-contained function in the webview storage adapter.
function createQueueClient(fetchFromHost, options = {}) {
  let cache;
  let tail = Promise.resolve();
  let timer;
  let pollGeneration = 0;
  let writeGeneration = 0;
  let pendingOperations = 0;
  let loadFlight;
  let hostRead;
  let stopHints;
  let hintPending = false;
  let hintDrainScheduled = false;
  let lastReportedError;
  const listeners = new Set();
  const pollMs = options.pollMs ?? 1000;
  const readTimeoutMs = options.readTimeoutMs ?? 5000;
  if (!Number.isFinite(pollMs) || pollMs <= 0 || !Number.isFinite(readTimeoutMs) || readTimeoutMs <= 0) throw new Error('Queue polling and read timeout must be positive finite durations');
  const clone = value => JSON.parse(JSON.stringify(value));
  const serial = operation => {
    pendingOperations++;
    const result = tail.then(async () => {
      try { return await operation(); }
      finally { pendingOperations--; scheduleHintDrain(); }
    });
    tail = result.catch(() => {});
    return result;
  };
  const report = error => {
    const key = `${error?.name}:${error?.message}`;
    if (key === lastReportedError) return;
    lastReportedError = key;
    // A diagnostics callback must not break polling or another listener.
    try { options.onError?.(error); } catch {}
  };
  const readSnapshot = async () => {
    // A timed-out RPC can still be pending in the transport. Reuse that request
    // rather than creating an unbounded set of background requests behind it.
    if (!hostRead) {
      const request = Promise.resolve().then(() => fetchFromHost('queue-repair-read', {params:{}}));
      hostRead = request;
      const clear = () => { if (hostRead === request) hostRead = undefined; };
      request.then(clear, clear);
    }
    const request = hostRead;
    let deadline;
    try {
      return await Promise.race([
        request,
        new Promise((_, reject) => {
          deadline = setTimeout(() => {
            const error = new Error('Codex queue storage read timed out. The last known queue was retained.');
            error.code = 'QUEUE_READ_TIMEOUT';
            reject(error);
          }, readTimeoutMs);
        })
      ]);
    } finally { clearTimeout(deadline); }
  };
  const remember = snapshot => {
    if (cache && cache.epoch === snapshot.epoch && snapshot.revision < cache.revision) throw new Error('Codex queue storage returned an older revision');
    const changed = !cache || cache.epoch !== snapshot.epoch || cache.revision !== snapshot.revision;
    cache = snapshot;
    lastReportedError = undefined;
    if (changed) {
      const recipients = [...listeners];
      queueMicrotask(() => {
        for (const recipient of recipients) {
          if (!listeners.has(recipient)) continue;
          try { recipient.listener(); } catch (error) { report(error); }
        }
      });
    }
  };
  const load = () => {
    // Coalesce reads only on the same side of a requested write. A read made
    // after updateQueuedFollowUps must observe that operation's result.
    if (loadFlight?.generation === writeGeneration) return loadFlight.promise.then(clone);
    const flight = {generation:writeGeneration};
    loadFlight = flight;
    flight.promise = serial(async () => {
      const snapshot = await readSnapshot();
      remember(snapshot);
      return snapshot.queue;
    });
    const clear = () => {
      if (loadFlight === flight) loadFlight = undefined;
      scheduleHintDrain();
    };
    flight.promise.then(clear, clear);
    return flight.promise.then(clone);
  };
  const schedulePoll = generation => {
    if (listeners.size === 0 || generation !== pollGeneration) return;
    timer = setTimeout(async () => {
      timer = undefined;
      if (listeners.size === 0 || generation !== pollGeneration) return;
      // Never add background work behind foreground operations. The next poll
      // is scheduled only when this one finishes, so slow reads cannot pile up.
      if (pendingOperations === 0) {
        try { await load(); }
        catch (error) { report(error); }
      }
      schedulePoll(generation);
    }, pollMs);
    timer.unref?.();
  };
  const scheduleHintDrain = () => {
    if (!hintPending || hintDrainScheduled || listeners.size === 0 || pendingOperations !== 0 || loadFlight) return;
    hintDrainScheduled = true;
    queueMicrotask(() => {
      hintDrainScheduled = false;
      if (listeners.size === 0) { hintPending = false; return; }
      if (!hintPending || pendingOperations !== 0 || loadFlight) return;
      hintPending = false;
      load().catch(report);
    });
  };
  const refreshHint = () => {
    if (listeners.size === 0) return;
    hintPending = true;
    // Drain only after a completed load clears its coalescing slot. Otherwise
    // a hint arriving during that read would reuse its stale result and vanish.
    scheduleHintDrain();
  };
  return {
    readQueuedFollowUps: () => ({isLoading:cache == null, value:cache?.queue}),
    loadQueuedFollowUps: load,
    updateQueuedFollowUps: (updater, metadata = {}) => {
      writeGeneration++;
      return serial(async () => {
        let removals=metadata.removals;
        for (let attempt=0; attempt<64; attempt++) {
          const snapshot = await readSnapshot();
          const next = updater(clone(snapshot.queue));
          // Capture deletion intent once. Retrying against a newer revision
          // must not turn an old removal into a deletion of a restored entry.
          if(removals==null)removals=Object.entries(snapshot.queue).flatMap(([conversationId,messages])=>messages.filter(message=>!(next[conversationId]??[]).some(m=>m.id===message.id)).map(message=>({conversationId,id:message.id,generation:message.queueRepairGeneration??0})));
          let result;
          try {
            result = await fetchFromHost('queue-repair-cas', {params:{
              epoch:snapshot.epoch, revision:snapshot.revision, queue:next,
              protocolVersion:options.protocolVersion ?? undefined,
              restores:metadata.restores ?? [], removals
            }});
            if (typeof result?.applied !== 'boolean') throw new Error('Invalid queue write response');
          } catch (cause) {
            // A transport failure can happen after commit. Only an explicit
            // applied:false permits retry; never infer that a lost reply failed.
            const error = new Error(`Codex queue write outcome is unknown: ${cause?.message ?? cause}. Check the saved queue before retrying.`);
            error.code = 'QUEUE_WRITE_OUTCOME_UNKNOWN';
            error.cause = cause;
            throw error;
          }
          if (result.applied) {
            const committed = result.queue ?? next;
            remember({epoch:result.epoch, revision:result.revision, queue:clone(committed)});
            return committed;
          }
          await new Promise(resolve => setTimeout(resolve, Math.min(attempt * 2, 30)));
        }
        throw new Error('Codex queue changed repeatedly in another window. Submission was not committed.');
      });
    },
    subscribeQueuedFollowUps: listener => {
      const recipient = {listener};
      const wasEmpty = listeners.size === 0;
      listeners.add(recipient);
      if (wasEmpty) {
        schedulePoll(++pollGeneration);
        try{stopHints=options.subscribeHints?.(refreshHint)}catch(error){report(error)}
      }
      return () => {
        if (!listeners.delete(recipient)) return;
        if (listeners.size === 0) {
          pollGeneration++;
          clearTimeout(timer);
          timer = undefined;
          hintPending=false;
          try{stopHints?.()}catch(error){report(error)}
          stopHints=undefined;
        }
      };
    }
  };
}

module.exports = {createQueueClient};
