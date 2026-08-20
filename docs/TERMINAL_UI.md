# Terminal interface guide

Seb `0.0.6` includes a local terminal renderer for interactive research.

The AI SDK still controls the agent message loop and tool transport.

Seb controls prompt editing, screen layout, accessibility, history, and terminal actions.

## Start the interface

Run either command from the project folder.

```bash
seb
npm run seb
```

The home screen shows the current NFL state and the active Seb experience.

Explore covers player, team, league, statistic, schedule, result, and news questions.

My Fantasy uses one optional Sleeper username.

Analyze continues from the active subject with comparison and decision context.

The first prompt shows up to three useful next actions.

The `/new` and `/clear` commands show these actions again.

Press `1`, `2`, or `3` to select one action.

Seb shows each action on a separate footer row.

Seb submits a complete action immediately.

Seb places an action with a placeholder in the editor.

Replace the placeholder before you submit the prompt.

## Edit a prompt

| Key | Action |
| --- | --- |
| `Left` and `Right` | Move the cursor by one character. |
| `Option+Left` and `Option+Right` | Move the cursor by one word. |
| `Ctrl+A` | Move the cursor to the start. |
| `Ctrl+E` | Move the cursor to the end. |
| `Backspace` | Delete the prior character. |
| `Delete` | Delete the next character. |
| `Ctrl+W` | Delete the prior word. |
| `Ctrl+U` | Delete from the cursor to the start. |
| `Alt+Enter` | Insert a new line. |
| `Enter` | Submit the complete prompt. |

Seb enables bracketed paste while the interface runs.

A multiline paste stays inside one prompt.

Seb normalizes Windows line endings in pasted text.

## Use the command palette

Press `Ctrl+K` to open the palette.

You can also type `/` at the start of a prompt.

The palette groups commands into nine categories.

- Essentials
- Explore
- My Fantasy
- Analyze
- Sources
- Conversation
- Preferences
- Advanced
- Diagnostics

The empty palette shows common tasks before advanced tools.

The palette searches command names and descriptions.

It places recent commands before equally relevant commands.

Advanced override commands show their active value when one exists.

The bottom row describes the selected command effect.

A warning symbol identifies a command that clears local state.

Use `Up` and `Down` to change the selection.

Press `Tab` to place the selected value in the editor.

Press `Escape` to close the palette.

Run `/commands SEARCH` when you need the same search in a transcript.

## Use prompt history

Seb saves up to 200 unique prompts on the local computer.

The newest prompt appears first.

Use `Up` and `Down` to read saved prompts.

Press `Ctrl+R` to find a prompt that contains the current editor text.

Run `/history` to show the latest entries.

Run `/history clear` to delete every saved entry.

Seb stores the history at the first applicable path.

1. `SEB_HISTORY_FILE`
2. `SEB_CONFIG_HOME/history.json`
3. `XDG_CONFIG_HOME/seb/history.json`
4. `~/.config/seb/history.json`

The file uses permission mode `0600`.

The parent directory uses permission mode `0700` when Seb creates it.

Set this value to disable disk history.

```dotenv
SEB_HISTORY=false
```

Seb then keeps history only for the current process.

Seb does not save a prompt longer than 16 KiB in history.

Seb keeps prompts in memory when the history file becomes unavailable.

The next prompt screen shows the file error.

Do not place an API key or another secret in a prompt.

## Reuse an answer or prompt

Run `/retry` to submit the latest non-command prompt again.

Run `/edit` to place that prompt in the editor.

Run `/copy` to copy the latest Seb answer.

The copy command uses the terminal OSC 52 clipboard sequence.

The terminal must allow OSC 52 for this action.

Run `/source 1` to show the first validated source link.

Replace `1` with another number from `/sources`.

Seb emits OSC 8 links when the terminal supports terminal links.

Seb makes Markdown links, angle-bracket links, and bare HTTP URLs clickable.

Seb prints a normal URL when terminal links are unavailable.

