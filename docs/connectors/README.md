# Connector setup guides

Seb ships with four production-ready chat connectors built on [Chat SDK](https://chat-sdk.dev). Pick a platform guide below to configure credentials, local development modes, and production webhooks, or read the [connector architecture guide](../CONNECTORS.md) for shared runtime details.

## Platform matrix

| Platform | Local mode | Production mode | Direct messages | Reply delivery & limit | Required credentials |
| --- | --- | --- | --- | --- | --- |
| [Slack](SLACK.md) | Socket Mode (`SEB_SLACK_MODE=socket`) | Signed webhook (`/webhooks/slack`) | Yes | Native streaming | `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` (Socket) or `SLACK_SIGNING_SECRET` (Webhook) |
| [Discord](DISCORD.md) | Outbound Gateway (`SEB_DISCORD_GATEWAY=true`) | Outbound Gateway + optional `/webhooks/discord` | Yes | Chunked plain text (`2,000` chars) | `DISCORD_APPLICATION_ID`, `DISCORD_PUBLIC_KEY`, `DISCORD_BOT_TOKEN` |
| [Telegram](TELEGRAM.md) | Long polling (`SEB_TELEGRAM_MODE=polling`) | Secret-verified webhook (`/webhooks/telegram`) | Yes | Chunked plain text (`4,096` chars) | `TELEGRAM_BOT_TOKEN` (+ `TELEGRAM_WEBHOOK_SECRET_TOKEN` in webhook mode) |
| [GroupMe](GROUPME.md) | HTTPS tunnel to `/webhooks/groupme` | Secret-verified webhook (`/webhooks/groupme`) | No (group chats only) | Chunked plain text (`1,000` chars) | `GROUPME_BOT_ID`, `GROUPME_WEBHOOK_SECRET` |

Need another chat surface? Start with [other supported platforms](OTHER_PLATFORMS.md) when Chat SDK already publishes an official or community adapter (such as Microsoft Teams, Google Chat, WhatsApp, or Web chat), or follow [custom adapter development](CUSTOM_ADAPTER.md) to build a new `Adapter` using Seb's in-repo [`createGroupMeAdapter`](../../src/connectors/groupme.ts) implementation as a reference.

## Long answers, Decision Gate, and error handling

Slack streams general research replies directly to threads, while Discord (`2,000` characters), Telegram (`4,096` characters), and GroupMe (`1,000` characters) send a typing indicator where supported, run the turn to completion, and split plain-text answers on clean boundaries without breaking `[label](url)` Markdown links. Every chunk preserves full report prose and `## Evidence` source URLs without platform re-formatting overflow.

Across all four platforms, actionable start/sit, waiver, add/drop, and trade recommendations pass through Seb's deterministic Decision Gate, which performs an automatic single-retry recovery pass when live tool evidence is missing or stale before returning `Decision unavailable`. If a model provider times out, hits rate limits after fallback, or rejects credentials, Seb posts a concise, user-safe recovery message and keeps raw upstream error payloads in server logs only.
