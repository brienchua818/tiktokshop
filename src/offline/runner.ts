import { allDrafts, nextBatch, reviveOrphanedUploads, type QueuedDraft } from './queue'
import { PREP_DEADLINE_MS, pushOne, withDeadline } from './push'

/**
 * The queue's one sender: a single loop for the whole app, not a screen effect.
 *
 * Brien, 17 Oct: "it keeps showing it as queued, and shows 'X waiting' on the
 * top right, but nothing happens ... usually after we list 8-10 variations."
 * The Log tab showed why it looked like a phone fault: the stuck variations
 * never reached the backend at all — BRI21–28 on 13 Oct arrived nineteen hours
 * later, the next time somebody opened that listing.
 *
 * The sender lived in a React effect on the listing screen, guarded by a
 * `working` flag. Saving the next SKU while a push was in flight — which is
 * what a live stream IS — changed the screen's draft list, React tore the
 * effect down mid-push, and the step that cleared `working` was skipped. Every
 * later run saw `working` still true and returned. Only leaving the listing
 * and coming back reset it. Two more holes sat beside it: nothing woke the
 * queue when a retry's wait ran out, and drafts for any listing not on screen
 * — continuation drafts included — were never pushed by anything.
 *
 * So the sender owns nothing a re-render can take away:
 *
 *   ONE LOOP. A module-level flag, cleared in `finally`, so it is cleared
 *   however a pass ends. A kick that arrives mid-pass is remembered and the
 *   pass goes round again, rather than being dropped.
 *
 *   FRESH READS. Each round reads the queue from IndexedDB, not from a screen's
 *   props, so a SKU saved a moment ago is seen and nothing pushed twice.
 *
 *   ONE PUSH PER STREAM, STILL. `nextBatch` decides, exactly as before: adding
 *   a variation is a read-modify-write of the whole product, and two at once
 *   deletes one. Pushes run one at a time, and across tabs only one tab sends
 *   (Web Locks, where the browser has them).
 *
 *   A HEARTBEAT. Every two seconds, and on reconnect, focus and return from the
 *   background, it looks again. A retry whose wait has run out is sent on time
 *   without anyone touching the phone, and a push orphaned by iOS suspending
 *   the app is picked up once `reviveOrphanedUploads` says it is safe — never
 *   sooner, because a push that may already have landed must not be re-sent
 *   blind (it carries its idempotency key regardless).
 */

export interface RunnerDeps {
  /** Overrides PUSH_WATCHDOG_MS; for tests. */
  watchdogMs?: number
  /** Overrides READ_DEADLINE_MS; for tests. */
  readDeadlineMs?: number
  drafts: () => Promise<QueuedDraft[]>
  push: (draft: QueuedDraft) => Promise<void>
  revive: (now: number) => Promise<number>
  online: () => boolean
  now: () => number
}

const defaults: RunnerDeps = {
  drafts: allDrafts,
  push: pushOne,
  revive: reviveOrphanedUploads,
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
  now: () => Date.now(),
}

/** How often the runner looks for due work when nothing has prompted it. */
export const HEARTBEAT_MS = 2_000
/**
 * The longest one push may hold the sender before it moves on.
 *
 * A push is bounded inside — a 120 s network deadline, an 80 s check of what
 * landed, 30 s for each step on the phone — so this should never fire. It
 * exists because "should never" is how the queue stopped last time. Past
 * every legitimate path, the sender stops waiting and carries on with other
 * listings. The row is freed by `reviveOrphanedUploads` once its last stamp
 * is stale and sent again on a later pass, under the same idempotency key so
 * it cannot land twice; if the abandoned push wakes up and fails after that
 * retry has gone through, its failure is not written over the result.
 */
export const PUSH_WATCHDOG_MS = 300_000

/**
 * The longest the sender waits for its own read of the queue.
 *
 * The same WebKit IndexedDB stall the photo read is guarded against can hit
 * these reads, and they run every two seconds, so one is often in flight when
 * the phone switches to TikTok. A read that never answered held the sender —
 * and its Web Lock — until the app was killed. Now it is a failed pass, and
 * the next heartbeat reads again on a fresh connection.
 */
export const READ_DEADLINE_MS = PREP_DEADLINE_MS

/** Rounds per pass before yielding; a backstop against a loop that cannot end. */
const MAX_ROUNDS = 1_000

