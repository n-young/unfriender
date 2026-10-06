import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type APIResponse } from "playwright";

const platform=process.argv[2] as "facebook"|"instagram";
if(!["facebook","instagram"].includes(platform))throw new Error("Usage: tsx scripts/spike-platform.ts facebook|instagram");
const root=path.resolve(import.meta.dirname,"..");
const dataDir=path.resolve(root,process.env.DATA_DIR??".data");
const profile=path.join(dataDir,"profiles",platform);
const reportDir=path.join(dataDir,"adapter-spikes");
const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const startUrls={facebook:"https://www.facebook.com/me/friends",instagram:"https://www.instagram.com/"} as const;
if(!existsSync(profile))throw new Error(`${platform} profile is missing. Run: npm run login -- ${platform}`);
mkdirSync(reportDir,{recursive:true,mode:0o700});

type Endpoint={method:string;status:number;path:string;queryKeys:string[];bodyKeys:string[];schema?:unknown};
const endpoints:Endpoint[]=[];const pending:Promise<void>[]=[];
function schema(value:unknown,depth=0):unknown{
  if(depth>6)return "…";if(value===null)return "null";
  if(Array.isArray(value))return value.length?{arrayLength:value.length,item:schema(value[0],depth+1)}:{arrayLength:0};
  if(typeof value!=="object")return typeof value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>).slice(0,80).map(([key,item])=>[
    key.startsWith("urn:")||key.length>120||/^\d{8,}$/.test(key)?"<dynamic-key>":key,schema(item,depth+1)
  ]));
}
function bodyKeys(response:APIResponse){
  const body=response.request().postData()??"";
  try{return Object.keys(Object.fromEntries(new URLSearchParams(body))).sort()}catch{return [];}
}
async function inspect(response:APIResponse){
  const url=new URL(response.url());
  const relevant=platform==="facebook"
    ? url.hostname.endsWith("facebook.com")&&(url.pathname.includes("graphql")||url.pathname.startsWith("/api/")||url.pathname.startsWith("/ajax/"))
    : url.hostname.endsWith("instagram.com")&&(url.pathname.includes("graphql")||url.pathname.startsWith("/api/"));
  if(!relevant)return;
  const entry:Endpoint={method:response.request().method(),status:response.status(),path:url.pathname,queryKeys:[...url.searchParams.keys()].sort(),bodyKeys:bodyKeys(response)};
  if((response.headers()["content-type"]??"").includes("json")){
    try{const body=await response.json() as {data?:unknown;included?:unknown;items?:unknown;users?:unknown};entry.schema=schema({data:body.data,included:body.included,items:body.items,users:body.users});}catch{}
  }
  endpoints.push(entry);
}

const context=await chromium.launchPersistentContext(profile,{headless:process.env.HEADLESS!=="false",...(process.platform==="darwin"&&existsSync(macChrome)?{executablePath:macChrome}:{})});
context.on("response",response=>pending.push(inspect(response)));
try{
  const page=context.pages()[0]??await context.newPage();
  await page.goto(startUrls[platform],{waitUntil:"domcontentloaded",timeout:60_000});
  await page.waitForTimeout(6_000);
  const current=new URL(page.url());
  if(current.pathname.includes("login")||current.pathname.includes("checkpoint")||current.pathname.includes("challenge"))throw new Error(`${platform} session needs attention on the computer (${current.pathname})`);
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));await page.waitForTimeout(3_000);await Promise.allSettled(pending);
  const dom=await page.evaluate(platformName=>{
    const selector=platformName==="facebook"?"main a[href*='facebook.com/']":"main a[href^='/']";
    const anchors=[...document.querySelectorAll<HTMLAnchorElement>(selector)];
    return {anchorCount:anchors.length,buttonCount:document.querySelectorAll("main button").length,
      anchorPathKinds:[...new Set(anchors.map(anchor=>{try{const parts=new URL(anchor.href).pathname.split("/").filter(Boolean);return parts[0]??"/"}catch{return "invalid"}}))].slice(0,40)};
  },platform);
  const unique=new Map<string,Endpoint>();for(const entry of endpoints){const key=JSON.stringify([entry.method,entry.status,entry.path,entry.queryKeys,entry.bodyKeys]);if(!unique.has(key))unique.set(key,entry);}
  const report={capturedAt:new Date().toISOString(),pagePath:current.pathname,authenticated:true,dom,endpoints:[...unique.values()]};
  const filename=path.join(reportDir,`${platform}-readonly.json`);writeFileSync(filename,JSON.stringify(report,null,2),{mode:0o600});chmodSync(filename,0o600);
  console.log(`Authenticated ${platform} page loaded. Captured ${report.endpoints.length} unique read-only API shapes.`);console.log(`Sanitized report: ${filename}`);
}finally{await context.close();}
