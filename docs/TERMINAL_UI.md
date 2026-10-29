# Terminal Interface Guide

[Documentation Hub](README.md) · [Interactive Guide](INTERACTIVE.md) · [CLI Guide](CLI.md) · [Experience Model](EXPERIENCES.md)

Seb includes a purpose-built terminal renderer for interactive NFL research and fantasy analysis. Built directly on the public AI SDK transport contract, the renderer owns prompt editing, layout, clickable tool and reasoning inspection, responsive stat tables, accessibility themes, and clipboard integration.

## Home screen, header, and contextual suggestions

Start the interface with `seb` (or `npm run seb` from a source checkout). Seb switches cleanly into the terminal's alternate screen buffer, enables bracketed paste, and restores your normal screen on exit.

### Reading the header

The top header surfaces live session state while hiding empty placeholders:

- **Seb version** and **current NFL season, phase, and display week**.
- **Active resolved model ID** (for example, the concrete version resolved from a model family such as `gemini-flash`).
- **Sleeper connection badge** showing `@user · N LEAGUES` when connected (with your two most urgent fantasy actions surfaced on the home screen), or `SLEEPER NOT CONNECTED`.
- **Active context overrides** when present: `FOCUS` (focused league), `ROSTER`, `PLAYER`, `TEAM`, and `WORKFLOW` (selected skill), alongside the latest source freshness badge (`LIVE`, `WEB`, `CACHED 4m`, `2025 STATS`, or `STALE`).

### Using numbered contextual suggestions

Seb displays up to three numbered next-step suggestions (`1`, `2`, `3`) on the home screen and whenever you run `/explore`, `/fantasy`, `/analyze`, `/skill`, `/next`, or `/new`.

1. Press **`1`**, **`2`**, or **`3`** on an empty prompt to **stage** that suggestion in the editor.
2. Press **`Enter`** to execute a complete suggestion immediately—or fill in any placeholder text in the editor first and then press `Enter`.

## Prompt editing and keyboard navigation

| Key | Action |
| --- | --- |
| `Left` / `Right` | Move the cursor by one character (or complete a slash command at end-of-line with `Right`). |
| `Option+Left` / `Option+Right` | Move the cursor by one word. |
| `Home` / `End` (or `Ctrl+A` / `Ctrl+E`) | Jump to the start or end of the current line. |
| `Backspace` / `Delete` | Delete the character before or after the cursor. |
| `Ctrl+W` / `Ctrl+U` | Delete the previous word, or delete from the cursor to the start of the line. |
| `Alt+Enter` | Insert a newline inside a multiline prompt. |
| `Enter` | Submit the prompt (or queue a draft while a response is streaming). |
| `Up` / `Down` | Browse saved prompt history or move through open menu items. |
| `Ctrl+R` | Search saved prompt history matching the current editor text. |
| `PageUp` / `PageDown`, mouse wheel | Scroll the transcript (3 lines per wheel tick, batched at 60 fps). |
| `Ctrl+L` | Force a full-screen repaint. |
| `?` (on empty prompt) or `/shortcuts` | Open the keyboard shortcut overlay (press any key or `Escape` to close). |
| `Escape` | Close an open palette/panel, cancel an active request, or exit Seb on an empty prompt. |
| `Ctrl+C` | Cancel any active request and exit Seb immediately. |

Bracketed paste keeps multiline pastes inside a single prompt and normalizes Windows (`\r\n`) line endings automatically.

## Command palette and context selector

- **Command palette (`Ctrl+K` or `/`)**: Searches command names and descriptions across nine groups (**Essentials**, **Explore**, **My Fantasy**, **Analyze**, **Sources**, **Conversation**, **Preferences**, **Advanced**, and **Diagnostics**), prioritizing recently used commands, displaying active override values, and marking state-clearing commands with a warning glyph. Navigate with `Up`/`Down`, press **`Tab`** or **`Right Arrow`** to accept the highlighted command or argument completion into the editor, and press `Enter` to run or `Escape` to dismiss.
- **Active context selector (`Ctrl+G`)**: Opens a compact selector for **league**, **roster**, **week**, **player**, and **team** using discovered account values. Use `Up`/`Down` to pick a field, `Left`/`Right` to cycle values, and `Enter` to apply.

