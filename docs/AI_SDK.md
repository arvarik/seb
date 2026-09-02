# AI SDK integration guide

Seb uses AI SDK features to improve news research, analysis, context size, tool selection, local debugging, and interactive streaming.

## Interactive stream integration

Seb owns the conversation loop and terminal renderer.

The loop uses the public AI SDK chat transport and UI message contracts.

The renderer reads public AI SDK UI message streams with `readUIMessageStream`.

This design keeps the agent and transport behavior unchanged.

It also gives Seb complete control over prompt editing and screen layout.

Seb does not import private package source files.

This design lets AI SDK package updates stay independent from the terminal interface.

## 1. Providers, direct news, and grounded news

Seb constructs Google, Anthropic, OpenAI, and OpenAI-compatible models through their AI SDK provider packages.

Google uses the Gemini `generateContent` adapter. OpenAI uses the Responses adapter.

Anthropic uses its provider adapter. Compatible endpoints use the OpenAI-compatible chat adapter.

Every provider receives the direct `searchFirstClassNews` tool.

The Google agent also receives Google Search and URL Context.

The `searchFirstClassNews` tool searches the built-in registry first.

It returns official NFL, independent, fantasy-impact, and official team reporting.

It also reports the result count, publisher count, and source failures.

Google Search supplies secondary coverage when the direct result is insufficient and Google is active.

Google Search also runs for broad web coverage when Google is active.

URL Context reads a user-supplied HTTP or HTTPS page only when Google is active.

Seb shows the resulting web links in the command line, interactive interface, and chat connectors.

Sleeper remains authoritative for fantasy league data.

nflverse remains authoritative for schedules and historical statistics.

The NWS remains authoritative for United States weather forecasts and alerts.

Seb does not treat a news article as an official statistic.

Seb treats every tool result and web page as untrusted data.

The model never follows an instruction that appears inside returned data.

Seb has no licensed publisher feed or official injury-report feed.

Read the [data source guide](DATA_SOURCES.md) for every source ID and cache period.

### Provider resolution

`seb configure` saves keys separately from non-secret model settings.

Environment keys override saved keys. Environment model values override saved model values.

An explicit CLI or slash model override uses that model as its own fallback.

A provider-only override keeps the configured fallback for that provider.

`SEB_MODEL` keeps the resolved fallback when `SEB_FALLBACK_MODEL` is empty.

The normal configured primary uses its fallback only after a capacity or rate-limit error.

The OpenAI-compatible provider accepts an optional key, a required base URL, and a required model ID.

HTTP compatible endpoints must use a loopback host. Remote endpoints must use HTTPS.

Compatible URLs cannot contain credentials, a query, a fragment, or an individual completion endpoint path.

Compatible model and discovery requests reject redirects.

The compatible endpoint must support streaming and tool calls for the full agent flow.

Interactive configuration verifies one local tool loop before it saves the selection.

## 2. Typed analysis and decision safeguards

`seb ask --json` uses AI SDK `Output.object` with a Zod schema.

Seb first runs a source-grounded research request with all read-only tools.

Seb then sends that draft to a tool-free formatter request.

This two-request design keeps direct and optional Google source records available during structured output.

The validated `analysis` object includes these fields.

- An analysis kind and subject.
- A summary and optional recommendation.
- A confidence level, score, and reason.
- Named metrics with values and context.
- Strengths, weaknesses, risks, assumptions, and limits.

The output includes `schemaVersion: 1`.

Seb formats the validated object into the existing `answer` field.

The `sources` field stays separate from the model object.

This rule lets Seb validate each HTTP or HTTPS source before output.

Seb applies a deterministic eligibility gate after schema validation.

The gate compares requested players and leagues with the executed tool inputs and results.

The gate removes a recommendation when required source, identity, player status, current news, league scoring, or projection evidence is missing.

Start-sit output needs an eligible scoring-aware projection.

An active scoring rule that the projection cannot calculate makes that projection ineligible.

The gate limits confidence when a fresh required source has a stale supplemental source.

Interactive, command-line, and connector paths record each tool input with its result.

Interactive and connector answers use the same gate for direct action requests.

These paths buffer a direct action answer until the gate finishes.

This rule prevents an unsupported partial action from reaching the user.

Select useful fields with `jq`.

```bash
seb ask --json "Should I start Player A?" | jq '.analysis.recommendation'
seb ask --json "Compare these teams." | jq '.analysis.confidence.score'
```

## 3. Context pruning

Seb calls AI SDK `pruneMessages` before each model request.

The policy removes all reasoning data from the prior context.

The policy removes tool calls and tool results older than the last six messages.

The policy also removes empty messages.

Recent user and assistant text remains available.

The interactive transport keeps at most 24 recent model messages.

This policy reduces token use during long interactive and connector sessions.

## 4. Tool input examples

Each main data tool includes valid input examples.

AI SDK middleware converts those examples into provider-compatible tool descriptions.

The examples distinguish player names from player IDs.

The examples also distinguish league IDs, roster IDs, team codes, seasons, and weeks.

This feature improves tool selection without changing the tool input schema.

## 5. Local usage telemetry

The production agent records the active model provider and model ID.

Google returns input, output, thought, cached, tool-use, and total token values when those values exist.

