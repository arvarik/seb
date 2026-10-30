# Interactive Guide

[Documentation Hub](README.md) · [Experience Model](EXPERIENCES.md) · [Terminal UI](TERMINAL_UI.md) · [Skill Guide](SKILLS.md)

Seb's interactive terminal interface maintains a multi-turn research conversation, refreshes live NFL and Sleeper context automatically, and verifies every fantasy recommendation before rendering it. Launch it with `seb` (or `npm run seb` in a source checkout).

## Recommended first session

You never need to configure a season, week, league ID, roster ID, or workflow before asking questions—Seb refreshes the NFL season, phase, display week, and Sleeper league season at startup and carries active subjects across turns:

1. **Explore NFL facts and verified news** (no Sleeper account needed):
   ```text
   Show Derrick Henry's profile, recent statistics, and verified news.
   ```
2. **Connect Sleeper for My Fantasy** (discovers every current league and owned roster automatically):
   ```text
   /connect your-sleeper-name
   What needs my attention across my leagues?
   ```
3. **Continue seamlessly into Analyze** using natural pronouns from the active subject:
   ```text
   Compare him with Saquon Barkley for the upcoming matchup.
   ```

Seb updates the active player or team only when you name a new subject or select one explicitly. Read the [Experience model](EXPERIENCES.md) for how all three modes share context.

## Home screen, header, and contextual actions

At startup, the header displays your session state at a glance:

- **Seb version** and **current NFL season, phase, and display week**.
- **Active resolved model ID** (for example, the concrete version resolved from `gemini-flash`).
- **Sleeper connection badge** (`@user · N LEAGUES` when connected, or `SLEEPER NOT CONNECTED`).
- **Active context overrides** when set (`FOCUS`, `ROSTER`, `PLAYER`, `TEAM`, and `WORKFLOW`), plus the latest source freshness indicator (`LIVE`, `CACHED`, or `STALE`).

On the home screen—and after running `/explore`, `/fantasy`, `/analyze`, `/skill`, `/next`, or `/new`—Seb displays up to three numbered contextual actions tailored to your urgent fantasy priorities or active subject. Press **`1`**, **`2`**, or **`3`** to **stage** that choice in the prompt editor, then press **`Enter`** to run it (or edit any placeholder text first before submitting).

## Command palette, search, and completion

Press **`Ctrl+K`** or type **`/`** at the start of an empty prompt to open the interactive command palette, which organizes commands into nine sections: **Essentials**, **Explore**, **My Fantasy**, **Analyze**, **Sources**, **Conversation**, **Preferences**, **Advanced**, and **Diagnostics**.

- **Navigate & complete**: Use `Up` and `Down` to highlight a command, press **`Tab`** or **`Right Arrow`** to fill the selected command or argument (such as a skill slug, NFL team code, or discovered league/roster ID), and press `Enter` to run it or `Escape` to close the menu.
- **Quick context switcher**: Press **`Ctrl+G`** to cycle active league, roster, week, player, or team overrides in a single compact panel.
- **Search & scriptable completion**: Run `/commands <SEARCH>` for prefix, substring, or fuzzy lookup across command names and descriptions, or `/complete <INPUT>` (such as `/complete /skill wea`) in remote/copied transcripts. Destructive state-clearing commands display a warning marker in the palette.

## Complete local command reference

Most slash commands execute locally without calling a language model:

