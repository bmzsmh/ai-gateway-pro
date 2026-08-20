import { Context } from 'hono'
import { getProviders, getProxyKeys, getModelGroups } from './storage'
import { SITE_CONFIG, OPENCODE_DEFAULT_URL } from './config'
import type { Env } from './types'
import { CSS_CONTENT } from './pages.css'
import { SHARED_JS, renderSiteFooter } from './shared.js'

// 前端页面模板：仅重构视觉与交互，保持后端路由、KV 结构和 API 契约不变。
const escapePageHtml = (value: unknown) => String(value ?? '')
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&#39;')

// 渲染可用模型 chips（点击添加到成员列表）
function renderAvailableModels(providers: Array<{ id: string; name: string; models: Array<{ id: string; enabled?: boolean }> }>): string {
  const chips: string[] = []
  for (const p of providers) {
    for (const m of p.models) {
      if (m.enabled === false) continue
      const ref = `${p.id}/${m.id}`
      chips.push(`<button type="button" class="chip chip-model chip-avail" data-ref="${escapePageHtml(ref)}" onclick="addAvailToGroup('${escapePageHtml(ref)}')">${escapePageHtml(ref)}</button>`)
    }
  }
  return chips.length ? chips.join('') : '<p class="form-helper">暂无可用模型，请先在「提供商」中添加。</p>'
}

const H = (title: string) => `
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover">
  <meta name="theme-color" content="oklch(98.5% 0.004 250)">
  <title>${title} — ${SITE_CONFIG.title}</title>
  <link rel="icon" href="${SITE_CONFIG.favicon}">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&amp;family=JetBrains+Mono:wght@400;500;600&amp;family=Space+Grotesk:wght@500;600&amp;display=swap" rel="stylesheet">
  <link rel="stylesheet" href="${SITE_CONFIG.faCdn}">
  <style>${CSS_CONTENT}</style>
</head>`

// ===== 首页 =====

export async function renderHomePage(c: Context<{ Bindings: Env }>, isLoggedIn: boolean) {
  const providers = await getProviders(c.env)
  const host = c.req.header('host') || 'localhost:8787'
  const apiBase = `https://${host}/v1`
  const enabledProviders = providers.filter((provider) => provider.enabled)
  const allModelsCount = providers.reduce((total, provider) => total + provider.models.length, 0)
  const enabledModelsCount = enabledProviders.reduce((total, provider) => total + provider.models.filter((model) => model.enabled).length, 0)

  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('首页')}
<body class="site-page home-page">
<header class="topbar">
  <div class="shell topbar__inner">
    <a class="brand" href="/" aria-label="AI Gateway 首页">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
      <span class="brand__descriptor">API CONTROL PLANE</span>
    </a>
    <nav class="topbar__actions" aria-label="主导航">
      ${isLoggedIn
        ? `<a href="/admin" class="btn btn-p"><i class="fas fa-sliders-h" aria-hidden="true"></i>管理控制台</a><a href="/admin/logout" class="btn btn-gh"><i class="fas fa-sign-out-alt" aria-hidden="true"></i>退出</a>`
        : `<a href="/admin/login" class="btn btn-p"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>管理员登录</a>`
      }
    </nav>
  </div>
</header>

<main>
  <section class="shell home-hero" aria-labelledby="home-title">
    <div class="home-hero__copy">
      <p class="eyebrow"><span aria-hidden="true"></span>UNIFIED AI GATEWAY</p>
      <h1 id="home-title">一个 API，调用已配置的所有模型。</h1>
      <p class="home-hero__lede">统一的 OpenAI / Anthropic 兼容入口。模型按提供商归档，转发 Key、启用状态和故障转移集中管理。</p>
      <div class="endpoint-box" aria-label="API 接入地址">
        <span class="endpoint-box__label">BASE URL</span>
        <code>${escapePageHtml(apiBase)}</code>
        <button class="icon-btn copy-control" type="button" data-copy="${escapePageHtml(apiBase)}" aria-label="复制 API 地址">
          <i class="far fa-copy" aria-hidden="true"></i><span>复制</span>
        </button>
      </div>
    </div>

    <figure class="request-panel" aria-labelledby="request-caption">
      <figcaption id="request-caption">
        <span>POST /chat/completions</span>
        <span class="protocol-state"><i aria-hidden="true"></i>OPENAI COMPATIBLE</span>
      </figcaption>
      <pre><code><span class="syntax-command">curl</span> ${escapePageHtml(apiBase)}/chat/completions \\
  <span class="syntax-key">-H</span> <span class="syntax-string">"Authorization: Bearer sk_cf_••••"</span> \\
  <span class="syntax-key">-H</span> <span class="syntax-string">"Content-Type: application/json"</span> \\
  <span class="syntax-key">-d</span> <span class="syntax-string">'{
    "model": "opencode/deepseek-v4-flash-free",
    "messages": [{ "role": "user", "content": "Hello" }]
  }'</span></code></pre>
      <div class="request-panel__foot">
        <span>模型格式</span>
        <code>provider/model</code>
      </div>
    </figure>
  </section>

  <section class="shell metrics-strip" aria-label="网关配置概览">
    <div class="metric"><span class="metric__value">${providers.length}</span><span class="metric__label">提供商总计</span></div>
    <div class="metric"><span class="metric__value">${enabledProviders.length}</span><span class="metric__label">已启用提供商</span></div>
    <div class="metric"><span class="metric__value">${allModelsCount}</span><span class="metric__label">模型总计</span></div>
    <div class="metric"><span class="metric__value">${enabledModelsCount}</span><span class="metric__label">可用模型</span></div>
  </section>

  <section class="shell directory" aria-labelledby="directory-title">
    <div class="section-heading">
      <div>
        <h2 id="directory-title">模型列表</h2>
        <p>点击模型 ID 即可复制；这里只展示已启用的提供商与模型。</p>
      </div>
      <label class="search-field" for="model-search">
        <i class="fas fa-search" aria-hidden="true"></i>
        <span class="sr-only">搜索提供商或模型</span>
        <input id="model-search" type="search" placeholder="搜索提供商或模型" autocomplete="off">
      </label>
    </div>

    <div class="provider-index" id="provider-index">
      ${enabledProviders.length ? enabledProviders.map((provider) => {
        const models = provider.models.filter((model) => model.enabled)
        return `<article class="provider-row" data-search="${escapePageHtml(`${provider.name} ${provider.id} ${models.map((model) => model.id).join(' ')}`.toLowerCase())}">
          <div class="provider-row__identity">
            <span class="provider-row__mark" aria-hidden="true">${escapePageHtml(provider.name.charAt(0).toUpperCase() || 'A')}</span>
            <div>
              <h3>${escapePageHtml(provider.name)}</h3>
              <p><code>${escapePageHtml(provider.id)}</code><span>${(provider.apiType || 'openai') === 'anthropic' ? 'Anthropic' : 'OpenAI'} 兼容</span></p>
            </div>
          </div>
          <div class="provider-row__models">
            ${models.length ? models.map((model) => {
              const fullModel = `${provider.id}/${model.id}`
              return `<button class="model-token copy-control" type="button" data-copy="${escapePageHtml(fullModel)}"><code>${escapePageHtml(fullModel)}</code><i class="far fa-copy" aria-hidden="true"></i></button>`
            }).join('') : '<span class="empty-inline">暂无启用模型</span>'}
          </div>
          <span class="status-badge status-badge--on"><i aria-hidden="true"></i>已启用</span>
        </article>`
      }).join('') : `<div class="empty-state"><i class="fas fa-cubes" aria-hidden="true"></i><h3>尚无可用模型</h3><p>管理员启用提供商和模型后，它们会出现在这里。</p>${isLoggedIn ? '<a class="btn btn-p" href="/admin">前往管理控制台</a>' : ''}</div>`}
    </div>
    <div id="search-empty" class="empty-state hd"><i class="fas fa-search" aria-hidden="true"></i><h3>没有匹配结果</h3><p>请尝试输入提供商名称、ID 或模型名称。</p></div>
  </section>
</main>

${renderSiteFooter(SITE_CONFIG.title)}

