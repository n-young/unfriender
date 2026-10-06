import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);

function bool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  dataDir: path.resolve(repoRoot, process.env.DATA_DIR ?? ".data"),
  allowedLogin: process.env.ALLOWED_TAILSCALE_LOGIN ?? "",
  appOrigin: process.env.APP_ORIGIN ?? "",
  localDevBypass: bool("LOCAL_DEV_BYPASS"),
  fakeAdapters: bool("FAKE_ADAPTERS"),
  graceMs: Number(process.env.REMOVAL_GRACE_MS ?? 10_000),
  mutationIntervalMs: Math.max(15_000,Number(process.env.MUTATION_INTERVAL_MS ?? 15_000)),
  mutationRetryBaseMs: Math.max(5_000,Number(process.env.MUTATION_RETRY_BASE_MS ?? 30_000))
};

const containerized = bool("CONTAINERIZED");
const validHost = config.host === "127.0.0.1" || config.host === "::1" || (containerized && config.host === "0.0.0.0");
if (!validHost) {
  throw new Error("HOST must be localhost, except 0.0.0.0 inside the loopback-published container");
}
if (!config.localDevBypass && (!config.allowedLogin || !config.appOrigin)) {
  throw new Error("ALLOWED_TAILSCALE_LOGIN and APP_ORIGIN are required outside local development");
}
