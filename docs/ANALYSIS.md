# Analysis and weekly learning

Seb estimates fantasy production from recorded NFL results and the selected league scoring rules.
The forecast exposes its expected points, uncertainty, input weeks, parameter choices, and evidence limits.
The language model explains these calculations. It does not invent the numerical forecast or edit learned parameters.

## Choose an analysis

| Request | Tool | Numerical method |
| --- | --- | --- |
| Project one player | `projectPlayer` | Season mean, exponential recency, and a small position prior |
| Compare two through six starters | `compareStartSit` | Expected points, legal slot checks, and approximate scoring probabilities |
| Find waiver targets | `rankWaiverTargets` | League availability, production, roster need, demand, and budget constraints |
| Compare a trade | `analyzeTradeImpact` | Best legal offensive lineup before and after the trade |
| Project several starters | `projectPlayers` | Up to 40 names, league scoring, explicit missing projections |
| Compare fantasy rosters | `predictMatchup` | Completed roster scores and a stated probability heuristic |
| Estimate playoff qualification | `simulatePlayoffOdds` | Repeated simulations against the actual remaining fantasy schedule |
| Review season learning | `inspectLearning` | Saved validation results and public player or team summaries |
| Update season learning | `learnCompletedWeek` | Chronological training, separate validation, and bounded parameter selection |

These tools never submit a lineup, waiver claim, or trade.
Only the learning update writes local football learning revisions. Source reads can also write caches and snapshots.
An explicit CLI or skill request updates the local football files.

## Forecast calculation

For each eligible game, Seb calculates fantasy points from the league scoring settings.
Seb combines the complete game average with an exponential average.
The exponential average gives half as much weight to an observation four appearances earlier.
Seb then adds a small position prior when at least 20 peer observations exist.
The prior excludes the projected player's own observations.

```text
recent_weight = 2 ^ (-appearances_ago / halfLife)
base = (1 - recentWeight) * mean + recentWeight * weighted_mean
expected_points = (games * base + priorGames * position_mean) / (games + priorGames)
```

Without a position prior, the last calculation returns `base`.
The default parameters are `recentWeight=0.25`, `halfLife=4`, and `priorGames=0.5`.
A small prior reduces extreme estimates from small samples without dominating established players.

Opponent, weather, and availability adjustments follow the statistical base forecast.
These existing adjustments remain bounded heuristics. The historical benchmark does not validate their accuracy.
Seb exposes each adjustment and its reason.

The result uses `expectedPoints` for the predicted mean.
The legacy `median` field contains the same value for compatibility. It does not estimate a statistical median.
The `model` field states the model version, parameters, learned season, learned week, and manual override state.

### Scoring and input safeguards

Seb supports ordinary passing, rushing, and receiving scoring.
It also supports volume scoring, reception premiums, fumbles, two-point conversions, special-teams touchdowns, and fumble-recovery touchdowns.
Known kicking and team-defense settings do not invalidate offensive projections.
Unknown active settings remain explicit and block final player recommendations.

Kicker projections calculate made and missed field goals, made and missed PATs, distance ranges, total field-goal yards, and yards over 30.
The distance ranges include both the older 50-plus rule and the separate 50–59 and 60-plus rules.
Blocked kicks count as misses. A distance rule requires a complete list of kick distances.
Kicker projections use default parameters or an explicit manual override. They do not reuse parameters learned from offensive players.
Seb does not claim validated kicker forecast accuracy.

A nonnumeric or nonfinite scoring weight causes an error. A missing required scoring component also causes an error. Seb never substitutes zero for that missing component.
The source cache uses a new player-statistics version to avoid reusing rows without the added fields.

