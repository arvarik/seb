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
| **Current news** | Direct reporting from 44 built-in NFL sources, with Google Search as secondary coverage. |
| **Player research** | Profiles, game logs, usage, production, news, and injury context. |
| **Team research** | Schedules, results, offensive trends, defensive matchups, and game conditions. |
| **My Fantasy** | Automatic discovery of your current Sleeper leagues, rosters, settings, and weekly needs. |
| **Decisions** | Start-sit, waiver, trade, matchup, and playoff analysis with explicit limits. |
| **Weather** | Kickoff forecasts and alerts from the National Weather Service for United States venues. |
| **Evidence** | Numbered sources with live, cached, or stale retrieval details. |

Seb only reads data. It never changes a lineup, waiver claim, trade, or league setting.

## Quick start

Seb requires Node.js 22 or newer and a [Gemini API key](https://aistudio.google.com/app/apikey).

```bash
git clone https://github.com/arvarik/seb.git
cd seb
npm install
cp .env.example .env
```

Add the Gemini key to `.env`.

```dotenv
GOOGLE_GENERATIVE_AI_API_KEY=your-key
```

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

## Use Seb your way

Install the short `seb` command in the active Node.js environment.

```bash
npm link
```

Start the full terminal interface.

```bash
seb
```

Ask one question from a script.

```bash
seb ask "Show the current NFL state."
```

Return a validated JSON object.

```bash
seb ask --json "Should I start Player A?"
```

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
| First-class news registry | Official NFL, independent, fantasy-impact, and all 32 official team sources. |
| Gemini Google Search | Secondary public coverage when direct sources do not give enough evidence. |
| National Weather Service | United States forecasts and active weather alerts. |

Seb checks news dates, publisher crawl rules, redirects, content types, and parsed values before it stores news data.

Seb records source freshness and stale-data warnings. It never presents model memory as current news.

Each answer keeps a numbered Evidence section with live, cached, or stale retrieval details.

## Honest limits

Seb has no licensed publisher feed, official injury feed, or official projection feed.

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

- [Data sources and limits](docs/DATA_SOURCES.md)
- [Provenance and replay](docs/PROVENANCE.md)
- [Local storage and cache](docs/STORAGE.md)

### Build and contribute

- [Architecture guide](docs/ARCHITECTURE.md)
- [AI SDK integration](docs/AI_SDK.md)
- [Testing and verification](docs/ARCHITECTURE.md#test-design)
- [Complete documentation index](docs/README.md)
