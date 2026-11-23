import {
  CHAIN_ID, AMM, scopeKey, readIntent, hasSwapIntentMetadata, isVerifiedTerminalIntent,
  recordVerifiedReceipt, recordVerifiedApprovalReceipt
} from "./public-safety.mjs";
const HASH=/^0x[0-9a-fA-F]{64}$/;
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
const DATA=/^0x(?:[0-9a-fA-F]{2})+$/;
export const FINALIZED_DUAL_SOURCE = "FINALIZED_DUAL_SOURCE";
export const SINGLE_SOURCE_NATIVE_FINALITY = "SINGLE_SOURCE_NATIVE_FINALITY";
const FINALITY_TIMEOUT_MS = 4_000;
function requireCondition(ok,code){if(!ok)throw Error(code)}
function hexBigInt(x){requireCondition(typeof x==="string"&&/^0x[0-9a-fA-F]+$/.test(x),"INVALID_RPC_HEX");return BigInt(x)}
async function rpc(provider,method,params=[]){requireCondition(provider&&typeof provider.request==="function","RPC_UNAVAILABLE");return provider.request({method,params})}
/**
 * Fail-closed verification. The expected calldata must come from a
 * previously independently reviewed/signed intent, NEVER from the RPC response.
 * Missing transaction/receipt returns UNKNOWN. Any mismatch throws.
 * No wallet calls or transaction submission.
 */
export async function verifyOnChainReceipt({
  provider, locks, storage, quote, intentId, txHash, expectedCalldata, minConfirmations = 2, finalityPolicy, observedReceipt
}) {
  requireCondition(typeof locks?.request === "function", "WEB_LOCKS_UNAVAILABLE");
  requireCondition(typeof intentId === "string" && HASH.test(intentId), "INVALID_INTENT_ID");
  requireCondition(typeof txHash === "string" && HASH.test(txHash), "INVALID_TX_HASH");
  requireCondition(typeof expectedCalldata === "string" && DATA.test(expectedCalldata), "EXPECTED_CALLDATA_REQUIRED");
  requireCondition(Number.isSafeInteger(minConfirmations) && minConfirmations >= 1, "INVALID_CONFIRMATIONS");
  const key = scopeKey(quote);
  const wallet = quote.wallet.toLowerCase();
  return locks.request(key, {mode: "exclusive"}, async lock => {
    requireCondition(lock, "WEB_LOCK_NOT_GRANTED");
    const original = readIntent(storage, key);
    requireCondition(original?.state === "UNKNOWN", "UNKNOWN_INTENT_REQUIRED");
    requireCondition(original.id === intentId.toLowerCase(), "SWAP_INTENT_ID_MISMATCH");
    requireCondition(original.txHash === txHash.toLowerCase(), "INTENT_HASH_MISMATCH");
    requireCondition(original.wallet === wallet, "INTENT_WALLET_MISMATCH");
    requireCondition(hasSwapIntentMetadata(original, expectedCalldata.toLowerCase()), "SWAP_INTENT_METADATA_MISMATCH");
    const result = await verifyReceipt({
      provider, txHash, wallet: original.wallet, destination: original.metadata.destination,
      expectedCalldata: original.metadata.expectedCalldata, minConfirmations, finalityPolicy, observedReceipt
    });
    if (result.state === "UNKNOWN") return result;
    const {evidence, confirmations, blockNumber} = result;
    requireMatchingObservation(evidence, observedReceipt);
    const final = recordVerifiedReceipt(storage, key, original, evidence);
    return {state: final.state, txHash, confirmations, blockNumber};
  });
}

// The caller derives the trusted token, spender and base-unit amount from
// the reviewed operation independently of the RPC response.
function approvalContext(trustedApproval) {
  const {token, spender, amount} = trustedApproval ?? {};
  requireCondition(typeof token === "string" && ADDRESS.test(token) &&
    typeof spender === "string" && spender.toLowerCase() === AMM &&
    typeof amount === "bigint" && amount > 0n && amount < (1n << 256n),
    "INVALID_TRUSTED_APPROVAL");
  const destination = token.toLowerCase();
  const expectedCalldata = "0x095ea7b3" + AMM.slice(2).padStart(64, "0") +
    amount.toString(16).padStart(64, "0");
  return {destination, expectedCalldata, amount: amount.toString()};
}

