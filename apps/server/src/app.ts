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
import { fetchPlatformPhoto } from "./photo.js";

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
  app.get("/api/status", async () => ({
    accounts: options.store.listAccounts(),fakeMode:options.fakeAdapters,
    adapters:Object.fromEntries([...options.adapters].map(([platform,adapter])=>[platform,{verified:adapter.verified}]))
  }));
  app.get("/api/deck", async (request) => {
    const query = request.query as any;
    const limit = Math.max(1,Math.min(50,Number(query.limit ?? 30)));
    const cursor = Number(query.cursor ?? -1);
    const cards = options.store.deck(limit,cursor);
    return { cards, nextCursor: cards.length ? (cards.at(-1) as any).deckOrder : null };
  });
  app.get("/api/removals", async () => ({ removals: options.store.removals(), serverTime: Date.now() }));
  app.get("/api/connections/:id/photo", async (request,reply) => {
    const id=Number((request.params as {id:string}).id);
    if(!Number.isSafeInteger(id)||id<1)return reply.code(404).send();
    const photo=options.store.connectionPhoto(id);
    if(!photo)return reply.code(404).send();
    let response:Response;
    try{response=await fetchPlatformPhoto(photo.platform,photo.photoUrl);}
    catch(error){request.log.warn({connectionId:id,error:error instanceof Error?error.message:String(error)},"profile photo proxy failed");return reply.code(502).send();}
    if(!response.ok)return reply.code(response.status===404?404:502).send();
    const contentType=(response.headers.get("content-type")??"").split(";")[0]??"";
    if(!["image/avif","image/gif","image/jpeg","image/png","image/webp"].includes(contentType))return reply.code(502).send();
    const length=Number(response.headers.get("content-length")??0);
    if(length>5_000_000)return reply.code(413).send();
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>5_000_000)return reply.code(413).send();
    return reply.header("cache-control","private, max-age=86400, stale-while-revalidate=604800").type(contentType).send(bytes);
  });

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
  app.post("/api/removals/retry-all", async () => options.store.retryAllPaused(Date.now(),options.graceMs));
  app.post("/api/removals/:id/cancel", async (request) => options.store.cancelRemoval(Number((request.params as any).id)));
  app.post("/api/removals/:id/resume", async (request) => options.store.resumeRemoval(Number((request.params as any).id),Date.now(),options.graceMs));
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
