import {withAtomicIntent} from "./public-atomic-lock.mjs";
import {markUnknown, readIntent, scopeKey} from "./public-safety.mjs";

// Both mock operations share the same lock scope. A failed simulation leaves
// the persisted intent in place for inspection.
export async function runOfflineIntent({
  operation, locks, storage, quote, intentId, nowMs, transaction, progression, simulateSubmission
}) {
  if (operation !== "SWAP" && operation !== "APPROVAL") throw Error("INVALID_OPERATION");
  if (typeof simulateSubmission !== "function") throw Error("MOCK_SUBMISSION_REQUIRED");

  const key = scopeKey(quote);
  const metadata = transaction && {
    ...transaction, operation, chainId: quote.chainId, wallet: quote.wallet.toLowerCase()
  };
  return withAtomicIntent({
    locks, storage, quote, intentId, nowMs,
    progression: progression && {...progression, metadata},
    onAcquired: async record => {
      // Persist uncertainty before invoking the simulation, including when
      // it throws or returns without a hash.
      if (!progression) {
        const unknown = markUnknown(storage, key, record.id);
        if (metadata) storage.setItem(key, JSON.stringify({...unknown, metadata}));
      }
      // Progression has already verified the complete active record under
      // the lock. Its archival and replacement writes are handled together.
      const pending = progression ? record : readIntent(storage, key);
      if (pending?.id !== record.id || pending.state !== "UNKNOWN" || pending.txHash !== null ||
          (metadata && JSON.stringify(pending.metadata) !== JSON.stringify(metadata))) {
        throw Error("INTENT_PERSIST_FAILED");
      }

      const txHash = await simulateSubmission({operation, intentId: record.id});
      if (txHash == null) return pending;

      const updated = markUnknown(storage, key, record.id, txHash);
      const saved = readIntent(storage, key);
      if (saved?.id !== record.id || saved.state !== "UNKNOWN" || saved.txHash !== updated.txHash ||
          (metadata && JSON.stringify(saved.metadata) !== JSON.stringify(metadata))) {
        throw Error("INTENT_PERSIST_FAILED");
      }
      return saved;
    }
  });
}
