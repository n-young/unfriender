import type { Platform } from "@social-cleanup/shared";
import { FakeAdapter } from "./fake.js";
import type { PlatformAdapter } from "./types.js";
import { UnverifiedAdapter } from "./unverified.js";
import { SnapshotAdapter } from "./snapshot.js";
import path from "node:path";

export function createAdapters(fake: boolean, dataDir: string): Map<Platform,PlatformAdapter> {
  const result = new Map<Platform,PlatformAdapter>();
  for (const platform of ["linkedin","facebook","instagram"] as const) {
    result.set(platform, fake ? new FakeAdapter(platform) : platform === "linkedin"
      ? new SnapshotAdapter(platform,path.join(dataDir,"platform-cache","linkedin.json"))
      : new UnverifiedAdapter(platform));
  }
  return result;
}