<script>
(function () {
  var status = document.getElementById('copy-status')
  document.querySelectorAll('.copy-control').forEach(function (button) {
    button.addEventListener('click', async function () {
      var text = button.getAttribute('data-copy') || ''
      var icon = button.querySelector('i')
      var label = button.querySelector('span')
      try {
        await navigator.clipboard.writeText(text)
        button.setAttribute('data-state', 'success')
        if (icon) icon.className = 'fas fa-check c-s'
        if (label) label.textContent = '已复制'
        if (status) status.textContent = '已复制 ' + text
        window.setTimeout(function () {
          button.removeAttribute('data-state')
          if (icon) icon.className = 'far fa-copy'
          if (label) label.textContent = '复制'
        }, 1800)
      } catch (error) {
        button.setAttribute('data-state', 'error')
        if (status) status.textContent = '复制失败，请手动选择文本。'
      }
    })
  })

  var search = document.getElementById('model-search')
  var rows = Array.from(document.querySelectorAll('.provider-row'))
  var empty = document.getElementById('search-empty')
  if (search) search.addEventListener('input', function () {
    var query = search.value.trim().toLowerCase()
    var visible = 0
    rows.forEach(function (row) {
      var matched = !query || (row.getAttribute('data-search') || '').includes(query)
      row.classList.toggle('hd', !matched)
      if (matched) visible++
    })
    if (empty) empty.classList.toggle('hd', visible > 0 || !query)
  })
})()
</script>
</body></html>`)
}

// ===== 登录页 =====

export async function renderLoginPage(c: Context<{ Bindings: Env }>) {
  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('登录')}
<body class="site-page auth-page">
<header class="topbar topbar--auth">
  <div class="shell topbar__inner">
    <a class="brand" href="/" aria-label="AI Gateway 首页">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span class="brand__name">${SITE_CONFIG.title}</span>
    </a>
    <a href="/" class="btn btn-gh"><i class="fas fa-arrow-left" aria-hidden="true"></i>返回首页</a>
  </div>
</header>

<main class="auth-shell">
  <section class="auth-context" aria-labelledby="auth-context-title">
    <p class="eyebrow"><span aria-hidden="true"></span>CONTROL PLANE ACCESS</p>
    <h1 id="auth-context-title">管理提供商、模型和转发密钥。</h1>
  </section>

  <section class="auth-form-wrap" aria-labelledby="login-title">
    <form class="auth-form" id="login-form" novalidate>
      <div class="auth-form__heading">
        <span class="auth-form__icon" aria-hidden="true"><i class="fas fa-lock"></i></span>
        <div><h2 id="login-title">管理员登录</h2><p>使用部署时配置的账号继续。</p></div>
      </div>

      <div id="er" class="al al-e hd" role="alert" aria-live="assertive">
        <i class="fas fa-exclamation-circle" aria-hidden="true"></i><span id="em"></span>
      </div>

      <div class="fg">
        <label for="u">用户名</label>
        <div class="input-wrap"><i class="far fa-user" aria-hidden="true"></i><input type="text" id="u" name="username" placeholder="admin" autocomplete="username" aria-required="true" aria-describedby="login-helper"></div>
      </div>
      <div class="fg">
        <label for="p">密码</label>
        <div class="input-wrap"><i class="fas fa-key" aria-hidden="true"></i><input type="password" id="p" name="password" placeholder="部署环境变量中的密码" autocomplete="current-password" aria-required="true" aria-describedby="login-helper"><button class="password-toggle" id="password-toggle" type="button" aria-label="显示密码"><i class="far fa-eye" aria-hidden="true"></i></button></div>
      </div>
      <p id="login-helper" class="form-helper">登录成功后将进入管理控制台。</p>
      <button class="btn btn-p btn-submit" id="login-button" type="submit"><span class="button-label"><i class="fas fa-sign-in-alt" aria-hidden="true"></i>登录管理控制台</span><span class="button-loading"><i class="fas fa-circle-notch fa-spin" aria-hidden="true"></i>正在验证</span></button>
    </form>
  </section>
</main>

<script>
(function () {
  var form = document.getElementById('login-form')
  var username = document.getElementById('u')
  var password = document.getElementById('p')
  var errorBox = document.getElementById('er')
  var errorMessage = document.getElementById('em')
  var submit = document.getElementById('login-button')
  var toggle = document.getElementById('password-toggle')

  function showError(message) {
    errorMessage.textContent = message
    errorBox.classList.remove('hd')
    username.setAttribute('aria-invalid', 'true')
    password.setAttribute('aria-invalid', 'true')
  }
  function clearError() {
    errorBox.classList.add('hd')
    username.removeAttribute('aria-invalid')
    password.removeAttribute('aria-invalid')
  }

  toggle.addEventListener('click', function () {
    var show = password.type === 'password'
    password.type = show ? 'text' : 'password'
    toggle.setAttribute('aria-label', show ? '隐藏密码' : '显示密码')
    toggle.querySelector('i').className = show ? 'far fa-eye-slash' : 'far fa-eye'
    password.focus({ preventScroll: true })
  })

  form.addEventListener('submit', async function (event) {
    event.preventDefault()
    clearError()
    var u = username.value.trim()
    var p = password.value
    if (!u || !p) {
      showError('请填写用户名和密码后再登录。')
      ;(!u ? username : password).focus()
      return
    }
    submit.disabled = true
    submit.setAttribute('data-state', 'loading')
    try {
      var response = await fetch('/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: u, password: p })
      })
      var data = await response.json()
      if (data.success) {
        submit.setAttribute('data-state', 'success')
        window.location.href = '/admin'
        return
      }
      showError(data.message || '登录失败，请检查账号配置。')
    } catch (error) {
      showError('无法连接服务，请检查网络后重试。')
    }
    submit.disabled = false
    submit.removeAttribute('data-state')
  })
})()
</script>
</body></html>`)
}

// ===== 管理后台 =====

