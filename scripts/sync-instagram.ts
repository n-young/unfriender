import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type APIResponse } from "playwright";

const root=path.resolve(import.meta.dirname,"..");
const dataDir=path.resolve(root,process.env.DATA_DIR??".data");
const profile=path.join(dataDir,"profiles","instagram");
const cacheDir=path.join(dataDir,"platform-cache");
const sessionDir=path.join(dataDir,"platform-sessions");
const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const limit=Math.max(10,Math.min(5_000,Number(process.env.INSTAGRAM_SYNC_LIMIT??1_000)));
const pageDelayMs=Math.max(750,Number(process.env.INSTAGRAM_PAGE_DELAY_MS??1_500));
if(!existsSync(profile))throw new Error("Instagram profile is missing. Run: npm run login -- instagram");
mkdirSync(cacheDir,{recursive:true,mode:0o700});
mkdirSync(sessionDir,{recursive:true,mode:0o700});

type InstagramUser={id?:string;pk?:string;pk_id?:string;username?:string;full_name?:string;profile_pic_url?:string};
type FollowingPage={users?:InstagramUser[];has_more?:boolean;next_max_id?:string;status?:string};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const allowedHeaderNames=new Set(["accept","accept-language","referer","user-agent","x-asbd-id","x-csrftoken","x-ig-app-id","x-ig-www-claim","x-requested-with","x-web-session-id"]);

async function retryingGet(context:Awaited<ReturnType<typeof chromium.launchPersistentContext>>,url:string,headers:Record<string,string>){
  for(let attempt=0;attempt<5;attempt++){
    if(attempt||pageDelayMs)await sleep(attempt?Math.min(30_000,pageDelayMs*2**attempt):pageDelayMs);
    const response=await context.request.get(url,{headers,timeout:60_000});
    if(response.ok())return response;
    if(response.status()!==429&&response.status()<500)throw new Error(`Instagram following page failed with HTTP ${response.status()}`);
    if(attempt===4)throw new Error(`Instagram following page remained unavailable after backoff (HTTP ${response.status()})`);
    const retryAfter=Number(response.headers()["retry-after"]??0);
    if(Number.isFinite(retryAfter)&&retryAfter>0)await sleep(Math.min(60_000,retryAfter*1_000));
  }
  throw new Error("Instagram following page retry loop exhausted");
}

const context=await chromium.launchPersistentContext(profile,{headless:process.env.HEADLESS!=="false",...(process.platform==="darwin"&&existsSync(macChrome)?{executablePath:macChrome}:{})});
try{
  const page=context.pages()[0]??await context.newPage();
  const accountResponse=page.waitForResponse(response=>response.url().includes("/api/v1/accounts/edit/web_form_data/"),{timeout:30_000});
  await page.goto("https://www.instagram.com/accounts/edit/",{waitUntil:"domcontentloaded",timeout:60_000});
  const accountReply=await accountResponse;
  const accountData=await accountReply.json() as {form_data?:{username?:string;first_name?:string}};
  const username=accountData.form_data?.username;
  if(!username)throw new Error("Instagram session needs attention on the computer");

  await page.goto(`https://www.instagram.com/${encodeURIComponent(username)}/`,{waitUntil:"domcontentloaded",timeout:60_000});
  await page.waitForTimeout(3_000);
  const firstResponsePromise=page.waitForResponse(response=>/\/api\/v1\/friendships\/\d+\/following\//.test(new URL(response.url()).pathname),{timeout:30_000});
  const followingLink=page.getByRole("link",{name:/following/i}).first();
  if(!await followingLink.count())throw new Error("Could not locate the authenticated account's Following control");
  await followingLink.click();
  const firstResponse=await firstResponsePromise;
  if(!firstResponse.ok())throw new Error(`Instagram initial following page failed with HTTP ${firstResponse.status()}`);
  const endpoint=new URL(firstResponse.url());
  const ownerMatch=endpoint.pathname.match(/^\/api\/v1\/friendships\/(\d+)\/following\/$/);
  if(!ownerMatch)throw new Error("Instagram following response did not contain the acting account ID");
  const requestHeaders=await firstResponse.request().allHeaders();
  const headers=Object.fromEntries(Object.entries(requestHeaders).filter(([key])=>allowedHeaderNames.has(key)));

  const grouped=new Map<string,{targetKey:string;displayName:string;handle:string;profileUrl:string;photoUrl?:string}>();
  const collect=(data:FollowingPage)=>{
    if(data.status!=="ok"||!Array.isArray(data.users))throw new Error("Instagram following response shape changed");
    for(const user of data.users){
      const id=user.pk??user.pk_id??user.id;
      if(!id||!/^\d+$/.test(id)||!user.username)continue;
      const photoHost=user.profile_pic_url&&/^https:\/\//.test(user.profile_pic_url)?new URL(user.profile_pic_url).hostname:"";
      const photoUrl=photoHost.endsWith("cdninstagram.com")||photoHost.endsWith("fbcdn.net")?user.profile_pic_url:undefined;
      grouped.set(id,{targetKey:`id:${id}`,displayName:user.full_name?.trim()||user.username,handle:user.username,profileUrl:`https://www.instagram.com/${encodeURIComponent(user.username)}/`,photoUrl});
    }
  };

  let data=await firstResponse.json() as FollowingPage;
  collect(data);
  while(data.has_more&&data.next_max_id&&grouped.size<limit){
    const nextUrl=new URL(endpoint);nextUrl.searchParams.set("max_id",data.next_max_id);
    const response:APIResponse=await retryingGet(context,nextUrl.toString(),headers);
    data=await response.json() as FollowingPage;collect(data);
  }
  const relationships=[...grouped.values()].slice(0,limit);
  const complete=!data.has_more&&relationships.length<limit;
  const snapshot={version:1,capturedAt:new Date().toISOString(),complete,account:{actingAccountKey:`instagram:id:${ownerMatch[1]}`,displayName:accountData.form_data?.first_name?.trim()||username},relationships};
  const filename=path.join(cacheDir,"instagram.json");writeFileSync(filename,JSON.stringify(snapshot,null,2),{mode:0o600});chmodSync(filename,0o600);
  const sessionFilename=path.join(sessionDir,"instagram.json");await context.storageState({path:sessionFilename});chmodSync(sessionFilename,0o600);
  console.log(`Verified the authenticated Instagram account and cached ${relationships.length} followed accounts (${complete?"complete":"partial"} scan).`);
  console.log(`Private local snapshot: ${filename}`);
}finally{await context.close();}
