# Architecture guide

Seb separates conversation control, source access, deterministic analysis, and model explanation.

This design keeps current facts outside model memory.

## Request flow

1. The command-line parser selects chat, ask, setup, doctor, cache, snapshot, replay, completion, help, or version mode.
2. Seb loads one optional saved Sleeper username.
3. Seb refreshes the NFL state, league season, leagues, owned rosters, and league settings.
4. The Seb renderer reads and edits the terminal prompt.
5. The transport selects Explore, My Fantasy, or Analyze from the question.
6. The transport runs a slash command locally or sends a normal question to the agent.
7. `ToolLoopAgent` gives Gemini the read-only tools, direct news tools, grounded web tools, and active session instructions.
8. Middleware adds valid input examples to each compatible data tool.
9. An identity tool resolves ambiguous player or team identifiers when necessary.
10. Gemini selects only the tools that the question needs.
11. A source client reads a fresh SQLite cache record or requests the source.
12. The news client searches built-in sources before Google Search.
13. Google Search supplies secondary coverage when the direct result has insufficient coverage.
14. URL Context reads a web page that the user supplies.
15. A deterministic function calculates summaries and risk signals.
16. Gemini explains the returned facts.
17. AI SDK telemetry emits run, model-step, performance, and tool lifecycle events.
18. Seb writes bounded usage metadata to the local SQLite database.
19. The transport records each executed tool input and result for the decision gate.
20. A decision gate matches that evidence to the requested subject and selected league.
21. The gate replaces an unsupported action before any user-facing output.
22. The transport adds validated web sources and records contextual actions.
23. The Seb renderer draws the response, responsive tables, record cards, tool progress, badges, and supported charts.

## Agent harness

Seb uses AI SDK `ToolLoopAgent` for model and tool-loop control.

Each tool uses a Zod input schema.

The schemas validate seasons, weeks, teams, limits, IDs, and other inputs.

The agent uses at most 12 model and tool steps for one request.

The agent runs AI SDK `pruneMessages` before each model request.

This policy removes reasoning and old tool data from the active context.

The last allowed step disables tools and asks the model for the final answer.

The active tool set controls the news instructions.

An agent without web tools reports that it cannot verify current news.

The interactive transport binds one cancellation signal to each model request.

It also binds the signal to local commands that read a network source.

The agent binds that signal to every local tool call.

The source clients use the same signal for downloads, cache waits, and retry delays.

Connector replies use one two-minute deadline for the primary and fallback models.

Connector shutdown cancels all active reply signals.

The tools perform read-only actions.

The direct data tools cap large row results.

Summary tools can read a complete file internally and return a small result.

The identity tools return ambiguity instead of a guessed source join.

Each answer path records a tool input with its result.

The decision gate never relies on the model's claim about which tool ran.

`seb ask --json` uses a separate agent with AI SDK `Output.object`.

The first request gathers evidence and grounded source records.

The second tool-free request converts that evidence into the validated schema.

Seb formats that object into the compatible `answer` field.

The gate removes an ineligible recommendation after schema validation.

## Interactive renderer and transport

AI SDK controls the message loop and calls the custom chat transport.

Seb owns the terminal renderer.

The renderer supplies prompt input, tool approval, stream display, and terminal cleanup.

Seb supplies a custom `ChatTransport` around `DirectChatTransport`.

The direct transport enables AI SDK source stream parts.

The custom transport intercepts local slash commands before the model call.

It selects an experience from normal question terms.

Explicit `/explore`, `/fantasy`, and `/analyze` commands can select the same experiences.

An inline `/skill NAME QUESTION` command selects the skill and sends the question to the model.

It removes local command messages from later model context.

It also supports a `/new` model-context boundary.

The transport records contextual actions for the renderer.

The transport records a tool-selected player only when the user named that player.

The transport also binds validated direct and web sources to the answer ID.

This step uses no extra Gemini request.

The transport buffers a direct action answer until the decision gate finishes.

An error or cancellation discards an unsupported partial action.

The `/commands` search uses local command metadata.

The `/complete` command ranks local command and argument candidates.

The renderer opens a live palette when the input starts with `/`.

The renderer calculates the palette, transcript, header, and prompt rows together.

The renderer enables terminal mouse reporting for transcript scrolling.

It renders each contextual action on a separate footer row.

It shows these rows on the first prompt and after `/new` or `/clear`.

Arrow keys change the selection. Tab fills the selected value.

Seb owns the conversation runner and local renderer.

The runner uses the public AI SDK chat transport and UI message contracts.

The local renderer uses the public `readUIMessageStream` function.

Pure editor, history, theme, and presentation modules contain most terminal behavior.

Tests can verify those modules without a live terminal or model request.

## Session context

The session stores these values in memory.

- Active Explore, My Fantasy, or Analyze experience.
- NFL season, phase, and display week.
- Sleeper league season.
- Sleeper username and user ID.
- Every discovered league and owned roster.
- Available trade, playoff, and waiver settings.
- Optional focused league and roster.
- NFL team.
- Active NFL player.
- Active skill.
- Token totals.
- Model-context boundary.

The agent receives trusted skill rules through dynamic call instructions.

Seb limits each remote session string and serializes the session data as one JSON value.

The agent adds that JSON to the current user message as untrusted runtime data.

The model must not follow instructions inside a session value.

A direct value in the user question overrides the active session value.

## Account preferences

Interactive chat loads one validated JSON profile before it starts the TUI.

One-shot requests load the same profile before they call the agent.

The top-level setup command validates Gemini and accepts one optional Sleeper username.

The profile stores only that username, the schema version, and the update time.

League, roster, NFL state, and subject values remain in the in-memory session.

It never stores an API key.