The OpenAI-compatible adapter requests streamed usage values from endpoints that support them.

AI SDK normalizes model usage and performance for each logical model step.

Seb registers `SebUsageTelemetry` through the AI SDK telemetry integration interface.

The integration observes run, model-step, tool-execution, completion, error, and cancellation events.

The interactive transport closes unfinished runs when a user stops local stream consumption.

This explicit action covers stream cancellation paths that do not emit an AI SDK abort event.

Seb applies terminal precedence in this order: aborted, failed, then completed.

This rule corrects a completed callback when later structured-output validation fails.

It also corrects a startup error when a later abort callback confirms cancellation.

Seb keeps the first terminal timestamp during each correction.

It records interactive, top-level command, connector, doctor, setup, and live contract activity in the local SQLite database.

One recorded model call equals one AI SDK model step.

The provider can make HTTP retries inside one step. The AI SDK event does not expose those retries to Seb.

Seb saves AI SDK token classes and selected Google usage fields.

The Google fields add provider totals, tool-use tokens, grounding counts, and service tier when Google returns them.

Seb recognizes the `standard`, `priority`, `flex`, and `deferred` service tiers. It maps another value to `other`.

Seb keeps a missing provider metric as `null`. The reports show the known coverage for each token class.

AI SDK performance data supplies model response time, time to first output, and complete step time.

AI SDK tool lifecycle events supply client execution duration and final outcome.

Model content parts supply provider tool calls and provider results.

Seb sets `recordInputs: false` and `recordOutputs: false` when DevTools is off.

DevTools enables both shared AI SDK flags because it records content in its separate trace store.

The local analytics integration ignores content in both configurations.

The analytics tables do not contain prompts, answers, tool inputs, tool results, or raw errors.

They also exclude keys, authorization headers, and compatible endpoint URLs.

The `/usage` and `/stats` commands read these local records without a model request.

The reports group safe error categories and calculate the successful run rate.

They also count failed runs that follow a returned client tool.

The successful run rate counts runs that end with `stop` against those runs plus failed runs.

It excludes approval pauses, cancellations, and unfinished runs. It does not measure completed user answers.

The JSON reports use stable schema version 1.

## 6. Local AI SDK DevTools

AI SDK DevTools records model calls, messages, outputs, and tool data on the local computer.

Enable recording for one local Seb session.

```bash
SEB_DEVTOOLS=true npm run seb
```

Start the local viewer in another terminal.

```bash
npm run devtools
```

Run `/devtools` inside Seb to show the active setting and commands.

DevTools writes trace data under `.devtools/`.

Git ignores that folder.

The files can contain complete prompts, model answers, and tool data.

Never enable DevTools in production.

Seb rejects this configuration when `NODE_ENV=production`.

Delete local trace files with a normal file operation when you no longer need them.

DevTools and local usage telemetry have different privacy rules.

DevTools records complete content. Local usage telemetry records metadata only.

## Verification

Run the complete local checks.

```bash
npm run check
npm run deps:check
npm audit
```

Run one current news request when a configured provider exists.

```bash
seb ask --json "Find current official NFL news and cite the publisher and date."
```

Confirm that the result includes web source links.

Run the doctor to verify one streaming local tool continuation.

The Google doctor check also verifies one grounded Google Search URL.

```bash
npm run doctor
```

Unit tests use AI SDK model mocks and injected HTTP mocks.

They cover all four provider selections, provider construction, private storage, setup prompts, model switching, connector routing, and safe error text.

The unit suite does not require live Anthropic, OpenAI, or OpenAI-compatible credentials.

Use `seb doctor` with each real provider configuration when live integration coverage is required.

Run the live first-class source probe without a model provider.

```bash
npm run news:smoke
```

## 2026 design sources

These official sources define the current telemetry and usage basis.

- [AI SDK telemetry](https://ai-sdk.dev/docs/ai-sdk-core/telemetry)
- [AI SDK tool calling](https://ai-sdk.dev/docs/ai-sdk-core/tools-and-tool-calling)
- [AI SDK Anthropic provider](https://ai-sdk.dev/providers/ai-sdk-providers/anthropic)
- [AI SDK OpenAI provider](https://ai-sdk.dev/providers/ai-sdk-providers/openai)
- [AI SDK OpenAI-compatible providers](https://ai-sdk.dev/providers/openai-compatible-providers)
- [Gemini generateContent API](https://ai.google.dev/api/generate-content)
- [Gemini function calling](https://ai.google.dev/gemini-api/docs/function-calling)
- [Gemini token guidance](https://ai.google.dev/gemini-api/docs/tokens)
- [Gemini rate limits](https://ai.google.dev/gemini-api/docs/rate-limits)
- [OpenTelemetry GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/)
- [OpenTelemetry 2026 GenAI observability guidance](https://opentelemetry.io/blog/2026/genai-observability/)

AI SDK marks its telemetry interface as experimental. Seb isolates that interface behind its own versioned recorder.

The 2026 OpenTelemetry guidance calls for agent, model, tool, token, and latency visibility.

Seb records those dimensions locally. It keeps prompt and output content disabled for this analytics store.

The local JSON schema is not an OpenTelemetry exporter. Its fields remain stable through Seb schema version 1.
