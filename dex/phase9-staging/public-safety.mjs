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
function historyKey(key) {
  return "ystar-public-intent-history-v1:" + key;
}

function positiveDecimal(value) {
  return typeof value === "string" && /^[1-9][0-9]{0,77}$/.test(value);
}

function completeMetadata(record) {
  const metadata = record.metadata;
  if (metadata?.operation === "SWAP") {
    return typeof metadata.expectedCalldata === "string" &&
      hasSwapIntentMetadata(record, metadata.expectedCalldata.toLowerCase());
  }
  if (metadata?.operation !== "APPROVAL" || metadata.chainId !== record.chainId ||
      metadata.wallet !== record.wallet || metadata.destination !== metadata.token ||
      typeof metadata.token !== "string" || !ADDRESS.test(metadata.token) ||
      metadata.spender !== record.amm || !positiveDecimal(metadata.amount)) return false;
  const amount = BigInt(metadata.amount);
  return amount <= UINT256_MAX && metadata.expectedCalldata ===
    "0x095ea7b3" + record.amm.slice(2).padStart(64, "0") + amount.toString(16).padStart(64, "0");
}

export function isVerifiedTerminalIntent(record) {
  if (!record || !["CONFIRMED", "REVERTED"].includes(record.state)) return false;
  const evidence = record.verifiedReceipt;
  return record.version === 1 && record.chainId === CHAIN_ID && record.amm === AMM &&
    typeof record.wallet === "string" && ADDRESS.test(record.wallet) &&
    typeof record.id === "string" && HEX32.test(record.id) &&
    typeof record.txHash === "string" && HEX32.test(record.txHash) &&
    completeMetadata(record) && evidence?.chainId === record.chainId &&
    evidence.wallet === record.wallet && evidence.to === record.metadata.destination &&
    evidence.calldata === record.metadata.expectedCalldata.toLowerCase() &&
    evidence.txHash === record.txHash &&
    evidence.status === (record.state === "CONFIRMED" ? "success" : "reverted") &&
    typeof evidence.blockHash === "string" && HEX32.test(evidence.blockHash) &&
    positiveDecimal(evidence.blockNumber) && positiveDecimal(evidence.confirmations);
}

function readHistory(storage, key, active) {
  const raw = storage.getItem(historyKey(key));
  try {
    const entries = raw === null ? [] : JSON.parse(raw);
    assert(Array.isArray(entries) && (raw === null || entries.length > 0), "INVALID_HISTORY");
    const ids = new Set();
    for (const [index, record] of entries.entries()) {
      assert(isVerifiedTerminalIntent(record) && scopeKey(record) === key &&
        !ids.has(record.id) && (record.previousIntentId ?? null) === (entries[index - 1]?.id ?? null),
      "INVALID_HISTORY");
      ids.add(record.id);
    }
    const last = entries.at(-1);
    if (last && active?.id === last.id) {
      // A prior archival write may have succeeded before active replacement.
      assert(JSON.stringify(active) === JSON.stringify(last), "INVALID_HISTORY");
    } else {
      assert((active?.previousIntentId ?? null) === (last?.id ?? null) &&
        !ids.has(active?.id), "INVALID_HISTORY");
    }
    return entries;
  } catch {
    throw Error("INTENT_HISTORY_RECOVERY_REQUIRED");
  }
}

export function acquireIntent(storage, q, id, nowMs = Date.now()) {
  const key = intentKey(q, id);
  assert(readIntent(storage, key) === null, "INTENT_ALREADY_LOCKED");
  readHistory(storage, key, null);
  const record = createIntentRecord(q, id, nowMs);
  storage.setItem(key, JSON.stringify(record));
  const saved = readIntent(storage, key);
  assert(saved?.id === record.id && saved?.state === "LOCKED", "INTENT_PERSIST_FAILED");
  return record;
}

