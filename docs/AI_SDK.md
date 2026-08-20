# AI SDK integration guide

Seb uses AI SDK features to improve news research, analysis, context size, tool selection, local debugging, and interactive streaming.

## Interactive stream integration

The AI SDK runner controls the message loop and chat transport.

Seb supplies a local renderer through the runner renderer interface.

The renderer reads public AI SDK UI message streams with `readUIMessageStream`.

This design keeps the agent and transport behavior unchanged.

It also gives Seb complete control over prompt editing and screen layout.

The installed TUI release does not export the renderer hook from its public entry point.

Seb pins `@ai-sdk/tui` to `1.0.72` and imports only the internal runner entry point.

Seb never imports the private default terminal renderer.

Review this adapter before every TUI dependency update.

## 1. Grounded current news

The production Gemini agent uses the Gemini Interactions API.

The agent includes Google Search and URL Context tools.

Google Search finds current public reporting and returns source records.

URL Context reads an HTTP or HTTPS page that the user supplies.

Seb shows the resulting web links in the command line, interactive interface, and chat connectors.

Sleeper remains authoritative for fantasy league data.

nflverse remains authoritative for schedules and historical statistics.

The NWS remains authoritative for United States weather forecasts and alerts.

Seb does not treat a news article as an official statistic.

Seb treats every tool result and web page as untrusted data.

The model never follows an instruction that appears inside returned data.

Seb has no licensed publisher feed or official injury-report feed.

## 2. Typed analysis output

`seb ask --json` uses AI SDK `Output.object` with a Zod schema.

Seb first runs a grounded research request with all read-only tools.

Seb then sends that draft to a tool-free formatter request.

This two-request design keeps Google source records available during structured output.

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

This policy reduces token use during long interactive and connector sessions.

## 4. Tool input examples

Each main data tool includes valid input examples.

AI SDK middleware converts those examples into provider-compatible tool descriptions.

The examples distinguish player names from player IDs.

The examples also distinguish league IDs, roster IDs, team codes, seasons, and weeks.

This feature improves tool selection without changing the tool input schema.

## 5. Local AI SDK DevTools

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

## Verification

Run the complete local checks.

```bash
npm run check
npm run deps:check
npm audit
```

Run one grounded request when a Gemini key exists.

```bash
seb ask --json "Find current official NFL news and cite the publisher and date."
```

Confirm that the result includes web source links.
