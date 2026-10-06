import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SnapshotAdapter } from "../src/adapters/snapshot.js";
import { AdapterUnavailableError } from "../src/adapters/types.js";

test("snapshot adapter provides bounded read-only discovery and blocks removal",async()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),"social-cleanup-snapshot-"));
  const filename=path.join(directory,"linkedin.json");
  writeFileSync(filename,JSON.stringify({version:1,capturedAt:new Date().toISOString(),complete:false,
    account:{actingAccountKey:"linkedin:owner",displayName:"Owner"},relationships:[
      {targetKey:"vanity:one",displayName:"Person One",handle:"one",profileUrl:"https://www.linkedin.com/in/one/"},
      {targetKey:"vanity:two",displayName:"Person Two",handle:"two",profileUrl:"https://www.linkedin.com/in/two/"}
    ]}));
  const adapter=new SnapshotAdapter("linkedin",filename);
  assert.deepEqual(await adapter.checkSession(),{actingAccountKey:"linkedin:owner",displayName:"Owner"});
  const first=await adapter.discover(null,1);assert.equal(first.relationships.length,1);assert.equal(first.nextCursor,"1");assert.equal(first.complete,false);
  assert.equal(await adapter.relationshipState("vanity:one"),"present");
  assert.equal(await adapter.relationshipState("vanity:missing"),"unknown");
  await assert.rejects(()=>adapter.remove("vanity:one"),AdapterUnavailableError);
});
