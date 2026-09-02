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
| `seb configure` | Configure and verify one model provider through private prompts. |
| `seb setup [USERNAME]` | Save one optional Sleeper username. |
| `seb doctor` | Verify local configuration and source access. |
| `seb cache` | Inspect or clear the SQLite source cache. |
| `seb snapshots` | List snapshots or inspect snapshot provenance. |
| `seb replay` | Measure the nflverse PPR baseline. |
| `seb usage` | Show concise local model API usage. |
| `seb stats` | Show detailed local model and tool analytics. |
| `seb completion` | Print a shell completion script. |
| `seb version` | Print the installed Seb version. |

Run `seb COMMAND --help` to return the general command help.

## Configure a model provider

Run the private configuration flow from a terminal.

```bash
seb configure
```

Seb lists Google Gemini, Anthropic, OpenAI, and OpenAI-compatible providers.

It masks each typed key and does not add the key to prompt history.

Google, Anthropic, and OpenAI require a key. An OpenAI-compatible key is optional.

The compatible flow asks for a base URL and reads `GET /models` without following redirects.

It sends the optional compatible key to that endpoint for model discovery.

The flow asks for approval before it sends data to a remote compatible origin.

It lists up to 25 discovered models. A failed discovery permits manual model entry.

Seb tests the selected provider for 30 seconds. It saves the configuration only after a successful test.

The default paths are `~/.config/seb/credentials.json` and `~/.config/seb/model-settings.json`.

The credential file stores keys. The model settings file stores no keys.

