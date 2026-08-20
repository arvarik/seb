# Skill guide

A skill gives Seb focused instructions for one fantasy workflow.

Select a skill with `/skill NAME` inside interactive chat.

The default skill is `general`.

## Core skills

| Skill | Purpose | Main evidence |
| --- | --- | --- |
| `general` | Routes a broad fantasy question. | The smallest useful tool set. |
| `start-sit` | Compares lineup choices. | Opportunity, production, opponent, venue, and weather. |
| `waiver-scout` | Ranks available targets. | Sleeper demand, nflverse usage, output, and schedule. |
| `matchup` | Compares two fantasy rosters. | Sleeper scores and selected NFL context. |
| `trade-review` | Compares both trade sides. | Production, usage, volatility, roster fit, and risk. |
| `league-audit` | Ranks every roster. | Sleeper records, scores, consistency, and recent form. |
| `projection-explainer` | Builds a transparent player range. | Baseline, matchup, weather, and uncertainty. |

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

It searches current public reporting through Gemini Google Search.

It includes publisher links and dates when Gemini returns those values.

It uses Sleeper for league facts and nflverse for historical statistics.

Seb has no licensed publisher feed or official injury-report feed.

## Skill selection guidance

Use `start-sit` for one lineup decision.

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

The NWS hourly forecast covers about seven days.

nflverse weekly player files can lag the latest game while a release updates.

Run `/sources` after an answer to inspect the source URLs.
