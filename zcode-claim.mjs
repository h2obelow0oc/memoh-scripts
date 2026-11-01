/**
 * ZCode 每日额度领取（Memoh / Linux + Xvfb + headful chromium）
 *
 * 移植自 dsh-our-free-model 的 channel-pack（常量与流程逐条对齐上游实测）。
 *
 * 用法：
 *   node zcode-claim.mjs watch      # 轮询 preview，摸清几点放量（不需要 captcha，最省）
 *   node zcode-claim.mjs preview     # 查一次可领 plan
 *   node zcode-claim.mjs claim       # 产 captcha 并领取
 *
 * 凭据：/data/zcode.json
 *   {"jwt":"...","device_mid":"...","region":"cn"}
 *   region: cn = bigmodel 国内渠道, sgp = z.ai 国际渠道
 *
 * 上游业务码：
 *   0    成功
 *   1003 已领取过（幂等成功，不是错误）
 *   1005 名额用完          <- 先到先得的证据
 *   1002 活动已结束
 *   3007 captcha 校验失败  <- 需换新 param 重试
 *   3012 风控拦截          <- 停止，别硬刷
 */

import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const ORIGIN = 'https://zcode.z.ai'
const APPVER = '3.14.3'
const URL_PREVIEW = `${ORIGIN}/api/v1/zcode-plan/billing/preview`
const URL_CLAIM = `${ORIGIN}/api/v1/zcode-plan/billing/claim`
const URL_EVENT = `${ORIGIN}/api/v1/event/report`
const SDK = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
const PAGE = 'https://zcode.z.ai/'
const CRED_FILE = '/data/zcode.json'
const EXE_LIST = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']

// ── 凭据 ────────────────────────────────────────────────────────────
function loadCred() {
  if (!fs.existsSync(CRED_FILE)) {
    console.error(`缺少凭据文件 ${CRED_FILE}`)
    console.error('格式：{"jwt":"...","device_mid":"...","region":"cn"}')
    process.exit(2)
  }
  const c = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))
  if (!c.jwt || !c.device_mid) {
    console.error('凭据缺少 jwt 或 device_mid')
    process.exit(2)
  }
  return { region: 'cn', ...c }
}

function headers(cred, extra = {}) {
  const h = {
    'User-Agent': `ZCode/${APPVER}`,
    'HTTP-Referer': ORIGIN,
    'X-ZCode-App-Version': APPVER,
    'X-Release-Channel': 'stable',
    'X-Client-Language': 'zh-CN',
    'X-Client-Timezone': 'Asia/Shanghai',
    'X-Device-Mid': cred.device_mid,
    'X-Platform': 'win32',
    'X-Os-Category': 'windows',
    'anthropic-version': '2023-06-01',
    Authorization: `Bearer ${cred.jwt}`,
    ...extra,
  }
  return h
}

// ── 激活上报（必须在 preview 之前，否则 plans 恒为空）──────────────
async function reportActivation(cred) {
  for (const event of ['app_launch', 'app_daily_active']) {
    try {
      await fetch(URL_EVENT, {
        method: 'POST',
        headers: headers(cred, { 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          event, device_mid: cred.device_mid, platform: 'win32', app_version: APPVER,
        }),
        signal: AbortSignal.timeout(20000),
      })
    } catch { /* 上报失败不阻塞 */ }
  }
}

// ── 查可领 plan ─────────────────────────────────────────────────────
async function fetchPlans(cred) {
  const url = `${URL_PREVIEW}?app_version=${encodeURIComponent(APPVER)}&platform=win32`
  const r = await fetch(url, { method: 'GET', headers: headers(cred), signal: AbortSignal.timeout(25000) })
  if (!r.ok) return { ok: false, status: r.status, plans: [] }
  const j = await r.json().catch(() => ({}))
  const raw = Array.isArray(j?.data?.plans) ? j.data.plans : []
  const plans = raw
    .filter((p) => p && typeof p.plan_id === 'string' && p.plan_id.length > 0)
    .map((p) => {
      const ent = (Array.isArray(p.entitlements) ? p.entitlements[0] : {}) || {}
      return {
        planId: p.plan_id,
        name: p.name,
        priority: Number(p.priority) || 0,
        grantUnits: ent.grant_units,
        unitType: ent.unit_type,
      }
    })
    .sort((a, b) => b.priority - a.priority)
  return { ok: true, status: r.status, plans }
}

// ── captcha（每 plan 必须重新产，复用必 3007）──────────────────────
async function mintParam(page, cred) {
  return await page.evaluate(async (cfg, sdk) => {
    document.body.innerHTML =
      '<div id="zc-c"><div id="zc-e"></div><button id="zc-b">v</button></div>'
    await new Promise((res) => {
      const s = document.createElement('script')
      s.src = sdk
      s.async = true
      s.onload = res
      s.onerror = res
      document.head.appendChild(s)
    })
    if (typeof window.initAliyunCaptcha !== 'function') return { stage: 'no-sdk' }

    let inter = false
    const chk = () => {
      if (inter) return
      if (document.querySelector('#aliyunCaptcha-window-popup')
        || document.querySelector('#aliyunCaptcha-sliding-slider')
        || document.querySelector('#aliyunCaptcha-puzzle')) inter = true
    }
    const timer = setInterval(chk, 200)

    return await new Promise((res) => {
      const fin = (o) => { clearInterval(timer); res(o) }
      try {
        window.AliyunCaptchaConfig = { region: cfg.region, prefix: cfg.prefix }
        window.initAliyunCaptcha({
          SceneId: cfg.sceneId,
          mode: 'popup',
          element: '#zc-e',
          button: document.getElementById('zc-b'),
          getInstance: (ins) => {
            if (typeof ins.startTracelessVerification === 'function') ins.startTracelessVerification()
            else { inter = true; ins.show() }
          },
          success: (param) => { chk(); fin({ stage: 'ok', param, inter }) },
          fail: (e) => fin({ stage: 'fail', msg: String((e && e.message) || e), inter }),
          onError: (e) => fin({ stage: 'error', msg: String((e && e.message) || e), inter }),
        })
      } catch (e) {
        fin({ stage: 'throw', msg: String((e && e.message) || e), inter })
      }
      setTimeout(() => fin({ stage: 'timeout', inter }), 60000)
    })
  }, { region: cred.region, prefix: cred.prefix || 'no8xfe', sceneId: cred.sceneId || '11xygtvd' }, SDK)
}

