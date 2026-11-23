import {AMM, CHAIN_ID, MAX_QUOTE_AGE_MS, validateQuote} from "./public-safety.mjs";

const YST = Object.freeze({symbol: "YST", address: "0x2e9803942daf364a803f4c01d3e49d431ddf1421"});
const USDT = Object.freeze({symbol: "USDT", address: "0x55d398326f99059ff775485246999027b3197955"});
// Selectors are from the reviewed SimpleAMMV4 compiler ABI and ERC-20 ABI.
const ROUTES = Object.freeze({
  USDT_TO_YST: {input: USDT, output: YST, selector: "0x8e6bcbf0"},
  YST_TO_USDT: {input: YST, output: USDT, selector: "0xc8f9edd8"}
});
const SCALE = 10n ** 18n;
const UINT256_MAX = (1n << 256n) - 1n;
// SHA-256 of the 12,586-byte immutable-filled runtime verified in Step 40B.
const AMM_RUNTIME_SHA256 = "abec2e54fe16d50574808bf2c6bc1a4f834bb468746c04f6f4e8fe7a033f221a";
const READ_METHODS = new Set(["eth_accounts", "eth_chainId", "eth_getBlockByNumber", "eth_getCode", "eth_call"]);
const word = value => value.toString(16).padStart(64, "0");

function requireValue(condition, message) {
  if (!condition) throw Error(message);
}

function quantity(value) {
  requireValue(typeof value === "string" && /^0x[0-9a-f]+$/i.test(value), "Malformed RPC quantity.");
  return BigInt(value);
}

function uint256(value) {
  requireValue(typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value), "Unexpected ABI response.");
  return BigInt(value);
}

function address(value) {
  requireValue(typeof value === "string" && /^0x0{24}[0-9a-f]{40}$/i.test(value), "Unexpected ABI address.");
  return "0x" + value.slice(-40).toLowerCase();
}

function parseAmount(value) {
  const parts = typeof value === "string" && /^(0|[1-9][0-9]{0,77})(?:\.([0-9]{1,18}))?$/.exec(value.trim());
  requireValue(parts, "Enter a positive decimal amount with at most 18 decimal places.");
  const amount = BigInt(parts[1]) * SCALE + BigInt((parts[2] ?? "").padEnd(18, "0"));
  requireValue(amount > 0n && amount <= UINT256_MAX, "Input is outside the supported token amount range.");
  return amount;
}

export function formatPreviewAmount(value) {
  const fraction = (value % SCALE).toString().padStart(18, "0").replace(/0+$/, "");
  return (value / SCALE).toString() + (fraction ? "." + fraction : "");
}

async function verifyPreviewAccount(read, account) {
  requireValue(quantity(await read("eth_chainId")) === BigInt(CHAIN_ID), "Select BSC Mainnet (56) in your wallet.");
  const accounts = await read("eth_accounts");
  requireValue(Array.isArray(accounts) && typeof accounts[0] === "string" &&
    accounts[0].toLowerCase() === account, "Wallet account differs from the selected session. Refresh it first.");
}

function readAllowance(read, token, account, at) {
  return read("eth_call", [{to: token, data: "0xdd62ed3e" + word(BigInt(account)) + word(BigInt(AMM))}, at])
    .then(uint256);
}

// The handoff supplies a fixture-backed reader. Check the original anchor
// and current allowance without preparing new transaction bytes.
export async function recheckReviewedQuote({quote, blockHash, direction, read}) {
  validateQuote(quote);
  requireValue(typeof direction === "string" && Object.hasOwn(ROUTES, direction), "Select a supported swap direction.");
  requireValue(typeof blockHash === "string" && /^0x[0-9a-f]{64}$/i.test(blockHash), "Missing reviewed block hash.");
  const inputToken = ROUTES[direction].input.address;
  await verifyPreviewAccount(read, quote.wallet);
  const at = "0x" + quote.blockNumber.toString(16);
  const block = await read("eth_getBlockByNumber", [at, false]);
  requireValue(quantity(block?.number) === quote.blockNumber && block.hash?.toLowerCase() === blockHash.toLowerCase(),
    "Quote block changed. Prepare a fresh preview.");
  const allowance = await readAllowance(read, inputToken, quote.wallet, "latest");
  await verifyPreviewAccount(read, quote.wallet);
  validateQuote(quote);
  return {inputToken, allowance};
}

