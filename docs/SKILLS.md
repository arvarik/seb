# Skill Guide

[Documentation Hub](README.md) · [Interactive Guide](INTERACTIVE.md) · [Experience Model](EXPERIENCES.md) · [Analysis & Learning](ANALYSIS.md)

Skills give Seb focused domain instructions for specialized NFL research, fantasy decision-making, and forecast evaluation workflows without hiding any read-only data tool. Most questions need no explicit skill—ask naturally or use **Explore**, **My Fantasy**, and **Analyze** first, and reach for `/skills` or `/skill <NAME> [QUESTION]` when you want a structured specialist workflow:

```text
/skills
/skill player-info Lamar Jackson
/skill start-sit Optimize my starting lineup for this week
```

Seb includes **19 skills** across the three categories displayed by `/skills` (**NFL information**, **Fantasy**, and **Research**), with `general` active by default.

## 1. NFL information skills (3)

These three skills focus on objective NFL facts, schedules, game logs, and verified news without adding fantasy advice unless you ask for it:

| Skill | Title | Purpose and primary evidence |
| --- | --- | --- |
| `player-info` | Player information | Separates one player's live Sleeper profile from nflverse weekly/season game logs and verified news (`findPlayers`, `resolvePlayerIdentity`, `getPlayerWeeklyStats`, `searchFirstClassNews`). |
| `team-info` | Team information | Summarizes franchise identity, active Sleeper player records (explicitly distinguished from an official 53-man NFL roster), schedule, results, team efficiency, and news. |
| `nfl-stats` | NFL facts and stats | Answers league-wide schedule, result, player, and team statistical queries while stating the exact season and week window for every metric. |

## 2. Fantasy skills (10 — `general` default + 9 specialized)

These skills power lineup optimization, projections, waivers, trades, matchups, and multi-week playoff planning:

| Skill | Title | Purpose and primary evidence |
| --- | --- | --- |
| `general` *(default)* | Fantasy assistant | Routes broad fantasy football questions to the smallest accurate set of data and analysis tools. |
| `start-sit` | Start and sit | Compares 2–6 lineup candidates (`compareStartSit`) or optimizes your **full starting lineup and bench swaps** (`optimizeRosterLineup`) across offensive skill slots, kickers, flex/superflex, **and team D/ST projections**. |
| `waiver-scout` | Waiver scout | Combines platform-wide Sleeper add demand with nflverse opportunity, recent output, roster need, and FAAB ranges (`rankWaiverTargets`). |
| `matchup` | Fantasy matchup | Compares two opposing Sleeper rosters side by side with live projections, stack correlations, and win probabilities. |
| `trade-review` | Trade review | Evaluates both sides of a proposed or recorded trade across production, usage shares, weekly volatility, roster depth fit, and current news. |
| `league-audit` | League audit | Ranks every roster in a Sleeper league by scoring power, consistency, recent form, and positional strengths/weaknesses. |
| `projection-explainer` | Projection explainer | Breaks down a player or team D/ST range into baseline rate/volume, matchup, venue/weather adjustments, return scoring, and uncertainty. |
| `defense-matchup` | Defense by position | Measures fantasy points, targets, and efficiency allowed per game by a specific NFL defense against one offensive position. |
| `playoff-planner` | Playoff planner | Evaluates player and team schedules, opponent strength, and outdoor weather exposure across future fantasy playoff weeks. |
| `boom-bust` | Boom and bust | Contrasts floor safety against ceiling upside using opportunity share, target depth/TD variance, same-game stacks, and weekly scoring volatility. |

## 3. Research skills (6)

These skills support deeper statistical, environmental, newsroom, and post-week model calibration workflows:

| Skill | Title | Purpose and primary evidence |
| --- | --- | --- |
| `weekly-learning` | Weekly learning | Reviews completed-week forecast errors, player/team residuals, and updates validated local learning parameters (`getNflState`, `inspectLearning`, `learnCompletedWeek`). |
| `weather-watch` | Weather watch | Screens single games or an entire NFL week for wind, precipitation, extreme temperatures, and NWS alerts (`getGameWeather`, `getWeekWeather`, `getStadiumForecast`). |
| `schedule-scout` | Schedule scout | Audits upcoming opponents, home/road splits, roof types, rest edges, and multi-week schedule difficulty. |
| `usage-trends` | Usage trends | Detects rising or falling targets, carries, route/snap market shares, red-zone usage, and efficiency shifts. |
| `game-environment` | Game environment | Synthesizes both teams' pace and efficiency with spread/total fields, stadium roof status, and kickoff weather. |
| `news-briefing` | Source-safe briefing | Cross-checks dated reporting from all 47 built-in NFL newsrooms (`searchFirstClassNews`, plus `searchCurrentNews` on Google) against Sleeper and nflverse records. |

