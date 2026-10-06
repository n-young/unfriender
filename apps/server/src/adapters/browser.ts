import { chmodSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import { z } from "zod";
import type { Platform } from "@social-cleanup/shared";
import { AdapterUnavailableError, AmbiguousMutationError, RateLimitError, SessionError, type PlatformAdapter } from "./types.js";

const SnapshotSchema=z.object({
  version:z.literal(1),capturedAt:z.string(),complete:z.boolean(),
  account:z.object({actingAccountKey:z.string().min(1),displayName:z.string().min(1),publicIdentifier:z.string().optional(),username:z.string().optional()}),
  relationships:z.array(z.object({targetKey:z.string().min(1),displayName:z.string().min(1),handle:z.string().optional(),profileUrl:z.string().url(),photoUrl:z.string().url().optional()}))
});
type Snapshot=z.infer<typeof SnapshotSchema>;
type SnapshotRelationship=Snapshot["relationships"][number];

export class BrowserAdapter implements PlatformAdapter {
  readonly verified=true;
  private browser?:Browser;
  private context?:BrowserContext;
  private page?:Page;
  private instagramHeaders?:Record<string,string>;

  constructor(readonly platform:Platform,private dataDir:string){}

  private get snapshotFile(){return path.join(this.dataDir,"platform-cache",`${this.platform}.json`);}
  private get sessionFile(){return path.join(this.dataDir,"platform-sessions",`${this.platform}.json`);}
  private read():Snapshot{
    try{return SnapshotSchema.parse(JSON.parse(readFileSync(this.snapshotFile,"utf8")));}
    catch(error){throw new AdapterUnavailableError(`${this.platform} relationship snapshot is unavailable or invalid`,{cause:error});}
  }
  private target(targetKey:string):SnapshotRelationship{
    const row=this.read().relationships.find(item=>item.targetKey===targetKey);
    if(!row)throw new SessionError("exact target is not present in the current platform snapshot");
    return row;
  }
  private async browserPage(){
    if(this.page&&!this.page.isClosed())return this.page;
    if(!existsSync(this.sessionFile))throw new AdapterUnavailableError(`${this.platform} browser session is missing; export the authenticated session first`);
    this.browser=await chromium.launch({headless:true,args:["--disable-dev-shm-usage"],...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH}:{})});
    this.context=await this.browser.newContext({storageState:this.sessionFile});
    this.page=await this.context.newPage();
    return this.page;
  }
  private async goto(url:string){
    const page=await this.browserPage();
    const response=await page.goto(url,{waitUntil:"domcontentloaded",timeout:60_000});
    if(response?.status()===429)throw new RateLimitError(`${this.platform} returned HTTP 429 during a read-only check`,60_000);
    if(response&&response.status()>=500)throw new RateLimitError(`${this.platform} returned HTTP ${response.status()} during a read-only check`,30_000);
    await page.waitForTimeout(2_000);
    const current=new URL(page.url());
    if(/\/(login|checkpoint|challenge)(\/|$)/.test(current.pathname)||await page.locator("input[name='username'],input[name='email'],form[action*='login']").count()){
      throw new SessionError(`${this.platform} session requires reconnect on the computer`);
    }
    return page;
  }
  private async persist(){if(this.context){await this.context.storageState({path:this.sessionFile});chmodSync(this.sessionFile,0o600);}}
  private async visible(locator:Locator){const found:Locator[]=[];for(let i=0;i<await locator.count();i++){const item=locator.nth(i);if(await item.isVisible().catch(()=>false))found.push(item);}return found;}
  private async oneVisible(candidates:Locator[],description:string):Promise<Locator>{
    for(const candidate of candidates){const matches=await this.visible(candidate);if(matches.length===1)return matches[0]!;if(matches.length>1)throw new SessionError(`${description} is not unique`);}
    throw new SessionError(`${description} was not found`);
  }
  private normalizedName(value:string){return value.replace(/[’']s profile picture$/i,"").trim().toLowerCase();}
  private async verifyTargetPage(page:Page,target:SnapshotRelationship){
    const actual=new URL(page.url()),expected=new URL(target.profileUrl);
    if(actual.hostname!==expected.hostname||actual.pathname.replace(/\/$/,"").toLowerCase()!==expected.pathname.replace(/\/$/,"").toLowerCase())throw new SessionError("target profile redirected to a different profile path");
    const wanted=this.normalizedName(target.displayName);
    const headings=await page.locator("h1,h2").allInnerTexts();
    if(!headings.some(heading=>this.normalizedName(heading).includes(wanted)))throw new SessionError("target profile heading does not match the immutable removal snapshot");
  }
  private async openLinkedInRemoval(page:Page){
    const more=await this.oneVisible([page.getByRole("button",{name:/^more actions$/i}),page.getByRole("button",{name:/^more$/i})],"LinkedIn More control");
    await more.click();await page.waitForTimeout(400);
    return this.oneVisible([page.getByRole("menuitem",{name:/^remove connection$/i}),page.getByText("Remove connection",{exact:true})],"LinkedIn Remove connection action");
  }
  private async openFacebookRemoval(page:Page){
    const friends=await this.oneVisible([page.getByRole("button",{name:/^friends$/i}),page.getByText("Friends",{exact:true}).locator("xpath=ancestor::*[@role='button'][1]")],"Facebook Friends control");
    await friends.click();await page.waitForTimeout(400);
    return this.oneVisible([page.getByRole("menuitem",{name:/^unfriend/i}),page.getByText(/^Unfriend$/i)],"Facebook Unfriend action");
  }

  async checkSession(){
    const expected=this.read().account;
    if(this.platform==="linkedin"){
      const page=await this.browserPage();
      const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==="/voyager/api/me"&&response.ok(),{timeout:30_000});
      await this.goto("https://www.linkedin.com/feed/");
      const body=await(await responsePromise).json() as {data?:{plainId?:string}};
      if(!body.data?.plainId||`linkedin:${body.data.plainId}`!==expected.actingAccountKey)throw new SessionError("live LinkedIn account does not match the configured account");
    }else if(this.platform==="facebook"){
      const page=await this.goto("https://www.facebook.com/me");
      const owner=new URL(page.url()).pathname.split("/").filter(Boolean)[0];
      if(!owner||`facebook:vanity:${owner}`.toLowerCase()!==expected.actingAccountKey.toLowerCase())throw new SessionError("live Facebook account does not match the configured account");
    }else{
      const page=await this.browserPage();
      const accountResponse=page.waitForResponse(response=>response.url().includes("/api/v1/accounts/edit/web_form_data/")&&response.ok(),{timeout:30_000});
      await this.goto("https://www.instagram.com/accounts/edit/");
      const body=await(await accountResponse).json() as {form_data?:{username?:string}};
      if(!body.form_data?.username)throw new SessionError("Instagram session is not authenticated");
      const followingResponse=page.waitForResponse(response=>/\/api\/v1\/friendships\/\d+\/following\//.test(new URL(response.url()).pathname)&&response.ok(),{timeout:30_000});
      await this.goto(`https://www.instagram.com/${encodeURIComponent(body.form_data.username)}/`);
      const following=page.getByRole("link",{name:/following/i}).first();
      if(!await following.count())throw new SessionError("Instagram acting account Following control was not found");
      await following.click();
      const response=await followingResponse;
      const match=new URL(response.url()).pathname.match(/^\/api\/v1\/friendships\/(\d+)\/following\/$/);
      if(!match||`instagram:id:${match[1]}`!==expected.actingAccountKey)throw new SessionError("live Instagram account does not match the configured account");
      const allowed=new Set(["accept","accept-language","referer","user-agent","x-asbd-id","x-csrftoken","x-ig-app-id","x-ig-www-claim","x-requested-with","x-web-session-id"]);
      this.instagramHeaders=Object.fromEntries(Object.entries(await response.request().allHeaders()).filter(([key])=>allowed.has(key)));
      await page.keyboard.press("Escape");
    }
    await this.persist();
    return {actingAccountKey:expected.actingAccountKey,displayName:expected.displayName};
  }
  async discover(cursor:string|null,limit:number){
    const data=this.read(),offset=cursor?Number(cursor):0,relationships=data.relationships.slice(offset,offset+limit),next=offset+relationships.length;
    return {relationships,nextCursor:next<data.relationships.length?String(next):null,complete:data.complete&&next>=data.relationships.length};
  }
  async relationshipState(targetKey:string){
    const target=this.target(targetKey);
    if(this.platform==="instagram"){
      const match=targetKey.match(/^id:(\d+)$/);if(!match)throw new SessionError("Instagram target lacks a stable numeric ID");
      if(!this.context||!this.instagramHeaders)await this.checkSession();
      const response=await this.context!.request.get(`https://www.instagram.com/api/v1/friendships/show/${match[1]}/`,{headers:this.instagramHeaders,timeout:60_000});
      if(response.status()===429||response.status()>=500)throw new RateLimitError(`Instagram relationship check returned HTTP ${response.status()}`,60_000);
      if(!response.ok())throw new SessionError(`Instagram relationship check returned HTTP ${response.status()}`);
      const body=await response.json() as {status?:string;following?:boolean};
      if(body.status!=="ok"||typeof body.following!=="boolean")return "unknown";
      return body.following?"present":"absent";
    }
    const page=await this.goto(target.profileUrl);await this.verifyTargetPage(page,target);
    try{
      const action=this.platform==="linkedin"?await this.openLinkedInRemoval(page):await this.openFacebookRemoval(page);
      if(!await action.isVisible())return "unknown";
      await page.keyboard.press("Escape");return "present";
    }catch(error){
      const absent=this.platform==="linkedin"
        ? (await this.visible(page.getByRole("button",{name:/^connect$/i}))).length>0
        : (await this.visible(page.getByText(/^add friend$/i))).length>0;
      if(absent)return "absent";
      throw error;
    }
  }
  async remove(targetKey:string){
    const target=this.target(targetKey),page=await this.goto(target.profileUrl);await this.verifyTargetPage(page,target);
    try{
      if(this.platform==="instagram"){
        const following=page.getByText("Following",{exact:true}).locator("xpath=ancestor::button[1]");
        if((await this.visible(following)).length!==1)throw new Error("Instagram Following control is not unique");
        await following.click();await page.waitForTimeout(500);
        const dialog=page.locator("[role=dialog]");
        const unfollow=dialog.getByText("Unfollow",{exact:true}).locator("xpath=ancestor::*[@role='button'][1]");
        if((await this.visible(dialog)).length!==1||(await this.visible(unfollow)).length!==1)throw new Error("Instagram Unfollow confirmation is not unique");
        await unfollow.click();
      }else if(this.platform==="facebook"){
        const action=await this.openFacebookRemoval(page);await action.click();await page.waitForTimeout(600);
        const dialog=page.getByRole("dialog");
        if((await this.visible(dialog)).length){const confirm=await this.oneVisible([dialog.getByRole("button",{name:/^confirm$/i}),dialog.getByRole("button",{name:/^unfriend$/i})],"Facebook final confirmation");await confirm.click();}
      }else{
        const action=await this.openLinkedInRemoval(page);await action.click();await page.waitForTimeout(600);
        const dialog=page.getByRole("dialog");
        const confirm=await this.oneVisible([dialog.getByRole("button",{name:/^remove$/i}),dialog.getByRole("button",{name:/^remove connection$/i})],"LinkedIn final Remove control");await confirm.click();
      }
      await page.waitForTimeout(1_500);await this.persist();
    }catch(error){throw new AmbiguousMutationError(error instanceof Error?error.message:String(error),{cause:error});}
  }
  async disconnect(){await this.context?.close();await this.browser?.close();this.context=undefined;this.browser=undefined;this.page=undefined;this.instagramHeaders=undefined;}
}
