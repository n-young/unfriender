import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { chromium, type APIResponse } from "playwright";

const root=path.resolve(import.meta.dirname,"..");
const dataDir=path.resolve(root,process.env.DATA_DIR??".data");
const profile=path.join(dataDir,"profiles","linkedin");
const reportDir=path.join(dataDir,"adapter-spikes");
const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
if(!existsSync(profile))throw new Error("LinkedIn profile is missing. Run: npm run login -- linkedin");
mkdirSync(reportDir,{recursive:true,mode:0o700});

type Endpoint={method:string;status:number;path:string;queryKeys:string[];variableKeys?:string[];queryId?:string;schema?:unknown};
const endpoints:Endpoint[]=[];
const pending:Promise<void>[]=[];

function schema(value:unknown,depth=0):unknown{
  if(depth>6)return "…";
  if(value===null)return "null";
  if(Array.isArray(value))return value.length?{arrayLength:value.length,item:schema(value[0],depth+1)}:{arrayLength:0};
  if(typeof value!=="object")return typeof value;
  return Object.fromEntries(Object.entries(value as Record<string,unknown>).slice(0,80).map(([key,item])=>[
    key.startsWith("urn:")||key.length>120?"<dynamic-key>":key,
    schema(item,depth+1)
  ]));
}

async function inspectResponse(response:APIResponse){
  const url=new URL(response.url());
  if(!url.hostname.endsWith("linkedin.com")||!url.pathname.includes("/voyager/api/"))return;
  const entry:Endpoint={method:response.request().method(),status:response.status(),path:url.pathname,queryKeys:[...url.searchParams.keys()].sort()};
  const queryId=url.searchParams.get("queryId");
  if(queryId)entry.queryId=queryId;
  const variables=url.searchParams.get("variables");
  if(variables)entry.variableKeys=[...new Set([...variables.matchAll(/(?:^|[,(])([A-Za-z][A-Za-z0-9_]*):/g)].map(match=>match[1]!))].sort();
  if((response.headers()["content-type"]??"").includes("json")){
    try{
      const body=await response.json() as {data?:unknown;included?:unknown};
      entry.schema=schema({data:body.data,included:body.included});
    }catch{}
  }
  endpoints.push(entry);
}

const context=await chromium.launchPersistentContext(profile,{
  headless:process.env.HEADLESS!=="false",
  ...(process.platform==="darwin"&&existsSync(macChrome)?{executablePath:macChrome}:{})
});
context.on("response",response=>pending.push(inspectResponse(response)));
try{
  const page=context.pages()[0]??await context.newPage();
  await page.goto("https://www.linkedin.com/mynetwork/invite-connect/connections/",{waitUntil:"domcontentloaded",timeout:60_000});
  await page.waitForTimeout(5_000);
  if(new URL(page.url()).pathname.startsWith("/login")||page.url().includes("checkpoint")){
    throw new Error(`LinkedIn session needs attention on the computer (${new URL(page.url()).pathname})`);
  }
  await page.evaluate(()=>window.scrollTo(0,document.body.scrollHeight));
  await page.waitForTimeout(3_000);
  await Promise.allSettled(pending);
  const dom=await page.evaluate(()=>{
    const selectors=["a[href*='/in/']","li","main button","main [data-view-name]"];
    const counts=Object.fromEntries(selectors.map(selector=>[selector,document.querySelectorAll(selector).length]));
    const anchor=document.querySelector("main a[href*='/in/']");
    const structure:string[]=[];
    const structureAttributes:{tag:string;attributes:string[]}[]=[];
    for(let element=anchor; element&&structure.length<5; element=element.parentElement){
      structure.push(`${element.tagName.toLowerCase()}${[...element.classList].slice(0,4).map(name=>`.${name}`).join("")}`);
      structureAttributes.push({tag:element.tagName.toLowerCase(),attributes:[...element.attributes].map(attribute=>attribute.name).sort()});
    }
    const profileAnchorMetrics=[...document.querySelectorAll<HTMLAnchorElement>("main a[href*='/in/']")].slice(0,8).map(item=>{
      const container=item.closest("li")??item.parentElement?.parentElement?.parentElement;
      return {
        anchorTextLength:(item.innerText??"").trim().length,
        ariaLabelLength:(item.getAttribute("aria-label")??"").length,
        imageAltLength:(item.querySelector("img")?.getAttribute("alt")??"").length,
        containerTag:container?.tagName.toLowerCase()??null,
        containerTextLines:(container?.textContent??"").split("\n").map(line=>line.trim()).filter(Boolean).length
      };
    });
    return {counts,firstProfileAnchorStructure:structure,firstProfileAnchorAttributeNames:structureAttributes,profileAnchorMetrics};
  });
  const unique=new Map<string,Endpoint>();
  for(const entry of endpoints){
    const key=JSON.stringify([entry.method,entry.status,entry.path,entry.queryKeys,entry.queryId]);
    if(!unique.has(key))unique.set(key,entry);
  }
  const report={capturedAt:new Date().toISOString(),pagePath:new URL(page.url()).pathname,authenticated:true,dom,endpoints:[...unique.values()]};
  const filename=path.join(reportDir,"linkedin-readonly.json");
  writeFileSync(filename,JSON.stringify(report,null,2),{mode:0o600});
  chmodSync(filename,0o600);
  console.log(`Authenticated LinkedIn page loaded. Captured ${report.endpoints.length} unique read-only API shapes.`);
  console.log(`Sanitized report: ${filename}`);
}finally{
  await context.close();
}
