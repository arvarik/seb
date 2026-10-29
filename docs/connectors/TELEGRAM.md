# Telegram setup

Telegram offers the fastest local connector setup via `@chat-adapter/telegram`: run long polling locally without any public URL or tunnel, then switch to a secret-verified HTTPS webhook (`POST /webhooks/telegram`) in production. For platform details, see Telegram's [BotFather guide](https://core.telegram.org/bots/features#botfather) and [Bot API reference](https://core.telegram.org/bots/api).

## Environment variables and configuration precedence

At startup, [`src/connectors/server.ts`](../../src/connectors/server.ts) calls `loadUserEnvironment(process.env, true)`, loading saved model, credential, and Sleeper defaults from `seb configure` (`settings.json`, `credentials.json`, and `model-settings.json`) whenever those environment variables are unset. Explicit `process.env` variables always take precedence and are required for Telegram bot tokens, mode settings, and production webhook secrets.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SEB_CONNECTORS` | Optional if credentials set | Auto-detected | Include `telegram` (for example `SEB_CONNECTORS=telegram`). |
| `TELEGRAM_BOT_TOKEN` | Yes | — | Bot API token issued by `@BotFather`. |
| `TELEGRAM_BOT_USERNAME` | Recommended | Resolved by adapter | Bot username (without `@`, ending in `bot`) for reliable group mention matching. |
| `SEB_TELEGRAM_MODE` | No | `auto` | Connection mode: `polling`, `webhook`, or `auto`. |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | When `SEB_TELEGRAM_MODE=webhook` | — | Secret verified against Telegram's `X-Telegram-Bot-Api-Secret-Token` header. |
| `TELEGRAM_ALLOWED_USER_IDS` | No | Empty (all users) | Comma-separated numeric Telegram user IDs permitted to message Seb. |
| `TELEGRAM_MENTION_ON_REPLY` | No | `true` | Prefixes group chat replies with `@username`; set `false` to omit the mention prefix. |
| `SEB_BOT_NAME` | No | `seb` | Display handle used by Chat SDK runtime configuration. |
| `NWS_USER_AGENT` | Recommended | Built-in fallback | Identifies your deployment on National Weather Service stadium weather lookups. |
| `REDIS_URL` | Production | Empty (in-memory) | Persists thread subscriptions, event claims, and queues across restarts. |

## 1. Create the Telegram bot

Open a chat with [@BotFather](https://t.me/BotFather), send `/newbot`, choose a display name such as `Seb`, and pick a unique username ending in `bot` (for example `seb_fantasy_bot`). Copy the token BotFather returns and store it securely as `TELEGRAM_BOT_TOKEN`—anyone holding that token has full control over the bot.

## 2. Run locally with polling

Set `SEB_TELEGRAM_MODE=polling` alongside your bot token and model provider credentials in your process environment (for example via `node --env-file=.env`; Seb does not auto-load `.env` files on its own):

```dotenv
SEB_CONNECTORS=telegram
TELEGRAM_BOT_TOKEN=replace-this-value
TELEGRAM_BOT_USERNAME=replace_this_bot
SEB_TELEGRAM_MODE=polling
```

```bash
npm run connectors
```

Open your bot in Telegram, press **Start**, and send a fantasy football question (Telegram bots cannot initiate a DM until a user starts the chat). In polling mode, Seb pulls updates directly from Telegram and disables the `/webhooks/telegram` HTTP route.

## 3. Access control and group reply behavior

You can lock down who can invoke Seb and how Seb formats group responses using two environment variables:

- **Restrict users (`TELEGRAM_ALLOWED_USER_IDS`)**: Pass comma-separated numeric Telegram user IDs (validated as digits at startup) so Seb ignores unauthorized callers during development or private league use. Leave `TELEGRAM_ALLOWED_USER_IDS` unset only when every user who can reach the bot should be allowed to run queries.
- **Control `@username` reply prefixes (`TELEGRAM_MENTION_ON_REPLY`)**: By default (`TELEGRAM_MENTION_ON_REPLY=true`), group replies prefix the caller's `@username` so busy league chats stay easy to follow; set `TELEGRAM_MENTION_ON_REPLY=false` if you prefer clean replies without leading `@username` tags.

```dotenv
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
TELEGRAM_MENTION_ON_REPLY=true
```

## 4. Configure a production webhook

1. **Generate a webhook secret and configure Seb**: Deploy Seb behind a public HTTPS domain, generate a random secret with `openssl rand -hex 32`, and configure your production secret store (Seb refuses to start in explicit `webhook` mode without `TELEGRAM_WEBHOOK_SECRET_TOKEN`):

   ```dotenv
   SEB_CONNECTORS=telegram
   SEB_TELEGRAM_MODE=webhook
   TELEGRAM_BOT_TOKEN=replace-this-value
   TELEGRAM_BOT_USERNAME=replace_this_bot
   TELEGRAM_WEBHOOK_SECRET_TOKEN=replace-this-random-value
   REDIS_URL=redis://replace-this-value
   ```

2. **Register the webhook with Telegram**: Call `setWebhook` from a trusted workstation so Telegram sends updates to `/webhooks/telegram` with the `X-Telegram-Bot-Api-Secret-Token` header:

   ```bash
   curl --request POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
     --header "Content-Type: application/json" \
     --data "{\"url\":\"https://seb.example.com/webhooks/telegram\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET_TOKEN}\"}"
   ```

   > [!WARNING]
   > Because Telegram's Bot API embeds `TELEGRAM_BOT_TOKEN` in the request URL path, run `curl` commands only on a trusted machine with environment variable expansion (never paste raw tokens into shared logs or shell history).

3. **Verify webhook delivery**: Inspect `curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"` to confirm the registered URL ends with `/webhooks/telegram` and has no delivery errors, verify `curl https://seb.example.com/health`, then test both a direct message and an `@bot_username` mention in a group chat.

