import type { Platform } from "@social-cleanup/shared";

export function assertPlatformPhotoUrl(platform:Platform,value:string){
  let url:URL;
  try{url=new URL(value);}catch{throw new Error("invalid profile photo URL");}
  const host=url.hostname.toLowerCase();
  const allowed=platform==="linkedin"
    ? host==="licdn.com"||host.endsWith(".licdn.com")
    : host==="fbcdn.net"||host.endsWith(".fbcdn.net")||host==="fbsbx.com"||host.endsWith(".fbsbx.com")||host==="cdninstagram.com"||host.endsWith(".cdninstagram.com");
  if(url.protocol!=="https:"||url.port||url.username||url.password||!allowed)throw new Error(`profile photo URL is outside the ${platform} CDN allowlist`);
  return url;
}

export async function fetchPlatformPhoto(platform:Platform,value:string){
  let current=assertPlatformPhotoUrl(platform,value);
  for(let redirects=0;redirects<=3;redirects++){
    const response=await fetch(current,{redirect:"manual",signal:AbortSignal.timeout(15_000),headers:{accept:"image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8"}});
    if(response.status>=300&&response.status<400){
      const location=response.headers.get("location");
      if(!location||redirects===3)throw new Error("profile photo redirect could not be resolved");
      current=assertPlatformPhotoUrl(platform,new URL(location,current).href);
      continue;
    }
    return response;
  }
  throw new Error("profile photo redirect limit exceeded");
}