function requireApprovalMetadata(original, {destination, expectedCalldata, amount}) {
  const expected = {operation: "APPROVAL", chainId: original.chainId, wallet: original.wallet,
    destination, token: destination, spender: AMM, amount, expectedCalldata};
  requireCondition(Object.entries(expected).every(([field, value]) => original.metadata?.[field] === value),
    "APPROVAL_INTENT_METADATA_MISMATCH");
}

function requireMatchingObservation(evidence, observed) {
  requireCondition(observed === undefined || ["txHash", "blockNumber", "blockHash", "status"].every(
    field => observed?.[field] === evidence[field]), "PROVISIONAL_RECEIPT_CHANGED");
}

export async function verifyApprovalReceipt({
  provider, locks, storage, scope, intentId, trustedApproval, minConfirmations = 2, finalityPolicy, observedReceipt
}) {
  requireCondition(typeof locks?.request === "function", "WEB_LOCKS_UNAVAILABLE");
  requireCondition(HASH.test(intentId), "INVALID_INTENT_ID");
  requireCondition(Number.isSafeInteger(minConfirmations) && minConfirmations >= 1, "INVALID_CONFIRMATIONS");
  const key = scopeKey(scope);
  const approval = approvalContext(trustedApproval);
  const {destination, expectedCalldata} = approval;
  return locks.request(key, {mode: "exclusive"}, async lock => {
    requireCondition(lock, "WEB_LOCK_NOT_GRANTED");
    const original = readIntent(storage, key);
    requireCondition(original?.state === "UNKNOWN", "UNKNOWN_INTENT_REQUIRED");
    requireCondition(original.id === intentId.toLowerCase(), "APPROVAL_INTENT_ID_MISMATCH");
    requireCondition(typeof original.txHash === "string" && HASH.test(original.txHash),
      "HASH_MISSING_MANUAL_REVIEW_REQUIRED");
    requireApprovalMetadata(original, approval);

    const result = await verifyReceipt({
      provider, txHash: original.txHash, wallet: original.wallet,
      destination, expectedCalldata, minConfirmations, finalityPolicy, observedReceipt
    });
    if (result.state === "UNKNOWN") return result;
    const {evidence, confirmations, blockNumber} = result;
    requireMatchingObservation(evidence, observedReceipt);
    const final = recordVerifiedApprovalReceipt(storage, key, original, evidence);
    return {state: final.state, txHash: final.txHash, confirmations, blockNumber};
  });
}

// Canonical inclusion is an observation only. This entry point never writes
// to storage and never returns authority to advance the intent lifecycle.
export async function inspectCanonicalReceipt({provider, locks, storage, scope, intentId, txHash, expectedCalldata, trustedApproval}) {
  requireCondition(typeof provider?.request === "function", "CANONICAL_SOURCE_UNCONFIGURED");
  requireCondition(typeof locks?.request === "function", "WEB_LOCKS_UNAVAILABLE");
  requireCondition(typeof intentId === "string" && HASH.test(intentId), "INVALID_INTENT_ID");
  requireCondition(typeof txHash === "string" && HASH.test(txHash), "INVALID_TX_HASH");
  const key = scopeKey(scope);
  const approval = trustedApproval === undefined ? null : approvalContext(trustedApproval);
  return locks.request(key, {mode: "exclusive"}, async lock => {
    requireCondition(lock, "WEB_LOCK_NOT_GRANTED");
    const original = readIntent(storage, key);
    requireCondition(original?.state === "UNKNOWN" && !Object.hasOwn(original, "verifiedReceipt") &&
      original.id === intentId.toLowerCase() &&
      original.txHash === txHash.toLowerCase() && original.wallet === scope.wallet.toLowerCase(),
    "CANONICAL_INTENT_MISMATCH");
    if (approval) requireApprovalMetadata(original, approval);
    else requireCondition(typeof expectedCalldata === "string" && DATA.test(expectedCalldata) &&
      hasSwapIntentMetadata(original, expectedCalldata.toLowerCase()), "SWAP_INTENT_METADATA_MISMATCH");
    const result = await boundedRead([provider], ([source]) => observeReceipt({
      provider: source, txHash: original.txHash, wallet: original.wallet, destination: original.metadata.destination,
      expectedCalldata: original.metadata.expectedCalldata, provisional: true
    }), "CANONICAL_RPC_TIMEOUT", "CANONICAL_RPC_READ_FAILED");
    requireCondition(JSON.stringify(readIntent(storage, key)) === JSON.stringify(original), "CANONICAL_INTENT_CHANGED");
    if (!result.evidence) return result;
    return {state: result.evidence.status === "success" ? "CONFIRMED_NOT_FINALIZED" : "REVERTED_NOT_FINALIZED",
      evidence: result.evidence};
  });
}

