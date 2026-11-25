// Phase 9 public transaction safety foundation. No wallet requests or transaction submission.
export const CHAIN_ID = 56;
export const AMM = "0x17dac8a164ce434fe36a2d6029bf4431a22397e2";
export const MAX_QUOTE_AGE_MS = 30_000;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const UINT256_MAX = (1n << 256n) - 1n;
function assert(condition, message) { if (!condition) throw new Error(message); }
export function scopeKey({chainId, amm, wallet}) {
  assert(chainId === CHAIN_ID, "WRONG_CHAIN");
  assert(ADDRESS.test(amm) && amm.toLowerCase() === AMM, "WRONG_AMM");
  assert(ADDRESS.test(wallet), "INVALID_WALLET");
  return "ystar-public-intent-v1:" + chainId + ":" + AMM + ":" + wallet.toLowerCase();
}
export function validateQuote(q, nowMs = Date.now()) {
  assert(q && typeof q === "object", "QUOTE_MISSING");
  assert(q.chainId === CHAIN_ID && String(q.amm).toLowerCase() === AMM, "QUOTE_SCOPE_MISMATCH");
  assert(ADDRESS.test(q.wallet), "INVALID_WALLET");
  assert(Number.isSafeInteger(q.observedAtMs) && q.observedAtMs <= nowMs && nowMs - q.observedAtMs <= MAX_QUOTE_AGE_MS, "QUOTE_STALE");
  assert(Number.isSafeInteger(q.deadlineSec) && q.deadlineSec > Math.floor(nowMs / 1000), "DEADLINE_EXPIRED");
  for (const field of ["amountIn", "quotedOut", "minimumOut"]) {
    assert(typeof q[field] === "bigint" && q[field] > 0n && q[field] <= UINT256_MAX, "INVALID_" + field.toUpperCase());
  }
  assert(q.minimumOut <= q.quotedOut, "INVALID_SLIPPAGE");
  assert(typeof q.blockNumber === "bigint" && q.blockNumber > 0n, "INVALID_BLOCK");
  return true;
}
export function intentKey(quote, id) {
  assert(HEX32.test(id), "INVALID_INTENT_ID");
  return scopeKey(quote);
}
export function createIntentRecord(q, id, nowMs = Date.now()) {
  validateQuote(q, nowMs);
  intentKey(q, id);
  return {version:1, id:id.toLowerCase(), chainId:q.chainId, amm:AMM, wallet:q.wallet.toLowerCase(), amountIn:q.amountIn.toString(), minimumOut:q.minimumOut.toString(), blockNumber:q.blockNumber.toString(), createdAtMs:nowMs, state:"LOCKED", txHash:null};
}
export function readIntent(storage, key) {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  try {
    const r = JSON.parse(raw);
    assert(r?.version === 1 && r?.state && ["LOCKED","UNKNOWN","CONFIRMED","REVERTED"].includes(r.state), "CORRUPT_INTENT");
    assert(r.chainId === CHAIN_ID && r.amm === AMM && ADDRESS.test(r.wallet) && key === scopeKey(r), "INTENT_SCOPE_MISMATCH");
    assert(HEX32.test(r.id), "INVALID_INTENT_ID");
    if (r.txHash !== null) assert(HEX32.test(r.txHash), "INVALID_TX_HASH");
    return r;
  } catch { throw new Error("INTENT_RECOVERY_REQUIRED"); }
}
export function acquireIntent(storage, q, id, nowMs = Date.now()) {
  const key = intentKey(q, id);
  assert(readIntent(storage, key) === null, "INTENT_ALREADY_LOCKED");
  const record = createIntentRecord(q, id, nowMs);
  storage.setItem(key, JSON.stringify(record));
  const saved = readIntent(storage, key);
  assert(saved?.id === record.id && saved?.state === "LOCKED", "INTENT_PERSIST_FAILED");
  return record;
}
export function markUnknown(storage, key, id, txHash = null) {
  const r = readIntent(storage, key);
  assert(r && r.id === id.toLowerCase(), "INTENT_NOT_FOUND");
  assert(r.state === "LOCKED" || r.state === "UNKNOWN", "INVALID_TRANSITION");
  assert(txHash === null || HEX32.test(txHash), "INVALID_TX_HASH");
  const next = {...r, state:"UNKNOWN", txHash:txHash?.toLowerCase() ?? r.txHash};
  storage.setItem(key, JSON.stringify(next));
  assert(readIntent(storage, key)?.state === "UNKNOWN", "INTENT_PERSIST_FAILED");
  return next;
}
// Only a verified receipt AND matching chain/transaction context can finalize an intent.
// This function deliberately does not unlock or remove the persistent record.
export function recordVerifiedReceipt(storage, key, id, evidence) {
  const r = readIntent(storage, key);
  assert(r && r.id === id.toLowerCase() && r.state === "UNKNOWN", "INVALID_TRANSITION");
  assert(evidence?.chainId === CHAIN_ID && evidence?.wallet?.toLowerCase() === r.wallet && evidence?.to?.toLowerCase() === AMM, "RECEIPT_CONTEXT_MISMATCH");
  assert(HEX32.test(evidence.txHash) && r.txHash === evidence.txHash.toLowerCase(), "RECEIPT_HASH_MISMATCH");
  assert(evidence.status === "success" || evidence.status === "reverted", "RECEIPT_NOT_FINAL");
  const next = {...r, state:evidence.status === "success" ? "CONFIRMED" : "REVERTED"};
  storage.setItem(key, JSON.stringify(next));
  return next;
}
// No clear/unlock helper is exported: manual review and a separately audited flow required.
// Storage is a persistence aid, NOT a cross-tab atomic lock. Production must use
// Web Locks or equivalent serialized coordination before requesting a wallet signature.
