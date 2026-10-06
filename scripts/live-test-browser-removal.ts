import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type BrowserContext, type Locator, type Page } from "playwright";
import { Store, type ClaimedRemoval } from "../apps/server/src/store.js";

type BrowserPlatform="linkedin"|"facebook";
const platform=process.argv[2] as BrowserPlatform;
if(!["linkedin","facebook"].includes(platform))throw new Error("Usage: tsx scripts/live-test-browser-removal.ts linkedin|facebook");
const confirmationVariable=platform==="linkedin"?"CONFIRM_LINKEDIN_REMOVE":"CONFIRM_FACEBOOK_UNFRIEND";
const expectedHandle=process.env[confirmationVariable];
if(!expectedHandle)throw new Error(`Set ${confirmationVariable} to the exact authorized profile handle`);
const live=process.env.LIVE_BROWSER_REMOVAL===expectedHandle;

const root=path.resolve(import.meta.dirname,"..");
const dataDir=path.resolve(root,process.env.DATA_DIR??".data");
const snapshot=JSON.parse(readFileSync(path.join(dataDir,"platform-cache",`${platform}.json`),"utf8")) as {
  account:{actingAccountKey:string};relationships:Array<{targetKey:string;handle?:string;profileUrl:string;displayName:string}>;
};
const target=snapshot.relationships.find(item=>item.handle?.toLowerCase()===expectedHandle.toLowerCase());
if(!target)throw new Error("Authorized handle does not resolve to one target in the current snapshot");
const store=new Store(path.join(dataDir,"social-cleanup.sqlite"));
const rows=store.db.prepare(`SELECT r.id,r.decision_id AS decisionId,r.state,r.target_key AS targetKey,
  a.id AS accountId,a.acting_account_key AS actingAccountKey,a.session_generation AS sessionGeneration,r.batch_id AS batchId,
  c.handle,c.display_name AS displayName
  FROM removals r JOIN accounts a ON a.id=r.account_id JOIN decisions d ON d.id=r.decision_id
  JOIN connections c ON c.id=d.connection_id
  WHERE a.platform=? AND lower(c.handle)=lower(?) AND r.state IN ('draft','paused')`).all(platform,expectedHandle) as Array<{
    id:number;decisionId:number;state:string;targetKey:string;accountId:number;actingAccountKey:string;sessionGeneration:number;batchId:number|null;handle:string;displayName:string;
  }>;
if(rows.length!==1||rows[0].targetKey!==target.targetKey)throw new Error(`Expected exactly one staged ${platform} removal bound to the authorized target`);
if(rows[0].actingAccountKey!==snapshot.account.actingAccountKey)throw new Error("Database and snapshot acting accounts do not match");

const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile=path.join(dataDir,"profiles",platform);
const sessionFile=path.join(dataDir,"platform-sessions",`${platform}.json`);
const context=await chromium.launchPersistentContext(profile,{headless:process.env.HEADLESS!=="false",...(process.platform==="darwin"&&existsSync(macChrome)?{executablePath:macChrome}:{})});
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
let claimed:ClaimedRemoval|undefined;
let mutationDispatched=false;