| Command | Result |
| --- | --- |
| `/help` or `/?` | Shows the complete interactive command catalog. |
| `/about [TOPIC]` | Explains Seb's design and internals (`overview`, `architecture`, `projections`, `sources`, `storage`, `learning`, `models`, `connectors`, `cli`). |
| `/explore [QUESTION]` | Switches to Explore or runs an NFL information question. |
| `/fantasy [QUESTION]` or `/my` | Switches to My Fantasy or runs an account-aware fantasy question. |
| `/analyze [QUESTION]` | Switches to Analyze or runs a comparison/decision question. |
| `/connect <USERNAME>` | Validates and saves one Sleeper username, then discovers leagues and owned rosters. |
| `/account` | Displays the connected Sleeper account and discovered league settings. |
| `/brief [LEAGUE_ID]` or `/autopilot` | Generates a deterministic weekly autopilot brief across all active leagues (or one league). |
| `/disconnect` | Removes the saved Sleeper username. |
| `/context` or `/status` | Shows active session context values and session token totals. |
| `/memory [clear]` | Displays or clears pinned session working memory (preferences, tracked players, decisions). |
| `/season <YEAR\|current>` | Overrides the active NFL season or restores Sleeper's live season. |
| `/week <1..22\|current\|clear>` | Sets, restores, or clears the active NFL week override. |
| `/leagues [USER] [YEAR]` | Refreshes current or historical Sleeper leagues. |
| `/league [ID\|all\|clear]` | Shows the My Fantasy dashboard, focuses one league, or clears focus back to all leagues. |
| `/rosters [LEAGUE_ID]` | Lists every roster in the focused or specified Sleeper league. |
| `/roster <ID\|clear>` | Sets or clears an explicit Sleeper roster override. |
| `/team <CODE\|clear>` | Sets or clears an active NFL team code (such as `SEA`). |
| `/user <NAME\|clear>` | Legacy alias for connecting or clearing a Sleeper username. |
| `/skills` | Lists all 19 specialized skills grouped into NFL information, Fantasy, and Research. |
| `/skill <NAME> [QUESTION]` | Activates a skill workflow, optionally running `QUESTION` immediately. |
| `/next`, `/suggest`, or `/suggestions` | Displays contextual next-action suggestions for the current state. |
| `/sources` | Lists verified source URLs, retrieval timestamps, and cache outcomes for the latest answer. |
| `/source <INDEX>` | Prints one numbered source from `/sources` as a clickable link. |
| `/refresh [sleeper\|nflverse\|weather\|news\|all]` | Invalidates cached entries for the chosen source while preserving snapshots. |
| `/cache` | Displays SQLite cache, snapshot, identity, and local telemetry counts. |
| `/snapshots [KIND]` | Lists recent stored source snapshots, optionally filtered by kind. |
| `/provenance <SNAPSHOT_ID>` | Displays up to 50 stored field-lineage paths for a snapshot. |
| `/replay [SEASON] [THROUGH_WEEK]` | Runs the leakage-free nflverse PPR baseline replay inside chat. |
| `/provider [NAME]` | Shows or switches the active model provider for the current session. |
| `/model [MODEL]` | Shows or switches the active model or model family for the current session. |
| `/retry` | Re-runs the most recent non-command prompt. |
| `/edit` | Loads the most recent non-command prompt back into the editor. |
| `/copy [all]` | Copies the latest answer (or the full conversation with `all`) via system clipboard and OSC 52. |
| `/select` or `/copy-mode` | Prints the full conversation to native terminal scrollback for selection (`Escape` returns). |
| `/export [NAME] [md\|json]` | Exports the transcript to `exports/` without overwriting existing files. |
| `/new` or `/clear` | Starts a fresh model context while keeping the visible transcript and Sleeper connection. |
| `/history [clear]` | Displays or deletes saved private prompt history. |
| `/setup [USERNAME]` | Saves the active or supplied Sleeper username to `profile.json`. |
| `/profile [show\|load\|clear]` | Inspects, reloads, or deletes `profile.json` without dropping the live session. |
| `/theme <default\|high-contrast\|contrast\|compact>` | Switches the terminal color and spacing theme (`contrast` aliases `high-contrast`). |
| `/icons <unicode\|ascii>` | Switches between Unicode sparklines/glyphs and portable ASCII symbols. |
| `/commands [SEARCH]` | Searches slash command names and descriptions. |
| `/complete <INPUT>` | Suggests command or argument completions for `INPUT`. |
| `/shortcuts` | Opens the keyboard shortcut reference overlay (`?` on an empty prompt also opens it). |
| `/usage [session\|today\|7d\|30d\|all]` | Shows concise local model and token usage (defaults to `session`). |
| `/stats [session\|today\|7d\|30d\|all]` | Shows detailed latency, token, model, and tool telemetry (defaults to `session`). |
| `/doctor [offline\|--offline]` | Runs all 9 health checks, or local-only checks with `offline` / `--offline`. |
| `/devtools` | Shows local AI SDK DevTools trace status and viewer instructions. |
| `/shell-completion <SHELL>` | Prints a `zsh`, `bash`, or `fish` completion script. |
| `/version` | Shows the Seb version, active provider, and resolved model ID. |
| `/exit`, `/quit`, or `/q` | Saves the session snapshot, prints the `seb resume <ID>` command, and exits. |

