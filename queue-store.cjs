'use strict';

// This store deliberately does not use VS Code's whole-extension Memento snapshot.
// All windows of one extension profile share the same revisioned file and lock.
const fs = require('node:fs/promises');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const transientFsErrors = new Set(['EPERM', 'EACCES', 'EBUSY']);
const ownerName = token => `owner-${token}.json`;
const ownerPattern = /^owner-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;

function validateQueue(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid queue state');
  for (const messages of Object.values(value)) {
    if (!Array.isArray(messages)) throw new Error('Invalid conversation queue');
    const ids = new Set();
    for (const message of messages) {
      if (!message || typeof message.id !== 'string' || !message.id || ids.has(message.id)) throw new Error('Invalid or duplicate queued message ID');
      ids.add(message.id);
    }
  }
}

class QueueStore {
  constructor(directory, readLegacy = () => ({}), options = {}) {
    if (!path.isAbsolute(directory)) throw new Error('Queue storage needs an absolute profile path');
    this.directory = path.join(directory, 'queue-repair-v1');
    this.file = path.join(this.directory, 'queue.json');
    // Keep the original name occupied permanently: old v1 hosts use open('wx')
    // on this path and must never write beside the new locking protocol.
    this.compatibilityLock = path.join(this.directory, 'writer.lock');
    this.lock = path.join(this.compatibilityLock, 'active');
    this.readLegacy = readLegacy;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.initialized = false;
    this.fs = options.fs ?? fs;
    this.hooks = options.hooks ?? {};
    this.reconcileProposal = options.reconcileProposal;
    this.probePid = options.probePid ?? (pid => process.kill(pid, 0));
    this.retryAttempts = options.retryAttempts ?? 30;
    this.retryDelay = options.retryDelay ?? (attempt => Math.min(10 * (attempt + 1), 100));
    this.onCleanupError = options.onCleanupError ?? ((error) => console.warn('Codex queue storage: transaction completed; lock cleanup will retry.', error.message));
    this.pendingCleanup = undefined;
    this.cleanupTask = undefined;
    this.cleanupTimer = undefined;
  }

