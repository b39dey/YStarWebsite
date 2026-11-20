import {CHAIN_ID, AMM, scopeKey, readIntent, recordVerifiedReceipt} from "./public-safety.mjs";
const HASH=/^0x[0-9a-fA-F]{64}$/;
const ADDRESS=/^0x[0-9a-fA-F]{40}$/;
const DATA=/^0x(?:[0-9a-fA-F]{2})+$/;
function requireCondition(ok,code){if(!ok)throw Error(code)}
function hexBigInt(x){requireCondition(typeof x==="string"&&/^0x[0-9a-fA-F]+$/.test(x),"INVALID_RPC_HEX");return BigInt(x)}
async function rpc(provider,method,params=[]){requireCondition(provider&&typeof provider.request==="function","RPC_UNAVAILABLE");return provider.request({method,params})}
/**
 * Read-only, fail-closed verification. The expected calldata must come from a
 * previously independently reviewed/signed intent, NEVER from the RPC response.
 * Missing transaction/receipt returns UNKNOWN. Any mismatch throws.
 * No wallet calls or transaction submission.
 */
export async function verifyOnChainReceipt({provider,storage,quote,txHash,expectedCalldata,minConfirmations=2}) {
  requireCondition(HASH.test(txHash),"INVALID_TX_HASH");
  requireCondition(DATA.test(expectedCalldata),"EXPECTED_CALLDATA_REQUIRED");
  requireCondition(Number.isSafeInteger(minConfirmations)&&minConfirmations>=1,"INVALID_CONFIRMATIONS");
  const key=scopeKey(quote);
  const intent=readIntent(storage,key);
  requireCondition(intent&&intent.state==="UNKNOWN","UNKNOWN_INTENT_REQUIRED");
  requireCondition(intent.txHash===txHash.toLowerCase(),"INTENT_HASH_MISMATCH");
  requireCondition(intent.wallet===quote.wallet.toLowerCase(),"INTENT_WALLET_MISMATCH");
  const chain=hexBigInt(await rpc(provider,"eth_chainId"));
  requireCondition(chain===BigInt(CHAIN_ID),"RPC_WRONG_CHAIN");
  const [tx,receipt,latestHex]=await Promise.all([
    rpc(provider,"eth_getTransactionByHash",[txHash]),
    rpc(provider,"eth_getTransactionReceipt",[txHash]),
    rpc(provider,"eth_blockNumber")
  ]);
  if(!tx||!receipt)return {state:"UNKNOWN",reason:"NOT_MINED_OR_NOT_FOUND"};
  requireCondition(tx.hash?.toLowerCase()===txHash.toLowerCase()&&receipt.transactionHash?.toLowerCase()===txHash.toLowerCase(),"HASH_MISMATCH");
  requireCondition(ADDRESS.test(tx.from)&&tx.from.toLowerCase()===intent.wallet,"SENDER_MISMATCH");
  requireCondition(ADDRESS.test(tx.to)&&tx.to.toLowerCase()===AMM,"DESTINATION_MISMATCH");
  requireCondition(typeof tx.input==="string"&&tx.input.toLowerCase()===expectedCalldata.toLowerCase(),"CALLDATA_MISMATCH");
  requireCondition(hexBigInt(tx.value)===0n,"UNEXPECTED_BNB_VALUE");
  requireCondition(receipt.from?.toLowerCase()===intent.wallet&&receipt.to?.toLowerCase()===AMM,"RECEIPT_CONTEXT_MISMATCH");
  requireCondition(typeof tx.blockHash==="string"&&tx.blockHash.toLowerCase()===receipt.blockHash?.toLowerCase()&&hexBigInt(tx.blockNumber)===hexBigInt(receipt.blockNumber),"BLOCK_MISMATCH");
  const block=hexBigInt(receipt.blockNumber),latest=hexBigInt(latestHex);
  if(latest<block||latest-block+1n<BigInt(minConfirmations))return {state:"UNKNOWN",reason:"AWAITING_CONFIRMATIONS"};
  // Canonical chain check detects basic reorg / orphaned receipt.
  const canonical=await rpc(provider,"eth_getBlockByNumber",[receipt.blockNumber,false]);
  requireCondition(canonical&&canonical.hash?.toLowerCase()===receipt.blockHash.toLowerCase(),"NONCANONICAL_BLOCK");
  const status=hexBigInt(receipt.status);
  requireCondition(status===0n||status===1n,"INVALID_RECEIPT_STATUS");
  // Re-check stored intent before persisting, to avoid overwriting a changed record.
  const current=readIntent(storage,key);
  requireCondition(current?.id===intent.id&&current?.state==="UNKNOWN"&&current.txHash===intent.txHash,"INTENT_CHANGED_DURING_VERIFICATION");
  const final=recordVerifiedReceipt(storage,key,intent.id,{chainId:CHAIN_ID,wallet:intent.wallet,to:AMM,txHash,status:status===1n?"success":"reverted"});
  return {state:final.state,txHash,confirmations:(latest-block+1n).toString(),blockNumber:block.toString()};
}
// A receipt proves transaction inclusion/status, not exact token amounts.
// Amount received requires event/balance-delta checks as a separate audit step.
// No automated unlock is provided. RPC trust and reorg risk remain.
