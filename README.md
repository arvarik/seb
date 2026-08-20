# Seb

Seb is a read-only NFL and fantasy football agent. It uses Gemini to select data tools and explain the returned facts.

Seb reads Sleeper, nflverse, and National Weather Service data. It never changes a league, roster, waiver claim, trade, or lineup.

Seb uses Gemini 3.7 Flash through the Gemini Interactions API by default.

One-shot and connector requests use Gemini 3.6 Flash after a temporary capacity or rate-limit error.

The current project version is `0.0.4`. Seb follows the [documented release policy](docs/VERSIONING.md).

## Requirements

- Node.js 22 or newer
- A [Gemini API key](https://aistudio.google.com/app/apikey)

## Setup

1. Install the dependencies.

   ```bash
   npm install
   ```

2. Copy the example environment file.

   ```bash
   cp .env.example .env
   ```

3. Add the Gemini API key to `.env`.

   ```dotenv
   GOOGLE_GENERATIVE_AI_API_KEY=your-key
   ```

   Set the NWS user agent when you want a direct contact value.

   ```dotenv
   NWS_USER_AGENT=seb/0.0.4 (you@example.com)
   ```

4. Verify the complete setup.

   ```bash
   npm run doctor
   ```

5. Create the team-independent profile.

   ```bash
   npm run seb -- setup
   ```

   Setup validates Gemini and records the current NFL season.

   It does not select a Sleeper user, league, roster, or NFL team.

6. Start the interactive terminal interface.

   ```bash
   npm run seb
   ```

   Press `Ctrl+K` or type `/` to open the command palette.

   Use `/leagues`, `/rosters`, and `/team` to select optional context.

   Use `/exit` to close interactive mode.

7. Ask one question without the interactive interface.

   ```bash
   npm run ask -- "Show the current NFL state and the most added players."
   ```

League questions work best when the prompt includes a Sleeper league ID.

```bash
npm run ask -- "Analyze every roster in Sleeper league 123456789."
```

Run `npm link` once when you want a direct `seb` command.

```bash
npm link
seb
```

See the [command-line guide](docs/CLI.md) for pipes, JSON, exit codes, and diagnostics.

See the [interactive guide](docs/INTERACTIVE.md) for slash commands, skills, sources, and transcript exports.

See the [terminal interface guide](docs/TERMINAL_UI.md) for editing, history, themes, shortcuts, badges, charts, and privacy.

See [the detailed setup guide](docs/SETUP.md) for verification and troubleshooting.

Read the [storage guide](docs/STORAGE.md) for SQLite, stale fallback, snapshots, and migration.

Read the [identity guide](docs/IDENTITIES.md) for Sleeper and nflverse mappings.

Read the [provenance guide](docs/PROVENANCE.md) for source lineage and freshness.

Read the [evaluation guide](docs/EVALUATION.md) for replay rules and baseline metrics.

Read the [AI SDK guide](docs/AI_SDK.md) for grounded news, typed results, context pruning, middleware, and local traces.

Install shell completion after `npm link`.

```bash
seb completion zsh
seb completion bash
seb completion fish
```

See the [command-line guide](docs/CLI.md) for exact installation commands.

## Chat connectors

Seb includes connectors for Slack, Discord, and Telegram.

The connectors share one agent and one set of Sleeper tools.

1. Choose a [connector guide](docs/CONNECTORS.md).
2. Add the platform credentials to `.env`.
3. Start the connector service.

   ```bash
   npm run connectors
   ```

4. Check the local health route.

   ```bash
   curl http://localhost:3000/health
   ```

Use Redis for every production connector deployment.

```dotenv
REDIS_URL=redis://your-production-redis
```

The [documentation index](docs/README.md) links every setup and operations guide.

## Current capabilities

- Read the current NFL state.
- Find Sleeper player records.
- Show non-fantasy NFL player, team, schedule, result, and statistic information.
- Read a user's leagues.
- Read league settings, users, rosters, matchups, and transactions.
- Read and resolve trending adds or drops.
- Rank fantasy rosters from league results.
- Compare two fantasy rosters with a transparent heuristic.
- Read current and historical NFL schedules from nflverse.
- Read weekly player production and opportunity data from nflverse.
- Compare recent targets, touches, scoring, market share, and volatility.
- Measure defense results against each fantasy position.
- Compare NFL team results and offense totals.
- Read NWS hourly forecasts and active alerts for United States stadiums.
- Search current public reporting through Gemini Google Search.
- Read user-supplied news pages through Gemini URL Context.
- Return a validated fantasy analysis object from `seb ask --json`.
- Screen a complete NFL week for outdoor weather risk.
- Combine a game, both teams, the venue, and kickoff weather.
- Select focused skills for start-sit, waivers, weather, schedules, and other workflows.
- Edit multiline prompts with cursor movement, word deletion, bracketed paste, and private history.
- Search a categorized command palette with live context values and command effect previews.
- Select contextual actions with the number keys.
- Show persistent context, source freshness, tool duration, decision bars, and terminal charts.
- Resolve and persist player and team identities across Sleeper and nflverse.
- Store checked cache records and versioned source snapshots in SQLite.
- Show source retrieval times, cache outcomes, and stale-data warnings.
- Run historical nflverse baseline replays without future leakage.

The roster analysis uses Sleeper results. The NFL analysis uses nflverse and NWS facts.

Seb can search current public reporting and return source links.

Seb has no licensed publisher feed, official injury feed, or official projection feed.

Seb never uses model memory as current news.

Read the [data source guide](docs/DATA_SOURCES.md) for fields, cache periods, limits, and attribution.

See [the V1 design](docs/V1.md) for news, injuries, calibrated projections, and roster simulations.

## Development

```bash
npm run check
npm run doctor
npm run data:smoke
npm run test:connectors
npm run test:harness
npm run deps:check
npm run devtools
```

Set `SEB_DEVTOOLS=true` before a local Seb run to record AI SDK requests.

Never enable local DevTools in production. The trace files contain prompts and tool data.

The agent uses `ToolLoopAgent` because this project needs direct model and tool-loop control. AI SDK `HarnessAgent` targets sandboxed coding runtimes and remains experimental.

The agent test harness uses AI SDK 7's `MockLanguageModelV4`. It tests a complete tool call without network use or model cost.

The agent prunes old tool data before long model requests.

Model middleware adds valid input examples to each data tool.

The connector harness uses Chat SDK mocks and contract matchers. It tests routing, subscriptions, configuration, and webhook dispatch without platform credentials.

Seb stores remote data in `.cache/seb.sqlite`. The [storage guide](docs/STORAGE.md) explains cache and snapshot rules.

Seb stores the setup profile outside the repository. The [setup guide](docs/SETUP.md) lists the exact path and permissions.

Seb uses the [Sleeper API](https://docs.sleeper.com/). Sleeper states that the API is free for non-commercial use and asks clients to stay below 1,000 calls each minute.

Seb uses [nflverse data releases](https://github.com/nflverse/nflverse-data) under CC BY 4.0.

Seb uses the [National Weather Service API](https://www.weather.gov/documentation/services-web-api) for United States forecasts and alerts.
