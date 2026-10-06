import type { Platform } from "@social-cleanup/shared";
import type { Store } from "./store.js";
import { AdapterUnavailableError, AmbiguousMutationError, SessionError, type PlatformAdapter } from "./adapters/types.js";

export class RemovalWorker {
  private timer?: NodeJS.Timeout;
  private working = false;
  private lastTick = Date.now();
  constructor(private store: Store, private adapters: Map<Platform,PlatformAdapter>, private intervalMs: number) {}

  start() {
    this.store.pauseStaleOnStartup();
    this.timer = setInterval(() => void this.tick(), Math.min(500, this.intervalMs));
    this.timer.unref();
  }
  stop() { if (this.timer) clearInterval(this.timer); }

  async tick(now = Date.now()) {
    if (this.working) return;
    if (now - this.lastTick > Math.max(30_000, this.intervalMs * 5)) {
      this.store.pauseStaleOnStartup();
    }
    this.lastTick = now;
    const job = this.store.claimNext(now);
    if (!job) return;
    this.working = true;
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
      await adapter.remove(job.targetKey);
      const after = await adapter.relationshipState(job.targetKey);
      if (after === "absent") this.store.completeRemoval(job.id,"removed","verified absent after mutation");
      else this.store.completeRemoval(job.id,"unknown",undefined,"mutation returned but relationship is still present or unreadable");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (error instanceof AmbiguousMutationError) this.store.completeRemoval(job.id,"unknown",undefined,message);
      else if (error instanceof SessionError || error instanceof AdapterUnavailableError) this.store.completeRemoval(job.id,"paused",undefined,message);
      else this.store.completeRemoval(job.id,"unknown",undefined,message);
    } finally {
      this.working = false;
    }
  }
}
