# Architecture guide

Seb separates conversation control, source access, deterministic analysis, and model explanation.

This design keeps current facts outside model memory.

## Request flow

1. The command-line parser selects chat, ask, setup, doctor, cache, snapshot, replay, completion, help, or version mode.
2. Interactive chat loads a season-only profile or creates one automatically.
3. The Seb renderer reads and edits the terminal prompt.
4. The transport runs a slash command locally or sends a normal question to the agent.
5. `ToolLoopAgent` gives Gemini the read-only tools, grounded web tools, and active session instructions.
6. Middleware adds valid input examples to each compatible data tool.
7. An identity tool resolves ambiguous player or team identifiers when necessary.
8. Gemini selects only the tools that the question needs.
9. A source client reads a fresh SQLite cache record or requests the source.
10. Google Search or URL Context returns current public reporting when necessary.
11. A deterministic function calculates summaries and risk signals.
12. Gemini explains the returned facts.
13. The transport adds web sources and contextual next actions.
14. The Seb renderer draws the response, tool progress, badges, and supported charts.

## Agent harness

Seb uses AI SDK `ToolLoopAgent` for model and tool-loop control.

Each tool uses a Zod input schema.

The schemas validate seasons, weeks, teams, limits, IDs, and other inputs.

The agent uses at most 12 model and tool steps for one request.

The agent runs AI SDK `pruneMessages` before each model request.

This policy removes reasoning and old tool data from the active context.

The tools perform read-only actions.

The direct data tools cap large row results.

Summary tools can read a complete file internally and return a small result.

The identity tools return ambiguity instead of a guessed source join.

`seb ask --json` uses a separate agent with AI SDK `Output.object`.

The first request gathers evidence and grounded source records.

The second tool-free request converts that evidence into the validated schema.

Seb formats that object into the compatible `answer` field.

## Interactive renderer and transport

AI SDK controls the message loop and calls the custom chat transport.

Seb owns the terminal renderer.

The renderer supplies prompt input, tool approval, stream display, and terminal cleanup.

Seb supplies a custom `ChatTransport` around `DirectChatTransport`.

The direct transport enables AI SDK source stream parts.

The custom transport intercepts slash commands before the model call.

It removes local command messages from later model context.

It also supports a `/new` model-context boundary.

The transport appends contextual suggestions as UI stream parts.

The transport also appends validated grounded web sources.

This step uses no extra Gemini request.

The `/commands` search uses local command metadata.

The `/complete` command ranks local command and argument candidates.

The renderer opens a live palette when the input starts with `/`.

The renderer calculates the palette, transcript, header, and prompt rows together.

Arrow keys change the selection. Tab fills the selected value.

AI SDK TUI has no public custom renderer hook in version `1.0.72`.

Seb pins that exact version and uses only the internal runner entry point.

Seb does not import the private AI SDK terminal renderer.

The local renderer uses the public `readUIMessageStream` function.

Review the runner adapter before each TUI dependency update.

Pure editor, history, theme, and presentation modules contain most terminal behavior.

Tests can verify those modules without a live terminal or model request.

## Session context

The session stores these values in memory.

- NFL season and week.
- Sleeper user, league, and roster.
- NFL team.
- Active skill.
- Token totals.
- Model-context boundary.

The agent receives these values through dynamic call instructions.

A direct value in the user question overrides the active session value.

## Setup profile

Interactive chat loads one validated JSON profile before it starts the TUI.

The top-level setup command validates Gemini and reads the current NFL season.

The profile stores only the NFL season, schema version, and update time.

Sleeper and NFL team values remain in the in-memory session.

It never stores an API key.

The profile store uses a private temporary file and an atomic rename.

The [setup guide](SETUP.md) defines path selection and file permissions.

## Source clients

Each direct public source has one client class.

- `SleeperClient` reads JSON endpoints.
- `NflverseClient` reads compressed CSV releases.
- `WeatherClient` reads NWS GeoJSON endpoints.

The production model uses the Gemini Interactions endpoint.

The model also receives two provider tools.

- Gemini Google Search reads current public reporting.
- Gemini URL Context reads a user-supplied web page.

Each direct source client accepts an injected `fetch` function.

Tests use that injection to avoid network requests.

Each direct source client accepts a source observer.

The observer records exact URLs, retrieval times, and cache outcomes.

The session source tracker records grounded HTTP and HTTPS source links.

`ResilientFetch` gives each client bounded retries and request timeouts.

It applies full-jitter backoff and honors `Retry-After`.

It opens a short circuit after repeated final failures.

