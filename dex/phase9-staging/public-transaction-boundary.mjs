import {runOfflineIntent} from "./public-offline-intent.mjs";
import {AMM, CHAIN_ID, createIntentRecord, isVerifiedTerminalIntent, readIntent, scopeKey, validateQuote} from "./public-safety.mjs";
import {recheckTerminalReceipt, pinFinalityPolicy} from "./public-receipt-verifier.mjs";

const USDT = "0x55d398326f99059ff775485246999027b3197955";
const YST = "0x2e9803942daf364a803f4c01d3e49d431ddf1421";
// SimpleAMMV4 tokenA = YST, tokenB = USDT in the reviewed configuration.
const DIRECTIONS = Object.freeze({
  USDT_TO_YST: {inputToken: USDT, outputToken: YST, selector: "0x8e6bcbf0"},
  YST_TO_USDT: {inputToken: YST, outputToken: USDT, selector: "0xc8f9edd8"}
});
const APPROVE = "0x095ea7b3";
const HASH = /^0x[0-9a-f]{64}$/i;
const ADDRESS = /^0x[0-9a-f]{40}$/i;
// Hold affected guarded scopes for manual review for the lifetime of the page.
const unverifiedScopes = new WeakMap();
const firstUseAuthorizations = new WeakMap();
const consumedFirstUseScopes = new WeakMap();
const FIRST_USE_MAX_AGE_MS = 30_000;

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function word(value) {
  return value.toString(16).padStart(64, "0");
}

function prepare(operation, transaction, quote, account, direction, route) {
  const swap = operation === "SWAP";
  const {inputToken, outputToken, selector} = route;
  const destination = swap ? AMM : inputToken;
  const expectedCalldata = swap
    ? selector + word(quote.amountIn) + word(quote.minimumOut) + word(BigInt(quote.deadlineSec))
    : APPROVE + AMM.slice(2).padStart(64, "0") + word(quote.amountIn);

  assert(typeof transaction?.from === "string" && transaction.from.toLowerCase() === account,
    "TRANSACTION_SENDER_MISMATCH");
  assert(typeof transaction.to === "string" && transaction.to.toLowerCase() === destination,
    "TRANSACTION_DESTINATION_MISMATCH");
  assert(typeof transaction.data === "string" && transaction.data.toLowerCase() === expectedCalldata,
    "TRANSACTION_CALLDATA_MISMATCH");
  assert(transaction.value === "0x0", "ZERO_NATIVE_VALUE_REQUIRED");

  const metadata = {
    destination, expectedCalldata, value: "0x0", direction, inputToken, outputToken,
    amountIn: quote.amountIn.toString(), minimumOutput: quote.minimumOut.toString(),
    observedAtMs: quote.observedAtMs, deadlineSec: quote.deadlineSec
  };
  if (!swap) Object.assign(metadata, {token: inputToken, spender: AMM, amount: metadata.amountIn});
  return {
    metadata,
    request: Object.freeze({from: account, to: destination, data: expectedCalldata, value: "0x0"})
  };
}

function errorOutcome(error) {
  if (error?.code === 4001) return "USER_REJECTED";
  if (error?.name === "TimeoutError" || ["TIMEOUT", "ETIMEDOUT"].includes(error?.code)) return "TIMEOUT";
  return "PROVIDER_ERROR";
}

/**
 * Legacy mock-only entry point. Never use this for a wallet handoff.
 * It preserves fixture-only progression without fresh receipt reads.
 */
export async function runOfflineTransactionBoundary(options) {
  return runBoundary(options);
}

// Internal pilot fixture API. The declaration and reader are synthetic
// evidence supplied by the operator harness. No wallet requests are made here.
export function issueSyntheticFirstUseAuthorization({
  storage, snapshot, quote, transaction, operation, direction, intentId, reviewedAllowance,
  review, readSyntheticNonces, clock = Date.now
}) {
  const key = scopeKey(quote);
  const scope = Object.freeze({chainId: CHAIN_ID, wallet: quote.wallet.toLowerCase(), amm: AMM});
  assert(typeof storage?.getItem === "function" && typeof storage?.setItem === "function" &&
    snapshot?.valid === true && snapshot.provider && snapshot.account === scope.wallet &&
    snapshot.chainId === CHAIN_ID, "FIRST_USE_SCOPE_INVALID");
  assert((operation === "SWAP" || operation === "APPROVAL") && Object.hasOwn(DIRECTIONS, direction) &&
    typeof intentId === "string" && HASH.test(intentId) && typeof reviewedAllowance === "bigint" &&
    typeof readSyntheticNonces === "function", "FIRST_USE_CONTEXT_INVALID");
  assert(review?.dedicatedWalletProvenanceReviewed === true && review.singleOperatorContextReviewed === true &&
    review.noPendingWalletRequestsReviewed === true && review.noPriorHashesReviewed === true &&
    review.latestNonce === 0n && review.pendingNonce === 0n && review.exactTransactionReviewed === true &&
    review.manualReconciliationDeclared === true &&
    [review.operator, review.origin, review.profile].every(value => typeof value === "string" && value.trim()),
  "FIRST_USE_REVIEW_REQUIRED");
  const issuedAt = clock();
  validateQuote(quote, issuedAt);
  const authorization = Object.freeze({});
  firstUseAuthorizations.set(authorization, {
    storage, key, scope, snapshot, provider: snapshot.provider, quote, transaction: Object.freeze({...transaction}),
    operation, direction, intentId: intentId.toLowerCase(), reviewedAllowance, review: Object.freeze({...review}),
    readSyntheticNonces, issuedAt, expiresAt: issuedAt + FIRST_USE_MAX_AGE_MS
  });
  return authorization;
}

