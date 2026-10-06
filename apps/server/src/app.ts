import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import { BatchInputSchema, DecisionInputSchema, PlatformSchema } from "@social-cleanup/shared";
import type { Platform } from "@social-cleanup/shared";
import type { Store } from "./store.js";
import { ConflictError, NotFoundError } from "./store.js";
import type { PlatformAdapter } from "./adapters/types.js";
import { AdapterUnavailableError } from "./adapters/types.js";

export interface AppOptions {
  store: Store;
  adapters: Map<Platform,PlatformAdapter>;
  allowedLogin: string;
  appOrigin: string;
  localDevBypass: boolean;
  fakeAdapters: boolean;
  graceMs: number;
}

export function buildApp(options: AppOptions) {
  const app = Fastify({ logger: true, trustProxy: false });
  app.addHook("onRequest", async (request, reply) => {
    const isLoopback = request.ip === "127.0.0.1" || request.ip === "::1";
    if (request.method === "GET" && request.url === "/api/health" && isLoopback) return;
    if (!(options.localDevBypass && isLoopback)) {
      if (request.headers["tailscale-user-login"] !== options.allowedLogin) return reply.code(401).send({error:"unexpected Tailscale identity"});
    }
    if (!["GET","HEAD","OPTIONS"].includes(request.method)) {
      if (request.headers.origin !== options.appOrigin && !(options.localDevBypass && isLoopback)) return reply.code(403).send({error:"unexpected origin"});
      if (request.headers["x-social-cleanup"] !== "1") return reply.code(403).send({error:"missing application request header"});
      const contentType = request.headers["content-type"] ?? "";
      if (!contentType.startsWith("application/json")) return reply.code(415).send({error:"JSON required"});
    }
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ConflictError) return reply.code(409).send({error:error.message});
    if (error instanceof NotFoundError) return reply.code(404).send({error:error.message});
    if (error instanceof AdapterUnavailableError) return reply.code(503).send({error:error.message});
    if ((error as any).issues) return reply.code(400).send({error:"invalid request",issues:(error as any).issues});
    app.log.error(error);
    return reply.code(500).send({error:"internal error"});
  });

  app.get("/api/health", async () => ({ ok: options.store.health() }));
  app.get("/api/status", async () => ({ accounts: options.store.listAccounts(), fakeMode: options.fakeAdapters }));
  app.get("/api/deck", async (request) => {
    const query = request.query as any;
    const limit = Math.max(1,Math.min(50,Number(query.limit ?? 30)));
    const cursor = Number(query.cursor ?? -1);
    const cards = options.store.deck(limit,cursor);
    return { cards, nextCursor: cards.length ? (cards.at(-1) as any).deckOrder : null };
  });
  app.get("/api/removals", async () => ({ removals: options.store.removals(), serverTime: Date.now() }));

  app.post("/api/accounts/:platform/connect", async (request, reply) => {
    const platform = PlatformSchema.parse((request.params as any).platform);
    const adapter = options.adapters.get(platform)!;
    const identity = await adapter.checkSession();
    options.store.connectAccount(platform,identity.actingAccountKey);
    return {connected:true,identity};
  });
  app.post("/api/accounts/:platform/disconnect", async (request) => {
    const platform = PlatformSchema.parse((request.params as any).platform);
    await options.adapters.get(platform)!.disconnect();
    options.store.disconnectAccount(platform);
    return {disconnected:true};
  });
  app.post("/api/accounts/:platform/sync", async (request) => {
    const platform = PlatformSchema.parse((request.params as any).platform);
    const page = await options.adapters.get(platform)!.discover(options.store.accountScanCursor(platform),25);
    const count = options.store.sync(platform,page.relationships,page.nextCursor,page.complete);
    return {count,...page};
  });
  app.post("/api/decisions", async (request) => options.store.decide(DecisionInputSchema.parse(request.body)));
  app.post("/api/decisions/:id/undo", async (request) => options.store.undoDecision(Number((request.params as any).id)));
  app.post("/api/undo", async (_request, reply) => {
    const latest = options.store.latestUndoableDecision();
    if (!latest) return reply.code(404).send({error:"nothing to undo"});
    return options.store.undoDecision(latest.id);
  });
  app.post("/api/batches", async (request) => {
    const body = BatchInputSchema.parse(request.body);
    return options.store.createBatch(body.operationId,body.decisionIds,Date.now(),options.graceMs);
  });
  app.post("/api/removals/:id/cancel", async (request) => options.store.cancelRemoval(Number((request.params as any).id)));
  app.post("/api/batches/:id/cancel", async (request) => options.store.cancelBatch(Number((request.params as any).id)));
  app.post("/api/batches/:id/resume", async (request) => options.store.resumeBatch(Number((request.params as any).id),Date.now(),options.graceMs));

  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here,"../../web/dist");
  if (existsSync(webDist)) {
    const types:Record<string,string>={".html":"text/html; charset=utf-8",".js":"text/javascript; charset=utf-8",".css":"text/css; charset=utf-8",".svg":"image/svg+xml",".json":"application/json",".webmanifest":"application/manifest+json"};
    app.setNotFoundHandler((request,reply) => {
      if (request.url.startsWith("/api/")) return reply.code(404).send({error:"not found"});
      const pathname = decodeURIComponent(new URL(request.url,"http://localhost").pathname);
      const relative = pathname.replace(/^\/+/,"");
      const candidate = path.resolve(webDist,relative);
      const safe = candidate === webDist || candidate.startsWith(webDist + path.sep);
      const filename = safe && existsSync(candidate) && statSync(candidate).isFile() ? candidate : path.join(webDist,"index.html");
      reply.type(types[path.extname(filename)]??"application/octet-stream").send(readFileSync(filename));
    });
  }
  return app;
}