  async retryFs(operation, ignored = []) {
    for (let attempt = 0;; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (ignored.includes(error.code)) return;
        if (!transientFsErrors.has(error.code) || attempt >= this.retryAttempts) throw error;
        await delay(this.retryDelay(attempt));
      }
    }
  }

  lockedError(reason) {
    return new Error(`Codex queue storage is locked. ${reason} The draft was not committed. Inspect queue-repair-v1/writer.lock/active; do not remove a live owner's lock.`);
  }

  async ensureCompatibilityGate() {
    await this.retryFs(() => this.fs.mkdir(this.directory, {recursive: true}));
    try { await this.retryFs(() => this.fs.mkdir(this.compatibilityLock, {mode: 0o700})); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await this.fs.lstat(this.compatibilityLock);
      if (!existing.isDirectory() || existing.isSymbolicLink()) {
        // Never unlink a legacy v1 lock: a delayed remover could delete a newer
        // owner's file. Existing v1 operations finish under their own protocol.
        throw this.lockedError('A legacy writer.lock file exists. Close old v1 extension hosts and inspect that file before upgrading.');
      }
    }
  }

  async removeOwner(owner) {
    await this.hooks.beforeRemoveOwner?.(owner);
    // UUID is part of the PATH, not merely a value checked before unlink.
    // A delayed old remover therefore cannot unlink a replacement owner's file.
    await this.retryFs(() => this.fs.unlink(path.join(this.lock, ownerName(owner.token))), ['ENOENT']);
    await this.retryFs(() => this.fs.rmdir(this.lock), ['ENOENT', 'ENOTEMPTY', 'EEXIST']);
  }

  async recoverDeadOwner() {
    let stat;
    try { stat = await this.fs.lstat(this.lock); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw this.lockedError('Unsupported active lock record.');
    const names = await this.fs.readdir(this.lock).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
    if (!names.length) {
      // Acquisition publishes only nonempty directories, so removing an empty
      // directory cannot remove a writer that is still initializing metadata.
      await this.retryFs(() => this.fs.rmdir(this.lock), ['ENOENT', 'ENOTEMPTY', 'EEXIST']);
      return;
    }
    const match = names.length === 1 && ownerPattern.exec(names[0]);
    if (!match) throw this.lockedError('Invalid active lock metadata; automatic recovery is unsafe.');
    let owner;
    try { owner = JSON.parse(await this.fs.readFile(path.join(this.lock, names[0]), 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return;
      if (error instanceof SyntaxError) throw this.lockedError('Invalid active lock JSON; automatic recovery is unsafe.');
      throw error;
    }
    if (!owner || typeof owner !== 'object' || Array.isArray(owner) || owner.format !== 2 || owner.token !== match[1] || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.created !== 'string' || !Number.isFinite(Date.parse(owner.created))) {
      throw this.lockedError('Invalid active lock owner; automatic recovery is unsafe.');
    }
    let dead = false;
    try { this.probePid(owner.pid); }
    catch (error) { dead = error.code === 'ESRCH'; }
    // Permission errors, live/hung owners, and a reused live PID all retain the
    // lock. Age alone is never evidence that the writer can no longer resume.
    if (dead) await this.removeOwner(owner);
  }

  scheduleCleanup() {
    if (!this.pendingCleanup || this.cleanupTimer) return;
    this.cleanupTimer = setTimeout(() => {
      this.cleanupTimer = undefined;
      this.retryOwnCleanup().finally(() => this.scheduleCleanup());
    }, 100);
    this.cleanupTimer.unref?.();
  }

  async retryOwnCleanup() {
    if (this.cleanupTask) return this.cleanupTask;
    const owner = this.pendingCleanup;
    if (!owner) return;
    this.cleanupTask = (async () => {
      try {
        await this.removeOwner(owner);
        if (this.pendingCleanup === owner) this.pendingCleanup = undefined;
      } catch (_) { /* The next attempt retains exactly the same owner UUID. */ }
      finally { this.cleanupTask = undefined; }
    })();
    return this.cleanupTask;
  }

  async acquireLock() {
    await this.ensureCompatibilityGate();
    const owner = {format: 2, token: randomUUID(), pid: process.pid, created: new Date().toISOString()};
    const candidate = path.join(this.compatibilityLock, `.candidate-${process.pid}-${owner.token}`);
    await this.retryFs(() => this.fs.mkdir(candidate, {mode: 0o700}));
    let published = false;
    try {
      await this.fs.writeFile(path.join(candidate, ownerName(owner.token)), JSON.stringify(owner), {flag: 'wx', mode: 0o600});
      await this.hooks.afterCandidatePrepared?.(owner);
      const started = Date.now();
      for (;;) {
        await this.retryOwnCleanup();
        await this.recoverDeadOwner();
        // A legacy FILE at the destination must be rejected before rename:
        // Windows permits a directory rename to replace a destination file.
        // Legitimate v2 competitors publish only nonempty directories here.
        try {
          await this.fs.rename(candidate, this.lock);
          published = true;
          await this.hooks.afterLockAcquired?.(owner);
          return owner;
        } catch (error) {
          if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
          if (Date.now() - started >= this.timeoutMs) throw this.lockedError('The active owner is alive or could not be verified.');
          await delay(10 + Math.floor(Math.random() * 20));
        }
      }
    } finally {
      // Candidate is private and its UUID is unique. Never recursively remove
      // a shared lock path, including in tests or in the rollback installer.
      try {
        await this.retryFs(() => this.fs.unlink(path.join(candidate, ownerName(owner.token))), ['ENOENT']);
        await this.retryFs(() => this.fs.rmdir(candidate), ['ENOENT']);
      } catch (error) {
        // A private preparation directory cannot block other writers. Its
        // cleanup must not turn an acquired shared lock into an apparent failure.
        if (!published) {
          try { this.onCleanupError(error); } catch (_) { }
        }
      }
    }
  }

  async transaction(operation) {
    const owner = await this.acquireLock();
    let result, operationError;
    try { result = await operation(); }
    catch (error) { operationError = error; }
    try { await this.removeOwner(owner); }
    catch (error) {
      this.pendingCleanup = owner;
      try { this.onCleanupError(error); } catch (_) { /* Diagnostics never change the commit result. */ }
      this.scheduleCleanup();
    }
    // A completed rename is still a successful commit if lock cleanup fails.
    // Preserve the primary error when both the operation and cleanup fail.
    if (operationError) throw operationError;
    return result;
  }

  async readExisting() {
    const document = JSON.parse(await this.fs.readFile(this.file, 'utf8'));
    if (document.format !== 1 || typeof document.epoch !== 'string' || !Number.isSafeInteger(document.revision) || document.revision < 0) throw new Error('Invalid Codex queue journal');
    validateQueue(document.queue);
    this.initialized = true;
    return document;
  }

  async readDocument() {
    try {
      return await this.readExisting();
    } catch (error) {
      // Corruption and read failures must never become an empty successful read.
      if (error.code !== 'ENOENT' || this.initialized) throw error;
      const legacy = JSON.parse(JSON.stringify((await this.readLegacy()) ?? {}));
      validateQueue(legacy);
      if (Object.keys(legacy).length) {
        await this.fs.writeFile(path.join(this.directory, 'legacy-snapshot.json'), JSON.stringify(legacy), {flag:'wx', mode:0o600})
          .catch(error => {if(error.code !== 'EEXIST') throw error;});
      }
      const queue = {};
      for (const [thread, messages] of Object.entries(legacy)) {
        queue[thread] = messages.map(message => ({
          ...message,
          pausedReason: 'Recovered from previous queue storage. Review this saved message before sending.',
          ...(message.submission ? {submission: {...message.submission,
            status: ['sending','outcome-unknown'].includes(message.submission.status) ? 'outcome-unknown' : 'queued'}} : {})
        }));
      }
      const document = {format:1, epoch:randomUUID(), revision:0, queue};
      await this.writeDocument(document);
      this.initialized = true;
      return document;
    }
  }

  async writeDocument(document) {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    let handle, committed = false;
    try {
      handle = await this.fs.open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(document));
      await handle.sync();
      await handle.close();
      handle = undefined;
      // Windows can briefly deny replacement while another window is reading.
      // Retry the atomic rename, never delete the old journal to make room.
      await this.hooks.beforeJournalCommit?.(document);
      await this.retryFs(() => this.fs.rename(temporary, this.file));
      committed = true;
      await this.hooks.afterJournalCommit?.(document);
    } finally {
      await handle?.close();
      // Rename already removed the temporary path. Avoid an unnecessary syscall
      // and any cleanup error after the journal was successfully committed.
      if (!committed) await this.retryFs(() => this.fs.unlink(temporary), ['ENOENT']);
    }
  }

  async read() {
    let document;
    try { document = await this.readExisting(); }
    catch(error) {
      if(error.code !== 'ENOENT' || this.initialized) throw error;
      document = await this.transaction(() => this.readDocument());
    }
    const {epoch,revision,queue} = document;
    return {epoch,revision,queue};
  }

  async compareAndSet(request) {
    const {epoch, revision, queue} = request;
    validateQueue(queue);
    return this.transaction(async () => {
      const current = await this.readDocument();
      if (current.epoch !== epoch || current.revision !== revision) return {applied:false};
      const next = this.reconcileProposal ? this.reconcileProposal(current, request) : {...current, revision:current.revision+1, queue};
      validateQueue(next.queue);
      await this.writeDocument(next);
      return {applied:true, epoch:next.epoch, revision:next.revision, ...(this.reconcileProposal ? {queue: next.queue} : {})};
    });
  }
}

module.exports = {QueueStore, validateQueue};
