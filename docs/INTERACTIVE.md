# Interactive guide

The interactive interface keeps a conversation and active fantasy context.

Start it with either command.

```bash
seb
npm run seb
```

Run `/help` inside Seb to show the local command list.

Local commands do not call Gemini. Regular questions call Gemini and the required data tools.

Seb creates a team-independent setup profile when no local profile exists.

The saved profile supplies only the default season.

Sleeper users, leagues, rosters, and NFL teams remain session-specific.

## Recommended first session

1. Show the loaded profile and session values.

   ```text
   /profile show
   /status
   ```

2. Set the current week.

   ```text
   /week current
   ```

3. Set an NFL team when several questions use the same team.

   ```text
   /team SEA
   ```

4. Select an analysis skill.

   ```text
   /skill start-sit
   ```

5. Ask a normal question.

   ```text
   Compare my two flex choices for this week.
   ```

Seb uses the active values when a question does not give different values.

## Search and completion commands

Type `/` to open the live command menu.

The menu filters commands after each character.

Use Up and Down to select one result.

Press Tab or Right Arrow to fill the selected command or argument.

Press Enter to run the current input.

Press Escape to close the menu without exiting Seb.

Run `/help` to show the complete command catalog.

Run `/commands SEARCH` to search command names and descriptions.

```text
/commands cache
/commands token
```

The search accepts prefixes, contained text, and fuzzy characters.

Run `/complete INPUT` to suggest a command or argument.

```text
/complete /ref
/complete /team se
/complete /skill wea
```

The argument suggestions include skills, NFL teams, and active context values.

After `/leagues` or `/rosters`, the menu also suggests the discovered IDs.

Unknown commands show up to three likely command names.

The `/complete` command remains useful in copied transcripts and remote terminals.

## Complete local command reference

| Command | Result |
| --- | --- |
| `/help` or `/?` | Shows every interactive command. |
| `/commands [SEARCH]` | Searches the command catalog. |
| `/complete INPUT` | Suggests commands and arguments. |
| `/status` or `/context` | Shows the active session values. |
| `/season YEAR|current` | Sets the active season. |
| `/week NUMBER|current|clear` | Sets or clears the active week. |
| `/user NAME|clear` | Sets or clears the Sleeper user. |
| `/leagues [SLEEPER_USER]` | Discovers leagues for the active season. |
| `/league ID|clear` | Sets or clears the Sleeper league. |
| `/rosters [LEAGUE_ID]` | Lists every roster in a Sleeper league. |
| `/roster ID|clear` | Sets or clears the Sleeper roster. |
| `/team CODE|clear` | Sets or clears the NFL team. |
| `/skills` | Lists all analysis skills. |
| `/skill NAME|list` | Selects or lists a skill. |
| `/setup` | Saves team-independent defaults. |
| `/profile [show|load|clear]` | Reads or removes the setup profile. |
| `/sources` | Shows source URLs and cache outcomes. |
| `/cache` | Shows SQLite cache and snapshot counts. |
| `/snapshots [KIND]` | Lists recent source snapshots. |
| `/provenance SNAPSHOT_ID` | Shows stored field lineage. |
| `/replay [SEASON] [THROUGH_WEEK]` | Runs the nflverse baseline replay. |
| `/refresh [SOURCE]` | Clears selected source cache entries. |
| `/new` or `/clear` | Starts a new model context. |
| `/save [NAME] [md|json]` | Saves the transcript. |
| `/doctor [offline]` | Checks configuration and services. |
| `/cost` | Shows session token counts. |
| `/suggest` or `/suggestions` | Shows contextual next actions. |
| `/completion SHELL` | Prints a shell completion script. |
| `/version` | Shows the Seb and Gemini versions. |

## Context commands

| Command | Result |
| --- | --- |
| `/status` | Shows every active value and token total. |
| `/context` | Runs the same action as `/status`. |
| `/season YEAR` | Sets the NFL season. |
| `/season current` | Reads the current season from Sleeper. |
| `/week NUMBER` | Sets an NFL week from 1 through 22. |
| `/week current` | Reads the current week from Sleeper. |
| `/week clear` | Removes the active week. |
| `/user NAME` | Sets the Sleeper user. |
| `/leagues [USER]` | Lists the user's leagues for the active season. |
| `/league ID` | Sets the numeric Sleeper league ID. |
| `/rosters [LEAGUE_ID]` | Lists every roster in the selected league. |
| `/roster ID` | Sets the Sleeper roster ID. |
| `/team CODE` | Sets an NFL team code, such as `SEA`. |