export async function renderAdminPage(c: Context<{ Bindings: Env }>) {
  const providers = await getProviders(c.env)
  const proxyKeys = await getProxyKeys(c.env)
  const modelGroups = await getModelGroups(c.env)
  const enabledProvidersCount = providers.filter((provider) => provider.enabled).length
  const modelsCount = providers.reduce((total, provider) => total + provider.models.length, 0)
  const enabledModelsCount = providers.reduce((total, provider) => total + provider.models.filter((model) => model.enabled).length, 0)
  const enabledProxyKeysCount = proxyKeys.filter((key) => key.enabled).length

  return c.html(`<!DOCTYPE html><html lang="zh-CN">
${H('管理')}
<body class="site-page admin-page">
<div class="admin-shell">
  <aside class="admin-rail" aria-label="控制台导航">
    <a class="brand admin-rail__brand" href="/">
      <span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span>
      <span><strong>${SITE_CONFIG.title}</strong><small>CONTROL PLANE</small></span>
    </a>
    <nav class="admin-nav">
      <a class="admin-nav__link is-active" href="#overview"><i class="fas fa-chart-pie" aria-hidden="true"></i><span>概览</span></a>
      <a class="admin-nav__link" href="#providers"><i class="fas fa-server" aria-hidden="true"></i><span>提供商</span><b>${providers.length}</b></a>
      <a class="admin-nav__link" href="#model-groups"><i class="fas fa-layer-group" aria-hidden="true"></i><span>模型组</span><b>${modelGroups.length}</b></a>
      <a class="admin-nav__link" href="#proxy-keys"><i class="fas fa-key" aria-hidden="true"></i><span>转发 Key</span><b>${proxyKeys.length}</b></a>
      <a class="admin-nav__link" href="#monitoring"><i class="fas fa-heartbeat" aria-hidden="true"></i><span>监控</span></a>
    </nav>
    <div class="admin-rail__foot">
      <a href="/" class="admin-nav__link"><i class="fas fa-arrow-left" aria-hidden="true"></i><span>返回首页</span></a>
      <a href="/admin/logout" class="admin-nav__link"><i class="fas fa-sign-out-alt" aria-hidden="true"></i><span>退出登录</span></a>
    </div>
  </aside>

  <div class="admin-main">
    <header class="admin-topbar">
      <a class="brand" href="/"><span class="brand__mark" aria-hidden="true"><i class="fas fa-cloud"></i></span><span class="brand__name">${SITE_CONFIG.title}</span></a>
      <nav aria-label="移动端控制台导航"><a href="#overview">概览</a><a href="#providers">提供商</a><a href="#model-groups">模型组</a><a href="#proxy-keys">Key</a><a href="#monitoring">监控</a></nav>
      <a class="icon-btn" href="/admin/logout" aria-label="退出登录"><i class="fas fa-sign-out-alt" aria-hidden="true"></i></a>
    </header>

    <main class="admin-content">
      <div id="toast" class="hd toast" role="status" aria-live="polite"></div>

      <section id="overview" class="admin-overview" aria-labelledby="admin-title">
        <div class="admin-heading">
          <div><p class="eyebrow"><span aria-hidden="true"></span>GATEWAY STATUS</p><h1 id="admin-title">管理控制台</h1><p>配置提供商、模型与客户端访问凭据。变更将写入 Cloudflare KV。</p></div>
          <div class="admin-heading__actions"><a href="/" class="btn btn-s"><i class="fas fa-external-link-alt" aria-hidden="true"></i>查看模型列表</a></div>
        </div>
        <div class="admin-metrics" aria-label="配置统计">
          <div><span>${providers.length}</span><p>提供商</p><small>${enabledProvidersCount} 个已启用</small></div>
          <div><span>${modelsCount}</span><p>模型</p><small>${enabledModelsCount} 个可用</small></div>
          <div><span>${proxyKeys.length}</span><p>转发 Key</p><small>${enabledProxyKeysCount} 个可用</small></div>
          <div><span class="status-dot status-dot--online"><i aria-hidden="true"></i>已配置</span><p>存储</p><small>Cloudflare KV</small></div>
        </div>
      </section>

      <section id="providers" class="workspace-section" aria-labelledby="providers-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="providers-title">提供商</h2><p>管理上游地址、协议、API Key 和模型。</p></div>
          <button class="btn btn-p" onclick="showAdd()"><i class="fas fa-plus" aria-hidden="true"></i>添加提供商</button>
        </div>

        <div class="af-w">
          <div id="af" class="hd add-form-panel">
            <div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-plus" aria-hidden="true"></i></span><div><h3>添加新提供商</h3><p>先配置基本信息，再测试 Key 与模型连接。</p></div></div><button class="icon-btn" type="button" onclick="hideAdd()" aria-label="关闭添加表单"><i class="fas fa-times" aria-hidden="true"></i></button></div>
            <div class="fr">
              <div class="fg"><label for="anm">名称</label><input type="text" id="anm" placeholder="DeepSeek"></div>
              <div class="fg"><label for="aid">提供商 ID</label><input type="text" id="aid" placeholder="deepseek"><span class="form-helper">用于模型前缀，创建后不可修改。</span></div>
            </div>
            <div class="fg"><label for="aurl">API 地址</label><input type="url" id="aurl" placeholder="https://api.deepseek.com"></div>
            <div class="fg"><label for="afmt">API 格式</label><select id="afmt" class="select-sm"><option value="openai">OpenAI 兼容</option><option value="anthropic">Anthropic 兼容</option></select></div>
            <fieldset class="form-group"><legend>上游 API Keys</legend><div id="akeys"><div class="fc mb-4 field-row"><input type="text" placeholder="sk-xxx" class="fx1 aki" aria-label="上游 API Key"><label class="tg" title="启用 Key"><input type="checkbox" checked class="ake" aria-label="启用 Key"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button><button class="icon-btn" onclick="testNewAKey(this)" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><button class="btn btn-s" onclick="addAKeyRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加 Key</button></fieldset>
            <aside id="amc" class="hd mdl-list-panel"><div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-cube" aria-hidden="true"></i></span><div><h3>可用模型</h3><p>点击“+”添加到配置。</p></div></div><button class="icon-btn" type="button" onclick="hideMdlPanel('amc')" title="关闭可用模型" aria-label="关闭可用模型"><i class="fas fa-times" aria-hidden="true"></i></button></div><div id="amcl"></div></aside>
            <fieldset class="form-group"><legend>模型 ID</legend><div id="amodels"><div class="fc mb-4 field-row"><input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg" title="启用模型"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制模型 ID" aria-label="复制模型 ID"><i class="far fa-copy" aria-hidden="true"></i></button><button class="icon-btn" onclick="testNewMdl(this)" title="测试模型" aria-label="测试模型"><i class="fas fa-plug" aria-hidden="true"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除模型" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div></div><button class="btn btn-s" onclick="addMdlRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加模型</button></fieldset>
            <fieldset class="form-group"><legend>加入梯队</legend><div class="fr"><div class="fg"><label for="agroup">目标模型组</label><select id="agroup"><option value="">不加入梯队</option><option value="auto-task">auto-task（一梯队主力）</option><option value="auto-task-backup">auto-task-backup（二梯队备用）</option></select></div><div class="fg"><label for="atier">梯队级别</label><select id="atier"><option value="primary">一梯队（主力）</option><option value="backup">二梯队（备用）</option></select></div></div><p class="form-helper">新建 provider 默认 pending，需调用 test-status 验证通过后才能被路由使用。选梯队只是决定验证通过后进哪个梯队。</p></fieldset>
            <div class="panel-actions"><label class="switch-label"><span>创建后立即启用</span><span class="tg"><input type="checkbox" checked id="aen"><span class="sl"></span></span></label><div><button class="btn btn-s" onclick="hideAdd()">取消</button><button class="btn btn-p" onclick="createProv()"><i class="fas fa-check" aria-hidden="true"></i>创建提供商</button></div></div>
            <div id="atestR" class="mt-1" aria-live="polite"></div>
          </div>
        </div>

        <div class="gp provider-list" id="plist">
          ${providers.length ? providers.map(p=>`
          <article class="pi" data-id="${escapePageHtml(p.id)}">
            <div class="ps" onclick="tog('${p.id}')" role="button" tabindex="0" onkeydown="if(event.key==='Enter'||event.key===' '){event.preventDefault();tog('${p.id}')}" aria-controls="dt-${escapePageHtml(p.id)}">
              <div class="l"><i class="fas fa-chevron-right provider-chevron" aria-hidden="true" id="ch-${escapePageHtml(p.id)}"></i><span class="provider-avatar" aria-hidden="true">${escapePageHtml(p.name.charAt(0).toUpperCase() || 'A')}</span><div><h3>${escapePageHtml(p.name)} <span class="status-badge status-${p.status || 'active'}">${p.status === 'pending' ? '待验证' : p.status === 'disabled' ? '已禁用' : '可用'}</span></h3><div class="pu"><code>${escapePageHtml(p.id)}</code><span>${(p.apiType||'openai')==='anthropic'?'Anthropic':'OpenAI'}</span><span>${p.apiKeys.length} Keys</span><span>${p.models.length} 模型</span></div></div></div>
              <div class="fc fx-s0" onclick="event.stopPropagation()"><label class="tg"><input type="checkbox" ${p.enabled?'checked':''} id="en-${escapePageHtml(p.id)}" onchange="togglePb('${p.id}',this.checked)" aria-label="启用 ${escapePageHtml(p.name)}"><span class="sl"></span></label><span class="bd ${p.enabled?'bd-on':'bd-off'}">${p.enabled?'已启用':'未启用'}</span></div>
            </div>
            <div class="pd" id="dt-${escapePageHtml(p.id)}">
              <div class="detail-heading"><div><h3>编辑 ${escapePageHtml(p.name)}</h3><p>保存后，新配置会用于后续转发请求。</p></div><span class="protocol-chip">${(p.apiType||'openai')==='anthropic'?'ANTHROPIC':'OPENAI'}</span></div>
              <div class="fr"><div class="fg"><label>名称</label><input type="text" id="nm-${escapePageHtml(p.id)}" value="${escapePageHtml(p.name)}"></div><div class="fg"><label>ID</label><input type="text" value="${escapePageHtml(p.id)}" disabled></div></div>
              <div class="fg"><label>API 地址</label><input type="url" id="url-${escapePageHtml(p.id)}" value="${escapePageHtml(p.baseUrl)}"></div>
              <div class="fg"><label>API 格式</label><select id="at-${escapePageHtml(p.id)}" class="select-sm"><option value="openai" ${(p.apiType||'openai')==='openai'?'selected':''}>OpenAI 兼容</option><option value="anthropic" ${p.apiType==='anthropic'?'selected':''}>Anthropic 兼容</option></select></div>
              <fieldset class="form-group"><legend>上游 API Keys</legend><div id="keys-${escapePageHtml(p.id)}">${p.apiKeys.map((k, ki)=>`<div class="fc mb-3 field-row" data-kidx="${ki}"><input type="text" value="${escapePageHtml(k.key)}" class="fx1" id="k-${escapePageHtml(p.id)}-${ki}" placeholder="API Key" aria-label="API Key"><label class="tg"><input type="checkbox" ${k.enabled?'checked':''} id="ken-${escapePageHtml(p.id)}-${ki}" aria-label="启用 Key"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button><button class="icon-btn" onclick="testKeyRow('${p.id}',${ki})" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug" aria-hidden="true"></i></button><button class="icon-btn" onclick="rmKeyRow('${p.id}',${ki})" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times" aria-hidden="true"></i></button></div>`).join('')}</div><div class="fc mt-1 field-row"><input type="text" id="nk-${escapePageHtml(p.id)}" placeholder="新的 API Key" class="fx1"><button class="btn btn-s" onclick="addKeyRow('${p.id}')"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div></fieldset>
              <fieldset class="form-group"><legend>模型</legend><div id="ml-${escapePageHtml(p.id)}">${p.models.map((m,mi)=>`<div class="fc mb-3 field-row" data-idx="${mi}"><input type="text" value="${escapePageHtml(m.id)}" class="fx1" id="mid-${escapePageHtml(p.id)}-${mi}" placeholder="模型 ID"><label class="tg"><input type="checkbox" ${m.enabled?'checked':''} id="men-${escapePageHtml(p.id)}-${mi}" aria-label="启用模型"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制模型 ID" aria-label="复制模型 ID"><i class="far fa-copy" aria-hidden="true"></i></button><button class="icon-btn" onclick="testMdl('${p.id}','${m.id}',${mi})" title="测试模型" aria-label="测试模型"><i class="fas fa-plug" aria-hidden="true"></i></button><button class="icon-btn" onclick="rmMdl('${p.id}',${mi})" title="移除模型" aria-label="移除模型"><i class="fas fa-times" aria-hidden="true"></i></button></div>`).join('')}</div><div class="fc mt-1 field-row"><input type="text" id="nmid-${escapePageHtml(p.id)}" placeholder="新的模型 ID" class="fx1"><button class="btn btn-s" onclick="addMdl('${p.id}')"><i class="fas fa-plus" aria-hidden="true"></i>添加</button></div></fieldset>
              <fieldset class="form-group"><legend>梯队（编辑后自动迁移）</legend><div class="fr"><div class="fg"><label>目标模型组</label><select id="eg-${escapePageHtml(p.id)}"><option value="">不加入梯队</option><option value="auto-task" ${p.groupId==='auto-task'?'selected':''}>auto-task（一梯队主力）</option><option value="auto-task-backup" ${p.groupId==='auto-task-backup'?'selected':''}>auto-task-backup（二梯队备用）</option></select></div><div class="fg"><label>梯队级别</label><select id="et-${escapePageHtml(p.id)}"><option value="primary" ${p.tier==='primary'?'selected':''}>一梯队（主力）</option><option value="backup" ${p.tier==='backup'?'selected':''}>二梯队（备用）</option></select></div></div><p class="form-helper">选择梯队并保存后，会将此提供商从原梯队移除并加入新梯队（含所有模型引用），同时写回此提供商的梯队信息。</p></fieldset>
              <div class="detail-actions"><div id="tr-${escapePageHtml(p.id)}" aria-live="polite"></div><div>${p.id === 'opencode' ? '<button class="btn btn-s" onclick="fetchEditModels(\'' + p.id + '\')"><i class="fas fa-download" aria-hidden="true"></i>获取模型</button>' : ''}<button class="btn btn-d" onclick="del('${p.id}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button><button class="btn btn-p" onclick="save('${p.id}')"><i class="fas fa-save" aria-hidden="true"></i>保存更改</button></div></div>
            </div>
          </article>`).join('') : `<div class="empty-state"><i class="fas fa-server" aria-hidden="true"></i><h3>还没有提供商</h3><p>添加第一个上游提供商，配置 API 地址、Key 和模型。</p><button class="btn btn-p" onclick="showAdd()">添加提供商</button></div>`}
        </div>
      </section>

      <section id="model-groups" class="workspace-section" aria-labelledby="model-groups-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="model-groups-title">模型组</h2><p>将多个提供商/模型编排成分层梯队。<b class="tag-multimodal">多模态</b>标记的分组用于视觉/图片/视频等能力，供外部系统（如 Hermes auxiliary.vision）识别调用。</p></div>
          <button class="btn btn-p" onclick="showAddGroup()"><i class="fas fa-plus" aria-hidden="true"></i>创建模型组</button>
        </div>

        <div class="af-w">
          <div id="agf" class="hd add-form-panel">
            <div class="panel-heading"><div><span class="panel-heading__mark"><i class="fas fa-layer-group" aria-hidden="true"></i></span><div><h3>创建模型组</h3><p>成员格式：提供商ID/模型ID 或 嵌套 group/分组ID。</p></div></div><button class="icon-btn" type="button" onclick="hideAddGroup()" aria-label="关闭创建表单"><i class="fas fa-times" aria-hidden="true"></i></button></div>
            <div class="fr">
              <div class="fg"><label for="agn">名称</label><input type="text" id="agn" placeholder="视觉模型池"></div>
              <div class="fg"><label for="agi">分组 ID</label><input type="text" id="agi" placeholder="vision-pool"><span class="form-helper">用于模型前缀 group/xxx，创建后不可修改。</span></div>
            </div>
            <div class="fg"><label for="agi-enabled">启用状态</label><label class="switch-label"><span>创建后立即启用</span><span class="tg"><input type="checkbox" checked id="agien"><span class="sl"></span></span></label></div>
            <div class="fg"><label for="agmultimodal">多模态分组</label><label class="switch-label"><span>用于视觉/图片/视频等多模态任务</span><span class="tg"><input type="checkbox" id="agmm"><span class="sl"></span></span></label></div>
            <fieldset class="form-group"><legend>成员模型</legend><div id="agmembers"><div class="fc mb-3 field-row"><input type="text" placeholder="agnes/agnes-2.5-flash" class="fx1 agmi" aria-label="成员模型"></div></div><button class="btn btn-s" onclick="addAGMemberRow()"><i class="fas fa-plus" aria-hidden="true"></i>添加成员</button> <span class="form-helper">也可在下方从「可用模型」快速勾选。</span></fieldset>
            <fieldset class="form-group"><legend>可用模型（点击添加）</legend><div id="agavail">${renderAvailableModels(providers)}</div></fieldset>
            <div class="panel-actions"><div><button class="btn btn-s" onclick="hideAddGroup()">取消</button><button class="btn btn-p" onclick="createGroup()"><i class="fas fa-check" aria-hidden="true"></i>创建模型组</button></div></div>
            <div id="agtestR" class="mt-1" aria-live="polite"></div>
          </div>
        </div>

        <div class="group-list" id="group-list">
          ${modelGroups.length===0?'<div class="empty-state"><i class="fas fa-layer-group" aria-hidden="true"></i><h3>暂无模型组</h3><p>创建模型组后，可通过 <code>group/分组ID</code> 调用。</p><button class="btn btn-p" onclick="showAddGroup()">创建模型组</button></div>':''}
          ${modelGroups.map((g) => `
          <article class="gi" data-id="${escapePageHtml(g.id)}" data-name="${escapePageHtml(g.name)}" data-multimodal="${g.multimodal?'1':'0'}">
            <div class="pi">
              <div class="cii">
                <div class="ci-ico"><i class="fas ${g.multimodal?'fa-eye':'fa-layer-group'}" aria-hidden="true"></i></div>
                <div><strong class="gname">${escapePageHtml(g.name)}</strong>${g.multimodal?' <span class="tag-multimodal">多模态</span>':''}<p class="gmute">group/${escapePageHtml(g.id)}</p></div>
              </div>
              <div class="ci-date"><span class="gmembers-count">${g.members.length}</span> 个成员</div>
              <label class="tg" title="启用/禁用"><input type="checkbox" ${g.enabled?'checked':''} onchange="toggleGroup('${escapePageHtml(g.id)}', this.checked)"><span class="sl"></span></label>
            </div>
            <div class="members-wrap">
              <div class="gmembers">${g.members.map((m,mi)=>`<span class="chip chip-model">${escapePageHtml(m)}<button class="chip-x" onclick="removeGroupMember('${escapePageHtml(g.id)}', ${mi})" title="移除" aria-label="移除成员"><i class="fas fa-times" aria-hidden="true"></i></button></span>`).join('')}</div>
            </div>
            <div class="detail-actions">
              <div id="gr-${escapePageHtml(g.id)}" aria-live="polite"></div>
              <div>
                <label class="switch-label"><span>多模态</span><span class="tg"><input type="checkbox" ${g.multimodal?'checked':''} onchange="toggleGroupMultimodal('${escapePageHtml(g.id)}', this.checked)"><span class="sl"></span></span></label>
                <button class="btn btn-s" onclick="editGroup('${escapePageHtml(g.id)}')"><i class="fas fa-edit" aria-hidden="true"></i>编辑成员</button>
                <button class="btn btn-d" onclick="delGroup('${escapePageHtml(g.id)}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button>
              </div>
            </div>
          </article>`).join('')}
        </div>
      </section>

      <section id="proxy-keys" class="workspace-section" aria-labelledby="proxy-keys-title">
        <div class="section-heading section-heading--admin"><div><h2 id="proxy-keys-title">转发 Key</h2><p>客户端使用这些 Key 访问统一的 <code>/v1</code> 接口。</p></div><button class="btn btn-p" onclick="genKey()"><i class="fas fa-plus" aria-hidden="true"></i>生成转发 Key</button></div>
        <div class="key-list">
          ${proxyKeys.length===0?'<div class="empty-state"><i class="fas fa-key" aria-hidden="true"></i><h3>暂无转发 Key</h3><p>生成一个 Key 后，客户端才能访问网关。</p><button class="btn btn-p" onclick="genKey()">生成转发 Key</button></div>':''}
          ${proxyKeys.map(k=>`<article class="ki" data-id="${escapePageHtml(k.id)}"><div class="key-main"><span class="key-icon" aria-hidden="true"><i class="fas fa-key"></i></span><div><div class="kv"><span id="kv-${escapePageHtml(k.id)}" data-full="${escapePageHtml(k.key)}" data-vis="0">${escapePageHtml(k.key.length>12?k.key.substring(0,8)+'*****'+k.key.substring(k.key.length-4):k.key)}</span><button class="icon-btn" onclick="toggleKeyVis('${k.id}')" title="显示或隐藏" aria-label="显示或隐藏 Key"><i class="far fa-eye" aria-hidden="true"></i></button><button class="icon-btn" onclick='copyText("${escapePageHtml(k.key)}",this)' title="复制" aria-label="复制 Key"><i class="far fa-copy" aria-hidden="true"></i></button></div><div class="key-meta"><h3>${escapePageHtml(k.name)}</h3><span class="key-meta__sep" aria-hidden="true">-</span><p>创建于 ${new Date(k.createdAt).toLocaleDateString()} · ${k.expiresAt?'有效至 '+new Date(k.expiresAt).toLocaleDateString():'永久有效'}</p></div></div></div><div class="key-actions"><label class="tg"><input type="checkbox" ${k.enabled?'checked':''} onchange="toggleProxyKey('${k.id}',this.checked)" aria-label="启用 ${escapePageHtml(k.name)}"><span class="sl"></span></label><span class="bd ${k.enabled?'bd-on':'bd-off'}">${k.enabled?'已启用':'已禁用'}</span><button class="bd bd-del" onclick="rmKey('${k.id}')"><i class="fas fa-trash" aria-hidden="true"></i>删除</button></div></article>`).join('')}
        </div>
      </section>

      <section id="monitoring" class="workspace-section" aria-labelledby="monitoring-title">
        <div class="section-heading section-heading--admin">
          <div><h2 id="monitoring-title">监控</h2><p>最近请求日志、当前活跃模型与每日消耗用量。</p></div>
          <button class="btn btn-s" onclick="refreshMonitoring()"><i class="fas fa-sync-alt" aria-hidden="true"></i>刷新</button>
        </div>

        <div class="mon-grid" id="mon-active-grid" aria-label="当前活跃模型">
          <div class="mon-active-card"><h4>一梯队（auto-task）</h4><div class="mon-active-body mon-active-empty" id="mon-active-auto-task">加载中…</div></div>
          <div class="mon-active-card"><h4>二梯队（auto-task-backup）</h4><div class="mon-active-body mon-active-empty" id="mon-active-auto-task-backup">加载中…</div></div>
        </div>

        <div class="mon-controls">
          <label for="mon-provider-select" class="fg" style="margin:0;"><span style="font-size:.8125rem;color:var(--color-muted);">查看提供商</span></label>
          <select id="mon-provider-select" onchange="refreshMonitoring()">
            ${providers.length ? providers.map(p => `<option value="${escapePageHtml(p.id)}">${escapePageHtml(p.name)} (${escapePageHtml(p.id)})</option>`).join('') : '<option value="">暂无提供商</option>'}
          </select>
        </div>

        <div class="mon-active-card" style="margin-bottom:var(--space-md);">
          <h4>今日用量</h4>
          <div id="mon-usage-body">
            <p class="mon-active-empty" id="mon-usage-empty">加载中…</p>
          </div>
        </div>

        <div class="mon-active-card">
          <h4>最近请求日志（最多 80 条，最新在前）</h4>
          <div id="mon-log-body">
            <div class="mon-log-empty" id="mon-log-loading">加载中…</div>
          </div>
        </div>
      </section>
    </main>

    ${renderSiteFooter(SITE_CONFIG.title)}
  </div>
</div>

<div id="modal" class="modal-o hd" role="presentation" onclick="if(event.target===this)closeM()"><div class="modal" id="mc" role="dialog" aria-modal="true" aria-live="polite"></div></div>

<script>${SHARED_JS}
// copy
function copyText(t, el) {
  const i = el.tagName === 'I' ? el : (el.querySelector('i') || el.parentElement?.querySelector('i'))
  if (!i) { navigator.clipboard.writeText(t).catch(() => {}); return }
  const oc = i.className
  navigator.clipboard.writeText(t).then(() => {
    i.className = 'fas fa-check c-s'
    el.setAttribute('data-state', 'success')
    setTimeout(() => {
      i.className = oc
      el.removeAttribute('data-state')
    }, 1800)
  }).catch(() => {
    el.setAttribute('data-state', 'error')
  })
}

// 从当前行读取实时输入值并复制（Key 行与模型 ID 行共用）
function copyRowVal(btn) {
  const inp = btn.parentElement.querySelector('input[type=text]')
  if (inp) copyText(inp.value, btn)
}

// modal
function showM(h) { document.getElementById('mc').innerHTML = h; document.getElementById('modal').classList.remove('hd') }
function closeM() { document.getElementById('modal').classList.add('hd') }
function cM(msg) {
  return new Promise(r => {
    showM('<h3><i class="fas fa-question-circle c-p"></i> 确认</h3><p>' + msg + '</p><div class="fa"><button class="btn btn-s" onclick="closeM();r(false)">取消</button><button class="btn btn-p" onclick="closeM();r(true)">确定</button></div>')
    window.r = r
  })
}
function pM(msg, def) {
  return new Promise(r => {
    showM('<h3><i class="fas fa-pen c-p"></i> ' + msg + '</h3><div class="fg"><input type="text" id="pv" value="' + (def || '') + '" placeholder="请输入"></div><div class="fa"><button class="btn btn-s" id="pMc">取消</button><button class="btn btn-p" id="pMo">确定</button></div>')
    window.r = r
    const inp = document.getElementById('pv')
    if (inp) {
      inp.focus()
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') { closeM(); r(inp.value.trim()) }
      })
    }
    document.getElementById('pMc').addEventListener('click', function() { closeM(); r(null) })
    document.getElementById('pMo').addEventListener('click', function() { closeM(); r(inp.value.trim()) })
  })
}
function aM(msg, t) {
  const i = t === 'success' ? 'fa-check-circle c-s' : 'fa-exclamation-circle c-d'
  showM('<h3><i class="fas ' + i + '"></i> ' + (t === 'success' ? '成功' : '提示') + '</h3><p>' + msg + '</p><div class="fa"><button class="btn btn-p" onclick="closeM()">确定</button></div>')
}

function toast(msg, t) {
  const el = document.getElementById('toast')
  const i = t === 'success' ? 'fa-check-circle' : 'fa-times-circle'
  const cls = t === 'success' ? 'al-s' : 'al-e'
  el.innerHTML = '<div class="al ' + cls + '"><i class="fas ' + i + '"></i> ' + escapeHtml(msg) + '</div>'
  el.classList.remove('hd')
  setTimeout(() => el.classList.add('hd'), 3000)
}

// providers
function tog(id) {
  const d = document.getElementById('dt-' + id), c = document.getElementById('ch-' + id)
  d.classList.toggle('open')
  c.style.transform = d.classList.contains('open') ? 'rotate(90deg)' : ''
}

function showAdd() { document.getElementById('af').classList.remove('hd') }
function hideAdd() { document.getElementById('af').classList.add('hd'); document.getElementById('amc').classList.add('hd') }

// ===== 模型组管理 =====
function showAddGroup() {
  document.getElementById('agf').classList.remove('hd')
  document.getElementById('agi').removeAttribute('disabled')
  document.getElementById('agi').value = ''
  document.getElementById('agn').value = ''
  document.getElementById('agien').checked = true
  document.getElementById('agmm').checked = false
  document.getElementById('agmembers').innerHTML = '<div class="fc mb-3 field-row"><input type="text" placeholder="provider/model" class="fx1 agmi" aria-label="成员模型"></div>'
  document.getElementById('agtestR').innerHTML = ''
}
function hideAddGroup() { document.getElementById('agf').classList.add('hd') }
function addAGMemberRow() {
  document.getElementById('agmembers').insertAdjacentHTML('beforeend', '<div class="fc mb-3 field-row"><input type="text" placeholder="provider/model" class="fx1 agmi" aria-label="成员模型"></div>')
}
function addAvailToGroup(ref) {
  const members = document.getElementById('agmembers')
  const inputs = Array.from(members.querySelectorAll('.agmi')).map(i => i.value.trim()).filter(Boolean)
  if (inputs.includes(ref)) { toast('该成员已在列表中', 'error'); return }
  if (inputs.length === 0) {
    const first = members.querySelector('.agmi')
    if (first) first.value = ref
  } else {
    members.insertAdjacentHTML('beforeend', '<div class="fc mb-3 field-row"><input type="text" value="" class="fx1 agmi" aria-label="成员模型"></div>')
    const last = members.querySelector('.agmi:last-of-type')
    if (last) last.value = ref
  }
}
async function createGroup() {
  const id = document.getElementById('agi').value.trim()
  const name = document.getElementById('agn').value.trim()
  const enabled = document.getElementById('agien').checked
  const multimodal = document.getElementById('agmm').checked
  if (!id) { toast('请填写分组 ID', 'error'); return }
  const members = Array.from(document.querySelectorAll('#agmembers .agmi')).map(i => i.value.trim()).filter(Boolean)
  if (members.length === 0) { toast('请至少添加一个成员模型', 'error'); return }
  const r = await fetch('/admin/api/model-groups', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name, enabled, members, multimodal })
  })
  const d = await r.json()
  if (d.success) { toast('模型组已创建'); hideAddGroup(); refreshGroups() }
  else toast(d.message || '创建失败', 'error')
}
async function toggleGroup(id, checked) {
  const r = await fetch('/admin/api/model-groups/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checked })
  })
  const d = await r.json()
  if (!d.success) toast(d.message || '操作失败', 'error')
}
async function toggleGroupMultimodal(id, checked) {
  const r = await fetch('/admin/api/model-groups/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ multimodal: checked })
  })
  const d = await r.json()
  if (d.success) {
    const gi = document.querySelector('.gi[data-id="' + id + '"]')
    if (gi) {
      gi.dataset.multimodal = checked ? '1' : '0'
      const ico = gi.querySelector('.ci-ico i')
      if (ico) ico.className = 'fas ' + (checked ? 'fa-eye' : 'fa-layer-group')
      const nameEl = gi.querySelector('.gname')
      if (nameEl) nameEl.parentElement.innerHTML = '<strong class="gname">' + nameEl.textContent + '</strong>' + (checked ? ' <span class="tag-multimodal">多模态</span>' : '')
    }
    toast(checked ? '已标记为多模态分组' : '已取消多模态标记')
  } else toast(d.message || '操作失败', 'error')
}
function editGroup(id) {
  const gi = document.querySelector('.gi[data-id="' + id + '"]')
  if (!gi) return
  const name = (gi.dataset.name || id)
  const members = Array.from(gi.querySelectorAll('.chip-model')).map(c => c.textContent).filter(t => t && t !== '×')
  // 将现有成员渲染到编辑表单
  document.getElementById('agi').value = id
  document.getElementById('agi').setAttribute('disabled', 'disabled')
  document.getElementById('agn').value = name
  document.getElementById('agien').checked = true
  document.getElementById('agmm').checked = gi.dataset.multimodal === '1'
  document.getElementById('agmembers').innerHTML = members.map(m => '<div class="fc mb-3 field-row"><input type="text" value="' + m + '" class="fx1 agmi" aria-label="成员模型"><button class="icon-btn" onclick="this.parentElement.remove()" title="移除"><i class="fas fa-times"></i></button></div>').join('') || '<div class="fc mb-3 field-row"><input type="text" placeholder="provider/model" class="fx1 agmi" aria-label="成员模型"></div>'
  document.getElementById('agtestR').innerHTML = '<p class="form-helper">编辑模式：修改成员后点「保存模型组」。</p>'
  // 临时保存原 ID 供保存用
  window.__editGroupId = id
  document.querySelector('#agf .panel-heading h3').textContent = '编辑模型组：' + id
  const saveBtn = document.querySelector('#agf .panel-actions .btn-p')
  saveBtn.onclick = function() { saveGroup() }
  saveBtn.innerHTML = '<i class="fas fa-save" aria-hidden="true"></i>保存模型组'
  showAddGroup()
}
async function saveGroup() {
  const id = window.__editGroupId
  if (!id) return
  const name = document.getElementById('agn').value.trim()
  const multimodal = document.getElementById('agmm').checked
  const members = Array.from(document.querySelectorAll('#agmembers .agmi')).map(i => i.value.trim()).filter(Boolean)
  if (members.length === 0) { toast('请至少保留一个成员模型', 'error'); return }
  const r = await fetch('/admin/api/model-groups/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, members, multimodal })
  })
  const d = await r.json()
  if (d.success) { toast('模型组已更新'); hideAddGroup(); refreshGroups() }
  else toast(d.message || '更新失败', 'error')
}
function removeGroupMember(id, idx) {
  const gi = document.querySelector('.gi[data-id="' + id + '"]')
  if (!gi) return
  const chips = gi.querySelectorAll('.chip-model')
  const member = chips[idx] ? chips[idx].textContent.trim() : ''
  if (!member) return
  const r = fetch('/admin/api/model-groups/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ members: Array.from(gi.querySelectorAll('.chip-model')).map(c => c.textContent.trim()).filter(t => t && t !== member) })
  }).then(x => x.json()).then(d => { if (d.success) refreshGroups(); else toast(d.message || '操作失败', 'error') })
}
async function delGroup(id) {
  if (!confirm('确定删除模型组 ' + id + ' 吗？')) return
  const r = await fetch('/admin/api/model-groups/' + encodeURIComponent(id), { method: 'DELETE' })
  const d = await r.json()
  if (d.success) { toast('模型组已删除'); refreshGroups() }
  else toast(d.message || '删除失败', 'error')
}
async function refreshGroups() {
  const r = await fetch('/admin/api/model-groups')
  const d = await r.json()
  if (!d.success || !d.data) { location.reload(); return }
  const navCount = document.querySelector('.admin-nav__link[href="#model-groups"] b')
  if (navCount) navCount.textContent = d.data.length
  location.reload()  // 数据简单，直接刷新页面保证 UI 一致性
}

// aid 输入 opencode 时自动填充 API 地址
document.getElementById('aid').addEventListener('input', function() {
  if (this.value.trim() === 'opencode') {
    document.getElementById('aurl').value = '${OPENCODE_DEFAULT_URL}'
  }
})

// provider api keys (add form)
function addAKeyRow() {
  const c = document.getElementById('akeys')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" placeholder="sk-xxx" class="fx1 aki" aria-label="上游 API Key"><label class="tg"><input type="checkbox" checked class="ake" aria-label="启用 Key"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy"></i></button><button class="icon-btn" onclick="testNewAKey(this)" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times"></i></button>'
  c.appendChild(d)
}

function renderModelGrid(models, editId, providerId) {
  if (providerId === 'opencode') {
    models = (models || []).filter(function(m) {
      return m && typeof m.id === 'string' && /^[A-Za-z0-9._:/-]+$/.test(m.id) && (m.id === 'big-pickle' || m.id.endsWith('-free'))
    })
  }
  if (!models || models.length === 0) return '<span class="mu">未返回模型列表</span>'
  var h = models.map(function(m) {
    var modelId = String(m.id || '')
    var safeId = escapeHtml(modelId)
    // 动态模型 ID 必须作为 JSON 字符串参数进入 inline handler，并先做 HTML escaping；
    // 禁止把未经 JS escaping 的远端模型 ID 直接拼入 onclick。
    var jsModelId = escapePageHtml(JSON.stringify(modelId).replace(/\\u2028/g, '\\\\u2028').replace(/\\u2029/g, '\\\\u2029'))
    var jsEditId = escapePageHtml(JSON.stringify(editId || '').replace(/\\u2028/g, '\\\\u2028').replace(/\\u2029/g, '\\\\u2029'))
    var addFn = editId
      ? 'addMdlToEdit(' + jsEditId + ',' + jsModelId + ')'
      : 'addMdlToForm(' + jsModelId + ')'
    var copyFn = 'copyText(' + jsModelId + ',this)'
    return '<div class="mdl-item">' +
      '<i class="fas fa-cube"></i>' +
			'<span class="fx1 cp ov" onclick="' + copyFn + '">' + safeId + '</span>' +
      '<button class="btn btn-gh mdl-add-btn" onclick="' + addFn + '" title="添加到表单">+</button></div>'
  }).join('')
  return '<div class="grid-2-gap6">' + h + '</div>'
}

// 可用模型面板 heading（添加态静态 HTML 与编辑态动态生成共用同一结构）
function modelPanelHeading(panelId) {
  return '<div class="panel-heading"><div>' +
    '<span class="panel-heading__mark"><i class="fas fa-cube" aria-hidden="true"></i></span>' +
    '<div><h3>可用模型</h3><p>点击“+”添加到配置。</p></div></div>' +
    '<button class="icon-btn" type="button" onclick="hideMdlPanel(\\'' + panelId + '\\')" title="关闭可用模型" aria-label="关闭可用模型"><i class="fas fa-times" aria-hidden="true"></i></button></div>'
}

// 关闭可用模型面板（仅隐藏，不清空已获取的模型数据）
function hideMdlPanel(panelId) {
  document.getElementById(panelId).classList.add('hd')
}

function testNewAKey(btn) {
  const inp = btn.parentElement.querySelector('.aki'), k = inp.value.trim()
  const providerId = document.getElementById('aid').value.trim()
  if (!k && providerId !== 'opencode') { toast('请输入 API Key', 'error'); return }
  const url = document.getElementById('aurl').value.trim()
  if (!url) { toast('请先填写 API 地址', 'error'); return }
  const apiType = document.getElementById('afmt').value
  const tr = document.getElementById('atestR')
  showSpinner(tr)
  testKeyConnection(url, apiType, k, providerId).then(function(result) {
    if (result.success && result.data) {
      document.getElementById('amcl').innerHTML = renderModelGrid(result.data.data || [], null, providerId)
      document.getElementById('amc').classList.remove('hd')
    } else {
      document.getElementById('amc').classList.add('hd')
    }
    showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  })
}

let mdlCount = 1
function addMdlRow() {
  const c = document.getElementById('amodels')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" placeholder="deepseek-chat" class="fx1 ami" aria-label="模型 ID"><label class="tg"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制模型 ID" aria-label="复制模型 ID"><i class="far fa-copy"></i></button><button class="icon-btn" onclick="testNewMdl(this)" title="测试模型" aria-label="测试模型"><i class="fas fa-plug"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除模型" aria-label="移除模型"><i class="fas fa-times"></i></button>'
  c.appendChild(d)
}

function addMdlToForm(mid) {
  const c = document.getElementById('amodels')
  const d = document.createElement('div')
  d.className = 'fc mb-4 field-row'
  d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1 ami" aria-label="模型 ID"><label class="tg"><input type="checkbox" checked class="ame" aria-label="启用模型"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制模型 ID" aria-label="复制模型 ID"><i class="far fa-copy"></i></button><button class="icon-btn" onclick="testNewMdl(this)" title="测试模型" aria-label="测试模型"><i class="fas fa-plug"></i></button><button class="icon-btn" onclick="this.parentElement.remove()" title="移除模型" aria-label="移除模型"><i class="fas fa-times"></i></button>'
  c.appendChild(d)
}

function testNewMdl(btn) {
  const inp = btn.parentElement.querySelector('.ami'), mid = inp.value.trim()
  if (!mid) { toast('请输入模型 ID', 'error'); return }
  const url = document.getElementById('aurl').value.trim()
    const akeys = document.querySelectorAll('#akeys .aki')
    const configuredKey = Array.from(akeys).map(function(inp) { return inp.value.trim() }).filter(Boolean)[0] || ''
    const apiType = document.getElementById('afmt').value
    const tr = document.getElementById('atestR')
    showSpinner(tr)
  const providerId = document.getElementById('aid').value.trim()
  const apiKey = configuredKey || (providerId === 'opencode' ? '' : 'dummy')
  testModelConnection(url, apiType, apiKey, mid, providerId).then(function(result) {
    showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  })
}

async function createProv() {
  const nm = document.getElementById('anm').value.trim(), id = document.getElementById('aid').value.trim()
  const url = document.getElementById('aurl').value.trim(), apiType = document.getElementById('afmt').value
  const aki = document.querySelectorAll('#akeys .aki')
  const keys = Array.from(aki).map((inp, i) => {
    const k = inp.value.trim()
    const en = inp.parentElement.querySelector('.ake')?.checked ?? true
    return k ? { key: k, enabled: en } : null
  }).filter(Boolean)
  const ami = document.querySelectorAll('#amodels .ami')
  const models = Array.from(ami).map(inp => {
    const mid = inp.value.trim()
    const en = inp.parentElement.querySelector('.ame')?.checked ?? true
    return mid ? { id: mid, enabled: en } : null
  }).filter(Boolean)
  const enabled = document.getElementById('aen').checked
  // 梯队选择
  const groupId = document.getElementById('agroup')?.value || undefined
  const tier = document.getElementById('atier')?.value || undefined
  if (!nm || !id || !url) { toast('请填写名称、ID 和 API 地址', 'error'); return }
  const r = await fetch('/admin/api/providers', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: nm, baseUrl: url, apiType, apiKeys: keys, models, enabled, groupId, tier })
  })
  const d = await r.json()
  if (d.success) { toast('已创建', 'success'); location.reload() }
  else toast(d.message || '创建失败', 'error')
}

// provider api keys (edit)
function getKeys(id) {
  const c = document.getElementById('keys-' + id)
  const items = c.querySelectorAll('[data-kidx]')
  return Array.from(items).map(item => {
    const idx = parseInt(item.dataset.kidx)
    const k = document.getElementById('k-' + id + '-' + idx).value.trim()
    const en = document.getElementById('ken-' + id + '-' + idx).checked
    return k ? { key: k, enabled: en } : null
  }).filter(Boolean)
}

function addKeyRow(id) {
  const inp = document.getElementById('nk-' + id), k = inp.value.trim()
  if (!k) { toast('请输入 API Key', 'error'); return }
  const c = document.getElementById('keys-' + id), cnt = c.querySelectorAll('[data-kidx]').length
  const d = document.createElement('div')
  d.className = 'fc mb-3 field-row'
  d.dataset.kidx = cnt
  d.innerHTML = '<input type="text" value="' + k + '" class="fx1" id="k-' + id + '-' + cnt + '" placeholder="API Key"><label class="tg"><input type="checkbox" checked id="ken-' + id + '-' + cnt + '"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制 Key" aria-label="复制 Key"><i class="far fa-copy"></i></button><button class="icon-btn" onclick="testKeyRow(\\'' + id + '\\',' + cnt + ')" title="测试 Key" aria-label="测试 Key"><i class="fas fa-plug"></i></button><button class="icon-btn" onclick="rmKeyRow(\\'' + id + '\\',' + cnt + ')" title="移除 Key" aria-label="移除 Key"><i class="fas fa-times"></i></button>'
  c.appendChild(d)
  inp.value = ''
  inp.focus()
}

function rmKeyRow(id, idx) {
  const c = document.getElementById('keys-' + id)
  c.querySelectorAll('[data-kidx]').forEach(item => {
    if (parseInt(item.dataset.kidx) === idx) item.remove()
  })
}

async function testKeyRow(id, idx) {
  const k = document.getElementById('k-' + id + '-' + idx).value.trim()
  const url = document.getElementById('url-' + id).value.trim()
  if (!k) { toast('请输入 API Key', 'error'); return }
  const apiType = document.getElementById('at-' + id).value
  const tr = document.getElementById('tr-' + id)
  showSpinner(tr)
  const result = await testKeyConnection(url, apiType, k, id)
  showResult(tr, result.success, result.success ? '' : 'HTTP ' + result.status)
  if (result.success && result.data) {
    showEditModelsList(id, result.data.data || [])
  }
}

// opencode 编辑表单 — 获取模型（复用 testKeyConnection 逻辑）
async function fetchEditModels(id) {
  const url = document.getElementById('url-' + id).value.trim()
  const keys = getKeys(id)
  const apiKey = keys.length > 0 ? keys[0].key : ''
  const apiType = document.getElementById('at-' + id).value
  const tr = document.getElementById('tr-' + id)
  showSpinner(tr)
  const result = await testKeyConnection(url, apiType, apiKey, id)
  showResult(tr, result.success, result.success ? '' : escapeHtml(result.message || '获取模型失败'))
  if (result.success && result.data) {
    showEditModelsList(id, result.data.data || [])
  }
}

function showEditModelsList(id, models) {
  const cid = 'mel-' + id
  let el = document.getElementById(cid)
  if (!el) {
    // 以 API Keys fieldset 为锚点插入，结构与添加态的 #amc 对称
    const keysFs = document.getElementById('keys-' + id).closest('fieldset')
    el = document.createElement('aside')
    el.id = cid
    el.className = 'mdl-list-panel'
    el.innerHTML = modelPanelHeading(cid) + '<div id="melc-' + id + '"></div>'
    keysFs.insertAdjacentElement('afterend', el)
  }
  el.classList.remove('hd')
  document.getElementById('melc-' + id).innerHTML = renderModelGrid(models, id, id)
}

function addMdlToEdit(id, mid) {
  document.getElementById('nmid-' + id).value = mid
  addMdl(id)
}

function getMdl(id) {
  const c = document.getElementById('ml-' + id), items = c.querySelectorAll('[data-idx]')
  return Array.from(items).map(item => {
    const idx = parseInt(item.dataset.idx), mid = document.getElementById('mid-' + id + '-' + idx).value.trim()
    const en = document.getElementById('men-' + id + '-' + idx).checked
    return mid ? { id: mid, enabled: en } : null
  }).filter(Boolean)
}

async function save(id) {
  const nm = document.getElementById('nm-' + id).value.trim(), url = document.getElementById('url-' + id).value.trim()
  const apiType = document.getElementById('at-' + id).value
  const keys = getKeys(id)
  const models = getMdl(id), enabled = document.getElementById('en-' + id).checked
  // 梯队（编辑迁移）
  const groupId = document.getElementById('eg-' + id)?.value || undefined
  const tier = document.getElementById('et-' + id)?.value || undefined
  const r = await fetch('/admin/api/providers/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nm, baseUrl: url, apiType, apiKeys: keys, models, enabled, groupId, tier })
  })
  const d = await r.json()
  if (d.success) { toast('已保存', 'success'); location.reload() }
  else toast(d.message || '保存失败', 'error')
}

async function del(id) {
  if (!(await cM('确定要删除此提供商？'))) return
  const r = await fetch('/admin/api/providers/' + encodeURIComponent(id), { method: 'DELETE' })
  const d = await r.json()
  if (d.success) { toast('已删除', 'success'); location.reload() }
  else toast(d.message || '删除失败', 'error')
}

function addMdl(id) {
  const inp = document.getElementById('nmid-' + id), mid = inp.value.trim()
  if (!mid) { toast('请输入模型 ID', 'error'); return }
  const c = document.getElementById('ml-' + id), cnt = c.querySelectorAll('[data-idx]').length
  const d = document.createElement('div')
  d.className = 'fc mb-3 field-row'
  d.dataset.idx = cnt
  d.innerHTML = '<input type="text" value="' + escapeHtml(mid) + '" class="fx1" id="mid-' + escapeHtml(id) + '-' + cnt + '" placeholder="模型 ID"><label class="tg"><input type="checkbox" checked id="men-' + escapeHtml(id) + '-' + cnt + '"><span class="sl"></span></label><button class="icon-btn" onclick="copyRowVal(this)" title="复制模型 ID" aria-label="复制模型 ID"><i class="far fa-copy"></i></button><button class="icon-btn" id="tm-' + escapeHtml(id) + '-' + cnt + '" title="测试模型" aria-label="测试模型"><i class="fas fa-plug"></i></button><button class="icon-btn" id="rm-' + escapeHtml(id) + '-' + cnt + '" title="移除模型" aria-label="移除模型"><i class="fas fa-times"></i></button>'
  c.appendChild(d)
  document.getElementById('tm-' + id + '-' + cnt).addEventListener('click', function() { testMdlNew(id, mid, cnt) })
  document.getElementById('rm-' + id + '-' + cnt).addEventListener('click', function() { rmMdl(id, cnt) })
  inp.value = ''
}

function rmMdl(id, idx) {
  const c = document.getElementById('ml-' + id)
  c.querySelectorAll('[data-idx]').forEach(item => {
    if (parseInt(item.dataset.idx) === idx) item.remove()
  })
}

async function testMdl(id, mid, idx) {
  const tr = document.getElementById('tr-' + id)
  showSpinner(tr)
  try {
    const r = await fetch('/admin/api/providers/' + encodeURIComponent(id) + '/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modelId: mid })
    })
    const d = await r.json()
    if (d.success && d.data) {
      showResult(tr, d.data.success, d.data.success ? '' : (d.data.message || '连接失败'))
    } else {
      showResult(tr, false, d.message || '测试失败')
    }
  } catch (e) { showResult(tr, false, '请求失败') }
}

// 编辑页新增模型行的测试：直接向上游 API 验证模型（绕过 KV 预检查）
// 新添加的模型尚未写入 KV，走 testMdl 会命中 handleTestModel 的
// "模型不存在于提供商" 预检查。这里改用 /admin/api/test-model，
// 用表单当前的 url/apiKey/apiType 直接向真实的 chat/completions 端点发请求。
async function testMdlNew(id, mid, idx) {
  if (!mid) { toast('请输入模型 ID', 'error'); return }
  const url = document.getElementById('url-' + id).value.trim()
  const keys = getKeys(id)
  const apiKey = keys.length > 0 ? keys[0].key : ''
  const apiType = document.getElementById('at-' + id).value
  const tr = document.getElementById('tr-' + id)
  showSpinner(tr)
  try {
    const r = await fetch('/admin/api/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, apiKey, apiType, model: mid, providerId: id })
    })
    const d = await r.json()
    if (d.success && d.data) {
      const ok = d.data.success
      showResult(tr, ok, ok ? '' : (d.data.message || ('HTTP ' + (d.data.statusCode || '?'))))
    } else {
      showResult(tr, false, d.message || '测试失败')
    }
  } catch (e) { showResult(tr, false, '请求失败') }
}

// proxy keys
async function genKey() {
  const name = await pM('输入 Key 名称（可选）')
  if (name === null) return
  showM('<h3><i class="fas fa-key c-p"></i> 生成转发 Key</h3><div class="fg"><label>有效期</label><select id="exp"><option value="30d">30 天</option><option value="90d">90 天</option><option value="180d">180 天</option><option value="1y">1 年</option><option value="forever" selected>永久</option></select></div><div class="fa"><button class="btn btn-s" id="gKc">取消</button><button class="btn btn-p" id="gKo">生成</button></div>')
  document.getElementById('gKc').addEventListener('click', closeM)
  document.getElementById('gKo').addEventListener('click', function() { doGenKey(document.getElementById('exp').value, name) })
}

async function doGenKey(exp, name) {
  closeM()
  const nm = name || ''
  const r = await fetch('/admin/api/proxy-keys', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: nm, expiresIn: exp })
  })
  const d = await r.json()
  if (d.success && d.data) {
    showM('<h3><i class="fas fa-check-circle c-s"></i> 生成成功</h3><p>请妥善保存，切勿泄露：</p><div class="mk">' + d.data.key + '</div><div class="fa"><button class="btn btn-p" onclick="closeM();location.reload()">关闭</button></div>')
  } else toast(d.message || '生成失败', 'error')
}

async function rmKey(id) {
  if (!(await cM('确定要删除此 Key？'))) return
  const r = await fetch('/admin/api/proxy-keys/' + encodeURIComponent(id), { method: 'DELETE' })
  const d = await r.json()
  if (d.success) { toast('已删除', 'success'); location.reload() }
  else toast(d.message || '删除失败', 'error')
}

// proxy key list interactions
async function togglePb(id, checked) {
  const pi = document.querySelector('.pi[data-id="' + id + '"]')
  if (!pi) return
  const b = pi.querySelector('.ps .bd')
  if (b) { b.textContent = checked ? '已启用' : '未启用'; b.className = 'bd ' + (checked ? 'bd-on' : 'bd-off') }
  const r = await fetch('/admin/api/providers/' + encodeURIComponent(id), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checked })
  })
  const d = await r.json()
  if (!d.success) toast(d.message || '操作失败', 'error')
}

function toggleKeyVis(id) {
  const el = document.getElementById('kv-' + id)
  const full = el.dataset.full
  const vis = el.dataset.vis === '1'
  if (vis) {
    el.textContent = full.length > 12
      ? full.substring(0, 8) + '*****' + full.substring(full.length - 4)
      : full
    el.dataset.vis = '0'
  } else {
    el.textContent = full
    el.dataset.vis = '1'
  }
}

async function toggleProxyKey(id, checked) {
  const r = await fetch('/admin/api/proxy-keys/' + encodeURIComponent(id), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: checked })
  })
  const d = await r.json()
  if (d.success) {
    const ki = document.querySelector('.ki[data-id="' + id + '"]')
    if (ki) {
      const b = ki.querySelector('.fc .bd')
      if (b) { b.textContent = checked ? '已启用' : '已禁用'; b.className = 'bd ' + (checked ? 'bd-on' : 'bd-off') }
    }
  } else toast(d.message || '操作失败', 'error')
}

// 中文说明：根据点击和 URL 锚点同步侧栏选中态，避免导航始终停留在“概览”。
const adminNavLinks = Array.from(document.querySelectorAll('.admin-nav a[href^="#"]'))
function setActiveAdminNav(hash) {
  const targetHash = adminNavLinks.some(function (link) { return link.getAttribute('href') === hash }) ? hash : '#overview'
  adminNavLinks.forEach(function (link) {
    const active = link.getAttribute('href') === targetHash
    link.classList.toggle('is-active', active)
    if (active) link.setAttribute('aria-current', 'page')
    else link.removeAttribute('aria-current')
  })
}
adminNavLinks.forEach(function (link) {
  link.addEventListener('click', function () { setActiveAdminNav(link.getAttribute('href') || '#overview') })
})
window.addEventListener('hashchange', function () { setActiveAdminNav(location.hash) })
setActiveAdminNav(location.hash)

// ===== 监控面板 =====
function monStatusClass(status) {
  if (status === 429) return 'mon-status-429'
  if (status >= 500) return 'mon-status-5xx'
  if (status >= 400) return 'mon-status-4xx'
  return 'mon-status-2xx'
}
function monFmtTime(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0')
}
function monFmtAgo(ts) {
  const diff = Math.max(0, Date.now() - ts)
  if (diff < 60000) return Math.floor(diff / 1000) + ' 秒前'
  if (diff < 3600000) return Math.floor(diff / 60000) + ' 分钟前'
  return Math.floor(diff / 3600000) + ' 小时前'
}
async function loadLastActive(scope, elId) {
  const el = document.getElementById(elId)
  if (!el) return
  try {
    const r = await fetch('/admin/api/telemetry/last-active?scope=' + encodeURIComponent(scope))
    const d = await r.json()
    if (d.success && d.data) {
      el.classList.remove('mon-active-empty')
      el.innerHTML = escapeHtml(d.data.providerId) + ' / ' + escapeHtml(d.data.modelId) + '<br>' + escapeHtml(d.data.keyMasked) + ' · ' + monFmtAgo(d.data.ts)
    } else {
      el.classList.add('mon-active-empty')
      el.textContent = '暂无记录'
    }
  } catch (e) {
    el.classList.add('mon-active-empty')
    el.textContent = '加载失败'
  }
}
async function loadUsage(providerId) {
  const body = document.getElementById('mon-usage-body')
  if (!body) return
  if (!providerId) { body.innerHTML = '<p class="mon-active-empty">请先选择提供商</p>'; return }
  try {
    const r = await fetch('/admin/api/telemetry/usage/' + encodeURIComponent(providerId))
    const d = await r.json()
    const usage = (d.success && d.data) ? d.data : { tokensIn: 0, tokensOut: 0, requests: 0 }
    const totalTokens = (usage.tokensIn || 0) + (usage.tokensOut || 0)
    body.innerHTML = '<p style="font-size:.8125rem;color:var(--color-muted);margin:0;">今日请求 <strong style="color:var(--color-ink);">' + usage.requests + '</strong> 次 · Token 输入 <strong style="color:var(--color-ink);">' + (usage.tokensIn||0) + '</strong> · 输出 <strong style="color:var(--color-ink);">' + (usage.tokensOut||0) + '</strong>（合计 ' + totalTokens + '）</p><p style="font-size:.75rem;color:var(--color-muted);margin-top:.25rem;">仅统计展示，不做用量限制；流式请求的 token 数暂无法解析，按 0 计。</p>'
  } catch (e) {
    body.innerHTML = '<p class="mon-active-empty">加载失败</p>'
  }
}
async function loadLog(providerId) {
  const body = document.getElementById('mon-log-body')
  if (!body) return
  if (!providerId) { body.innerHTML = '<div class="mon-log-empty">请先选择提供商</div>'; return }
  try {
    const r = await fetch('/admin/api/telemetry/log/' + encodeURIComponent(providerId))
    const d = await r.json()
    const log = (d.success && Array.isArray(d.data)) ? d.data.slice().reverse() : []
    if (log.length === 0) { body.innerHTML = '<div class="mon-log-empty">暂无请求记录</div>'; return }
    let html = '<table class="mon-log-table"><thead><tr><th>时间</th><th>状态</th><th>模型</th><th>Key</th><th>耗时</th><th>结果</th></tr></thead><tbody>'
    log.forEach(function (ev) {
      const outcomeText = ev.outcome === 'success' ? '成功' : (ev.outcome === 'retry' ? '重试' : '失败')
      html += '<tr><td>' + monFmtTime(ev.ts) + '</td><td><span class="mon-status-chip ' + monStatusClass(ev.status) + '">' + ev.status + '</span></td><td>' + escapeHtml(ev.modelId) + '</td><td>' + escapeHtml(ev.keyMasked) + '</td><td>' + ev.latencyMs + 'ms</td><td>' + outcomeText + '</td></tr>'
    })
    html += '</tbody></table>'
    body.innerHTML = html
  } catch (e) {
    body.innerHTML = '<div class="mon-log-empty">加载失败</div>'
  }
}
function refreshMonitoring() {
  loadLastActive('group/auto-task', 'mon-active-auto-task')
  loadLastActive('group/auto-task-backup', 'mon-active-auto-task-backup')
  const sel = document.getElementById('mon-provider-select')
  const providerId = sel ? sel.value : ''
  loadUsage(providerId)
  loadLog(providerId)
}
if (document.getElementById('monitoring')) {
  refreshMonitoring()
}
</script>
</body></html>`)
}