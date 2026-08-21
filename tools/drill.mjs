/* drill.mjs — the automated half of DRILL.md.
 *
 * Drives a real browser over the DevTools protocol: installs the service
 * worker, cuts the network at the OS level rather than faking a flag, runs a
 * complete two-race day offline, kills the app mid-day, and brings the
 * network back.
 *
 * It exists so DRILL.md documents something that has actually happened rather
 * than something that ought to work. It has already earned its keep once: it
 * found that wind recorded before the gun was reverted by arming the sequence,
 * with every unit test passing throughout.
 *
 * Usage:
 *   python3 -m http.server 8000
 *   node tools/drill.mjs http://127.0.0.1:8000/
 *
 * Requires Google Chrome at the path below. Part B of DRILL.md — everything
 * about iOS, installation and being outdoors — cannot be automated and is not
 * attempted here.
 */
import { spawn } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT=9348, PROFILE="/tmp/nsc-drill", BASE=process.argv[2];
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
await rm(PROFILE,{recursive:true,force:true});
const chrome=spawn(CHROME,["--headless=new","--disable-gpu","--no-first-run","--no-default-browser-check",
  `--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,"--window-size=390,844","about:blank"],{stdio:"ignore"});
let u; for(let i=0;i<60;i++){try{const l=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
  const p=l.find(t=>t.type==="page"); if(p){u=p.webSocketDebuggerUrl;break}}catch{} await sleep(250);}
const ws=new WebSocket(u); await new Promise(r=>ws.onopen=r);
let id=1; const pend=new Map(); const errors=[];
ws.onmessage=(e)=>{const m=JSON.parse(e.data);
  if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);pend.delete(m.id);
    m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);return;}
  if(m.method==="Runtime.exceptionThrown")errors.push("EXC "+(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text).split("\n")[0]);
  if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="error")errors.push("ERR "+m.params.args.map(a=>a.value??a.description).join(" ").slice(0,160));};
const send=(m,p={})=>new Promise((res,rej)=>{const i=id++;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
const ev=async(x)=>{const r=await send("Runtime.evaluate",{expression:x,awaitPromise:true,returnByValue:true});
  if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text);return r.result.value;};
const M=(n)=>`import("${BASE}js/${n}.js")`;
const step=[]; const note=(k,v)=>{step.push([k,v]); console.log(`  ${k}: ${JSON.stringify(v)}`);};
async function waitFor(x,l,t=100){for(let i=0;i<t;i++){try{if(await ev(x))return true}catch{} await sleep(250);}
  console.error("TIMEOUT:",l,errors.join("\n"));throw new Error("timeout: "+l);}
const offline=(v)=>send("Network.emulateNetworkConditions",{offline:v,latency:0,downloadThroughput:-1,uploadThroughput:-1});

await send("Runtime.enable"); await send("Page.enable"); await send("Network.enable");
await send("Emulation.setDeviceMetricsOverride",{width:390,height:844,deviceScaleFactor:2,mobile:true});

console.log("\n== 1. Cold start online, then install-equivalent cache ==");

/* Start from an empty database, cleared BEFORE the app boots.
   Clearing it from under a running app is what a drill must not do: the app
   is mid-write on boot (resume check, reference pull), and tearing those
   transactions up logs "transaction failed" — a fault of the probe that
   looks exactly like a fault of the app. Deleting it on a bare page of the
   same origin, with nothing else holding a connection, is deterministic. */
await send("Page.navigate",{url:BASE+"?drill-reset"}); await sleep(1200);
await ev(`new Promise((resolve)=>{
  const req = indexedDB.deleteDatabase("nsc-race-day");
  req.onsuccess = req.onerror = req.onblocked = () => resolve(true);
})`);

await send("Page.navigate",{url:BASE}); await sleep(4000);
await ev(`document.getElementById("pin-dialog")?.close()`);
note("serviceWorkerActive", await ev(`!!navigator.serviceWorker.controller`));

/* Wait for the worker to finish activating before counting. Reading the
   cache mid-install reports a number that is simply wrong — it once said 47
   of 60 and sent me looking for a precache failure that did not exist. */
await waitFor(`navigator.serviceWorker.ready.then(r=>r.active?.state==="activated")`,"sw activated");
await sleep(1500);
note("shellPrecached", await ev(`(async()=>{
  const keys=await caches.keys();
  const c=await caches.open(keys[0]);
  const cached=new Set((await c.keys()).map(r=>new URL(r.url).pathname));
  const sw=await fetch("sw.js").then(r=>r.text());
  const shell=[...sw.matchAll(/^\\s*"(\\.\\/[^"]*)"/gm)].map(m=>m[1]);
  const missing=shell.filter(p=>!cached.has(new URL(p,location.href).pathname));
  return {of:shell.length, missing};})()`));

console.log("\n== 2. Go offline and cold-start from cache ==");
await offline(true);
await send("Page.navigate",{url:BASE}); await sleep(4000);
await ev(`document.getElementById("pin-dialog")?.close()`);
note("appRenderedOffline", await ev(`!!document.querySelector(".page:not([hidden])")`));
note("fontsLoaded", await ev(`document.fonts.ready.then(()=>document.fonts.size>0)`));
note("logoDrawn", await ev(`(()=>{const i=document.getElementById("mast-logo");
  return i.complete && i.naturalWidth>0;})()`));

console.log("\n== 3. Set up a two-race day, entirely offline ==");
await ev(`location.hash="#/setup"`); await sleep(900);
await ev(`(()=>{const set=(label,val)=>{const f=[...document.querySelectorAll("#page-setup .field")]
    .find(d=>d.querySelector("label")?.textContent===label);
  const i=f.querySelector("input"); i.value=val; i.dispatchEvent(new Event("input",{bubbles:true}));};
  set("Officer of the Day","Chris Darcy-Burt"); set("Rescue Officer 1 (RO1)","Gareth Lloyd");
  set("Rescue Officer 2 (RO2)","Sioned Wyn"); set("Races planned","2");})()`);
await sleep(400);
note("phoneNamed", await ev(`[...document.querySelectorAll("#page-setup .field")]
  .find(d=>d.querySelector("label")?.textContent==="This phone")?.querySelector("input")?.value`));
await ev(`[...document.querySelectorAll("#page-setup button")].find(b=>b.textContent==="Start race day").click()`);
await waitFor(`location.hash==="#/signon"`,"signon");
note("racesCreated", await ev(`(async()=>{const rd=await ${M("raceday")};
  const d=await rd.openRaceDay(); return (await rd.racesForDay(d.id)).length;})()`));

console.log("\n== 4. Sign six boats on, offline ==");
await ev(`(async()=>{const reg=await ${M("registers")}, rd=await ${M("raceday")};
  const fast=await reg.createClass({name:"RS Aero 7",basePy:1065,crewSize:1});
  const slow=await reg.createClass({name:"Wayfarer",basePy:1101,crewSize:2});
  const d=await rd.openRaceDay(); const races=await rd.racesForDay(d.id);
  const ctx=await rd.handicapContext(2026);
  const people=[["Hamish Fowler",fast],["Hannah Prichard",fast],["Gareth Lloyd",fast],
                ["Sioned Wyn",slow],["Rhys Owen",slow],["Bethan Rowlands",slow]];
  let i=0;
  for(const [n,k] of people){ i++; const h=await reg.createMember({name:n});
    await rd.addEntry({race:races[0],klass:k,helmId:h.id,sailNo:String(1000+i),context:ctx}); }})()`);
await ev(`location.hash="#/home"`); await sleep(300); await ev(`location.hash="#/signon"`); await sleep(1200);
note("signedOn", await ev(`(async()=>{const rd=await ${M("raceday")};
  const d=await rd.openRaceDay(); const r=await rd.currentRace(d.id);
  return (await rd.entriesForRace(r.id)).length;})()`));
note("outboxGrowingOffline", await ev(`${M("db")}.then(m=>m.countOutbox())`));
note("combinationsSelfMaintained", await ev(`(async()=>{const reg=await ${M("registers")};
  const c=await reg.listCombinations();
  return {rows:c.length, withSailNo:c.filter(x=>x.default_sail_no).length};})()`));

console.log("\n== 5. Checklist, sequence and race 1 on the 60x clock ==");
await ev(`${M("devclock")}.then(m=>m.setSequenceSpeed(60))`);
await ev(`location.hash="#/sequence"`);
await waitFor(`!!document.querySelector("#page-sequence .bigstart")`,"arm");
await ev(`[...document.querySelectorAll("#page-sequence .compassbtn")].find(b=>b.textContent==="SW").click()`);
await sleep(300);
await ev(`[...document.querySelectorAll("#page-sequence .forcebtn")]
  .find(b=>b.textContent.startsWith("F4")).click()`);
await sleep(400);
note("windRecordedBeforeGun", await ev(`(async()=>{const rd=await ${M("raceday")};
  const d=await rd.openRaceDay(); const r=await rd.currentRace(d.id);
  return {dir:r.wind_direction, force:r.wind_force};})()`));
note("prestartSaysNothingStarted", await ev(`!!document.querySelector("#page-sequence .prestart")`));
await ev(`document.querySelector("#page-sequence .bigstart").click()`);
await waitFor(`location.hash==="#/live"`,"live",80);
note("sequenceRanOffline", true);
note("dayBrandedTestData", await ev(`(async()=>{const rd=await ${M("raceday")};
  return (await rd.openRaceDay()).is_test_data;})()`));
await ev(`(async()=>{const rd=await ${M("raceday")}, lg=await ${M("raceevents")};
  const d=await rd.openRaceDay(); const r=await rd.currentRace(d.id);
  const es=await rd.entriesForRace(r.id);
  for(const e of es){ const laps=(await rd.entriesForRace(r.id)).length;
    for(let l=0;l<2;l++){ await lg.recordLap(r.id,e.id); }
    await lg.recordFinish(r.id,e.id); }
  await lg.endRace(r.id);})()`);
await ev(`location.hash="#/home"`); await sleep(300); await ev(`location.hash="#/live"`); await sleep(1200);
note("race1Ended", await ev(`(async()=>{const rd=await ${M("raceday")}, lg=await ${M("raceevents")};
  const d=await rd.openRaceDay(); const r=await rd.currentRace(d.id);
  return (await lg.eventsForRace(r.id)).some(e=>e.type==="race_ended");})()`));

console.log("\n== 6. Results and publish, offline ==");
await ev(`location.hash="#/results"`);
await waitFor(`!!document.querySelector("#page-results .cards")`,"results");
note("scored", await ev(`document.querySelectorAll("#page-results .card:not(.out)").length`));
note("windOnSheet", await ev(`/SW\\s*F4/.test(document.querySelector("#page-results").textContent)`));
note("publishAvailable", await ev(`(()=>{const b=[...document.querySelectorAll("#page-results button")]
  .find(x=>x.textContent==="Publish results"); return b? !b.disabled : null;})()`));
await ev(`[...document.querySelectorAll("#page-results button")].find(x=>x.textContent==="Publish results").click()`);
await sleep(1800);
note("race1Published", await ev(`(async()=>{const rd=await ${M("raceday")}, dbm=await ${M("db")};
  const d=await rd.openRaceDay(); const rs=await rd.racesForDay(d.id); return rs[0].status;})()`));

console.log("\n== 7. Race 2, still offline ==");
await ev(`location.hash="#/signon"`); await sleep(1200);
note("race2Current", await ev(`(async()=>{const rd=await ${M("raceday")};
  const d=await rd.openRaceDay(); const r=await rd.currentRace(d.id); return r.number;})()`));
note("carryForwardOffered", await ev(`document.querySelector("#page-signon")?.textContent.includes("Carried forward")`));
await ev(`(async()=>{const rd=await ${M("raceday")}, lg=await ${M("raceevents")};
  const d=await rd.openRaceDay(); const r=await rd.currentRace(d.id);
  const ctx=await rd.handicapContext(2026);
  const cands=await rd.carryForwardCandidates(r,ctx);
  for(const c of cands) await rd.addEntry({race:r,klass:c.klass,helmId:c.helmId,crewId:c.crewId,sailNo:c.sailNo,context:ctx});
  await lg.startSequence(r.id);
  const gun=Date.now();
  await rd.setRaceStatusIfEarlier(r,"racing",{start_at:new Date(gun).toISOString(),
    sequence_start_at:new Date(gun-10000).toISOString()});
  const es=await rd.entriesForRace(r.id);
  for(const e of es){ for(let l=0;l<2;l++) await lg.recordLap(r.id,e.id); await lg.recordFinish(r.id,e.id); }
  await lg.endRace(r.id);})()`);
note("race2Entries", await ev(`(async()=>{const rd=await ${M("raceday")};
  const d=await rd.openRaceDay(); const r=await rd.currentRace(d.id);
  return (await rd.entriesForRace(r.id)).length;})()`));

console.log("\n== 8. Kill the app mid-day and reload — nothing lost ==");
const before=await ev(`${M("db")}.then(m=>m.countOutbox())`);
await send("Page.navigate",{url:BASE}); await sleep(4000);
await ev(`document.getElementById("pin-dialog")?.close()`);
note("outboxSurvivedReload", {before, after: await ev(`${M("db")}.then(m=>m.countOutbox())`)});
note("resumeBannerShown", await ev(`!document.getElementById("resume-slot").hidden`));
note("speedResetTo1x", await ev(`${M("devclock")}.then(m=>m.sequenceSpeed())`));

console.log("\n== 9. Stand down offline: hard warning about unsynced rows ==");
await ev(`location.hash="#/standdown"`); await sleep(1500);
note("standdownWarnsUnsynced", await ev(`(()=>{const t=document.querySelector("#page-standdown")?.textContent||"";
  return /not reached the club database/.test(t);})()`));
note("tallyBlocksIfBoatsOut", await ev(`document.querySelector("#page-standdown .whydisabled")?.textContent ?? "no block"`));

console.log("\n== 10. Back online: the whole day syncs ==");
await offline(false);
await sleep(1500);
note("pendingBeforeFlush", await ev(`${M("db")}.then(m=>m.countOutbox())`));
note("syncNeedsPin", await ev(`(async()=>{const s=await ${M("sync")}; await s.sync.flush();
  return s.sync.status.needsAuth;})()`));
note("nothingDroppedWithoutPin", await ev(`${M("db")}.then(m=>m.countOutbox())`));
note("authBarVisible", await ev(`!document.getElementById("auth-bar").hidden`));

console.log("\n--- console errors ---\n"+(errors.join("\n")||"(none)"));
ws.close();chrome.kill();process.exit(0);
