# Connector guide

Seb uses Chat SDK to share one agent across several chat platforms.

The current project includes Slack, Discord, and Telegram adapters.

## Quick choice

| Platform | Best local mode | Best deployed mode | Public URL needed |
| --- | --- | --- | --- |
| Slack | Socket Mode | HTTPS webhook | No for Socket Mode |
| Discord | Gateway | Gateway plus optional interactions endpoint | No for mentions and direct messages |
| Telegram | Polling | HTTPS webhook | No for polling |

Use Slack when the team already works in Slack.

Use Discord when a resident service can keep a Gateway connection open.

Use Telegram for the smallest local setup.

## Shared behavior

Seb responds to direct messages on every included platform.

Seb responds to a new mention in a channel or group.

Seb subscribes to that thread after the first mention.

Seb then responds to later messages in the same thread.

The connector reads up to 20 recent messages for conversation context.

The connector streams each Gemini answer through the platform adapter.

The connector uses one queue for overlapping messages in each thread.

Every connector can use the Sleeper, nflverse, and NWS tools.

Terminal slash commands apply only to the interactive command-line interface.

Set `NWS_USER_AGENT` for connector weather requests.

## Start the service

Set one or more connectors.

```dotenv
SEB_CONNECTORS=slack,discord,telegram
```

You only need credentials for the listed connectors.

Start the service.

```bash
npm run connectors
```

The service exposes these routes.

| Route | Purpose |
| --- | --- |
| `GET /` | Shows the service name and enabled connectors. |
| `GET /health` | Shows health, state type, and background task count. |
| `POST /webhooks/slack` | Receives verified Slack events. |
| `POST /webhooks/discord` | Receives verified Discord interactions. |
| `POST /webhooks/telegram` | Receives verified Telegram updates. |

Each platform adapter verifies its own webhook credentials.

Do not place another JSON body parser before these routes. Signature checks need the original request body.

## Local development

Use temporary memory state during local development.

Leave `REDIS_URL` empty for this mode.

Memory state disappears when the process stops.

Choose a connection that does not need a public URL.

- Set `SEB_SLACK_MODE=socket` for Slack.
- Keep the Discord Gateway enabled.
- Set `SEB_TELEGRAM_MODE=polling` for Telegram.

## Production

Set `REDIS_URL` before production use.

Redis stores subscriptions, message claims, queues, and distributed locks.

Use an HTTPS domain for every webhook.

Example webhook base:

```text
https://seb.example.com/webhooks
```

Expose only port 443 through the public load balancer.

Keep the Node service on a private application port.

See [production operations](OPERATIONS.md) for deployment requirements.

## Platform guides

- [Slack setup](connectors/SLACK.md)
- [Discord setup](connectors/DISCORD.md)
- [Telegram setup](connectors/TELEGRAM.md)
- [Other supported platforms](connectors/OTHER_PLATFORMS.md)
- [Custom adapter development](connectors/CUSTOM_ADAPTER.md)

Chat SDK maintains the [current adapter directory](https://chat-sdk.dev/adapters).

Read the [Chat SDK platform matrix](https://chat-sdk.dev/docs/platform-adapters) before you add rich platform features.