Both files use mode `0600` on Unix systems. Read the [setup guide](SETUP.md#local-configuration-paths-and-security) for path overrides.

## Account preferences

Create an account profile without connecting Sleeper.

```bash
seb setup
```

Add a Sleeper username when you want automatic fantasy context.

```bash
seb setup your-sleeper-name
```

The account profile stores only the optional username and update time.

It never stores a league, roster, NFL team, season, week, or provider key.

Starting interactive chat without account preferences creates an empty file.

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

Run `/help` inside the interface. Most local commands do not call a model provider.

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

## Inspect local API usage

Show a concise report for today.

```bash
seb usage
```

Show detailed analytics for the latest seven days.

```bash
seb stats
```

Select another saved range.

```bash
seb usage 7d
seb usage 30d --json
seb stats today
seb stats all --json
```

`seb usage` defaults to `today`. `seb stats` defaults to `7d`.

The `today` range starts at local midnight. The `7d` and `30d` ranges use rolling clock time.

The `all` range removes the time filter. Each report reads the 10,000 newest matching runs at most.

Each range includes its start time and excludes its end time. Seb filters runs by their start time.

The concise usage report shows these values.

- Agent run outcomes.
- The successful run rate and safe error categories.
- Failures that occur after a client tool returns.
- Logical model calls.
- Input, cache, output, reasoning, tool-use, and total tokens.
- Client and provider tool-call counts.
- Model names and cache-read share when Seb has those values.

The detailed stats report adds these values.

- Model calls and tool calls per run.
- Average, p50, p90, p95, and maximum latency.
- Time to first output and complete model-step time.
- Model, provider, service-tier, and finish-reason groups.
- Tool names, execution locations, outcomes, durations, and repeated calls.
- Daily runs, model calls, tool calls, and token totals.
- Missing, conflicting, or truncated telemetry counts.

Seb uses one logical model call for each AI SDK model step.

The successful run rate counts agent runs that end with `stop` against those runs plus failed runs.

It excludes approval pauses, cancellations, and unfinished runs. It does not measure completed user answers.

The provider can retry an HTTP request inside that step. Seb cannot see those provider HTTP retries.

Token classes include non-cached input, cache-read input, cache-write input, text output, reasoning output, and provider tool use.

Some providers omit a token class. Seb reports that metric as unavailable instead of zero.

The AI SDK total uses the SDK normalized total. The provider total uses the provider's independent total when available.

These totals can differ. Seb keeps both values and never substitutes one for the other.

JSON aggregate metrics include `calls`, `reported`, and `sum`. Model groups, daily totals, and cumulative client duration use the same coverage fields.

An aggregate that exceeds the safe JSON number range uses `sum: null`. The report also sets `dataQuality.overflowedAggregates` to `true`.

Text reports label that value as an overflow. They do not present it as missing provider data.

JSON ratios include `calls`, `reported`, and `value`. Seb calculates each value from calls that report both required token fields.

An unfinished run has no terminal lifecycle event. The run can still be active, or an earlier Seb process can have stopped unexpectedly.

Tool outcomes use these meanings.

| Outcome | Meaning |
| --- | --- |
| `returned` | The client or provider returned a tool result. Seb does not verify its domain meaning. |
| `error` | Tool execution returned an error. |
| `invalid` | The model produced an invalid tool call. |
| `cancelled` | The caller stopped the tool call. |
| `unresolved` | Seb observed a tool call without a final result. |

A repeated call is each extra call with the same tool name in one run. Seb does not compare tool input.

Client duration covers local tool execution. Provider tools do not expose the same local duration.

Cumulative tool duration is not wall time. Parallel calls can make cumulative duration larger than wall time.

The cumulative duration reports coverage. It never treats an unavailable duration as zero.

Use JSON for scripts.

```bash
seb usage --json
seb stats --json
```

Both report objects use `schemaVersion: 1` and `source: "seb-local-telemetry"`.

Seb keeps field names stable within schema version 1. A breaking field change requires a later schema version.

The reports cover only Seb calls in the active local database.

They do not show Google account quota, credits, billing totals, or currency cost.

The analytics tables store identifiers, timestamps, numeric metrics, and bounded categories.

They do not store prompts, answers, tool inputs, tool results, or raw errors.

AI SDK DevTools uses a separate store with different privacy rules.

Remove old local telemetry while you keep recent records.

```bash
seb stats prune
seb stats prune --retain-days 30
seb stats prune --retain-days 30 --json
seb stats prune --retain-days 30 --include-unfinished
```

The default prune keeps 90 days. It deletes older finished runs and their child records.

The default command preserves unfinished runs. An unfinished run can still belong to another Seb process.

Stop every other Seb process before you use `--include-unfinished`.

An active recorder can recreate its run after this command deletes the row.

Remove all saved usage telemetry.

```bash
seb stats clear
seb stats clear --json
seb stats clear --include-unfinished
```

The default clear command preserves unfinished runs. Use `--include-unfinished` to delete the current unfinished rows too.

Stop every other Seb process first. An active recorder can recreate its run after deletion.

An interrupted process can leave an unfinished run. The explicit option removes these stale records.

These retention commands act immediately. They do not delete source caches, snapshots, or identities.

Read the [storage guide](STORAGE.md) for the SQLite schema and deletion rules.

## Run diagnostics

Run the doctor after setup or after a credential change.

```bash
seb doctor
```

The doctor performs these checks.

1. It verifies Node.js 22 or newer.
2. It verifies the selected provider key or compatible endpoint.
3. It opens SQLite and reports the schema and record counts.
4. It reads the current Sleeper NFL state.
5. It loads the nflverse schedule.
6. It loads one NWS hourly forecast.
7. It forces the selected provider through one local tool loop.

The Google check also requires one valid grounded Google Search URL.

The report names these checks `Model provider key` and `Model provider API`.

Use the offline option when the computer has no network access.

```bash
seb doctor --offline
```

Use JSON for an installation script.

```bash
seb doctor --json
```

The doctor never prints a provider key.

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

Select a configured provider for one command.

```bash
seb ask --provider anthropic "Show the current NFL state."
seb chat -p openai
```

The provider must equal `google`, `anthropic`, `openai`, or `openai-compatible`.

Override the model for one command.

```bash
seb ask --model gemini-3.7-flash "Show the current NFL state."
seb chat --model gemini-3.7-flash
```

`-p` is the short form of `--provider`. `-m` is the short form of `--model`.

An explicit CLI model uses that model as its own fallback. This rule makes one-run experiments repeatable.

An explicit `--provider` without `--model` keeps that provider's configured fallback.

Seb resolves the provider in this order.

1. An explicit `--provider` value.
2. The provider from a qualified `--model` value.
3. `SEB_MODEL_PROVIDER` or the older `SEB_PROVIDER` alias.
4. The provider from a qualified `SEB_MODEL` value.
5. The active provider in `model-settings.json`.
6. The first configured provider in this order: Google, Anthropic, OpenAI, then OpenAI-compatible.

A qualified model uses `provider:model`.

Seb resolves the primary model in this order.

1. An explicit `--model` value.
2. `SEB_MODEL`.
3. The active provider-specific model variable.
4. Saved model settings.
5. The hosted provider default.

Seb resolves the fallback in this order.

1. The explicit `--model` value, when present.
2. `SEB_FALLBACK_MODEL`.
3. The active provider-specific fallback variable.
4. Saved model settings.
5. The hosted provider default or primary model.

Environment keys take priority over saved keys.

Google uses `GEMINI_MODEL` and `GEMINI_FALLBACK_MODEL`.

Anthropic and OpenAI use the matching `ANTHROPIC_*` and `OPENAI_*` model variables.

OpenAI-compatible endpoints use `OPENAI_COMPATIBLE_MODEL` and `OPENAI_COMPATIBLE_FALLBACK_MODEL`.

An OpenAI-compatible endpoint has no default model.

`SEB_MODEL` does not disable fallback when `SEB_FALLBACK_MODEL` is empty.

Seb then uses the provider-specific, saved, or default fallback.

One-shot mode retries a capacity or rate-limit failure before it prints answer text.

JSON mode can also use this fallback before it prints the output object.

Seb does not use the fallback after another error category.

Run `/provider` or `/model` to inspect the active interactive model.

Run `/provider NAME` or `/model MODEL` to switch it. A successful switch starts a fresh model context and keeps the visible transcript.

`/provider` keeps the configured fallback. `/model` uses the selected model as its own fallback.

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
