/**
 * Process-local gate for incomplete-todo continuation promptAsync attempts.
 *
 * Scoped via globalThis + Symbol.for so independently created hook instances
 * in the same JS process share one-attempt-per-session protection. Does not
 * claim cross-process or restart durability.
 */

type AttemptState =
  | { status: 'reserved'; owner: symbol }
  | { status: 'consumed' }
  | { status: 'waiting-for-user' };

type RearmIdentity = string | symbol;

type ContinuationAttemptStore = {
  attempts: Map<string, AttemptState>;
  /**
   * Last external user-message identity that rearmed each session.
   * string = chat.message ID; symbol = same-process object identity fallback.
   */
  lastRearmIdentity: Map<string, RearmIdentity>;
  /** Stable symbols for ID-less output.message object identity (same process). */
  messageObjectIdentity: WeakMap<object, symbol>;
};

const STORE_KEY = Symbol.for('oh-my-opencode-slim.continuation-attempt-gate');

function getStore(): ContinuationAttemptStore {
  const globalWithStore = globalThis as typeof globalThis & {
    [STORE_KEY]?: ContinuationAttemptStore;
  };
  globalWithStore[STORE_KEY] ??= {
    attempts: new Map(),
    lastRearmIdentity: new Map(),
    messageObjectIdentity: new WeakMap(),
  };
  return globalWithStore[STORE_KEY];
}

/**
 * Block continuation for a text-only HITL boundary until a distinct real
 * external user message opens the next continuation epoch.
 *
 * Deleting an existing attempt also revokes an in-flight reservation: its
 * owner can no longer commit a prompt after this wait begins.
 */
export function beginUserWait(sessionID: string): void {
  getStore().attempts.set(sessionID, { status: 'waiting-for-user' });
}

export function hasUserWait(sessionID: string): boolean {
  return getStore().attempts.get(sessionID)?.status === 'waiting-for-user';
}

function resolveRearmIdentity(identity: string | object): RearmIdentity {
  if (typeof identity === 'string') return identity;
  const store = getStore();
  const existing = store.messageObjectIdentity.get(identity);
  if (existing) return existing;
  const token = Symbol('continuation-rearm-message');
  store.messageObjectIdentity.set(identity, token);
  return token;
}

/**
 * Atomically reserve a continuation attempt.
 * Returns an owner token on success, or null if already reserved/consumed.
 */
export function tryReserveContinuationAttempt(
  sessionID: string,
): symbol | null {
  const { attempts } = getStore();
  if (attempts.has(sessionID)) return null;
  const owner = Symbol(sessionID);
  attempts.set(sessionID, { status: 'reserved', owner });
  return owner;
}

/**
 * Commit a reserved attempt owned by `owner`. Returns true if this owner
 * committed; false if the reservation is missing or owned by someone else.
 */
export function commitContinuationAttempt(
  sessionID: string,
  owner: symbol,
): boolean {
  const { attempts } = getStore();
  const state = attempts.get(sessionID);
  if (state?.status !== 'reserved' || state.owner !== owner) {
    return false;
  }
  attempts.set(sessionID, { status: 'consumed' });
  return true;
}

/**
 * Release an uncommitted reservation only when still owned by `owner`.
 * Consumed attempts and foreign reservations are left intact.
 */
export function releaseContinuationAttempt(
  sessionID: string,
  owner: symbol,
): void {
  const { attempts } = getStore();
  const state = attempts.get(sessionID);
  if (state?.status === 'reserved' && state.owner === owner) {
    attempts.delete(sessionID);
  }
}

/**
 * Open a new continuation epoch for a real external user message.
 * Idempotent per (sessionID, identity): string message IDs or same-process
 * object identity (WeakMap→symbol). A second observe of the same identity
 * does not rearm again. Returns true when this call cleared attempt state.
 */
export function rearmContinuationForUserMessage(
  sessionID: string,
  identity: string | object,
): boolean {
  const store = getStore();
  const resolved = resolveRearmIdentity(identity);
  if (store.lastRearmIdentity.get(sessionID) === resolved) {
    return false;
  }
  store.lastRearmIdentity.set(sessionID, resolved);
  store.attempts.delete(sessionID);
  return true;
}

/**
 * Full session cleanup (genuine deletion). Clears attempt state and rearm
 * identity so a later session id reuse is not pinned to a prior message.
 */
export function clearContinuationAttempt(sessionID: string): void {
  const store = getStore();
  store.attempts.delete(sessionID);
  store.lastRearmIdentity.delete(sessionID);
}

export function hasConsumedContinuationAttempt(sessionID: string): boolean {
  return getStore().attempts.get(sessionID)?.status === 'consumed';
}

/** Test seam: wipe process-local gate state between cases. */
export function resetContinuationAttemptGateForTests(): void {
  const store = getStore();
  store.attempts.clear();
  store.lastRearmIdentity.clear();
  // WeakMap entries are not enumerable; leave for GC. Tests use fresh objects.
}