// Read-only. The boundary must hold the scope lock and compare the active
// record again after this returns. This helper never finalizes an intent.
export async function recheckTerminalReceipt({provider, record, minConfirmations = 2, finalityPolicy}) {
  requireCondition(isVerifiedTerminalIntent(record), "VERIFIED_TERMINAL_INTENT_REQUIRED");
  requireCondition(Number.isSafeInteger(minConfirmations) && minConfirmations >= 1, "INVALID_CONFIRMATIONS");
  const {blockHash, blockNumber, status} = record.verifiedReceipt;
  const result = await verifyReceipt({
    provider, txHash: record.txHash, wallet: record.wallet, destination: record.metadata.destination,
    expectedCalldata: record.metadata.expectedCalldata, minConfirmations, finalityPolicy
  });
  requireCondition(result.state !== "UNKNOWN", result.reason);
  requireCondition(result.evidence.blockHash === blockHash.toLowerCase() &&
    result.blockNumber === blockNumber, "TERMINAL_RECEIPT_BLOCK_CHANGED");
  requireCondition(result.evidence.status === status, "TERMINAL_RECEIPT_STATUS_CHANGED");
  return result.evidence;
}

export function requireFinalitySources(finalityPolicy) {
  const mode = finalityPolicy?.mode;
  requireCondition(mode === FINALIZED_DUAL_SOURCE || mode === SINGLE_SOURCE_NATIVE_FINALITY, "INVALID_FINALITY_POLICY");
  const sources = finalityPolicy.sources;
  const single = mode === SINGLE_SOURCE_NATIVE_FINALITY;
  requireCondition(Array.isArray(sources) && sources.length === (single ? 1 : 2) &&
    Array.from(sources).every(source => source?.approvedForFinality === true &&
      typeof source.id === "string" && source.id.trim() === source.id && source.id.length > 0 &&
      typeof source.provider?.request === "function") &&
    (single || (sources[0].id !== sources[1].id && sources[0].provider !== sources[1].provider)),
  "FINALITY_SOURCES_UNAPPROVED");
  return sources;
}

export function pinFinalityPolicy(policy) {
  const mode = policy?.mode;
  const sources = requireFinalitySources(policy).map(source => Object.freeze({...source}));
  return Object.freeze({mode, sources: Object.freeze(sources)});
}

async function verifyReceipt({finalityPolicy, observedReceipt, ...context}) {
  if (finalityPolicy === undefined) return observeReceipt(context);
  const sources = requireFinalitySources(finalityPolicy);
  if (finalityPolicy.mode === SINGLE_SOURCE_NATIVE_FINALITY) {
    const {id, provider} = sources[0];
    return verifySingleSource(context, provider, id, observedReceipt);
  }
  // Approval must establish independent infrastructure and real finalized-tag
  // semantics. Different names and object identities alone cannot prove either.
  return boundedRead(sources.map(({provider}) => provider), readers => corroborateFinality(context, readers),
    "FINALITY_RPC_TIMEOUT", "FINALITY_RPC_READ_FAILED");
}

async function boundedRead(providers, inspect, timeoutCode, readErrorCode) {
  let active = true;
  let timer;
  const readers = providers.map(provider => {
    const request = provider.request.bind(provider);
    return {async request(args) {
      requireCondition(active, timeoutCode);
      try { return await request(args); }
      catch (cause) { throw new Error(readErrorCode, {cause}); }
    }};
  });
  try {
    return await Promise.race([
      inspect(readers),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(timeoutCode)), FINALITY_TIMEOUT_MS);
      })
    ]);
  } finally {
    active = false;
    clearTimeout(timer);
  }
}

function parseFinalityBlock(block) {
  requireCondition(typeof block?.number === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(block.number) &&
    typeof block.hash === "string" && HASH.test(block.hash), "MALFORMED_FINALITY_BLOCK");
  return {number: BigInt(block.number), hash: block.hash.toLowerCase()};
}

function parseLatestHeight(value) {
  requireCondition(typeof value === "string" && /^0x(?:0|[1-9a-f][0-9a-f]*)$/i.test(value),
    "MALFORMED_FINALITY_LATEST");
  return BigInt(value);
}

