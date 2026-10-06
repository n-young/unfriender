import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Response } from "playwright";
import { Store, type ClaimedRemoval } from "../apps/server/src/store.js";

const expectedHandle=process.env.CONFIRM_INSTAGRAM_UNFOLLOW;
if(!expectedHandle)throw new Error("Set CONFIRM_INSTAGRAM_UNFOLLOW to the exact authorized Instagram handle");
const root=path.resolve(import.meta.dirname,"..");
const dataDir=path.resolve(root,process.env.DATA_DIR??".data");
const snapshot=JSON.parse(readFileSync(path.join(dataDir,"platform-cache","instagram.json"),"utf8")) as {
  account:{actingAccountKey:string};relationships:Array<{targetKey:string;handle?:string;profileUrl:string;displayName:string}>;
};
const target=snapshot.relationships.find(item=>item.handle?.toLowerCase()===expectedHandle.toLowerCase());
if(!target||!/^id:\d+$/.test(target.targetKey))throw new Error("Authorized handle does not resolve to one stable numeric target in the current snapshot");
const targetId=target.targetKey.slice(3);
const store=new Store(path.join(dataDir,"social-cleanup.sqlite"));
const row=store.db.prepare(`SELECT r.id,r.decision_id AS decisionId,r.state,r.target_key AS targetKey,
  a.id AS accountId,a.acting_account_key AS actingAccountKey,a.session_generation AS sessionGeneration,r.batch_id AS batchId,
  c.handle,c.display_name AS displayName
  FROM removals r JOIN accounts a ON a.id=r.account_id JOIN decisions d ON d.id=r.decision_id
  JOIN connections c ON c.id=d.connection_id
  WHERE a.platform='instagram' AND lower(c.handle)=lower(?) AND r.state IN ('draft','paused')`).all(expectedHandle) as Array<{
    id:number;decisionId:number;state:string;targetKey:string;accountId:number;actingAccountKey:string;sessionGeneration:number;batchId:number|null;handle:string;displayName:string;
  }>;
if(row.length!==1||row[0].targetKey!==target.targetKey)throw new Error("Expected exactly one draft removal bound to the authorized Instagram target");
if(row[0].actingAccountKey!==snapshot.account.actingAccountKey)throw new Error("Database and snapshot acting accounts do not match");

const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile=path.join(dataDir,"profiles","instagram");
const context=await chromium.launchPersistentContext(profile,{headless:process.env.HEADLESS!=="false",...(process.platform==="darwin"&&existsSync(macChrome)?{executablePath:macChrome}:{})});
const allowedHeaderNames=new Set(["accept","accept-language","referer","user-agent","x-asbd-id","x-csrftoken","x-ig-app-id","x-ig-www-claim","x-requested-with","x-web-session-id"]);
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let claimed:ClaimedRemoval|undefined;let mutationDispatched=false;

async function exactRelationshipState(browser:BrowserContext,headers:Record<string,string>){
  for(let attempt=0;attempt<4;attempt++){
    if(attempt)await sleep(Math.min(15_000,2_000*2**(attempt-1)));
    const response=await browser.request.get(`https://www.instagram.com/api/v1/friendships/show/${targetId}/`,{headers,timeout:60_000});
    if(response.ok()){
      const body=await response.json() as {status?:string;following?:boolean};
      if(body.status!=="ok"||typeof body.following!=="boolean")throw new Error("Instagram friendship response shape changed");
      return body.following;
    }
    if(response.status()!==429&&response.status()<500)throw new Error(`Instagram friendship check failed with HTTP ${response.status()}`);
    if(attempt===3)throw new Error(`Instagram friendship check remained unavailable after backoff (HTTP ${response.status()})`);
  }
  throw new Error("Instagram friendship check exhausted");
}

