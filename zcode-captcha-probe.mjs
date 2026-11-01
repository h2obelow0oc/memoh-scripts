/**
 * ZCode 阿里云 captcha 产出探测（在 Memoh / 任意 Linux headful 环境跑）
 *
 * 目的：验证「Linux + Xvfb + headful chromium」能否产出合法的阿里云验证码 param。
 * 这是 ZCode 每日领取额度的**唯一硬门禁**。
 *
 * 判据（来自 dsh-our-free-model channel-pack 实测记录）：
 *   - 成功：param 长度约 280 字符
 *   - 失败：F001 / fail / timeout  -> 这条路不通，别再投入
 *   - inter=true（弹滑块/拼图）-> 设备信誉已下滑，即使当次能出 param 也不建议投产
 *
 * ⚠ 本脚本**不需要** zcode_jwt / device_mid：产 captcha 只用 region/prefix/sceneId
 * ⚠ 每跑一次消耗一点该出口 IP 的设备信誉。跑 1~2 次即可，别反复刷。
 *
 * 用法：
 *   pgrep -a Xvfb || (Xvfb :99 -screen 0 1920x1080x24 &)
 *   export DISPLAY=:99
 *   cd /data && npm i puppeteer-core
 *   node zcode-captcha-probe.mjs
 */
import puppeteer from 'puppeteer-core'
import fs from 'node:fs'

const CFG = { region: 'cn', prefix: 'no8xfe', sceneId: '11xygtvd' }
const SDK = 'https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js'
const PAGE = 'https://zcode.z.ai/'
const EXE_LIST = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome']

const exe = EXE_LIST.find((p) => fs.existsSync(p))
if (!exe) {
  console.error('找不到 chromium，试过：' + EXE_LIST.join(', '))
  process.exit(2)
}
if (!process.env.DISPLAY) {
  console.error('DISPLAY 未设置 —— headful 必须要有 X server。先 export DISPLAY=:99')
  process.exit(2)
}

console.log('node     =', process.version)
console.log('chromium =', exe)
console.log('DISPLAY  =', process.env.DISPLAY)
console.log('region   =', CFG.region)
console.log('')

const browser = await puppeteer.launch({
  executablePath: exe,
  headless: false,
  args: [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-sync',
    '--disable-features=Translate',
    '--lang=zh-CN',
    '--window-size=1280,900',
  ],
})

let code = 0
try {
  const page = await browser.newPage()
  page.setDefaultTimeout(60000)
  console.log('导航到 ' + PAGE + ' ...')
  await page.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 45000 })
  console.log('页面已加载，开始产 captcha ...')
  console.log('')

  const t0 = Date.now()
  const r = await page.evaluate(async (cfg, sdk) => {
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
    if (typeof window.initAliyunCaptcha !== 'function') {
      return { stage: 'no-sdk', msg: 'SDK 未加载（网络？）' }
    }

    let inter = false
    const chk = () => {
      if (inter) return
      if (
        document.querySelector('#aliyunCaptcha-window-popup') ||
        document.querySelector('#aliyunCaptcha-sliding-slider') ||
        document.querySelector('#aliyunCaptcha-puzzle')
      ) inter = true
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
            if (typeof ins.startTracelessVerification === 'function') {
              ins.startTracelessVerification()
            } else {
              inter = true
              ins.show()
            }
          },
          success: (param) => {
            chk()
            fin({ stage: 'ok', n: param.length, head: String(param).slice(0, 10), inter })
          },
          fail: (e) => fin({ stage: 'fail', msg: String((e && e.message) || e), inter }),
          onError: (e) => fin({ stage: 'error', msg: String((e && e.message) || e), inter }),
        })
      } catch (e) {
        fin({ stage: 'throw', msg: String((e && e.message) || e), inter })
      }
      setTimeout(() => fin({ stage: 'timeout', inter }), 45000)
    })
  }, CFG, SDK)
  r.ms = Date.now() - t0

  console.log('结果：' + JSON.stringify(r, null, 2))
  console.log('')

  if (r.stage === 'ok' && r.n >= 200) {
    console.log('[PASS] 产出合法 param：' + r.n + ' 字符，耗时 ' + r.ms + 'ms')
    if (r.inter) {
      console.log('[WARN] 被降级为交互式验证（inter=true）—— 设备信誉已下滑，投产有风险')
      code = 1
    } else {
      console.log('[PASS] 无感验证（inter=false）—— 可以投产')
    }
  } else {
    console.log('[FAIL] stage=' + r.stage + ' —— 这条路不通，别在 Memoh 上继续投入')
    code = 1
  }
} finally {
  await browser.close().catch(() => {})
}

process.exit(code)
