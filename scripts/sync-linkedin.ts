import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root=path.resolve(import.meta.dirname,"..");
const dataDir=path.resolve(root,process.env.DATA_DIR??".data");
const profile=path.join(dataDir,"profiles","linkedin");
const cacheDir=path.join(dataDir,"platform-cache");
const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const limit=Math.max(10,Math.min(500,Number(process.env.LINKEDIN_SYNC_LIMIT??50)));
if(!existsSync(profile))throw new Error("LinkedIn profile is missing. Run: npm run login -- linkedin");
mkdirSync(cacheDir,{recursive:true,mode:0o700});

let me: any;
const responseReads:Promise<void>[]=[];
const context=await chromium.launchPersistentContext(profile,{
  headless:process.env.HEADLESS!=="false",
  ...(process.platform==="darwin"&&existsSync(macChrome)?{executablePath:macChrome}:{})
});
context.on("response",response=>{
  if(new URL(response.url()).pathname==="/voyager/api/me"&&response.ok()){
    responseReads.push(response.json().then(body=>{me=body}).catch(()=>{}));
  }
});

try{
  const page=context.pages()[0]??await context.newPage();
  await page.goto("https://www.linkedin.com/mynetwork/invite-connect/connections/",{waitUntil:"domcontentloaded",timeout:60_000});
  await page.waitForTimeout(5_000);
  if(new URL(page.url()).pathname.startsWith("/login")||page.url().includes("checkpoint")){
    throw new Error(`LinkedIn session needs attention on the computer (${new URL(page.url()).pathname})`);
  }
  await Promise.allSettled(responseReads);
  const miniProfile=me?.included?.find((item:any)=>typeof item?.publicIdentifier==="string");
  const plainId=me?.data?.plainId;
  if(!plainId||!miniProfile?.publicIdentifier)throw new Error("Could not verify the acting LinkedIn account from /voyager/api/me");

  let stableRounds=0;
  let previousCount=0;
  for(let round=0;round<30&&previousCount<limit&&stableRounds<3;round++){
    const anchors=page.locator("main a[href*='/in/']");
    const count=await anchors.count();
    stableRounds=count===previousCount?stableRounds+1:0;
    previousCount=count;
    const more=page.getByRole("button",{name:/show more/i}).first();
    if(await more.isVisible().catch(()=>false))await more.click().catch(()=>{});
    else if(count)await anchors.last().evaluate(element=>element.scrollIntoView({block:"center"}));
    else await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
    await page.waitForTimeout(1_000);
  }

  const raw=await page.locator("main a[href*='/in/']").evaluateAll(items=>items.map(item=>({
    href:(item as HTMLAnchorElement).href,
    text:(item as HTMLElement).innerText??"",
    imageAlt:item.querySelector("img")?.getAttribute("alt")??""
  })));
  const grouped=new Map<string,{profileUrl:string;displayName:string;handle:string}>();
  for(const item of raw){
    const url=new URL(item.href);
    const match=url.pathname.match(/^\/in\/([^/]+)/);
    if(!match||match[1]===miniProfile.publicIdentifier)continue;
    const profileUrl=`https://www.linkedin.com/in/${match[1]}/`;
    const candidates=[item.imageAlt,item.text.split("\n")[0]??""]
      .map(value=>value.trim().replace(/^(profile photo of|photo of)\s+/i,"").replace(/\s*[•·]\s*(1st|2nd|3rd).*$/i,""))
      .filter(value=>value.length>=2&&value.length<=120&&!/^(view|profile)$/i.test(value));
    const displayName=candidates.sort((a,b)=>a.length-b.length)[0];
    if(displayName&&!grouped.has(profileUrl))grouped.set(profileUrl,{profileUrl,displayName,handle:match[1]});
  }
  const relationships=[...grouped.values()].slice(0,limit).map(row=>({targetKey:`vanity:${row.handle}`,displayName:row.displayName,handle:row.handle,profileUrl:row.profileUrl}));
  if(!relationships.length)throw new Error("Authenticated page loaded but no connection cards could be parsed; selectors need repair");
  const snapshot={
    version:1,capturedAt:new Date().toISOString(),complete:false,
    account:{actingAccountKey:`linkedin:${plainId}`,displayName:`${miniProfile.firstName??""} ${miniProfile.lastName??""}`.trim(),publicIdentifier:miniProfile.publicIdentifier},
    relationships
  };
  const filename=path.join(cacheDir,"linkedin.json");
  writeFileSync(filename,JSON.stringify(snapshot,null,2),{mode:0o600});
  chmodSync(filename,0o600);
  console.log(`Verified the authenticated LinkedIn account and cached ${relationships.length} connections (partial scan).`);
  console.log(`Private local snapshot: ${filename}`);
}finally{
  await context.close();
}
