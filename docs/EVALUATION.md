# Historical replay and metrics guide

Seb can replay an nflverse season against a transparent fantasy-points baseline.

The replay measures past accuracy without using future results as model input.

## Run a replay

Select one completed or partially completed season.

```bash
seb replay --season 2025
```

Limit the final week.

```bash
seb replay --season 2025 --through-week 10
```

Filter the positions with one comma-separated value.

```bash
seb replay --season 2025 --position QB,RB,WR,TE
```

Save the complete report.

```bash
seb replay --season 2025 --output exports/replay-2025.json
```

Print compact JSON for a script.

```bash
seb replay --season 2025 --json
```

The season must use `1999` through `2100`.

The final week must use `2` through `18`.

The position filter accepts `QB`, `RB`, `WR`, `TE`, and `K`.

## Interactive replay

Run a replay inside chat.

```text
/replay 2025 10
```

The first argument selects the season.

The second argument selects the final week.

Seb uses the previous season when you omit the season.

Interactive replay does not expose the position or output-file options.

## Current dataset

The runner reads nflverse regular-season weekly player statistics.

It measures `fantasyPointsPpr` for the selected positions.

It uses nflverse schedules to define weekly forecast boundaries.

The dataset records a stable source URL and a schema version.

## No-leakage rules

Each replay period has one exact knowledge cutoff.

The nflverse runner uses the earliest game date in the forecast week.

It sets that cutoff to `00:00:00Z` on that date.

The runner marks a game result as available at noon UTC on the next calendar day.

This time is a deterministic availability assumption for the current baseline.

Training requires an earlier season or week than the forecast period.

Training also requires `availableAt` at or before the knowledge cutoff.

A target must exist at or before the cutoff.

The runner builds targets from players who appeared during the prior week.

A target outcome must become available after the cutoff.

Seb throws `FutureLeakageError` when an input breaks these rules.

The audit records excluded late observations, future periods, and missing outcomes.

## Baseline calculation

The default baseline uses one player history after one prior observation.

It gives the complete history a weight of `0.7`.

It gives the latest three observations a weight of `0.3`.

It falls back to a position prior when a player has no history.

It then falls back to the global prior or zero.

The prediction interval uses an 80 percent level and the population standard deviation.

The report records each projection method and history count.

## Baseline metrics

The text summary reports these metrics.

- Mean absolute error.
- Root mean squared error.
- Prediction interval coverage.
- Pairwise rank accuracy.
- Spearman rank correlation.

The complete JSON report also contains these values.

- Mean error, mean actual value, and mean predicted value.
- Interval width and the rates above or below the interval.
- Mean absolute rank error.
- Sample counts for every metric group.
- A period audit for each forecast week.

The common metric library also supports Brier score and calibration bins.

It supports expected calibration error for probability forecasts.

It supports total, mean, and maximum regret for grouped decisions.

The current nflverse baseline supplies no probability forecasts or decision groups.

Those metric groups therefore have zero samples in this runner.

## Interpret the results

A lower MAE and RMSE indicate smaller point errors.

RMSE gives larger misses more weight than MAE.

Interval coverage should stay near the configured interval level.

High coverage with a wide interval gives weak decision value.

Pairwise accuracy measures the correctly ordered player pairs within each week.

Spearman correlation measures the complete weekly ranking relationship.

Compare models on the same dataset, periods, positions, and cutoffs.

Do not compare two reports with different target rules as one direct model test.

## Reproducible reports

The report uses schema version `1`.

The serializer sorts object keys and rejects nonfinite numbers.

The output file uses a private `0600` temporary file before the final rename.

Store the source snapshots with important reports.

Record the Seb version and command beside each report.

## Current limits

The baseline does not read a Sleeper league scoring system.

It measures nflverse PPR points only.

The availability time uses a deterministic next-day assumption.

It does not model injuries, depth charts, weather, or news.

It does not use player correlations or roster constraints.

Use this report as a reference baseline, not as a production projection model.

## Compare the production forecast models

The separate `seb evaluate --season YEAR` command tests the statistical forecast used by player projections.
It compares the previous formula, fixed ensemble, and weekly adaptive ensemble using corrected league-style PPR scoring.
It reports point error, interval quality, rank quality, and synthetic decision diagnostics.
Its target pool differs from `seb replay`, so the headline values cannot serve as a direct comparison.
Read the [analysis guide](ANALYSIS.md#verify-forecast-quality) for methods, measured results, and limitations.
