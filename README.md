# Seb

**A source-grounded NFL and fantasy football research assistant for your terminal.**

Seb connects player research, current news, matchup context, weather, and your Sleeper leagues in one conversation.

Ask a normal football question. Seb selects the current week, finds the right sources, and keeps the subject for your next question.

```text
Show Derrick Henry's recent production and latest verified news.
Look deeper into his usage.
Compare him with Saquon Barkley for this week's matchup and weather.
```

## Why Seb

- **Start with a question.** You do not need to select a week, league, roster, team, or workflow first.
- **Connect Sleeper once.** Seb discovers your current leagues, owned rosters, and useful league settings.
- **Follow the evidence.** Seb uses Sleeper, nflverse, the National Weather Service, and grounded web sources.
- **Move from facts to decisions.** Continue from a player profile into comparison, matchup, weather, news, or roster analysis.
- **Protect each decision.** Seb withholds advice when current identity, status, news, scoring, or projection evidence is incomplete.
- **Keep control.** Seb only reads data. It never changes a lineup, waiver claim, trade, or league setting.

## Three ways to use Seb

| Experience | Use it for | Example |
| --- | --- | --- |
| **Explore** | Players, NFL teams, league-wide statistics, schedules, results, and news | `Show Baltimore's recent offensive trends.` |
| **My Fantasy** | Sleeper leagues, rosters, deadlines, player news, and league health | `What needs my attention across my leagues?` |
| **Analyze** | Comparisons, start-sit choices, trades, matchups, usage, and weather | `Compare my flex options for this week.` |

You can ask naturally. The `/explore`, `/fantasy`, and `/analyze` commands remain available when you want an explicit mode.

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

Connect Sleeper from the terminal interface when you want personal fantasy context.

```text
/connect your-sleeper-name
```

Seb saves only the optional username. It refreshes the current NFL state and fantasy context when a session starts.

## Trust by design

Seb separates source facts from model explanation.

- Sleeper supplies account, league, roster, matchup, transaction, and player records.
- nflverse supplies schedules, results, weekly production, usage, and team performance.
- The National Weather Service supplies United States forecasts and active alerts.
- Gemini grounded search supplies current public reporting and source links.
- Local storage keeps checked cache records, source snapshots, identities, and provenance.

Seb reports source freshness and stale-data warnings. It never presents model memory as current news.

Each answer keeps its own numbered Evidence section with live, cached, or stale retrieval details.

Seb has no licensed publisher feed, official injury feed, or official projection feed.

## Documentation

- [Experience model](docs/EXPERIENCES.md)
- [Setup guide](docs/SETUP.md)
- [Interactive guide](docs/INTERACTIVE.md)
- [Command-line guide](docs/CLI.md)
- [Terminal interface](docs/TERMINAL_UI.md)
- [Data sources and limits](docs/DATA_SOURCES.md)
- [Complete documentation index](docs/README.md)

Contributors can start with the [architecture guide](docs/ARCHITECTURE.md).
