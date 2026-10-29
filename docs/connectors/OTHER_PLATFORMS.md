# Other platforms

Seb ships out of the box with [Slack](SLACK.md), [Discord](DISCORD.md), [Telegram](TELEGRAM.md), and [GroupMe](GROUPME.md) connectors, and [Chat SDK](https://chat-sdk.dev) provides official and community adapters for several additional chat and collaboration surfaces. Review the [Chat SDK adapter directory](https://chat-sdk.dev/adapters) and [platform feature matrix](https://chat-sdk.dev/docs/platform-adapters) before wiring a new connector into Seb.

## Official Chat SDK adapter options

| Platform | Package | Primary event transport | Typical credentials |
| --- | --- | --- | --- |
| Microsoft Teams | `@chat-adapter/teams` | Azure Bot Framework HTTPS webhook | Microsoft App ID, password/secret, and optional tenant ID |
| Google Chat | `@chat-adapter/gchat` | Google Chat HTTPS webhook or Cloud Pub/Sub | Google Cloud service account or Chat app credentials |
| Web chat | `@chat-adapter/web` | AI SDK HTTP chat requests | Host-application user authentication |
| WhatsApp Business | `@chat-adapter/whatsapp` | Signed Meta Graph webhook | Access token, app secret, phone number ID, and verify token |
| Facebook Messenger | `@chat-adapter/messenger` | Signed Meta Graph webhook | Page access token, app secret, and verify token |
| Twilio SMS | `@chat-adapter/twilio` | Signed Twilio HTTPS webhook | Account SID and auth token |
| GitHub | `@chat-adapter/github` | Signed GitHub App webhook | GitHub App ID, private key, and webhook secret |
| Linear | `@chat-adapter/linear` | Signed Linear webhook | API key or OAuth credentials and webhook secret |
| X | `@chat-adapter/x` | Account Activity webhook | OAuth credentials and consumer secret |

Feature coverage varies across platforms—verify support for `@mentions`, direct messages, thread history reads, native streaming vs. final-message chunking, and character limits before committing to an adapter.

## Evaluating candidate connectors for Seb

- **Microsoft Teams & Google Chat**: Strong fits for workplace fantasy leagues where members already collaborate in Microsoft 365 or Google Workspace. Teams requires an Azure Bot registration and app manifest package; Google Chat requires a Google Cloud project and Chat app configuration (with delegated credentials for certain DM workflows).
- **Web chat (`@chat-adapter/web`)**: Best when embedding Seb inside a custom web dashboard using the AI SDK protocol. Your host web app owns authentication, session boundaries, and rate limiting before forwarding requests to the adapter.
- **WhatsApp Business & Twilio SMS**: Useful for mobile-first leagues, but subject to strict carrier/Meta template rules, 24-hour customer-care messaging windows, and tight character budgets that benefit from `CONNECTOR_CHUNK_LIMITS`.
- **GitHub & Linear**: Tailored to issue and pull-request threads rather than live fantasy chat rooms, making them better suited to automated evaluation or developer ops workflows than league Q&A.

## Adding an official Chat SDK adapter to Seb

When `npm run connectors` boots, [`src/connectors/server.ts`](../../src/connectors/server.ts) calls `loadUserEnvironment(process.env, true)`, loading saved `seb configure` defaults (`settings.json`, `credentials.json`, and `model-settings.json`) when environment variables are unset while giving explicit `process.env` variables precedence. New platform adapters should read and validate their bot tokens and webhook secrets from `Environment` (`process.env`) alongside existing connectors:

1. **Install and pin the adapter**: Install `@chat-adapter/<platform>` at an exact tested version.
2. **Register configuration & chunk limits**: Add the connector identifier to `CONNECTOR_NAMES` and set its character limit in `CONNECTOR_CHUNK_LIMITS` (`null` for native streaming, or an integer character cap such as `2_000` for markdown-link-safe chunking) in [`src/connectors/config.ts`](../../src/connectors/config.ts), along with startup credential validation in `validateCredentials` and auto-detection in `readEnabledConnectors`.
3. **Wire the runtime**: Instantiate the adapter inside `createConnectorRuntime` in [`src/connectors/bot.ts`](../../src/connectors/bot.ts) and attach it to `adapters`—Seb's shared `onNewMention`, `onDirectMessage`, `onSubscribedMessage`, 40-message / 12k-char history compactor, and auto-recovery Decision Gate will work automatically, and [`src/connectors/server.ts`](../../src/connectors/server.ts) will expose `POST /webhooks/<connector>`.
4. **Document and verify**: Document required and optional variables in `.env.example`, add a setup guide in `docs/connectors/`, write unit tests covering credential validation and signed webhook dispatch, run `npm run check`, and verify end-to-end against a sandbox account.

> [!IMPORTANT]
> When evaluating third-party vendor or community adapters from the Chat SDK directory, audit raw-body webhook signature verification, maintainer release hygiene, license compatibility, and secret redaction before exposing `/webhooks/<connector>` to public traffic.

## Pre-implementation checklist

Before shipping a new platform integration, confirm how the platform answers these operational questions:

1. **Authentication**: Does the adapter verify cryptographic signatures or constant-time secrets against the unparsed HTTP body before parsing JSON?
2. **Conversation model**: Can the bot distinguish mentions, subscribed threads, and direct messages—or is it group-only (`isDM() => false`) like GroupMe?
3. **History context**: Can `fetchMessages` read up to 40 recent turns from the platform API, or does the adapter need a bounded per-thread cache?
4. **Outbound limits**: What maximum character length and post/edit rate limits apply, and what value belongs in `CONNECTOR_CHUNK_LIMITS`?
5. **Runtime topology**: Does the connector work over stateless HTTP webhooks backed by `REDIS_URL`, or does it require a single resident WebSocket/polling process?
6. **Compliance**: Which platform review gates, privacy modes, or data-retention rules apply to league messages?

If Chat SDK does not offer an adapter for your target platform, follow the [custom adapter guide](CUSTOM_ADAPTER.md).
