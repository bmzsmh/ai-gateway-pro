# Changelog

## 1.2.3 — Harden & fix audit findings (2026-08-20)

Full-round audit of the freshly deployed standalone project surfaced 6 issues; all fixed in this release:

- **C1 (hardening)**: removed the built-in default API key `cline2api-default-key` fallback in `worker-proxy/cline.js` — `getApiKey()` now returns `null` when `API_KEY` is unset (true fail-closed, matching the top-level 503 guard; removes the leftover hardcoded credential from the pre-audit relaxed design).
- **C2 (harden)**: `POST /admin/api/providers` now validates `groupId` exists before accepting a provider assigned to it (previously silently accepted a nonexistent group).
- **C3 (harden)**: `POST /admin/api/model-groups` now validates that provider members exist (nested `group/` members are resolved separately); dangling provider refs are rejected.
- **C4 (fix regression)**: OPTIONS CORS preflight is now handled before the proxy-key auth middleware, so a configured CORS preflight returns 204 instead of 401.
- **C5 (consistency)**: provider creation now uses the same strict `normalizeApiKeys()` as updates (length/trim/empty-key filtering), removing the create-vs-update asymmetry.
- **C6 (harden, IPv6)**: SSRF `validateBaseUrl()` now also blocks IPv6 private ULA (`fd00::/8`), link-local (`fe80::/10`) and — only for internal ranges — IPv4-mapped IPv6 (`::ffff:10.x`, `::ffff:192.168.x`, etc.), while still allowing public IPv4-mapped addresses. (DNS-resolution-after-parse check remains infeasible on Workers.)
- **Branding**: updated site author from `QingYun` to `小鸢`, repo URL from `yutian81/ai-gateway` to `bmzsmh/ai-gateway-pro`, title from `AI Gateway` to `AI Gateway Pro`.


- `model` request field runtime validation: added length cap (300) and `SAFE_RESOURCE_ID_RE`/`SAFE_MODEL_ID_RE` format checking in `parseModelId()` — same regexes already used at admin creation time, so no legitimate model is rejected.
- Precise error classification: replaced string-prefix guessing with dedicated `PayloadTooLargeError` / `InvalidJsonError` classes matched via `instanceof`; unclassified internal errors now correctly return 500 instead of being misreported as client 400.

## 1.2.1 — Telemetry & monitoring (no quota/blocking)

- New unified telemetry layer (`src/telemetry.ts`): per-provider ring request log (max 80 entries), last-active model tracking, daily token/request usage stats (35-day TTL).
- Removed the "consumption threshold/quota interception" feature entirely (read-modify-write race made hard limits unreliable); kept pure display-only usage stats.
- Admin UI "监控" panel: current active model cards for auto-task / auto-task-backup tiers, color-coded request log, daily usage (display only, no blocking).
- Read-only telemetry APIs (admin-auth required): `/admin/api/telemetry/log/:providerId`, `/admin/api/telemetry/last-active?scope=...`, `/admin/api/telemetry/usage/:providerId`.
- `parseModelId` and error-class unit tests pass; `tsc --noEmit` 0 errors.

## 1.1.0 — Personal Production Hardening

### Security
- Hardened Admin login with isolate-level failed-login throttling.
- Added Provider/Model/Group ID validation.
- Added SSRF basic blocking for Admin upstream test URLs.
- Stopped arbitrary CORS by default.
- Added safe upstream request/response header allowlists.
- Hardened dynamic model IDs used by the Admin UI.
- Disabled OpenCode public mirror fallback by default.
- Removed Admin credentials from GitHub Actions-generated `wrangler.toml`.
- Hardened the standalone Cline worker to fail closed when `API_KEY` is missing.

### Reliability
- Model Group fallback now only happens for retryable upstream failures.
- Added a per-request Group attempt budget.
- Added configurable upstream request timeout.
- Added configurable request body limit.
- Added `Retry-After` aware Key cooldown.
- Added `X-Request-ID` and structured error request IDs.
- Preserved useful upstream diagnostic headers.
- Bounded Provider status history.

### Compatibility
- Provider base URLs now work with either `https://host` or `https://host/v1`.
- Anthropic test endpoints use the correct authentication headers.
- `/v1/models` now exposes all enabled model groups instead of only two hard-coded groups.

### Deployment
- Added `npm run typecheck`.
- CI runs typecheck before build/deploy.
- Production Admin credentials are documented as Cloudflare Secrets.
