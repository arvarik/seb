# Production operations

This guide applies to the connector service.

The command-line agent does not need a resident server.

## Runtime model

Run `npm run connectors` as a resident Node.js 22 service.

The service listens on `HOST` and `PORT`.

Place an HTTPS reverse proxy or load balancer before the service.

The proxy must preserve the original webhook request body.

The service returns platform acknowledgements before Gemini work finishes.

Background tasks continue the agent request after each acknowledgement.

## State

The connector selects Redis when `REDIS_URL` contains a value.

The connector selects memory state when `REDIS_URL` is empty.

Use memory state only for local tests.

Memory state loses subscriptions and duplicate claims after restart.

Memory state cannot coordinate more than one service process.

Redis stores these connector records.

- Thread subscriptions
- Distributed locks
- Overlapping-message queues
- Duplicate event claims
- Short-lived adapter caches

Use Redis 6 or a newer compatible service.

Enable Redis persistence according to the service recovery target.

Restrict Redis network access to the Seb service.

Use a dedicated Redis key prefix or database for each environment.

The current code uses the `seb` key prefix.

## Overlapping messages

Seb uses the Chat SDK `queue` strategy.

The first message starts the agent request immediately.

Later messages wait while the same thread remains busy.

The queue keeps up to ten messages for each thread.

The queue removes the oldest item when it becomes full.

Queued messages expire after 90 seconds.

The next agent turn receives skipped intermediate messages as context.

## Service scaling

Use Redis before you start a second HTTP instance.

Slack and Telegram webhooks can use several HTTP instances with shared state.

Run only one Discord Gateway loop for each Discord bot token.

Run only one Slack Socket Mode connection during simple local development.

Run only one Telegram polling process for each Telegram bot token.

Prefer webhooks when several instances must receive traffic.

## Health checks

Use this liveness route.

```text
GET /health
```

The route returns `200` while the HTTP process can answer.

The JSON response includes enabled connectors, state type, and background task count.

This route does not call Redis, Gemini, Sleeper, or a platform API.

Add a separate synthetic test when dependency health must affect alerts.

Do not restart the service only because Gemini returns one capacity error.

Seb already retries the configured fallback model.

## Secrets

Store these values in the deployment secret store.

- `GOOGLE_GENERATIVE_AI_API_KEY`
- Platform bot tokens
- Platform signing secrets
- Webhook verification tokens
- `REDIS_URL`

Do not bake a secret into a container image.

Do not print `.env` in a build log.

Rotate a platform token after any suspected exposure.

Restart every service instance after a non-dynamic secret rotation.

## Logs

The service writes startup and shutdown messages to standard output.

The service writes failures and retry notices to standard error.

The Chat SDK writes adapter lifecycle events through its console logger.

Collect both streams in the deployment log service.

Do not add complete request payloads to production logs.

Add a request correlation ID at the proxy when cross-service tracing becomes necessary.

Track these operational values.

- Webhook response latency
- Agent answer latency
- Gemini error count by status
- Sleeper error count by endpoint
- Platform post and edit failures
- Discord Gateway reconnect count
- Redis connection failures
- Queue full events

## Safe deployment sequence

1. Run `npm ci` in a clean build environment.
2. Run `npm run check`.
3. Start Redis and verify its network policy.
4. Add Gemini and platform secrets.
5. Start one Seb instance.
6. Check `/health`.
7. Send one test message from each enabled platform.
8. Confirm one answer and one follow-up answer.
9. Review logs for signature or permission errors.
10. Add more HTTP instances only after shared-state verification.

## Upgrade sequence

1. Run `npm run deps:check`.
2. Read release notes for AI SDK and Chat SDK.
3. Update related Chat SDK packages together.
4. Run `npm install` to update the lock file.
5. Run `npm run check`.
6. Test one tool call with `npm run test:harness`.
7. Test one signed webhook per platform.
8. Deploy to a development environment.
9. Review streaming and duplicate event behavior.
10. Promote the tested lock file to production.

Do not update one Chat SDK adapter without checking the core `chat` version.

## Incident actions

### Gemini fails

Confirm the key and model names.

Check whether the fallback model also fails.

Keep webhook acknowledgements active so platforms do not create a retry storm.

### Sleeper fails

Run `npm run sleeper:smoke` from the same network.

Inspect the failed endpoint and status in the service log.

Do not substitute model memory for current Sleeper data.

### Redis fails

Stop extra connector instances.

Restore Redis before normal production traffic resumes.

Do not switch a multi-instance service to memory state.

### A platform token leaks

Revoke or rotate the token in the platform console.

Update the deployment secret.

Restart the affected connector service.

Review recent platform activity for unauthorized posts.

### Duplicate answers appear

Confirm that every instance uses the same Redis service.

Confirm that the proxy does not change signed webhook bodies.

Confirm that only one polling or Gateway process uses each bot token.
