# Projection and conversation review

> [!NOTE]
> **Historical Engineering Review (`2026-09-10`, v1.0.2)** — This document preserves the point-in-time post-mortem and verification record from the `v1.0.2` cycle. For live `v1.1.2` behavior—including the reduction of `MAX_AGENT_STEPS` from `32` to **`16`** in `v1.1.0`, `toModelOutput` compaction, full-roster lineup optimization, intra-game correlations, and automatic Decision Gate recovery—see the [Analysis and weekly learning guide](ANALYSIS.md), [Defense and special teams guide](DEFENSE_AND_SPECIAL_TEAMS.md), and [Architecture guide](ARCHITECTURE.md).

## Why the reported turns failed

Two interactive research turns terminated at the earlier 12-step model limit with `finishReason: "tool-calls"` rather than a completed user-facing answer, and the terminal surfaced that incomplete stop as a generic Gemini provider failure. Recorded usage telemetry showed 47 individual `projectPlayer` calls (46 returned, 1 failed) plus two `predictMatchup` calls that failed legitimately in Week 1 because historical roster-score matchup prediction requires completed weekly team scores. Those telemetry records confirmed that the underlying projection calculations succeeded while step exhaustion and context pruning broke conversation completion.

At the same time, aggressive message pruning dropped early tool results after six history messages, forcing the model to repeat prior player lookups and discarding provider thought signatures mid-turn. On the final allowed step, passing an empty tool array also caused the Google Gemini adapter to omit `functionCallingConfig`, leaving tool calling implicitly active instead of sending an explicit `NONE` directive.

## Corrections recorded in v1.0.2

| Defect | Resulting behavior (at review time) | Regression coverage |
| --- | --- | --- |
| Research limit ended without an answer | Raised the step ceiling (32 steps in `v1.0.2`, later streamlined to **16 steps** in `v1.1.0` alongside batching and `toModelOutput` compaction) and reserved the final step for tool-free synthesis while keeping declarations so Gemini receives `NONE`. | `gemini-model.test.ts`, `agent-harness.test.ts` |
| Early tool results disappeared mid-turn | Preserved the entire active turn and provider continuation signatures, pruning only prior-turn history. | `ai-sdk-features.test.ts`, `gemini-model.test.ts` |
| Repeated single-player projections consumed steps | Added `projectPlayers` for up to 40 names per call (4 concurrent projections), preserving valid results when individual players lack data. | `projection-batch.test.ts` |
| Model summed live roster subtotals inaccurately | Added `projectLeagueMatchup` to sum verified weekly starters, completed scores, and remaining projections deterministically once per slot while keeping missing/partial scores explicit. | `projection-matchup.test.ts` |
| Kicking counts and distances were dropped during CSV parsing | Preserved FG/PAT counts and attempt distance arrays in `NflverseClient` and scored league kicking settings from component stats. | `nflverse-client.test.ts`, `projection-review.test.ts` |
| Split distance tiers blocked offensive projections | Recognized `50–59` and `60+` FG rules alongside the legacy `50+` rule. | `projection-review.test.ts` |
| Punctuation and name suffixes hid historical player logs | Unified player-name normalization across source searches and `PlayerIdentityRegistry`. | `nflverse-client.test.ts`, `sleeper-client.test.ts` |
| Rams `'LA'` source codes hid scheduled games | Mapped nflverse `'LA'` deterministically to `'LAR'` across schedules, player stats, opponents, and source links, bumping cache schema versions. | `nflverse-client.test.ts`, `identity.test.ts` |
| Unpublished new-season CSVs blocked automatic fallback | Fell back to the prior regular season on automatic windows after HTTP `404` while keeping explicit season errors visible. | `projection-review.test.ts` |
| Current injuries and transfers altered historical backtests | Excluded live Sleeper status and current-day team overrides when projecting completed historical weeks or seasons. | `projection-review.test.ts` |
| Team defense codes matched unrelated player names | Resolved canonical NFL team codes before player search so D/ST requests route cleanly instead of matching player substrings. | `projection-review.test.ts` |
| Partial scoring appeared indistinguishable from full projections | Added `scoreScope` (`weekly-estimate`, `partial-scoring`, `historical-baseline`) and required `weekly-estimate` across every batch item for `complete: true`. | `projection-batch.test.ts` |
| Duplicate opponent-week rows inflated positional defense adjustments | Rejected duplicate `(player, week)` records before computing opponent positional allowances. | `projection-review.test.ts` |
| Malformed comparison intervals produced `NaN` win probabilities | Required finite expected points and uncertainty bounds containing the point estimate. | `projection-review.test.ts` |
| Corrupted local learning files surfaced as provider failures | Reported safe, file-content-free local forecast-data errors directly. | `projection-review.test.ts` |
| Failed turns dropped the user's question from session context | Retained the user question while discarding unfinished assistant/approval state so natural-language retries resolve cleanly. | `interactive-tui.test.ts`, `recommendation-eligibility.test.ts` |
| Terminal editor locked input during streaming | Allowed live draft typing and `Enter` queuing during active streams, preserving drafts on cancellation or error. | `interactive-renderer.test.ts`, `interactive-tui.test.ts` |
| Embedded evidence headings leaked past collapsed transcript mode & touched footer | Collapsed embedded evidence blocks to a single summary line (retaining full text for copy/export) and added a spacer row above the status bar. | `interactive-renderer.test.ts` |

## Scoring verification

Against the live 2025 nflverse regular-season dataset ([`stats_player_week_2025.csv.gz`](https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2025.csv.gz)), all **543 kicker game rows** and **6,037 offensive player-game rows** produced finite component-derived scores across tested [Sleeper scoring profiles](https://support.sleeper.com/en/articles/3998131-what-scoring-options-are-available), covering distance boundaries, blocked kicks, yardage tiers, zero-attempt games, and [special-teams fumble rules](https://support.sleeper.com/en/articles/4056849-why-did-my-player-lose-points-for-a-special-teams-fumble). Because nflverse's precomputed `fantasy_points_ppr` column cannot represent arbitrary custom league weights, Seb always computes weekly fantasy totals from raw component columns.

## Model scope evolution since this review

The initial review pass left team D/ST and play-level individual special-teams events (`st_ff`, `st_fum_rec`, `st_tkl_solo`) unsupported; `v1.0.2` subsequently shipped both via play-by-play (`play_by_play_YEAR.csv.gz`) and official weekly team totals (`stats_team_week_YEAR.csv.gz`), documented in [Defense and special teams](DEFENSE_AND_SPECIAL_TEAMS.md). Individual defensive player (`IDP`) projections remain unsupported, kicker forecasts continue to use fixed default or manual-override parameters rather than offensive learned weights, and opponent/weather/availability adjustments remain disclosed bounded heuristics.

## Point-in-time verification snapshot (`2026-09-10`)

- **`npm run check` & `npm run test:coverage`**: 78 test files and 1,085 tests passed with all coverage thresholds satisfied.
- **`npm audit --omit=dev`**: Zero production dependency vulnerabilities.
- **`npm run doctor`**: Live Sleeper, nflverse, NWS, Gemini streaming local-tool continuation, and Google Search grounding checks passed.
- **Interactive & live matchup smoke checks**: Verified draft queuing, follow-up submission, collapsed evidence rendering, clean terminal restoration, and exact four-roster live matchup subtotals across completed and remaining offensive/defense starters.
