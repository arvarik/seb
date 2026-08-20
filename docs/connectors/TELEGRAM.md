# Telegram setup

Telegram provides the quickest connector setup.

Use polling locally. Use a verified webhook after deployment.

Telegram publishes its current [BotFather guide](https://core.telegram.org/bots/features#botfather) and [Bot API reference](https://core.telegram.org/bots/api).

## 1. Create the Telegram bot

Open a chat with [@BotFather](https://t.me/BotFather).

Send `/newbot`.

Choose the display name `Seb`.

Choose a unique username that ends with `bot`.

Copy the token that BotFather returns.

Anyone with this token can control the bot.

## 2. Configure local polling

Add these values to `.env`.

```dotenv
SEB_CONNECTORS=telegram
TELEGRAM_BOT_TOKEN=replace-this-value
TELEGRAM_BOT_USERNAME=replace_this_bot
SEB_TELEGRAM_MODE=polling
```

Start Seb.

```bash
npm run connectors
```

Open the bot in Telegram.

Select **Start** and send a question.

Telegram bots cannot start a conversation with a user.

## 3. Limit local access

Use `TELEGRAM_ALLOWED_USER_IDS` to restrict the bot.

The value accepts comma-separated numeric Telegram user IDs.

```dotenv
TELEGRAM_ALLOWED_USER_IDS=123456789,987654321
```

Use an ID bot or a Telegram update during development to find your numeric ID.

Review that service before you share any account information.

Leave the list empty only when every Telegram user can call Seb.

## 4. Configure a production webhook

Deploy Seb at a public HTTPS domain.

Generate a webhook secret.

```bash
openssl rand -hex 32
```

Add the secret and webhook mode to the deployment environment.

```dotenv
SEB_CONNECTORS=telegram
SEB_TELEGRAM_MODE=webhook
TELEGRAM_BOT_TOKEN=replace-this-value
TELEGRAM_BOT_USERNAME=replace_this_bot
TELEGRAM_WEBHOOK_SECRET_TOKEN=replace-this-random-value
REDIS_URL=redis://replace-this-value
```

Register the webhook with Telegram.

```bash
curl --request POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --header "Content-Type: application/json" \
  --data "{\"url\":\"https://seb.example.com/webhooks/telegram\",\"secret_token\":\"${TELEGRAM_WEBHOOK_SECRET_TOKEN}\"}"
```

The token appears in the request URL.

Run this command only on a trusted computer.

Clear shell history when the local security policy requires that action.

Telegram sends the secret in `X-Telegram-Bot-Api-Secret-Token`.

The Telegram adapter rejects a request with the wrong secret.

## 5. Verify the webhook

Read the current Telegram webhook status.

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"
```

Confirm that the returned URL ends with `/webhooks/telegram`.

Check the Seb health route.

```bash
curl https://seb.example.com/health
```

Send a direct message to the bot.

Mention the bot in a group when you need a group test.

## Switch back to polling

Telegram does not permit polling while a webhook exists.

Delete the registered webhook.

```bash
curl --request POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook"
```

Set `SEB_TELEGRAM_MODE=polling`.

Restart Seb.

## Automatic mode

Set `SEB_TELEGRAM_MODE=auto` to let the adapter inspect Telegram.

The adapter uses webhook mode when a webhook URL exists.

The adapter uses polling on a resident local process when no webhook exists.

Use an explicit mode in production for clearer operations.

## Rate limits and streaming

The adapter posts a placeholder and edits it as Gemini produces text.

The adapter limits edit frequency to protect the Telegram API quota.

Group streams update more slowly than direct-message streams.

Do not lower those intervals without a rate-limit test.

## Troubleshooting

### Telegram reports a polling conflict

A webhook or another polling process still exists.

Call `deleteWebhook`. Then stop every other Seb process.

### Telegram delivers no webhook updates

Confirm that the webhook URL uses HTTPS.

Run `getWebhookInfo` and inspect the last error message.

Confirm that the deployment secret matches the registered secret.

### Seb ignores a valid user

Check `TELEGRAM_ALLOWED_USER_IDS`.

Telegram user IDs are numeric and do not equal usernames.

### Seb ignores normal group messages

Mention the bot in the group.

Telegram Privacy Mode hides unrelated group messages by default.

Change Privacy Mode through BotFather only when the product requires broader access.