The profile store uses a private temporary file and an atomic rename.

The [setup guide](SETUP.md) defines path selection and file permissions.

## Source clients

Each direct public source has one client class.

- `SleeperClient` reads JSON endpoints.
- `NflverseClient` reads compressed CSV releases.
- `WeatherClient` reads NWS GeoJSON endpoints.
- `NewsClient` reads feeds, news sitemaps, and supported publisher pages.

The production model uses the Gemini Interactions endpoint.

The model also receives two provider tools.

- Gemini Google Search supplies secondary public coverage.
- Gemini URL Context reads a user-supplied web page.

`NewsClient` uses a built-in registry of official, independent, fantasy-impact, and team sources.

It validates publication dates before it returns an article.

It validates parsed discovery arrays and article metadata before it stores them.

It recommends Google Search when direct results contain too few articles or publishers.

Each direct source client accepts an injected `fetch` function.

Tests use that injection to avoid network requests.

Each direct source client accepts a source observer.

The observer records exact URLs, retrieval times, and cache outcomes.

The source tracker records grounded HTTP and HTTPS source links.

The interactive state stores one immutable source snapshot for each answer ID.

`ResilientFetch` gives each client bounded retries and request timeouts.

It applies full-jitter backoff and honors `Retry-After`.

It opens a short circuit after repeated final failures.

A caller cancellation stops the active request and its retry delay.

Caller cancellation does not add a source failure to the shared circuit.

The news client checks each publisher's robots policy before it reads content.

It also applies crawl delays, response size limits, and same-site redirect checks.

## Cache design

Seb stores normalized source values in `.cache/seb.sqlite`.

Each cache record includes expiry times, source validators, a schema version, and a checksum.

A cache hit also requires the stored source URL to match the requested source URL.

The current client policy calculates freshness from the stored retrieval time.

Seb persists the recalculated deadlines before a storage prune can delete the record.

Clients send `If-None-Match` and `If-Modified-Since` when a source supplied validators.

A successful `304` response renews the existing record.

A source failure can use an eligible stale record.

A caller cancellation never uses a stale record.

An expired record never serves as a stale fallback.

The SQLite store uses write-ahead logging and a five-second busy timeout.

Concurrent reads in one Seb process use one source refresh per database file.

Each caller can cancel its own wait without cancelling another caller.

One shared refresh writes one cache record and one source snapshot.

Each caller keeps its own eligible stale fallback when the shared refresh fails.

Seb stops the shared refresh when every waiting caller cancels.

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
- Scoring-aware player projections and eligibility.
- Stable waiver production, demand, need, and risk scores.
- Trade production value and roster position changes.

The model explains these results. It does not calculate hidden source facts.

## Decision gate

The gate activates when a question requests a direct fantasy action.

It checks current source state, player identity, status, news, league scoring, and projection eligibility.

The identity and league checks compare the question with the executed tool inputs and results.

A start-sit action needs a projection with enough games and complete supported active scoring rules.

The trade service rejects duplicate players and received players from several opposing rosters.

The waiver service uses fixed production references and an absolute demand scale.

The gate replaces a blocked action with exact missing requirements.

It reduces confidence when fresh required evidence includes a stale supplemental source.

## Local usage analytics

Seb uses the AI SDK telemetry integration interface for local usage records.

The production model uses the Google Interactions API.

AI SDK supplies normalized model-step usage, performance values, and tool lifecycle events.

Google usage adds provider-specific totals, tool-use tokens, grounding counts, and service tier when available.

One model call in a report means one logical AI SDK model step.

Provider HTTP retries can occur inside that step. Seb does not observe those retries.

`SebUsageTelemetry` records runs, model steps, and tool calls across the interactive, command-line, and connector surfaces.

It deduplicates repeated lifecycle events by run, step, and tool-call identifiers.

The recorder writes input, cache-read, cache-write, output, text, reasoning, tool-use, and total token classes.

It keeps an omitted metric as unknown. It never converts an omitted metric to zero.

Seb keeps the AI SDK normalized total separate from the provider total. The two totals can use different provider accounting rules.

The recorder also writes response time, time to first output, complete step time, and client tool duration.

Tool records separate client execution from provider execution.

Tool outcomes include returned, error, invalid, cancelled, and unresolved.

Analytics calculate totals, matched-call weighted token ratios, distributions, model groups, tool groups, repeated calls, and daily trends.

Each ratio reports its matched-call count. A missing token class never becomes zero in a ratio.

Model totals, daily totals, and cumulative client duration also report their measured-call coverage.

A stored `running` status means the recorder received no terminal lifecycle event. Reports call this state `unfinished` because a stopped process can leave it behind.

The interactive transport explicitly closes active usage runs when a user stops a stream.

Terminal state precedence is aborted, failed, then completed.

This order resolves AI SDK callback races without changing the first terminal timestamp.

A repeated call is each extra call with the same tool name in one run. The analytics do not compare tool input.

Reports include missing metrics, conflicting token fields, and truncated query state.

Each report reads the 10,000 newest matching runs at most.

Top-level JSON output uses schema version 1.

The local reports do not query Google quota, credits, billing totals, or currency cost.

The recorder disables input and output capture for local analytics.

It stores identifiers, timestamps, numeric metrics, and bounded categories.

It does not store prompts, answers, tool inputs, tool results, or raw errors.

AI SDK DevTools uses a separate content-rich trace store.

Read the [AI SDK guide](AI_SDK.md#5-local-usage-telemetry) for the event and provider basis.

Read the [storage guide](STORAGE.md#usage-telemetry) for schema and retention details.

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

Vitest checks clients, SQLite storage, usage telemetry, analytics, identities, provenance, evaluation, commands, setup, weather, CLI behavior, and connectors.

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