// No permission, signing, submission or network switching. The caller
// supplies a selected session and an invalidation guard for this preview.
export async function prepareReadOnlyQuote({snapshot, direction, amount, isCurrent, clock = Date.now}) {
  requireValue(typeof direction === "string" && Object.hasOwn(ROUTES, direction), "Select a supported swap direction.");
  requireValue(snapshot?.valid && snapshot.chainId === CHAIN_ID &&
    /^0x[0-9a-f]{40}$/i.test(snapshot.account ?? "") &&
    typeof snapshot.provider?.request === "function", "Select a valid BSC wallet session.");
  requireValue(globalThis.crypto?.subtle, "Runtime verification requires a secure browser context.");
  const {provider, account} = snapshot;
  const route = ROUTES[direction];
  const amountIn = parseAmount(amount);
  const observedAtMs = clock();
  async function read(method, params = []) {
    requireValue(READ_METHODS.has(method), "Preview method is not permitted.");
    requireValue(isCurrent(snapshot), "Wallet or preview selection changed.");
    let result;
    try {
      result = await provider.request({method, params});
    } catch {
      throw Error("Selected wallet could not complete " + method + ".");
    }
    requireValue(isCurrent(snapshot), "Wallet or preview selection changed.");
    return result;
  }
  await verifyPreviewAccount(read, account);
  const block = await read("eth_getBlockByNumber", ["latest", false]);
  const blockNumber = quantity(block?.number);
  const blockTime = Number(quantity(block?.timestamp));
  requireValue(/^0x[0-9a-f]{64}$/i.test(block?.hash ?? "") && Number.isSafeInteger(blockTime) &&
    Math.abs(observedAtMs - blockTime * 1000) <= MAX_QUOTE_AGE_MS, "Provider returned a stale or invalid quote block.");
  const at = block.number;
  const code = await read("eth_getCode", [AMM, at]);
  requireValue(typeof code === "string" && /^0x[0-9a-f]{25172}$/i.test(code),
    "AMM runtime size differs from the reviewed deployment.");
  const bytes = Uint8Array.from(code.slice(2).match(/../g), byte => Number.parseInt(byte, 16));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  requireValue(isCurrent(snapshot), "Wallet or preview selection changed.");
  const runtimeHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  requireValue(runtimeHash === AMM_RUNTIME_SHA256, "AMM runtime differs from the reviewed deployment.");

  const call = (to, data) => read("eth_call", [{to, data}, at]);
  requireValue(address(await call(AMM, "0x0fc63d10")) === YST.address &&
    address(await call(AMM, "0x5f64b55b")) === USDT.address, "AMM token ordering differs from the reviewed deployment.");
  requireValue(uint256(await call(YST.address, "0x313ce567")) === 18n &&
    uint256(await call(USDT.address, "0x313ce567")) === 18n, "Unexpected token decimals.");
  const reserveA = uint256(await call(AMM, "0xdc5fa6c5"));
  const reserveB = uint256(await call(AMM, "0x19e36f3b"));
  const [reserveIn, reserveOut] = route.input === YST ? [reserveA, reserveB] : [reserveB, reserveA];
  requireValue(reserveIn > 0n && reserveOut > 0n, "The pool has no usable reserves.");
  const quotedOut = uint256(await call(AMM, "0x054d50d4" + word(amountIn) + word(reserveIn) + word(reserveOut)));
  requireValue(quotedOut < reserveOut, "Quote exceeds the available output reserve.");
  const allowance = await readAllowance(read, route.input.address, account, at);
  const anchor = await read("eth_getBlockByNumber", [at, false]);
  requireValue(anchor?.number === at && anchor.hash?.toLowerCase() === block.hash.toLowerCase(),
    "Quote block changed. Prepare a fresh preview.");
  const blockHash = anchor.hash.toLowerCase();
  await verifyPreviewAccount(read, account);

  const quote = Object.freeze({
    chainId: CHAIN_ID, amm: AMM, wallet: account, blockNumber, observedAtMs,
    deadlineSec: Math.min(blockTime, Math.floor(observedAtMs / 1000)) + 600,
    amountIn, quotedOut, minimumOut: quotedOut * 995n / 1000n
  });
  validateQuote(quote, clock());
  const swap = Object.freeze({
    from: account, to: AMM, value: "0x0",
    data: route.selector + word(amountIn) + word(quote.minimumOut) + word(BigInt(quote.deadlineSec))
  });
  const approval = allowance < amountIn ? Object.freeze({
    from: account, to: route.input.address, value: "0x0",
    data: "0x095ea7b3" + word(BigInt(AMM)) + word(amountIn)
  }) : null;
  return {quote, blockHash, input: route.input, output: route.output, allowance, approval, swap};
}
