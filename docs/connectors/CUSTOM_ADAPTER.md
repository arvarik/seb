# Custom connector adapter

Build a custom Chat SDK `Adapter` when no official package covers your messaging platform, or subclass an existing `@chat-adapter/*` package when you only need small behavior overrides. Read the [Chat SDK adapter building guide](https://chat-sdk.dev/docs/contributing/building) alongside Seb's production in-repo reference implementation: [`createGroupMeAdapter`](../../src/connectors/groupme.ts) in [`src/connectors/groupme.ts`](../../src/connectors/groupme.ts).

> [!TIP]
> [`src/connectors/groupme.ts`](../../src/connectors/groupme.ts) is a complete, ~265-line custom `Adapter` shipped in Seb. Inspect it directly to see how a custom connector handles constant-time webhook verification, thread ID encoding, bot/system loop filtering, monotonic history caching, and Seb runtime registration.

## Subclassing vs. implementing `Adapter`

When your target platform already has an official Chat SDK adapter, prefer a thin subclass over forking the upstream package, and pin the exact `@chat-adapter/*` version because protected methods can evolve faster than the public `Adapter` interface. When integrating a distinct platform—such as GroupMe's Bot callback API—implement `Adapter<TThreadId, TRawPayload>` directly from `chat` and export a factory function like `createGroupMeAdapter(config)`.

## Core adapter responsibilities

Every Seb connector adapter is responsible for clear security and normalization boundaries:

| Area | Adapter contract | How [`createGroupMeAdapter`](../../src/connectors/groupme.ts) implements it |
| --- | --- | --- |
| **Webhook verification** | Verify HMAC signatures or shared secrets before parsing or dispatching events; return `401` on invalid credentials and `400` on malformed payloads. | `verifySecret` checks `x-groupme-bot-secret`, `Authorization: Bearer`, or `?secret=` using `node:crypto` `timingSafeEqual` before reading JSON. |
| **Thread & channel IDs** | Implement reversible `encodeThreadId` / `decodeThreadId` (`platform:channel-id:thread-id`), `channelIdFromThreadId`, and accurate `isDM()`. | Encodes `groupme:${groupId}:${groupId}`, scopes locks per channel (`lockScope: 'channel'`), and returns `isDM() => false` since GroupMe bots are group-only. |
| **Loop prevention** | Ignore or flag messages sent by this bot (`author.isMe = true`) and system events so Seb never replies to itself. | Short-circuits `sender_type === 'bot'`, `sender_type === 'system'`, and empty messages with `200 ok` in `handleWebhook`, and sets `isBot`/`isMe` on outbound echoes. |
| **Message normalization** | Populate `id`, `threadId`, `text`, `formatted` (`parseMarkdown`), `author`, `isMention`, `metadata.dateSent`, and `raw`. | Matches `@<botName>` on word boundaries for `isMention` and converts integer-second `created_at` fields into `Date` instances. |
| **History reads** | Implement `fetchMessages(threadId, { limit })` so `buildPrompt` in [`src/connectors/bot.ts`](../../src/connectors/bot.ts) can compact up to 40 recent turns (`12,000` chars). | Maintains a 40-message per-group ring buffer (`MAX_CACHED_MESSAGES = 40`), nudging `dateSent` monotonically (`prevMs + 1`) when webhooks share the same second. |
| **Outbound delivery** | Implement `postMessage` (plus `editMessage`/`deleteMessage` or `NotImplementedError` where unsupported) and set `CONNECTOR_CHUNK_LIMITS`. | Posts JSON to `/v3/bots/post`, caps text at `1,000` chars, throws `NotImplementedError` on `deleteMessage`, and relies on `CONNECTOR_CHUNK_LIMITS.groupme = 1_000` for markdown-link-safe chunking. |

> [!IMPORTANT]
> Set `author.isMe = true` **only** on messages sent by Seb's own bot identity—never on every message originating from a shared workspace or authenticated user account, which would silently drop legitimate user questions.

## Webhook verification and duplicate protection

Always validate authenticity before invoking `chat.processMessage(...)`, using raw request bytes for cryptographic HMAC signatures (Slack/GitHub style) or `timingSafeEqual` over equal-length buffers for shared secret tokens (`GroupMe` / `Telegram` style), and enforce timestamp replay windows whenever the platform provides request timestamps:

```typescript
import { timingSafeEqual } from 'node:crypto';

function verifySecret(request: Request, expected: string): boolean {
  const bearer = request.headers.get('authorization')?.replace(/^Bearer\s+/iu, '').trim();
  const header = request.headers.get('x-groupme-bot-secret')?.trim();
  const query = new URL(request.url, 'http://localhost').searchParams.get('secret')?.trim();
  const candidate = header || bearer || query;
  if (!candidate) return false;
  const left = Buffer.from(candidate);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}
```

Acknowledge handshakes and accepted webhook deliveries promptly (`200` or `202`, passing `options` through to `chat.processMessage(this, message.threadId, message, options)` so [`BackgroundTasks`](../../src/connectors/server.ts) tracks async reply work via `waitUntil`). Because webhook providers frequently retry before a multi-tool agent turn finishes, rely on Chat SDK's state adapter—backed by `REDIS_URL` in production—to claim message IDs across processes and prevent duplicate model runs.

## Connecting the adapter to Seb

Integrating a custom adapter into Seb takes four small wiring steps across `src/connectors/`:

1. **Declare the connector and chunk limit in [`src/connectors/config.ts`](../../src/connectors/config.ts)**: Add the name to `CONNECTOR_NAMES`, set `CONNECTOR_CHUNK_LIMITS.<name>` (`null` if the platform supports native streaming, or the platform's max character count so `postConnectorResponse` splits replies without breaking Markdown links), and validate required `process.env` credentials in `validateCredentials` and `readEnabledConnectors`. (Remember that [`src/connectors/server.ts`](../../src/connectors/server.ts) calls `loadUserEnvironment(process.env, true)` for saved `seb configure` model/user settings, while explicit `process.env` variables take precedence and carry connector secrets.)
2. **Instantiate the adapter in [`src/connectors/bot.ts`](../../src/connectors/bot.ts)**: Call your `create<Platform>Adapter(...)` factory inside `createConnectorRuntime` when `config.enabled` includes your connector, passing `config.botName` (`SEB_BOT_NAME`) and validated secrets.
3. **Verify HTTP webhook routing in [`src/connectors/server.ts`](../../src/connectors/server.ts)**: `POST /webhooks/:connector` automatically serves every connector in `config.webhookConnectors`—adjust the filter in `readConnectorConfig` only if your adapter supports a non-webhook local mode like polling or WebSockets.
4. **Update `.env.example` and docs**: Add placeholder environment variable names (without secret values) to `.env.example` and add a setup guide in `docs/connectors/`.

## Testing with `@chat-adapter/tests` and Vitest

Pair Seb's Vitest suite with `@chat-adapter/tests` contract helpers (`createMockChatInstance`, `createTestMessage`, `selfMessageContract`, `threadIdContract`, and `connectWebhookContract`) to verify adapter invariants without hitting live network APIs:

```typescript
import { createMockChatInstance, createTestMessage } from '@chat-adapter/tests';

const chat = createMockChatInstance();
const message = createTestMessage('message-1', '@seb check waivers');
```

Before opening a pull request or deploying to production, cover these test cases and release checks:

- **Webhook security**: Accepts valid signatures/secrets (`202`), rejects tampered bodies, missing secrets, or expired timestamps (`401`), and rejects malformed JSON (`400`) without logging tokens or raw private message bodies.
- **Routing & loop safety**: Dispatches mentions and subscribed turns through `processMessage`, ignores bot/system echoes (`selfMessageContract`), and round-trips `encodeThreadId` / `decodeThreadId` cleanly (`threadIdContract`).
- **Delivery & lifecycle**: Splits long answers cleanly at `CONNECTOR_CHUNK_LIMITS`, deduplicates retried webhook deliveries under `REDIS_URL`, and closes any open sockets or timers cleanly during `shutdown()`.
