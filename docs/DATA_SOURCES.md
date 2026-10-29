# Data source guide

Seb ingests five read-only public data families—**first-class NFL newsrooms (47 sources)**, **optional Gemini grounded web search & URL Context**, **Sleeper**, **nflverse**, and the **National Weather Service (NWS)**—recording exact URLs, retrieval timestamps, cache outcomes, and field-level provenance in `.cache/seb.sqlite` (fronted by a 128-entry in-memory L1 cache). See the [storage guide](STORAGE.md) for SQLite schema and retention rules.

## News search order, FTS5 ranking, and corroboration

Every configured model provider receives `searchFirstClassNews`, which queries Seb's built-in **47-source, 3-tier newsroom registry** (15 official league, national independent, and fantasy outlets plus all 32 official NFL team sites) before any secondary web search runs. Callers can scope searches by `sourceIds`, `categories` (`official`, `independent`, `fantasy`), or `teams` (inferred from the query or passed explicitly).

Discovered articles must pass URL normalization, canonical deduplication, and strict publication-date validation (defaulting to a 7-day lookback and rejecting missing, malformed, or `> 24h` future dates). Validated items are indexed in SQLite FTS5 (`news_articles_fts` with `porter unicode61` tokenization, treating singular/plural variants consistently) and ranked by BM25 relevance, query token coverage, publisher tier, and recency, capped at **3 articles per publisher** in one response:

- **36-hour `corroboratedBy` event clustering**: Stories covering the same player, team, and event within a **36-hour** publication window cluster onto the highest-ranked primary article with `corroboratedBy` attribution metadata. Independent corroboration adds **`+8`** (one corroborating publisher) or **`+12`** (two or more corroborating publishers) to the primary story's rank score, and corroborated publishers count toward publisher-diversity sufficiency so clustered multi-outlet breaking news does not falsely appear single-sourced.
- **Coverage sufficiency and Google Search fallback**: Unless narrowed to a single explicit `sourceId`, Seb flags coverage as insufficient when direct results return fewer than `min(5, limit)` articles or fewer than **2 distinct Tier 1/2 publishers** (including `corroboratedBy` outlets). Only the Google Gemini provider can act on that flag via hosted **Google Search** (and read user-supplied links via **URL Context**); Anthropic, OpenAI, and compatible providers surface the direct-source boundary explicitly without substituting model memory. See the [AI SDK guide](AI_SDK.md).

## First-class NFL news registry

### League, independent, and fantasy sources (15)