// Call only under the scope's exclusive Web Lock for an explicit new action.
// Archive first. An interrupted replacement keeps the old intent in history.
export function progressTerminalIntent(storage, quote, id, {previousIntentId, metadata, assertReady, clock = Date.now}) {
  const key = intentKey(quote, id);
  const previous = readIntent(storage, key);
  assert(previous?.id === previousIntentId && isVerifiedTerminalIntent(previous), "VERIFIED_TERMINAL_INTENT_REQUIRED");
  const history = readHistory(storage, key, previous);
  const next = {
    ...createIntentRecord(quote, id, clock()), state: "UNKNOWN", metadata,
    previousIntentId: previous.id
  };
  assert(next.id !== previous.id && !history.some(entry => entry.id === next.id), "INTENT_ID_ALREADY_USED");
  assert(completeMetadata(next), "INTENT_METADATA_REQUIRED");
  assert(typeof assertReady === "function", "PROGRESSION_GUARD_REQUIRED");
  assert(assertReady(previous) === true, "PROGRESSION_NOT_AUTHORIZED");
  const archiveKey = historyKey(key);
  const archive = JSON.stringify(history.at(-1)?.id === previous.id ? history : [...history, previous]);
  storage.setItem(archiveKey, archive);
  assert(storage.getItem(archiveKey) === archive, "INTENT_HISTORY_NOT_PERSISTED");

  // Recheck before replacing the active intent. The new UNKNOWN is written
  // with metadata in one write, before any simulation can run.
  assert(assertReady(previous) === true, "PROGRESSION_NOT_AUTHORIZED");
  validateQuote(quote, clock());
  const prior = JSON.stringify(previous);
  assert(JSON.stringify(readIntent(storage, key)) === prior, "ACTIVE_INTENT_CHANGED");
  const replacement = JSON.stringify(next);
  try {
    storage.setItem(key, replacement);
    assert(storage.getItem(key) === replacement && storage.getItem(archiveKey) === archive,
      "INTENT_PERSIST_FAILED");
  } catch (error) {
    try {
      storage.setItem(key, prior);
      assert(storage.getItem(key) === prior, "INTENT_RESTORE_FAILED");
    } catch (restoreError) {
      throw new AggregateError([error, restoreError], "INTENT_RESTORE_FAILED_MANUAL_REVIEW_REQUIRED");
    }
    throw error;
  }
  return next;
}
export function markUnknown(storage, key, id, txHash = null) {
  const r = readIntent(storage, key);
  assert(r && r.id === id.toLowerCase(), "INTENT_NOT_FOUND");
  assert(r.state === "LOCKED" || r.state === "UNKNOWN", "INVALID_TRANSITION");
  assert(txHash === null || HEX32.test(txHash), "INVALID_TX_HASH");
  // Once a hash is associated with an intent, never replace it with a different hash.
  // An unknown result must be recovered, not treated as permission to retry.
  if (r.txHash !== null && txHash !== null) {
    assert(r.txHash === txHash.toLowerCase(), "INTENT_HASH_IMMUTABLE");
  }
  const next = {...r, state:"UNKNOWN", txHash:txHash?.toLowerCase() ?? r.txHash};
  storage.setItem(key, JSON.stringify(next));
  assert(readIntent(storage, key)?.state === "UNKNOWN", "INTENT_PERSIST_FAILED");
  return next;
}
export function hasSwapIntentMetadata(intent, expectedCalldata) {
  const metadata = intent.metadata;
  return metadata?.operation === "SWAP" && metadata.chainId === intent.chainId &&
    metadata.wallet === intent.wallet && metadata.destination === AMM &&
    typeof metadata.expectedCalldata === "string" &&
    /^0x(?:[0-9a-fA-F]{2})+$/.test(metadata.expectedCalldata) &&
    metadata.expectedCalldata.toLowerCase() === expectedCalldata;
}

// Called with the intent's exclusive Web Lock held through verification and readback.
export function recordVerifiedReceipt(storage, key, original, evidence) {
  const current = readIntent(storage, key);
  assert(original?.state === "UNKNOWN" && current?.state === "UNKNOWN" &&
    JSON.stringify(current) === JSON.stringify(original), "INTENT_CHANGED_DURING_VERIFICATION");
  assert(evidence?.chainId === current.chainId && evidence.wallet === current.wallet &&
    evidence.to === AMM && hasSwapIntentMetadata(current, evidence.calldata), "RECEIPT_CONTEXT_MISMATCH");
  assert(typeof evidence.txHash === "string" && HEX32.test(evidence.txHash) &&
    current.txHash === evidence.txHash.toLowerCase(), "RECEIPT_HASH_MISMATCH");
  assert(evidence.status === "success" || evidence.status === "reverted", "RECEIPT_NOT_FINAL");

  const next = {...current, verifiedReceipt: evidence, state: evidence.status === "success" ? "CONFIRMED" : "REVERTED"};
  storage.setItem(key, JSON.stringify(next));
  const saved = readIntent(storage, key);
  assert(JSON.stringify(saved) === JSON.stringify(next), "SWAP_FINAL_STATE_NOT_PERSISTED");
  return saved;
}

// Called with the intent's exclusive Web Lock held through verification and readback.
export function recordVerifiedApprovalReceipt(storage, key, original, evidence) {
  const current = readIntent(storage, key);
  assert(original?.state === "UNKNOWN" && original.metadata?.operation === "APPROVAL" &&
    current?.id === original.id && current.state === "UNKNOWN" &&
    current.txHash === original.txHash && JSON.stringify(current.metadata) === JSON.stringify(original.metadata),
    "APPROVAL_INTENT_CHANGED_DURING_VERIFICATION");
  assert(evidence?.chainId === current.chainId && evidence.wallet === current.wallet &&
    evidence.to === current.metadata.token && evidence.to === current.metadata.destination &&
    evidence.calldata === current.metadata.expectedCalldata, "APPROVAL_RECEIPT_CONTEXT_MISMATCH");
  assert(HEX32.test(evidence.txHash) && evidence.txHash === current.txHash, "RECEIPT_HASH_MISMATCH");
  assert(evidence.status === "success" || evidence.status === "reverted", "RECEIPT_NOT_FINAL");

  const next = {...current, verifiedReceipt: evidence, state: evidence.status === "success" ? "CONFIRMED" : "REVERTED"};
  storage.setItem(key, JSON.stringify(next));
  const saved = readIntent(storage, key);
  assert(JSON.stringify(saved) === JSON.stringify(next), "APPROVAL_FINAL_STATE_NOT_PERSISTED");
  return saved;
}
// No clear/unlock helper is exported: manual review and a separately audited flow required.
// Storage is a persistence aid, NOT a cross-tab atomic lock. Production must use
// Web Locks or equivalent serialized coordination before requesting a wallet signature.