### Command aliases

| Alias | Primary command |
| --- | --- |
| `/?` | `/help` |
| `/architecture`, `/arch` | `/about` |
| `/my` | `/fantasy` |
| `/autopilot` | `/brief` |
| `/status` | `/context` |
| `/open` | `/source` |
| `/cost` | `/usage` |
| `/suggest`, `/suggestions` | `/next` |
| `/copy-mode` | `/select` |
| `/save` | `/export` |
| `/completion` | `/shell-completion` |
| `/quit`, `/q` | `/exit` |

## Account, league, and context overrides

Running `/connect <USERNAME>` validates the Sleeper user, discovers current-season NFL leagues and owned rosters, and persists only the username to `profile.json`. By default, Seb keeps an account-wide view across all discovered leagues (automatically narrowing to one league when you ask about a player you roster in only one league). Use `/league <ID>` to focus a single league, `/league all` or `/league clear` to return to all discovered leagues, or `/leagues <USERNAME> <YEAR>` for historical research.

## Model selection and model families

Inspect or switch your session model at any time without leaving chat:

```text
/provider
/provider anthropic
/model gemini-flash
/model claude-haiku-4-5
```

Entering a **model family** (such as `gemini-flash`, `claude-sonnet`, or `gpt-luna`) resolves the newest stable release in that provider's catalog and shows the resolved ID in the header, whereas an exact ID stays pinned. `/provider <NAME>` preserves that provider's distinct fallback family (`gemini-flash-lite`, `claude-haiku`, or `gpt-mini`), while `/model <MODEL>` uses the selected model as its own fallback for the session. Seb verifies the target model before switching; a successful switch starts a clean model context (clearing prior-model answer evidence while keeping your visible transcript), and a failed check leaves your current model and context untouched. To persist changes or add API keys, run `seb configure` (see [Model selection](MODELS.md)).

## Decision safeguards and automatic gate recovery

For start/sit, full-lineup optimization, waiver, and trade prompts, Seb validates the model's draft recommendation against recorded tool inputs and outputs—checking player identity, active injury/news coverage, scoring-rule support, projection eligibility, fixed-scale waiver scores, and valid single-opponent trade rosters.

- **Auto-bundled newsroom verification**: Decision tools (`compareStartSit`, `optimizeRosterLineup`, `rankWaiverTargets`, and `runWeeklyPortfolioBrief`) automatically run parallel first-class newsroom searches for compared, swapped, injured, and top waiver candidates so most decisions clear the gate in a single tool call.
- **5-minute evidence reuse**: Verified tool evidence from earlier turns in the same session remains reusable for **5 minutes**, allowing natural follow-up questions (`"What if it rains?"` or `"Compare him with my bench RB instead"`) without redundant fetches.
- **Single-retry Decision Gate recovery**: If a draft recommendation misses required verification evidence on the first pass, Seb automatically runs **one targeted recovery turn** (`buildRecommendationRecoveryPrompt`) instructing the agent to execute the missing verification tools before checking the gate again. If evidence is still unavailable, Seb renders `Decision unavailable` with the exact missing requirements.

## Sources and clickable tool inspection

Every tool-backed answer ends with a compact blue summary line (`Evidence: 7 sources · /sources`, respecting `NO_COLOR`). Run `/sources` to view every Sleeper, nflverse, NWS, and publisher URL with its `LIVE`, `CACHED`, or `STALE` status (Seb retains up to 100 sources per answer across 50 answer snapshots per session, and 200 live tracker entries), or `/source <INDEX>` for a single clickable link.

