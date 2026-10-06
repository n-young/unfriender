import type { AdapterRelationship, Platform } from "@social-cleanup/shared";

export interface SessionIdentity {
  actingAccountKey: string;
  displayName: string;
}

export interface DiscoveryPage {
  relationships: AdapterRelationship[];
  nextCursor: string | null;
  complete: boolean;
}

export type RelationshipState = "present" | "absent" | "unknown";

export interface PlatformAdapter {
  readonly platform: Platform;
  readonly verified: boolean;
  checkSession(): Promise<SessionIdentity>;
  discover(cursor: string | null, limit: number): Promise<DiscoveryPage>;
  relationshipState(targetKey: string): Promise<RelationshipState>;
  remove(targetKey: string): Promise<void>;
  disconnect(): Promise<void>;
}

export class AdapterUnavailableError extends Error {}
export class SessionError extends Error {}
export class AmbiguousMutationError extends Error {}
