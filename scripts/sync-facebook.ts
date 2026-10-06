import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root=path.resolve(import.meta.dirname,"..");
const dataDir=path.resolve(root,process.env.DATA_DIR??".data");
const profile=path.join(dataDir,"profiles","facebook");
const cacheDir=path.join(dataDir,"platform-cache");
const sessionDir=path.join(dataDir,"platform-sessions");
const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const limit=Math.max(10,Math.min(5_000,Number(process.env.FACEBOOK_SYNC_LIMIT??1_000)));
if(!existsSync(profile))throw new Error("Facebook profile is missing. Run: npm run login -- facebook");
mkdirSync(cacheDir,{recursive:true,mode:0o700});
mkdirSync(sessionDir,{recursive:true,mode:0o700});
const reserved=new Set(["afad","ajax","events","explore","friends","groups","help","legal","marketplace","messages","notifications","pages","privacy","reel","reels","settings","stories","watch"]);

const context=await chromium.launchPersistentContext(profile,{headless:process.env.HEADLESS!=="false",...(process.platform==="darwin"&&existsSync(macChrome)?{executablePath:macChrome}:{})});
try{
  const page=context.pages()[0]??await context.newPage();
  await page.goto("https://www.facebook.com/me/friends",{waitUntil:"domcontentloaded",timeout:60_000});await page.waitForTimeout(6_000);
  const current=new URL(page.url());
  if(current.pathname.includes("login")||current.pathname.includes("checkpoint")||await page.locator("input[name='email']").count())throw new Error(`Facebook session needs attention on the computer (${current.pathname})`);
  const owner=current.pathname.split("/").filter(Boolean)[0];if(!owner||owner==="me")throw new Error("Could not verify the acting Facebook profile URL");
  const grouped=new Map<string,{targetKey:string;profileUrl:string;displayName:string;handle?:string;photoUrl?:string}>();
  const collect=async()=>{
    const raw=await page.locator("[role='main'] a[href]").evaluateAll(items=>items.map(item=>{
      let scope:Element|null=item;let image=scope.querySelector("img") as HTMLImageElement|null;
      for(let depth=0;!image&&depth<4;depth++){scope=scope.parentElement;image=scope?.querySelector("img") as HTMLImageElement|null;}
      return {href:(item as HTMLAnchorElement).href,text:(item as HTMLElement).innerText??"",imageAlt:image?.getAttribute("alt")??"",imageSrc:image?.currentSrc||image?.src||""};
    }));
    for(const item of raw){
      const url=new URL(item.href);if(!url.hostname.endsWith("facebook.com"))continue;
      const first=url.pathname.split("/").filter(Boolean)[0];if(!first||first===owner||reserved.has(first))continue;
      let targetKey:string,profileUrl:string,handle:string|undefined;
      if(first==="profile.php"){
        const id=url.searchParams.get("id");if(!id||!/^\d+$/.test(id))continue;targetKey=`id:${id}`;profileUrl=`https://www.facebook.com/profile.php?id=${id}`;
      }else{targetKey=`vanity:${first}`;handle=first;profileUrl=`https://www.facebook.com/${first}`;}
      const candidates=[item.imageAlt,item.text.split("\n")[0]??""]
        .map(value=>value.trim().replace(/^(profile picture of|profile photo of|photo of)\s+/i,"").replace(/['’]s profile picture$/i,""))
        .filter(value=>value.length>=2&&value.length<=120&&!/^(add friend|friends|message|profile)$/i.test(value));
      const imageHost=/^https:\/\//.test(item.imageSrc)?new URL(item.imageSrc).hostname:"";
      const photoUrl=imageHost.endsWith("fbcdn.net")||imageHost.endsWith("fbsbx.com")?item.imageSrc:undefined;
      const displayName=candidates.sort((a,b)=>a.length-b.length)[0];
      if(displayName){
        const existing=grouped.get(targetKey);
        if(!existing)grouped.set(targetKey,{targetKey,profileUrl,displayName,handle,photoUrl});
        else if(!existing.photoUrl&&photoUrl)existing.photoUrl=photoUrl;
      }
    }
  };
  let stableRounds=0;let previousUnique=0;
  const maxRounds=Math.min(500,Math.max(60,Math.ceil(limit/5)*3));
  for(let round=0;round<maxRounds&&grouped.size<limit&&stableRounds<8;round++){
    await collect();stableRounds=grouped.size===previousUnique?stableRounds+1:0;previousUnique=grouped.size;
    const anchors=page.locator("[role='main'] a[href*='facebook.com/']");
    if(await anchors.count())await anchors.last().evaluate(element=>element.scrollIntoView({block:"end"}));
    await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await page.mouse.wheel(0,4_000);await page.waitForTimeout(1_500);
  }
  await collect();
  const relationships=[...grouped.values()].slice(0,limit);if(!relationships.length)throw new Error("Authenticated page loaded but no friend cards could be parsed; selectors need repair");
  const snapshot={version:1,capturedAt:new Date().toISOString(),complete:false,account:{actingAccountKey:`facebook:vanity:${owner}`,displayName:owner},relationships};
  const filename=path.join(cacheDir,"facebook.json");writeFileSync(filename,JSON.stringify(snapshot,null,2),{mode:0o600});chmodSync(filename,0o600);
  const sessionFilename=path.join(sessionDir,"facebook.json");await context.storageState({path:sessionFilename});chmodSync(sessionFilename,0o600);
  console.log(`Verified the authenticated Facebook account and cached ${relationships.length} friends (partial scan).`);console.log(`Private local snapshot: ${filename}`);
}finally{await context.close();}
