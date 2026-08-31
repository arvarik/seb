# Command-line guide

Seb supports interactive use, one question, standard input, and JSON output.

Use the interactive interface for research. Use one-shot modes for scripts and automation.

## Install the `seb` command

Run these commands once from the project folder.

```bash
npm install
npm link
```

The second command adds a `seb` command to the active Node.js installation.

Verify the command.

```bash
seb --version
seb doctor
```

You can skip `npm link`. Use `npm run seb` and `npm run ask` instead.

## Command summary

| Command | Purpose |
| --- | --- |
| `seb` or `seb chat` | Start interactive chat. |
| `seb ask` | Ask one question or read standard input. |
| `seb setup [USERNAME]` | Validate Gemini and save one optional Sleeper username. |
| `seb doctor` | Verify local configuration and source access. |
| `seb cache` | Inspect or clear the SQLite source cache. |
| `seb snapshots` | List snapshots or inspect snapshot provenance. |
| `seb replay` | Measure the nflverse PPR baseline. |
| `seb completion` | Print a shell completion script. |
| `seb version` | Print the installed Seb version. |

Run `seb COMMAND --help` to return the general command help.

## First-run preferences

Validate Gemini without connecting Sleeper.

```bash
seb setup
```

Setup validates Gemini with one small request.

Add a Sleeper username when you want automatic fantasy context.

```bash
seb setup your-sleeper-name
```

Seb stores only the optional username and update time.

It never stores a league, roster, NFL team, season, week, or API key.

Starting interactive chat without preferences validates Gemini and creates an empty file.

Read the [setup guide](SETUP.md) for profile paths and security rules.

## Install shell completion

Generate a completion script without credentials.

```bash
seb completion zsh
seb completion bash
seb completion fish
```

Install Zsh completion.

```bash
mkdir -p ~/.zfunc
seb completion zsh > ~/.zfunc/_seb
```

Add `~/.zfunc` to `fpath`, and run `compinit` from `~/.zshrc`.

Install Bash completion.

```bash
seb completion bash > ~/.seb-completion.bash
printf '\nsource ~/.seb-completion.bash\n' >> ~/.bashrc
```

Install Fish completion.

```fish
mkdir -p ~/.config/fish/completions
seb completion fish > ~/.config/fish/completions/seb.fish
```

Restart the active shell after a Zsh or Bash installation.

The scripts complete top-level commands and supported options.

## Interactive chat

Start the full terminal interface.

```bash
seb
```

The interface keeps the conversation until you exit. It renders Markdown, automatic context, sources, charts, and data tool activity.

The home screen presents Explore, My Fantasy, and Analyze.

Use these controls.

| Key | Action |
| --- | --- |
| `Enter` | Send the current question. |
| `Ctrl+K` or `/` | Open the command palette. |
| `Up` and `Down` | Select a command or read prompt history. |
| `Tab` | Fill the selected command or argument. |
| `Left` and `Right` | Move the prompt cursor. |
| `Option+Left` and `Option+Right` | Move the cursor by one word. |
| `Alt+Enter` | Insert a new prompt line. |
| `Ctrl+R` | Search private prompt history. |
| `1`, `2`, or `3` | Select a contextual action. |
| `PageUp` and `PageDown` | Scroll one page. |
| Mouse wheel or trackpad | Scroll the transcript. |
| `Ctrl+L` | Repaint the terminal. |
| `Escape` | Close a panel or stop the current request. |
| `Ctrl+C` | Exit Seb. |

The interface animates only active work. It keeps each completed tool on one compact row.

Seb hides model reasoning by default. It shows a compact reasoning card when the provider returns reasoning.

Run `/help` inside the interface. Local commands do not call Gemini.

Run `/connect USERNAME` once to save a Sleeper account.

Seb discovers its current leagues and owned rosters automatically.

Use the [interactive guide](INTERACTIVE.md) for every command and skill.

Use the [terminal interface guide](TERMINAL_UI.md) for editing, themes, history, accessibility, and terminal compatibility.

## Ask one question

Use `ask` when a shell script needs one answer.

```bash
seb ask "Show the current NFL state."
```

Seb streams answer text to standard output. An interactive terminal can show tool activity on standard error.

Seb loads the optional Sleeper username and current NFL state before the request.

Account-aware prompts can use discovered leagues without copied IDs.

Answers end with direct data and web sources when a request uses them.

Direct sources include cache outcomes and retrieval times.

Use this option when you want no tool activity.

```bash
seb ask --no-progress "Show trending player adds."
```

Seb hides tool activity automatically when standard error does not connect to a terminal.

## Decision output

Seb records each executed tool input and result for a direct fantasy decision.

The final gate matches those records to the requested player and selected league.

Start-sit output needs an eligible scoring-aware projection.

Seb buffers the answer until this gate finishes.

If the evidence is incomplete, Seb returns `Decision unavailable` with the missing requirements.

JSON mode applies the same gate after schema validation.

## Read a question from standard input

Seb reads standard input when the command does not contain a question.

```bash
printf 'Show trending player adds.' | seb ask
```

