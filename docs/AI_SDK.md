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

## 1. Direct and grounded current news

The production Gemini agent uses the Gemini Interactions API.

The agent includes a direct news tool, Google Search, and URL Context.

The `searchFirstClassNews` tool searches the built-in registry first.

It returns official NFL, independent, fantasy-impact, and official team reporting.

It also reports the result count, publisher count, and source failures.

Google Search supplies secondary coverage when the direct result is insufficient.

Google Search also runs when the user requests broad web coverage.

URL Context reads an HTTP or HTTPS page that the user supplies.

Seb shows the resulting web links in the command line, interactive interface, and chat connectors.

Sleeper remains authoritative for fantasy league data.

nflverse remains authoritative for schedules and historical statistics.

The NWS remains authoritative for United States weather forecasts and alerts.

Seb does not treat a news article as an official statistic.

Seb treats every tool result and web page as untrusted data.

The model never follows an instruction that appears inside returned data.

Seb has no licensed publisher feed or official injury-report feed.

Read the [data source guide](DATA_SOURCES.md) for every source ID and cache period.

## 2. Typed analysis and decision safeguards

`seb ask --json` uses AI SDK `Output.object` with a Zod schema.

Seb first runs a source-grounded research request with all read-only tools.

Seb then sends that draft to a tool-free formatter request.

This two-request design keeps direct and Google source records available during structured output.

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

Run one current news request when a Gemini key exists.

```bash
seb ask --json "Find current official NFL news and cite the publisher and date."
```

Confirm that the result includes web source links.

Run the live first-class source probe without Gemini.

```bash
npm run news:smoke
```
