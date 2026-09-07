# Skill guide

A skill gives Seb focused instructions for one advanced NFL or fantasy workflow.

Most requests do not need a selected skill.

Ask naturally or use Explore, My Fantasy, and Analyze first.

Select a skill with `/skill NAME` inside interactive chat.

Run a skill immediately with `/skill NAME QUESTION`.

```text
/skill player-info Lamar Jackson
```

Seb selects `player-info` and sends `Lamar Jackson` as the question.

The default skill is `general`.

The `/skills` command groups skills by NFL information, fantasy decisions, and research.

## NFL information skills

These skills answer non-fantasy questions by default.

| Skill | Purpose | Main evidence |
| --- | --- | --- |
| `player-info` | Shows one NFL player profile and recorded statistics. | Sleeper profiles, nflverse game logs, and verified news. |
| `team-info` | Shows one NFL team, player set, schedule, and results. | Team identity, Sleeper player records, and nflverse data. |
| `nfl-stats` | Answers general NFL schedule and statistics questions. | Sleeper NFL state and nflverse records. |

The `player-info` skill separates a current profile from game statistics and news.

The `team-info` skill does not call Sleeper records an official NFL roster.

The `nfl-stats` skill states the season and week range for each statistic.

These skills add fantasy advice only when the user requests it.

## Fantasy skills

| Skill | Purpose | Main evidence |
| --- | --- | --- |
| `general` | Routes a broad fantasy question. | The smallest useful tool set. |
| `start-sit` | Compares lineup choices. | Opportunity, production, opponent, venue, and weather. |
| `waiver-scout` | Ranks available targets. | Sleeper demand, nflverse usage, output, and schedule. |
| `matchup` | Compares two fantasy rosters. | Sleeper scores and selected NFL context. |
| `trade-review` | Compares both trade sides. | Production, usage, volatility, roster fit, and risk. |
| `league-audit` | Ranks every roster. | Sleeper records, scores, consistency, and recent form. |
| `projection-explainer` | Builds a transparent player range. | Baseline, matchup, weather, and uncertainty. |

## Decision safeguards

Seb matches the executed tool evidence to the requested player and selected league.

The `start-sit` skill needs an eligible projection before it gives an action.

The projection needs at least three completed games and at least one supported active scoring rule.

Every active player scoring rule must have a supported nflverse calculation.

The player must also be available and cannot be a kicker.

Seb lists the missing requirement when the final gate blocks an action.

## Trade review skill

The `trade-review` skill needs both trade sides.

Seb resolves each player through Sleeper.

Seb compares prior production, opportunity, recent form, and volatility through nflverse.

Set a league and roster when roster fit affects the decision.

Seb reads an identified Sleeper transaction only when the request refers to that transaction.

Each player can appear only once on each trade side.

Every received player must belong to the same opposing roster.

Seb labels rest-of-season expectations as assumptions.

Seb does not invent a trade-chart value or a market value.

The trade calculation never creates a final accept or decline action by itself.

Current news must support that final action.

## Waiver scout skill

The `waiver-scout` skill starts with Sleeper trending adds.

It removes every player who appears on a roster in the selected league.

Recent production uses fixed reference points for each position.

Sleeper demand uses an absolute logarithmic scale from zero to 1,000 adds.

These scales do not depend on the other candidates in one request.

The final score combines production, roster need, Sleeper demand, and risk.

The result states that Sleeper demand covers the complete Sleeper platform.

## nflverse skills

| Skill | Purpose | Main evidence |
| --- | --- | --- |
| `schedule-scout` | Reviews future opponents and rest. | nflverse schedule and result rows. |
| `usage-trends` | Finds changing opportunity. | Targets, carries, market share, scoring, and recent averages. |
| `game-environment` | Reviews one complete NFL game. | Both teams, venue, line fields, and weather. |
| `defense-matchup` | Measures one defense against a position. | PPR points and targets allowed per game. |
| `playoff-planner` | Compares future playoff paths. | Schedule, prior results, and outdoor venues. |
| `boom-bust` | Compares floor and upside. | Average PPR output, opportunity, and weekly volatility. |

## Weather skill

The `weather-watch` skill finds wind, rain, cold, heat, and active alerts.

It can screen every outdoor game in one NFL week.

Seb loads the current season, week, and season type from Sleeper automatically.

Run `/week current` only to retry or override that automatic value.

The weather tools use `REG` or `POST` to select the correct nflverse schedule.

nflverse schedule releases do not include preseason game rows.

During preseason, Seb can show the selected team home-stadium forecast.

Seb states that this outlook is not matched to the game venue or kickoff.

Seb first checks the nflverse roof field.

Seb skips direct field effects when the roof is closed or the venue is a dome.

Seb then matches the kickoff with the closest NWS hourly forecast period.

The risk rules stay transparent.

- Wind at 15 mph creates a medium signal.
- Wind at 25 mph creates a high signal.
- Precipitation at 35 percent creates a medium signal.
- Precipitation at 75 percent creates a high signal.
- Severe or extreme alerts create a high signal.
- Very cold or hot conditions add a temperature signal.

These rules provide analysis context. They do not create an official projection.

## Source-safe briefing skill

The `news-briefing` skill prevents false current-news claims.

It searches the built-in first-class news sources with every model provider.

It can use Google Search for insufficient coverage when Google is active.

It includes validated publisher links and publication dates.

Seb validates every parsed discovery record and article metadata value before it stores the value.

The live source probe checks all 44 built-in sources.

It uses Sleeper for league facts and nflverse for historical statistics.

Seb has no licensed publisher feed or official injury-report feed.

## Skill selection guidance

Use `start-sit` for one lineup decision.

Use `player-info` for a non-fantasy player profile or game log.

Use `team-info` for a non-fantasy team profile, player set, schedule, or results.

Use `nfl-stats` for a general NFL schedule, result, or statistical question.

Use `usage-trends` when the decision depends on changing opportunity.

Use `defense-matchup` when the opponent is the main question.

Use `weather-watch` when the kickoff falls within the NWS forecast window.

Use `game-environment` when several game factors interact.

Use `projection-explainer` when the user wants a range and assumptions.

Use `boom-bust` when the user must choose between floor and upside.

Use `league-audit` before a broad roster improvement plan.

## Data limits

Skills do not create unavailable facts.

Seb has no licensed publisher feed, official projection feed, or official injury-report feed.

Current web reporting can contain incomplete or conflicting claims.

The `news-briefing` skill identifies that uncertainty.

The NWS supports United States points only.

Seb does not apply a home-stadium coordinate to a neutral-site game.

Seb does not claim a preseason kickoff forecast without a reliable schedule row.

The NWS hourly forecast covers about seven days.

nflverse weekly player files can lag the latest game while a release updates.

Run `/sources` after an answer to inspect the source URLs.

## Weekly learning

Use `/skill weekly-learning` to review completed-week errors and local player or team trends.
Add a request to update the selected league after all games finish and the reporting buffer passes.
The tool validates parameters before it saves a revision.
The skill does not start a background schedule or edit files from language-model guesses.
Read the [analysis guide](ANALYSIS.md#update-local-learning) for the complete workflow.
