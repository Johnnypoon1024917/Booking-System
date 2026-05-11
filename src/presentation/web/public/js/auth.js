// Trilingual login page bootstrap. The SPA at /app/ takes over once
// authentication succeeds.

const STRINGS = {
  en: {
    tagline: 'Multi-tenant booking platform',
    heroTitle: 'Real-time room booking, made effortless.',
    heroBody: 'Single sign-on, recurring meetings, ICS calendar sync, QR check-in, and a tenant studio — all in one place.',
    f1Title: 'Trilingual',     f1Body: 'EN / 繁體 / 简体 — switch on the fly.',
    f2Title: 'HK Aware',       f2Body: 'HKO weather + gov.hk holidays auto-sync.',
    f3Title: 'Real-time',      f3Body: 'WebSocket availability, no refresh.',
    signIn: 'Sign in',
    signInDesc: 'Use your Active Directory credentials to continue.',
    username: 'Username',
    password: 'Password',
    continue: 'Continue',
    signingIn: 'Signing in…',
    badCreds: 'Invalid credentials. Please try again.',
    footer: 'Single sign-on protected · Compliant with HK PDPO'
  },
  'zh-Hant': {
    tagline: '多租戶預約平台',
    heroTitle: '即時會議室預約，輕鬆完成。',
    heroBody: '單一登入、循環會議、ICS 日曆同步、二維碼簽到，以及租戶設定中心，一站式整合。',
    f1Title: '三語介面',     f1Body: 'EN / 繁體 / 简体 即時切換。',
    f2Title: '香港在地',     f2Body: '天文台訊號 + gov.hk 假期自動同步。',
    f3Title: '即時更新',     f3Body: 'WebSocket 即時可用率，毋須重新整理。',
    signIn: '登入',
    signInDesc: '使用您的 Active Directory 帳號繼續。',
    username: '用戶名',
    password: '密碼',
    continue: '繼續',
    signingIn: '登入中…',
    badCreds: '帳號或密碼錯誤，請再試。',
    footer: '單一登入保護 · 符合香港個人資料條例'
  },
  'zh-Hans': {
    tagline: '多租户预约平台',
    heroTitle: '实时会议室预约，轻松完成。',
    heroBody: '单点登录、循环会议、ICS 日历同步、二维码签到，以及租户设置中心，一站式整合。',
    f1Title: '三语界面',     f1Body: 'EN / 繁體 / 简体 即时切换。',
    f2Title: '香港本地',     f2Body: '天文台信号 + gov.hk 假期自动同步。',
    f3Title: '实时更新',     f3Body: 'WebSocket 实时可用率，无需刷新。',
    signIn: '登录',
    signInDesc: '使用您的 Active Directory 帐号继续。',
    username: '用户名',
    password: '密码',
    continue: '继续',
    signingIn: '登录中…',
    badCreds: '账号或密码错误，请重试。',
    footer: '单点登录保护 · 符合香港个人资料条例'
  }
}

let locale = localStorage.getItem('fsd_locale') || preferred() || 'en'

function preferred() {
  const langs = navigator.languages || [navigator.language]
  for (const l of langs) {
    if (!l) continue
    const lo = l.toLowerCase()
    if (lo.startsWith('zh-tw') || lo.startsWith('zh-hk') || lo.startsWith('zh-hant')) return 'zh-Hant'
    if (lo.startsWith('zh-cn') || lo.startsWith('zh-hans') || lo === 'zh') return 'zh-Hans'
    if (lo.startsWith('en')) return 'en'
  }
  return null
}

function applyLocale() {
  const dict = STRINGS[locale] || STRINGS.en
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const k = el.getAttribute('data-i18n')
    if (dict[k]) el.textContent = dict[k]
  })
  document.documentElement.lang = locale
  document.querySelectorAll('.lang-row button').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-locale') === locale)
  })
}

document.querySelectorAll('.lang-row button').forEach(b => {
  b.addEventListener('click', () => {
    locale = b.getAttribute('data-locale')
    localStorage.setItem('fsd_locale', locale)
    applyLocale()
  })
})
applyLocale()

const form = document.getElementById('loginForm')
const errBox = document.getElementById('loginError')
const submit = document.getElementById('submitBtn')
const submitLabel = submit.querySelector('span')

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  errBox.classList.remove('show')

  const u = document.getElementById('username').value.trim()
  const p = document.getElementById('password').value

  submit.disabled = true
  submitLabel.textContent = STRINGS[locale].signingIn
  submit.insertAdjacentHTML('afterbegin', '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>')

  try {
    const res = await fetch('/api/v1/login', {
      method: 'POST',
      headers: { 'X-Username': u, 'X-Password': p }
    })
    if (!res.ok) throw new Error(STRINGS[locale].badCreds)
    const data = await res.json()
    localStorage.setItem('fsd_jwt', data.token)
    localStorage.setItem('fsd_role', data.role)
    localStorage.setItem('fsd_user', u)
    sessionStorage.setItem('fsd_jwt', data.token)
    window.location.href = '/app/'
  } catch (err) {
    errBox.textContent = err.message || STRINGS[locale].badCreds
    errBox.classList.add('show')
    submit.disabled = false
    submit.querySelector('svg')?.remove()
    submitLabel.textContent = STRINGS[locale].continue
  }
})
