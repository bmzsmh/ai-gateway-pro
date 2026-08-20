# Design — AI Gateway

A locked design system for this app. Every page redesign reads this file before emitting code. Do not regenerate per page; amend this file when the system needs to grow.

## Genre

modern-minimal — calm infrastructure UI with a cool engineered canvas, precise hairlines, one cobalt signal accent, and code as functional content.

## Macrostructure family

- Marketing pages: Workbench — endpoint-first hero, real integration steps, provider/model directory.
- App pages: Workbench control plane — persistent side rail on desktop, compact top rail on mobile, list/detail editing surface.
- Access pages: Split security entry — product context beside a focused authentication form.

## Theme

- `--color-paper` oklch(98.5% 0.004 250)
- `--color-paper-2` oklch(96.7% 0.006 250)
- `--color-paper-3` oklch(94.8% 0.008 250)
- `--color-ink` oklch(22% 0.020 258)
- `--color-ink-2` oklch(34% 0.018 257)
- `--color-muted` oklch(49% 0.016 255)
- `--color-rule` oklch(89% 0.010 252)
- `--color-rule-2` oklch(82% 0.014 252)
- `--color-accent` oklch(52% 0.205 256)
- `--color-accent-hover` oklch(46% 0.195 256)
- `--color-accent-ink` oklch(99% 0.003 250)
- `--color-focus` oklch(44% 0.180 256)
- `--color-success` oklch(45% 0.120 158)
- `--color-danger` oklch(50% 0.185 25)

Accent coverage stays below 5% of each viewport. Status colours communicate real state only.

## Typography

- Display: Space Grotesk, weight 500–600, normal style.
- Body: Inter, weight 400–600.
- Mono: JetBrains Mono, weight 400–600.
- Display tracking: `-0.025em`.
- No italic headings.

## Spacing

4-point named scale from `--space-3xs` through `--space-4xl`. Production CSS uses tokens for component spacing; no arbitrary spacing values.

## Motion

- `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`.
- Short interaction duration: 160ms; panel duration: 260ms.
- Page content is visible immediately. Only drawers/dialogs use restrained opacity/translation.
- Reduced-motion fallback removes transforms and animations.

## Microinteractions stance

- Copy actions confirm inline on the triggering control.
- Save/create actions may use a short toast because persistence is otherwise invisible.
- Errors stay visible near their context and use `aria-live` where applicable.
- Every button and field supports hover, focus-visible, active, disabled, loading, error and success styling.
- Touch targets are at least 44px.

## CTA voice

- Primary: solid cobalt, 6px radius, destination/action named explicitly.
- Secondary: paper surface with a hairline border, 6px radius.
- Dangerous: quiet red tint; destructive actions keep confirmation.

## Per-page allowances

- Homepage may use one graphite code/request panel as functional enrichment.
- Login and admin pages do not use decorative enrichment; function carries the page.
- No gradients, glass cards, fake browser chrome, fake terminal chrome, or decorative blobs.

## What pages MUST share

- Cloud mark and AI Gateway wordmark.
- Cobalt accent placement and status colour semantics.
- Typography, 44px controls, 6–10px radii, hairline borders.
- Primary/secondary/danger button voice.
- Copy feedback, focus treatment and reduced-motion behaviour.

## What pages MAY differ on

- Homepage uses an endpoint-first split workbench.
- Login uses a balanced two-column split.
- Admin uses a persistent control-plane rail and list/detail workspace.

## Responsive contract

Verified target widths: 320, 375, 414 and 768 CSS pixels. Both `html` and `body` use `overflow-x: clip`. Clickable labels do not wrap. Desktop side rail becomes a horizontally scrollable top rail below 60rem; forms and list/detail layouts collapse to one column.


## v1.1 稳定性边界

v1.1 保持 KV + Worker 的轻量架构，不为了个人低流量场景引入 Redis / D1 / Durable Objects。

核心策略：

1. **请求边界**：限制 JSON body，生成 Request ID，并使用可配置的上游 timeout。
2. **错误边界**：Group 只对 retryable error fallback；非 retryable 4xx 直接返回。
3. **尝试预算**：单次 Group 请求有总 attempt 上限。
4. **Key 健康**：429 根据 `Retry-After` 做 cooldown；失败次数仍采用 KV best-effort 持久化。
5. **数据边界**：客户端认证 Header 不直接透传；OpenCode 公共镜像必须显式开启。
6. **管理面**：Provider/Model/Group 输入校验、登录 best-effort rate limit、测试 URL 的 SSRF 基础拦截。
7. **部署面**：管理员凭据只使用 Cloudflare Secrets，CI 不写入 `wrangler.toml`。

### KV 并发说明

Cloudflare KV 没有事务型 read-modify-write。Key health 的失败计数因此仍属于 best-effort 状态，而不是强一致计数器。

对当前个人、低并发 Agent 使用场景，这个取舍优先保证架构简单。若未来 Gateway 进入明显高并发，再把 health engine 迁移到 Durable Objects，并保持 Proxy 层接口不变。
