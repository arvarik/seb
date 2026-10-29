# Command-Line Guide

[Documentation Hub](README.md) · [Setup Guide](SETUP.md) · [Interactive Guide](INTERACTIVE.md) · [Terminal UI](TERMINAL_UI.md)

Seb supports rich interactive terminal research alongside scriptable one-shot prompts, standard input pipes, schema-validated JSON output, session resume, local telemetry, and forecasting benchmarks.

## Install the `seb` command

Install the published CLI globally from npm, or invoke it directly via `npx` without a global install:

```bash
npm install -g @arvarik/seb
seb --version

# Or run on demand:
npx @arvarik/seb doctor
```

When working from a source checkout, install locked dependencies with `npm ci` and link the binary into your active Node.js environment (use `npm unlink -g seb` later if you want to remove the global link, or run `npm run seb` / `npm run ask` directly):

```bash
npm ci
npm link
seb doctor
```

## Command summary

| Command | Purpose |
| --- | --- |
| `seb` or `seb chat` | Launch the interactive terminal interface. |
| `seb ask [PROMPT]` | Answer one question from arguments or standard input (`--json`, `--no-progress`). |
| `seb resume <SESSION_ID>` | Resume a saved interactive conversation by session ID. |
| `seb sessions` | List saved interactive conversations and their opening questions. |
| `seb configure` | Run interactive provider/settings setup or import a dotenv file (`--import-env <FILE>`). |
| `seb setup [USERNAME]` | Initialize account preferences or save an optional Sleeper username. |
| `seb doctor` | Run all 9 local and network health checks (`--offline`, `--json`). |
| `seb cache` | Inspect, clear, or prune the SQLite source cache and view record/telemetry counts. |
| `seb snapshots` | List stored source snapshots or inspect field-level provenance manifests. |
| `seb replay` | Run leakage-free historical PPR baseline replays across completed NFL weeks. |
| `seb learn` | Inspect or update adaptive local forecast learning from completed weeks. |
| `seb evaluate` | Benchmark legacy, ensemble, and adaptive forecast models on historical seasons. |
| `seb usage` | Display a concise local model and token usage summary (`today`, `7d`, `30d`, `all`). |
| `seb stats` | Display detailed latency, token, model, and tool telemetry or prune/clear records. |
| `seb connectors` | Start the HTTP webhook/bot service for Slack, Discord, Telegram, and GroupMe. |
| `seb completion <SHELL>` | Print a `zsh`, `bash`, or `fish` completion script. |
| `seb version` | Print the installed Seb version. |

Run `seb <COMMAND> --help` (or `-h`) for command-specific flags. Options with values accept both `--option value` and `--option=value` (for example, `seb evaluate --season=2025`), and `--` separates flags from literal prompt text that starts with a hyphen. Pressing `Ctrl+C` cancels an in-flight one-shot request cleanly; if output is truncated, Seb appends an explicit warning and withholds incomplete fantasy recommendations.

## Configure providers, settings, and Sleeper (`seb configure`, `seb setup`)

Run `seb configure` in an interactive terminal to configure a hosted provider (Google Gemini, Anthropic, or OpenAI), verify an OpenAI-compatible endpoint, edit saved settings by category, or import a dotenv file:

```bash
seb configure
seb configure --import-env /absolute/path/to/.env
```

