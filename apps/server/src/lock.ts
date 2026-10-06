import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

export function acquireInstanceLock(dataDir: string): () => void {
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const filename = path.join(dataDir,"app.lock");
  try {
    const fd = openSync(filename,"wx",0o600);
    writeFileSync(fd,String(process.pid));
    closeSync(fd);
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const oldPid = Number(readFileSync(filename,"utf8"));
    try { process.kill(oldPid,0); throw new Error(`another social-cleanup process is running (PID ${oldPid})`); }
    catch (probe: any) {
      if (probe.code !== "ESRCH") throw probe;
      rmSync(filename);
      return acquireInstanceLock(dataDir);
    }
  }
  return () => { try { rmSync(filename); } catch {} };
}