## Read the header

The first header row shows these values.

- Seb version
- Active experience
- NFL season and week

The following rows show only useful active context.

- Connected Sleeper username and discovered league count
- Focused fantasy league, when one league has focus
- Active NFL player or team
- Latest source state

Seb hides empty league, roster, team, and workflow placeholders.

Source states include `LIVE`, `WEB`, `CACHED 4m`, `2025 STATS`, and `STALE`.

The exact cache age changes as time passes.

Run `/context` for the full context.

Run `/sources` for exact links, retrieval times, and cache outcomes.

## Read analysis presentation

Seb highlights a `Decision` section when the answer includes one.

Seb converts Markdown tables into bordered terminal tables.

Wide NFL stat tables group passing, rushing, receiving, and fantasy fields.

Seb uses labeled record cards when another wide table cannot fit safely.

The renderer keeps every table value in both layouts.

Headings, nested lists, numbered lists, labeled metrics, quotes, and code blocks use distinct terminal styles.

A percentage on a `Confidence` line becomes a ten-cell bar.

A `Win probability` percentage becomes a twenty-cell bar.

Seb renders supported comma-separated series as terminal charts.

Supported series names include these values.

- `Weekly points`
- `Usage trend`
- `Schedule difficulty`

Unicode mode uses block sparklines.

ASCII mode prints the values with arrows.

The chart never creates data.

It only renders values that the answer already contains.

## Read tool progress

Seb shows one animated marker for each active operation.

The operation label states the external action in plain language.

The label also shows elapsed time.

Seb changes a completed operation to one compact row.

Press `Escape` during a request to stop that request.

The session remains open after this action.

Press `Ctrl+C` to stop the request and exit Seb.

Run `/exit`, `/quit`, or `/q` from the prompt to exit Seb.

Use `Page Up` and `Page Down` to scroll the transcript.

Use the mouse wheel or a trackpad gesture to scroll the transcript.

Each wheel event moves one transcript row.

The footer shows when the screen displays earlier transcript rows.

Mouse scrolling does not select an older prompt from history.

Use `Ctrl+L` to repaint the complete screen.

## Select a theme

Run one of these commands.

```text
/theme default
/theme high-contrast
/theme compact
```

The default theme uses the normal Seb colors and spacing.

The high-contrast theme uses brighter text and stronger header contrast.

The compact theme removes blank rows between transcript sections.

Set a startup theme in `.env`.

```dotenv
SEB_THEME=compact
```

Set the `NO_COLOR` environment variable to disable all terminal colors.

Seb also disables colors when `TERM=dumb`.

## Select terminal symbols

Run one of these commands.

```text
/icons unicode
/icons ascii
```

Unicode mode uses block charts and graphical status symbols.

ASCII mode uses portable characters and numeric chart arrows.

Set the startup mode in `.env`.

```dotenv
SEB_ICONS=ascii
```

## Open the shortcut guide

Press `?` when the editor is empty.

You can also run `/shortcuts`.

Press `Escape`, `Enter`, or any character to close the guide.

## Terminal compatibility

Seb needs an interactive terminal for `seb` or `seb chat`.

Use `seb ask` for a pipe, file, automation, or noninteractive shell.

The interface needs a terminal width of at least 40 columns.

Seb uses the alternate screen and restores the normal screen at exit.

It enables bracketed paste only while the interface runs.

OSC 8 and OSC 52 support depends on the terminal application.

The analysis and source URLs remain readable without those features.

## Troubleshoot the interface

If the screen looks incomplete, press `Ctrl+L`.

If symbols look incorrect, run `/icons ascii`.

If colors have low contrast, run `/theme high-contrast`.

If colors remain incorrect, start Seb with `NO_COLOR=1`.

If a paste submits early, confirm that the terminal supports bracketed paste.

If `/copy` does not change the clipboard, enable OSC 52 in the terminal settings.

Run `seb doctor` when a model or data request fails.
