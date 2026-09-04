/**
 * One script lock, taken once per execution.
 *
 * Why this file exists
 * --------------------
 * Several layers of this backend each want to serialise: the API router wraps
 * every write action, `appendRows_` guards a Sheet append, `touchLastSeen_`
 * guards a cell update, and adding a variation to a TikTok product is a
 * read-modify-write that must not interleave. Left alone, they nest — the
 * router takes the lock, then `recordSku_` tries to take it again inside the
 * same execution.
 *
 * Whether that nesting is harmless depends on whether Apps Script's script
 * lock is re-entrant within a single execution, and the documentation does not
 * say. If it is not, `waitLock(30000)` inside a held lock blocks for the full
 * thirty seconds and then throws — turning every single push into a timeout —
 * while `tryLock` returns false and silently skips the work it was guarding.
 * Both failures are the kind that only show up in production, under load, on
 * factory Wi-Fi.
 *
 * Rather than bet on a behaviour that cannot be verified from outside the
 * Apps Script runtime, this helper makes the question irrelevant: it tracks
 * whether the current execution already holds the lock and, if so, simply runs
 * the work. Correct under either semantics.
 *
 * The flag is safe because Apps Script gives each execution its own global
 * scope and runs it single-threaded, so `HELD_` can never be observed by a
 * different request.
 */

/** True while this execution holds the script lock. Never shared across executions. */
var HELD_ = false;

/** How long to wait for the lock before giving up. */
var LOCK_TIMEOUT_MS = 30000;

/**
 * Run `fn` holding the script lock, taking it only if this execution does not
 * already hold it.
 *
 * @param {number} timeoutMs how long to wait; defaults to LOCK_TIMEOUT_MS
 * @param {function} fn the work to run
 * @throws Error prefixed 'BUSY:' when the lock cannot be taken, which the API
 *   router turns into a retryable response rather than a failure
 */
function withScriptLock_(timeoutMs, fn) {
  // Already ours. Re-taking it is exactly the nesting this file exists to
  // avoid, and the work is already serialised by the outer holder.
  if (HELD_) return fn();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs || LOCK_TIMEOUT_MS)) {
    throw new Error(
      'BUSY: Another change is being saved right now. This will retry in a moment — ' +
      'nothing has been lost.'
    );
  }

  HELD_ = true;
  try {
    return fn();
  } finally {
    // Cleared before releasing, so a caller that somehow observes the lock as
    // free never also sees it as held.
    HELD_ = false;
    lock.releaseLock();
  }
}

/**
 * Run `fn` under the lock, but skip it entirely rather than fail if the lock
 * is unavailable.
 *
 * For genuinely optional writes — recording a last-seen timestamp — where
 * blocking a livestream push to record a nicety is the wrong trade.
 */
function withScriptLockOptional_(timeoutMs, fn) {
  if (HELD_) return fn();

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(timeoutMs || 5000)) return undefined;

  HELD_ = true;
  try {
    return fn();
  } finally {
    HELD_ = false;
    lock.releaseLock();
  }
}

/** True when this execution holds the lock. Exposed for assertions and tests. */
function holdsScriptLock_() {
  return HELD_;
}
