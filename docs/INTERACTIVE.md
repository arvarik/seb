# Interactive guide

The interactive interface keeps a conversation and loads useful automatic context.

Start it with either command.

```bash
seb
npm run seb
```

Run `/help` inside Seb to show the local command list.

Most local commands do not call a model provider. Regular questions call the active provider and the required data tools.

Seb refreshes the NFL season, phase, display week, and Sleeper league season at startup.

The optional preferences file stores one Sleeper username.

Seb then discovers every current league and owned roster for that account.

## Recommended first session

1. Ask an Explore question without setup.

   ```text
   Show Derrick Henry's profile, recent statistics, and verified news.
   ```

2. Connect Sleeper when you want My Fantasy.

   ```text
   /connect your-sleeper-name
   What needs my attention across my leagues?
   ```

3. Continue into Analyze from the active subject.

   ```text
   Compare him with Saquon Barkley for the upcoming matchup.
   ```

Seb remembers the active player or team for a natural follow-up.

Seb changes a subject only when the user names that subject or selects it explicitly.

You do not need to select a week, league, roster, team, or workflow first.

Use an advanced override only when you want another period or one league.

Read the [experience guide](EXPERIENCES.md) for complete user journeys.

## Home screen and contextual actions

The home screen shows urgent weekly actions before Explore, My Fantasy, and Analyze.

The header shows the active experience, current NFL state, provider, and model.

It shows up to three contextual actions.

Press `1`, `2`, or `3` to select one action.

Seb submits a complete action immediately.

Seb places an action with a placeholder in the editor.

## Search and completion commands

Press `Ctrl+K` or type `/` to open the command palette.

The menu filters commands after each character.

It groups commands into nine clear sections.

- Essentials
- Explore
- My Fantasy
- Analyze
- Sources
- Conversation
- Preferences
- Advanced
- Diagnostics

The empty palette starts with the three experiences, account connection, and navigation.

It shows active context values and the selected command effect.

Press `Ctrl+G` to select the active league, roster, week, player, or team in one panel.

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
| `/explore [QUESTION]` | Opens Explore or runs one Explore question. |
| `/fantasy [QUESTION]` or `/my` | Opens My Fantasy or runs one account-aware question. |
| `/analyze [QUESTION]` | Opens Analyze or runs one analysis question. |
| `/connect USERNAME` | Saves one username and discovers leagues and owned rosters. |
| `/account` | Shows the connected account and discovered league settings. |
| `/disconnect` | Removes the saved Sleeper username. |
| `/commands [SEARCH]` | Searches the command catalog. |
| `/complete INPUT` | Suggests commands and arguments. |
| `/shortcuts` | Shows the keyboard shortcut guide. |
| `/context` or `/status` | Shows the active session values. |
| `/season YEAR|current` | Sets the active season. |
| `/week NUMBER|current|clear` | Sets or clears the active week. |
| `/user NAME|clear` | Runs the legacy account connection command. |
| `/leagues [SLEEPER_USER] [YEAR]` | Refreshes current or historical fantasy context. |
| `/league [ID|all]` | Shows My Fantasy, or focuses one discovered league or all leagues. |
| `/rosters [LEAGUE_ID]` | Lists every roster in a Sleeper league. |
| `/roster ID|clear` | Sets or clears the Sleeper roster. |
| `/team CODE|clear` | Sets or clears the NFL team. |
| `/skills` | Lists all analysis skills. |
| `/skill NAME [QUESTION]` | Selects a skill, or selects it and runs one question. |
| `/retry` | Runs the latest model prompt again. |
| `/edit` | Places the latest model prompt in the editor. |
| `/setup [USERNAME]` | Saves the current or supplied Sleeper username. |
| `/profile [show|load|clear]` | Reads or removes the preferences file. |
| `/sources` | Shows source URLs and cache outcomes. |
| `/source INDEX` | Shows one numbered source link. |
| `/cache` | Shows SQLite cache and snapshot counts. |
| `/snapshots [KIND]` | Lists recent source snapshots. |
| `/provenance SNAPSHOT_ID` | Shows stored field lineage. |
| `/replay [SEASON] [THROUGH_WEEK]` | Runs the nflverse baseline replay. |
| `/refresh [SOURCE]` | Clears selected source cache entries. |
| `/new` or `/clear` | Starts a new model context. |
| `/history [clear]` | Shows or clears private prompt history. |
| `/copy [all]` | Copies the latest answer, or the full conversation with `all`. |
| `/select` | Prints the full conversation to terminal scrollback for native selection. `Escape` returns to Seb. |
| `/theme NAME` | Selects a display theme. |
| `/icons MODE` | Selects Unicode or ASCII symbols. |
| `/provider [NAME]` | Shows or switches the active configured provider. |
| `/model [MODEL]` | Shows or switches the active model. |
| `/export [NAME] [md|json]` | Exports the transcript. |
| `/doctor [offline]` | Checks configuration and services. |
| `/devtools` | Shows local AI SDK DevTools status and commands. |
| `/usage [session|today|7d|30d|all]` | Shows concise local API usage. |
| `/stats [session|today|7d|30d|all]` | Shows detailed local usage analytics. |
| `/next` | Shows contextual next actions. |
| `/shell-completion SHELL` | Prints a shell completion script. |
| `/version` | Shows the Seb version, provider, and model. |
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

