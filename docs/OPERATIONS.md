# Production operations

This guide covers deploying, scaling, monitoring, and operating Seb's multi-platform chat connector service (`npm run connectors` on Node.js 22+). Local interactive (`seb`) and one-shot CLI (`seb ask`) workflows run in-process without a resident HTTP server.

## Runtime model and webhook routes

Run `npm run connectors` behind a TLS-terminating reverse proxy or load balancer that forwards exact, unmodified raw request bodies to `HOST` and `PORT` so platform HMAC and Ed25519 signature checks succeed. Each webhook acknowledges receipt to the chat platform immediately and executes `ToolLoopAgent` + Decision Gate validation asynchronously under a shared **two-minute deadline** (canceling in-flight streams cleanly on `SIGINT` / `SIGTERM`).

| Route / transport | Platform | Delivery, formatting, and access rules | Horizontal HTTP scaling |
| --- | --- | --- | --- |
| `POST /webhooks/slack` *(or Socket Mode)* | **Slack** | HMAC-signed webhooks (production) or single-instance Socket Mode (dev); native streaming updates and Slack `mrkdwn`. | Yes (webhook mode + shared Redis) |
| `POST /webhooks/discord` + Gateway | **Discord** | Ed25519-verified interaction webhooks plus **at most one** Gateway consumer per bot token; 2,000-character message chunking. | Webhooks: Yes; Gateway: **1 process per token** |
| `POST /webhooks/telegram` *(or polling)* | **Telegram** | Secret-token webhook verification (or single-instance polling); 4,096-character chunking; optional `TELEGRAM_ALLOWED_USER_IDS` allowlist. | Webhooks: Yes; Polling: **1 process per token** |
| `POST /webhooks/groupme` | **GroupMe** | Secret-verified callback (`GROUPME_WEBHOOK_SECRET`), bot post replies via `GROUPME_BOT_ID`, **1,000-character** chunking, and bot self-loop suppression. | Yes (with shared Redis) |
| `GET /health` | Liveness check | Returns `200` JSON (`enabled` connectors, `state` backend, active background task count) without polling Redis, LLMs, or Sleeper. | All instances |

Do not restart instances solely on isolated LLM capacity errors—Seb automatically retries the configured fallback model within the active two-minute request budget.

## Shared Redis state, queueing, and SQLite caches

Connector state uses **Redis 6+** whenever `REDIS_URL` is configured (key prefix `seb`) and falls back to ephemeral in-memory state when `REDIS_URL` is empty. Restrict memory state strictly to single-process local testing, as restarts drop subscriptions and duplicate-event claims and cannot coordinate multiple workers.

Redis coordinates thread subscriptions, distributed per-thread locks, overlapping-message queues, duplicate webhook claims, and short-lived Chat SDK adapter state. Under Chat SDK's `queue` concurrency policy, the first message in a thread starts immediately while overlapping follow-ups queue up to **10 messages per thread** (dropping the oldest item on overflow and expiring queued items after **90 seconds**, passing skipped intermediate messages as context on the next turn).

Public football source caches, snapshots, canonical identities, FTS5 news indexes, and local usage telemetry remain in each worker's local `.cache/seb.sqlite` (fronted by a 128-entry in-memory L1 cache), **not** in Redis:

- Grant the service user `0700`/`0600` read-write permissions on `.cache/`, or attach a dedicated local/block volume if snapshots should persist across container restarts.
- Separate stateless replicas may safely maintain independent `.cache/seb.sqlite` files; **never** mount one SQLite database across network filesystems (such as NFS without POSIX lock guarantees) that break WAL locking.

## Configuration, secrets, and observability

Store credentials in your deployment secret manager—never baked into container layers or printed in CI logs—and restart instances after rotating static tokens:

- **Model provider keys**: `GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_COMPATIBLE_API_KEY` (plus `SEB_MODEL_PROVIDER`, model overrides, and `https://` `OPENAI_COMPATIBLE_BASE_URL`—loopback-only for `http://`).
- **Platform credentials & access controls**: Slack bot token & signing secret, Discord bot token / public key / application ID, Telegram bot token / webhook secret / optional `TELEGRAM_ALLOWED_USER_IDS`, and GroupMe `GROUPME_BOT_ID` & `GROUPME_WEBHOOK_SECRET`.
- **Infrastructure & optional tracing**: `REDIS_URL`, `NWS_USER_AGENT`, and optional `SEB_JUDGMENT_TRACING`, `JUDGMENT_API_KEY`, and `JUDGMENT_ORG_ID`.