/**
 * Protected entry point for offline integration. Any future wallet handoff
 * must use this guarded path. Use a synthetic receipt provider in this step.
 * The second argument accepts {provider, minConfirmations} for development
 * depth checks or {finalityPolicy} for an explicit native-finality policy.
 * There is no option to skip the check during progression.
 * If a valid hash cannot be read back, returns
 * {outcome: "HASH_RECEIVED_PERSISTENCE_UNVERIFIED", intent: null, txHash, intentId, scope}.
 */
export async function runRevalidatedOfflineTransactionBoundary(options, receiptCheck) {
  const {provider, minConfirmations, finalityPolicy} = receiptCheck ?? {};
  const pinnedPolicy = finalityPolicy === undefined ? undefined : pinFinalityPolicy(finalityPolicy);
  if (options.progression) {
    assert(finalityPolicy !== undefined || typeof provider?.request === "function", "TERMINAL_RECEIPT_PROVIDER_REQUIRED");
  }
  return runBoundary(options, {provider, minConfirmations, finalityPolicy: pinnedPolicy});
}

/**
 * Call once for each explicit mock user action. The caller supplies the
 * prepared session snapshot, a fresh scoped quote, and exact request bytes.
 * Choose USDT_TO_YST or YST_TO_USDT. APPROVAL targets the route's input
 * token and uses the quoted input amount. Without preflight, explicit SWAP
 * directions require synchronous readMockAllowance. The omitted-direction
 * USDT route retains its optional allowance hook, except after terminal approval.
 *
 * Optional preflight(context) runs under the scope lock before intent writes.
 * Supply reviewedAllowance as a bigint from the reviewed preview. The hook
 * must make its own injected mock reads and return {context, provider, account,
 * chainId, inputToken, spender, allowance}, echoing the exact context object.
 * Integrations must include preview invalidation in session.isCurrent.
 * simulateSubmission receives only {operation, intentId, transaction}; it
 * must be an offline mock. This adapter never invokes a wallet provider.
 *
 * Returns {intent, outcome, sessionChanged}. All submission outcomes remain
 * UNKNOWN until separately verified. This function schedules no timeout,
 * retry or follow-up action. Failures before a valid hash is observed throw
 * when they prevent intent persistence or readback.
 */