Sleeper yardage bonuses use separate ranges.
For example, 400 passing yards awards the configured 400-yard bonus and removes the 300-yard bonus.
The same rule applies to rushing and receiving tiers. See [Sleeper's scoring rules](https://support.sleeper.com/en/articles/3998131-what-scoring-options-are-available).

Seb rejects duplicate player-week records and ambiguous historical identities.
Seb maps nflverse's `LA` source code to `LAR` before matching schedules, players, and opponents.
It excludes postseason rows from regular-season projections.
It limits training to completed weeks before the target week.
An explicit historical cutoff also limits the available learning revision.

Week 1 uses the previous season.
Later weeks also fall back when the current season has no matching results.
An unpublished current-season statistics file also triggers this fallback when the user did not select an explicit analysis window.
Other source failures remain visible. Seb does not silently replace a requested season.
Fewer than three observed games prevent a final starter recommendation.
An explicit prior-season analysis remains available when the current sample is too small.

A bye week, a started game, an unavailable player, or an invalid starter slot prevents a starter selection.
A missing kickoff time or unverified current team also prevents a starter selection.
Recorded weather from a completed target game cannot adjust its historical projection.
Current injuries and later team assignments cannot adjust a past week or season.
Comparisons across positions require an explicit slot, such as `FLEX` or `SUPER_FLEX`.
Current identity, league scoring, player status, source freshness, and news checks still apply.
News must cover every relevant player. A shared last name cannot satisfy both players' checks.

## Forecast uncertainty

With at least 20 applicable past errors, Seb uses the 80% absolute-error rank with a finite-sample correction.
The interval equals the forecast center plus or minus that error magnitude.
Local learning pools the last three validation weeks by position.
Without enough errors, Seb uses a wider sample-variance fallback and labels it `uncalibrated-small-sample`.
The range permits negative fantasy scores.

This method borrows the residual-rank calculation from conformal prediction.
It does not claim exact conformal coverage under season drift, player dependence, or parameter selection.
The confidence score measures evidence completeness. It does not measure the probability of a correct prediction.

Start-sit probabilities approximate independent normal scoring errors.
The output flags the top two players as a close choice below a 60% estimated advantage probability.
Shared-game correlation, uneven scoring distributions, and availability uncertainty can change that estimate.
The estimate does not represent a validated personal win rate.

## Trades, waivers, and playoffs

### Trade lineup value

Seb assigns each player to at most one eligible starter slot.
The optimizer searches all reachable slot combinations and maximizes the expected offensive starter total.
It supports up to 12 offensive starter slots and 60 candidate players.

A trade can increase summed player value while reducing starter value.
For example, two 12-point bench options do not replace a 20-point starter in a one-slot lineup.
Seb reports both totals and bases its value verdict on the lineup change.
Unchanged kicker and defense slots cancel from this offensive comparison.

Missing player identities, missing production, or unsupported slots prevent a lineup verdict.
Draft picks, contracts, market prices, future roster moves, and playoff-specific player schedules remain outside this estimate.
Current news remains necessary before an accept or decline recommendation.

### Waiver ranking

The waiver assistant keeps its explicit production, need, demand, and risk formula.
It now exposes the common forecast's `expectedPoints` alongside historical production.
Its rank and FAAB ranges remain heuristics, not trained price predictions.
Sleeper popularity covers the platform, not the selected league.

An explicit priority-waiver setting overrides a leftover FAAB budget.
Seb withholds a bid range when the remaining budget is below the minimum bid.
It removes duplicate trending players and rejects duplicate production weeks.
Unavailable production remains unavailable.

### Historical rosters and playoff odds

Historical league analysis reconstructs wins, ties, and points from the requested weekly scores.
It does not use current roster totals to describe an earlier cutoff.
Commissioner score overrides take precedence.
Median-match leagues add the extra result without halving the team's weekly scoring average.

Playoff simulation requires complete historical scores, valid opponent pairs, and at least two scores per roster.
It also requires one known future matchup per roster in every remaining fantasy regular-season week.
Missing schedules and division-based seeding stop the simulation.
Seb never invents future opponents.

The simulation blends season and recent roster averages at 70% and 30%.
It uses independent normal weekly scores with a minimum standard deviation of eight points.
It ranks simulated records by wins, then points scored, then higher points against, then a random draw for exact ties.
This order follows [Sleeper standings tiebreakers](https://support.sleeper.com/en/articles/4238872-can-i-set-tiebreakers).
Custom commissioner seeding remains outside the model.
It includes median matches when the league enables them.

The default uses 10,000 simulations and a fixed seed.
The maximum uses 50,000 simulations and 32 rosters.
The loop yields every 250 simulations so cancellation can stop it.
The reported 95% interval measures simulation sampling error only. It excludes uncertainty in the scoring model.

## Update local learning

Run an update after every game in the requested week has results.
The update also requires 24 hours after each game's kickoff and statistics for every completed game.
A missing week, unfinished game, or inconsistent game identity stops the update.

Use the selected league's scoring profile when the league uses custom rules.
Without a league, the CLI uses the explicit PPR profile shown in the JSON report.

```bash
seb learn update --season 2026 --through-week 1 --league LEAGUE_ID
seb learn status --season 2026 --league LEAGUE_ID
seb learn status --season 2026 --league LEAGUE_ID --json
```

Replace `LEAGUE_ID` with the numeric Sleeper league ID.
Omit `--through-week` to select the latest contiguous completed week.
Use the previous season to prepare a Week 1 baseline.

```bash
seb learn update --season 2025
```

In the interactive terminal, run the built-in workflow.

```text
/skill weekly-learning Review the last completed week and update learning for my selected league.
```

The skill can also inspect a player or team without writing an update.
It does not create a background schedule. Run the workflow after each week, or invoke the explicit CLI command from your own scheduler.

### Parameter promotion

1. Build chronological samples from games with at least three earlier player appearances.
2. Select a candidate using the earlier training weeks.
3. Reserve the final three sample weeks for validation.
4. Require at least 100 training samples and 100 validation samples.
5. Require at least three separate training weeks and three validation weeks.
6. Promote only when validation MAE improves by more than 1% and RMSE does not increase.
7. Retain the fixed default parameters when either gate fails.

MAE measures average absolute point error.
RMSE gives larger errors more weight.
The candidate grid uses recency weights of `0`, `0.25`, and `0.5`.
It uses prior strengths of `0`, `0.5`, and `2` with a four-appearance half-life.
Each update compares against the versioned default. It does not reuse a previously selected candidate as an unbiased validation baseline.

These gates reduce untested changes. They do not prove that a candidate improves future accuracy.
The historical 2024 and 2025 tests retained the defaults at every update.
Synthetic trend tests verify that the learner can promote a candidate when both gates pass.

### Storage and privacy

```text
.cache/learning/
  overrides.json
  .update-lock/
  2026-<scoring-profile-hash>/
    01-<content-sha256>.json
    02-<content-sha256>.json
```

Each revision contains a schema version, model version, season, completed week, creation time, and data checksum.
It also contains the scoring rules, selected parameters, candidate parameters, validation weeks, errors, player summaries, team summaries, and source URLs.
Player summaries use nflverse player IDs. Team summaries use NFL team codes.
Player summaries track average points, recent points, and passing attempts plus carries plus targets.
Team summaries track sample count, MAE, RMSE, and signed forecast bias.
They do not create unverified injury, depth-chart, or coaching claims.

Later projections read only a compatible scoring profile from an earlier eligible week.
Trade and waiver estimates use the compatible parameters for their selected analysis cutoff.
The agent can inspect player and team summaries as dated historical context.
Team error summaries do not directly modify matchup coefficients.

Writes use a temporary file followed by an atomic rename.
A local lock prevents simultaneous updates.
Identical source results produce no new revision.
The store retains four corrections per completed week and preserves earlier weeks for replay.
The maximum revision size is 8 MiB. The maximum override size is 16 KiB.
Checksums detect altered revisions. Invalid schemas or checksums stop the read.

The learning files contain football statistics and model diagnostics.
They contain no prompts, answers, API keys, or model-provider transcripts.
Usage analytics remain in the existing metadata-only telemetry store.
Clearing the source cache or usage history does not delete learning revisions.

If a crashed update leaves `.update-lock`, confirm that no update runs before removing that directory.
Archive or remove an old season directory when you no longer need its revisions.

### Overrides and rollback

Create `.cache/learning/overrides.json` to disable all learned and manual parameters.

```json
{
  "schemaVersion": 1,
  "enabled": false
}
```

Use an explicit bounded configuration for a controlled experiment or rollback.

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "parameters": {
    "recentWeight": 0.25,
    "halfLife": 4,
    "priorGames": 0.5
  }
}
```

| Parameter | Type | Meaning | Allowed range |
| --- | --- | --- | --- |
| `recentWeight` | Number | Fraction assigned to the exponential average | 0 through 0.75 |
| `halfLife` | Number | Player appearances before an observation receives half weight | 1 through 12 |
| `priorGames` | Number | Equivalent observations assigned to the position prior | 0 through 12 |

A manual override takes precedence over learned parameters.
It does not reuse residual calibration from another parameter configuration.
To restore an earlier configuration, copy its `parameters` object into the override file.
Do not edit a revision file. The checksum detects that edit.

`seb doctor --offline` validates the override.
`seb learn status` reports the effective parameters and override state.
The learner never edits its source code, provider settings, prompts, or arbitrary files.

## Verify forecast quality

```bash
seb evaluate --season 2024 --through-week 18 --output evaluation-2024.json
seb evaluate --season 2025 --through-week 18 --output evaluation-2025.json
```

The evaluation compares the previous forecast formula, the new fixed ensemble, and the weekly adaptive ensemble.
Each week uses only earlier statistical observations.
The evaluation uses corrected scoring for every model.
The old model retains its original narrow range formula.
New ranges use each model's errors from earlier weeks.

The report includes MAE, RMSE, bias, interval coverage, interval score, rank correlation, and pairwise ranking accuracy.
It also includes synthetic neighbor-choice regret and probability calibration diagnostics.
Each model pairs adjacent projected ranks. Those model-specific pairs are not a shared set of user decisions.
Position reports expose differences between quarterbacks, running backs, receivers, and tight ends.

The tests below used revised nflverse statistics, regular-season Weeks 4 through 18, and the report's PPR scoring rules.
The target pool requires three earlier appearances and an observed outcome.
Missing outcomes remain missing. The report does not count them as zero.

| Season | Player-week outcomes | Previous MAE | New MAE | Previous RMSE | New RMSE | Previous range coverage | New 80% range coverage |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2024 | 4,227 | 4.655 | 4.640 | 6.483 | 6.411 | 52.4% | 80.6% |
| 2025 | 4,325 | 4.598 | 4.567 | 6.513 | 6.405 | 54.2% | 80.2% |

The [saved benchmark summary](benchmarks/projections-2024-2025.json) includes dataset checksums and results by position.

The point-error improvement is modest. The new ranges improve observed coverage partly because they are wider.
The 2024 season informed the default prior strength. The 2025 season supplied the separate later-season check.
Mean absolute rank error does not improve in both seasons. Do not claim improvement on every metric.
These results do not prove superior live lineup decisions or league wins.

The replay cannot reconstruct original source publication times, injury reports, inactive-player decisions, or roster constraints.
It measures the statistical base forecast conditional on observed player outcomes.
It does not score the full language-model answer or the production context adjustments.
The calibration pools positions. It supplies no individual-player coverage guarantee.

The older `seb replay` command remains available for the existing versioned evaluation dataset.
It has a different target-pool definition. Do not compare its headline metrics directly with `seb evaluate`.
See the [evaluation guide](EVALUATION.md).

## Performance and verification

A local Node.js 22 run measured the following computation times after imports and downloads.
The [saved performance report](benchmarks/analysis-performance.json) records the environment and exact limits.

| Work | Input size | Observed time |
| --- | --- | ---: |
| One weekly learning revision | 19,400 source rows with regular-season filtering | 76 ms |
| Exact lineup assignment | 60 players and 12 starter slots | 62 ms |
| Maximum playoff simulation | 32 rosters, 15 weeks, and 50,000 trials | 2.80 seconds |

These observations do not guarantee the same speed on another machine.
The learning service also passed a live 2025 update and checksum readback for 610 players and 32 teams.
A repeated update retained the same revision.

Regression tests cover scoring tiers, missing scoring fields, future inputs, duplicate identities, legal slots, and started games.
They also cover historical standings, median matches, waiver budgets, comparison news, learning cutoffs, invalid overrides, retention, and cancellation.
Existing usage-analytics tests continue to check missing metrics, overflow, aggregation, and metadata-only storage.
Doctor checks local overrides without a language-model call.

## Research basis and next experiments

| Primary source | Application in Seb | Limit |
| --- | --- | --- |
| [Forecasting: time-series cross-validation](https://otexts.com/fpp3/tscv.html) | Rolling weekly cutoffs and separate validation | Revised historical data cannot recreate every original publication delay |
| [Forecasting: forecast combinations](https://otexts.com/fpp3/combinations.html) | A transparent mean and recency ensemble | Complexity alone does not establish better forecasts |
| [Forecasting: distributional accuracy](https://otexts.com/fpp3/distaccuracy.html) | Coverage and an interval score that penalizes misses and excessive width | Aggregate coverage does not establish player-level reliability |
| [Report the Floor, June 2026 preprint](https://arxiv.org/abs/2606.09473) | Motivation for explicit baseline and interval comparisons | The paper does not validate NFL player forecasts |
| [Adaptive conformal inference under distribution shift](https://arxiv.org/abs/2106.00170) | Motivation for checking uncertainty as the season changes | Seb uses empirical residual ranks, not the paper's full adaptive conformal algorithm |
| [nflverse expected fantasy opportunity](https://nflreadr.nflverse.com/reference/load_ff_opportunity.html) | A candidate source for future opportunity-based forecasts | The current model does not ingest or claim these expected-point features |
| [Playoff-aware fantasy trade optimization preprint](https://arxiv.org/abs/2511.17535) | Motivation for separating roster value from summed player value | Seb uses exact weekly slot assignment, not the paper's genetic algorithm or dynasty claims |
| [Sleeper scoring reference](https://support.sleeper.com/en/articles/3998131-what-scoring-options-are-available) | Scoring categories and exclusive yardage bonus ranges | Unknown active rules still require explicit support |

A later model can add play-by-play expected opportunity, role changes, and correlated lineup simulations.
Those additions need aligned historical inputs and the same chronological tests before automatic promotion.
Large machine-learning models and causal player claims remain outside this implementation.

## Missing projections

The player model supports QB, RB, WR, TE, and K scoring. It does not project team defenses or individual defenders.

Seb reports these positions as unavailable. It does not use zero as a replacement.

A batch keeps successful player projections when another player lacks data. Cancellation stops the batch before it starts more players.

Each projection includes `scoreScope`: `weekly-estimate`, `partial-scoring`, or `historical-baseline`.
Unknown active scoring rules produce partial estimates. Missing schedules or current team identity produce historical baselines.
The batch reports `complete: true` only when every result has a complete weekly estimate.
Weekly data does not separate player special-teams forced fumbles and recoveries. The active `st_ff` and `st_fum_rec` rules remain explicit omissions.

A matchup subtotal excludes missing projections. It does not represent a complete final score.

The historical roster-score model needs at least two completed scores per roster. Week 1 analysis uses supported player projections from the prior season.
