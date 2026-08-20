# Custom connector adapter

Use a custom adapter when Chat SDK does not supply a suitable platform adapter.

Read the current [Chat SDK adapter building guide](https://chat-sdk.dev/docs/contributing/building) first.

## Choose the extension method

Use an existing adapter subclass when the target platform already has an official adapter.

Use a new `Adapter` implementation for a different messaging platform.

Prefer a small subclass over a package fork.

Chat SDK marks the protected subclass surface as less stable than its public interface.

Pin the adapter version when a subclass overrides a protected method.

## Required responsibilities

A platform adapter performs these tasks.

1. It verifies each inbound webhook before parsing content.
2. It rejects old signed requests when the platform supports timestamps.
3. It converts a platform message into a Chat SDK `Message`.
4. It creates stable channel and thread identifiers.
5. It identifies messages that this bot sent.
6. It sends plain text and formatted replies.
7. It reads thread history when the platform permits that action.
8. It exposes platform limits through exact errors.
9. It closes sockets and clients during shutdown.

Do not set `author.isMe` for every message from an authenticated account.

Set it only for messages that this bot instance sent.

This rule prevents response loops without hiding user messages.

## Identifier format

Use one stable prefix for the adapter.

Use this general thread format.

```text
platform:channel-id:thread-id
```

Implement `encodeThreadId` and `decodeThreadId` as inverse functions.

Keep raw platform identifiers intact when possible.

Do not derive an identifier from a mutable channel name.

## Webhook verification

Verify the signature against the original request body.

Do not parse and rebuild the body before verification.

Use a constant-time comparison for message authentication codes.

Enforce the platform timestamp window when one exists.

Return `401` for a bad signature.

Return `400` for a valid signature with an invalid payload.

Return the platform handshake response before background work starts.

Never log an authorization token or a complete signed payload.

## Message normalization

Map the platform payload to these core fields.

| Field | Rule |
| --- | --- |
| `id` | Use the immutable platform message ID. |
| `threadId` | Use the adapter prefix and stable conversation identifiers. |
| `text` | Supply plain readable text. |
| `formatted` | Supply the parsed formatting tree. |
| `author` | Supply stable user details and bot flags. |
| `metadata.dateSent` | Use the platform event time. |
| `attachments` | Include safe metadata and an authenticated fetch function. |
| `isMention` | Set true only when the message targets Seb. |
| `raw` | Preserve the original parsed payload for platform-specific use. |

Filter the bot's own messages before they reach Seb's reply handler.

Preserve attachment size and MIME type when the platform supplies them.

## Outbound messages

Start with plain strings and markdown.

Add streaming only after normal replies work.

Use post-and-edit when the platform lacks native streaming.

Throttle edits below the platform limit.

Buffer the complete answer when the platform does not permit edits.

Return a stable sent-message ID for later edits and deletes.

## State and duplicate delivery

Platforms often retry a webhook before an agent answer finishes.

Claim the platform event ID through the Chat SDK state adapter.

Use a retention period that exceeds the platform retry window.

Use Redis in a multi-instance deployment.

Memory state cannot prevent duplicates across processes.

## Test harness

Use `@chat-adapter/tests` with Vitest.

The package provides mock adapters, state, messages, and common contracts.

Add its setup file to `vitest.config.ts`.

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['@chat-adapter/tests/setup'],
  },
});
```

Use `createMockChatInstance` to verify webhook dispatch.

```typescript
import {
  createMockChatInstance,
  createTestMessage,
} from '@chat-adapter/tests';

const chat = createMockChatInstance();
const message = createTestMessage('message-1', 'hello');
```

Add these test groups.

1. Accept one webhook with a valid signature.
2. Reject one webhook with a changed body.
3. Reject one webhook with an old timestamp.
4. Complete the platform handshake.
5. Dispatch one normal message through `processMessage`.
6. Ignore one message that the bot sent.
7. Round-trip every thread identifier case.
8. Send one reply with the correct platform thread ID.
9. Stop one open client during adapter shutdown.
10. Confirm that a repeated event produces one agent call.

Use `selfMessageContract` for response-loop protection.

Use `threadIdContract` for identifier round trips.

Use `connectWebhookContract` when a custom verifier replaces native verification.

## Connect the adapter to Seb

Export one factory from the custom package.

Create the adapter inside `createConnectorRuntime`.

Add the factory result to the shared adapter record.

Add the connector name to `CONNECTOR_NAMES`.

Add all required secrets to `.env.example` without values.

The shared Seb handlers then support mentions and direct messages.

The HTTP service exposes `/webhooks/{connector-name}` after route validation accepts the name.

## Release review

Complete this review before production use.

- Confirm that every webhook path verifies authenticity.
- Confirm that logs redact secrets and private message bodies.
- Confirm that retries do not create duplicate Gemini calls.
- Confirm that message edits stay below platform limits.
- Confirm that the adapter closes every resident connection.
- Confirm that Redis survives one service restart.
- Confirm that the platform terms permit the planned data use.
- Confirm that a user can remove or disable the integration.