Secret prompts mask typed keys and never record them in prompt history. During OpenAI-compatible setup, Seb queries `GET /models` without following HTTP redirects, asks for confirmation before contacting a non-loopback origin, lists up to 25 discovered models (with manual entry fallback), and verifies streaming plus tool calling over a 30-second test before writing `~/.config/seb/credentials.json` and `~/.config/seb/model-settings.json` (`0600` permissions). See [Persistent configuration](CONFIGURATION.md) and [Local configuration paths and security](SETUP.md#local-configuration-paths-and-security) for storage overrides.

To connect your optional Sleeper account for automatic league and roster discovery (or initialize an empty profile without Sleeper), run `seb setup`:

```bash
seb setup your-sleeper-name
seb setup
```

## Interactive chat (`seb`, `seb chat`)

Run `seb` to open the full-screen terminal interface with live Markdown tables, sparklines, automatic NFL/Sleeper context, clickable tool details, and source provenance:

```bash
seb
```

| Key | Action |
| --- | --- |
| `Enter` | Submit the current prompt, or execute/expand a staged contextual action. |
| `Ctrl+K` or `/` | Open the categorized slash-command palette. |
| `Ctrl+G` | Open the active context selector (league, roster, week, player, team). |
| `Up` / `Down` | Navigate palette suggestions or browse saved prompt history. |
| `Tab` or `Right Arrow` | Fill the selected slash command or argument completion. |
| `Left` / `Right` | Move the prompt cursor by one character. |
| `Option+Left` / `Option+Right` | Move the prompt cursor by one word. |
| `Home` / `End` (`Ctrl+A` / `Ctrl+E`) | Jump to the start or end of the current line. |
| `Alt+Enter` | Insert a newline inside a multiline prompt. |
| `Ctrl+R` | Reverse-search private prompt history. |
| `1`, `2`, or `3` | Stage a numbered contextual action (`Enter` runs or expands it). |
| `PageUp` / `PageDown`, mouse wheel | Scroll the conversation transcript. |
| `Ctrl+L` | Repaint the entire terminal display. |
| `Escape` | Close an open palette/panel, cancel an active run, or exit on an empty prompt. |
| `Ctrl+C` | Stop active work and exit Seb immediately. |

See the [Interactive guide](INTERACTIVE.md) and [Terminal interface guide](TERMINAL_UI.md) for every slash command, theme, and selection shortcut.

## Resume and list sessions (`seb sessions`, `seb resume`)

When you exit interactive chat with `/exit`, Seb saves your conversation snapshot to `~/.config/seb/sessions/` (`0600` permissions) and prints the exact command to pick up where you left off:

```bash
seb sessions
seb resume seb-00000000-0000-0000-0000-000000000000
```

`seb sessions` lists available snapshots with their session IDs and opening questions (skipping any damaged files), while `seb resume <SESSION_ID>` restores your prior turns, verified tool outputs, source snapshots, and active player/team/skill/league focus against the current NFL state and connected Sleeper account. Set `SEB_SESSIONS=false` to disable session snapshots, or `SEB_HISTORY=false` to disable both prompt history and session saving.

## One-shot queries, stdin pipes, and JSON (`seb ask`)

Use `seb ask` in scripts, shell pipelines, and automation workflows:

```bash
seb ask "Show the current NFL state."
seb ask --no-progress "Show trending player adds."
printf 'Show trending player adds.' | seb ask
seb ask < prompt.txt
```

Seb streams the Markdown answer to `stdout` and writes live tool progress to `stderr` only when `stderr` is attached to a TTY (or suppress it explicitly with `--no-progress`). Standard input prompts are capped at **128 KiB** to guard against accidental binary or log-file redirection.

### Decision Gate verification

Whenever a prompt asks for a direct fantasy action (start/sit, lineup optimization, waiver pickup, or trade verdict), Seb buffers output until its Decision Gate verifies that executed tool inputs and outputs cover every named player, resolved identity, current injury/news status, and active league scoring rule. If required evidence is missing or a scoring rule is unsupported, Seb withholds the action and returns `Decision unavailable` listing the exact missing requirements.

### Structured JSON output (`--json`)

Pass `--json` to emit a single schema-validated JSON object on `stdout`:

```bash
seb ask --json "Show the current NFL state."
```

```json
{
  "analysis": {
    "schemaVersion": 1,
    "kind": "general",
    "subject": "Current NFL state",
    "summary": "Sleeper reports the 2026 preseason.",
    "recommendation": null,
    "confidence": {
      "level": "high",
      "score": 0.98,
      "rationale": "Sleeper returned the current league state."
    },
    "metrics": [],
    "strengths": [],
    "weaknesses": [],
    "risks": [],
    "assumptions": [],
    "limitations": []
  },
  "answer": "# Current NFL state\n\nSleeper reports the 2026 preseason.",
  "fallbackUsed": false,
  "finishReason": "stop",
  "generatedAt": "2026-08-20T12:00:02.000Z",
  "model": "gemini-3.7-flash",
  "recommendationEligibility": {
    "outcome": "allowed",
    "reasons": []
  },
  "sources": [
    {
      "accessedAt": "2026-08-20T12:00:01.000Z",
      "cacheOutcome": "source-updated",
      "id": "sleeper-state-nfl",
      "label": "Sleeper read-only API",
      "retrievedAt": "2026-08-20T12:00:00.000Z",
      "url": "https://api.sleeper.app/v1/state/nfl"
    }
  ],
  "toolCalls": ["getNflState"],
  "usage": {
    "inputTokens": 1050,
    "outputTokens": 32
  }
}
```

JSON mode runs one tool-enabled research pass followed by a tool-free structured formatter pass (`usage` sums both calls; token fields are `null` if the provider omits them), validates `analysis` (`schemaVersion: 1`), and attaches `recommendationEligibility` alongside validated `sources`. See the [AI SDK guide](AI_SDK.md) for the full schema contract.

> [!TIP]
> Pipe `seb ask --json` directly into `jq`—for example, `seb ask --json "Compare these teams." | jq .analysis.confidence.score`. If running through `npm` without a global binary, add `--silent` (`npm --silent run ask -- --json "..."`) so npm banner lines do not pollute `stdout`.

## Inspect local API usage

Seb records privacy-safe operational telemetry in `.cache/seb.sqlite`—tracking timestamps, models, token classes, latencies, and tool outcomes while **never** storing prompts, answers, tool payloads, API keys, or raw error messages.

```bash
seb usage               # Concise report (defaults to 'today' since local midnight)
seb stats               # Detailed analytics (defaults to rolling '7d')
seb usage 30d --json    # Supported windows: today, 7d, 30d, all (up to 10,000 newest runs)
seb stats all --json
```

- **`seb usage`** summarizes agent run outcomes, successful completion rate (`stop` vs. `stop + failed`, excluding cancellations, approval pauses, and active/unfinished runs), post-tool failures, logical AI SDK model steps, token breakdowns (input, cache-read, cache-write, text, reasoning, provider tool-use, plus separate SDK-normalized and provider-reported totals), and client/provider tool counts.
- **`seb stats`** adds per-run call distributions, latency percentiles (`avg`, `p50`, `p90`, `p95`, `max`), time-to-first-output, provider/model/service-tier/finish-reason breakdowns, per-tool durations and repeat counts, daily rollups, and missing/conflicting telemetry quality counters.

Missing provider token fields stay reported as unavailable rather than `0`, ratios (`calls`, `reported`, `value`) compute only over calls reporting both numerator and denominator, and safe-integer overflows set `sum: null` with `dataQuality.overflowedAggregates: true`. Both `--json` outputs follow `schemaVersion: 1` (`source: "seb-local-telemetry"`). Tool call outcomes classify each invocation as `returned`, `error`, `invalid`, `cancelled`, or `unresolved`.

Manage local telemetry retention without touching source caches, snapshots, or canonical identities:

```bash
seb stats prune --retain-days 30         # Default retains 90 days of finished runs
seb stats clear                          # Clears finished telemetry runs
seb stats clear --include-unfinished     # Also clears stale unfinished rows (stop other Seb processes first)
```

## Run diagnostics (`seb doctor`)

Run `seb doctor` after installation or configuration changes to verify all **9** system and source checks:

```bash
seb doctor
seb doctor --offline
seb doctor --json
```

1. **Node.js runtime** — Verifies Node.js 22+.
2. **Environment configuration** — Checks provider configuration, keys, and settings validity.
3. **Local SQLite cache** — Verifies `.cache/seb.sqlite` schema and record counts.
4. **Local file permissions** — Audits `~/.config/seb` directory (`0700`) and file (`0600`) modes.
5. **Local forecast learning** — Validates stored adaptive forecast parameters.
6. **Active model provider** — Runs a live tool-calling verification loop (plus grounded Google Search URL check on Google).
7. **Sleeper public API** — Reads live NFL state.
8. **nflverse public files** — Checks schedule and weekly stats endpoints.
9. **National Weather Service API** — Checks stadium forecast availability.

`seb doctor` never prints secret keys to output or JSON.

## Inspect cache and source snapshots (`seb cache`, `seb snapshots`)

Inspect `.cache/seb.sqlite` sizes, cached source rows, historical snapshots, canonical identity mappings (`identities` and `identityLinks`), and **local usage telemetry counts** (recorded agent runs, model calls, and tool calls):

```bash
seb cache status
seb cache status --json
seb cache clear                          # Clears cached source entries while preserving snapshots
seb cache prune --max-size-mb 256 --max-age-days 90 --retain 8
```

`seb cache prune` removes expired cache entries and old excess snapshots, checkpoints the SQLite WAL, and compacts the database file.

To audit stored source snapshots and field-level lineage (`1`–`1000` rows per query; JSON omits raw source payloads for fast inspection):

```bash
seb snapshots
seb snapshots --kind nflverse-player-stats --limit 100
seb snapshots --id <SNAPSHOT_ID> --json
```

See [Storage](STORAGE.md) and [Provenance](PROVENANCE.md) for retention rules and lineage manifests.

## Historical replay, forecast learning, and evaluation (`seb replay`, `seb learn`, `seb evaluate`)

All three forecasting benchmark commands run locally against nflverse and Sleeper scoring rules with **zero language-model calls**, and all support `--json`:

```bash
# Leakage-free nflverse PPR baseline replay (weeks 2..18; positions QB,RB,WR,TE,K)
seb replay --season 2025 --through-week 10 --position QB,RB,WR,TE
seb replay --season 2025 --output exports/replay-2025.json --json

# Inspect or update validated local forecast learning after completed weeks
seb learn status --season 2025
seb learn update --season 2025 --league <LEAGUE_ID>

# Compare legacy, ensemble, and adaptive forecast models across a season
seb evaluate --season 2025 --json
```

Read [Evaluation](EVALUATION.md) and [Analysis and learning](ANALYSIS.md) for temporal cutoff guarantees, validation gates, and scoring profiles.

## Select a model (`--provider`, `--model`) and shell completion

Override the configured provider (`-p` / `--provider`) or model (`-m` / `--model`, including `provider:model` syntax) for a single command:

```bash
seb ask --provider anthropic "Show the current NFL state."
seb ask --model gemini-flash "Show the current NFL state."
seb chat -p openai -m gpt-luna
```

Passing `--provider` alone preserves that provider's configured or default fallback model, whereas passing `--model` pins that model as its own fallback for repeatable runs. Overall resolution follows: explicit CLI flags > `SEB_MODEL_PROVIDER` / `SEB_MODEL` / `SEB_FALLBACK_MODEL` > provider-specific env vars (`GEMINI_*`, `ANTHROPIC_*`, `OPENAI_*`, `OPENAI_COMPATIBLE_*`) > saved `model-settings.json` > hosted defaults (`google` -> `anthropic` -> `openai` -> `openai-compatible`). See [Model selection](MODELS.md) for details.

Generate shell completion scripts anytime without credentials (`seb completion zsh`, `seb completion bash`, or `seb completion fish`); see [Setup guide](SETUP.md#shell-completion) for one-line shell profile setup.

## Output streams and exit codes

Seb writes answer text and `--json` payloads exclusively to `stdout`, keeping progress indicators, fallback notices, and errors on `stderr`. Early downstream pipe closure (such as piping to `head`) exits cleanly without raising a broken-pipe error.

| Exit code | Meaning |
| --- | --- |
| `0` | Command succeeded. |
| `1` | Configuration, network, model provider, or diagnostic check failed. |
| `2` | Invalid CLI syntax, unknown flag, or malformed input. |
