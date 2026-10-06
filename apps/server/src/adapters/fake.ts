import type { AdapterRelationship, Platform } from "@social-cleanup/shared";
import type { DiscoveryPage, PlatformAdapter, RelationshipState, SessionIdentity } from "./types.js";

const hosts: Record<Platform,string> = {
  linkedin: "www.linkedin.com/in/",
  facebook: "www.facebook.com/",
  instagram: "www.instagram.com/"
};

export class FakeAdapter implements PlatformAdapter {
  readonly verified = true;
  private present = new Set<string>();
  private rows: AdapterRelationship[];
  constructor(readonly platform: Platform, count = 8) {
    this.rows = Array.from({length: count}, (_, index) => {
      const targetKey = `${platform}-${index + 1}`;
      this.present.add(targetKey);
      return { targetKey, displayName: `${platform[0]!.toUpperCase()}${platform.slice(1)} Person ${index + 1}`,
        handle: `person${index + 1}`, profileUrl: `https://${hosts[platform]}person${index + 1}` };
    });
  }
  async checkSession(): Promise<SessionIdentity> { return { actingAccountKey: `owner-${this.platform}`, displayName: "Local test owner" }; }
  async discover(cursor: string | null, limit: number): Promise<DiscoveryPage> {
    const offset = cursor ? Number(cursor) : 0;
    const relationships = this.rows.slice(offset, offset + limit).filter((row) => this.present.has(row.targetKey));
    const next = offset + limit;
    return { relationships, nextCursor: next < this.rows.length ? String(next) : null, complete: next >= this.rows.length };
  }
  async relationshipState(targetKey: string): Promise<RelationshipState> { return this.present.has(targetKey) ? "present" : "absent"; }
  async remove(targetKey: string) { this.present.delete(targetKey); }
  async disconnect() {}
}
