# Projection and conversation review

Review date: September 10, 2026.

## Why the reported turns failed

The two reported interactive turns ended at the 12-step research limit with `tool-calls` as their finish reason.
They did not end with a completed answer.
The terminal described that condition as a Gemini failure, which hid the actual cause.

The recorded tool metadata contained 47 individual player projection calls.
Of those calls, 46 returned results and one failed.
Both historical matchup calls failed because that model needs completed roster scores.
Week 1 has no such scores.
These observations distinguish successful calculations from a failed conversation.

The agent also removed early research after six messages.
That removal encouraged repeated requests and discarded provider continuation state.
On the final step, the empty tool list caused the Google adapter to omit the function-calling configuration.
The request therefore did not explicitly disable further function calls.

## Corrections

| Defect | Resulting behavior | Regression coverage |
| --- | --- | --- |
| Research limit ended without an answer | Allow 32 model steps and reserve the final step for an answer. Keep function declarations so Gemini receives `NONE`. | `gemini-model.test.ts`, `agent-harness.test.ts` |
| Early tool results disappeared | Preserve the active turn and its provider signatures. Prune older conversation history only. | `ai-sdk-features.test.ts`, `gemini-model.test.ts` |
| Repeated single-player projections consumed steps | Project up to 40 players in a batch with four concurrent requests. Preserve successful results when one player lacks data. | `projection-batch.test.ts` |
| The model added a live roster subtotal incorrectly | Calculate both rosters from verified weekly starters. Add completed and projected points exactly once. Keep missing and partial scores explicit. | `projection-matchup.test.ts` |
| Kicking data disappeared during parsing | Preserve kicking counts and distance lists. Calculate league points from those fields. | `nflverse-client.test.ts`, `projection-review.test.ts` |
| New distance rules blocked offensive projections | Recognize 50–59 and 60-plus kicking rules alongside the older 50-plus rule. | `projection-review.test.ts` |
| Name punctuation and suffixes hid player history | Use the same player-name normalization for source searches and identity resolution. | `nflverse-client.test.ts`, `sleeper-client.test.ts` |
| Rams source codes hid scheduled games | Map nflverse `LA` to `LAR` in schedules, player teams, opponents, and source identities. Refresh the affected cache versions. | `nflverse-client.test.ts`, `identity.test.ts` |
| A missing new-season file prevented automatic fallback | Use the prior season for an automatic window after HTTP 404. Preserve explicit windows and other errors. | `projection-review.test.ts` |
| Current injuries and later teams changed historical estimates | Exclude current profiles from forecasts for past weeks and seasons. | `projection-review.test.ts` |
| Defense codes matched unrelated player names | Recognize team identities before player research. Explain the unsupported defense projection. | `projection-review.test.ts` |
| Partial scoring looked like a complete batch | Expose `scoreScope`. A complete batch requires a weekly estimate for every player. | `projection-batch.test.ts` |
| Duplicate opponent weeks inflated defensive scoring | Reject duplicate player-week rows before the opponent adjustment. | `projection-review.test.ts` |
| Invalid comparison values produced invalid probabilities | Require finite points and a range that contains the estimate. | `projection-review.test.ts` |
| Invalid saved learning produced a generic provider error | Explain the local forecast-data failure without exposing file contents. | `projection-review.test.ts` |
| Failed questions disappeared from conversation context | Keep the question and discard unfinished assistant and approval continuations. Resolve repeated natural-language retries. | `interactive-tui.test.ts`, `recommendation-eligibility.test.ts` |
| The editor stopped accepting text during research | Accept drafts during a response. Enter queues the draft. Editing removes it from the queue. Failure or cancellation preserves it for review. | `interactive-renderer.test.ts`, `interactive-tui.test.ts` |
| Detailed evidence escaped the collapsed display | Recognize embedded evidence headings and show one evidence line per answer. Preserve full text for sources, copy, and export. | `interactive-renderer.test.ts` |
| The input touched the status line | Add one terminal row below the editor and adjust small-window layout limits. | `interactive-renderer.test.ts` |

## Scoring checks

The live 2025 regular-season dataset contains 543 kicker game rows.
All 543 rows produced finite scores under each tested league's kicking rules.
The tests check made-distance boundaries, missed-distance boundaries, blocked attempts, yardage scoring, zero attempts, and incomplete source fields.

The review also scored 6,037 offensive game rows.
The source's precomputed PPR field does not encode an arbitrary Sleeper league's rules.
Special-teams touchdowns and special-teams fumble penalties can differ between those definitions.
Seb therefore calculates points from the league settings and component statistics.
It does not substitute the source's precomputed fantasy score.

Sources:

- [nflverse 2025 weekly player data](https://github.com/nflverse/nflverse-data/releases/download/stats_player/stats_player_week_2025.csv.gz)
- [Sleeper scoring options](https://support.sleeper.com/en/articles/3998131-what-scoring-options-are-available)
- [Sleeper special-teams fumble rules](https://support.sleeper.com/en/articles/4056849-why-did-my-player-lose-points-for-a-special-teams-fumble)

## Remaining model limits

The initial review left defense and individual special-teams projections unsupported.
Version 1.0.2 adds both through play-level data and official weekly totals.
See [Defense and special teams](DEFENSE_AND_SPECIAL_TEAMS.md) for the implementation and verification.
Individual defender projections remain unsupported.

Kicker projections use historical results and default forecast parameters, or an explicit manual override.
They do not reuse learned offensive parameters.
The existing offensive forecast benchmark does not validate kicker accuracy.
Opponent, availability, and weather adjustments remain disclosed heuristics.
Current news supplements the estimate and does not change the numerical model automatically.

## Verification

- `npm run check`: 78 files and 1,085 tests passed.
- `npm run test:coverage`: 1,085 tests passed. All coverage thresholds passed.
- `npm audit --omit=dev`: zero vulnerabilities.
- `npm run doctor`: all required checks passed, including live source access, Gemini local-tool continuation, and grounded search.
- A real terminal smoke test verified typing, queuing, follow-up submission, transcript retention, collapsed evidence, and normal exit.
- Direct live matchup calculations verified all four roster subtotals, including a completed offensive player and a completed defense.

The source checks establish calculation and integration behavior.
They do not establish the accuracy of a future fantasy score.