## Automatic context and advanced overrides

Seb normally gets the current period from Sleeper.

It also gets league and roster IDs from the connected account.

Run `/context` to inspect the selected values.

Use these advanced commands only when a question needs a different scope.

| Command | Result |
| --- | --- |
| `/context` | Shows every active value and token total. |
| `/status` | Runs the same action as `/context`. |
| `/season YEAR` | Sets the NFL season. |
| `/season current` | Reads the current season from Sleeper. |
| `/week NUMBER` | Sets an NFL week from 1 through 22. |
| `/week current` | Reads the current week from Sleeper. |
| `/week clear` | Removes the active week. |
| `/user NAME` | Connects a Sleeper account through the legacy command. |
| `/leagues [USER] [YEAR]` | Refreshes current or historical leagues. |
| `/league ID` | Focuses one discovered Sleeper league. |
| `/league all` | Returns My Fantasy to all discovered leagues. |
| `/league` | Shows the current fantasy dashboard and discovered leagues. |
| `/rosters [LEAGUE_ID]` | Lists every roster in the selected league. |
| `/roster ID` | Sets the Sleeper roster ID. |
| `/team CODE` | Sets an NFL team code, such as `SEA`. |

Use `/disconnect` to remove the saved account.

For historical fantasy research, run `/leagues USERNAME YEAR`.

The normal `/connect USERNAME` path always returns to the current Sleeper state.

## Account preference commands

Run `/connect USERNAME` for the normal account flow.

Seb validates the user, discovers leagues, finds owned rosters, and saves the username.

Run `/account` to show the automatic fantasy context.

Run `/disconnect` to remove the saved username.

```text
/connect your-sleeper-name
/account
/disconnect
```

The account preferences file never contains a league, roster, NFL team, season, week, or provider key.

Use `/league ID` only when you want one league instead of the account-wide view.

```text
/league 123456789
/league all
```

Show the saved preferences file.

```text
/profile show
```

Load its username and refresh the current fantasy context.

```text
/profile load
```

Remove the saved file.

```text
/profile clear
```

The clear action removes the file without changing the active session.

Read the [setup guide](SETUP.md) for the path and file permissions.

## Model selection

Run either command without an argument to show the active provider and model.

```text
/provider
/model
```

Switch to another configured provider.

```text
/provider anthropic
```

This command keeps the selected provider's configured fallback model.

Switch the active provider to another model.

```text
/model claude-haiku-4-5
```

Seb verifies the new selection before it changes the active agent.

A successful switch starts a fresh model context. It keeps the visible transcript.

The switch clears the prior answer evidence because that evidence belongs to the prior model context.

A failed switch keeps the prior provider, model, context, and agent.

An explicit `/model` value uses that model as its own fallback for the session.

The slash commands have no API key or endpoint argument. Run `seb configure` to add them.

## Skill commands

Run `/skills` to list every skill.

Run `/skill NAME` to select one skill.

Add a question after the name to select and run the skill in one step.

```text
/skill waiver-scout
/skill weather-watch
/skill usage-trends
/skill player-info
/skill team-info
/skill nfl-stats
/skill player-info Lamar Jackson
```

The skill changes the analysis instructions. It does not hide any read-only data tool.

The home screen keeps workflows under the Advanced command group.

An action with missing values stays in the editor for completion.

Read the [skill guide](SKILLS.md) for all available workflows.

## Decision safeguards

Seb records the input and result for each tool that runs during a decision request.

It uses those records to match the evidence to the requested player and selected league.

A start-sit action needs an eligible scoring-aware projection.

An unsupported active scoring rule blocks that action.

A trade package needs unique players from one opposing roster.

Waiver production and demand use fixed scales that do not depend on the candidate list.

Seb buffers a direct action answer until the evidence gate finishes.

If the evidence is incomplete, Seb shows `Decision unavailable` and lists the missing requirements.

Run `/sources` after the answer to inspect the supporting records.

## Source commands

Run `/sources` after an answer.

Seb shows each source URL that the latest answer used.

The source list records Sleeper endpoints, nflverse files, NWS endpoints, and web reporting.

Answers include one compact Evidence section with up to three source links.

The section labels each source as `LIVE`, `CACHED`, or `STALE` and shows retrieval details.

Seb keeps an immutable source set for each answer during the session.

Seb keeps at most 100 sources in one answer snapshot and 50 answer snapshots in one session.

The live source tracker keeps at most 200 records.

Seb accepts only HTTP and HTTPS web source links.

Run `/new` to clear the source list and start a new model context.

The terminal keeps the visible transcript after `/new`.

The header shows a short source state for the latest source.

The states include `LIVE`, `CACHED`, and `STALE`.

Run `/source INDEX` to print one numbered source as a clickable link.

## Prompt editing and history

The editor supports cursor movement, word movement, deletion, and multiline prompts.

Press `Alt+Enter` to insert a new line.

Bracketed paste keeps a multiline paste inside one prompt.

