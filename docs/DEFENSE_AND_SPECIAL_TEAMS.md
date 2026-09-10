# Defense and special teams

Seb 1.0.2 projects team D/ST and individual special-teams scoring.
Use a team name or code with `projectPlayer`, `projectPlayers`, or `compareStartSit`.
`projectLeagueMatchup` includes D/ST starters automatically.
The model returns expected points, a median, a range, and explicit scoring limits.

## Scoring rules and sources

Sleeper separates team special-teams scoring from individual special-teams scoring.
Seb assigns each event to its correct unit. It does not apply a player's `st_td` setting to a team defense.
See [Sleeper special-teams scoring](https://support.sleeper.com/en/articles/3278982-special-teams-scoring-options).

Points allowed differ from an opponent's final score.
Seb removes touchdowns against the offense, such as interception and offensive-fumble returns.
It retains ensuing extra points and two-point conversions.
Kickoff, punt, and blocked-punt return touchdowns remain points allowed.
It excludes safeties against the offense.
See [Sleeper points-allowed rules](https://support.sleeper.com/en/articles/4126495-how-are-points-allowed-calculated).

Yards allowed use opponent passing yards, rushing yards, and negative sack yardage.
Return yards do not enter that total.
See [Sleeper yards-allowed rules](https://support.sleeper.com/en/articles/4126427-how-are-yards-allowed-calculated).

The supported team settings cover sacks, interceptions, forced fumbles, opponent fumble recoveries, defensive touchdowns, safeties, blocked kicks, quarterback hits, tackles for loss, defensive two-point returns, and special-teams events.
Special-teams settings cover touchdowns, forced fumbles, opponent recoveries, solo tackles, and return yards.
Seb also supports points-allowed and yards-allowed tiers and linear scoring.
Each total enters exactly one tier for its metric.
Unknown active defense settings remain explicit omissions. They prevent a complete-score claim.
See [Sleeper scoring options](https://support.sleeper.com/en/articles/3998131-what-scoring-options-are-available).

## Data construction

The client reads two nflverse releases for the analysis season:

- `pbp/play_by_play_YEAR.csv.gz` identifies completed games, possession, special-teams plays, touchdowns, and fumbles.
- `stats_team/stats_team_week_YEAR.csv.gz` supplies official weekly sacks, interceptions, hits, tackles for loss, net-yardage components, returns, safeties, and blocked kicks.

Official weekly totals retain corrections and unusual plays that simple play flags can miss.
The full-season comparison found differences in quarterback hits, tackles for loss, and net yardage.
Seb therefore uses weekly totals for those fields.
It uses opponent sacks suffered to retain team sacks without individual player credit.
The [nflfastR statistics documentation](https://nflfastr.com/reference/calculate_stats.html) explains the official-stat calculation.
The [source implementation](https://github.com/nflverse/nflfastR/blob/master/R/calculate_stats.R) shows its event mappings.

Player projections join special-teams forced fumbles, recoveries, and tackles by game and player identifier.
Official player return-yard fields take precedence over play-level return attribution.
A completed game with no matching special-teams event supplies a verified zero.
A missing completed game supplies an error, not a zero.
Weekly learning uses the same enrichment for leagues with these settings.

The client projects only required play columns into memory.
It caches compact aggregates, shares concurrent loads, limits download and expansion sizes, and retains request cancellation.
It rejects duplicate plays, duplicate team games, missing columns, invalid numbers, and missing final scores.
Only regular-season games with an end-game record enter training.

## Forecast method

Seb scores each historical game with the selected league's rules before it calculates the forecast.
This preserves nonlinear scoring tiers and the relationship between sacks, turnovers, and points allowed within a game.
Scoring average points allowed would produce a different and misleading result.

The ordinary scoring component uses a weighted mixture of three samples:

1. Team history receives weight `0.5 × teamGames / (teamGames + 8)`.
2. Games against the scheduled opponent receive weight `0.5 × opponentGames / (opponentGames + 8)`.
3. All NFL team games receive the remaining weight.

Defensive and special-teams touchdowns use a stronger prior.
Their expected points combine the team's recorded touchdowns with 24 games at the NFL average.
This reduces the effect of rare touchdown streaks.
The returned model parameters describe these weights directly.

The median and range use the weighted historical score distribution.
The range starts at its 10th and 90th percentiles and expands if necessary to include expected points.
It is a descriptive range. Seb does not claim calibrated future coverage.

Week 1 defaults to the previous season.
Later weeks use only earlier completed weeks.
An automatic request can fall back when current-season team data does not exist.
An explicit analysis-season request keeps its selected season and reports missing data.
A missing or started kickoff produces a historical baseline.
Matchup totals accept verified completed Sleeper scores in place of those baselines.

## Recorded benchmark

From a source checkout, run the rolling benchmark with public nflverse data:

```sh
node --import tsx scripts/benchmark-defense.ts 2024
node --import tsx scripts/benchmark-defense.ts 2025
```

The benchmark starts in Week 5. Each forecast uses only earlier weeks from its season.
It compares standard D/ST scoring with team-average and NFL-average baselines.
The fixed model weights did not change between these evaluations.

| Season | Forecasts | Model mean absolute error | Team-average error | NFL-average error | Range coverage |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2024 | 416 | 4.29 | 4.56 | 4.42 | 81.25% |
| 2025 | 416 | 4.30 | 4.54 | 4.39 | 83.89% |

The model improves both error measures in both recorded seasons.
These results use revised public data. They do not reconstruct each historical publication time or prove future accuracy.
The JSON reports also contain root mean squared error:
[2024 results](benchmarks/defense-2024.json), [2025 results](benchmarks/defense-2025.json).

## Remaining limits

Current defensive injuries, coaching changes, and weather do not alter the numerical D/ST model.
Seb can discuss verified news separately. It must not invent a numerical news adjustment.
Rare multi-possession plays can still expose limits in play-level fumble attribution.
Individual defender projections and unsupported custom scoring rules remain unavailable.
Seb labels these limits instead of treating missing components as zero.
