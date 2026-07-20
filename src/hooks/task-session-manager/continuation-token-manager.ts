export function createContinuationTokenManager(options?: {
  onInvalidateContinuation?: (sessionID: string) => void;
}) {
  const continuationSessionTokens = new Map<string, symbol>();
  const activeContinuationEvaluations = new Map<string, Set<symbol>>();
  const continuationConsumed = new Set<string>();

  function getContinuationSessionToken(sessionID: string): symbol {
    const existing = continuationSessionTokens.get(sessionID);
    if (existing) return existing;

    const token = Symbol(sessionID);
    continuationSessionTokens.set(sessionID, token);
    return token;
  }

  function isCurrentContinuation(
    sessionID: string,
    sessionToken: symbol,
    evaluationToken?: symbol,
  ): boolean {
    return (
      continuationSessionTokens.get(sessionID) === sessionToken &&
      (evaluationToken === undefined ||
        activeContinuationEvaluations.get(sessionID)?.has(evaluationToken) ===
          true)
    );
  }

  function invalidateContinuation(sessionID: string): void {
    options?.onInvalidateContinuation?.(sessionID);
    continuationSessionTokens.delete(sessionID);
    activeContinuationEvaluations.delete(sessionID);
  }

  function clearContinuation(sessionID: string): void {
    invalidateContinuation(sessionID);
    continuationConsumed.delete(sessionID);
  }

  return {
    getContinuationSessionToken,
    isCurrentContinuation,
    invalidateContinuation,
    clearContinuation,
    // Exposed internal state for consumers not yet migrated (evaluateContinuation, etc.)
    sessionTokens: continuationSessionTokens,
    evaluations: activeContinuationEvaluations,
    consumed: continuationConsumed,
  };
}
