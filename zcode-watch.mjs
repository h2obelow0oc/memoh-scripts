/**
 * ZCode 放量监控（长跑）
 *
 * ## 时间窗口的判据（不是随便定的）
 * 额度按**自然日**结算：`billing/balance` 的桶带 expires_at，
 * 活动说明为「每日刷新」，代码据此取 **UTC+8 当日 24:00** 作为重置点
 * （见 channel-pack zcode-adapter.ts 的 nextUtc8DayStartMs）。
 * ⇒ 放量窗口在**零点后**，不在 12/20 点。
 * ⇒ 零点后加密到 7 分钟一次（覆盖 00:00-00:30），哨兵打在 00:05 / 00:15。
 * ⇒ 其余时段 1 小时 ± 15% 抖动，避免规律行为触发 3012 风控。
 *
 * ## 频率
 *   - 平时：1 小时（≈22 次/天）
 *   - 零点窗口：00:00-00:30 每 7 分钟（≈4 次）
 *   - 哨兵：00:05、00:15 各一轮（6 个候选端点 × 2 = 12 次/天）
 *   - 合计 ≈ 40 请求/天，比正常用户开客户端的频率还低
 *
 * 用法：
 *   node zcode-watch.mjs                  # 默认 60min，跑 3 天
 *   EVERY_MS=1800000 node zcode-watch.mjs # 平时也 30 分钟
 *   MAX_MS=86400000 node zcode-watch.mjs  # 只跑 1 天
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

const BASE = Number(process.env.EVERY_MS || 3600000)      // 平时 1 小时
const JITTER = Number(process.env.JITTER_PCT || 15) / 100
const RESET_EVERY = Number(process.env.RESET_EVERY_MS || 420000) // 零点窗口 7 分钟
const MAX = Number(process.env.MAX_MS || 259200000)       // 3 天

// 哨兵：这些端点**现在全是 404**。某天变 200 = 上游新增发放通道的信号
const SENTINELS = [
  '/api/v1/zcode-plan/billing/gift',
  '/api/v1/zcode-plan/gift',
  '/api/v1/zcode-plan/billing/plans',
  '/api/v1/zcode-plan/billing/welcome',
  '/api/v1/zcode-plan/billing/reward',
  '/api/v1/zcode-plan/activities',
]

const t0 = Date.now()
const now = () => new Date()
const stamp = () => now().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
const dkey = () => now().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' })  // YYYY-MM-DD
/** 取 UTC+8 的 时:分 */
const hm = () => {
  const s = now().toLocaleString('en-GB', { timeZone: 'Asia/Shanghai', hour12: false })
  const m = s.match(/(\d{2}):(\d{2})/)
  return { h: Number(m[1]), m: Number(m[2]) }
}
const log = (s) => { const l = `[${stamp()}] ${s}`; console.log(l); fs.appendFileSync(LOG, l + '\n') }

log(`start  base=${BASE / 60000}min ±${JITTER * 100}%  reset=${RESET_EVERY / 60000}min  max=${MAX / 3600000}h`)

async function activation() {
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
        return { id: p.plan_id, name: p.name, pri: Number(p.priority) || 0,
          units: e0.grant_units, unit: e0.unit_type, period: e0.period }
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
const scanned = new Set()   // 按 "YYYY-MM-DD:槽位" 去重（修 bug：原先只记小时，跨日不重扫）

while (Date.now() - t0 < MAX) {
  const today = dkey()
  if (today !== lastDate) {
    await activation()
    lastDate = today
    log('已补激活上报（跨日）')
  }

  const p = await preview()
  const sig = JSON.stringify(p.plans)
  if (sig !== lastSig) {
    if (p.plans.length === 0) log(`preview 空 status=${p.status}`)
    else {
      log(`*** 可领 ${p.plans.length} 个 *** status=${p.status}`)
      for (const x of p.plans) {
        log(`    ${x.id}  +${x.units ?? '?'}${x.unit || ''}  period=${x.period || '?'}  pri=${x.pri}  ${x.name || ''}`)
      }
    }
    lastSig = sig
  } else {
    log(`no change (${p.plans.length})`)
  }

  // ── 哨兵：零点后 00:05 与 00:15 各一次 ──────────────────
  const { h, m } = hm()
  for (const [slot, cond] of [['t005', h === 0 && m >= 5 && m < 10],
                              ['t015', h === 0 && m >= 15 && m < 20]]) {
    if (!cond) continue
    const key = `${today}:${slot}`
    if (scanned.has(key)) continue
    scanned.add(key)
    const s = await scanSentinels()
    log(s.length ? `!! 哨兵[${slot}] 命中: ${s.join(', ')}` : `哨兵[${slot}] 完成（全部 404）`)
  }

  // ── 下次等待：零点窗口加密，其余 1 小时 ──────────────────
  const inResetWindow = h === 0 && m < 30
  const wait = inResetWindow
    ? RESET_EVERY
    : Math.round(BASE * (1 + (Math.random() * 2 - 1) * JITTER))
  await new Promise((r) => setTimeout(r, wait))
}
log('watch 结束')
