import {strict as assert} from "node:assert";
import {scopeKey, readIntent, markUnknown} from "./public-safety.mjs";
import {withAtomicIntent} from "./public-atomic-lock.mjs";
import {verifyOnChainReceipt} from "./public-receipt-verifier.mjs";
const wallet="0x317F835aF5C5eC9089d765884DA88354f8c8680c";
const amm="0x17dAc8A164Ce434fE36A2D6029Bf4431a22397e2";
const now=1800000000000, hash="0x"+"b".repeat(64), blockHash="0x"+"c".repeat(64), data="0x12345678";
const id=n=>"0x"+n.repeat(64);
const quote={chainId:56,amm,wallet,observedAtMs:now-1000,deadlineSec:Math.floor(now/1000)+300,amountIn:1n,quotedOut:2n,minimumOut:1n,blockNumber:123n};
function store(){const m=new Map();return {getItem:k=>m.has(k)?m.get(k):null,setItem:(k,v)=>m.set(k,v)}}
function locks(){const tail=new Map();return {async request(key,opts,fn){assert.equal(opts.mode,"exclusive");const before=tail.get(key)||Promise.resolve();let done;const current=new Promise(r=>done=r);tail.set(key,current);await before;try{return await fn({name:key})}finally{done();if(tail.get(key)===current)tail.delete(key)}}}}
function rpc(overrides={}){const values={eth_chainId:"0x38",eth_getTransactionByHash:{hash,from:wallet,to:amm,input:data,value:"0x0",blockHash,blockNumber:"0x64"},eth_getTransactionReceipt:{transactionHash:hash,from:wallet,to:amm,blockHash,blockNumber:"0x64",status:"0x1"},eth_blockNumber:"0x65",eth_getBlockByNumber:{hash:blockHash},...overrides};return {request:async({method})=>{if(values[method] instanceof Error)throw values[method];return values[method]}}}
async function prepare({storage=store(),lockManager=locks(),q=quote,intentId=id("a"),callback=async()=>{}}={}){await withAtomicIntent({locks:lockManager,storage,quote:q,intentId,nowMs:now,onAcquired:callback});return storage}
async function unknown(storage){markUnknown(storage,scopeKey(quote),id("a"),hash)}
async function verify(storage,provider=rpc(),extra={}){return verifyOnChainReceipt({provider,storage,quote,txHash:hash,expectedCalldata:data,...extra})}
let passed=0;async function test(name,fn){await fn();passed++;console.log("PASS",name)}
await test("full flow confirms after verified receipt",async()=>{const s=await prepare();await unknown(s);assert.equal((await verify(s)).state,"CONFIRMED");assert.equal(readIntent(s,scopeKey(quote)).state,"CONFIRMED")});
await test("full flow records reverted transaction",async()=>{const s=await prepare();await unknown(s);const p=rpc({eth_getTransactionReceipt:{transactionHash:hash,from:wallet,to:amm,blockHash,blockNumber:"0x64",status:"0x0"}});assert.equal((await verify(s,p)).state,"REVERTED")});
await test("pending receipt remains unknown then recovers",async()=>{const s=await prepare();await unknown(s);assert.equal((await verify(s,rpc({eth_getTransactionReceipt:null}))).state,"UNKNOWN");assert.equal((await verify(s)).state,"CONFIRMED")});
await test("RPC failure retains unknown then recovers",async()=>{const s=await prepare();await unknown(s);await assert.rejects(()=>verify(s,rpc({eth_getTransactionReceipt:new Error("TIMEOUT")})),/TIMEOUT/);assert.equal(readIntent(s,scopeKey(quote)).state,"UNKNOWN");assert.equal((await verify(s)).state,"CONFIRMED")});
await test("wrong calldata cannot finalize",async()=>{const s=await prepare();await unknown(s);await assert.rejects(()=>verify(s,rpc({eth_getTransactionByHash:{hash,from:wallet,to:amm,input:"0xdeadbeef",value:"0x0",blockHash,blockNumber:"0x64"}})),/CALLDATA_MISMATCH/);assert.equal(readIntent(s,scopeKey(quote)).state,"UNKNOWN")});
await test("insufficient confirmations then finalizes",async()=>{const s=await prepare();await unknown(s);assert.equal((await verify(s,rpc({eth_blockNumber:"0x64"}))).state,"UNKNOWN");assert.equal((await verify(s)).state,"CONFIRMED")});
await test("concurrent intent requests allow one",async()=>{const s=store(),l=locks();let called=0;const run=n=>prepare({storage:s,lockManager:l,intentId:id(n),callback:async()=>{called++;await Promise.resolve()}});const r=await Promise.allSettled([run("a"),run("b")]);assert.equal(r.filter(x=>x.status==="fulfilled").length,1);assert.equal(called,1)});
await test("callback error keeps lock and prevents retry",async()=>{const s=store();await assert.rejects(()=>prepare({storage:s,callback:async()=>{throw Error("WALLET_REJECTED")}}),/WALLET_REJECTED/);await assert.rejects(()=>prepare({storage:s}),/INTENT_ALREADY_LOCKED/)});
await test("final intent cannot be reacquired",async()=>{const s=await prepare();await unknown(s);await verify(s);await assert.rejects(()=>prepare({storage:s}),/INTENT_ALREADY_LOCKED/)});
await test("invalid quote never creates intent",async()=>{const s=store();await assert.rejects(()=>prepare({storage:s,q:{...quote,observedAtMs:now-31000}}),/QUOTE_STALE/);assert.equal(readIntent(s,scopeKey(quote)),null)});
console.log("PASS",passed,"public integration mock checks");