> [!IMPORTANT]
> **Connector environment & `~/.config/seb/` precedence** — At startup, `npm run connectors` runs `loadUserEnvironment(process.env, true)`, which populates unset settings from `~/.config/seb/` (`settings.json`, `credentials.json`, `model-settings.json`, `profile.json`) while giving explicit `process.env` variables priority (and never reading a working-directory `.env`). In production containers or shared hosts, declare explicit environment variables and set `SEB_CONFIG_HOME` to a dedicated empty or service-owned directory so local user files are never inherited unintentionally.

### Logs, DevTools, and optional Judgment tracing

Connectors write startup/shutdown lifecycle events to `stdout`, error/retry diagnostics to `stderr`, and Chat SDK adapter logs via console streams; ship both streams without logging raw webhook bodies, API keys, `Authorization` headers, compatible base URLs, or SQLite snapshot payloads.

When `SEB_JUDGMENT_TRACING=true` (with `JUDGMENT_API_KEY` and `JUDGMENT_ORG_ID`), Seb initializes Judgment OpenTelemetry tracing (`src/ai/judgment.ts`) before handling traffic and flushes pending spans cleanly during graceful shutdown.

> [!WARNING]
> Keep `SEB_DEVTOOLS` disabled in production (`NODE_ENV=production` rejects it automatically). Remember that enabling `SEB_JUDGMENT_TRACING=true` sets AI SDK `recordInputs` and `recordOutputs` to `true` and exports prompts, completions, and tool I/O to Judgment's collector, whereas default local `SebUsageTelemetry` remains strictly metadata-only.

Track these operational signals in dashboards and alerts:

- Webhook acknowledgement latency, end-to-end agent reply latency, and queue-full drops
- Successful agent-run rate, post-tool failure count, and bounded error categories (`seb stats --json`)
- Upstream error rates, circuit-breaker openings, cache outcomes (`fresh`, `updated`, `not-modified`, `stale-if-error`), and NWS forecast age across Sleeper, nflverse, NWS, and newsrooms
- SQLite write errors, `.cache/seb.sqlite` size, `seb.telemetry.write_failed` warnings, Redis connection errors, Discord Gateway reconnects, and platform post/edit failures

## Live contract checks, deployment, and upgrades

Validate live external contracts before major rollouts or when investigating upstream drift:

```bash
npm run contract:sources   # Sleeper, nflverse, and NWS without cache
npm run contract:answer    # Gemini structured schema, local tool loop, and Google Search grounding
```

### Safe deployment and upgrade checklist

1. **Build & verify**: Run `npm ci`, `npm run check`, `npm run test:coverage`, and `npm audit --omit=dev` in a clean environment.
2. **State & secrets**: Provision Redis 6+ with restricted network ACLs, set explicit provider/platform secrets and `SEB_CONFIG_HOME`, and start a single connector instance first.
3. **Smoke check**: Verify `seb cache status`, `GET /health`, and one message plus one threaded follow-up on each enabled platform (Slack, Discord, Telegram, GroupMe) before scaling additional HTTP replicas.
4. **Dependency upgrades**: Run `npm run deps:check`, update grouped Chat SDK packages (`chat` and `@chat-adapter/*`, currently `4.43.0`) together alongside grouped Vitest + `@vitest/coverage-v8` (`5.0.5`), run `npm run test:harness` and signed webhook checks in staging, and promote the verified `package-lock.json`.

## Incident runbooks

- **Model provider failure**: Verify `SEB_MODEL_PROVIDER`, API keys/endpoints, and primary + fallback model IDs; run `seb doctor` with the service environment while keeping HTTP webhook acknowledgements online to prevent platform retry storms.
- **First-class or grounded news failure**: Run `npm run news:smoke` to pinpoint failing publisher IDs, `robots.txt` policies, or date changes (and check Google Search status if Gemini is active). Never substitute model memory when news sources fail.
- **Sleeper, nflverse, or NWS outage**: Probe from the service network via `npm run sleeper:smoke` or `npm run data:smoke` (confirming `NWS_USER_AGENT` for weather). Inspect `/sources` if `stale-if-error` fallbacks activate, and preserve cached entries until upstream health recovers rather than wiping caches mid-outage.
- **SQLite or Redis failure**: For SQLite errors, verify `.cache/` permissions and POSIX locking via `seb cache status` (see the [storage recovery guide](STORAGE.md)). For Redis outages, scale down to zero extra HTTP replicas and restore Redis before resuming traffic—never fail over a multi-instance cluster to memory state.
- **Leaked token or duplicate replies**: Immediately revoke/rotate compromised platform or provider keys, update secrets, restart workers, and audit recent bot posts. If duplicate answers appear, verify every replica shares the same `REDIS_URL`, proxies preserve raw webhook bodies, and at most one Discord Gateway or Telegram polling worker runs per token.
