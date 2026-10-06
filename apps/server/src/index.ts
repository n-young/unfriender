import { mkdirSync } from "node:fs";
import path from "node:path";
import { buildApp } from "./app.js";
import { config } from "./config.js";
import { createAdapters } from "./adapters/index.js";
import { acquireInstanceLock } from "./lock.js";
import { Store } from "./store.js";
import { RemovalWorker } from "./worker.js";

mkdirSync(config.dataDir,{recursive:true,mode:0o700});
const releaseLock = acquireInstanceLock(config.dataDir);
const store = new Store(path.join(config.dataDir,"social-cleanup.sqlite"));
const adapters = createAdapters(config.fakeAdapters);
const worker = new RemovalWorker(store,adapters,config.mutationIntervalMs);
const app = buildApp({...config,store,adapters});
worker.start();

const close = async () => { worker.stop(); await app.close(); store.close(); releaseLock(); };
process.once("SIGINT",() => void close().then(() => process.exit(0)));
process.once("SIGTERM",() => void close().then(() => process.exit(0)));

await app.listen({host:config.host,port:config.port});
