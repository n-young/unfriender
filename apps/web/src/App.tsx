import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DeckCard, Platform } from "@social-cleanup/shared";

type Account = { platform:Platform; connectionState:string; scanState:string; lastSyncAt?:string };
type Removal = {id:number;decisionId:number;batchId?:number;platform:Platform;targetKey:string;displayName:string;handle?:string;profileUrl:string;state:string;executeAfterMs?:number;result?:string;error?:string};
const labels:Record<Platform,string>={linkedin:"LinkedIn",facebook:"Facebook",instagram:"Instagram"};

async function api<T>(url:string,init?:RequestInit):Promise<T>{
  const response=await fetch(url,{...init,headers:{...(init?.body?{"content-type":"application/json"}:{}),"x-social-cleanup":"1",...init?.headers}});
  const body=await response.json().catch(()=>({error:response.statusText}));
  if(!response.ok)throw new Error(body.error??"Request failed");
  return body;
}

export function App(){
  const [cards,setCards]=useState<DeckCard[]>([]),[accounts,setAccounts]=useState<Account[]>([]),[removals,setRemovals]=useState<Removal[]>([]);
  const [adapterReady,setAdapterReady]=useState<Record<Platform,boolean>>({linkedin:false,facebook:false,instagram:false});
  const [online,setOnline]=useState(true),[error,setError]=useState(""),[drag,setDrag]=useState(0),[busy,setBusy]=useState(false);
  const startX=useRef<number|null>(null); const card=cards[0];
  const drafts=useMemo(()=>removals.filter(r=>r.state==="draft"),[removals]);
  const active=useMemo(()=>removals.filter(r=>["scheduled","ready","executing","paused","unknown"].includes(r.state)),[removals]);
  const visibleRemovals=useMemo(()=>removals.filter(r=>["draft","scheduled","ready","executing","paused","unknown"].includes(r.state)),[removals]);
  const canApply=drafts.length>0&&drafts.every(removal=>adapterReady[removal.platform]);

  const refresh=useCallback(async()=>{try{const [s,d,r]=await Promise.all([api<any>("/api/status"),api<any>("/api/deck?limit=50"),api<any>("/api/removals")]);setAccounts(s.accounts);setAdapterReady(Object.fromEntries(Object.entries(s.adapters??{}).map(([platform,value])=>[platform,Boolean((value as any).verified)])) as Record<Platform,boolean>);setCards(d.cards);setRemovals(r.removals);setOnline(true);setError("")}catch(e){setOnline(false);setError(e instanceof Error?e.message:String(e))}},[]);
  useEffect(()=>{void refresh();const id=setInterval(()=>void refresh(),active.length?1000:5000);return()=>clearInterval(id)},[refresh,active.length]);

  async function decide(kind:"keep"|"remove"|"skip"){
    if(!card||!online||busy)return;setBusy(true);
    try{await api("/api/decisions",{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),connectionId:card.id,version:card.version,kind})});await refresh()}catch(e){setError(e instanceof Error?e.message:String(e));await refresh()}finally{setBusy(false);setDrag(0)}
  }
  async function undo(){setBusy(true);try{await api("/api/undo",{method:"POST",body:"{}"});await refresh()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  async function apply(){setBusy(true);try{await api("/api/batches",{method:"POST",body:JSON.stringify({operationId:crypto.randomUUID(),decisionIds:drafts.map(r=>r.decisionId)})});await refresh()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}
  async function accountAction(platform:Platform,action:"connect"|"sync"|"disconnect"){setBusy(true);try{await api(`/api/accounts/${platform}/${action}`,{method:"POST",body:"{}"});if(action==="connect")await api(`/api/accounts/${platform}/sync`,{method:"POST",body:"{}"});await refresh()}catch(e){setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}}

  function release(){if(drag>90)void decide("keep");else if(drag< -90)void decide("remove");else setDrag(0);startX.current=null}
  return <main>
    <header><div><span className="eyebrow">PRIVATE · LOCAL</span><h1>Social Cleanup</h1></div></header>
    {!online&&<div className="offline">Computer or Tailscale is unreachable. Cards are read-only.</div>}
    {error&&<button className="error" onClick={()=>setError("")}>{error} <span>×</span></button>}
    <section className="accounts" aria-label="Accounts">{accounts.map(a=><div className="account" key={a.platform}><span className={`dot ${a.connectionState}`}/><b>{labels[a.platform]}</b><small>{a.connectionState} · {adapterReady[a.platform]?"removal ready":"read-only"}</small><div>{a.connectionState==="connected"?<><button disabled={busy} onClick={()=>void accountAction(a.platform,"sync")}>Sync</button><button disabled={busy} onClick={()=>void accountAction(a.platform,"disconnect")}>Disconnect</button></>:<button disabled={busy} onClick={()=>void accountAction(a.platform,"connect")}>Connect</button>}</div></div>)}</section>
    <section className="deck" aria-live="polite">
      {cards[1]&&<div className="card behind"/>}
      {card?<article className="card" style={{transform:`translateX(${drag}px) rotate(${drag/25}deg)`}} onPointerDown={e=>{startX.current=e.clientX;e.currentTarget.setPointerCapture(e.pointerId)}} onPointerMove={e=>{if(startX.current!==null)setDrag(e.clientX-startX.current)}} onPointerUp={release} onPointerCancel={release}>
        <div className={`stamp keep ${drag>45?"show":""}`}>KEEP</div><div className={`stamp remove ${drag< -45?"show":""}`}>REMOVE</div>
        <div className={`avatar ${card.platform}`} style={{position:"relative"}}><span>{card.displayName.split(/\s+/).slice(0,2).map(s=>s[0]).join("")}</span>{card.photoUrl&&<img src={card.photoUrl} alt="" referrerPolicy="no-referrer" style={{position:"absolute",inset:0}} onError={event=>event.currentTarget.remove()}/>}</div>
        <span className={`badge ${card.platform}`}>{labels[card.platform]}</span><h2>{card.displayName}</h2>{card.handle&&<p>@{card.handle}</p>}
        <a href={card.profileUrl} target="_blank" rel="noreferrer" onPointerDown={e=>e.stopPropagation()}>View profile ↗</a>
      </article>:<div className="empty"><div>✓</div><h2>You’re caught up</h2><p>Sync an account to look for more connections.</p></div>}
    </section>
    <nav className="actions"><button className="removeButton" disabled={!card||busy||!online} onClick={()=>void decide("remove")} aria-label="Stage removal">×</button><div className="secondaryActions" style={{display:"flex",alignItems:"center",gap:8}}><button className="skipButton" disabled={!card||busy||!online} onClick={()=>void decide("skip")}>Skip</button><button className="undo skipButton" disabled={busy||!online} onClick={()=>void undo()}>↶ Undo</button></div><button className="keepButton" disabled={!card||busy||!online} onClick={()=>void decide("keep")} aria-label="Keep">♥</button></nav>
    <section className="tray"><div><span>Staged removals</span><strong>{drafts.length}</strong></div><button disabled={!canApply||busy||!online} onClick={()=>void apply()}>{drafts.length&&!canApply?"Removal setup pending":`Apply ${drafts.length||""} removals`}</button></section>
    {visibleRemovals.length>0&&<section className="pending"><h2>Staged & pending</h2>{visibleRemovals.map(r=><div className="pendingRow" key={r.id}><span className={`badge ${r.platform}`}>{labels[r.platform]}</span><span>{r.displayName}{r.handle&&<small> @{r.handle}</small>}</span><b>{r.state}</b>{r.state==="paused"&&r.batchId&&adapterReady[r.platform]?<button onClick={()=>void api(`/api/batches/${r.batchId}/resume`,{method:"POST",body:"{}"}).then(refresh)}>Resume</button>:["draft","scheduled","ready"].includes(r.state)?<button onClick={()=>void api(`/api/removals/${r.id}/cancel`,{method:"POST",body:"{}"}).then(refresh)}>Cancel</button>:null}{r.error&&<small>{r.error}</small>}</div>)}</section>}
  </main>
}