Above each answer, completed tool calls appear as compact **purple tool rows** (grouping consecutive calls to the same tool with a call count and combined duration). Click any purple tool row with your mouse to expand its JSON input and output (capped at 64,000 characters); clicking a grouped row first expands the individual calls with their short IDs and elapsed times so you can inspect any call individually.

## Transcript management, drafts, and session resume

Seb manages long interactive research sessions automatically so multi-turn conversations stay fast and grounded:

- **Context budget, two-pass turn compaction, & pinned working memory**: Each model request includes up to **24** recent messages within a **120,000-character** budget (with individual user prompts capped at 32,000 characters). Seb preserves full, uncompacted tool outputs in up to the **3** most recent turns, compacts older turns into concise `[Verified tool calls in this turn (outputs compacted): ...]` summaries, and folds evicted turns plus noted floor/ceiling preferences, league constraints, tracked players, and `Recommendation:` verdicts into persistent `workingMemory` (`/memory [clear]`).
- **Draft queueing & error recovery**: You can type and edit your next prompt (`Alt+Enter` for newlines, bracketed multiline paste supported) while Seb streams an answer, and press `Enter` to queue it for immediate submission once the active turn finishes (editing the text unqueues it). Pressing `Escape` cancels an active run while preserving your draft and keeping the failed question in context for `"try again"` follow-ups; incomplete answers and unfinished approvals are excluded from future model turns.
- **Copy, native scrollback, & exports**: Drag across visible text to copy on mouse release, run `/copy` or `/copy all`, use `/select` (`/copy-mode`) to dump the transcript into native terminal scrollback, or write Markdown/JSON transcripts to `exports/` with `/export [NAME] [md|json]`.
- **Session boundaries & resume**: Run `/new` (or `/clear`) to reset the model context, pinned working memory, active subject, and skill workflow for a new topic while keeping your Sleeper connection. When you finish and run `/exit` (`/quit`, `/q`, or `Escape` on an empty prompt), Seb saves the session under `~/.config/seb/sessions/` so you can reopen it immediately with bare `seb resume` (or `seb resume <INDEX|QUERY|SESSION_ID>`—see [Setup guide](SETUP.md#resume-a-conversation)).

## Cache, snapshots, telemetry, and DevTools

Manage local SQLite data and inspect performance without leaving chat:

- **Refresh & lineage**: Run `/refresh sleeper`, `/refresh nflverse`, `/refresh weather`, `/refresh news`, or `/refresh all` to clear stale cached rows without deleting historical snapshots, and inspect snapshots with `/cache`, `/snapshots [KIND]`, `/provenance <SNAPSHOT_ID>`, or `/replay [SEASON] [THROUGH_WEEK]`.
- **Session & historical telemetry**: `/usage` and `/stats` default to the active `session` (or accept `today`, `7d`, `30d`, and `all`), reporting logical AI SDK steps, token classes, latency percentiles, and tool outcomes from `.cache/seb.sqlite` without storing prompt/answer text. Use `seb stats prune` or `seb stats clear` from the CLI for retention management (see [Inspect local API usage](CLI.md#inspect-local-api-usage)).
- **Diagnostics & DevTools**: Run `/doctor` or `/doctor --offline` (`/doctor offline`) to check local setup and external services, or `/devtools` to check local `.devtools/` trace recording (`SEB_DEVTOOLS=true`; never enable in production—see [AI SDK integration](AI_SDK.md)).

## Example workflows

| Goal | Example prompt or command |
| --- | --- |
| **Start/sit & lineup check** | `/analyze Optimize my starting lineup for this week, including flex and D/ST.` |
| **Weather risk screening** | `/analyze Which outdoor games have the highest fantasy weather risk this week?` |
| **Player profile & game log** | `/explore Show Justin Jefferson's player profile and 2025 NFL game log.` |
| **Team overview & schedule** | `/explore Show Seattle's team profile, current player records, schedule, and recent results.` |
| **Trade evaluation** | `/analyze Compare Player A for Player B. Show production, usage, roster fit, and risk.` |
| **Cross-league waiver & roster audit** | `/fantasy Rank the top trending adds by recent opportunity and schedule across my leagues.` |
