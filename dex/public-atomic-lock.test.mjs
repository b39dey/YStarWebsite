import {strict as assert} from "node:assert";
import {withAtomicIntent} from "./public-atomic-lock.mjs";
import {scopeKey,readIntent} from "./public-safety.mjs";
const wallet="0x317F835aF5C5eC9089d765884DA88354f8c8680c";
const other="0x1111111111111111111111111111111111111111";
const amm="0x17dAc8A164Ce434fE36A2D6029Bf4431a22397e2";
const now=1_800_000_000_000;
const quote={chainId:56,amm,wallet,observedAtMs:now-1000,deadlineSec:Math.floor(now/1000)+300,amountIn:100000000000000000n,quotedOut:1630393132589472651104n,minimumOut:1622241166926525287848n,blockNumber:133115164n};
const id=n=>"0x"+n.repeat(64);
function store(){const map=new Map();return {getItem:k=>map.has(k)?map.get(k):null,setItem:(k,v)=>map.set(k,v)}}
function mockLocks(){const tails=new Map();return {async request(key,opts,fn){assert.equal(opts.mode,"exclusive");const previous=tails.get(key)||Promise.resolve();let release;const current=new Promise(r=>release=r);tails.set(key,current);await previous;try{return await fn({name:key})}finally{release();if(tails.get(key)===current)tails.delete(key)}}}}
let passed=0;async function test(name,fn){await fn();passed++;console.log("PASS",name)}
await test("one of two concurrent tabs acquires intent",async()=>{const storage=store(),locks=mockLocks();let entered=0;const run=i=>withAtomicIntent({locks,storage,quote,intentId:id(i),nowMs:now,onAcquired:async()=>{entered++;await Promise.resolve();return "ok"}});const results=await Promise.allSettled([run("a"),run("b")]);assert.equal(results.filter(x=>x.status==="fulfilled").length,1);assert.equal(results.filter(x=>x.status==="rejected"&&/INTENT_ALREADY_LOCKED/.test(x.reason.message)).length,1);assert.equal(entered,1)});
await test("persistent lock survives new lock manager",async()=>{const storage=store();await withAtomicIntent({locks:mockLocks(),storage,quote,intentId:id("c"),nowMs:now,onAcquired:async()=>{}});await assert.rejects(()=>withAtomicIntent({locks:mockLocks(),storage,quote,intentId:id("d"),nowMs:now,onAcquired:async()=>{}}),/INTENT_ALREADY_LOCKED/)});
await test("different wallets use independent keys",async()=>{const storage=store(),locks=mockLocks();const result=await Promise.all([withAtomicIntent({locks,storage,quote,intentId:id("e"),nowMs:now,onAcquired:async()=>1}),withAtomicIntent({locks,storage,quote:{...quote,wallet:other},intentId:id("f"),nowMs:now,onAcquired:async()=>2})]);assert.deepEqual(result,[1,2])});
await test("missing Web Locks fails closed",async()=>{await assert.rejects(()=>withAtomicIntent({locks:null,storage:store(),quote,intentId:id("a"),nowMs:now,onAcquired:async()=>{}}),/WEB_LOCKS_UNAVAILABLE/)});
await test("missing storage fails closed",async()=>{await assert.rejects(()=>withAtomicIntent({locks:mockLocks(),storage:null,quote,intentId:id("a"),nowMs:now,onAcquired:async()=>{}}),/STORAGE_UNAVAILABLE/)});
await test("missing callback fails closed",async()=>{await assert.rejects(()=>withAtomicIntent({locks:mockLocks(),storage:store(),quote,intentId:id("a"),nowMs:now}),/CALLBACK_REQUIRED/)});
await test("callback failure retains persistent intent",async()=>{const storage=store();await assert.rejects(()=>withAtomicIntent({locks:mockLocks(),storage,quote,intentId:id("a"),nowMs:now,onAcquired:async()=>{throw Error("SIMULATED_FAILURE")}}),/SIMULATED_FAILURE/);assert.equal(readIntent(storage,scopeKey(quote)).state,"LOCKED")});
await test("corrupt persistent intent fails closed",async()=>{const storage=store();storage.setItem(scopeKey(quote),"{bad");await assert.rejects(()=>withAtomicIntent({locks:mockLocks(),storage,quote,intentId:id("a"),nowMs:now,onAcquired:async()=>{}}),/INTENT_RECOVERY_REQUIRED/)});
console.log("PASS",passed,"atomic lock mock checks");