You can also read a saved prompt.

```bash
seb ask < prompt.txt
```

The input limit is 128 KiB. This limit prevents accidental input of a large file.

## Return JSON

Use `--json` for a program that needs a stable output object.

```bash
seb ask --json "Show the current NFL state."
```

The command writes one compact JSON object to standard output.

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

The token values can be `null` when a provider does not return usage data.

Each source can include a cache outcome, retrieval time, and refresh error.

The `analysis` object follows schema version 1.

Seb validates this object before it writes any JSON.

JSON mode uses one research request and one tool-free formatter request.

The reported token use includes both requests.

Web source URLs stay in the separate `sources` array.

Use the linked command for clean JSON. The standard npm command prints its own status lines.

If you do not use `npm link`, add the npm silent option.

```bash
npm --silent run ask -- --json "Show the current NFL state."
```

This example selects one field with `jq`.

```bash
seb ask --json "Show the current NFL state." | jq -r .answer
```

Select a recommendation or confidence score.

```bash
seb ask --json "Should I start Player A?" | jq -r .analysis.recommendation.action
seb ask --json "Compare these teams." | jq .analysis.confidence.score
```

Read the [AI SDK guide](AI_SDK.md) for the complete analysis contract.

## Run diagnostics

Run the doctor after setup or after a credential change.

```bash
seb doctor
```

The doctor performs these checks.

1. It verifies Node.js 22 or newer.
2. It verifies that the Gemini key exists.
3. It opens SQLite and reports the schema and record counts.
4. It reads the current Sleeper NFL state.
5. It loads the nflverse schedule.
6. It loads one NWS hourly forecast.
7. It sends one small Gemini test request.

Use the offline option when the computer has no network access.

```bash
seb doctor --offline
```

Use JSON for an installation script.

```bash
seb doctor --json
```

The doctor never prints the Gemini key.

## Inspect the local cache

Show the database path, byte sizes, and record counts.

```bash
seb cache
seb cache status
seb cache status --json
```

Text output names `Canonical identities` and `Identity source links`.

JSON output uses the `identities` and `identityLinks` fields.

Clear source cache entries.

```bash
seb cache clear
seb cache clear --json
```

The clear command preserves every historical snapshot.

Delete expired cache rows and old snapshots.

```bash
seb cache prune
seb cache prune --max-size-mb 256 --max-age-days 90 --retain 8
seb cache prune --json
```

The prune command checkpoints the write-ahead log and compacts the database.

Read the [storage guide](STORAGE.md) for source freshness periods.

## Inspect source snapshots

List the latest 20 snapshots.

```bash
seb snapshots
```

Filter and increase the result limit.

```bash
seb snapshots --kind nflverse-player-stats --limit 100
seb snapshots --entity player-stats-v1-2025 --json
```

The result limit must use `1` through `1000`.

Inspect one snapshot's provenance summary.

```bash
seb snapshots --id SNAPSHOT_ID
```

Return the complete stored provenance manifest.

```bash
seb snapshots --id SNAPSHOT_ID --json
```

The JSON inspection omits the source payload.

List commands read only snapshot metadata and byte sizes.

Read the [provenance guide](PROVENANCE.md) for field lineage rules.

## Run a historical replay

Run the default PPR baseline through Week 18.

```bash
seb replay --season 2025
```

Select the final week and positions.

```bash
seb replay --season 2025 --through-week 10 --position QB,RB,WR,TE
```

Save the complete report and print compact JSON.

```bash
seb replay --season 2025 --output exports/replay-2025.json --json
```

The season is required.

The final week must use `2` through `18`.

The position list accepts `QB`, `RB`, `WR`, `TE`, and `K`.

Read the [evaluation guide](EVALUATION.md) before you compare two reports.

## Select a model

Set the default models in `.env`.

```dotenv
GEMINI_MODEL=gemini-3.7-flash
GEMINI_FALLBACK_MODEL=gemini-3.6-flash
```

Override the model for one command.

```bash
seb ask --model gemini-3.7-flash "Show the current NFL state."
seb chat --model gemini-3.7-flash
```

An explicit model disables the fallback for that command. This behavior makes experiments repeatable.

One-shot mode retries a capacity or rate-limit failure before it prints answer text.

JSON mode can also use this fallback before it prints the output object.

Interactive mode uses the selected primary model for the session. Restart with `--model` when that model has no capacity or quota.

## Output and exit guarantees

Seb keeps answer data on standard output. It writes progress, retry notices, and errors to standard error.

Seb returns these exit codes.

| Code | Meaning |
| --- | --- |
| `0` | The command completed successfully. |
| `1` | A configuration, network, provider, or diagnostic check failed. |
| `2` | The command syntax or input was invalid. |

Seb stops without an error when the next pipe closes early. This behavior supports commands such as `head`.

## Show help

```bash
seb --help
```

The old direct-question form remains valid.

```bash
npm run ask -- "Show the current NFL state."
```

## Remove the linked command

Run this command from the project folder.

```bash
npm unlink -g seb
```
