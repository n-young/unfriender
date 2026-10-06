import { chmodSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const platform=process.argv[2] as "linkedin"|"facebook"|"instagram";
if(!["linkedin","facebook","instagram"].includes(platform))throw new Error("Usage: tsx scripts/export-session.ts linkedin|facebook|instagram");
const root=path.resolve(import.meta.dirname,"..");
const dataDir=path.resolve(root,process.env.DATA_DIR??".data");
const profile=path.join(dataDir,"profiles",platform);
const sessionDir=path.join(dataDir,"platform-sessions");
const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const verificationUrls={linkedin:"https://www.linkedin.com/feed/",facebook:"https://www.facebook.com/me/friends",instagram:"https://www.instagram.com/accounts/edit/"} as const;
if(!existsSync(profile))throw new Error(`${platform} profile is missing. Run: npm run login -- ${platform}`);
mkdirSync(sessionDir,{recursive:true,mode:0o700});

const context=await chromium.launchPersistentContext(profile,{headless:process.env.HEADLESS!=="false",...(process.platform==="darwin"&&existsSync(macChrome)?{executablePath:macChrome}:{})});
try{
  const page=context.pages()[0]??await context.newPage();
  await page.goto(verificationUrls[platform],{waitUntil:"domcontentloaded",timeout:60_000});await page.waitForTimeout(3_000);
  const current=new URL(page.url());
  const loginVisible=await page.locator("input[name='username'],input[name='email'],form[action*='login']").count()>0;
  if(current.pathname.includes("login")||current.pathname.includes("checkpoint")||current.pathname.includes("challenge")||loginVisible)throw new Error(`${platform} session needs attention on the computer (${current.pathname})`);
  const filename=path.join(sessionDir,`${platform}.json`);await context.storageState({path:filename});chmodSync(filename,0o600);
  console.log(`Verified and exported the private local ${platform} browser session.`);
}finally{await context.close();}