## Cache design

Seb stores normalized source values in `.cache/seb.sqlite`.

Each cache record includes expiry times, source validators, a schema version, and a checksum.

Clients send `If-None-Match` and `If-Modified-Since` when a source supplied validators.

A successful `304` response renews the existing record.

A source failure can use an eligible stale record.

An expired record never serves as a stale fallback.

The SQLite store uses write-ahead logging and a five-second busy timeout.

The nflverse client shares a cold download across concurrent requests.

The refresh commands delete only known source cache namespaces.

They preserve all source snapshots.

Read the [storage guide](STORAGE.md) for exact periods and retention counts.

## Snapshot and provenance design

A successful source update can create one versioned snapshot.

The snapshot contains the normalized payload, source schema, checksum, and provenance manifest.

The manifest assigns source IDs and freshness to exact JSON Pointer fields.

Large payloads use root lineage after the configured field-path limit.

Derived lineage can reference fields from other envelopes.

The derivation records an operation name and calculation version.

The `/provenance` command shows a stored manifest inside chat.

The [provenance guide](PROVENANCE.md) defines each freshness state.

## Identity design

`TeamIdentityRegistry` maps aliases and provider codes to 32 canonical franchises.

Each canonical team ID uses the `nfl-team:CODE` format.

`PlayerIdentityRegistry` maps source IDs and normalized names to canonical players.

Strict automatic matching requires the same name, position, and team.

The registry reports ambiguous or conflicting candidates.

The agent can call a team or player identity tool before it joins source data.

`IdentityRepository` saves each resolved identity and its provider links in SQLite.

The repository reuses the first canonical ID after a later cross-source match.

It rejects source links that already point to conflicting canonical IDs.

Read the [identity guide](IDENTITIES.md) for matching and persistence limits.

## Weather safety

The NWS point endpoint returns the hourly forecast URL.

Seb verifies that the returned URL uses the configured NWS origin.

Seb sends the required user agent with each NWS request.

Seb validates coordinates before each request.

Seb skips a direct weather effect for a closed roof or a dome.

Seb labels past nflverse weather fields as historical conditions.

Seb labels NWS values as forecasts.

## Deterministic analysis

Plain TypeScript functions calculate the following results.

- Player averages and latest three-game averages.
- Targets, touches, target share, and air-yards share.
- Weekly PPR volatility.
- Team records and scoring averages.
- Team offense totals.
- Defense PPR points and targets allowed by position.
- Weather risk and its reason list.

The model explains these results. It does not calculate hidden source facts.

## Local model inspection

Seb can register AI SDK DevTools telemetry during local development.

The feature stays disabled unless `SEB_DEVTOOLS` equals `true` or `1`.

Seb rejects the feature when `NODE_ENV` equals `production`.

The local viewer reads trace files from `.devtools/`.

Read the [AI SDK guide](AI_SDK.md) before you enable trace recording.

## Historical evaluation

The replay runner converts nflverse weekly records into a versioned evaluation dataset.

Each forecast period has an exact knowledge cutoff.

Training requires an earlier period and an availability time before that cutoff.

The replay rejects a target or outcome that reveals future information.

The default baseline blends the complete history with the latest three results.

Metrics cover point error, interval coverage, and weekly rank quality.

The common metric library also supports probability calibration and decision regret.

Read the [evaluation guide](EVALUATION.md) for exact rules and limits.

## Test design

Vitest checks clients, SQLite storage, identities, provenance, evaluation, commands, setup, weather, CLI behavior, and connectors.

AI SDK `MockLanguageModelV4` checks complete agent tool loops without model cost.

Chat SDK test adapters check connector behavior without platform credentials.

`npm run data:smoke` checks live nflverse and NWS data without Gemini.

`npm run doctor` checks every source and one small Gemini request.

Run the full local gate before each commit.

```bash
npm run check
```

## Extension points

Add a new source in this order.

1. Add a typed client with an injected fetch function.
2. Add the shared resilient request policy.
3. Add SQLite cache, stale-if-error, and snapshot rules.
4. Add source tracking and field-level provenance.
5. Add canonical identity mapping when the provider uses new identifiers.
6. Add deterministic transformation functions.
7. Add small read-only agent tools.
8. Add client, storage, and tool-loop tests.
9. Add doctor and smoke coverage.
10. Document access, freshness, attribution, and failure behavior.

Add a new skill in `src/interactive/skills.ts`.

Give the skill one purpose, exact instructions, and useful suggestions.

Do not give a skill authority to write league or platform data.