Use `clear` with `/user`, `/league`, `/roster`, or `/team` to remove that value.

## Setup and profile commands

Run `/setup` to save the active season as the global default.

Setup never saves a Sleeper user, league, roster, or NFL team.

Run `/season YEAR` first when you want another default season.

Discover a user's leagues.

```text
/leagues your-sleeper-name
```

Select one returned league.

```text
/league 123456789
```

List every roster in that league, then select one.

```text
/rosters
/roster 4
```

Seb applies these values only to the active interactive session.

Show the saved profile.

```text
/profile show
```

Load its default season into the current session again.

```text
/profile load
```

Remove the saved file.

```text
/profile clear
```

The clear action does not erase current session values.

Use the related context commands to clear those values.

The profile never contains the Gemini key.

Read the [setup guide](SETUP.md) for the path and file permissions.

## Skill commands

Run `/skills` to list every skill.

Run `/skill NAME` to select one skill.

```text
/skill waiver-scout
/skill weather-watch
/skill usage-trends
```

The skill changes the analysis instructions. It does not hide any read-only data tool.

Read the [skill guide](SKILLS.md) for all available workflows.

## Source commands

Run `/sources` after an answer.

Seb shows each source URL that a data client used during the session.

The source list records Sleeper endpoints, nflverse files, and NWS endpoints.

Run `/new` to clear the source list and start a new model context.

The terminal keeps the visible transcript after `/new`.

## Cache and snapshot commands

Seb stores source caches and snapshots in `.cache/seb.sqlite`.

Show the active database and record counts.

```text
/cache
```

The result includes canonical identity and provider source-link counts.

List the latest snapshots.

```text
/snapshots
/snapshots nflverse-player-stats
```

The optional value filters the snapshot kind.

Inspect one snapshot's field lineage.

```text
/provenance SNAPSHOT_ID
```

This command shows up to 50 field paths and their source IDs.

Use these commands when a source published new data.

```text
/refresh sleeper
/refresh nflverse
/refresh weather
/refresh all
```

The command deletes only the selected source cache entries.

It preserves every historical snapshot.

The next request downloads fresh data.

Read the [data source guide](DATA_SOURCES.md) for each cache period.

Read the [storage guide](STORAGE.md) for SQLite and snapshot details.

## Historical replay

Run the nflverse PPR baseline inside chat.

```text
/replay 2025 10
```

The first value selects the season.

The second value selects the final week.

Seb uses the previous active season when you omit the season.

Seb uses Week 18 when you omit the final week.

Read the [evaluation guide](EVALUATION.md) for leakage rules and metrics.

## Suggestions and token use

Seb adds contextual next actions after each answer.

Run `/suggest` when you want only the current action list.

The suggestions use the active skill and the missing session values.

Run `/cost` to show model requests and token totals.

The command does not calculate currency cost. Gemini prices can change.

## Shell completion

Print a Bash, Fish, or Zsh completion script inside chat.

```text
/completion zsh
```

Use the top-level command for direct installation.

```bash
seb completion zsh
```

Read the [command-line guide](CLI.md) for exact shell installation steps.

## Transcript exports

Run `/save` to create a Markdown file with an automatic name.

```text
/save
```

Run `/save NAME md` to select a Markdown name.

```text
/save week-1-review md
```

Run `/save NAME json` to store complete UI messages as JSON.

```text
/save week-1-review json
```

Seb writes each file under `exports/`. Git ignores that folder.

Seb rejects an existing file name. This rule prevents an accidental overwrite.

## Diagnostics

Run the full doctor inside a session.

```text
/doctor
```

Run only local checks when the network is unavailable.

```text
/doctor offline
```

The full doctor sends one small Gemini request.

## Session boundaries

Run `/new` before an unrelated research task.

This command removes earlier messages from the next model request.

The command keeps season, week, league, roster, team, and skill values.

Use the related `clear` commands when you also want to remove those values.

Press Escape or Ctrl+C to exit.

## Example workflows

### Start and sit

```text
/season 2026
/week 8
/team SEA
/skill start-sit
Compare Player A and Player B in PPR. Include usage, opponent, and weather.
```

### Weather watch

```text
/season 2026
/week 12
/skill weather-watch
Which outdoor games have the highest fantasy weather risk?
```

### League audit

```text
/league 123456789
/week 8
/skill league-audit
Rank every roster and explain each main weakness.
```

### Waiver scout

```text
/league 123456789
/week 8
/skill waiver-scout
Rank the top trending adds by recent opportunity and schedule.
```
