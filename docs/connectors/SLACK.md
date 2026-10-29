# Slack setup

Seb supports both **Slack Socket Mode** and **Slack Events API webhooks** via `@chat-adapter/slack`. Use Socket Mode for fast local development without exposing a public URL, and switch to a signed HTTPS webhook (`/webhooks/slack`) for production deployments. For Slack platform details, see the official [Slack app manifest reference](https://docs.slack.dev/reference/app-manifest/) and [Events API guide](https://docs.slack.dev/apis/events-api/).

## Environment variables and configuration precedence

When `npm run connectors` starts, [`src/connectors/server.ts`](../../src/connectors/server.ts) calls `loadUserEnvironment(process.env, true)`, loading saved model, credential, and Sleeper defaults from `seb configure` (`settings.json`, `credentials.json`, and `model-settings.json`) whenever those environment variables are unset. Explicit `process.env` variables always take precedence and must be used for Slack tokens, mode flags, and production secrets.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SEB_CONNECTORS` | Optional if credentials set | Auto-detected | Include `slack` (for example `SEB_CONNECTORS=slack`). |
| `SEB_SLACK_MODE` | No | `webhook` | Set `socket` for local Socket Mode or `webhook` for signed HTTPS webhooks. |
| `SLACK_BOT_TOKEN` | Yes | — | Bot User OAuth Token (`xoxb-...`) from **OAuth & Permissions**. |
| `SLACK_APP_TOKEN` | When `SEB_SLACK_MODE=socket` | — | App-Level Token (`xapp-...`) with the `connections:write` scope. |
| `SLACK_SIGNING_SECRET` | When `SEB_SLACK_MODE=webhook` | — | Signing Secret from **Basic Information** used to verify `/webhooks/slack` requests. |
| `SEB_BOT_NAME` | No | `seb` | Display handle used by Chat SDK runtime configuration. |
| `NWS_USER_AGENT` | Recommended | Built-in fallback | Identifies your deployment on National Weather Service stadium weather lookups. |
| `REDIS_URL` | Production | Empty (in-memory) | Persists thread subscriptions, event claims, and queues across restarts. |

> [!NOTE]
> Seb does not automatically load a working-directory `.env` file on startup. Pass environment variables via your shell, container secret store, or `node --env-file=.env`, and optionally import supported model and Sleeper settings with `seb configure --import-env .env`.

## Local setup with Socket Mode

1. **Create the Slack app from the Socket Mode manifest**: Open the [Slack app dashboard](https://api.slack.com/apps), select **Create New App -> From an app manifest**, choose your development workspace, and paste [`slack-socket-manifest.yaml`](slack-socket-manifest.yaml).
2. **Generate an App-Level Token**: In **Basic Information -> App-Level Tokens**, create a token with the `connections:write` scope and copy the `xapp-...` value (`SLACK_APP_TOKEN`).
3. **Install the app to your workspace**: Open **OAuth & Permissions**, select **Install to Workspace**, approve the bot scopes, and copy the `xoxb-...` Bot User OAuth Token (`SLACK_BOT_TOKEN`).
4. **Configure and start Seb**: Export your Slack tokens alongside your model provider credentials (Socket Mode does not require `SLACK_SIGNING_SECRET`) and launch the connector service:

   ```dotenv
   SEB_CONNECTORS=slack
   SEB_SLACK_MODE=socket
   SLACK_BOT_TOKEN=xoxb-replace-this-value
   SLACK_APP_TOKEN=xapp-replace-this-value
   ```

   ```bash
   npm run connectors
   ```

5. **Test mentions, threads, and DMs**: Invite `@Seb` to a test channel, send `@Seb show the current NFL state`, reply inside the resulting Slack thread without mentioning `@Seb` again, and send a direct message to verify DM routing.

## Production setup with an HTTPS webhook

1. **Prepare your public HTTPS URL**: Deploy the connector service behind TLS so Slack can reach `https://seb.example.com/webhooks/slack`, and replace `seb.example.com` in [`slack-webhook-manifest.yaml`](slack-webhook-manifest.yaml) with your domain.
2. **Create and install the production Slack app**: Create a new app in the [Slack app dashboard](https://api.slack.com/apps) using your edited [`slack-webhook-manifest.yaml`](slack-webhook-manifest.yaml). Copy the **Signing Secret** from **Basic Information** (`SLACK_SIGNING_SECRET`), then open **OAuth & Permissions**, install the app to your workspace, and copy the `xoxb-...` bot token (`SLACK_BOT_TOKEN`).
3. **Configure production secrets and restart**: Store your Slack credentials, model provider API key, and `REDIS_URL` in your deployment secret manager, then start (or restart) the service:

   ```dotenv
   SEB_CONNECTORS=slack
   SEB_SLACK_MODE=webhook
   SLACK_BOT_TOKEN=xoxb-replace-this-value
   SLACK_SIGNING_SECRET=replace-this-value
   REDIS_URL=redis://replace-this-value
   ```

4. **Verify Event Subscriptions**: Open **Event Subscriptions** in the Slack app settings and confirm that the Request URL shows **Verified** (Seb's Slack adapter answers Slack's `url_verification` challenge automatically). Confirm that bot events include `app_mention` (requires `app_mentions:read`), `message.channels`, `message.groups`, `message.im` (required for DMs), and `message.mpim`.
5. **Run a production smoke test**: Check `curl https://seb.example.com/health`, invite `@Seb` to a channel, ask an initial `@Seb` question, and post an unmentioned reply in that thread to verify Redis-backed thread subscriptions.

## Reply streaming, thread history, and permissions

Slack is Seb's native streaming connector (`CONNECTOR_CHUNK_LIMITS.slack = null`): general research replies stream incrementally into the Slack thread as tokens arrive, while actionable start/sit, waiver, add/drop, and trade recommendations buffer through Seb's deterministic Decision Gate (including automatic single-retry recovery when live evidence is missing or stale) before posting. On follow-up replies, Seb reads up to **40** messages from the Slack thread, strips historical `## Evidence` footers, and compacts context within a **12,000-character** history budget.

Both included Slack manifests request the minimum bot scopes needed for channel mentions, subscribed threads, and direct messages:

| Scope | Purpose |
| --- | --- |
| `app_mentions:read` | Receives `@Seb` mentions in public and private channels. |
| `channels:history` / `channels:read` | Reads metadata and thread context in joined public channels. |
| `groups:history` / `groups:read` | Reads metadata and thread context in joined private channels. |
| `im:history` / `im:read` | Reads 1:1 direct-message metadata and conversation history. |
| `mpim:history` / `mpim:read` | Reads multi-person direct-message metadata and history. |
| `chat:write` | Posts and streams Seb responses in channels, threads, and DMs. |
| `users:read` | Resolves speaker names for multi-user thread context. |

> [!TIP]
> Avoid adding `chat:write.public` unless your deployment explicitly needs Seb to post into channels it has not been invited to join.

## Troubleshooting

### Slack rejects the webhook signature (`401`)

`SLACK_SIGNING_SECRET` does not match the active Slack app, a reverse proxy modified the raw request body before `/webhooks/slack`, or the server clock has drifted outside Slack's 5-minute replay window. Re-copy the **Signing Secret** from **Basic Information**, verify NTP clock sync on the host, ensure proxies forward raw bytes untouched, and restart Seb.

### Slack does not accept the Request URL

Confirm that the URL uses `https://`, routes directly to `/webhooks/slack` without `301`/`302` redirects, and that `SEB_SLACK_MODE` is set to `webhook` (Seb disables `/webhooks/slack` while `SEB_SLACK_MODE=socket`).

### Seb answers an `@Seb` mention but ignores thread follow-ups

The initial mention stores a thread subscription in Chat SDK's state store. Confirm `REDIS_URL` is healthy in multi-instance or restarting deployments, and verify that the Slack app subscribes to the matching `message.channels`, `message.groups`, `message.im`, or `message.mpim` bot events.

### Seb never receives channel messages or Socket Mode fails to connect

Invite `@Seb` to the target channel first—Slack only delivers events from channels the bot has joined. If Socket Mode fails at startup, confirm `SEB_SLACK_MODE=socket`, `SLACK_APP_TOKEN` begins with `xapp-`, and the app-level token includes `connections:write`.
