import { beforeEach, describe, expect, test } from 'bun:test';
import {
  beginUserWait,
  resetContinuationAttemptGateForTests,
} from './continuation-attempt-gate';

type LegacyAttemptState =
  | { status: 'reserved'; owner: symbol }
  | { status: 'consumed' };

type LegacyStore = {
  attempts: Map<string, LegacyAttemptState>;
};

const STORE_KEY = Symbol.for('oh-my-opencode-slim.continuation-attempt-gate');

function getLegacyStore(): LegacyStore {
  return (
    globalThis as typeof globalThis & {
      [STORE_KEY]: LegacyStore;
    }
  )[STORE_KEY];
}

function legacyTryReserve(sessionID: string): symbol | null {
  const { attempts } = getLegacyStore();
  if (attempts.has(sessionID)) return null;
  const owner = Symbol(sessionID);
  attempts.set(sessionID, { status: 'reserved', owner });
  return owner;
}

function legacyCommit(sessionID: string, owner: symbol): boolean {
  const { attempts } = getLegacyStore();
  const state = attempts.get(sessionID);
  if (state?.status !== 'reserved' || state.owner !== owner) return false;
  attempts.set(sessionID, { status: 'consumed' });
  return true;
}

describe('continuation attempt gate compatibility', () => {
  beforeEach(() => {
    resetContinuationAttemptGateForTests();
  });

  test('wait_for_user blocks a pre-upgrade hook sharing the global store', () => {
    const staleOwner = legacyTryReserve('parent-1');
    expect(staleOwner).not.toBeNull();

    beginUserWait('parent-1');

    expect(legacyTryReserve('parent-1')).toBeNull();
    expect(legacyCommit('parent-1', staleOwner as symbol)).toBe(false);
  });
});
