import type { Platform } from "@social-cleanup/shared";
import type { Store } from "./store.js";
import { AdapterUnavailableError, AmbiguousMutationError, PreMutationError, RateLimitError, SessionError, type PlatformAdapter } from "./adapters/types.js";

export class RemovalWorker {
  private timer?: NodeJS.Timeout;
  private working = false;
  private lastTick = Date.now();
  private nextMutationAt = 0;
  constructor(private store: Store, private adapters: Map<Platform,PlatformAdapter>, private intervalMs: number,private retryBaseMs=5_000) {}

  start() {
    this.store.pauseStaleOnStartup();
    this.timer = setInterval(() => void this.tick(), Math.min(500,Math.max(100,this.intervalMs)));
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async tick(now = Date.now()) {
    if (this.working) return;
    if (now - this.lastTick > Math.max(30_000, this.intervalMs * 5)) {
      this.store.pauseStaleOnStartup();
    }
    this.lastTick = now;
    const uncertain=this.store.nextUnknown(now);
    if(uncertain){
      this.working=true;
      try{
        if(!this.store.accountMatches(uncertain.accountId,uncertain.actingAccountKey,uncertain.sessionGeneration)){
          this.store.resolveUnknown(uncertain.id,"paused",undefined,"bound account or session generation changed during reconciliation");
          return;
        }
        const adapter=this.adapters.get(uncertain.platform)!;
        const identity=await adapter.checkSession();
        if(identity.actingAccountKey!==uncertain.actingAccountKey){
          this.store.resolveUnknown(uncertain.id,"paused",undefined,"acting account changed during reconciliation");
          return;
        }
        const state=await adapter.relationshipState(uncertain.targetKey);
        if(state==="absent")this.store.resolveUnknown(uncertain.id,"already_absent","verified absent during read-only reconciliation; cause uncertain");
        else if(state==="present")this.store.resolveUnknown(uncertain.id,"paused",undefined,"relationship is still present after read-only reconciliation");
        else this.store.resolveUnknown(uncertain.id,"paused",undefined,"relationship state remained unreadable during reconciliation");
      }catch(error){
        const message=error instanceof Error?error.message:String(error);
        if(error instanceof RateLimitError){
          const retryAt=now+Math.max(this.retryBaseMs,error.retryAfterMs??0);
          this.store.deferUnknown(uncertain.id,retryAt,message);
        }else this.store.resolveUnknown(uncertain.id,"paused",undefined,`read-only reconciliation failed: ${message}`);
      }finally{this.working=false;}
      return;
    }
    if(now<this.nextMutationAt)return;
    const job = this.store.claimNext(now);
    if (!job) return;
    this.working = true;
    let mutationDispatched=false;
    try {
      if (!this.store.accountMatches(job.accountId,job.actingAccountKey,job.sessionGeneration)) {
        throw new SessionError("bound account or session generation changed");
      }
      const adapter = this.adapters.get(job.platform)!;
      const identity = await adapter.checkSession();
      if (identity.actingAccountKey !== job.actingAccountKey) throw new SessionError("acting account changed");
      const before = await adapter.relationshipState(job.targetKey);
      if (before === "absent") {
        this.store.completeRemoval(job.id,"already_absent","target absent before mutation");
        return;
      }
      if (before !== "present") throw new SessionError("could not verify exact relationship before mutation");
      mutationDispatched=true;
      await adapter.remove(job.targetKey);
      const after = await adapter.relationshipState(job.targetKey);
      if (after === "absent") this.store.completeRemoval(job.id,"removed","verified absent after mutation");
      else this.store.completeRemoval(job.id,"unknown",undefined,"mutation returned but relationship is still present or unreadable");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if(error instanceof PreMutationError){
        this.store.completeRemoval(job.id,"paused",undefined,message);
      }
      else if(error instanceof RateLimitError&&!mutationDispatched){
        const exponential=Math.min(5*60_000,this.retryBaseMs*2**Math.max(0,job.attempt-1));
        const retryAt=now+Math.max(exponential,error.retryAfterMs??0);
        this.store.deferRemoval(job.id,retryAt,message);
      }
      else if (error instanceof AmbiguousMutationError || mutationDispatched) this.store.completeRemoval(job.id,"unknown",undefined,message);
      else if (error instanceof SessionError || error instanceof AdapterUnavailableError) this.store.completeRemoval(job.id,"paused",undefined,message);
      else this.store.completeRemoval(job.id,"paused",undefined,message);
    } finally {
      this.working = false;
      this.nextMutationAt=Math.max(this.nextMutationAt,now+this.intervalMs);
    }
  }
}
