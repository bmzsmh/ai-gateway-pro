import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import type { Env } from './types'
import { adminAuthMiddleware, proxyKeyAuthMiddleware, handleLogin, handleLogout } from './auth'
import { handleProxy, handleModels } from './proxy'
import {
  handleStatus,
  handleGetProviders,
  handleCreateProvider,
  handleUpdateProvider,
  handleDeleteProvider,
  handleTestModel,
  handleTestKeyNew,
  handleTestModelNew,
  handleGetProxyKeys,
  handleCreateProxyKey,
  handleUpdateProxyKey,
  handleDeleteProxyKey,
  handleGetModelGroups,
  handleCreateModelGroup,
  handleUpdateModelGroup,
  handleDeleteModelGroup,
  handleTestProviderStatus,
  handleSetProviderStatus,
  handleGetTelemetryLog,
  handleGetLastActive,
  handleGetUsage,
} from './admin'
import { renderHomePage, renderLoginPage, renderAdminPage } from './pages'
import { seedInitialData, getSession } from './storage'

const app = new Hono<{ Bindings: Env }>()

// ===== 全局中间件 =====
// 默认不开放任意浏览器跨域；如确有 Web 客户端需求，可通过 CORS_ORIGINS 显式配置。
// Server-to-server 的 Hermes/Agent 请求不受此限制。
app.use('*', async (c, next) => {
  const requestId = c.req.header('X-Request-ID')?.trim() || crypto.randomUUID()
  ;(c as any).set('requestId', requestId)
  c.header('X-Request-ID', requestId)
  return next()
})
app.use('*', async (c, next) => {
  const raw = c.env.CORS_ORIGINS?.trim()
  if (!raw) return next()
  const origins = raw.split(',').map(v => v.trim()).filter(Boolean)
  return cors({ origin: origins })(c, next)
})
app.use('*', logger())

// 首次请求时填充初始数据；用 Promise 防止同一 isolate 的并发首请求重复 seed。
let seedPromise: Promise<void> | null = null
app.use('*', async (c, next) => {
  if (!seedPromise) seedPromise = seedInitialData(c.env)
  await seedPromise
  return next()
})

// ===== 首页 =====
app.get('/', async (c) => {
  const { getCookie } = await import('hono/cookie')
  const sessionId = getCookie(c, 'session_id')
  let isLoggedIn = false
  if (sessionId) {
const session = await getSession(c.env, sessionId)
    isLoggedIn = session !== null
  }
  return renderHomePage(c, isLoggedIn)
})

// ===== 登录/退出 =====
app.get('/admin/login', async (c) => renderLoginPage(c))
app.post('/admin/login', handleLogin)
app.get('/admin/logout', handleLogout)

// ===== 管理后台（需 Session 验证） =====
app.use('/admin/*', adminAuthMiddleware)

app.get('/admin', async (c) => renderAdminPage(c))

// 系统状态
app.get('/admin/api/status', handleStatus)

// 提供商 CRUD
app.get('/admin/api/providers', handleGetProviders)
app.post('/admin/api/providers/:id/test-status', handleTestProviderStatus)
app.patch('/admin/api/providers/:id/status', handleSetProviderStatus)
app.post('/admin/api/providers', handleCreateProvider)
app.put('/admin/api/providers/:id', handleUpdateProvider)
app.delete('/admin/api/providers/:id', handleDeleteProvider)
app.post('/admin/api/providers/:id/test-model', handleTestModel)
app.post('/admin/api/test-key', handleTestKeyNew)
app.post('/admin/api/test-model', handleTestModelNew)

// 转发 Key 管理
app.get('/admin/api/proxy-keys', handleGetProxyKeys)
app.post('/admin/api/proxy-keys', handleCreateProxyKey)
app.delete('/admin/api/proxy-keys/:id', handleDeleteProxyKey)
app.patch('/admin/api/proxy-keys/:id', handleUpdateProxyKey)

// 模型组管理
app.get('/admin/api/model-groups', handleGetModelGroups)
app.post('/admin/api/model-groups', handleCreateModelGroup)
app.put('/admin/api/model-groups/:id', handleUpdateModelGroup)
app.delete('/admin/api/model-groups/:id', handleDeleteModelGroup)

// 遥测查询（第1层：只读接口，UI 面板留待第2层）
app.get('/admin/api/telemetry/log/:providerId', handleGetTelemetryLog)
app.get('/admin/api/telemetry/last-active', handleGetLastActive)
app.get('/admin/api/telemetry/usage/:providerId', handleGetUsage)

// ===== API 转发路由（需转发 Key 验证） =====
app.use('/v1/*', proxyKeyAuthMiddleware)
app.get('/v1/models', handleModels)
app.all('/v1/*', handleProxy)

// ===== 404 处理 =====
app.notFound((c) => {
  return c.json({ error: { message: '接口不存在', type: 'not_found' } }, 404)
})

// ===== 错误处理 =====
app.onError((err, c) => {
  console.error('未捕获的错误:', err)
  return c.json({ error: { message: '服务器内部错误', type: 'server_error' } }, 500)
})

export default app
