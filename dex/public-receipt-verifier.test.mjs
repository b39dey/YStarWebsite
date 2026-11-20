import {strict as assert} from "node:assert";
import {acquireIntent,markUnknown,scopeKey,readIntent} from "./public-safety.mjs";
import {verifyOnChainReceipt} from "./public-receipt-verifier.mjs";
const wallet="0x317F835aF5C5eC9089d765884DA88354f8c8680c",amm="0x17dAc8A164Ce434fE36A2D6029Bf4431a22397e2";
const now=1800000000000,hash="0x"+"b".repeat(64),id="0x"+"a".repeat(64),blockHash="0x"+"c".repeat(64),calldata="0x12345678";
const quote={chainId:56,amm,wallet,observedAtMs:now-1000,deadlineSec:Math.floor(now/1000)+300,amountIn:1n,quotedOut:2n,minimumOut:1n,blockNumber:123n};
function setup(overrides={}){const map=new Map(),storage={getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,v)};acquireIntent(storage,quote,id,now);markUnknown(storage,scopeKey(quote),id,hash);
 const tx={hash,from:wallet,to:amm,input:calldata,value:"0x0",blockHash,blockNumber:"0x64",...overrides.tx};
 const receipt={transactionHash:hash,from:wallet,to:amm,blockHash,blockNumber:"0x64",status:"0x1",...overrides.receipt};
 const replies={eth_chainId:"0x38",eth_getTransactionByHash:tx,eth_getTransactionReceipt:receipt,eth_blockNumber:"0x65",eth_getBlockByNumber:{hash:blockHash},...overrides.rpc};
 const provider={request:async({method})=>{if(replies[method] instanceof Error)throw replies[method];return replies[method]}};
 return {storage,provider,args:{provider,storage,quote,txHash:hash,expectedCalldata:calldata}}}
let count=0;async function test(name,fn){await fn();count++;console.log("PASS",name)}
await test("confirmed receipt",async()=>{const s=setup();assert.equal((await verifyOnChainReceipt(s.args)).state,"CONFIRMED")});
await test("reverted receipt",async()=>{const s=setup({receipt:{status:"0x0"}});assert.equal((await verifyOnChainReceipt(s.args)).state,"REVERTED")});
await test("pending receipt stays unknown",async()=>{const s=setup({rpc:{eth_getTransactionReceipt:null}});assert.equal((await verifyOnChainReceipt(s.args)).state,"UNKNOWN");assert.equal(readIntent(s.storage,scopeKey(quote)).state,"UNKNOWN")});
await test("insufficient confirmations stays unknown",async()=>{const s=setup({rpc:{eth_blockNumber:"0x64"}});assert.equal((await verifyOnChainReceipt(s.args)).reason,"AWAITING_CONFIRMATIONS")});
await test("wrong chain fails closed",async()=>{const s=setup({rpc:{eth_chainId:"0x1"}});await assert.rejects(()=>verifyOnChainReceipt(s.args),/RPC_WRONG_CHAIN/)});
await test("wrong sender fails closed",async()=>{const s=setup({tx:{from:"0x1111111111111111111111111111111111111111"}});await assert.rejects(()=>verifyOnChainReceipt(s.args),/SENDER_MISMATCH/)});
await test("wrong destination fails closed",async()=>{const s=setup({tx:{to:"0x1111111111111111111111111111111111111111"}});await assert.rejects(()=>verifyOnChainReceipt(s.args),/DESTINATION_MISMATCH/)});
await test("wrong calldata fails closed",async()=>{const s=setup({tx:{input:"0xabcdef12"}});await assert.rejects(()=>verifyOnChainReceipt(s.args),/CALLDATA_MISMATCH/)});
await test("nonzero BNB value fails closed",async()=>{const s=setup({tx:{value:"0x1"}});await assert.rejects(()=>verifyOnChainReceipt(s.args),/UNEXPECTED_BNB_VALUE/)});
await test("hash mismatch fails closed",async()=>{const s=setup({receipt:{transactionHash:id}});await assert.rejects(()=>verifyOnChainReceipt(s.args),/HASH_MISMATCH/)});
await test("orphaned block fails closed",async()=>{const s=setup({rpc:{eth_getBlockByNumber:{hash:id}}});await assert.rejects(()=>verifyOnChainReceipt(s.args),/NONCANONICAL_BLOCK/)});
await test("RPC error retains unknown intent",async()=>{const s=setup({rpc:{eth_getTransactionReceipt:new Error("RPC_TIMEOUT")}});await assert.rejects(()=>verifyOnChainReceipt(s.args),/RPC_TIMEOUT/);assert.equal(readIntent(s.storage,scopeKey(quote)).state,"UNKNOWN")});
console.log("PASS",count,"receipt mock checks");
