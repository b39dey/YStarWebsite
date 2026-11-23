import {scopeKey, acquireIntent, readIntent, progressTerminalIntent} from "./public-safety.mjs";

// Same-origin coordination: the browser must implement navigator.locks.request.
// A persistent intent is never automatically cleared, including on errors.
export async function withAtomicIntent({locks, storage, quote, intentId, nowMs = Date.now(), progression, onAcquired}) {
  if (!locks || typeof locks.request !== "function") throw Error("WEB_LOCKS_UNAVAILABLE");
  if (!storage || typeof storage.getItem !== "function" || typeof storage.setItem !== "function") throw Error("STORAGE_UNAVAILABLE");
  if (typeof onAcquired !== "function") throw Error("CALLBACK_REQUIRED");
  const key = scopeKey(quote);
  return locks.request(key, {mode:"exclusive"}, async lock => {
    if (!lock) throw Error("WEB_LOCK_NOT_GRANTED");
    // Lock acquisition and persistent write must complete before any wallet request.
    if (progression) {
      return onAcquired(progressTerminalIntent(storage, quote, intentId, progression));
    }
    if (readIntent(storage, key) !== null) throw Error("INTENT_ALREADY_LOCKED");
    const record = acquireIntent(storage, quote, intentId, nowMs);
    return onAcquired(record);
  });
}
// Critical deployment constraint: Web Locks and localStorage coordinate only
// same-origin tabs in the same browser storage partition. They do NOT prevent
// duplicates across devices, profiles, or origins. On-chain nonce/receipt checks
// and recovery remain required before any public execution can be enabled.
