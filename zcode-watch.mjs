/**
 * ZCode 放量监控（长跑）
 *
 * 设计原则：**像人不像机器人**
 *   - 默认 1 小时一次，带 ±15% 随机抖动（不是精确周期）
 *   - 只打 preview/event（无 captcha，不耗阿里云设备配额）
 *   - 哨兵端点探测每天只做 2 次（不是每轮都扫）
 *
 * 频率依据：
 *   - 真实放量窗口是「周末 3 亿 / 1024 节 5 亿」，以小时计 → 30 分钟足够
 *   - preview 每 5 分钟 = 288 次/天，行为模式过于规律，有 3012 风控风险
 *
 * 用法：
 *   node zcode-watch.mjs                  # 默认 60min，跑 3 天
 *   EVERY_MS=1800000 node zcode-watch.mjs # 30 分钟
 *   MAX_MS=86400000 node zcode-watch.mjs # 只跑 1 天
 */
import fs from 'node:fs'
const CRED = '/data/zcode.json'
const LOG = '/data/zcode-watch.log'
const c = JSON.parse(fs.readFileSync(CRED, 'utf8'))
const A = c.app_version || '3.14.3'
const O = 'https://zcode.z.ai'

const H = (x = {}) => ({
  'User-Agent': `ZCode/${A}`, 'HTTP-Referer': O, 'X-ZCode-App-Version': A,
  'X-Release-Channel': 'stable', 'X-Client-Language': 'zh-CN',
  'X-Client-Timezone': 'Asia/Shanghai', 'X-Device-Mid': c.device_mid,
  'X-Platform': 'win32', 'X-Os-Category': 'windows',
  'anthropic-version': '2023-06-01',
  Authorization: `Bearer ${c.jwt}`, ...x,
})

// 默认 1 小时 + 抖动
const BASE = Number(process.env.EVERY_MS || 3600000)
const JITTER = Number(process.env.JITTER_PCT || 15) / 100
const MAX = Number(process.env.MAX_MS || 259200000)  // 3 天
// 哨兵每天只探 2 次（放在 12:00 与 20:00 附近）
const SENTINELS = [
  '/api/v1/zcode-plan/billing/gift',
  '/api/v1/zcode-plan/gift',
  '/api/v1/zcode-plan/billing/plans',
  '/api/v1/zcode-plan/billing/welcome',
  '/api/v1/zcode-plan/billing/reward',
  '/api/v1/zcode-plan/activities',
]
const t0 = Date.now()
const stamp = () => new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const log = (s) => { const l = `[${stamp()}] ${s}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }

log(`start  base=${BASE / 60000}min jitter=±${JITTER * 100}%  max=${MAX / 3600000}h`)

async function activation() {
  // ⚠ 一天只在第一轮补一次即可：服务端按 device_mid + 日期去重，
  //   重复上报不增加收益，只增加行为痕迹
  for (const e of ['app_launch', 'app_daily_active']) {
    try {
      await fetch(`${O}/api/v1/event/report`, {
        method: 'POST', headers: H({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ event: e, device_mid: c.device_mid, platform: 'win32', app_version: A }),
        signal: AbortSignal.timeout(15000),
      })
    } catch { /* 不阻塞 */ }
  }
}

async function preview() {
  try {
    const r = await fetch(`${O}/api/v1/zcode-plan/billing/preview?app_version=${A}&platform=win32`,
      { headers: H(), signal: AbortSignal.timeout(20000) })
    if (!r.ok) return { status: r.status, plans: [] }
    const j = await r.json().catch(() => ({}))
    const raw = Array.isArray(j?.data?.plans) ? j.data.plans : []
    return {
      status: r.status,
      plans: raw.map((p) => {
        const e0 = (Array.isArray(p.entitlements) ? p.entitlements[0] : {}) || {}
        return {
          id: p.plan_id, name: p.name, pri: Number(p.priority) || 0,
          units: e0.grant_units, unit: e0.unit_type, period: e0.period,
        }
      }),
    }
  } catch (e) { return { status: 'ERR', plans: [], err: e.message } }
}

async function scanSentinels() {
  const hits = []
  for (const p of SENTINELS) {
    try {
      const r = await fetch(`${O}${p}?app_version=${A}&platform=win32`,
        { headers: H(), signal: AbortSignal.timeout(10000) })
      if (r.status !== 404) hits.push(`${p}=${r.status}`)
    } catch { /* 忽略 */ }
  }
  return hits
}

let lastDate = ''
let lastSig = ''
let lastScanHour = -1

while (Date.now() - t0 < MAX) {
  // 跨日才补激活（不是每轮）
  const today = new Date().toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' })
  if (today !== lastDate) { await activation(); lastDate = today; log('已补激活上报（跨日）') }

  const p = await preview()
  const sig = JSON.stringify(p.plans)
  if (sig !== lastSig) {
    if (p.plans.length === 0) log(`preview 空 status=${p.status}`)
    else {
      log(`*** 可领 ${p.plans.length} 个 *** status=${p.status}`)
      for (const x of p.plans) log(`    ${x.id}  +${x.units ?? '?'}${x.unit || ''}  period=${x.period || '?'}  pri=${x.pri}  ${x.name || ''}`)
    }
    lastSig = sig
  } else {
    log(`no change (${p.plans.length})`)
  }

  // 哨兵：每天 12 点 / 20 点各一次
  const hour = Number(new Date().toLocaleString('en-US', { timeZone: 'Asia/Shanghai', hour: '2-digit', hour12: false }))
  if ((hour === 12 || hour === 20) && hour !== lastScanHour) {
    lastScanHour = hour
    const s = await scanSentinels()
    log(s.length ? `!! 哨兵命中: ${s.join(', ')}` : `哨兵扫描完成（全部 404）`)
  }

  // 30 分钟 ± 抖动
  const wait = Math.round(BASE * (1 + (Math.random() * 2 - 1) * JITTER))
  await new Promise((r) => setTimeout(r, wait))
}
log('watch 结束')
