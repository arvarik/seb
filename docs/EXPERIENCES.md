# Explore, My Fantasy, and Analyze

Seb supports three connected experiences.

Users can ask normal questions without selecting an experience first.

The `/explore`, `/fantasy`, and `/analyze` commands change the visible experience.

Seb does not change that selection from a keyword in a question.

## Explore

Explore answers NFL information questions.

It covers players, teams, league-wide facts, statistics, schedules, results, and verified news.

Explore needs no Sleeper account.

Example questions:

```text
Show Derrick Henry's current profile and recent game log.
What is the latest verified news about Baltimore?
Show the strongest rushing offenses this season.
```

## My Fantasy

My Fantasy adds personal Sleeper context.

The user connects one username with `/connect USERNAME` or `seb setup USERNAME`.

Seb stores only that username.

At startup, Seb completes these actions:

1. It reads the current NFL state from Sleeper.
2. It separates the NFL season from the Sleeper league season.
3. It uses Sleeper's display week as the current user-facing week.
4. It discovers every NFL league for the current league season.
5. It finds every roster that the user owns or co-owns.
6. It reads available trade, playoff, and waiver settings.
7. It checks open starter slots, player status signals, and nearby deadlines.

Seb keeps an account-wide view when several leagues remain relevant.

It selects one league only when one owned league clearly matches the current season.

Example questions:

```text
What needs my attention across my leagues?
Show urgent news for players on my rosters.
Which league has the weakest running back depth?
```

Sleeper can use custom daily waiver schedules.

Seb shows the available settings and states when Sleeper owns the exact live countdown.

## Analyze

Analyze turns an active subject into a decision or comparison.

It can combine statistics, recent usage, matchup strength, weather, news, and fantasy roster fit.

Scoring-aware projections show a median, floor, ceiling, confidence, adjustments, and limits.

The waiver assistant ranks unrostered targets and shows a transparent FAAB range when the league uses FAAB.

The trade impact tool compares recent scoring value and roster position changes on both sides.

Seb requires current sources, resolved player identity, player status, current news, and league scoring before it displays a recommendation.

Seb keeps the active player from the previous answer.

Therefore, a follow-up can use a pronoun without repeating the player name.

```text
Show Derrick Henry's player information.
Look deeper into his statistics.
Compare him with Saquon Barkley for the upcoming matchup.
```

Advanced workflows remain available through `/skills` and `/skill`.

Most users do not need to select a workflow.

## Progressive disclosure

The home screen shows urgent weekly actions before the three experiences when a Sleeper account is connected.

The command palette shows common experience and account actions first.

It places manual season, week, league, roster, team, and workflow controls under Advanced.

Use those controls for historical research or a narrow league focus.

Do not use them as normal setup steps.

## Saved and automatic values

| Value | Source | Persistence |
| --- | --- | --- |
| Sleeper username | User preference | Saved locally |
| NFL season and phase | Current Sleeper state | Refreshed per request or session |
| Display week | Current Sleeper state | Refreshed per request or session |
| Sleeper league season | Current Sleeper state | Refreshed per request or session |
| Leagues | Connected Sleeper account | Rediscovered automatically |
| Owned rosters | League roster records | Rediscovered automatically |
| Active player or team | Current conversation | Current session |
| Focused league | User override or clear automatic match | Current session |

Seb never saves an API key, league ID, roster ID, NFL team, season, or week in the preferences file.

## Failure behavior

Explore and Analyze remain available when account refresh fails.

The header keeps the account name and shows a refresh warning.

Seb never invents a league, roster, week, deadline, or player identity.

Run `/connect USERNAME` to retry the complete account refresh.

Run `/disconnect` to remove the account preference.

Sleeper publishes the current state, user leagues, and roster endpoints in its [API documentation](https://docs.sleeper.com/).

Sleeper explains trade deadline timing in its [trade deadline guide](https://support.sleeper.com/en/articles/2435411-when-is-my-trade-deadline).

Sleeper explains custom waiver schedules in its [waiver guide](https://support.sleeper.com/en/articles/3978868-waivers-for-regular-season-playoffs).