### Switching between `webhook`, `polling`, and `auto` modes

Telegram blocks `getUpdates` polling whenever a webhook is registered. To switch back to local polling, delete the webhook first with `curl --request POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook"`, set `SEB_TELEGRAM_MODE=polling`, and restart Seb.

When `SEB_TELEGRAM_MODE=auto` (the default), the adapter inspects Telegram at startup—using webhook mode if a webhook URL is already registered (exposing `/webhooks/telegram` only when `TELEGRAM_WEBHOOK_SECRET_TOKEN` is set) and falling back to polling otherwise. Pin an explicit mode (`polling` locally, `webhook` in production) for predictable operations.

## Delivery, chunking, and rate limits

Seb does **not** post a placeholder message or live-edit streaming tokens on Telegram. Instead, when a turn starts (`CONNECTOR_CHUNK_LIMITS.telegram = 4_096`), [`src/connectors/bot.ts`](../../src/connectors/bot.ts) sends a Telegram typing indicator (`startTyping()`), runs the Seb agent and deterministic Decision Gate (including automatic single-retry recovery when live evidence is missing or stale) to completion, compacts up to **40** messages of thread history (`12,000`-character budget with historical `## Evidence` footers stripped), and posts plain-text chunks of up to **4,096 characters** without breaking `[label](url)` Markdown links.

Buffering until completion eliminates Telegram Bot API `editMessageText` rate-limit throttling in active group chats while ensuring every fantasy recommendation and `## Evidence` citation URL arrives intact.

## Troubleshooting

### Telegram reports a `409 Conflict` polling error

Either a webhook is still registered on the bot token or a second Seb process is polling with the same `TELEGRAM_BOT_TOKEN`. Call `deleteWebhook` and stop any duplicate local or container instances.

### Telegram delivers no webhook updates

Confirm the registered URL uses `https://` without redirects, run `getWebhookInfo` to inspect `last_error_message`, and verify `TELEGRAM_WEBHOOK_SECRET_TOKEN` in your deployment matches the `secret_token` passed to `setWebhook`.

### Seb ignores a user or ignores unmentioned group messages

If a specific user gets no reply, check `TELEGRAM_ALLOWED_USER_IDS`—entries must be numeric Telegram user IDs rather than `@usernames`. In group chats, Telegram **Privacy Mode** hides ordinary unmentioned messages from bots until `@bot_username` is mentioned (or a user replies directly to a bot message); mention the bot first to subscribe the thread, and only disable Privacy Mode in `@BotFather` if your league explicitly wants broader group visibility.
