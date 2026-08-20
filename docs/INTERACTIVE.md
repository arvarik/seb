# Interactive guide

The interactive interface keeps a conversation and active NFL or fantasy context.

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
   /context
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

## Home screen and contextual actions

The home screen shows the active season, week, model, skill, and source health.

It shows up to three contextual actions.

Press `1`, `2`, or `3` to select one action.

Seb submits a complete action immediately.

Seb places an action with a placeholder in the editor.

## Search and completion commands

Press `Ctrl+K` or type `/` to open the command palette.

The menu filters commands after each character.

It groups commands into seven clear sections.

- Essentials
- Context
- Analysis
- Sources
- Conversation
- Preferences
- Diagnostics

The empty palette starts with the most common context, skill, and navigation commands.

It shows active context values and the selected command effect.

It places recent commands before equally relevant commands.

A warning symbol identifies a local state-clearing command.

Use Up and Down to select one result.

Press Tab to fill the selected command or argument.

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

The menu closes after you complete one valid `/skill` value.

Seb never appends a second skill to the same command.

After `/leagues` or `/rosters`, the menu also suggests the discovered IDs.

Unknown commands show up to three likely command names.

The `/complete` command remains useful in copied transcripts and remote terminals.

## Complete local command reference

| Command | Result |
| --- | --- |
| `/help` or `/?` | Shows every interactive command. |
| `/commands [SEARCH]` | Searches the command catalog. |
| `/complete INPUT` | Suggests commands and arguments. |
| `/shortcuts` | Shows the keyboard shortcut guide. |
| `/context` or `/status` | Shows the active session values. |
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
| `/retry` | Runs the latest model prompt again. |
| `/edit` | Places the latest model prompt in the editor. |
| `/setup` | Saves team-independent defaults. |
| `/profile [show|load|clear]` | Reads or removes the setup profile. |
| `/sources` | Shows source URLs and cache outcomes. |
| `/source INDEX` | Shows one numbered source link. |
| `/cache` | Shows SQLite cache and snapshot counts. |
| `/snapshots [KIND]` | Lists recent source snapshots. |
| `/provenance SNAPSHOT_ID` | Shows stored field lineage. |
| `/replay [SEASON] [THROUGH_WEEK]` | Runs the nflverse baseline replay. |
| `/refresh [SOURCE]` | Clears selected source cache entries. |
| `/new` or `/clear` | Starts a new model context. |
| `/history [clear]` | Shows or clears private prompt history. |
| `/copy` | Copies the latest Seb answer. |
| `/theme NAME` | Selects a display theme. |
| `/icons MODE` | Selects Unicode or ASCII symbols. |
| `/export [NAME] [md|json]` | Exports the transcript. |
| `/doctor [offline]` | Checks configuration and services. |
| `/devtools` | Shows local AI SDK DevTools status and commands. |
| `/usage` | Shows session token counts. |
| `/next` | Shows contextual next actions. |
| `/shell-completion SHELL` | Prints a shell completion script. |
| `/version` | Shows the Seb and Gemini versions. |
| `/exit` or `/quit` | Exits interactive mode. |

Earlier command names remain available as aliases.

| Earlier name | Primary name |
| --- | --- |
| `/status` | `/context` |
| `/open` | `/source` |
| `/cost` | `/usage` |
| `/suggest` | `/next` |
| `/save` | `/export` |
| `/completion` | `/shell-completion` |

## Context commands

