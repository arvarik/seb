# Seb

**Current NFL research. Safer fantasy decisions. One terminal.**

[![CI](https://github.com/arvarik/seb/actions/workflows/ci.yml/badge.svg)](https://github.com/arvarik/seb/actions/workflows/ci.yml)

Seb combines NFL data, current reporting, weather, and your Sleeper leagues in one conversation.

Ask a normal question. Seb finds the current context, gathers the evidence, and shows whether the evidence supports an action.

```text
Show Derrick Henry's recent production and latest verified news.
Look deeper into his usage.
Compare him with Saquon Barkley for this week's matchup and weather.
```

Seb keeps the active subject between questions. You do not need to repeat the player, week, or league.

## What Seb can do

| Need | What Seb gives you |
| --- | --- |
| **Current news** | Direct reporting from 44 built-in NFL sources. Google adds Search as secondary coverage. |
| **Player research** | Profiles, game logs, usage, production, news, and injury context. |
| **Team research** | Schedules, results, offensive trends, defensive matchups, and game conditions. |
| **My Fantasy** | Automatic discovery of your current Sleeper leagues, rosters, settings, and weekly needs. |
| **Decisions** | Scoring-aware projections, starter comparisons, legal trade lineups, waiver ranks, and playoff simulations. |
| **Weekly learning** | Local player trends, team errors, bounded parameter updates, and historical accuracy reports. |
| **Weather** | Kickoff forecasts and alerts from the National Weather Service for United States venues. |
| **Evidence** | Numbered sources with live, cached, or stale retrieval details. |

Seb reads your fantasy leagues. It never changes a lineup, waiver claim, trade, or league setting.

Optional weekly learning updates local forecast parameters after completed games and validation.

## Quick start

Seb requires Node.js 22 or newer and one configured model provider.

```bash
git clone https://github.com/arvarik/seb.git
cd seb
npm install
cp .env.example .env
```

Run the private configuration flow.

```bash
npm run seb -- configure
```

Choose Google Gemini, Anthropic, OpenAI, or an OpenAI-compatible endpoint.

Seb masks typed keys and tests the selected model before it saves the configuration.

The compatible flow accepts a local loopback endpoint or a remote HTTPS endpoint.

Run the flow again when you want to add another provider or change a saved model.

You can also add a provider key to `.env`. This example uses a [Gemini API key](https://aistudio.google.com/app/apikey).

```dotenv
GOOGLE_GENERATIVE_AI_API_KEY=your-key
```

Hosted Anthropic and OpenAI configurations use `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`.

An OpenAI-compatible configuration needs a base URL and model. Its API key is optional.

Environment values take priority over saved values.

Seb ignores provider selection, custom endpoints, and private storage paths from a current-directory `.env` file.

Use `seb configure` or an explicit shell environment for a compatible endpoint.

Verify the installation and start Seb.

```bash
npm run doctor
npm run seb
```

Connect Sleeper when you want personal fantasy context.

```text
/connect your-sleeper-name
```

Seb saves only the optional username. It refreshes the current NFL state and fantasy context for each session.

## Ask questions in three connected experiences

### Explore

Research the NFL without a fantasy account.

```text
Show Baltimore's recent offensive trends.
What changed in the latest verified Seahawks news?
Compare the rushing usage for these two players.
```

### My Fantasy

Connect Sleeper and ask across every current league that you own.

```text
What needs my attention across my leagues?
Show urgent news for players on my rosters.
Which league has the weakest running back depth?
```

### Analyze

Turn the active subject into a comparison or decision.

```text
Compare my flex options for this week.
Rank these waiver targets and explain the free-agent acquisition budget ranges.
Review this trade for my selected league.
```

Use `/explore`, `/fantasy`, or `/analyze` when you want to select an experience directly.

Run `/provider` or `/model` to inspect the active model.

Run `/provider NAME` or `/model MODEL` to switch it for the current session.

`/provider` keeps that provider's configured fallback. `/model` uses one model without a separate fallback.

## Use Seb your way

Install the short `seb` command in the active Node.js environment.

```bash
npm link
```

Start the full terminal interface.

```bash
seb
```

Seb shows provider reasoning separately from the answer when the provider supplies it.
Progress labels show thinking, reasoning, and answer writing.
Press Escape to stop a request, including during startup. Use `/retry` to try again.
Scroll with PgUp/PgDn or the mouse wheel. Seb preserves your reading position when the answer finishes.

Ask one question from a script.

```bash
seb ask "Show the current NFL state."
```

Select a configured provider or model for one run.

```bash
seb ask --provider anthropic "Show the current NFL state."
seb chat --provider openai --model gpt-5.6-luna
```

`--provider` keeps the configured fallback. An explicit `--model` uses that model as its own fallback.

Return a validated JSON object.

```bash
seb ask --json "Should I start Player A?"
```

Inspect locally recorded model activity.

```bash
seb usage
seb stats
```

`seb usage` defaults to today. `seb stats` defaults to the latest seven days.

Run `/usage` or `/stats` inside the interactive interface for the current session.

The reports show the successful run rate, safe error categories, and failures after a returned client tool.

These reports read local Seb telemetry. They do not query Google billing or calculate currency cost.

Seb also supports Slack, Discord, and Telegram through read-only connectors.

Read the [command-line guide](docs/CLI.md) and [connector guide](docs/CONNECTORS.md) for setup details.

## How Seb protects a decision

1. Seb resolves the requested player, team, league, and roster.
2. Seb gathers current facts from direct data and news sources.
3. Deterministic functions calculate statistics, projections, and ranking signals.
4. A final gate checks that the evidence matches the requested subject and league.
5. Seb withholds the action when identity, news, status, scoring, or projection evidence is incomplete.

Start-sit advice requires an eligible projection for the selected league.

Trade review rejects duplicate players and received players from several opposing rosters.

Waiver rankings use stable absolute scales. The score does not change because a weaker candidate leaves the request.

The same safeguards apply to terminal, JSON, and connector answers.

## Sources and trust

Seb separates source facts from model explanation.

| Source | Seb uses it for |
| --- | --- |
| Sleeper | NFL state, fantasy leagues, rosters, settings, matchups, transactions, and player records. |
| nflverse | Schedules, results, weekly production, usage, and team performance. |
| First-class news registry | Official NFL, independent, fantasy-impact, and all 32 official team sources for every model provider. |
| Google Search and URL Context | Secondary public coverage and user-supplied web pages when Google is the active provider. |
| National Weather Service | United States forecasts and active weather alerts. |

Seb checks news dates, publisher crawl rules, redirects, content types, and parsed values before it stores news data.

Seb records source freshness and stale-data warnings. It never presents model memory as current news.

Each answer keeps a numbered Evidence section with live, cached, or stale retrieval details.

Seb stores saved API keys in a private credential file. The non-secret model settings file contains no keys.

Remote compatible endpoints must use HTTPS. Local HTTP endpoints must use a loopback host.

Compatible model and discovery requests reject redirects.

Local usage telemetry stores metadata only. It excludes prompts, answers, tool inputs, tool results, and raw errors.

It also excludes API keys, authorization headers, and compatible endpoint URLs.

## Honest limits

Seb has no licensed publisher feed, official injury feed, or official projection feed.

An OpenAI-compatible endpoint must support model streaming and tool calls for the full Seb agent flow.

Public reporting can conflict or change. nflverse releases can lag the latest completed game.

The National Weather Service supports United States locations only.

Seb states these limits in the answer when they affect a conclusion.

## Documentation

### Use Seb

- [Setup guide](docs/SETUP.md)
- [Interactive guide](docs/INTERACTIVE.md)
- [Command-line guide](docs/CLI.md)
- [Experience model](docs/EXPERIENCES.md)
- [Terminal interface](docs/TERMINAL_UI.md)
- [Skills and advanced workflows](docs/SKILLS.md)
- [Chat connectors](docs/CONNECTORS.md)

### Understand the evidence

- [Analysis, forecast accuracy, and weekly learning](docs/ANALYSIS.md)

- [Data sources and limits](docs/DATA_SOURCES.md)
- [Provenance and replay](docs/PROVENANCE.md)
- [Local storage and cache](docs/STORAGE.md)

### Build and contribute

- [Architecture guide](docs/ARCHITECTURE.md)
- [AI SDK integration](docs/AI_SDK.md)
- [Testing and verification](docs/ARCHITECTURE.md#test-design)
- [Complete documentation index](docs/README.md)
