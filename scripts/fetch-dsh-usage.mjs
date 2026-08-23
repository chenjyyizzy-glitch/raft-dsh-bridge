// Fetch usage by turn from a DSH session via its web API.
// Usage: node fetch-dsh-usage.mjs <sessionId> [base]
const sid=process.argv[2]; const base=process.argv[3]??'http://127.0.0.1:3080';
if(!sid){console.error('session id required');process.exit(1)}
let beforeSeq=undefined; const usage=new Map(); let pages=0;
async function rpc(method,payload){const res=await fetch(`${base}/api/${method}`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:Math.random().toString(36).slice(2),method,payload})}); return (await res.json()).result}
while(true){
 const payload={sessionId:sid,maxMessages:20}; if(beforeSeq!==undefined) payload.beforeSeq=beforeSeq;
 const r=await rpc('session.history',payload); if(!r?.ok){console.error(r);process.exit(1)}
 const evs=r.value.events??[]; pages++;
 for(const e of evs){
  const ev=e.event; if(ev.type!=='assistant/message') continue;
  const t=ev.data?.turn; if(t==null||!ev.usage) continue;
  const u=usage.get(t)??{input:0,output:0,cacheRead:0,reasoning:0}; u.input+=ev.usage.inputTokens??0; u.output+=ev.usage.outputTokens??0; u.cacheRead+=ev.usage.cacheReadTokens??0; u.reasoning+=ev.usage.reasoningTokens??0; usage.set(t,u);
 }
 if(!r.value.hasMore){break}
 const min=Math.min(...evs.map(e=>e.event.seq)); beforeSeq=min;
 if(pages>20)break;
}
console.log(`session=${sid} pages=${pages}`);
for(const [t,u] of [...usage].sort((a,b)=>a[0]-b[0])) console.log(`turn ${t}: input=${u.input} output=${u.output} cacheRead=${u.cacheRead} reasoning=${u.reasoning}`);
