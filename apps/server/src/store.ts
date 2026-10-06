import { DatabaseSync } from "node:sqlite";
import type { AdapterRelationship, DecisionInput, Platform } from "@social-cleanup/shared";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

export interface ClaimedRemoval {
  id: number;
  decisionId: number;
  accountId: number;
  platform: Platform;
  actingAccountKey: string;
  sessionGeneration: number;
  targetKey: string;
  profileUrl: string;
  attempt: number;
}

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    this.db = new DatabaseSync(filename);
    this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;");
    this.migrate();
  }

  close() { this.db.close(); }

  health() {
    return (this.db.prepare("SELECT 1 AS ok").get() as {ok:number}).ok === 1;
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id INTEGER PRIMARY KEY, platform TEXT NOT NULL UNIQUE,
        acting_account_key TEXT, session_generation INTEGER NOT NULL DEFAULT 0,
        connection_state TEXT NOT NULL DEFAULT 'disconnected', scan_cursor TEXT,
        scan_state TEXT NOT NULL DEFAULT 'idle', last_sync_at TEXT, error TEXT
      );
      CREATE TABLE IF NOT EXISTS connections (
        id INTEGER PRIMARY KEY, account_id INTEGER NOT NULL REFERENCES accounts(id),
        target_key TEXT NOT NULL, canonical_url TEXT NOT NULL, display_name TEXT NOT NULL,
        handle TEXT, photo_url TEXT, review_state TEXT NOT NULL DEFAULT 'pending',
        deck_order INTEGER NOT NULL, version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(account_id, target_key)
      );
      CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, sequence INTEGER NOT NULL UNIQUE,
        connection_id INTEGER NOT NULL REFERENCES connections(id), kind TEXT NOT NULL,
        previous_state TEXT NOT NULL, previous_order INTEGER NOT NULL,
        created_at TEXT NOT NULL, undone_at TEXT
      );
      CREATE TABLE IF NOT EXISTS batches (
        id INTEGER PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL,
        execute_after_ms INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'scheduled'
      );
      CREATE TABLE IF NOT EXISTS removals (
        id INTEGER PRIMARY KEY, decision_id INTEGER NOT NULL UNIQUE REFERENCES decisions(id),
        batch_id INTEGER REFERENCES batches(id), account_id INTEGER NOT NULL REFERENCES accounts(id),
        target_key TEXT NOT NULL, profile_url TEXT NOT NULL, acting_account_key TEXT NOT NULL,
        session_generation INTEGER NOT NULL, state TEXT NOT NULL DEFAULT 'draft',
        attempt INTEGER NOT NULL DEFAULT 0, started_at TEXT, completed_at TEXT,
        result TEXT, error TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_live_removal ON removals(account_id,target_key)
        WHERE state IN ('draft','scheduled','ready','executing','paused','unknown');
    `);
    const accountColumns=new Set((this.db.prepare("PRAGMA table_info(accounts)").all() as {name:string}[]).map(column=>column.name));
    if(!accountColumns.has("mutation_backoff_until_ms"))this.db.exec("ALTER TABLE accounts ADD COLUMN mutation_backoff_until_ms INTEGER");
    const removalColumns=new Set((this.db.prepare("PRAGMA table_info(removals)").all() as {name:string}[]).map(column=>column.name));
    if(!removalColumns.has("retry_after_ms"))this.db.exec("ALTER TABLE removals ADD COLUMN retry_after_ms INTEGER");
    for (const platform of ["linkedin", "facebook", "instagram"]) {
      this.db.prepare("INSERT OR IGNORE INTO accounts(platform) VALUES (?)").run(platform);
    }
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  listAccounts() {
    return this.db.prepare(`SELECT id,platform,acting_account_key AS actingAccountKey,
      session_generation AS sessionGeneration,connection_state AS connectionState,
      scan_state AS scanState,last_sync_at AS lastSyncAt,error FROM accounts ORDER BY id`).all();
  }

  accountScanCursor(platform: Platform) {
    const row=this.db.prepare("SELECT scan_cursor AS scanCursor FROM accounts WHERE platform=?").get(platform) as {scanCursor:string|null}|undefined;
    return row?.scanCursor??null;
  }

  connectAccount(platform: Platform, actingAccountKey: string) {
    this.db.prepare(`UPDATE accounts SET acting_account_key=?,session_generation=session_generation+1,
      connection_state='connected',scan_cursor=NULL,scan_state='idle',error=NULL WHERE platform=?`).run(actingAccountKey, platform);
  }

  disconnectAccount(platform: Platform) {
    return this.transaction(() => {
      const account = this.db.prepare("SELECT id FROM accounts WHERE platform=?").get(platform) as {id:number};
      this.db.prepare(`UPDATE removals SET state='cancelled',completed_at=datetime('now'),result='account disconnected'
        WHERE account_id=? AND state IN ('draft','scheduled','ready','paused')`).run(account.id);
      return this.db.prepare(`UPDATE accounts SET acting_account_key=NULL,session_generation=session_generation+1,
        connection_state='disconnected',scan_state='idle',error=NULL WHERE id=?`).run(account.id);
    });
  }

  sync(platform: Platform, rows: AdapterRelationship[], cursor: string | null, complete: boolean) {
    return this.transaction(() => {
      const account = this.db.prepare("SELECT id FROM accounts WHERE platform=? AND connection_state='connected'").get(platform) as {id:number}|undefined;
      if (!account) throw new ConflictError(`${platform} is not connected`);
      let nextOrder = Number((this.db.prepare("SELECT COALESCE(MAX(deck_order),0)+1 n FROM connections").get() as {n:number}).n);
      const upsert = this.db.prepare(`INSERT INTO connections(account_id,target_key,canonical_url,display_name,handle,photo_url,deck_order)
        VALUES (?,?,?,?,?,?,?) ON CONFLICT(account_id,target_key) DO UPDATE SET
        canonical_url=excluded.canonical_url,display_name=excluded.display_name,handle=excluded.handle,photo_url=excluded.photo_url`);
      for (const row of rows) {
        assertPlatformProfileUrl(platform,row.profileUrl);
        upsert.run(account.id,row.targetKey,row.profileUrl,row.displayName,row.handle ?? null,row.photoUrl ?? null,nextOrder++);
      }
      this.db.prepare(`UPDATE accounts SET scan_cursor=?,scan_state=?,last_sync_at=datetime('now'),error=NULL WHERE id=?`)
        .run(cursor, complete ? "complete" : "partial", account.id);
      this.rebuildPendingDeck();
      return rows.length;
    });
  }

  private rebuildPendingDeck() {
    const rows = this.db.prepare(`SELECT c.id,a.platform,c.target_key AS targetKey
      FROM connections c JOIN accounts a ON a.id=c.account_id WHERE c.review_state='pending'`).all() as any[];
    const hash = (value: string) => {
      let h = 2166136261;
      for (const char of value) { h ^= char.charCodeAt(0); h = Math.imul(h, 16777619); }
      return h >>> 0;
    };
    const queues = new Map<string, any[]>();
    for (const platform of ["linkedin","facebook","instagram"]) {
      queues.set(platform, rows.filter((r) => r.platform === platform).sort((a,b) => hash(`${a.platform}:${a.targetKey}`)-hash(`${b.platform}:${b.targetKey}`)));
    }
    let order = 1;
    while ([...queues.values()].some((q) => q.length)) {
      for (const platform of ["linkedin","facebook","instagram"]) {
        const row = queues.get(platform)?.shift();
        if (row) this.db.prepare("UPDATE connections SET deck_order=? WHERE id=?").run(order++,row.id);
      }
    }
  }

  deck(limit = 30, after = -1) {
    return this.db.prepare(`SELECT c.id,a.platform,c.target_key AS targetKey,c.display_name AS displayName,
      c.handle,c.canonical_url AS profileUrl,c.photo_url AS photoUrl,c.version,c.deck_order AS deckOrder
      FROM connections c JOIN accounts a ON a.id=c.account_id
      WHERE c.review_state='pending' AND c.deck_order>? ORDER BY c.deck_order LIMIT ?`).all(after, limit);
  }

  decide(input: DecisionInput) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id FROM decisions WHERE operation_id=?").get(input.operationId) as {id:number}|undefined;
      if (existing) return existing;
      const connection = this.db.prepare(`SELECT c.*,a.acting_account_key,a.session_generation
        FROM connections c JOIN accounts a ON a.id=c.account_id WHERE c.id=?`).get(input.connectionId) as any;
      if (!connection) throw new NotFoundError("connection not found");
      if (connection.version !== input.version || connection.review_state !== "pending") throw new ConflictError("stale card version or card already decided");
      const sequence = Number((this.db.prepare("SELECT COALESCE(MAX(sequence),0)+1 n FROM decisions").get() as {n:number}).n);
      const info = this.db.prepare(`INSERT INTO decisions(operation_id,sequence,connection_id,kind,previous_state,previous_order,created_at)
        VALUES (?,?,?,?,?,?,datetime('now'))`).run(input.operationId,sequence,input.connectionId,input.kind,connection.review_state,connection.deck_order);
      const decisionId = Number(info.lastInsertRowid);
      if (input.kind === "skip") {
        const order = Number((this.db.prepare("SELECT COALESCE(MAX(deck_order),0)+1 n FROM connections").get() as {n:number}).n);
        this.db.prepare("UPDATE connections SET deck_order=?,version=version+1 WHERE id=?").run(order,input.connectionId);
      } else {
        this.db.prepare("UPDATE connections SET review_state=?,version=version+1 WHERE id=?").run(input.kind === "keep" ? "kept" : "staged",input.connectionId);
      }
      if (input.kind === "remove") {
        if (!connection.acting_account_key) throw new ConflictError("account is not connected");
        this.db.prepare(`INSERT INTO removals(decision_id,account_id,target_key,profile_url,acting_account_key,session_generation)
          VALUES (?,?,?,?,?,?)`).run(decisionId,connection.account_id,connection.target_key,connection.canonical_url,connection.acting_account_key,connection.session_generation);
      }
      return { id: decisionId };
    });
  }

  undoDecision(decisionId: number) {
    return this.transaction(() => {
      const decision = this.db.prepare("SELECT * FROM decisions WHERE id=? AND undone_at IS NULL").get(decisionId) as any;
      if (!decision) throw new NotFoundError("active decision not found");
      const removal = this.db.prepare("SELECT id,state FROM removals WHERE decision_id=?").get(decisionId) as any;
      if (removal) {
        if (["executing","removed","already_absent","unknown"].includes(removal.state)) throw new ConflictError("removal already started");
        this.db.prepare(`UPDATE removals SET state='cancelled',completed_at=datetime('now'),result='undone' WHERE id=?`).run(removal.id);
      }
      this.db.prepare("UPDATE connections SET review_state=?,deck_order=?,version=version+1 WHERE id=?")
        .run(decision.previous_state,decision.previous_order,decision.connection_id);
      this.db.prepare("UPDATE decisions SET undone_at=datetime('now') WHERE id=?").run(decisionId);
      return { id: decisionId, undone: true };
    });
  }

  latestUndoableDecision() {
    return this.db.prepare(`SELECT d.id FROM decisions d LEFT JOIN removals r ON r.decision_id=d.id
      WHERE d.undone_at IS NULL AND (r.id IS NULL OR r.state IN ('draft','scheduled','ready','paused'))
      ORDER BY d.sequence DESC LIMIT 1`).get() as {id:number}|undefined;
  }

  createBatch(operationId: string, decisionIds: number[], nowMs: number, graceMs: number) {
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT id,execute_after_ms AS executeAfterMs FROM batches WHERE operation_id=?").get(operationId);
      if (existing) return existing;
      const unique = [...new Set(decisionIds)];
      if (unique.length !== decisionIds.length) throw new ConflictError("duplicate decision IDs");
      const placeholders = unique.map(() => "?").join(",");
      const eligible = this.db.prepare(`SELECT id FROM removals WHERE decision_id IN (${placeholders}) AND state='draft'`).all(...unique);
      if (eligible.length !== unique.length) throw new ConflictError("batch contains missing or non-draft removals");
      const deadline = nowMs + graceMs;
      const batch = this.db.prepare("INSERT INTO batches(operation_id,applied_at,execute_after_ms) VALUES (?,datetime('now'),?)").run(operationId,deadline);
      const batchId = Number(batch.lastInsertRowid);
      this.db.prepare(`UPDATE removals SET batch_id=?,state='scheduled' WHERE decision_id IN (${placeholders})`).run(batchId,...unique);
      return { id: batchId, executeAfterMs: deadline };
    });
  }

  cancelRemoval(id: number) {
    return this.transaction(() => {
      const row = this.db.prepare("SELECT decision_id,state FROM removals WHERE id=?").get(id) as any;
      if (!row) throw new NotFoundError("removal not found");
      if (!["draft","scheduled","ready","paused"].includes(row.state)) throw new ConflictError("removal already started");
      this.db.prepare("UPDATE removals SET state='cancelled',completed_at=datetime('now'),result='cancelled' WHERE id=?").run(id);
      return this.undoDecisionInside(row.decision_id);
    });
  }

  private undoDecisionInside(decisionId: number) {
    const d = this.db.prepare("SELECT * FROM decisions WHERE id=? AND undone_at IS NULL").get(decisionId) as any;
    if (!d) return { id: decisionId, undone: true };
    this.db.prepare("UPDATE connections SET review_state=?,deck_order=?,version=version+1 WHERE id=?").run(d.previous_state,d.previous_order,d.connection_id);
    this.db.prepare("UPDATE decisions SET undone_at=datetime('now') WHERE id=?").run(decisionId);
    return { id: decisionId, undone: true };
  }

  cancelBatch(id: number) {
    return this.transaction(() => {
      const rows = this.db.prepare(`SELECT id,decision_id FROM removals WHERE batch_id=? AND state IN ('scheduled','ready','paused')`).all(id) as any[];
      for (const row of rows) {
        this.db.prepare("UPDATE removals SET state='cancelled',completed_at=datetime('now'),result='batch cancelled' WHERE id=?").run(row.id);
        this.undoDecisionInside(row.decision_id);
      }
      this.db.prepare("UPDATE batches SET state='cancelled' WHERE id=?").run(id);
      return { cancelled: rows.length };
    });
  }

  claimNext(nowMs: number): ClaimedRemoval | undefined {
    return this.transaction(() => {
      this.db.prepare("UPDATE removals SET state='ready' WHERE state='scheduled' AND batch_id IN (SELECT id FROM batches WHERE execute_after_ms<=? AND state='scheduled')").run(nowMs);
      const row = this.db.prepare(`SELECT r.id,r.decision_id AS decisionId,r.account_id AS accountId,a.platform,
        r.acting_account_key AS actingAccountKey,r.session_generation AS sessionGeneration,
        r.target_key AS targetKey,r.profile_url AS profileUrl,r.attempt
      FROM removals r JOIN accounts a ON a.id=r.account_id WHERE r.state='ready'
        AND COALESCE(r.retry_after_ms,0)<=? AND COALESCE(a.mutation_backoff_until_ms,0)<=?
        ORDER BY r.id LIMIT 1`).get(nowMs,nowMs) as ClaimedRemoval|undefined;
      if (!row) return undefined;
      const changed = this.db.prepare(`UPDATE removals SET state='executing',attempt=attempt+1,started_at=datetime('now') WHERE id=? AND state='ready'`).run(row.id);
      if (changed.changes !== 1) return undefined;
      row.attempt += 1;
      return row;
    });
  }

  completeRemoval(id: number, state: "removed"|"already_absent"|"paused"|"unknown", result?: string, error?: string) {
    this.db.prepare(`UPDATE removals SET state=?,completed_at=datetime('now'),result=?,error=?,retry_after_ms=NULL WHERE id=? AND state='executing'`)
      .run(state,result ?? null,error ?? null,id);
  }

  deferRemoval(id:number,retryAfterMs:number,error:string){
    return this.transaction(()=>{
      const row=this.db.prepare("SELECT account_id AS accountId FROM removals WHERE id=? AND state='executing'").get(id) as {accountId:number}|undefined;
      if(!row)throw new ConflictError("removal is not executing");
      this.db.prepare("UPDATE removals SET state='ready',started_at=NULL,retry_after_ms=?,error=? WHERE id=?").run(retryAfterMs,error,id);
      this.db.prepare(`UPDATE accounts SET mutation_backoff_until_ms=CASE
        WHEN COALESCE(mutation_backoff_until_ms,0)>? THEN mutation_backoff_until_ms ELSE ? END WHERE id=?`)
        .run(retryAfterMs,retryAfterMs,row.accountId);
      return {id,retryAfterMs};
    });
  }

  accountMatches(id: number, actingAccountKey: string, generation: number) {
    return Boolean(this.db.prepare(`SELECT 1 FROM accounts WHERE id=? AND acting_account_key=?
      AND session_generation=? AND connection_state='connected'`).get(id,actingAccountKey,generation));
  }

  pauseStaleOnStartup() {
    return this.transaction(() => {
      this.db.prepare("UPDATE removals SET state='unknown',error='process stopped after dispatch; reconcile before retry' WHERE state='executing'").run();
      const result = this.db.prepare("UPDATE removals SET state='paused',error='application restarted; resume explicitly' WHERE state IN ('scheduled','ready')").run();
      this.db.prepare("UPDATE batches SET state='paused' WHERE state='scheduled' AND id IN (SELECT batch_id FROM removals WHERE state='paused')").run();
      return result.changes;
    });
  }

  resumeBatch(id: number, nowMs: number, graceMs: number) {
    return this.transaction(() => {
      const batch = this.db.prepare("SELECT id FROM batches WHERE id=? AND state='paused'").get(id);
      if (!batch) throw new ConflictError("batch is not paused");
      const deadline = nowMs + graceMs;
      this.db.prepare("UPDATE batches SET state='scheduled',execute_after_ms=? WHERE id=?").run(deadline,id);
      this.db.prepare("UPDATE removals SET state='scheduled',error=NULL WHERE batch_id=? AND state='paused'").run(id);
      return { id, executeAfterMs: deadline };
    });
  }

  removals() {
    return this.db.prepare(`SELECT r.id,r.decision_id AS decisionId,r.batch_id AS batchId,a.platform,
      r.target_key AS targetKey,r.profile_url AS profileUrl,r.state,r.attempt,r.started_at AS startedAt,
      r.completed_at AS completedAt,r.result,r.error,r.retry_after_ms AS retryAfterMs,b.execute_after_ms AS executeAfterMs
      FROM removals r JOIN accounts a ON a.id=r.account_id LEFT JOIN batches b ON b.id=r.batch_id ORDER BY r.id DESC`).all();
  }
}

function assertPlatformProfileUrl(platform: Platform, value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new ConflictError(`invalid ${platform} profile URL`); }
  const hosts:Record<Platform,Set<string>>={
    linkedin:new Set(["linkedin.com","www.linkedin.com"]),
    facebook:new Set(["facebook.com","www.facebook.com","m.facebook.com"]),
    instagram:new Set(["instagram.com","www.instagram.com"])
  };
  const pathOkay = platform !== "linkedin" || url.pathname.startsWith("/in/");
  if (url.protocol !== "https:" || !hosts[platform].has(url.hostname.toLowerCase()) || !pathOkay || url.username || url.password) {
    throw new ConflictError(`profile URL is outside the ${platform} allowlist`);
  }
}
