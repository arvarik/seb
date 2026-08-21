# Data source guide

Seb uses four read-only source families.

Each client records the source URL, retrieval time, and cache outcome.

Seb stores normalized cache values and source snapshots in `.cache/seb.sqlite`.

Read the [storage guide](STORAGE.md) for the common request and stale-data policies.

## Gemini Google Search and URL Context

Seb uses Gemini Google Search for current public reporting.

Seb uses Gemini URL Context for an HTTP or HTTPS page that a user supplies.

These tools return provider source records and grounding metadata.

Google can return an attribution redirect URL for a grounded publisher page.

Seb validates each direct web source URL before it displays the link.

The command line, interactive interface, and chat connectors show these links.

Seb includes the current UTC date in each agent request.

This date helps Gemini interpret terms such as `today` and `latest`.

Seb uses grounded reporting for news, injury discussion, trades, and depth-chart changes.

Sleeper remains authoritative for league and roster data.

nflverse remains authoritative for historical schedules and statistics.

The NWS remains authoritative for United States forecasts and alerts.

Seb does not store a persistent news index in version 0.0.10.

It records validated web source links for the active answer and session.

Seb has no licensed publisher feed, official injury feed, or official projection feed.

Read the [AI SDK guide](AI_SDK.md) for the grounding and output rules.

## Sleeper

Sleeper remains the fantasy league system of record.

Seb reads these data groups.

- The current NFL state.
- Users and NFL leagues.
- League settings and scoring rules.
- League users and rosters.
- Weekly matchups and scores.
- Weekly transactions.
- Current player profiles.
- Trending player adds and drops.

The base URL is `https://api.sleeper.app/v1`.

Sleeper needs no API key for these read-only endpoints.

Seb caches the complete NFL player map for 24 hours.

It can use that cached map for seven more days after a refresh error.

Trending and filtered player results stay fresh for one minute.

Historical matchup and transaction results stay fresh for two minutes.

Other Sleeper results stay fresh for five minutes.

Run `/refresh sleeper` to clear only the Sleeper cache entries.

This command preserves Sleeper snapshots.

Sleeper does not supply the nflverse game-log fields that Seb uses.

Read the [Sleeper documentation](https://docs.sleeper.com/) for the public API contract.

## nflverse

Seb reads compressed CSV files from nflverse GitHub releases.

### Schedule file

Seb reads this file.

```text
https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv.gz
```

The schedule file supplies these useful fields.

- Season, game type, and week.
- Kickoff date and Eastern time.
- Home and away teams.
- Final scores.
- Venue and stadium ID.
- Roof and surface.
- Team rest days.
- Spread and game total fields.
- Recorded temperature and wind for many completed games.

Seb caches the parsed schedule for six hours.

It can use the schedule for seven more days after a refresh error.

### Weekly player files

Seb builds one file URL for each season.

```text
https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_YEAR.csv.gz
```

The weekly file supplies these useful fields.

- Player, position, team, opponent, game, and week.
- Passing attempts, yards, touchdowns, and interceptions.
- Carries, rushing yards, and rushing touchdowns.
- Targets, receptions, receiving yards, and receiving touchdowns.
- Target share, air-yards share, and receiving air yards.
- Standard and PPR fantasy points.

Seb caches each parsed season for six hours.

It can use that season for seven more days after a refresh error.

Run `/refresh nflverse` to clear the schedule and season cache entries.

This command preserves nflverse snapshots.

The first request can take longer because Seb downloads and parses the file.

Later requests use the local parsed cache.

Seb shares one cold download across concurrent requests for the same file.

Direct schedule and player-stat tools return at most 100 rows by default.

The tools report the total row count and whether they truncated the result.

The nflverse-data repository uses the CC BY 4.0 license.

Keep nflverse attribution in a public product that displays this data.

Read the [nflverse organization page](https://github.com/nflverse) and [data repository](https://github.com/nflverse/nflverse-data).

## National Weather Service

Seb uses the NWS API at `https://api.weather.gov`.

The NWS requires a user agent that identifies the application.

Set `NWS_USER_AGENT` to an application name and contact value.

```dotenv
NWS_USER_AGENT=seb/0.0.10 (you@example.com)
```

Seb performs three request types.

1. `/points/{latitude},{longitude}` discovers the grid and hourly forecast URL.
2. The returned `forecastHourly` URL supplies about seven days of hourly periods.
3. `/alerts/active?point={latitude},{longitude}` supplies current alerts.

Seb caches point metadata for seven days.

It can use point metadata for 30 more days after a refresh error.

Seb caches hourly forecasts for ten minutes.

It can use a forecast for six more hours after a refresh error.

Seb caches active alerts for two minutes.

It can use alerts for 30 more minutes after a refresh error.

Run `/refresh weather` to clear those cache entries.

This command preserves NWS snapshots.

Seb validates the forecast host before it follows the returned URL.

Seb uses a 15-second request timeout.

The NWS supports United States locations. Seb returns unavailable for international venues.

Read the [NWS API documentation](https://www.weather.gov/documentation/services-web-api) for the official contract.

## Stadium coordinates

Seb keeps a small current home-stadium coordinate catalog in the repository.

The catalog maps the nflverse home team to an NWS point.

Shared venues include both team codes.

The schedule roof field controls indoor detection.

International games do not use the home-stadium fallback.

Neutral-site games do not use the home-stadium fallback.

Review the catalog before each season. Teams can rename or replace venues.

## Combined game weather

Seb follows this sequence.

1. It reads the selected game from nflverse.
2. It checks the roof field.
3. It converts the nflverse Eastern kickoff time to an exact instant.
4. It finds the current home-stadium coordinate.
5. It loads the NWS hourly periods and active alerts.
6. It selects the period that contains the kickoff.
7. It calculates a transparent low, medium, or high weather signal.

Seb uses recorded nflverse temperature and wind for completed games.

Seb labels those values as historical conditions.

Seb labels NWS values as forecasts.

## Failure behavior

Each client returns an exact source name and HTTP status when possible.

Each client validates source records before it saves or returns them.

Each client stops a response when it exceeds its configured byte limit.

The nflverse client limits compressed and expanded data separately.

Each client makes at most three attempts for a temporary failure.

The retry delay uses exponential backoff with full jitter.

Seb honors `Retry-After` up to five seconds.

Five consecutive final failures open a 30-second client circuit.

Sleeper and NWS use a 15-second request timeout.

nflverse uses a 20-second request timeout.

Seb uses an eligible stale value only after a refresh error.

The source output labels that result as `stale-if-error`.

Seb never replaces a failed data request with model memory.

Seb returns an unavailable result when a kickoff falls outside the forecast window.

The doctor checks the three direct public data source families without cache data.

A grounded news request separately checks Gemini Search access.

```bash
npm run doctor
```

The public-data smoke test skips Gemini.

```bash
npm run data:smoke
```

## Identity and provenance

Sleeper and nflverse use different player identifiers.

Seb can resolve them through a canonical player identity.

Seb persists each resolved mapping and keeps its first canonical ID stable.

It also maps current and historical team codes to one canonical franchise.

Read the [identity guide](IDENTITIES.md) before you join provider records.

Successful source updates create snapshots with field-level source lineage.

Run `seb snapshots` to list those records.

Run `seb snapshots --id ID --json` to inspect a complete provenance manifest.

Read the [provenance guide](PROVENANCE.md) for freshness and derivation rules.
