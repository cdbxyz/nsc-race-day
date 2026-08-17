/* render-icons.mjs — icon.svg -> the PNGs iOS and Android insist on.
 *
 * iOS ignores SVG for apple-touch-icon entirely: without a real PNG the home
 * screen shows a grey page thumbnail, which is the first thing an OOD sees
 * and the last impression you want on a beach.
 *
 * Rendered from icon.svg through headless Chrome rather than committed by
 * hand, so the PNGs cannot drift from the source. Run `npm run icons` after
 * changing icon.svg, then `npm run stamp`.
 */
import { spawn } from "node:child_process";
import { rm, writeFile, readFile } from "node:fs/promises";
const CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT=9350, PROFILE="/tmp/nsc-png";
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms));
const REPO=new URL("..", import.meta.url).pathname;
const svg=await readFile(`${REPO}/icon.svg`,"utf8");
await rm(PROFILE,{recursive:true,force:true});
const chrome=spawn(CHROME,["--headless=new","--disable-gpu","--no-first-run",
  `--remote-debugging-port=${PORT}`,`--user-data-dir=${PROFILE}`,"about:blank"],{stdio:"ignore"});
let u; for(let i=0;i<60;i++){try{const l=await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r=>r.json());
  const p=l.find(t=>t.type==="page"); if(p){u=p.webSocketDebuggerUrl;break}}catch{} await sleep(250);}
const ws=new WebSocket(u); await new Promise(r=>ws.onopen=r);
let id=1; const pend=new Map();
ws.onmessage=(e)=>{const m=JSON.parse(e.data); if(m.id&&pend.has(m.id)){const{res,rej}=pend.get(m.id);
  pend.delete(m.id); m.error?rej(new Error(JSON.stringify(m.error))):res(m.result);}};
const send=(m,p={})=>new Promise((res,rej)=>{const i=id++;pend.set(i,{res,rej});ws.send(JSON.stringify({id:i,method:m,params:p}));});
await send("Page.enable");
for (const size of [180, 192, 512]) {
  await send("Emulation.setDeviceMetricsOverride",{width:size,height:size,deviceScaleFactor:1,mobile:false});
  const html=`<!doctype html><meta charset="utf-8">
    <style>html,body{margin:0;padding:0;width:${size}px;height:${size}px;overflow:hidden}
    svg{display:block;width:${size}px;height:${size}px}</style>${svg}`;
  await send("Page.navigate",{url:"data:text/html;charset=utf-8,"+encodeURIComponent(html)});
  await sleep(900);
  const {data}=await send("Page.captureScreenshot",{format:"png",captureBeyondViewport:false});
  const name = size===180 ? "apple-touch-icon.png" : `icon-${size}.png`;
  await writeFile(`${REPO}/img/${name}`, Buffer.from(data,"base64"));
  console.log("wrote", name);
}
ws.close();chrome.kill();process.exit(0);