## Inspecting tool and reasoning rows

During a model turn, active external lookups show a single animated status marker with plain-language labels and elapsed time. Once completed, tool calls and model reasoning collapse into compact, clickable rows so answers stay easy to scan:

- **Click purple tool rows**: Click any completed purple tool row to expand its JSON input and output details in place; click again to collapse. Each expanded detail view caps output at **64,000 characters** and labels any shortened payload explicitly.
- **Expand grouped tool calls**: Consecutive successful calls to the same tool combine into one grouped summary row showing call count and total duration. Clicking a grouped row first expands it into individual call rows (each with its short call ID and elapsed time), and clicking any individual call toggles its input and result.
- **Click reasoning cards**: When a provider returns model reasoning, Seb keeps reasoning collapsed into a compact card by default—click the reasoning row to expand or collapse the full reasoning trace.
- **Compact evidence footer**: Every sourced answer ends with a single blue `Evidence:` summary line pointing to `/sources` (copy and `/export` commands preserve the full evidence listing).

## Analysis tables, bars, and sparklines

Seb formats structured Markdown answers for terminal readability without inventing or altering model values:

- **Responsive tables & record cards**: Standard Markdown tables render with clean borders, wide NFL stat tables group passing, rushing, receiving, and fantasy columns, and tables too wide for the current viewport automatically reflow into labeled record cards so no column is dropped. Long answers open directly at the highlighted `Decision` section or main heading (`Page Down` scrolls onward).
- **Progress bars & sparklines**: `Confidence` percentages render as 10-cell bars and `Win probability` percentages as 20-cell bars. Supported comma-separated series (`Weekly points`, `Usage trend`, and `Schedule difficulty`) render as Unicode block sparklines—or numeric arrow sequences when `/icons ascii` is active.

## Selection, clipboard, links, and prompt history

- **Drag-to-copy & `/copy`**: Drag across visible transcript cells (holding near the top/bottom edge or scrolling the wheel mid-drag to span multiple screens) to highlight text and copy automatically on mouse release. You can also run `/copy` for the latest answer, `/copy all` for the full conversation (using both the local OS clipboard and OSC 52), or `/select` (`/copy-mode`) to print the conversation into native terminal scrollback (`Escape` returns to Seb).
- **Clickable links**: Markdown links, `<https://...>` links, bare URLs, and `/source <INDEX>` outputs emit clickable OSC 8 hyperlinks in supported terminals and fall back to plain readable URLs elsewhere.
- **Private prompt history**: Seb stores up to 200 unique prompts (each up to 16 KiB) with `0600` permissions at `SEB_HISTORY_FILE`, `$SEB_CONFIG_HOME/history.json`, `$XDG_CONFIG_HOME/seb/history.json`, or `~/.config/seb/history.json` (`0700` on newly created parent folders). Set `SEB_HISTORY=false` to keep prompt history in memory only (and disable session snapshot saving); never paste API keys into chat prompts.

## Themes, symbols, and troubleshooting

Switch visual styles live in chat or persist defaults via `seb configure` / environment variables:

```text
/theme default
/theme high-contrast    # Alias: /theme contrast
/theme compact
/icons unicode
/icons ascii
```

Set `SEB_THEME=compact` (or `high-contrast`) and `SEB_ICONS=ascii` for startup defaults, or export `NO_COLOR=1` (also honored automatically when `TERM=dumb`) to disable all ANSI color output. Note that interactive mode requires a TTY at least **40 columns** wide; use `seb ask` for narrower environments, pipes, or CI scripts.

> [!TIP]
> **Quick display fixes**: Press `Ctrl+L` if terminal output looks garbled after a window resize, switch to `/icons ascii` if box/sparkline glyphs render poorly in a remote font, use `/theme contrast` (or `NO_COLOR=1`) for legibility, enable OSC 52 in your terminal preferences if `/copy` cannot reach a remote clipboard, or run `/select` for native terminal copy mode.