async function verifyBlockAt(provider, number, expectedHash, code) {
  const block = parseFinalityBlock(await rpc(provider, "eth_getBlockByNumber", ["0x" + number.toString(16), false]));
  requireCondition(block.number === number && block.hash === expectedHash, code);
}

async function verifyFinalizedHead(provider, observation, {
  strictEarlierTip = true,
  readHead = () => rpc(provider, "eth_getBlockByNumber", ["finalized", false])
} = {}) {
  const head = parseFinalityBlock(await readHead());
  const latestBefore = observation.latestHeight;
  const [latestAfterHex] = await Promise.all([
    rpc(provider, "eth_blockNumber"),
    verifyBlockAt(provider, head.number, head.hash, "FINALITY_HEAD_MISMATCH"),
    verifyBlockAt(provider, BigInt(observation.blockNumber), observation.evidence.blockHash, "NONCANONICAL_BLOCK")
  ]);
  const latestAfter = parseLatestHeight(latestAfterHex);
  requireCondition(latestAfter >= latestBefore, "FINALITY_LATEST_REGRESSION");
  const ceiling = strictEarlierTip ? latestBefore : latestAfter;
  requireCondition(head.number <= ceiling, "FINALITY_HEAD_AHEAD_OF_LATEST");
  requireCondition(head.number < latestAfter, "FINALITY_HEAD_EQUALS_LATEST");
  return head;
}

async function verifySingleSource(context, provider, sourceId, observedReceipt) {
  let readingFinalizedTag = false;
  try {
    return await boundedRead([provider], async ([reader]) => {
      const observation = await observeReceipt({...context, provider: reader, finalized: true});
      if (observation.state === "UNKNOWN") return observation;
      requireMatchingObservation(observation.evidence, observedReceipt);
      const height = BigInt(observation.blockNumber);
      await verifyBlockAt(reader, height, observation.evidence.blockHash, "NONCANONICAL_BLOCK");
      const head = await verifyFinalizedHead(reader, observation, {strictEarlierTip: false, async readHead() {
        readingFinalizedTag = true;
        const block = await rpc(reader, "eth_getBlockByNumber", ["finalized", false]);
        readingFinalizedTag = false;
        return block;
      }});
      if (head.number < height) return {state: "UNKNOWN", reason: "AWAITING_FINALITY"};
      return {blockNumber: observation.blockNumber, confirmations: observation.confirmations,
        evidence: {...observation.evidence, finality: {policy: SINGLE_SOURCE_NATIVE_FINALITY, sourceId,
          checkpointHeight: head.number.toString(), checkpointHash: head.hash}}};
    }, "FINALITY_RPC_TIMEOUT", "FINALITY_RPC_READ_FAILED");
  } catch (error) {
    if (readingFinalizedTag && observedReceipt &&
        ["FINALITY_RPC_TIMEOUT", "FINALITY_RPC_READ_FAILED"].includes(error.message)) {
      throw Error("NATIVE_FINALIZED_TAG_UNAVAILABLE", {cause: error});
    }
    throw error;
  }
}

async function corroborateFinality(context, readers) {
  const observations = await Promise.all(readers.map(provider => observeReceipt({...context, provider, finalized: true})));
  const [first, second] = observations;
  if (first.state === "UNKNOWN" && second.state === "UNKNOWN") return first;
  requireCondition(first.evidence && second.evidence &&
    first.evidence.blockNumber === second.evidence.blockNumber &&
    first.evidence.blockHash === second.evidence.blockHash &&
    first.evidence.status === second.evidence.status, "FINALITY_RECEIPT_CONFLICT");
  const receiptHeight = BigInt(first.blockNumber);
  const heads = await Promise.all(readers.map((provider, index) => verifyFinalizedHead(provider, observations[index])));
  if (heads.some(head => head.number < receiptHeight)) return {state: "UNKNOWN", reason: "AWAITING_FINALITY"};
  requireCondition(heads[0].number !== heads[1].number || heads[0].hash === heads[1].hash,
    "FINALITY_CHECKPOINT_CONFLICT");
  const lower = heads[0].number <= heads[1].number ? 0 : 1;
  const checkpoint = heads[lower];
  await verifyBlockAt(readers[1 - lower], checkpoint.number, checkpoint.hash, "FINALITY_CHECKPOINT_CONFLICT");
  const confirmations = BigInt(first.confirmations) <= BigInt(second.confirmations)
    ? first.confirmations : second.confirmations;
  return {
    blockNumber: first.blockNumber, confirmations,
    evidence: {...first.evidence, confirmations, finality: {
      policy: FINALIZED_DUAL_SOURCE, checkpointHeight: checkpoint.number.toString(), checkpointHash: checkpoint.hash
    }}
  };
}

