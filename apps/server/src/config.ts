import path from "node:path";

function bool(name: string, fallback = false): boolean {
  const value = process.env[name];
  if (value === undefined) return fallback;
  return value === "true" || value === "1";
}

export const config = {
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? 3000),
  dataDir: path.resolve(process.env.DATA_DIR ?? ".data"),
  allowedLogin: process.env.ALLOWED_TAILSCALE_LOGIN ?? "",
  appOrigin: process.env.APP_ORIGIN ?? "",
  localDevBypass: bool("LOCAL_DEV_BYPASS"),
  fakeAdapters: bool("FAKE_ADAPTERS"),
  graceMs: Number(process.env.REMOVAL_GRACE_MS ?? 10_000),
  mutationIntervalMs: Number(process.env.MUTATION_INTERVAL_MS ?? 3_000)
};

if (config.host !== "127.0.0.1" && config.host !== "::1") {
  throw new Error("HOST must be localhost; expose the app only through Tailscale Serve");
}
if (!config.localDevBypass && (!config.allowedLogin || !config.appOrigin)) {
  throw new Error("ALLOWED_TAILSCALE_LOGIN and APP_ORIGIN are required outside local development");
}