One submitted prompt can contain at most 32,000 characters.

Seb keeps at most 24 recent model messages and 120,000 estimated context characters.

Use `Up` and `Down` to read prior prompts.

Use the mouse wheel or `Page Up` and `Page Down` to scroll the transcript.

Each mouse wheel event moves three transcript rows.

Seb batches rapid wheel events at 60 frames per second.

Press `Ctrl+R` to search history with the current editor text.

Run `/history` to show saved prompts.

Run `/history clear` to delete the private history file.

Set `SEB_HISTORY=false` to disable disk history.

Read the [terminal interface guide](TERMINAL_UI.md) for every key and path.

Tool activity uses one compact row per call. Consecutive successful calls to the same tool share a count and total duration. Failures retain their error text.

## Retry, edit, and copy

Run `/retry` to submit the latest non-command prompt again.

Run `/edit` to place that prompt in the editor.

Run `/copy all` to copy the full conversation, including prompts and tool activity.

Run `/copy` to send the latest answer to the terminal clipboard.

Seb uses the local system clipboard when available. It also sends OSC 52 for compatible terminals.

Drag across visible text to select it. Seb highlights the selection and copies it when you release the mouse button.

Hold the pointer at the top or bottom edge while dragging to extend the selection across the conversation. You can also use the mouse wheel during a drag.

Seb keeps the selected transcript stable while a response arrives. A resize clears the selection.

Run `/select` to print the full conversation to normal terminal scrollback. Use your terminal to scroll, select, and copy. Press `Escape` to return. The printed conversation remains in terminal scrollback.

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

Seb shows contextual next actions on the first prompt.

Run `/new` or `/clear` to show the actions again.

Seb hides the actions after you submit a prompt.

Run `/next` when you want only the current action list.

The suggestions use the active experience, player, team, and fantasy account.

Player suggestions repeat the active player name.

Seb learns the active player from player tool input and inline player skills.

The model does not add interface suggestions to its answer.

Run `/usage` to show model requests and token totals.

Run `/stats` to show token classes, latency, models, tool calls, and daily trends.

Both reports show the successful run rate and safe error categories.

They count failures that occur after a client tool returns.

Both commands default to the current interactive session.

```text
/usage
/usage today
/stats
/stats 30d
```

The `today` range starts at local midnight. The `7d` and `30d` ranges use rolling clock time.

The `all` range removes the time filter. Each report reads the 10,000 newest matching runs at most.

The reports include their start time and exclude their end time.

One model call means one AI SDK model step. Provider HTTP retries remain outside local coverage.

Seb keeps missing token metrics unknown. It does not convert a missing metric to zero.

Seb calculates each token ratio only from model calls that report both required fields.

An unfinished run can still be active. It can also come from an earlier process that stopped before the final lifecycle event.

The detailed report shows input, cache-read, cache-write, text, reasoning, tool-use, and total tokens.

It shows average, p50, p90, p95, and maximum latency with the sample count.

It separates client tools from provider tools.

Tool outcomes include returned, error, invalid, cancelled, and unresolved.

A repeated call is each extra call with the same tool name in one run. Seb does not compare tool input.

A returned provider result does not prove a successful domain result.

The commands read only the active local SQLite database.

They do not show Google account quota, credits, billing totals, or currency cost.

Seb stores no prompts, answers, tool inputs, tool results, or raw errors in these analytics tables.

Use `seb stats prune` or `seb stats clear` outside the interface to remove saved telemetry.

Read the [command-line guide](CLI.md#inspect-local-api-usage) for retention commands and JSON output.

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

The full doctor forces the active provider through one local tool loop.

The Google check also requires one valid grounded Google Search URL.

## Session boundaries

Run `/new` before an unrelated research task.

This command removes earlier messages from the next model request.

The command keeps the automatic NFL state and Sleeper account.

It clears the active subject and advanced workflow.

Use the related `clear` commands when you also want to remove those values.

Press Escape during a request to stop only that request.

Press Ctrl+C to exit.

Run `/exit`, `/quit`, or `/q` to exit from an empty prompt.

## Example workflows

### Start and sit

```text
/analyze Compare Player A and Player B in PPR. Include usage, opponent, and weather.
```

### Weather watch

```text
/analyze Which outdoor games have the highest fantasy weather risk this week?
```

Seb loads the current week and season type automatically.

During preseason, nflverse can lack the required game row.

Seb then gives a home-stadium outlook and labels the missing venue and kickoff match.

### Player information

```text
/explore Show Justin Jefferson's player profile and 2025 NFL game log.
```

This skill does not add fantasy advice unless you request it.

### Team information

```text
/explore Show Seattle's team profile, current player records, schedule, and recent results.
```

Sleeper player records are not an official NFL roster source.

### NFL facts and stats

```text
/explore Show the complete NFL schedule and recorded results for this week.
```

### Trade review

```text
/analyze Compare Player A for Player B. Show production, usage, roster fit, and risk.
```

### League audit

```text
/fantasy Rank every roster in my leagues and explain each main weakness.
```

### Waiver scout

```text
/fantasy Rank the top trending adds by recent opportunity and schedule.
```