async function observeReceipt({provider, txHash, wallet, destination, expectedCalldata, minConfirmations, finalized = false, provisional = false}) {
  const chain=hexBigInt(await rpc(provider,"eth_chainId"));
  requireCondition(chain===BigInt(CHAIN_ID),"RPC_WRONG_CHAIN");
  const [tx,receipt,latestHex]=await Promise.all([
    rpc(provider,"eth_getTransactionByHash",[txHash]),
    rpc(provider,"eth_getTransactionReceipt",[txHash]),
    rpc(provider,"eth_blockNumber")
  ]);
  if(!tx||(!receipt&&!provisional))return {state:"UNKNOWN",reason:"NOT_MINED_OR_NOT_FOUND"};
  requireCondition(tx.hash?.toLowerCase()===txHash.toLowerCase(),"HASH_MISMATCH");
  requireCondition(ADDRESS.test(tx.from)&&tx.from.toLowerCase()===wallet,"SENDER_MISMATCH");
  requireCondition(ADDRESS.test(tx.to)&&tx.to.toLowerCase()===destination,"DESTINATION_MISMATCH");
  requireCondition(typeof tx.input==="string"&&tx.input.toLowerCase()===expectedCalldata.toLowerCase(),"CALLDATA_MISMATCH");
  requireCondition(hexBigInt(tx.value)===0n,"UNEXPECTED_BNB_VALUE");
  if (provisional && tx.chainId != null) requireCondition(hexBigInt(tx.chainId) === BigInt(CHAIN_ID), "TRANSACTION_WRONG_CHAIN");
  if (!receipt) return tx.blockNumber === null && tx.blockHash === null
    ? {state: "PENDING"} : {state: "UNKNOWN", reason: "NOT_MINED_OR_NOT_FOUND"};
  requireCondition(receipt.transactionHash?.toLowerCase()===txHash.toLowerCase(),"HASH_MISMATCH");
  requireCondition(receipt.from?.toLowerCase()===wallet&&receipt.to?.toLowerCase()===destination,"RECEIPT_CONTEXT_MISMATCH");
  requireCondition(typeof tx.blockHash==="string"&&tx.blockHash.toLowerCase()===receipt.blockHash?.toLowerCase()&&hexBigInt(tx.blockNumber)===hexBigInt(receipt.blockNumber),"BLOCK_MISMATCH");
  const block=hexBigInt(receipt.blockNumber),latest=finalized ? parseLatestHeight(latestHex) : hexBigInt(latestHex);
  if (provisional) {
    requireCondition(block > 0n && latest >= block && HASH.test(receipt.blockHash), "MALFORMED_CANONICAL_RECEIPT");
    await verifyBlockAt(provider, block, receipt.blockHash.toLowerCase(), "NONCANONICAL_BLOCK");
  } else if (finalized) {
    requireCondition(block > 0n && latest >= block && HASH.test(receipt.blockHash), "MALFORMED_FINALITY_RECEIPT");
  } else {
    if(latest<block||latest-block+1n<BigInt(minConfirmations))return {state:"UNKNOWN",reason:"AWAITING_CONFIRMATIONS"};
    const canonical=await rpc(provider,"eth_getBlockByNumber",[receipt.blockNumber,false]);
    requireCondition(canonical&&canonical.hash?.toLowerCase()===receipt.blockHash.toLowerCase(),"NONCANONICAL_BLOCK");
  }
  const status=hexBigInt(receipt.status);
  requireCondition(status===0n||status===1n,"INVALID_RECEIPT_STATUS");
  return {
    evidence: {chainId: CHAIN_ID, wallet, to: destination, txHash: txHash.toLowerCase(),
      calldata: tx.input.toLowerCase(), status: status === 1n ? "success" : "reverted",
      blockHash: receipt.blockHash.toLowerCase(), blockNumber: block.toString(),
      confirmations: (latest - block + 1n).toString()},
    confirmations: (latest - block + 1n).toString(), blockNumber: block.toString(), latestHeight: latest
  };
}
// A receipt proves transaction inclusion/status, not exact token amounts.
// Amount received requires event/balance-delta checks as a separate audit step.
// No automated unlock is provided. RPC trust and reorg risk remain.
