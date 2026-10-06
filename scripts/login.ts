import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { platforms, type Platform } from "@social-cleanup/shared";

const platform = process.argv[2] as Platform;
if (!platforms.includes(platform)) throw new Error(`Usage: npm run login -- ${platforms.join("|")}`);
const urls:Record<Platform,string>={linkedin:"https://www.linkedin.com/feed/",facebook:"https://www.facebook.com/",instagram:"https://www.instagram.com/"};
const dataDir=path.resolve(process.env.DATA_DIR??".data");
const profile=path.join(dataDir,"profiles",platform);
mkdirSync(profile,{recursive:true,mode:0o700});
console.log(`Opening a dedicated ${platform} profile. Complete login and MFA in the browser.`);
console.log("Close the browser when the account home page is visibly authenticated.");
const macChrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const executablePath=process.platform==="darwin"&&existsSync(macChrome)?macChrome:undefined;
let context;
try {
  context=await chromium.launchPersistentContext(profile,{headless:false,...(executablePath?{executablePath}:{})});
} catch (error) {
  if (error instanceof Error && error.message.includes("Executable doesn't exist")) {
    throw new Error("No compatible browser was found. Install Chromium once with: npx playwright install chromium",{cause:error});
  }
  throw error;
}
await context.pages()[0]?.goto(urls[platform]);
await new Promise<void>(resolve=>context.on("close",()=>resolve()));
console.log(`Saved the local browser profile under ${profile}.`);
console.log("The real adapter remains disabled until read-only discovery and an explicit-target removal spike are verified.");
