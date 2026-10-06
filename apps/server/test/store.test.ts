import test from "node:test";
import assert from "node:assert/strict";
import { Store, ConflictError } from "../src/store.js";
import { FakeAdapter } from "../src/adapters/fake.js";
import { RemovalWorker } from "../src/worker.js";
import type { Platform } from "@social-cleanup/shared";

function setup(){
  const store=new Store(":memory:");
  for(const platform of ["linkedin","facebook","instagram"] as const){
    store.connectAccount(platform,`owner-${platform}`);
    const base=platform==="linkedin"?"https://www.linkedin.com/in/":`https://www.${platform}.com/`;
    store.sync(platform,[1,2].map(i=>({targetKey:`${platform}-${i}`,displayName:`${platform} ${i}`,profileUrl:`${base}person${i}`})),null,true);
  }
  return store;
}

test("mixed deck round-robins platforms and survives reads",()=>{
  const store=setup();
  const first=store.deck(20) as any[],second=store.deck(20) as any[];
  assert.deepEqual(first.map(x=>x.platform),["linkedin","facebook","instagram","linkedin","facebook","instagram"]);
  assert.deepEqual(second,first);store.close();
});

test("decision operation IDs are idempotent and undo persists",()=>{
  const store=setup();const card=(store.deck(1) as any[])[0];
  const input={operationId:"11111111-1111-4111-8111-111111111111",connectionId:card.id,version:card.version,kind:"remove" as const};
  const one=store.decide(input),two=store.decide(input);assert.equal(two.id,one.id);assert.equal(store.removals().length,1);
  store.undoDecision(one.id);assert.equal((store.deck(1) as any[])[0].id,card.id);store.close();
});

test("cancellation wins before atomic claim and late cancellation loses",()=>{
  const store=setup();const [a,b]=store.deck(2) as any[];
  const da=store.decide({operationId:"21111111-1111-4111-8111-111111111111",connectionId:a.id,version:a.version,kind:"remove"});
  const db=store.decide({operationId:"31111111-1111-4111-8111-111111111111",connectionId:b.id,version:b.version,kind:"remove"});
  store.createBatch("41111111-1111-4111-8111-111111111111",[da.id,db.id],1000,10);
  const removal=(store.removals() as any[]).find(r=>r.decisionId===da.id);store.cancelRemoval(removal.id);
  const claimed=store.claimNext(1010)!;assert.equal(claimed.decisionId,db.id);
  assert.throws(()=>store.undoDecision(db.id),ConflictError);store.close();
});

test("startup marks dispatched work unknown and pauses unstarted work",()=>{
  const store=setup();const [a,b]=store.deck(2) as any[];
  const decisions=[a,b].map((c,i)=>store.decide({operationId:`${i+5}1111111-1111-4111-8111-111111111111`,connectionId:c.id,version:c.version,kind:"remove"}));
  store.createBatch("71111111-1111-4111-8111-111111111111",decisions.map(d=>d.id),0,0);store.claimNext(1);store.pauseStaleOnStartup();
  assert.deepEqual((store.removals() as any[]).map(r=>r.state).sort(),["paused","unknown"]);store.close();
});

test("worker verifies account binding and exact postcondition",async()=>{
  const store=setup();const card=(store.deck(1) as any[])[0];
  const d=store.decide({operationId:"81111111-1111-4111-8111-111111111111",connectionId:card.id,version:card.version,kind:"remove"});
  store.createBatch("91111111-1111-4111-8111-111111111111",[d.id],0,0);
  const adapters=new Map<Platform,FakeAdapter>();for(const p of ["linkedin","facebook","instagram"] as const)adapters.set(p,new FakeAdapter(p,2));
  const worker=new RemovalWorker(store,adapters,0);await worker.tick(1);
  assert.equal((store.removals() as any[])[0].state,"removed");store.close();
});

test("wrong acting account pauses without mutation",async()=>{
  const store=setup();const card=(store.deck(1) as any[])[0];
  const d=store.decide({operationId:"a1111111-1111-4111-8111-111111111111",connectionId:card.id,version:card.version,kind:"remove"});
  store.createBatch("b1111111-1111-4111-8111-111111111111",[d.id],0,0);store.connectAccount("linkedin","different-owner");
  const adapters=new Map<Platform,FakeAdapter>();for(const p of ["linkedin","facebook","instagram"] as const)adapters.set(p,new FakeAdapter(p,2));
  await new RemovalWorker(store,adapters,0).tick(1);
  assert.equal((store.removals() as any[])[0].state,"paused");store.close();
});

test("sync rejects profile URLs outside the platform allowlist",()=>{
  const store=new Store(":memory:");store.connectAccount("linkedin","owner-linkedin");
  assert.throws(()=>store.sync("linkedin",[{targetKey:"victim",displayName:"Wrong host",profileUrl:"https://example.com/in/victim"}],null,true),ConflictError);
  store.close();
});
