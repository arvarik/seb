# Other platforms

Seb ships with Slack, Discord, and Telegram connectors.

Chat SDK supplies adapters for several other platforms.

Review the [current adapter directory](https://chat-sdk.dev/adapters) before implementation.

## Official adapter options

| Platform | Package | Main event source | Typical credentials |
| --- | --- | --- | --- |
| Microsoft Teams | `@chat-adapter/teams` | Bot Framework webhook | App ID, password, and optional tenant ID |
| Google Chat | `@chat-adapter/gchat` | Google Chat webhook or Pub/Sub | Service account or application credentials |
| GitHub | `@chat-adapter/github` | GitHub App webhook | App credentials and webhook secret |
| Linear | `@chat-adapter/linear` | Linear webhook | API or OAuth credentials and webhook secret |
| WhatsApp Business | `@chat-adapter/whatsapp` | Meta webhook | Access token, app secret, phone ID, and verify token |
| Facebook Messenger | `@chat-adapter/messenger` | Meta webhook | Page token, app secret, and verify token |
| Twilio SMS | `@chat-adapter/twilio` | Twilio webhook | Account SID and auth token |
| Web chat | `@chat-adapter/web` | AI SDK web requests | Application-defined user authentication |
| X | `@chat-adapter/x` | X webhook | OAuth credentials and consumer secret |

These adapters do not all support the same features.

Check mentions, direct messages, streaming, files, cards, and message history before selection.

The [Chat SDK platform matrix](https://chat-sdk.dev/docs/platform-adapters) records the current feature support.

## Good next connectors for Seb

### Microsoft Teams

Choose Teams when the organization uses Microsoft 365.

Teams supports mentions, direct messages, Adaptive Cards, and modal forms.

The setup requires an Azure bot registration and a Teams app package.

### Google Chat

Choose Google Chat when the organization uses Google Workspace.

The setup requires a Google Cloud project and a Chat app configuration.

Some direct-message features require delegated Google credentials.

### Web chat

Choose Web when Seb needs a product-owned user interface.

The adapter uses the AI SDK chat protocol.

The host application must authenticate users before it calls the adapter.

### WhatsApp Business

Choose WhatsApp only after a Meta policy review.

Business message templates and conversation windows restrict outbound messages.

The connector needs a verified Meta webhook and persistent state.

### GitHub and Linear

Choose these adapters for issue or pull-request discussions.

They do not replace a normal chat connector.

They can support later development and evaluation workflows.

## Add an official adapter to Seb

Follow these steps for one adapter.

1. Install the platform package at a tested version.
2. Add the connector name to `CONNECTOR_NAMES` in `src/connectors/config.ts`.
3. Add credential validation to the same file.
4. Create the adapter in `src/connectors/bot.ts`.
5. Add the adapter to the shared `adapters` record.
6. Extend `.env.example` with required and optional values.
7. Add one webhook route test with a mock adapter.
8. Add one platform setup guide under `docs/connectors/`.
9. Run `npm run check`.
10. Test one signed webhook in a development account.

The HTTP service creates `/webhooks/{connector}` from the connector name.

Update `isConnectorName` through `CONNECTOR_NAMES` so the route accepts the new name.

## Vendor and community adapters

Chat SDK also lists vendor-maintained and community adapters.

Review the package owner, release history, license, and security policy.

Review webhook verification before you accept public traffic.

Pin the version during the first integration test.

Add an automated upgrade check after the connector reaches production.

## Selection checklist

Answer these questions before you add a platform.

1. Does the platform provide signed webhooks or another verified event channel?
2. Can the bot read mentions and direct messages?
3. Can the bot fetch enough thread history for Gemini context?
4. Does the platform permit streamed edits or only final messages?
5. Which rate limits apply to posts, edits, and history reads?
6. Which data retention rules apply to message content?
7. Does the service need one resident connection?
8. Does the adapter support shared state across service instances?
9. Which platform review or business approval blocks deployment?
10. Which test account can receive safe development traffic?

Use the [custom adapter guide](CUSTOM_ADAPTER.md) when no suitable adapter exists.
