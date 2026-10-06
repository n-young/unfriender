import type { Platform } from "@social-cleanup/shared";
import { AdapterUnavailableError, type PlatformAdapter } from "./types.js";

export class UnverifiedAdapter implements PlatformAdapter {
  readonly verified = false;
  constructor(readonly platform: Platform) {}
  private unavailable(): never {
    throw new AdapterUnavailableError(`${this.platform} private API is not verified for this account; run the documented API spike first`);
  }
  async checkSession() { return this.unavailable(); }
  async discover(_cursor: string | null, _limit: number) { return this.unavailable(); }
  async relationshipState(_targetKey: string) { return this.unavailable(); }
  async remove(_targetKey: string) { return this.unavailable(); }
  async disconnect() {}
}