## Decision safeguards

Seb validates every direct fantasy action against executed tool inputs and outputs for the requested players and target league before showing a recommendation:

- **Start/sit & full-roster lineup optimization (`start-sit`)**: Whether comparing 2–6 players (`compareStartSit`) or optimizing an entire roster (`optimizeRosterLineup`), Seb requires eligible scoring-aware projections—at least three completed games for player baselines (or valid team defensive inputs for **team D/ST**), available player status, complete stat coverage, and full support for every active league scoring rule (including special-teams return rules when enabled). Unsupported active scoring rules block the recommendation and report the exact gap under `Decision unavailable`.
- **Trade evaluations (`trade-review`)**: Requires both sides of the trade with unique players on each side, every incoming player rostered on the **same opposing team** in the selected league, nflverse usage/volatility evidence, and current news verification (the numerical trade score never issues an accept/decline verdict without news support, never invents arbitrary trade-chart values, and labels rest-of-season projections explicitly as assumptions).
- **Waiver rankings (`waiver-scout`)**: Filters Sleeper trending adds against all rostered players in the target league and scores candidates against **fixed positional production benchmarks** and an **absolute logarithmic demand scale (`0`–`1,000` platform-wide adds)** so rankings never shift based on which other candidates appear in the query.

## Weather, newsroom, and weekly learning rules

### Weather watch (`weather-watch`)

Seb resolves the current NFL season, week, and season type (`REG` or `POST`) automatically, checks the nflverse stadium `roof` field first (skipping direct field-weather adjustments for domes and closed roofs), and matches outdoor US kickoffs to the closest NWS hourly period (~7-day horizon):

- **Risk thresholds**: Wind reaches **medium** risk at `15 mph` and **high** risk at `25 mph`; precipitation probability reaches **medium** at `35%` and **high** at `75%`; severe/extreme NWS alerts trigger **high** risk; extreme cold or heat adds a temperature signal.
- **Preseason & neutral-site limits**: Because nflverse schedule files omit preseason rows and NWS covers US coordinates only, Seb labels preseason team home-stadium outlooks explicitly as unmatched to kickoff/venue and never applies a home stadium's coordinates to an international or neutral-site game.

### Source-safe news briefing (`news-briefing`)

`news-briefing` searches Seb's **47 built-in first-class NFL newsrooms** across every model provider (falling back to grounded Google Search when Google Gemini is active and newsroom coverage is thin). Every parsed discovery item and article timestamp is validated before storage, and conflicting or unconfirmed beat reports are flagged explicitly rather than stated as settled fact.

### Weekly learning (`weekly-learning`)

Use `/skill weekly-learning` after an NFL week finishes to inspect forecast errors, review player or team trends, and trigger validated parameter updates for your league scoring profile. `learnCompletedWeek` rejects updates until every game in that week is final and the 24-hour post-kickoff reporting buffer has elapsed, validates candidate revisions before saving, and never runs background cron jobs or writes LLM-guessed weights. Read the [analysis guide](ANALYSIS.md#update-local-learning) for the complete calibration workflow.

## Choosing the right skill and data boundaries

| When your question focuses on... | Recommended skill |
| --- | --- |
| One lineup slot or optimizing your whole starting lineup (including K & D/ST) | `start-sit` |
| Unbiased player bio/game log, franchise overview, or league-wide NFL stats | `player-info`, `team-info`, or `nfl-stats` |
| Changing snap/target/carry share or opponent positional vulnerability | `usage-trends` or `defense-matchup` |
| Outdoor wind/rain/alert screening or full game script + Vegas lines | `weather-watch` or `game-environment` |
| Understanding projection math/ranges or choosing floor vs. ceiling | `projection-explainer` or `boom-bust` |
| Full-league power rankings, playoff week prep, or post-week model tuning | `league-audit`, `playoff-planner`, or `weekly-learning` |

> [!IMPORTANT]
> Skills never fabricate unavailable feeds: Seb uses public Sleeper, nflverse, NWS, and validated publisher endpoints rather than proprietary injury wires or licensed projection feeds, and nflverse weekly stat releases can lag briefly right after games end. Run `/sources` after any answer to inspect exact URLs and retrieval timestamps.
