# GroupMe setup

Seb includes a built-in GroupMe connector ([`src/connectors/groupme.ts`](../../src/connectors/groupme.ts)) designed for fantasy football league group chats. Incoming group messages arrive via secret-verified HTTP callbacks at `POST /webhooks/groupme`, and outbound replies post through the [GroupMe v3 Bots API](https://dev.groupme.com/tutorials/bots) (`https://api.groupme.com/v3/bots/post`).

## 1. Prepare an HTTPS callback URL and webhook secret

GroupMe bots are webhook-only—GroupMe does not offer a polling API or WebSocket gateway for bot accounts. For production, deploy Seb behind a stable HTTPS domain; for local development, expose local port `3000` through an HTTPS tunnel such as Cloudflare Tunnel (`cloudflared tunnel --url http://localhost:3000`) or ngrok (`ngrok http 3000`).

Generate a strong random secret for webhook authentication before registering the bot:

```bash
openssl rand -hex 32
```

## 2. Create the GroupMe bot

Open the [GroupMe Bots developer portal](https://dev.groupme.com/bots), sign in with your GroupMe account, and select **Create Bot**:

1. **Choose a Group**: Select the fantasy football group chat where Seb will participate. Each GroupMe bot registration is bound to a single group.
2. **Bot Name**: Enter `Seb` (or another display name matching `SEB_BOT_NAME` so league members know how to mention it).
3. **Callback URL**: Enter your HTTPS webhook route with the secret query parameter attached:

   ```text
   https://seb.example.com/webhooks/groupme?secret=replace-with-your-generated-secret
   ```

4. **Avatar URL** *(optional)*: Provide an HTTPS image URL if you want a custom bot avatar.
5. Submit the form and copy the generated **Bot ID** from the bot details page (`GROUPME_BOT_ID`).

> [!IMPORTANT]
> GroupMe's Bot portal does not support configuring custom HTTP headers on outbound webhooks, so appending `?secret=<GROUPME_WEBHOOK_SECRET>` to your HTTPS Callback URL is the standard setup. If you route webhooks through an authenticating reverse proxy or custom relay, Seb also accepts the secret in `x-groupme-bot-secret: <secret>` or `Authorization: Bearer <secret>` headers and verifies whichever credential is provided using constant-time comparison (`timingSafeEqual`).

## 3. Configure Seb

At startup, [`src/connectors/server.ts`](../../src/connectors/server.ts) calls `loadUserEnvironment(process.env, true)`, loading saved model, credential, and Sleeper defaults from `seb configure` (`settings.json`, `credentials.json`, and `model-settings.json`) whenever the corresponding environment variables are unset. Explicit `process.env` variables always take precedence and are required for GroupMe bot credentials and production deployments.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SEB_CONNECTORS` | Optional if credentials set | Auto-detected | Include `groupme` (for example `SEB_CONNECTORS=groupme`). |
| `GROUPME_BOT_ID` | Yes | — | GroupMe Bot ID from the developer portal used to post replies to `/v3/bots/post`. |
| `GROUPME_WEBHOOK_SECRET` | Yes | — | Shared secret verified against `?secret=`, `x-groupme-bot-secret`, or `Authorization: Bearer`. |
| `SEB_BOT_NAME` | No | `seb` | Case-insensitive handle matched for `@seb` mentions in group messages. |
| `NWS_USER_AGENT` | Recommended | Built-in fallback | Identifies your deployment on National Weather Service stadium weather lookups. |
| `REDIS_URL` | Production | Empty (in-memory) | Persists group thread subscriptions, event claims, and queues across restarts. |

Provide your GroupMe credentials alongside your chosen model provider key (see [Model provider environment](../CONNECTORS.md#model-provider-environment)) in your deployment secret store or shell environment:

```dotenv
SEB_CONNECTORS=groupme
SEB_BOT_NAME=seb
GROUPME_BOT_ID=replace-with-groupme-bot-id
GROUPME_WEBHOOK_SECRET=replace-with-your-generated-secret
GOOGLE_GENERATIVE_AI_API_KEY=replace-with-provider-key
NWS_USER_AGENT=seb-fantasy-bot (ops@example.com)
REDIS_URL=redis://replace-in-production
```

## 4. Start and verify

Start the connector service:

```bash
npm run connectors
```

Verify that the service is healthy and `groupme` is active on both `connectors` and `webhookConnectors`:

```bash
curl https://seb.example.com/health
```

In your GroupMe group chat (or via your local HTTPS tunnel), mention `@seb` to ask a question and subscribe the group thread:

```text
@seb show the current NFL state and key injuries at WR
```

Once Seb replies, send a natural follow-up message in the same group without `@seb` (for example, `What about weather for Sunday night's game?`) to confirm that thread subscription and history context are working.

## Group chat behavior and message chunking

- **Group chats only (no DMs)**: GroupMe bots exist solely inside their registered group (`isDM()` always returns `false`). Bot messages (`sender_type: "bot"`), system events (`sender_type: "system"` or `system: true`), and blank attachments return `200 ok` immediately so Seb never enters a self-reply loop.
- **Mentions and subscribed group threads**: Mentioning `@seb` (matched case-insensitively at word boundaries against `SEB_BOT_NAME`) triggers `onNewMention` and subscribes `groupme:<groupId>:<groupId>`. Follow-up messages in that group then flow to Seb automatically without needing repeated `@` tags.
- **Monotonic 40-message history & compaction**: Standalone GroupMe bots cannot call user-scoped group history APIs, so Seb maintains an in-process per-group ring buffer of up to **40** messages (`MAX_CACHED_MESSAGES = 40`) across both user turns and Seb's own replies. Because GroupMe `created_at` timestamps use integer seconds, Seb nudges colliding timestamps monotonically to preserve exact arrival order, strips prior `## Evidence` footers on follow-ups, and keeps the incoming user turn last within the **12,000-character** prompt budget.
- **Markdown-link-safe 1,000-character chunking**: GroupMe caps bot posts at **1,000 characters** (`GROUPME_MAX_TEXT_LENGTH = 1_000`) and does not support editing or deleting sent bot messages. Seb runs the agent and deterministic Decision Gate (including single-retry auto-recovery) to completion, then splits long answers and `## Evidence` source lists into `<= 1,000`-character plain-text chunks without breaking `[label](url)` Markdown links.

> [!TIP]
> If your league chat is noisy and you want to pause automatic follow-up replies after a conversation wraps up, keep `REDIS_URL` scoped to your deployment or adjust your bot's `SEB_BOT_NAME` to a dedicated trigger handle like `seb-bot`.

## Troubleshooting

### GroupMe callbacks fail with `401 Unauthorized`

Confirm that the `?secret=` query parameter in the [GroupMe Bots portal](https://dev.groupme.com/bots) exactly matches `GROUPME_WEBHOOK_SECRET` with no extra whitespace or shell-escaped characters. If you rotate `GROUPME_WEBHOOK_SECRET`, update both the GroupMe Callback URL and the Seb service environment, then restart `npm run connectors`.

### Seb ignores `@seb` mentions in the group

Verify that `SEB_BOT_NAME` matches the handle members type in chat (default `seb`, matching `@seb` or `seb` on a word boundary) and that your Callback URL uses `https://` and ends with `/webhooks/groupme?secret=...`. For local testing, confirm your `cloudflared` or `ngrok` tunnel URL has not changed after restarting the tunnel.

### Seb stops answering unmentioned follow-ups after a restart

Without `REDIS_URL`, group thread subscriptions and cached GroupMe messages live in process memory and clear on restart. Mention `@seb` once to re-subscribe the group during local development, and configure `REDIS_URL` in production so subscriptions survive rolling restarts.

### Seb logs `GroupMe bot post failed with status 400` or `404`

The `GROUPME_BOT_ID` is invalid, belongs to a deleted bot registration, or was removed from the target GroupMe group. Check `https://dev.groupme.com/bots`, copy the active `Bot ID`, update `GROUPME_BOT_ID`, and restart the connector service.
