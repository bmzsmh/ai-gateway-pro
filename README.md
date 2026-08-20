# AI Gateway Pro

基于 Cloudflare Workers + Hono 的 AI 提供商 API 代理网关，统一 `/v1` 接口转发，支持多 Key 轮询、健康检查与自动故障转移。

## 功能与特性

- **统一 API 接口** — 所有 AI 提供商通过 `https://你的域名/v1` 访问，兼容 OpenAI / Anthropic 协议
- **多 Key 轮询 + 健康检查** — 每个提供商可配置多个 API Key，请求随机打乱；失败 Key 自动降权，连续失败 5 次后进入冷却
- **Key 自动恢复** — 降权 Key 冷却 5 分钟后自动获得一次试用机会，成功则恢复权重，失败则重新冷却
- **OpenCode 默认接入** — 默认启用 4 个免费模型，无需配置上游 API Key
- **OpenCode 自动故障转移** — 配置 Key 时优先官方 API，失败后使用公共镜像；无 Key 时直接使用公共镜像
- **多提供商管理** — 默认仅创建 OpenCode，支持自定义添加其他 OpenAI / Anthropic 兼容提供商
- **OpenCode 创建智能填充** — 创建提供商时 ID 输入 `opencode` 自动填充官方 API 地址，API Key 可留空，空 Key 测试时自动走镜像获取可用模型（仅显示 `-free` 和 `big-pickle` 模型）
- **OpenCode 编辑获取模型** — 编辑页可直接从镜像/官方获取模型列表，一键添加到表单
- **两级启用控制** — 提供商级别 + 模型级别的启用/禁用
- **转发 Key 认证** — 生成 `sk_cf_*` 格式的 API Key，支持有效期管理
- **模型连接测试** — 管理后台手动测试模型是否可连接（通过服务端代理，无跨域限制）
- **模型分组路由（`group/` 前缀）** — 可将多个 provider/模型组织为模型组，通过 `group/<组名>` 调用；组内随机起点轮换，成员失败自动切换，支持嵌套子组作备用梯队
- **多模态自动切换（vision-pool）** — 多模态模型（如 vision 模型）组织为 `vision-pool` 分组，单模型故障时自动切换其他多模态成员
- **遥测与监控** — 管理后台"监控"面板，实时展示各 provider/group 当前活跃模型、最近请求日志（状态码染色）与每日用量统计（纯展示，不做拦截）
- **请求安全加固** — 请求体大小限制、可配置上游超时、请求 Header 白名单、Request ID 追踪、模型 ID 运行时格式校验
- **管理后台** — 卡片式 UI，移动端自适应，无需前端构建

## 技术栈

