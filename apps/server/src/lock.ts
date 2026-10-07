import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

type LockRecord={pid:number;processStart:string|null};

function linuxProcessStart(pid:number){
  if(process.platform!=="linux")return undefined;
  try{
    const stat=readFileSync(`/proc/${pid}/stat`,"utf8");
    const fields=stat.slice(stat.lastIndexOf(")")+2).trim().split(/\s+/);
    if(fields[0]==="Z")return undefined;
    return fields[19];
  }catch{return undefined;}
}

function liveLock(raw:string){
  let record:LockRecord|undefined;
  try{const parsed=JSON.parse(raw);if(Number.isSafeInteger(parsed?.pid)&&parsed.pid>0)record=parsed;}catch{}
  if(record?.processStart&&process.platform==="linux")return linuxProcessStart(record.pid)===record.processStart;
  const legacyPid=record?.pid??Number(raw);
  if(!Number.isSafeInteger(legacyPid)||legacyPid<1)return false;
  if(process.env.CONTAINERIZED==="true"&&!record)return false;
  try{process.kill(legacyPid,0);return true;}catch(error:any){if(error.code==="ESRCH")return false;throw error;}
}

export function acquireInstanceLock(dataDir: string): () => void {
  mkdirSync(dataDir,{recursive:true,mode:0o700});
  const filename = path.join(dataDir,"app.lock");
  try {
    const fd = openSync(filename,"wx",0o600);
    const record:LockRecord={pid:process.pid,processStart:linuxProcessStart(process.pid)??null};
    writeFileSync(fd,JSON.stringify(record));
    closeSync(fd);
  } catch (error: any) {
    if (error.code !== "EEXIST") throw error;
    const raw=readFileSync(filename,"utf8");
    if(liveLock(raw)){let pid="unknown";try{pid=String(JSON.parse(raw).pid)}catch{pid=raw.trim()}throw new Error(`another social-cleanup process is running (PID ${pid})`);}
    rmSync(filename);
    return acquireInstanceLock(dataDir);
  }
  return () => { try { rmSync(filename); } catch {} };
}
