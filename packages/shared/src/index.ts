import { z } from "zod";

export const platforms = ["linkedin", "facebook", "instagram"] as const;
export type Platform = (typeof platforms)[number];
export const PlatformSchema = z.enum(platforms);

export const DecisionInputSchema = z.object({
  operationId: z.string().uuid(),
  connectionId: z.number().int().positive(),
  version: z.number().int().nonnegative(),
  kind: z.enum(["keep", "remove", "skip"])
});
export type DecisionInput = z.infer<typeof DecisionInputSchema>;

export const BatchInputSchema = z.object({
  operationId: z.string().uuid(),
  decisionIds: z.array(z.number().int().positive()).min(1).max(500)
});

export type RemovalState =
  | "draft" | "scheduled" | "ready" | "executing" | "removed"
  | "already_absent" | "paused" | "unknown" | "cancelled";

export interface DeckCard {
  id: number;
  platform: Platform;
  targetKey: string;
  displayName: string;
  handle?: string;
  profileUrl: string;
  photoUrl?: string;
  version: number;
  deckOrder: number;
}

export interface AdapterRelationship {
  targetKey: string;
  displayName: string;
  handle?: string;
  profileUrl: string;
  photoUrl?: string;
}
