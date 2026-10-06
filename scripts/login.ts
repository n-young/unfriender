import { mkdirSync } from "node:fs";
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
const context=await chromium.launchPersistentContext(profile,{headless:false});
await context.pages()[0]?.goto(urls[platform]);
await new Promise<void>(resolve=>context.on("close",()=>resolve()));
console.log(`Saved the local browser profile under ${profile}.`);
console.log("The real adapter remains disabled until read-only discovery and an explicit-target removal spike are verified.");