try{
  const page=context.pages()[0]??await context.newPage();
  const accountResponse=page.waitForResponse(response=>response.url().includes("/api/v1/accounts/edit/web_form_data/"),{timeout:30_000});
  await page.goto("https://www.instagram.com/accounts/edit/",{waitUntil:"domcontentloaded",timeout:60_000});
  const account=await(await accountResponse).json() as {form_data?:{username?:string}};
  if(!account.form_data?.username)throw new Error("Instagram session is not authenticated");
  await page.goto(`https://www.instagram.com/${encodeURIComponent(account.form_data.username)}/`,{waitUntil:"domcontentloaded",timeout:60_000});
  await page.waitForTimeout(3_000);
  const followingResponse=page.waitForResponse(response=>/\/api\/v1\/friendships\/\d+\/following\//.test(new URL(response.url()).pathname),{timeout:30_000});
  const ownFollowing=page.getByRole("link",{name:/following/i}).first();
  if(!await ownFollowing.count())throw new Error("Could not locate the acting account's Following control");
  await ownFollowing.click();
  const initial=await followingResponse;
  const ownerMatch=new URL(initial.url()).pathname.match(/^\/api\/v1\/friendships\/(\d+)\/following\/$/);
  if(!ownerMatch||`instagram:id:${ownerMatch[1]}`!==row[0].actingAccountKey)throw new Error("Live acting account does not match the staged removal");
  const requestHeaders=await initial.request().allHeaders();
  const headers=Object.fromEntries(Object.entries(requestHeaders).filter(([key])=>allowedHeaderNames.has(key)));
  if(!await exactRelationshipState(context,headers))throw new Error("Target is already absent before mutation");

  await page.goto(target.profileUrl,{waitUntil:"domcontentloaded",timeout:60_000});await page.waitForTimeout(3_000);
  if(new URL(page.url()).pathname.toLowerCase()!==`/${expectedHandle.toLowerCase()}/`)throw new Error("Target profile redirected unexpectedly");
  const openUnfollowMenu=async()=>{
    const following=page.getByText("Following",{exact:true}).locator("xpath=ancestor::button[1]");
    if(await following.count()!==1)throw new Error("Target Following control is not unique");
    await following.click();await page.waitForTimeout(1_000);
    const dialog=page.locator("[role=dialog]");
    if(await dialog.count()!==1)throw new Error("Target relationship dialog is not unique");
    const unfollow=dialog.getByText("Unfollow",{exact:true}).locator("xpath=ancestor::*[@role='button'][1]");
    if(await unfollow.count()!==1)throw new Error("Target Unfollow confirmation is not unique");
    return unfollow;
  };
  await openUnfollowMenu();await page.keyboard.press("Escape");await page.waitForTimeout(500);

  const scheduled=row[0].state==="draft"
    ? store.createBatch(crypto.randomUUID(),[row[0].decisionId],Date.now(),10_000)
    : (()=>{
        if(!row[0].batchId)throw new Error("Paused canary has no batch to resume");
        const members=Number((store.db.prepare("SELECT count(*) count FROM removals WHERE batch_id=?").get(row[0].batchId) as {count:number}).count);
        if(members!==1)throw new Error("Refusing to resume a live-test batch containing more than the exact canary");
        return store.resumeBatch(row[0].batchId,Date.now(),10_000);
      })();
  const deadline=Number(scheduled.executeAfterMs);
  if(!Number.isFinite(deadline))throw new Error("Canary batch returned an invalid execution deadline");
  console.log(`Scheduled one Instagram canary for @${expectedHandle}; waiting for the 10-second grace window.`);
  await sleep(Math.max(0,deadline-Date.now()));
  claimed=store.claimNext(Date.now());
  if(!claimed||claimed.id!==row[0].id||claimed.targetKey!==target.targetKey){
    if(claimed)store.completeRemoval(claimed.id,"paused",undefined,"unexpected job won the live-test claim");
    throw new Error("Could not atomically claim the exact authorized removal");
  }
  if(!store.accountMatches(claimed.accountId,claimed.actingAccountKey,claimed.sessionGeneration)){
    store.completeRemoval(claimed.id,"paused",undefined,"bound account or session generation changed");
    throw new Error("Bound Instagram account changed before dispatch");
  }
  if(!await exactRelationshipState(context,headers)){
    store.completeRemoval(claimed.id,"already_absent","target absent before mutation");
    console.log(`@${expectedHandle} was already absent at dispatch time; no mutation was sent.`);
    process.exitCode=0;
  }else{
    await page.goto(target.profileUrl,{waitUntil:"domcontentloaded",timeout:60_000});await page.waitForTimeout(3_000);
    if(new URL(page.url()).pathname.toLowerCase()!==`/${expectedHandle.toLowerCase()}/`)throw new Error("Target profile redirected unexpectedly");
    const unfollow=await openUnfollowMenu();
    const mutationResponsePromise:Promise<Response|undefined>=page.waitForResponse(response=>{
      if(response.request().method()!=="POST")return false;
      const pathname=new URL(response.url()).pathname;
      return pathname===`/api/v1/friendships/destroy/${targetId}/`||pathname===`/web/friendships/${targetId}/unfollow/`;
    },{timeout:30_000}).catch(()=>undefined);
    mutationDispatched=true;
    await unfollow.click();
    const mutationResponse=await mutationResponsePromise;
    await sleep(2_000);
    const followingAfter=await exactRelationshipState(context,headers);
    const reportDir=path.join(dataDir,"adapter-spikes");mkdirSync(reportDir,{recursive:true,mode:0o700});
    const params=new URLSearchParams(mutationResponse?.request().postData()??"");
    const report={capturedAt:new Date().toISOString(),platform:"instagram",targetBinding:"stable numeric ID matched staged row",method:mutationResponse?.request().method()??"unobserved",status:mutationResponse?.status()??null,path:mutationResponse?new URL(mutationResponse.url()).pathname.replace(targetId,"<target-id>"):"unobserved",bodyKeys:[...params.keys()].sort(),followingAfter};
    const reportFile=path.join(reportDir,"instagram-removal-live.json");writeFileSync(reportFile,JSON.stringify(report,null,2),{mode:0o600});chmodSync(reportFile,0o600);
    if(followingAfter){
      store.completeRemoval(claimed.id,"unknown",undefined,"unfollow was dispatched once but target still appears followed");
      throw new Error("Unfollow was dispatched once but independent verification still reports following");
    }
    store.completeRemoval(claimed.id,"removed","verified absent after one Instagram unfollow");
    console.log(`Verified @${expectedHandle} is no longer followed after exactly one mutation dispatch.`);
  }
}catch(error){
  if(claimed){
    const current=store.removals().find(item=>(item as {id:number}).id===claimed!.id) as {state?:string}|undefined;
    if(current?.state==="executing")store.completeRemoval(claimed.id,mutationDispatched?"unknown":"paused",undefined,error instanceof Error?error.message:String(error));
  }
  throw error;
}finally{
  await context.close();store.close();
}
