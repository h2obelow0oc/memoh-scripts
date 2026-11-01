import fs from 'node:fs'
const c = JSON.parse(fs.readFileSync('/data/zcode.json','utf8'))
const A = c.app_version || '3.14.3', O = 'https://zcode.z.ai'
const H = (x={}) => ({'User-Agent':`ZCode/${A}`,'HTTP-Referer':O,'X-ZCode-App-Version':A,
 'X-Release-Channel':'stable','X-Client-Language':'zh-CN','X-Client-Timezone':'Asia/Shanghai',
 'X-Device-Mid':c.device_mid,'X-Platform':'win32','X-Os-Category':'windows','anthropic-version':'2023-06-01',
 Authorization:`Bearer ${c.jwt}`, ...x})

// 已知通道
const KNOWN = '/api/v1/zcode-plan/billing/preview'
// 哨兵：这些端点现在 404。某天变 200 = 上游新增了发放通道
const SENTINELS = [
  '/api/v1/zcode-plan/billing/gift',
  '/api/v1/zcode-plan/gift',
  '/api/v1/zcode-plan/billing/plans',
  '/api/v1/zcode-plan/billing/welcome',
  '/api/v1/zcode-plan/billing/reward',
  '/api/v1/zcode-plan/activities',
  '/api/v1/zcode-plan/banner',
  '/api/v1/client/banners',
]
const LOG = '/data/zcode-watch.log'
const EVERY = Number(process.env.EVERY_MS || 300000)   // 默认 5 分钟
const MAX   = Number(process.env.MAX_MS || 259200000)  // 默认 3 天
const t0 = Date.now()

function stamp(){ return new Date().toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}) }
function log(s){ const line=`[${stamp()}] ${s}`; console.log(line); fs.appendFileSync(LOG, line+'\n') }

log(`start watch  every=${EVERY/1000}s  max=${MAX/3600000}h  log=${LOG}`)

async function activation(){
  for (const e of ['app_launch','app_daily_active']){
    try{ await fetch(`${O}/api/v1/event/report`,{method:'POST',headers:H({'Content-Type':'application/json'}),
      body:JSON.stringify({event:e,device_mid:c.device_mid,platform:'win32',app_version:A}),
      signal:AbortSignal.timeout(15000)}) }catch{}
  }
}
async function preview(){
  try{
    const r=await fetch(`${O}${KNOWN}?app_version=${A}&platform=win32`,
      {headers:H(),signal:AbortSignal.timeout(20000)})
    if(!r.ok) return {status:r.status, plans:[]}
    const j=await r.json().catch(()=>({}))
    const raw=Array.isArray(j?.data?.plans)?j.data.plans:[]
    return {status:r.status, plans:raw.map(p=>({
      id:p.plan_id, name:p.name, pri:Number(p.priority)||0,
      units:(p.entitlements&&p.entitlements[0]&&p.entitlements[0].grant_units),
      unit:(p.entitlements&&p.entitlements[0]&&p.entitlements[0].unit_type),
      period:(p.entitlements&&p.entitlements[0]&&p.entitlements[0].period),
    }))}
  }catch(e){ return {status:'ERR', plans:[], err:e.message} }
}
async function sentinels(){
  const hits=[]
  for(const p of SENTINELS){
    try{
      const r=await fetch(`${O}${p}?app_version=${A}&platform=win32`,
        {headers:H(),signal:AbortSignal.timeout(10000)})
      if(r.status!==404) hits.push(`${p}=${r.status}`)
    }catch{}
  }
  return hits
}

let lastSig=''
while(Date.now()-t0 < MAX){
  await activation()
  const p=await preview()
  const sig=JSON.stringify(p.plans)
  if(sig!==lastSig){
    if(p.plans.length===0) log(`preview 空（无可领）status=${p.status}`)
    else{
      log(`*** 可领 ${p.plans.length} 个 *** status=${p.status}`)
      for(const x of p.plans) log(`    ${x.id}  +${x.units??'?'}${x.unit||''}  period=${x.period||'?'}  pri=${x.pri}  ${x.name||''}`)
    }
    lastSig=sig
  } else {
    log(`no change (${p.plans.length})`)
  }
  const s=await sentinels()
  if(s.length) log(`!! 哨兵命中（上游新增通道？）: ${s.join(', ')}`)
  await new Promise(r=>setTimeout(r,EVERY))
}
log('watch 结束')
