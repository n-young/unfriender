import type { Platform } from "@social-cleanup/shared";
import { FakeAdapter } from "./fake.js";
import type { PlatformAdapter } from "./types.js";
import { UnverifiedAdapter } from "./unverified.js";

export function createAdapters(fake: boolean): Map<Platform,PlatformAdapter> {
  const result = new Map<Platform,PlatformAdapter>();
  for (const platform of ["linkedin","facebook","instagram"] as const) {
    result.set(platform, fake ? new FakeAdapter(platform) : new UnverifiedAdapter(platform));
  }
  return result;
}
