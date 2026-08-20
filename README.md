# Seb

Seb is a read-only fantasy football agent for Sleeper leagues. It uses Gemini to select tools and explain the returned data.

The V0 reads public Sleeper data. It never changes a league, roster, waiver claim, trade, or lineup.

Seb uses Gemini 3.7 Flash by default. One-shot requests retry Gemini 3.6 Flash after a temporary capacity error.

The current project version is `0.0.1`. Seb follows the [documented release policy](docs/VERSIONING.md).

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

4. Verify the complete setup.

   ```bash
   npm run doctor
   ```

5. Start the interactive terminal interface.

   ```bash
   npm run seb
   ```

6. Ask one question without the interactive interface.

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

See [the detailed setup guide](docs/SETUP.md) for verification and troubleshooting.

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

## V0 capabilities

- Read the current NFL state.
- Find Sleeper player records.
- Read a user's leagues.
- Read league settings, users, rosters, matchups, and transactions.
- Read and resolve trending adds or drops.
- Rank fantasy rosters from league results.
- Compare two fantasy rosters with a transparent heuristic.

The roster analysis uses only Sleeper results. It does not claim to be a betting model or an official Sleeper projection.

Sleeper does not document NFL schedules, player game logs, projections, or news in its public API. See [the V1 design](docs/V1.md) for the planned data sources and analysis.

## Development

```bash
npm run check
npm run doctor
npm run test:connectors
npm run test:harness
npm run deps:check
```

The agent uses `ToolLoopAgent` because this project needs direct model and tool-loop control. AI SDK `HarnessAgent` targets sandboxed coding runtimes and remains experimental.

The agent test harness uses AI SDK 7's `MockLanguageModelV4`. It tests a complete tool call without network use or model cost.

The connector harness uses Chat SDK mocks and contract matchers. It tests routing, subscriptions, configuration, and webhook dispatch without platform credentials.

The Sleeper player endpoint can return a large response. Seb stores that response in `.cache/` for 24 hours, as Sleeper recommends.

Seb uses the [Sleeper API](https://docs.sleeper.com/). Sleeper states that the API is free for non-commercial use and asks clients to stay below 1,000 calls each minute.