| Source ID | Category | Tier | Publisher | Discovery method |
| --- | --- | ---: | --- | --- |
| `nfl` | Official | 1 | [NFL News](https://www.nfl.com/news/) | News sitemap + selective article metadata |
| `nfl-player-health` | Official | 1 | [NFL Player Health & Safety](https://www.nfl.com/playerhealthandsafety/resources/press-releases/) | Publisher page + article metadata (health/safety queries only) |
| `espn-nfl` | Independent | 1 | [ESPN NFL](https://www.espn.com/nfl/) | RSS |
| `profootballtalk` | Independent | 1 | [NBC ProFootballTalk](https://www.nbcsports.com/nfl/profootballtalk) | RSS |
| `profootballrumors` | Independent | 1 | [Pro Football Rumors](https://www.profootballrumors.com/) | RSS |
| `cbs-nfl` | Independent | 2 | [CBS Sports NFL](https://www.cbssports.com/nfl/) | RSS |
| `fox-nfl` | Independent | 2 | [FOX Sports NFL](https://www.foxsports.com/nfl) | News sitemap |
| `nfltraderumors` | Independent | 2 | [NFL Trade Rumors](https://nfltraderumors.co/) | RSS |
| `yahoo-nfl` | Independent | 3 | [Yahoo Sports NFL](https://sports.yahoo.com/nfl/) | RSS (preserving syndicated AP/partner publisher labels) |
| `rotoworld-player-news` | Fantasy | 1 | [NBC Rotoworld Player News](https://www.nbcsports.com/fantasy/football/player-news) | Server-rendered publisher page |
| `fantasypros-player-news` | Fantasy | 1 | [FantasyPros Player News](https://www.fantasypros.com/nfl/player-news.php) | Dated publisher page |
| `fantasypros-team-news` | Fantasy | 1 | [FantasyPros Team News](https://www.fantasypros.com/nfl/team-news.php) | Dated team page (requires team; maps `JAX` $\rightarrow$ `JAC`) |
| `draftsharks` | Fantasy | 1 | [Draft Sharks Shark Bites](https://www.draftsharks.com/shark-bites) | RSS |
| `rotoballer` | Fantasy | 2 | [RotoBaller Fantasy Football](https://www.rotoballer.com/nfl) | RSS |
| `pff` | Fantasy | 2 | [PFF Fantasy News](https://www.pff.com/news/fantasy-football) | Fantasy-filtered RSS |

### Official NFL team newsrooms (32)

All 32 franchises are built into the registry as Tier 1 team sources (`team-ari` through `team-was`). Thirty-one clubs use official RSS feeds while Washington (`team-was`) uses its news sitemap + article metadata because its RSS feed stopped updating; Seb also skips Green Bay's robots-disallowed Insider Inbox path and retains Philadelphia's feed item URL when `philadelphiaeagles.com` canonicalizes articles to its home page.

<details>
<summary>View all 32 official NFL team news feeds</summary>

| Team | Source ID | Official newsroom | Discovery method |
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
| Washington Commanders | `team-was` | [commanders.com](https://www.commanders.com/news/) | News sitemap + article metadata |

</details>

### Crawl compliance, RFC 9309 `robots.txt`, and date extraction

`NewsClient` enforces public web standards and never bypasses publisher access controls:

- **Inline RFC 9309 `robots.txt` parser**: Evaluates `Seb` and `*` user-agent groups using longest-path match precedence across `Allow` and `Disallow` rules (supporting `*` wildcards and `$` end anchors) plus per-origin `Crawl-delay` throttling. Seb refuses to crawl when a required `robots.txt` fetch fails without an eligible cached policy, treats final `4xx` responses other than `429` as an absent robots file, rejects cross-site redirects, unexpected MIME types, and `Cache-Control: no-store` responses, and sends `ETag` / `Last-Modified` validators (or hashes payloads when validators are omitted).
- **Bounded feed & HTML metadata parsing**: RSS/Atom items require valid publication timestamps and cap parsed `<category>` tags at **30 per item**. News sitemaps read [`news:publication_date`](https://developers.google.com/search/docs/crawling-indexing/sitemaps/news-sitemap) for discovery and **skip HTML article-metadata fetches on zero-token-match sitemap entries** so unrelated URLs are never downloaded. When enrichment runs, page-level [Article JSON-LD `datePublished`](https://developers.google.com/search/docs/appearance/structured-data/article), meta tags, or `<time datetime>` elements supersede sitemap timestamps.

### News cache periods and audited exclusions

| News cache entry | Fresh TTL | Stale-if-error window |
| --- | ---: | --- |
| NFL News sitemap (`nfl`) | 30 seconds | 1 day |
| CBS Sports, Pro Football Rumors, NBC ProFootballTalk, NBC Rotoworld, and PFF discovery | 1 minute | 1 day (PFF: none) |
| Standard RSS & publisher-page discovery records | 5 minutes | 1 day |
| FantasyPros player & team discovery records | 10 minutes | 1 day |
| FOX Sports news sitemap (`fox-nfl`) | 20 minutes | 1 day |
| Enriched article HTML metadata | 1 minute | 7 days |
| Publisher `robots.txt` policy | 24 hours | 30 days |

Clear direct news caches (including `news_articles_fts`) via `/refresh news` or `seb cache clear`. Verify all 47 live sources anytime with `npm run news:smoke`.

<details>
<summary>Audited candidate sources excluded from the built-in registry</summary>

| Candidate | Audit reason for exclusion |
| --- | --- |
| NFL Football Operations | Did not expose a stable public feed, sitemap, or server-rendered dated crawl path. |
| Direct AP RSS / API / hub | `robots.txt` disallows RSS/API paths and the public hub returns `403` to automated clients; syndicated AP NFL stories arrive cleanly via `yahoo-nfl` instead. |
| Rotoworld Atom feed | Returned empty feed items; Seb parses the server-rendered NBC Rotoworld player news page instead. |
| Footballguys | Lacked reliable structured dates, returned `no-store`, and served a broken localhost sitemap. |
| RotoWire | Public pages return `no-store` and the commercial API carries redistribution restrictions. |
| Guessed Yahoo sitemap | Unreliable for NFL coverage; replaced by the official Yahoo Sports NFL RSS feed. |

</details>

## Sleeper

[Sleeper's read-only REST API](https://docs.sleeper.com/) (`https://api.sleeper.app/v1`, no API key required) is Seb's system of record for current NFL state, user profiles, leagues, scoring/waiver/playoff settings, rosters, weekly matchups, transactions, player status profiles, and platform add/drop trends:

| Sleeper resource | Fresh TTL | Additional stale-if-error window |
| --- | ---: | ---: |
| Complete NFL player catalog (`/players/nfl`) | 24 hours | 7 days |
| Trending adds/drops and filtered player lookups | 1 minute | 10 minutes |
| Weekly matchups and league transactions | 2 minutes | 1 day |
| NFL state, user leagues, rosters, and league settings | 5 minutes | 1 hour |

Run `/refresh sleeper` to invalidate Sleeper L1/SQLite cache entries while retaining historical snapshots.

## nflverse

Seb streams and validates gzip-compressed CSV releases from [nflverse-data](https://github.com/nflverse/nflverse-data) (licensed under **CC BY 4.0**—preserve nflverse attribution in downstream products displaying these statistics):

| Release path (`https://github.com/nflverse/nflverse-data/releases/download/...`) | Cache key pattern | Contents & projection role | Fresh TTL / Stale window |
| --- | --- | --- | --- |
| `schedules/games.csv.gz` | `schedules-v*` | Kickoffs (ET), home/away teams, final scores, venue/roof/surface, rest days, spread/total lines, historical temp/wind | **6 hours** / 7 days (**15 minutes** when an active-week game has kicked off without final scores) |
| `stats_player/stats_player_week_YEAR.csv.gz` | `player-stats-v*-YEAR` | Weekly passing, rushing, receiving, kicking (with attempt distances), return yards, target/air-yard shares, fumbles, 2PTs | **6 hours** / 7 days |
| `pbp/play_by_play_YEAR.csv.gz` | `defense-v2-YEAR` | Stream-projected play-by-play aggregates: completed game markers, D/ST points-allowed TD/safety exclusions, defensive 2PTs, team & individual ST events (`st_ff`, `st_fum_rec`, `st_tkl_solo`) | **6 hours** / 7 days |
| `stats_team/stats_team_week_YEAR.csv.gz` | `defense-team-v1-YEAR` | Official weekly opponent sacks suffered, interceptions, QB hits, tackles for loss, safeties, blocked kicks, team returns, net yards | **6 hours** / 7 days |

Direct schedule and player-stat agent tools return at most 100 rows by default with total-row and truncation metadata, concurrent callers share a single cold download per release, and `/refresh nflverse` clears all cached nflverse namespaces while preserving snapshots.

## National Weather Service and stadium weather

Seb queries the [National Weather Service API](https://www.weather.gov/documentation/services-web-api) (`https://api.weather.gov`), which requires an identifying `User-Agent` header configured via `NWS_USER_AGENT`:

```dotenv
NWS_USER_AGENT=seb/1.1.2 (you@example.com)
```

Point grid discovery (`/points/{lat},{lon}`) stays fresh for **7 days** (30 days stale), `forecastHourly` periods stay fresh for **10 minutes** (6 hours stale, verifying that the returned forecast URL stays on the configured NWS origin), and `/alerts/active` stays fresh for **2 minutes** (30 minutes stale). Clear weather caches via `/refresh weather`.

When computing combined game weather from nflverse schedules and the built-in U.S. home-stadium coordinate catalog, Seb evaluates conditions in strict order:

1. **Roof check**: Games marked `dome` or `closed` bypass NWS weather impact immediately.
2. **Neutral-site and international check**: Neutral-site (`location === 'Neutral'`) and international venues never fall back to the home team's stadium coordinates, returning unavailable rather than misattributing domestic weather.
3. **Completed games**: Past/completed games report recorded nflverse temperature and wind labeled explicitly as historical conditions.
4. **Forecast horizon check**: Kickoffs more than **8 days** in the future fall outside NWS hourly coverage and return unavailable without polling hourly endpoints.
5. **Hourly forecast & `[kickoff, kickoff + 3h]` alert window**: For upcoming outdoor U.S. games within range, Seb matches the kickoff hour and upgrades game weather risk (`low` / `medium` / `high`) **only for active alerts whose verified effective window intersects `[kickoff, kickoff + 3h]`**, displaying non-overlapping alerts separately as general context.

## Resilience, timeouts, and payload limits

Every source client wraps requests in `ResilientFetch` with up to **3 attempts**, exponential full-jitter backoff, `Retry-After` adherence capped at 5 seconds, and per-origin **30-second circuit breakers** after 5 consecutive final failures. Retryable transient statuses cover standard HTTP throttling/gateway errors (`408`, `425`, `429`, `500`, `502`, `503`, `504`), **Cloudflare origin errors (`520`, `521`, `522`, `523`, `524`, `529`)**, and transient network socket failures. Eligible `stale-if-error` records serve only after a refresh failure (labeled `stale-if-error` in `/sources`), never after user cancellation or cache expiration, and Seb never fabricates missing source data from model memory.

| Client | Request timeout | Response & parsing limits |
| --- | ---: | --- |
| `SleeperClient` | 15 seconds | Bounded JSON response bytes + Zod schema validation |
| `NflverseClient` | 20 seconds | Separate compressed `.csv.gz` download cap and expanded CSV byte cap; streaming column projection on PBP |
| `WeatherClient` | 15 seconds | Coordinate range validation, NWS origin check on `forecastHourly`, bounded GeoJSON payload size |
| `NewsClient` | 15 seconds | `512 KiB` `robots.txt` cap, `4 MiB` feed/sitemap/HTML cap, max `30` RSS/Atom categories per item, same-site redirect enforcement |

> [!TIP]
> Verify live public endpoints without model credentials via `npm run data:smoke` and `npm run news:smoke`, or run full end-to-end provider and tool-loop diagnostics with `npm run doctor`. For cross-provider entity joins and snapshot lineage, see the [identity guide](IDENTITIES.md) and [provenance guide](PROVENANCE.md).