let running = false
let again = false
/**
 * Bumped when the runner is stopped — which is signing out, since the app
 * shell runs it only for a signed-in person. A pass in flight ends after its
 * current push, as it did when leaving the listing screen ended it.
 *
 * Not "is there a credential": a session that lapses mid-stream must not stop
 * the sender without a word. The push says why it cannot go (push.ts) and the
 * app shell sends the person to sign in.
 */
let generation = 0
const listeners = new Set<() => void>()

/** Be told when the runner has changed the queue (a push finished, an orphan revived). */
export function onQueueChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener()
    } catch {
      /* a screen's refresh failing must not stop the sender */
    }
  }
}

/** True while a pass is pushing. For tests and the indicator. */
export function isDraining(): boolean {
  return running
}

/**
 * Push everything that is due, one at a time per stream, until nothing is.
 * Returns how many pushes were made. Safe to call at any moment, from
 * anywhere, any number of times: a call during a pass makes the pass go round
 * again instead of starting a second one.
 */
export async function drainQueue(deps: RunnerDeps = defaults): Promise<number> {
  if (running) {
    again = true
    return 0
  }
  running = true
  let pushed = 0
  let revived = 0
  // Streams whose push outran the watchdog. Left alone for the rest of this
  // pass, so one stuck listing cannot be picked straight back up in a tight
  // loop; the next pass, a heartbeat later, tries it again.
  const abandoned = new Set<string>()
  const readMs = deps.readDeadlineMs ?? READ_DEADLINE_MS
  const started = generation
  const live = () => deps.online() && generation === started
  try {
    do {
      again = false
      if (!live()) break
      revived += await withDeadline(deps.revive(deps.now()), readMs, 'Checking for stalled uploads').catch(() => 0)
      for (let round = 0; round < MAX_ROUNDS && live(); round++) {
        const all = await withDeadline(deps.drafts(), readMs, 'Reading the queue')
        const batch = nextBatch(all.filter((d) => !abandoned.has(d.stream_id)), deps.now())
        if (!batch.length) break
        for (const draft of batch) {
          // Signing out mid-pass ends it after the push in flight.
          if (!live()) break
          const settled = await settleWithin(deps.push(draft), deps.watchdogMs ?? PUSH_WATCHDOG_MS)
          if (settled) pushed++
          else abandoned.add(draft.stream_id)
          notify()
        }
      }
    } while (again && live())
  } finally {
    // Cleared however the pass ended — a throw included. This is the line the
    // old loop could skip, and skipping it is what stopped the queue for good.
    running = false
    again = false
    if (pushed || revived) notify()
  }
  return pushed
}

/**
 * Wait for `work`, but no longer than `ms`. True if it finished, false if the
 * wait ran out. A throw from `work` still throws.
 */
function settleWithin(work: Promise<void>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const give = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), ms)
  })
  return Promise.race([work.then(() => true), give]).finally(() => clearTimeout(timer))
}

/** Ask for a pass soon. Never throws, never waits. */
export function kickQueue(deps: RunnerDeps = defaults): void {
  const pass = () => drainQueue(deps).catch(() => 0)
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined
  if (locks?.request) {
    // One sending tab per phone. `ifAvailable`: if another tab holds it, that
    // tab is already sending and this one has nothing to add.
    void locks
      .request('tikshop-queue-sender', { ifAvailable: true }, (lock) => {
        if (lock) return pass()
        // Held. If this tab holds it, the pass must go round again for what
        // prompted this kick; if another tab does, there is nothing to add.
        if (running) again = true
        return 0
      })
      .catch(() => 0)
    return
  }
  void pass()
}

/**
 * Start the heartbeat and the wake-up listeners. Returns a stop function.
 * Started once by the app shell for a signed-in person, so it is never torn
 * down by a screen changing.
 */
export function startQueueRunner(deps: RunnerDeps = defaults): () => void {
  const kick = () => kickQueue(deps)
  const onVisible = () => {
    if (typeof document === 'undefined' || document.visibilityState === 'visible') kick()
  }
  kick()
  const timer = setInterval(kick, HEARTBEAT_MS)
  window.addEventListener('online', kick)
  window.addEventListener('focus', kick)
  document.addEventListener('visibilitychange', onVisible)
  return () => {
    generation++
    clearInterval(timer)
    window.removeEventListener('online', kick)
    window.removeEventListener('focus', kick)
    document.removeEventListener('visibilitychange', onVisible)
  }
}
