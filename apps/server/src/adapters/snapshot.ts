import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Platform } from "@social-cleanup/shared";
import { AdapterUnavailableError, type PlatformAdapter } from "./types.js";

const SnapshotSchema=z.object({
  version:z.literal(1),capturedAt:z.string(),complete:z.boolean(),
  account:z.object({actingAccountKey:z.string().min(1),displayName:z.string().min(1)}),
  relationships:z.array(z.object({
    targetKey:z.string().min(1),displayName:z.string().min(1),handle:z.string().optional(),
    profileUrl:z.string().url(),photoUrl:z.string().url().optional()
  }))
});

export class SnapshotAdapter implements PlatformAdapter {
  readonly verified=false;
  constructor(readonly platform:Platform,private filename:string){}
  private read(){
    try{return SnapshotSchema.parse(JSON.parse(readFileSync(this.filename,"utf8")))}
    catch(error){throw new AdapterUnavailableError(`${this.platform} host snapshot is unavailable or invalid; run npm run sync:${this.platform}`,{cause:error});}
  }
  async checkSession(){const data=this.read();return data.account;}
  async discover(cursor:string|null,limit:number){
    const data=this.read();const offset=cursor?Number(cursor):0;
    const relationships=data.relationships.slice(offset,offset+limit);
    const next=offset+relationships.length;
    return {relationships,nextCursor:next<data.relationships.length?String(next):null,complete:data.complete&&next>=data.relationships.length};
  }
  async relationshipState(targetKey:string){return this.read().relationships.some(row=>row.targetKey===targetKey)?"present" as const:"unknown" as const;}
  async remove(_targetKey:string):Promise<void>{throw new AdapterUnavailableError(`${this.platform} removal has not been live-verified and remains disabled`);}
  async disconnect(){}
}
