import type { Platform } from "@social-cleanup/shared";
import { FakeAdapter } from "./fake.js";
import type { PlatformAdapter } from "./types.js";
import { UnverifiedAdapter } from "./unverified.js";
import { SnapshotAdapter } from "./snapshot.js";
import { BrowserAdapter } from "./browser.js";
import path from "node:path";

export function createAdapters(fake: boolean, dataDir: string): Map<Platform,PlatformAdapter> {
  const result = new Map<Platform,PlatformAdapter>();
  const browserPlatforms=new Set((process.env.BROWSER_ADAPTERS??"").split(",").map(value=>value.trim()).filter(Boolean));
  for (const platform of ["linkedin","facebook","instagram"] as const) {
    result.set(platform, fake
      ? new FakeAdapter(platform)
      : browserPlatforms.has(platform)
        ? new BrowserAdapter(platform,dataDir)
        : platform === "linkedin" || platform === "facebook" || platform === "instagram"
          ? new SnapshotAdapter(platform,path.join(dataDir,"platform-cache",`${platform}.json`))
          : new UnverifiedAdapter(platform));
  }
  return result;
}
