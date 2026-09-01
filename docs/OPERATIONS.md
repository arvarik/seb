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

Redis does not store source caches or source snapshots.

Each Seb process uses the local `.cache/seb.sqlite` file for those records.

Give the service user read and write access to the `.cache` directory.

Use one persistent volume when source snapshots must survive a deployment.

Separate instances can use separate SQLite files.

Those instances can download the same public source value independently.

Do not place one SQLite file on a filesystem that breaks SQLite locking.

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

## Live contract checks

The `Live contracts` GitHub Actions workflow runs each Monday and supports manual runs.

The source job calls Sleeper, nflverse, and the National Weather Service without local cache data.

Run the same source contracts locally.

```bash
npm run contract:sources
```

The answer job sends a fixed evidence object to Gemini.

It also verifies one local tool result, one model continuation, and one grounded Google Search source.

It requires the `GOOGLE_GENERATIVE_AI_API_KEY` repository secret.

The job validates the structured answer schema, player identity, and recommendation limit.

Run the same answer contract locally when the environment contains the key.

```bash
npm run contract:answer
```

Treat a contract failure as a provider or integration change until the evidence shows another cause.

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

Do not print SQLite snapshot payloads in normal production logs.

Keep `SEB_DEVTOOLS` disabled in every production environment.

AI SDK DevTools stores complete prompts, model output, and tool data in local files.

Add a request correlation ID at the proxy when cross-service tracing becomes necessary.

Track these operational values.

- Webhook response latency
- Agent answer latency
- Gemini error count by status
- Successful agent-run rate
- Failed run count after a returned client tool
- Safe model error count by category
- Sleeper error count by endpoint
- nflverse download failures by release file
- NWS error count by endpoint
- NWS forecast age at answer time
- Cache result count by fresh, updated, not-modified, and stale-if-error outcomes
- Open request circuit count by source
- SQLite write errors and database size
- Structured `seb.telemetry.write_failed` warning count
- Platform post and edit failures
- Discord Gateway reconnect count
- Redis connection failures
- Queue full events

## Safe deployment sequence

1. Run `npm ci` in a clean build environment.
2. Run `npm run check` and `npm run test:coverage`.
3. Start Redis and verify its network policy.
4. Add Gemini and platform secrets.
5. Start one Seb instance.
6. Run `seb cache status` as the service user.
7. Check `/health`.
8. Send one test message from each enabled platform.
9. Confirm one answer and one follow-up answer.
10. Review logs for signature or permission errors.
11. Add more HTTP instances only after shared-state verification.

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

### Current news fails

Inspect the visible web source list in a local reproduction.

Run the live direct source probe.

```bash
npm run news:smoke
```

Inspect the failed source ID, discovery URL, and publication date.

Check the site's robots policy and required crawl delay.

Retry the request after a temporary direct source or Gemini Search error.

Do not replace current reporting with model memory.

Keep the answer unavailable when both direct and secondary coverage fail.

### Sleeper fails

Run `npm run sleeper:smoke` from the same network.

Inspect the failed endpoint and status in the service log.

Do not substitute model memory for current Sleeper data.

### nflverse fails

Run `npm run data:smoke` from the same network.

Check the requested season and release file URL.

Use `/refresh nflverse` in interactive mode after a source update.

Use `seb cache clear` from the service directory when all cache namespaces need a refresh.

Do not substitute model memory for a schedule or statistic.

### The National Weather Service fails

Confirm that `NWS_USER_AGENT` identifies the application.

Run `npm run data:smoke` from the same network.

Keep weather unavailable until the NWS request succeeds.

Do not replace the forecast with model memory.

### Seb reports stale source data

Inspect `/sources` in an interactive reproduction.

The result shows the failed refresh and cached retrieval time.

Check source access before you clear the local cache.

Seb stops using that value after its stale-if-error period expires.

### SQLite fails

Run `seb cache status` as the service user.

Confirm the `.cache` directory owner and permissions.

Confirm that the volume supports SQLite locks and atomic writes.

Restore the database backup when historical snapshots matter.

Read the [storage recovery guide](STORAGE.md) before you replace the file.

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