| Command | Result |
| --- | --- |
| `/context` | Shows every active value and token total. |
| `/status` | Runs the same action as `/context`. |
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
/skill player-info
/skill team-info
/skill nfl-stats
```

The skill changes the analysis instructions. It does not hide any read-only data tool.

The home screen shows actions for the active skill before optional setup actions.

An action with missing values stays in the editor for completion.

Read the [skill guide](SKILLS.md) for all available workflows.

## Source commands

Run `/sources` after an answer.

Seb shows each source URL that a data client or grounded search used during the session.

The source list records Sleeper endpoints, nflverse files, NWS endpoints, and web reporting.

Current-news answers include a `Web sources` section when Gemini returns source links.

Seb accepts only HTTP and HTTPS web source links.

Run `/new` to clear the source list and start a new model context.

The terminal keeps the visible transcript after `/new`.

The header shows a short source state for the latest source.

The states include `LIVE`, `WEB`, `CACHED`, `STATS`, and `STALE`.

Run `/source INDEX` to print one numbered source as a clickable link.

## Prompt editing and history

The editor supports cursor movement, word movement, deletion, and multiline prompts.

Press `Alt+Enter` to insert a new line.

Bracketed paste keeps a multiline paste inside one prompt.

Use `Up` and `Down` to read prior prompts.

Press `Ctrl+R` to search history with the current editor text.

Run `/history` to show saved prompts.

Run `/history clear` to delete the private history file.

Set `SEB_HISTORY=false` to disable disk history.

Read the [terminal interface guide](TERMINAL_UI.md) for every key and path.

## Retry, edit, and copy

Run `/retry` to submit the latest non-command prompt again.

Run `/edit` to place that prompt in the editor.

Run `/copy` to send the latest answer to the terminal clipboard.

The clipboard action needs terminal OSC 52 support.

## Themes and symbols

Select a display theme inside the session.

```text
/theme default
/theme high-contrast
/theme compact
```

Select Unicode or ASCII symbols.

```text
/icons unicode
/icons ascii
```

Seb respects the `NO_COLOR` environment variable.

Read the [terminal interface guide](TERMINAL_UI.md) for startup environment values.

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

## Next actions and token use

Seb adds contextual next actions after each answer.

Run `/next` when you want only the current action list.

The suggestions use the active skill and the missing session values.

Run `/usage` to show model requests and token totals.

The command does not calculate currency cost. Gemini prices can change.

Seb removes old tool data before a long model request.

It keeps the six latest messages with tool data.

This rule reduces token use without deleting recent conversation text.

## Local AI SDK DevTools

Run `/devtools` to show whether local trace recording is active.

Enable recording before you start Seb.

```bash
SEB_DEVTOOLS=true npm run seb
```

Start the viewer in another terminal.

```bash
npm run devtools
```

DevTools stores complete prompts and tool data under `.devtools/`.

Never enable this feature in production.

Read the [AI SDK guide](AI_SDK.md) for its privacy rules.

## Shell completion

Print a Bash, Fish, or Zsh completion script inside chat.

```text
/shell-completion zsh
```

Use the top-level command for direct installation.

```bash
seb completion zsh
```

Read the [command-line guide](CLI.md) for exact shell installation steps.

## Transcript exports

Run `/export` to create a Markdown file with an automatic name.

```text
/export
```

Run `/export NAME md` to select a Markdown name.

```text
/export week-1-review md
```

Run `/export NAME json` to store complete UI messages as JSON.

```text
/export week-1-review json
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

Press Escape during a request to stop only that request.

Press Ctrl+C to exit.

Run `/exit`, `/quit`, or `/q` to exit from an empty prompt.

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
/week current
/skill weather-watch
Which outdoor games have the highest fantasy weather risk?
```

`/week current` also loads the preseason, regular-season, or postseason type.

During preseason, nflverse can lack the required game row.

Seb then gives a home-stadium outlook and labels the missing venue and kickoff match.

### Player information

```text
/skill player-info
Show Justin Jefferson's player profile and 2025 NFL game log.
```

This skill does not add fantasy advice unless you request it.

### Team information

```text
/team SEA
/skill team-info
Show the team profile, current player records, schedule, and recent results.
```

Sleeper player records are not an official NFL roster source.

### NFL facts and stats

```text
/week 8
/skill nfl-stats
Show the complete NFL schedule and recorded results for this week.
```

### Trade review

```text
/season 2026
/skill trade-review
Compare Player A for Player B. Show production, usage, roster fit, and risk.
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