- **运行时**：Cloudflare Workers
- **框架**：[Hono](https://hono.dev/) v4
- **存储**：Cloudflare Workers KV
- **语言**：TypeScript

## 本地开发

```bash
# 克隆项目
git clone <你的仓库地址>
cd ai-gateway
npm install

# 创建 .dev.vars（已 .gitignore）
echo ADMIN_USERNAME=admin >> .dev.vars
echo ADMIN_PASSWORD=your-password >> .dev.vars
echo OPENCODE_MIRROR_FALLBACK=false >> .dev.vars
# 如明确接受第三方镜像数据边界，再配置 OPENCODE_MIRRORS_URL

# 启动本地开发服务器
npm run dev
```

## 从零开始部署

### 前置条件

- 一个 [Cloudflare](https://dash.cloudflare.com/) 账号
- 一个 [GitHub](https://github.com/) 账号
- 本地安装 Node.js 18+ 和 npm（用于本地开发测试）

### 第一步：新建 Cloudflare Worker

在 Cloudflare Dashboard 中创建两个 Worker（生产环境和测试环境共用一套代码，通过不同的 `wrangler.toml` 配置区分）：

1. 进入 **Workers & Pages** → **创建** → **Worker**
2. 命名为 `ai-gateway`（生产环境），点击**部署**
3. 重复上述步骤，创建 `ai-gateway-test`（测试环境）
4. 建议为生产 Worker 绑定一个自定义域名，方便后续使用

### 第二步：新建 KV 命名空间

需要两个独立的 KV 命名空间（生产与测试隔离）：

1. 进入 **Workers & Pages** → **KV** → **创建命名空间**
2. 创建 `ai-gateway-kv`（生产 KV）
3. 创建 `ai-gateway-test-kv`（测试 KV）
4. 记录下两个 KV 命名空间的 **ID**（格式为 32 位十六进制字符串，如 `f8f174699b4b43b3ae29594484921b07`）

### 第三步：配置 GitHub 仓库

1. 将本仓库 Fork 或推送到你自己的 GitHub 账号
2. 进入仓库 **Settings** → **Secrets and variables** → **Actions**：
   - **Secrets**（加密存储，不可见）：
     - `CF_API_TOKEN` — Cloudflare API Token，需包含 Workers 和 KV 的编辑权限（在 Cloudflare Dashboard → **我的资料** → **API 令牌** → **创建令牌** → **Workers 编辑** 中生成）
     - `CF_ACCOUNT_ID` — Cloudflare 账号 ID（在 Cloudflare Dashboard 右侧边栏的**账号 ID** 中查看）
   - **Variables**（明文存储，工作流中可见）：
     - `KV_NAMESPACE_ID` — 生产 KV 命名空间的 ID（第二步中记录的 `ai-gateway-kv` 的 ID）
3. 进入仓库 **Settings** → **Actions** → **General** → **Workflow permissions**，确保 **Read and write permissions** 已勾选
4. 进入仓库 **Actions** 页面，确认 **Deploy to Cloudflare Workers** 工作流已自动启用（若显示为 disabled，手动启用）

### 第四步：配置 wrangler.toml

仓库中包含两个 `.example` 模板文件，基于它们创建实际配置（**不要直接提交真实凭据到仓库**）：

```bash
# 基于模板创建生产配置
cp wrangler.toml.example wrangler.toml
# 编辑 wrangler.toml，将 <YOUR_PROD_KV_NAMESPACE_ID> 替换为生产 KV ID
# 将 <YOUR_PROD_KV_NAMESPACE_ID> 替换为生产 KV ID
# Admin 凭据使用 wrangler secret put，不写入此文件

# 基于模板创建测试配置
cp wrangler-test.toml.example wrangler-test.toml
# 编辑 wrangler-test.toml，仅配置 KV；Admin 凭据也建议使用 secret put
```

两个 `.example` 文件已被 `.gitignore` 排除，不会意外提交到仓库。

### 第五步：Admin 凭据独立管理

**重要：Admin 凭据不应以明文形式存入仓库或 CI 环境变量。** 推荐以下两种方式：

**方式一：生产环境用 `wrangler secret put`（推荐）**

```bash
# 安装并登录 wrangler（需先通过 npm install -g wrangler 安装）
npx wrangler secret put ADMIN_PASSWORD --name ai-gateway
# 按提示输入密码，密码将加密存储在 Cloudflare 边缘，运行时通过环境变量注入
npx wrangler secret put ADMIN_USERNAME --name ai-gateway
# 按提示输入用户名
```

**方式二：测试环境允许在 `wrangler-test.toml` 的 `[vars]` 中明文配置**（仅限测试，不提交到仓库）

> 注意：`wrangler.toml` 和 `wrangler-test.toml` 已在 `.gitignore` 中，不会被提交到 Git 仓库。

### 第六步：首次部署

**首次部署前，KV 命名空间是空的，需要在部署后通过管理后台手动添加 provider 数据。**

**方式一：本地 wrangler 部署生产**

```bash
# 确保 wrangler.toml 已按第四步配置好
CLOUDFLARE_API_TOKEN=$(cat /root/.secrets/cf_api_token) \
CLOUDFLARE_ACCOUNT_ID=<你的账号ID> \
npx wrangler deploy
```

**方式二：GitHub Actions 自动部署**

1. 确保第三步中的 `CF_API_TOKEN`、`CF_ACCOUNT_ID`、`KV_NAMESPACE_ID` 已配置
2. 进入仓库 **Actions** 页面，选择 **Deploy to Cloudflare Workers** 工作流
3. 点击 **Run workflow** → **Run workflow**（使用 `main` 分支）
4. 等待工作流运行完成（约 2-3 分钟）

> 工作流会自动生成 `wrangler.toml`（仅含 KV 绑定）。Admin 凭据由 Cloudflare Secret 独立管理，不通过 CI 写入。OpenCode 公共镜像不会由 CI 默认启用。

### 第七步：部署后初始化

部署完成后，首次使用时 KV 中尚无 provider 数据，需要初始化：

1. 打开管理后台：`https://你的生产域名/admin` 或 `https://ai-gateway.<你的子域名>.workers.dev/admin`
2. 使用第五步中配置的用户名和密码登录
3. 在管理后台中创建需要的 AI 提供商（如 OpenCode、hc、sensenova 等），配置 API Key 和模型
4. 或通过 API 快速初始化：
   ```bash
   # 登录获取 session
   curl -X POST https://你的域名/admin/login \
     -H 'Content-Type: application/json' \
     -d '{"username":"admin","password":"你的密码"}'
   # 创建 provider 等操作详见 API.md
   ```

### 第八步：测试环境部署

测试环境独立于生产，使用不同的 KV 和凭据：

```bash
# 确保 wrangler-test.toml 已按第四步配置好
CLOUDFLARE_API_TOKEN=$(cat /root/.secrets/cf_api_token) \
CLOUDFLARE_ACCOUNT_ID=<你的账号ID> \
npx wrangler deploy --config wrangler-test.toml
```

测试环境部署完成后：
1. 访问 `https://ai-gateway-test.<你的子域名>.workers.dev/admin` 登录测试管理后台
2. 与生产环境相同的方式添加 provider 数据（或从生产导出再导入）
3. 在测试环境验证功能正常后，再执行生产部署

### 部署流程图

```
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  新建 Worker  │     │ 新建 KV 命名  │     │  配置 GitHub  │
│  ai-gateway  │──→  │  空间 × 2    │──→  │ Secrets/Vars  │
│  ai-gateway- │     │              │     │              │
│  test        │     │              │     │              │
└──────────────┘     └──────────────┘     └──────────────┘
                                                │
                                                ▼
┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│ 首次部署运行  │←──  │ 配置 example  │←──  │ wrangler     │
│ 后初始化数据  │     │  → wrangler  │     │ secret put   │
│ (管理后台)    │     │  toml × 2    │     │ Admin 凭据   │
└──────────────┘     └──────────────┘     └──────────────┘
```

> **提示**：如需完整的 CI/CD 部署流程，GitHub Actions 工作流已预配置好。首次部署后，后续每次推送代码到 `main` 分支即可触发自动部署（当前默认仅手动触发，可通过取消 `deploy.yml` 中 `push` 事件的注释启用自动部署）。

## 使用方法

- **API BASE URL**：`https://你的域名/v1`
- **API KEY**：在管理后台手动生成，格式为：`sk_cf_<KEY>`
- **模型ID**：`提供商ID/模型ID`，默认 OpenCode 模型包括：
  - `opencode/deepseek-v4-flash-free`
  - `opencode/mimo-v2.5-free`
  - `opencode/nemotron-3-ultra-free`
  - `opencode/hy3-free`

OpenCode 默认不需要上游 Key。请求首先访问配置的官方 API 地址；只有显式设置 `OPENCODE_MIRROR_FALLBACK=true`，并配置 `OPENCODE_MIRRORS_URL` 后，才会在可重试错误时访问公共/自建镜像。已有 KV 数据不会被删除，升级时仅在缺少 OpenCode 的情况下补充该默认提供商。

## 项目结构

```
ai-gateway/
├── src/
│   ├── index.ts       # 入口，路由注册
│   ├── types.ts       # 类型定义
│   ├── config.ts      # 默认配置
│   ├── storage.ts     # KV 存储层
│   ├── auth.ts        # 认证系统
│   ├── proxy.ts       # API 转发核心（Key 轮询 + 健康检查 + 自动恢复）
│   ├── opencode.ts    # OpenCode 官方 API 与公共镜像故障转移
│   ├── admin.ts       # 管理 API（含服务端 Key/模型测试代理）
│   ├── pages.ts       # 前端页面模板
│   ├── pages.css.ts   # 样式
│   └── shared.js.ts   # 共享 JS 工具函数
├── wrangler.toml
├── package.json
├── tsconfig.json
└── .github/workflows/deploy.yml
```

## License

Apache 2.0

## 鸣谢

感谢 [DuoJLa](https://github.com/DuoJLa/ai-gateway) 贡献的前端代码


## 生产级个人部署建议（v1.1）

当前项目以“个人 Agent Gateway”为目标，不追求多租户/高并发。v1.1 重点加强了请求安全、失败策略和部署安全：

- **Model Group 只对可重试错误做 fallback**：400/404/422 等客户端或配置错误会直接返回，不会把一个错误请求复制到多个上游。
- **Group 总尝试次数有限制**：默认最多 6 次上游尝试，避免 Provider × Key 数量导致一次 Agent 请求被放大。
- **请求体大小限制**：默认 5 MiB，可通过 `MAX_REQUEST_BODY_BYTES` 调整，最大 20 MiB。
- **上游超时可配置**：默认 120 秒，可通过 `REQUEST_TIMEOUT_MS` 调整，最大 10 分钟。
- **Request ID**：每个请求都会得到 `X-Request-ID`，错误响应也包含 `request_id`。
- **上游 Header/Response Header 白名单**：不会把客户端 `Authorization`、Cookie、Host 等连接级信息转发给上游。
- **429 支持 Retry-After 冷却**：Key 会暂时进入 cooldown，减少重复撞限流。
- **OpenCode 公共镜像 fallback 默认关闭**：只有显式设置 `OPENCODE_MIRROR_FALLBACK=true` 才会启用 `OPENCODE_MIRRORS_URL`。
- **Admin 登录增加 best-effort 限流**：同一 IP/用户名 5 分钟最多失败 5 次；这是 Worker isolate 级保护，不能替代 Cloudflare WAF/Access。
- **Provider / Model / Group ID 校验**：避免配置值进入 URL、HTML、JS 上下文时形成注入面。
- **Provider 测试 URL 拒绝 localhost、RFC1918、metadata 等明显 SSRF 目标**。
- **CI 不再生成管理员密码到 `wrangler.toml`**：生产环境应使用 Cloudflare Secret。

### 推荐 Secret

在 Cloudflare Worker 中配置：

```text
ADMIN_USERNAME
ADMIN_PASSWORD
```

不要把管理员密码放进 GitHub Variables、`wrangler.toml` 或仓库。

### 可选环境变量

```text
REQUEST_TIMEOUT_MS=120000
MAX_REQUEST_BODY_BYTES=5242880
OPENCODE_MIRROR_FALLBACK=false
OPENCODE_MIRRORS_URL=
CORS_ORIGINS=
```

`CORS_ORIGINS` 留空时不主动开放跨域；如果需要浏览器前端访问，填写逗号分隔的可信 Origin。

### OpenCode Mirror 数据边界

公共镜像可能收到完整的 Agent 请求内容。个人生产环境建议默认关闭：

```text
OPENCODE_MIRROR_FALLBACK=false
```

只有明确接受第三方镜像数据边界时再开启。
