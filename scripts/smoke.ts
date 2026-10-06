const origin=process.env.SMOKE_ORIGIN??"http://127.0.0.1:3000";
const response=await fetch(`${origin}/api/status`,{headers:process.env.TAILSCALE_USER_LOGIN?{"Tailscale-User-Login":process.env.TAILSCALE_USER_LOGIN}:{}});
if(!response.ok)throw new Error(`Smoke check failed: ${response.status} ${await response.text()}`);
const body=await response.json();
console.log(JSON.stringify({ok:true,origin,accounts:(body as any).accounts?.length,fakeMode:(body as any).fakeMode},null,2));
