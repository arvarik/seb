# Data source guide

Seb uses five read-only source families.

Each client records the source URL, retrieval time, and cache outcome.

Seb stores normalized cache values and source snapshots in `.cache/seb.sqlite`.

Read the [storage guide](STORAGE.md) for the common request and stale-data policies.

## News search order

Seb searches its built-in news registry first.

The registry contains official NFL, independent, fantasy-impact, and official team sources.

Seb validates each article URL and publication date before it returns the article.

Seb ranks relevant articles by query match, source class, and publication time.

Seb limits one publisher to three results in one answer.

Seb recommends Google Search when the direct search returns fewer than five results.

It uses the requested limit when that limit is smaller than five.

It also recommends Google Search when the results contain fewer than two publishers.

An explicit single-source request needs only that publisher.

Google Search also remains available when the user requests broad web coverage.

## First-class NFL news registry

The `searchFirstClassNews` tool accepts an optional list of source IDs.

It also accepts the `official`, `independent`, and `fantasy` categories.

The tool can infer an NFL team from the question or accept a team code.

The registry is built into Seb.

Version `0.1.0` does not read a custom source file.

A tool caller can limit a search with `sourceIds`, `categories`, or `teams`.

### League, independent, and fantasy sources

| Source ID | Category | Source | Discovery method |
| --- | --- | --- | --- |
| `nfl` | Official | [NFL News](https://www.nfl.com/news/) | News sitemap and article metadata |
| `nfl-player-health` | Official | [NFL Player Health and Safety](https://www.nfl.com/playerhealthandsafety/resources/press-releases/) | Publisher page and article metadata |
| `ap-nfl` | Independent | [Associated Press NFL](https://apnews.com/hub/nfl) | NFL hub and article metadata |
| `espn-nfl` | Independent | [ESPN NFL](https://www.espn.com/nfl/) | RSS |
| `cbs-nfl` | Independent | [CBS Sports NFL](https://www.cbssports.com/nfl/) | RSS |
| `profootballtalk` | Independent | [NBC ProFootballTalk](https://www.nbcsports.com/nfl/profootballtalk) | RSS |
| `fox-nfl` | Independent | [FOX Sports NFL](https://www.foxsports.com/nfl) | News sitemap |
| `yahoo-nfl` | Independent | [Yahoo Sports NFL](https://sports.yahoo.com/nfl/) | RSS with syndication publisher labels |
| `rotoworld-player-news` | Fantasy | [NBC Rotoworld Player News](https://www.nbcsports.com/fantasy/football/player-news) | Publisher page |
| `fantasypros-player-news` | Fantasy | [FantasyPros Player News](https://www.fantasypros.com/nfl/player-news.php) | Dated publisher page |
| `fantasypros-team-news` | Fantasy | [FantasyPros Team News](https://www.fantasypros.com/nfl/team-news.php) | Dated team page |
| `pff` | Fantasy | [PFF Fantasy News](https://www.pff.com/news/fantasy-football) | Fantasy RSS items |

The player health source runs only for a related health or safety question.

FantasyPros Team News needs one team. Seb converts `JAX` to the site's `JAC` value.

### Official team news sources

The registry contains one source ID for each current NFL team.

| Team | Source ID | Official news site | Discovery method |
| --- | --- | --- | --- |
| Arizona Cardinals | `team-ari` | [azcardinals.com](https://www.azcardinals.com/news/) | RSS |
| Atlanta Falcons | `team-atl` | [atlantafalcons.com](https://www.atlantafalcons.com/news/) | RSS |
| Baltimore Ravens | `team-bal` | [baltimoreravens.com](https://www.baltimoreravens.com/news/) | RSS |
| Buffalo Bills | `team-buf` | [buffalobills.com](https://www.buffalobills.com/news/) | RSS |
| Carolina Panthers | `team-car` | [panthers.com](https://www.panthers.com/news/) | RSS |
| Chicago Bears | `team-chi` | [chicagobears.com](https://www.chicagobears.com/news/) | RSS |
| Cincinnati Bengals | `team-cin` | [bengals.com](https://www.bengals.com/news/) | RSS |
| Cleveland Browns | `team-cle` | [clevelandbrowns.com](https://www.clevelandbrowns.com/news/) | RSS |
| Dallas Cowboys | `team-dal` | [dallascowboys.com](https://www.dallascowboys.com/news/) | RSS |
| Denver Broncos | `team-den` | [denverbroncos.com](https://www.denverbroncos.com/news/) | RSS |
| Detroit Lions | `team-det` | [detroitlions.com](https://www.detroitlions.com/news/) | RSS |
| Green Bay Packers | `team-gb` | [packers.com](https://www.packers.com/news/) | RSS |
| Houston Texans | `team-hou` | [houstontexans.com](https://www.houstontexans.com/news/) | RSS |
| Indianapolis Colts | `team-ind` | [colts.com](https://www.colts.com/news/) | RSS |
| Jacksonville Jaguars | `team-jax` | [jaguars.com](https://www.jaguars.com/news/) | RSS |
| Kansas City Chiefs | `team-kc` | [chiefs.com](https://www.chiefs.com/news/) | RSS |
| Las Vegas Raiders | `team-lv` | [raiders.com](https://www.raiders.com/news/) | RSS |
| Los Angeles Chargers | `team-lac` | [chargers.com](https://www.chargers.com/news/) | RSS |
| Los Angeles Rams | `team-lar` | [therams.com](https://www.therams.com/news/) | RSS |
| Miami Dolphins | `team-mia` | [miamidolphins.com](https://www.miamidolphins.com/news/) | RSS |
| Minnesota Vikings | `team-min` | [vikings.com](https://www.vikings.com/news/) | RSS |
| New England Patriots | `team-ne` | [patriots.com](https://www.patriots.com/news/) | RSS |
| New Orleans Saints | `team-no` | [neworleanssaints.com](https://www.neworleanssaints.com/news/) | RSS |
| New York Giants | `team-nyg` | [giants.com](https://www.giants.com/news/) | RSS |
| New York Jets | `team-nyj` | [newyorkjets.com](https://www.newyorkjets.com/news/) | RSS |
| Philadelphia Eagles | `team-phi` | [philadelphiaeagles.com](https://www.philadelphiaeagles.com/news/) | RSS |
| Pittsburgh Steelers | `team-pit` | [steelers.com](https://www.steelers.com/news/) | RSS |
| San Francisco 49ers | `team-sf` | [49ers.com](https://www.49ers.com/news/) | RSS |
| Seattle Seahawks | `team-sea` | [seahawks.com](https://www.seahawks.com/news/) | RSS |
| Tampa Bay Buccaneers | `team-tb` | [buccaneers.com](https://www.buccaneers.com/news/) | RSS |
| Tennessee Titans | `team-ten` | [tennesseetitans.com](https://www.tennesseetitans.com/news/) | RSS |
| Washington Commanders | `team-was` | [commanders.com](https://www.commanders.com/news/) | News sitemap and article metadata |

Washington uses its news sitemap because its RSS feed stopped updating.

Seb excludes the Packers Insider Inbox path because the site's robots policy blocks it.

Seb keeps the Eagles feed URL when the article page reports its home page as the canonical URL.

## News crawl and date rules

Seb reads feeds, news sitemaps, and server-rendered publisher pages.

It follows each site's [robots policy](https://www.rfc-editor.org/rfc/rfc9309.html) before it reads content.

It applies a supported crawl delay to requests for the same site.

It does not crawl when a required robots policy is unavailable and no cached policy exists.

It accepts a missing robots file after a final `4xx` response other than `429`.

Seb limits a robots file to 512 KiB and a news response to 4 MiB.

It rejects a cross-site redirect, an invalid content type, and a `no-store` response.

It uses `ETag` and `Last-Modified` values when a publisher supplies them.

It creates a content hash when a publisher supplies no validator.

Seb reads the `datePublished` value from [Article structured data](https://developers.google.com/search/docs/appearance/structured-data/article) when the article needs enrichment.

It can also read an article publication meta value or a dated HTML `time` element.

RSS and Atom items must contain a valid publication date.

News sitemaps use [`news:publication_date`](https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap) for discovery.

Seb treats an article page date as stronger evidence than a sitemap date.

It rejects a missing date, an invalid date, and a date more than 24 hours in the future.

The default search includes articles from the last seven days.

Seb removes tracking parameters and deduplicates canonical URLs and normalized titles.

These methods use current public web standards. They do not bypass access controls.

### News cache periods

| Cache value | Fresh period | Stale period after an error |
| --- | --- | --- |
| NFL News sitemap | 5 seconds | 1 day |
| CBS Sports and PFF discovery | Revalidate on each use | CBS: 1 day. PFF: none. |
| NBC ProFootballTalk and NBC Rotoworld discovery | 1 minute | 1 day |
| Most source discovery records | 5 minutes | 1 day |
| FantasyPros discovery records | 10 minutes | 1 day |
| FOX Sports news sitemap | 20 minutes | 1 day |
| Enriched article metadata | Revalidate on each use | 7 days |
| Robots policy | 24 hours | 30 days |

A cancellation never returns stale news.

Concurrent requests share one refresh for the same cache key.

Run `seb cache clear` to clear all cache entries, including direct news entries.

## Live source validation

The 2026-08-29 source audit tested each retained discovery URL and a dated article.

The audit also tested the robots policy, redirect target, content type, and cache policy.

All 32 official team sites passed the live source audit.

Every retained general source returned at least one plausible publication date.

Run the complete live probe from the same network as Seb.

```bash
npm run news:smoke
```

The command prints one result for each configured source.

It fails when any configured source returns no valid dated article.

Publisher endpoints can change after a release.

Keep deterministic parser tests in CI and run the live probe before each release.

### Sources not retained after the audit

| Candidate | Audit result |
| --- | --- |
| NFL Football Operations | The current page, sitemap, robots file, and feed did not supply a stable live crawl path. |
| AP RSS and API paths | The robots policy blocks these paths. Seb uses the public NFL hub instead. |
| Rotoworld Atom feed | The feed returned no items. Seb uses the server-rendered player news page instead. |
| Footballguys | The page supplied no reliable structured date. It also returned `no-store` and a stale localhost sitemap. |
| RotoWire | The public response returned `no-store`. The API also requires access and has redistribution limits. |
| Yahoo guessed sitemap | The guessed sitemap was not a reliable NFL source. Seb uses the NFL RSS feed instead. |

## Gemini Google Search and URL Context

Seb uses Gemini Google Search for secondary public coverage.

Seb uses Gemini URL Context for an HTTP or HTTPS page that a user supplies.

These tools return provider source records and grounding metadata.

Google can return an attribution redirect URL for a grounded publisher page.

Seb validates each direct web source URL before it displays the link.

The command line, interactive interface, and chat connectors show these links.

Seb includes the current UTC date in each agent request.

This date helps Gemini interpret terms such as `today` and `latest`.

Seb uses direct and grounded reporting for news, injury discussion, trades, and depth-chart changes.

Sleeper remains authoritative for league and roster data.

nflverse remains authoritative for historical schedules and statistics.

The NWS remains authoritative for United States forecasts and alerts.

Seb stores direct discovery records and article metadata in the local cache.

It records validated direct and Google source links for the active answer and session.

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
NWS_USER_AGENT=seb/0.1.0 (you@example.com)
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

The doctor checks Sleeper, nflverse, and NWS without cache data.

A grounded news request separately checks Gemini Search access.

```bash
npm run doctor
```

The public-data smoke test skips Gemini.

```bash
npm run data:smoke
```

The news smoke test checks all 44 direct news sources.

```bash
npm run news:smoke
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
