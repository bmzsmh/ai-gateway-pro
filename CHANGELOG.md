# Changelog

## 1.2.2 — Stability fixes (no functional change)

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
