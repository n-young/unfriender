import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { acquireInstanceLock } from "../src/lock.js";

test("instance lock rejects a live owner and replaces a stale process identity",()=>{
  const directory=mkdtempSync(path.join(os.tmpdir(),"unfriendr-lock-"));
  try{
    const release=acquireInstanceLock(directory);
    assert.throws(()=>acquireInstanceLock(directory),/another social-cleanup process is running/);
    release();
    writeFileSync(path.join(directory,"app.lock"),JSON.stringify({pid:999_999_999,processStart:"stale-start"}));
    const releaseReplacement=acquireInstanceLock(directory);
    assert.equal(JSON.parse(readFileSync(path.join(directory,"app.lock"),"utf8")).pid,process.pid);
    releaseReplacement();
  }finally{rmSync(directory,{recursive:true,force:true});}
});