async function visible(locator:Locator){
  const matches=[] as Locator[];
  for(let i=0;i<await locator.count();i++){const candidate=locator.nth(i);if(await candidate.isVisible().catch(()=>false))matches.push(candidate);}
  return matches;
}
async function oneVisible(candidates:Locator[],description:string){
  for(const candidate of candidates){
    const matches=await visible(candidate);
    if(matches.length===1)return matches[0];
    if(matches.length>1)throw new Error(`${description} is not unique (${matches.length} visible)`);
  }
  throw new Error(`${description} was not found`);
}
function normalizedName(value:string){return value.replace(/[’']s profile picture$/i,"").trim().toLowerCase();}
async function verifyTargetPage(page:Page){
  const actual=new URL(page.url());
  const expected=new URL(target.profileUrl);
  const expectedPath=expected.pathname.replace(/\/$/,"").toLowerCase();
  const actualPath=actual.pathname.replace(/\/$/,"").toLowerCase();
  if(actual.hostname!==expected.hostname||actualPath!==expectedPath)throw new Error("Target profile redirected to a different profile path");
  const wanted=normalizedName(target.displayName);
  const headings=await page.locator("h1,h2").allInnerTexts();
  if(!headings.some(heading=>normalizedName(heading).includes(wanted)))throw new Error("Target profile heading does not match the staged relationship");
}
async function verifyActingAccount(page:Page){
  if(platform==="linkedin"){
    const responsePromise=page.waitForResponse(response=>new URL(response.url()).pathname==="/voyager/api/me"&&response.ok(),{timeout:30_000});
    await page.goto("https://www.linkedin.com/feed/",{waitUntil:"domcontentloaded",timeout:60_000});
    const body=await(await responsePromise).json() as {data?:{plainId?:string}};
    if(!body.data?.plainId||`linkedin:${body.data.plainId}`!==rows[0].actingAccountKey)throw new Error("Live LinkedIn account does not match the staged removal");
  }else{
    await page.goto("https://www.facebook.com/me",{waitUntil:"domcontentloaded",timeout:60_000});
    await page.waitForTimeout(2_000);
    const current=new URL(page.url());
    const owner=current.pathname.split("/").filter(Boolean)[0];
    if(!owner||`facebook:vanity:${owner}`.toLowerCase()!==rows[0].actingAccountKey.toLowerCase())throw new Error("Live Facebook account does not match the staged removal");
  }
}
async function openRelationshipMenu(page:Page){
  if(platform==="linkedin"){
    const more=await oneVisible([
      page.getByRole("button",{name:/^more actions$/i}),
      page.getByRole("button",{name:/^more$/i})
    ],"LinkedIn More control");
    await more.click();await page.waitForTimeout(500);
    const action=await oneVisible([
      page.getByRole("menuitem",{name:/^remove connection$/i}),
      page.getByText("Remove connection",{exact:true})
    ],"LinkedIn Remove connection action");
    return action;
  }
  const friends=await oneVisible([
    page.getByRole("button",{name:/^friends$/i}),
    page.getByText("Friends",{exact:true}).locator("xpath=ancestor::*[@role='button'][1]")
  ],"Facebook Friends control");
  await friends.click();await page.waitForTimeout(500);
  return oneVisible([
    page.getByRole("menuitem",{name:/^unfriend/i}),
    page.getByText(/^Unfriend$/i)
  ],"Facebook Unfriend action");
}
async function relationshipPresent(page:Page){
  await page.goto(target.profileUrl,{waitUntil:"domcontentloaded",timeout:60_000});await page.waitForTimeout(2_500);
  await verifyTargetPage(page);
  try{await openRelationshipMenu(page);await page.keyboard.press("Escape");return true;}
  catch(error){
    const absent=platform==="linkedin"
      ? (await visible(page.getByText("Connect",{exact:true}).locator("xpath=ancestor::button[1]"))).length>0
      : (await visible(page.getByText(/^add friend$/i))).length>0;
    if(absent)return false;
    throw error;
  }
}
async function dispatchRemoval(page:Page){
  await page.goto(target.profileUrl,{waitUntil:"domcontentloaded",timeout:60_000});await page.waitForTimeout(2_500);
  await verifyTargetPage(page);
  const action=await openRelationshipMenu(page);
  mutationDispatched=true;
  await action.click();await page.waitForTimeout(750);
  const dialog=page.getByRole("dialog");
  if((await visible(dialog)).length){
    const confirm=platform==="linkedin"
      ? await oneVisible([dialog.getByRole("button",{name:/^remove$/i}),dialog.getByRole("button",{name:/^remove connection$/i})],"LinkedIn final Remove control")
      : await oneVisible([dialog.getByRole("button",{name:/^confirm$/i}),dialog.getByRole("button",{name:/^unfriend$/i})],"Facebook final confirmation control");
    await confirm.click();
  }
  await page.waitForTimeout(2_000);
}

try{
  const page=context.pages()[0]??await context.newPage();
  await verifyActingAccount(page);
  if(!await relationshipPresent(page))throw new Error("Target is already absent before mutation");
  console.log(`Dry-run verified the exact ${platform} target and located the ${platform==="linkedin"?"Remove connection":"Unfriend"} control.`);
  if(!live){
    console.log(`No mutation was sent. Set LIVE_BROWSER_REMOVAL to the same exact handle to run the guarded canary.`);
  }else{
    const currentAccount=store.db.prepare("SELECT session_generation AS sessionGeneration,acting_account_key AS actingAccountKey FROM accounts WHERE id=?").get(rows[0].accountId) as {sessionGeneration:number;actingAccountKey:string};
    if(currentAccount.actingAccountKey!==rows[0].actingAccountKey)throw new Error("Acting account changed after live identity verification");
    if(currentAccount.sessionGeneration!==rows[0].sessionGeneration){
      const rebound=store.db.prepare("UPDATE removals SET session_generation=? WHERE id=? AND state IN ('draft','paused') AND acting_account_key=?").run(currentAccount.sessionGeneration,rows[0].id,rows[0].actingAccountKey);
      if(rebound.changes!==1)throw new Error("Could not refresh the exact canary's verified session binding");
      rows[0].sessionGeneration=currentAccount.sessionGeneration;
    }
    const scheduled=rows[0].state==="draft"
      ? store.createBatch(crypto.randomUUID(),[rows[0].decisionId],Date.now(),10_000)
      : (()=>{
          if(!rows[0].batchId)throw new Error("Paused canary has no batch to resume");
          const members=Number((store.db.prepare("SELECT count(*) count FROM removals WHERE batch_id=?").get(rows[0].batchId) as {count:number}).count);
          if(members!==1)throw new Error("Refusing to resume a live-test batch containing more than the exact canary");
          return store.resumeBatch(rows[0].batchId,Date.now(),10_000);
        })();
    const deadline=Number(scheduled.executeAfterMs);
    console.log(`Scheduled one exact ${platform} canary; waiting for the 10-second grace window.`);
    await sleep(Math.max(0,deadline-Date.now()));
    claimed=store.claimNext(Date.now());
    if(!claimed||claimed.id!==rows[0].id||claimed.targetKey!==target.targetKey){
      if(claimed)store.completeRemoval(claimed.id,"paused",undefined,"unexpected job won the live-test claim");
      throw new Error("Could not atomically claim the exact authorized removal");
    }
    if(!store.accountMatches(claimed.accountId,claimed.actingAccountKey,claimed.sessionGeneration)){
      store.completeRemoval(claimed.id,"paused",undefined,"bound account or session generation changed");
      throw new Error(`Bound ${platform} account changed before dispatch`);
    }
    if(!await relationshipPresent(page)){
      store.completeRemoval(claimed.id,"already_absent","target absent before mutation");
      console.log("Target was already absent at dispatch time; no mutation was sent.");
    }else{
      const captured:Array<{method:string;status:number;path:string;operation?:string;bodyKeys:string[]}>=[];
      page.on("response",response=>{
        if(!mutationDispatched||response.request().method()!=="POST")return;
        const url=new URL(response.url());
        if(!url.hostname.endsWith(platform==="linkedin"?"linkedin.com":"facebook.com"))return;
        const params=new URLSearchParams(response.request().postData()??"");
        captured.push({method:"POST",status:response.status(),path:url.pathname.replace(/\d{6,}/g,"<id>"),operation:params.get("fb_api_req_friendly_name")??undefined,bodyKeys:[...new Set(params.keys())].sort()});
      });
      await dispatchRemoval(page);
      const presentAfter=await relationshipPresent(page);
      const reportDir=path.join(dataDir,"adapter-spikes");mkdirSync(reportDir,{recursive:true,mode:0o700});
      const reportFile=path.join(reportDir,`${platform}-removal-live.json`);
      writeFileSync(reportFile,JSON.stringify({capturedAt:new Date().toISOString(),platform,targetBinding:"staged handle, canonical URL, profile heading, acting account",presentAfter,requests:captured.slice(0,30)},null,2),{mode:0o600});chmodSync(reportFile,0o600);
      if(presentAfter){
        store.completeRemoval(claimed.id,"unknown",undefined,"browser removal was dispatched once but the relationship still appears present");
        throw new Error("Removal was dispatched once but independent UI verification still shows the relationship");
      }
      store.completeRemoval(claimed.id,"removed",`verified absent after one ${platform} browser removal`);
      console.log(`Verified the exact ${platform} relationship is absent after one browser mutation flow.`);
    }
  }
  await context.storageState({path:sessionFile});chmodSync(sessionFile,0o600);
}catch(error){
  if(claimed){
    const current=store.removals().find(item=>(item as {id:number}).id===claimed!.id) as {state?:string}|undefined;
    if(current?.state==="executing")store.completeRemoval(claimed.id,mutationDispatched?"unknown":"paused",undefined,error instanceof Error?error.message:String(error));
  }
  throw error;
}finally{
  await context.close();store.close();
}
