# Defense and special teams

Seb projects team D/ST (`DEF`) and individual special-teams scoring across `projectPlayer`, `projectPlayers`, `compareStartSit`, `optimizeRosterLineup`, `projectLeagueMatchup`, `analyzeTradeImpact`, and `rankWaiverTargets`. Pass any NFL team name, alias, or canonical code (such as `"Seattle Seahawks"` or `"SEA"`) to project a team defense; Seb returns expected points, a descriptive median and 10th–90th percentile range, model weights, and explicit scoring-scope limits.

## Scoring rules and Sleeper unit boundaries

Sleeper separates team D/ST special-teams events from individual player special-teams events, so Seb attributes each play to its exact scoring unit and never applies an individual player's `st_td` weight to a team defense (see [Sleeper special-teams scoring](https://support.sleeper.com/en/articles/3278982-special-teams-scoring-options) and [Sleeper scoring options](https://support.sleeper.com/en/articles/3998131-what-scoring-options-are-available)):

- **Points allowed**: Computed per [Sleeper points-allowed rules](https://support.sleeper.com/en/articles/4126495-how-are-points-allowed-calculated) rather than raw scoreboard totals. Seb subtracts touchdowns scored directly against the team's offense (interception returns and offensive fumble-recovery returns) and safeties surrendered by the offense, while retaining ensuing PATs/two-point conversions and kickoff, punt, or blocked-kick return touchdowns allowed.
- **Yards allowed**: Computed per [Sleeper yards-allowed rules](https://support.sleeper.com/en/articles/4126427-how-are-yards-allowed-calculated) from opponent net passing yards (including negative sack yardage) plus opponent rushing yards, excluding return yardage. Both mutually exclusive tier buckets and linear per-point/per-yard rules are supported.
- **Defensive & special-teams events**: Team `DEF` projections cover sacks, interceptions, forced fumbles, opponent fumble recoveries, defensive TDs, safeties, blocked kicks, QB hits, tackles for loss, defensive 2-point returns, and team special-teams TDs, forced fumbles, recoveries, solo tackles, and return yards. Individual offensive/returner projections separately enrich `st_td`, `st_ff`, `st_fum_rec`, `st_tkl_solo`, and kick/punt return yardage. Unrecognized custom defense keys remain explicit `partial-scoring` omissions rather than zeros.

## Data construction and source reconciliation

Official weekly stat summaries preserve stat corrections and multi-player sack/TFL accounting that raw play-by-play flags can miss, whereas play-by-play rows distinguish offensive turnovers from special-teams and defensive scoring plays. Seb reconciles three nflverse releases (documented in [nflfastR `calculate_stats`](https://nflfastr.com/reference/calculate_stats.html) and [`calculate_stats.R`](https://github.com/nflverse/nflfastR/blob/master/R/calculate_stats.R)):

| Metric group | Authoritative nflverse release | Cache key & reconciliation rule |
| --- | --- | --- |
| Sacks, interceptions, QB hits, tackles for loss, safeties, blocked kicks, team return yards, and net passing/rushing yards allowed | `stats_team/stats_team_week_YEAR.csv.gz` | Cached under `defense-team-v1-YEAR`. Uses opponent `sacks_suffered` so uncredited team sacks are retained alongside official weekly stat corrections. |
| Completed-game boundaries, offensive-turnover TD & safety exclusions from points allowed, defensive 2PT returns, and team vs. player special-teams TDs, forced fumbles (`st_ff`), recoveries (`st_fum_rec`), and solo tackles (`st_tkl_solo`) | `pbp/play_by_play_YEAR.csv.gz` | Stream-projected to required columns only and cached as compact aggregates under `defense-v2-YEAR`. Completed games without matching ST plays record verified `0`s; missing games throw an error rather than substituting `0`. |
| Individual player kick and punt return yardage (`kr_yd`, `pr_yd`) and offensive stats | `stats_player/stats_player_week_YEAR.csv.gz` | Cached under `player-stats-v*-YEAR`. Official weekly player return-yard totals take precedence over play-level return yardage attribution. |

`NflverseClient` shares concurrent downloads, bounds compressed and decompressed byte sizes, honors caller `AbortSignal` cancellation during decompression and parsing, filters strictly to regular-season games with verified end-of-game rows, and rejects duplicate plays, duplicate team-weeks, missing columns, or non-finite final scores.

### Integration across lineup, correlation, trade, and waiver tools

- **Same-game covariance (`sameGameCorrelation`)**: In `compareStartSit` and `projectLeagueMatchup`, pairing an offensive player or kicker (`QB`, `RB`, `WR`, `TE`, `K`) with the opposing team's `DEF` in the same scheduled game applies $\rho = -0.25$ (verified via a mutual scheduled-opponent check) to capture negative game-script, sack, turnover, and points-allowed coupling.
- **Lineup optimization & matchups**: `optimizeRosterLineup` evaluates `DEF` starter slots and bench defenses alongside offensive and kicker slots (locking kicked-off defenses in place), and `projectLeagueMatchup` substitutes verified completed Sleeper `DEF` scores once a game finishes.
- **Trades, waivers, and weekly learning**: `TradeImpactService` (`analyzeTradeImpact`), `WaiverAssistantService` (`rankWaiverTargets`), and `learnCompletedWeek` apply the same play-by-play special-teams (`st_ff`, `st_fum_rec`, `st_tkl_solo`) and official return-yardage enrichment whenever a league activates those scoring rules.

## Forecast method

Because points-allowed and yards-allowed tiers are nonlinear and covary within a game with sacks and turnovers, Seb scores every historical team-game under the league's exact rules **before** aggregating—avoiding the distortion of plugging average points allowed into a tier table.

Non-touchdown D/ST points blend three historical pools:

1. **Team defense history**: Weight `0.5 * teamGames / (teamGames + 8)`
2. **Scheduled opponent offenses faced**: Weight `0.5 * opponentGames / (opponentGames + 8)`
3. **League-wide NFL team-game baseline**: Remaining weight `1 - teamWeight - opponentWeight`

High-variance defensive and special-teams return touchdowns shrink separately toward a stronger **24-game NFL-average prior** so brief pick-six or return streaks do not dominate projections. The returned descriptive `median` and `[low, high]` interval use the weighted historical game-score distribution's 50th, 10th, and 90th percentiles (expanded if needed to bracket `expectedPoints`). Week 1 (and automatic windows when current-season team files are not yet published) falls back to the prior regular season, whereas explicit season overrides report missing files directly and started or unscheduled games return `historical-baseline`.

## Recorded benchmark

Run the walk-forward regular-season D/ST benchmark (Weeks 5–18, using strictly prior weeks in each season) from a repository checkout:

```bash
node --import tsx scripts/benchmark-defense.ts 2024
node --import tsx scripts/benchmark-defense.ts 2025
```

| Season | Team-week forecasts | Seb D/ST MAE | Team-average MAE | NFL-average MAE | 10th–90th range coverage |
| --- | ---: | ---: | ---: | ---: | ---: |
| 2024 ([JSON](benchmarks/defense-2024.json)) | 416 | **4.29** | 4.56 | 4.42 | 81.25% |
| 2025 ([JSON](benchmarks/defense-2025.json)) | 416 | **4.30** | 4.54 | 4.39 | 83.89% |

Fixed mixture weights beat both team-mean and league-mean baselines across MAE and RMSE in both seasons without tuning between years, though revised public CSVs cannot reconstruct real-time stat latencies or guarantee future live coverage.

> [!NOTE]
> Defensive injuries, coordinator changes, and game weather do not automatically alter numerical D/ST points; Seb surfaces verified injury and weather context alongside the projection without inventing ad-hoc point adjustments, and rare multi-turnover plays remain bounded by upstream nflfastR play-by-play attribution.