// ── 领取 ────────────────────────────────────────────────────────────
async function claimOne(cred, plan, page) {
  const m = await mintParam(page, cred)
  if (m.stage !== 'ok') return { ok: false, code: -1, msg: `captcha ${m.stage} ${m.msg || ''}`, inter: m.inter }

  const r = await fetch(URL_CLAIM, {
    method: 'POST',
    headers: headers(cred, {
      'Content-Type': 'application/json',
      'x-aliyun-captcha-verify-param': m.param,
      'x-aliyun-captcha-verify-region': cred.region,
    }),
    body: JSON.stringify({ plan_id: plan.planId }),
    signal: AbortSignal.timeout(60000),
  })
  const text = await r.text().catch(() => '')
  let code, msg
  try {
    const j = JSON.parse(text)
    code = typeof j.code === 'number' ? j.code : (typeof j.code === 'string' ? Number(j.code) : undefined)
    msg = j.msg || j.message
  } catch { msg = text.slice(0, 200) }
  if (code === undefined && /unusual activity|blocked due to/i.test(text)) code = 3012

  return {
    planId: plan.planId,
    ok: r.ok && (code === 0 || code === 1003),
    already: code === 1003,
    code, msg, http: r.status, inter: m.inter,
  }
}

// ── 主流程 ──────────────────────────────────────────────────────────
const mode = process.argv[2] || 'preview'
const cred = loadCred()

if (mode === 'watch') {
  // 摸清放量时刻：只打 preview（几乎零成本，不产 captcha、不耗设备信誉）
  const everyMs = Number(process.env.EVERY_MS || 120000)
  const maxMs = Number(process.env.MAX_MS || 3600000)
  const t0 = Date.now()
  console.log(`轮询 preview，每 ${everyMs / 1000}s 一次，最长 ${maxMs / 60000} 分钟`)
  let last = ''
  while (Date.now() - t0 < maxMs) {
    await reportActivation(cred)
    const r = await fetchPlans(cred)
    const stamp = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })
    const sig = r.plans.map((p) => `${p.planId}:${p.grantUnits}${p.unitType || ''}`).join('|')
    if (sig !== last) {
      console.log(`[${stamp}] 变化 -> ${r.plans.length} 个可领`)
      for (const p of r.plans) console.log(`   ${p.planId}  ${p.grantUnits}${p.unitType || ''}  ${p.name || ''}`)
      last = sig
    } else {
      console.log(`[${stamp}] 无变化（${r.plans.length} 个）`)
    }
    await new Promise((res) => setTimeout(res, everyMs))
  }
  process.exit(0)
}

if (mode === 'preview') {
  await reportActivation(cred)
  const r = await fetchPlans(cred)
  console.log(`HTTP ${r.status}，可领 ${r.plans.length} 个`)
  for (const p of r.plans) console.log(`  ${p.planId}  ${p.grantUnits}${p.unitType || ''}  ${p.name || ''}`)
  process.exit(0)
}

if (mode === 'claim') {
  await reportActivation(cred)
  const r = await fetchPlans(cred)
  if (r.plans.length === 0) {
    console.log('今天没有可领 plan（可能已领过，或活动未投放）')
    process.exit(0)
  }
  console.log(`可领 ${r.plans.length} 个，开始领取 ...`)

  const exe = EXE_LIST.find((p) => fs.existsSync(p))
  if (!exe) { console.error('找不到 chromium'); process.exit(2) }
  if (!process.env.DISPLAY) { console.error('DISPLAY 未设置，先 export DISPLAY=:99'); process.exit(2) }

  const browser = await puppeteer.launch({
    executablePath: exe, headless: false,
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--no-first-run',
      '--disable-background-networking', '--disable-sync', '--disable-features=Translate',
      '--lang=zh-CN', '--window-size=1280,900'],
  })
  try {
    const page = await browser.newPage()
    await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 45000 })
    let done = 0
    for (const plan of r.plans) {
      const res = await claimOne(cred, plan, page)
      if (res.ok) done += 1
      const tag = res.already ? '已领过' : (res.ok ? '成功' : `失败 code=${res.code}`)
      console.log(`  ${plan.planId}: ${tag} ${res.msg || ''}${res.inter ? ' [降级交互]' : ''}`)
      if (res.code === 3012) { console.log('  ⚠ 命中风控 3012，停止领取'); break }
      if (res.code === 1005) { console.log('  ⚠ 名额用完 1005 —— 抢光了'); }
      if (res.code === 3007) { console.log('  ⚠ captcha 被拒 3007'); }
    }
    console.log(`完成：${done}/${r.plans.length}`)
  } finally {
    await browser.close().catch(() => {})
  }
  process.exit(0)
}

console.error('未知模式：' + mode)
process.exit(2)
