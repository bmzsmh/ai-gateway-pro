// 公共页脚渲染函数 — 主页与 /admin 页复用，保证两处页脚一致
export const SITE_REPO_URL = 'https://github.com/bmzsmh/ai-gateway-pro'
export function renderSiteFooter(title: string): string {
  return `<footer class="site-footer">
  <div class="shell site-footer__inner">
    <span>© ${new Date().getFullYear()} <a class="site-footer__link" href="${SITE_REPO_URL}" target="_blank" rel="noreferrer">${title}</a></span>
    <span>Cloudflare Workers · Hono · KV</span>
  </div>
</footer>`
}

// 共享 JS 工具函数 — 注入到后台页面的 <script> 块中
export const SHARED_JS = `
// ── 工具函数 ──
function normalizeUrl(url) {
    return url.replace(/\\/$/, '')
  }
function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
function buildAuthHeaders(apiType, key) {
  return apiType === 'anthropic'
    ? { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
    : { 'Authorization': 'Bearer ' + key }
}

// ── UI 函数 ──
function showSpinner(el) {
  el.innerHTML = '<span class="mu"><i class="fas fa-spinner fa-spin"></i> 测试中...</span>'
}
function showResult(el, success, msg) {
  el.innerHTML = success
    ? '<div class="al al-s"><i class="fas fa-check-circle"></i> 连接成功</div>'
    : '<div class="al al-e"><i class="fas fa-times-circle"></i> ' + escapeHtml(msg || '连接失败') + '</div>'
}

// ── API 请求函数 ──
// fetchJSON 带客户端超时兜底，避免任何情况下"测试中..."无限转圈
async function fetchJSON(url, opts, timeoutMs) {
  var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null
  var t = ctrl ? setTimeout(function() { ctrl.abort() }, timeoutMs || 25000) : null
  try {
    var r = await fetch(url, opts && ctrl ? Object.assign({}, opts, { signal: ctrl.signal }) : (opts || {}))
    var d = await r.json()
    return { ok: r.ok, data: d }
  } catch (e) {
    return { ok: false, data: null, error: e }
  } finally {
    if (t) clearTimeout(t)
  }
}
async function testKeyConnection(url, apiType, key, providerId) {
  try {
    var r = await fetchJSON('/admin/api/test-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, apiKey: key, apiType: apiType, providerId: providerId })
    }, 25000)
    var d = r.data
    if (r.ok && d && d.success && d.data) {
      return { success: d.data.success, status: d.data.statusCode, data: d.data.data, message: d.data.message }
    }
    return { success: false, status: 0, data: null }
  } catch (e) {
    return { success: false, status: 0, data: null }
  }
}
async function testModelConnection(url, apiType, key, modelId, providerId) {
  try {
    var r = await fetchJSON('/admin/api/test-model', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: url, apiKey: key, apiType: apiType, model: modelId, providerId: providerId })
    }, 25000)
    var d = r.data
    if (r.ok && d && d.success && d.data) {
      return { success: d.data.success, status: d.data.statusCode }
    }
    return { success: false, status: 0 }
  } catch (e) {
    return { success: false, status: 0 }
  }
}
`