async function runBoundary({
  session, snapshot, storage, locks, clock = Date.now, operation, intentId,
  quote, transaction, direction, readMockAllowance, preflight, reviewedAllowance, progression, simulateSubmission,
  firstUseAuthorization
}, receiptCheck) {
  assert(operation === "SWAP" || operation === "APPROVAL", "INVALID_OPERATION");
  assert(typeof intentId === "string" && HASH.test(intentId), "INVALID_INTENT_ID");
  assert(typeof simulateSubmission === "function", "MOCK_SUBMISSION_REQUIRED");
  assert(typeof locks?.request === "function", "WEB_LOCKS_UNAVAILABLE");
  assert(typeof clock === "function", "CLOCK_REQUIRED");
  if (preflight !== undefined) {
    assert(typeof preflight === "function", "INVALID_PREFLIGHT");
    assert(typeof reviewedAllowance === "bigint" && reviewedAllowance >= 0n && reviewedAllowance < (1n << 256n),
      "REVIEWED_ALLOWANCE_REQUIRED");
  }
  const selectedDirection = direction === undefined ? "USDT_TO_YST" : direction;
  assert(typeof selectedDirection === "string" && Object.hasOwn(DIRECTIONS, selectedDirection),
    "UNSUPPORTED_SWAP_DIRECTION");
  const route = DIRECTIONS[selectedDirection];
  assert(snapshot?.provider && snapshot.valid === true && snapshot.chainId === CHAIN_ID &&
    typeof snapshot.account === "string" && ADDRESS.test(snapshot.account) &&
    typeof session?.isCurrent === "function", "VALID_BSC_SESSION_REQUIRED");

  const preparedQuote = Object.freeze({...quote});
  const key = scopeKey(preparedQuote);
  const provider = snapshot.provider;
  const account = snapshot.account.toLowerCase();
  assert(preparedQuote.wallet.toLowerCase() === account, "QUOTE_ACCOUNT_MISMATCH");
  const nowMs = clock();
  validateQuote(preparedQuote, nowMs);
  assert(session.isCurrent(snapshot), "WALLET_SESSION_CHANGED");
  const {metadata, request} = prepare(operation, transaction, preparedQuote, account, selectedDirection, route);
  const persistedMetadata = {...metadata, operation, chainId: CHAIN_ID, wallet: account};
  const expectedMetadata = JSON.stringify(persistedMetadata);
  const firstUse = firstUseAuthorization !== undefined;
  if (firstUse) assert(receiptCheck && !progression && preflight && direction !== undefined, "FIRST_USE_GUARDED_PREFLIGHT_REQUIRED");
  const preflightContext = preflight && Object.freeze({
    provider, snapshot, account, chainId: CHAIN_ID, intentId: intentId.toLowerCase(),
    operation, direction: selectedDirection, amountIn: preparedQuote.amountIn, quote: preparedQuote,
    transaction: request, inputToken: route.inputToken, spender: AMM, reviewedAllowance
  });

  function requireReady() {
    validateQuote(preparedQuote, clock());
    assert(session.isCurrent(snapshot) && snapshot.valid === true && snapshot.provider === provider &&
      snapshot.chainId === CHAIN_ID && snapshot.account?.toLowerCase() === account, "WALLET_SESSION_CHANGED");
  }

  function checkAllowance(required) {
    if (operation !== "SWAP") return;
    const readAllowance = readMockAllowance ?? progression?.readMockAllowance;
    if (!required && readAllowance === undefined) return;
    assert(typeof readAllowance === "function", "MOCK_ALLOWANCE_READER_REQUIRED");
    const allowance = readAllowance({account, token: route.inputToken, spender: AMM});
    assert(typeof allowance === "bigint" && allowance >= preparedQuote.amountIn, "MOCK_ALLOWANCE_INSUFFICIENT");
  }

  function readPreparedIntent() {
    const intent = readIntent(storage, key);
    assert(intent?.id === intentId.toLowerCase() && intent.state === "UNKNOWN" && intent.txHash === null &&
      intent.amountIn === preparedQuote.amountIn.toString() &&
      intent.minimumOut === preparedQuote.minimumOut.toString() &&
      intent.blockNumber === preparedQuote.blockNumber.toString() &&
      JSON.stringify(intent.metadata) === expectedMetadata, "PREPARED_INTENT_NOT_PERSISTED");
    if (firstUse) {
      const expected = {...createIntentRecord(preparedQuote, intentId, nowMs), state: "UNKNOWN", metadata: persistedMetadata};
      assert(JSON.stringify(intent) === JSON.stringify(expected), "FIRST_USE_INTENT_READBACK_MISMATCH");
    }
    return intent;
  }

  async function consumeFirstUse() {
    const authorization = firstUseAuthorizations.get(firstUseAuthorization);
    const requireAuthorization = () => {
      const currentTime = clock();
      assert(authorization && firstUseAuthorizations.get(firstUseAuthorization) === authorization &&
        !consumedFirstUseScopes.get(storage)?.has(key), "FIRST_USE_AUTHORIZATION_UNAVAILABLE");
      assert(currentTime >= authorization.issuedAt && currentTime < authorization.expiresAt, "FIRST_USE_AUTHORIZATION_EXPIRED");
      assert(authorization.storage === storage && authorization.key === key && authorization.snapshot === snapshot &&
        authorization.provider === provider && authorization.quote === quote && authorization.operation === operation &&
        authorization.direction === direction && authorization.intentId === intentId.toLowerCase() &&
        authorization.reviewedAllowance === reviewedAllowance &&
        Reflect.ownKeys(authorization.transaction).length === 4 && Reflect.ownKeys(transaction).length === 4 &&
        Object.keys(request).every(field => Object.hasOwn(transaction, field) && Object.hasOwn(authorization.transaction, field) &&
          request[field] === transaction[field] && request[field] === authorization.transaction[field]),
      "FIRST_USE_AUTHORIZATION_MISMATCH");
      requireReady();
      assert(storage.getItem(key) === null && storage.getItem("ystar-public-intent-history-v1:" + key) === null,
        "FIRST_USE_SCOPE_NOT_CLEAN");
    };
    requireAuthorization();
    const nonces = await authorization.readSyntheticNonces(authorization.scope);
    requireAuthorization();
    assert(nonces?.chainId === CHAIN_ID && nonces.wallet === account &&
      nonces.latestNonce === authorization.review.latestNonce && nonces.pendingNonce === authorization.review.pendingNonce,
    "FIRST_USE_NONCE_EVIDENCE_MISMATCH");
    firstUseAuthorizations.delete(firstUseAuthorization);
    let consumed = consumedFirstUseScopes.get(storage);
    if (!consumed) {
      consumed = new Set();
      consumedFirstUseScopes.set(storage, consumed);
    }
    consumed.add(key);
  }

  const previousIntentId = progression?.previousIntentId;
  let checkedTerminal;
  let submittedIntent;
  let receivedHash;
  let unverifiedResult;
  const guardedLocks = {request(key, options, callback) {
    return locks.request(key, options, async lock => {
      if (!lock) return callback(lock);
      if (receiptCheck) assert(!unverifiedScopes.get(storage)?.has(key), "HASH_PERSISTENCE_RECONCILIATION_REQUIRED");
      requireReady();
      let terminal;
      let terminalRaw;
      if (progression && receiptCheck) {
        terminalRaw = storage.getItem(key);
        terminal = readIntent(storage, key);
        assert(isVerifiedTerminalIntent(terminal) && terminal.id === previousIntentId,
          "VERIFIED_TERMINAL_INTENT_REQUIRED");
      }
      if (preflight) {
        const result = await preflight(preflightContext);
        requireReady();
        assert(result?.context === preflightContext && result.provider === provider &&
          typeof result.account === "string" && result.account.toLowerCase() === account &&
          result.chainId === CHAIN_ID && result.inputToken === route.inputToken && result.spender === AMM,
        "PREFLIGHT_IDENTITY_MISMATCH");
        assert(result.allowance === reviewedAllowance, "PREFLIGHT_ALLOWANCE_CHANGED");
        if (operation === "SWAP") {
          assert(result.allowance >= preparedQuote.amountIn, "PREFLIGHT_ALLOWANCE_INSUFFICIENT");
        } else {
          assert(result.allowance < preparedQuote.amountIn, "PREFLIGHT_APPROVAL_NOT_REQUIRED");
        }
      } else if (!progression) {
        checkAllowance(direction !== undefined);
      }
      if (progression && receiptCheck) {
        await recheckTerminalReceipt({...receiptCheck, record: terminal});
        checkedTerminal = JSON.stringify(terminal);
        assert(storage.getItem(key) === terminalRaw && JSON.stringify(readIntent(storage, key)) === checkedTerminal,
          "TERMINAL_INTENT_CHANGED");
        requireReady();
      }
      if (firstUse) {
        await consumeFirstUse();
        requireReady();
      }
      if (!receiptCheck) return callback(lock);
      try {
        const saved = await callback(lock);
        if (receivedHash) {
          assert(JSON.stringify(saved) === JSON.stringify({...submittedIntent, txHash: receivedHash}),
            "HASH_READBACK_MISMATCH");
        }
        return saved;
      } catch (error) {
        if (!receivedHash) throw error;
        let blockedScopes = unverifiedScopes.get(storage);
        if (!blockedScopes) {
          blockedScopes = new Set();
          unverifiedScopes.set(storage, blockedScopes);
        }
        blockedScopes.add(key);
        unverifiedResult = {
          outcome: "HASH_RECEIVED_PERSISTENCE_UNVERIFIED", intent: null,
          txHash: receivedHash, intentId: submittedIntent.id,
          scope: Object.freeze({chainId: preparedQuote.chainId, wallet: account, amm: AMM})
        };
        return null;
      }
    });
  }};

  let outcome = "UNKNOWN";
  const intent = await runOfflineIntent({
    operation, locks: guardedLocks, storage, quote: preparedQuote, intentId, nowMs,
    transaction: metadata,
    progression: progression && {
      previousIntentId, clock,
      assertReady(previous) {
        if (receiptCheck) assert(JSON.stringify(previous) === checkedTerminal, "TERMINAL_INTENT_CHANGED");
        if (!preflight) checkAllowance(direction !== undefined || previous.metadata.operation === "APPROVAL");
        requireReady();
        return true;
      }
    },
    simulateSubmission: async details => {
      submittedIntent = readPreparedIntent();
      requireReady();
      let hash;
      try {
        hash = await simulateSubmission({...details, transaction: request});
      } catch (error) {
        outcome = errorOutcome(error);
      }
      if (typeof hash === "string" && HASH.test(hash)) receivedHash = hash.toLowerCase();
      // The result belongs to the captured scope even if the UI has moved
      // to another session. Check that scope again before attaching a hash.
      readPreparedIntent();
      if (receivedHash) {
        outcome = "HASH_RECORDED";
        return receivedHash;
      }
      return null;
    }
  });
  if (unverifiedResult) return unverifiedResult;
  return {intent, outcome, sessionChanged: !session.isCurrent(snapshot)};
}
