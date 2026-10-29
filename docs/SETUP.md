# Setup Guide

[Documentation Hub](README.md) · [Persistent Configuration](CONFIGURATION.md) · [Model Selection](MODELS.md) · [CLI Guide](CLI.md)

This guide walks you through installing Seb, configuring a language model provider, verifying all local and public data services, and optionally linking your Sleeper fantasy account or a chat connector.

## 1. Prerequisites and model providers

Seb requires **Node.js 22 or newer** (unless you run the official Docker image). Check your local runtime before installing:

```bash
node --version
npm --version
```

Sleeper, nflverse, the National Weather Service (NWS), and Seb's 47 built-in NFL newsrooms all use public read-only endpoints and require **no API keys**. You only need access to one supported language model provider:

| Provider | Required credentials | Default primary family | Default fallback family |
| --- | --- | --- | --- |
| **Google Gemini** | `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY` | `gemini-flash` | `gemini-flash-lite` |
| **Anthropic** | `ANTHROPIC_API_KEY` | `claude-sonnet` | `claude-haiku` |
| **OpenAI** | `OPENAI_API_KEY` | `gpt-luna` | `gpt-mini` |
| **OpenAI-compatible** | Base URL and model ID (API key is optional) | None (explicit model required) | Uses primary model |

Hosted providers default to auto-updating model families that resolve to the newest stable release at startup. See [Model selection](MODELS.md) for family resolution rules, capabilities, and pinning exact model IDs.

## 2. Install Seb

Choose the installation method that fits your workflow:

### Install globally from npm (recommended)

```bash
npm install -g @arvarik/seb
seb --version
```

### Run without installing via `npx`

```bash
npx @arvarik/seb configure
npx @arvarik/seb
```

### Run with Docker

The published container sets `SEB_CONFIG_HOME=/root/.seb` so a single mounted volume persists your configuration, prompt history, and resumable sessions:

```bash
docker run --rm -it \
  -v "$HOME/.config/seb:/root/.seb" \
  ghcr.io/arvarik/seb:latest
```

### Install from source

Clone the repository, install locked dependencies with `npm ci`, and link or install the binary globally:

```bash
git clone https://github.com/arvarik/seb.git
cd seb
npm ci
npm link          # or: npm install -g .
```

When working directly in a source checkout without `npm link`, you can run any command via `npm run seb -- <subcommand>` (for example, `npm run seb -- configure` or `npm run seb`).

## 3. Configure a model provider and settings

Run the interactive configuration wizard in a terminal to mask secret input, verify your provider key with a 30-second live test, and save settings to `~/.config/seb`:

```bash
seb configure
```

Seb saves your provider credentials only after the verification request succeeds. Re-run `seb configure` any time to add another provider, edit application settings, or switch model families.

Alternatively, import supported keys and settings from an explicit dotenv file without contacting the provider:

```bash
cp .env.example .env
# Edit .env with your provider key and preferences
seb configure --import-env /absolute/path/to/.env
```

> [!IMPORTANT]
> Seb **never** auto-loads a `.env` file from your current working directory. This prevents an untrusted repository from hijacking your model endpoint or storage paths. Always apply settings via `seb configure`, `seb configure --import-env`, or explicit shell/deployment environment variables.

### Recommended environment settings

Set a contact address on `NWS_USER_AGENT` so the National Weather Service can reach you if automated weather requests encounter issues, and use strict `'true'` or `'false'` strings for boolean flags:

```dotenv
NWS_USER_AGENT=seb/1.1.2 (you@example.com)
SEB_DEVTOOLS=false
SEB_THEME=default
SEB_ICONS=unicode
SEB_HISTORY=true
SEB_SESSIONS=true
```

> [!WARNING]
> Boolean settings imported with `seb configure --import-env` strictly accept `'true'` or `'false'` (never `on` or `off`). For example, use `SEB_SESSIONS=false` to stop saving session snapshots, or `SEB_HISTORY=false` to disable both disk prompt history and session snapshots. Keep `SEB_DEVTOOLS=false` outside local debugging because DevTools writes full prompts and tool payloads to `.devtools/`.

To target a local OpenAI-compatible server (such as Ollama or vLLM) for the current shell without saving credentials:

```bash
export SEB_MODEL_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
export OPENAI_COMPATIBLE_MODEL=local-model
```

See [Persistent configuration](CONFIGURATION.md) for full details on `~/.config/seb` files, precedence rules, and optional Judgment OpenTelemetry tracing.

## 4. Verify diagnostics and data sources

Run `seb doctor` to verify your local environment, active model provider, and every public NFL/weather source in one pass:

```bash
seb doctor
```

`seb doctor` executes **9 checks**:

1. **Node.js runtime** — Confirms Node.js 22 or newer.
2. **Environment configuration** — Validates configured provider settings, keys, and environment values.
3. **Local SQLite cache** — Opens `.cache/seb.sqlite` and reports schema version plus cache, snapshot, canonical identity, and source-link counts.
4. **Local file permissions** — Verifies safe directory (`0700`) and file (`0600`) modes on saved configuration files.
5. **Local forecast learning** — Validates stored adaptive forecast learning state.
6. **Active model provider** — Forces the active model through a live local tool-calling loop (and verifies a grounded Google Search URL when Google Gemini is active).
7. **Sleeper public API** — Fetches the live NFL season and week state.
8. **nflverse public files** — Verifies schedule and player statistics release access.
9. **National Weather Service API** — Fetches a live stadium hourly forecast and alert feed.

When working without network access, run only the local checks with `seb doctor --offline`. Once diagnostics pass, test a quick one-shot prompt:

```bash
seb ask "Show the current NFL state."
```

One-shot requests try your configured primary model first and fall back to the fallback model only on capacity or rate-limit errors (never on authentication errors, invalid requests, timeouts, or cancellations).

If you installed from source, you can also run provider-free smoke tests directly:

```bash
npm run sleeper:smoke   # Reads live Sleeper NFL state
npm run data:smoke      # Loads nflverse schedules/stats + Seattle NWS forecast & alerts
npm run news:smoke      # Verifies dated articles across all 47 built-in NFL newsrooms
```

## 5. Connect an optional Sleeper account

Seb works out of the box for NFL research without any fantasy account. When you want automatic league, roster, scoring, and matchup context in **My Fantasy** and **Analyze**, save your public Sleeper username:

```bash
seb setup your-sleeper-name
```

Running `seb setup` with no username initializes a clean empty `profile.json` for scripts or non-fantasy setups. `profile.json` stores only your optional Sleeper username, schema version, and update timestamp—never league IDs, roster IDs, or API keys—because Seb rediscovers your active leagues and owned rosters dynamically from Sleeper.

## 6. Use interactive chat, sessions, and tool inspection

Launch the terminal UI with `seb`:

```bash
seb
```

Inside interactive chat, all three experiences work together without manual setup:

- **Explore** answers player, team, schedule, stat, and verified news questions with no Sleeper account required.
- **My Fantasy** (`/connect your-sleeper-name`) discovers every current-season league and owned roster to surface lineup gaps, injuries, waivers, and matchup priorities.
- **Analyze** carries the active player, team, or league forward for start/sit comparisons, full-roster lineup optimization, waiver rankings, and trade evaluations.

Press `Ctrl+K` or type `/` to open the command palette, or run `/help` for the full command list. Use `/league <ID>` or `/season <YEAR>` only when you want to narrow focus to one league or historical season, and use `/profile show`, `/profile clear`, or `/disconnect` to manage your saved Sleeper profile. See the [Interactive guide](INTERACTIVE.md) and [Terminal interface guide](TERMINAL_UI.md) for all controls.

### Inspect tool details

Every external lookup renders as a compact purple tool row in the transcript. Click any purple tool row to expand its JSON input and result in place, and click it again to collapse. Consecutive calls to the same tool collapse into a single grouped row—click once to expand into individual calls (each labeled with a short ID and elapsed duration), then click an individual call to inspect its payload (capped at 64,000 characters with a truncation label when shortened). You can drag across any visible text to select and copy it.

### Resume a conversation

When you leave chat with `/exit`, Seb saves the conversation snapshot and prints its session ID along with the exact command to continue later:

```bash
seb sessions
seb resume seb-00000000-0000-0000-0000-000000000000
```

`seb sessions` lists saved conversations with their opening question, while `seb resume <SESSION_ID>` restores prompts, answers, tool inputs/results, source evidence, and active player/team/skill/league focus under owner-only permissions (`0600`) in `~/.config/seb/sessions/` (or alongside `SEB_HISTORY_FILE`; `/root/.seb/sessions` in Docker).

- **Privacy & opt-out**: Session files never contain API keys or provider credentials. Set `SEB_SESSIONS=false` to disable session snapshots while keeping prompt history, or `SEB_HISTORY=false` to disable both prompt history and session saving (existing `.json` files remain until you delete them).
- **Safety & limits**: Seb records your prompt before calling the model so a failed request is ready to retry after resuming, but it never auto-executes an unfinished approval. One terminal writes a given session at a time; snapshots exceeding 32 MiB keep their previous revision with a warning, and corrupted snapshots are left untouched and omitted from `seb sessions`. Resuming refreshes the live model and NFL calendar from startup and requires the same connected Sleeper account.

## 7. Shell completion, local DevTools, and source checks

### Shell completion

Generate and install tab completion for Zsh, Bash, or Fish:

```bash
# Zsh (ensure ~/.zfunc is in fpath before compinit in ~/.zshrc)
mkdir -p ~/.zfunc && seb completion zsh > ~/.zfunc/_seb

# Bash
seb completion bash > ~/.seb-completion.bash
printf '\nsource ~/.seb-completion.bash\n' >> ~/.bashrc

# Fish
mkdir -p ~/.config/fish/completions
seb completion fish > ~/.config/fish/completions/seb.fish
```

### Local AI SDK DevTools

To inspect raw model steps and tool payloads during local development, launch Seb with `SEB_DEVTOOLS=true seb` and run `npm run devtools` in a second terminal from a source checkout. Never enable `SEB_DEVTOOLS` in production; see the [AI SDK guide](AI_SDK.md) for trace retention details.

### Contributor checks (source checkouts)

```bash
npm run check           # Version invariant, ESLint, TypeScript, and unit tests
npm run test:coverage   # Coverage gate
npm run test:harness    # Model and tool harness suite
npm run deps:check      # Check direct dependencies for newer releases
```

## 8. Start a chat connector

Seb includes webhook and bot connectors for four chat platforms:

- [Slack](connectors/SLACK.md)
- [Discord](connectors/DISCORD.md)
- [Telegram](connectors/TELEGRAM.md)
- [GroupMe](connectors/GROUPME.md)

Save your platform credentials via `seb configure` or `seb configure --import-env /absolute/path/to/.env` (or pass them directly in the process environment), then start the unified HTTP connector service:

```bash
seb connectors          # or: npm run connectors
curl http://localhost:3000/health
```

For **GroupMe**, create a bot callback pointing to your public HTTPS endpoint (or an HTTPS development tunnel forwarding to `http://localhost:3000`) with your webhook secret query/header configuration, and set `SEB_CONNECTORS=groupme`, `GROUPME_BOT_ID`, and `GROUPME_WEBHOOK_SECRET`. See [GroupMe setup](connectors/GROUPME.md) and [Production operations](OPERATIONS.md) for deployment checklists and Redis state configuration (`REDIS_URL`).

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `SEB_MODEL_PROVIDER` | No | Selects `google`, `anthropic`, `openai`, or `openai-compatible` (`SEB_PROVIDER` is an older alias). |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google | Authenticates Google Gemini requests (`GEMINI_API_KEY` is an accepted alias). |
| `ANTHROPIC_API_KEY` | Anthropic | Authenticates Anthropic requests. |
| `OPENAI_API_KEY` | OpenAI | Authenticates OpenAI requests. |
| `OPENAI_COMPATIBLE_API_KEY` | Endpoint-specific | Authenticates an OpenAI-compatible endpoint when required. |
| `OPENAI_COMPATIBLE_BASE_URL` | OpenAI-compatible | Base URL for an OpenAI-compatible API (`http://` loopback or `https://` remote). |
| `SEB_MODEL`, `SEB_FALLBACK_MODEL` | No | Overrides the active provider's primary or fallback model (`provider:model` prefix supported). |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | No | Overrides the Google Gemini primary or fallback model/family. |
| `ANTHROPIC_MODEL`, `ANTHROPIC_FALLBACK_MODEL` | No | Overrides the Anthropic primary or fallback model/family. |
| `OPENAI_MODEL`, `OPENAI_FALLBACK_MODEL` | No | Overrides the OpenAI primary or fallback model/family. |
| `OPENAI_COMPATIBLE_MODEL`, `OPENAI_COMPATIBLE_FALLBACK_MODEL` | OpenAI-compatible | Selects the compatible endpoint primary and optional fallback model IDs. |
| `SEB_CONFIG_HOME` | No | Directory storing `settings.json`, `credentials.json`, `model-settings.json`, `profile.json`, `history.json`, and `sessions/`. |
| `SEB_PROFILE_FILE` | No | Explicit file path override for `profile.json` (takes priority over `SEB_CONFIG_HOME`). |
| `SEB_MODEL_SETTINGS_FILE` | No | Explicit file path override for `model-settings.json`. |
| `SEB_HISTORY_FILE` | No | Explicit file path override for `history.json` (also relocates sibling `sessions/`). |
| `SEB_SLEEPER_USER` | No | Supplies a default Sleeper username during `seb setup`. |
| `SEB_THEME` | No | Startup terminal theme (`default`, `high-contrast`, or `compact`). |
| `SEB_ICONS` | No | Startup symbol set (`unicode` or `ascii`). |
| `SEB_HISTORY` | No | `'true'` or `'false'`. Setting `'false'` disables both disk prompt history and session snapshots. |
| `SEB_SESSIONS` | No | `'true'` or `'false'`. Setting `'false'` disables saving resumable conversation snapshots. |
| `NWS_USER_AGENT` | Recommended | Identifies Seb and supplies contact info for National Weather Service API calls. |
| `SEB_DEVTOOLS` | No | Records local AI SDK traces to `.devtools/` when set to `'true'` or `'1'`. |
| `SEB_JUDGMENT_TRACING` | No | `'true'` or `'false'`. Enables optional Judgment OpenTelemetry tracing when `'true'`. |
| `JUDGMENT_API_KEY` | Judgment | API key for Judgment trace export (saved in `credentials.json` when configured). |
| `JUDGMENT_ORG_ID` | Judgment | Target Judgment organization UUID for trace export. |
| `JUDGMENT_MONITORING` | No | Set to `'false'` to disable Judgment monitoring spans. |
| `SEB_CONNECTORS` | Production | Comma-separated list of enabled connectors: `slack`, `discord`, `telegram`, or `groupme`. |
| `SEB_BOT_NAME` | No | Display/mention handle for chat connectors (defaults to `seb`). |
| `HOST`, `PORT` | No | Bind host (`0.0.0.0`) and HTTP port (`3000`) for `seb connectors`. |
| `REDIS_URL` | Production | Redis connection URL for shared, persistent connector state across restarts. |
| `GROUPME_BOT_ID` | GroupMe | Bot ID issued by GroupMe for posting replies. |
| `GROUPME_WEBHOOK_SECRET` | GroupMe | Shared secret verifying inbound GroupMe webhook callbacks. |
| `TELEGRAM_MENTION_ON_REPLY` | No | `'true'` or `'false'`. Controls whether Telegram replies mention the sender. |

> [!NOTE]
> While Seb can auto-detect enabled connectors from complete platform credentials during local testing, always set `SEB_CONNECTORS` explicitly in production so unused credentials never activate an unintended webhook route.

## Local configuration paths and security

Seb resolves its user configuration directory in this order: `SEB_CONFIG_HOME`, `$XDG_CONFIG_HOME/seb`, or `~/.config/seb` by default (`SEB_PROFILE_FILE`, `SEB_MODEL_SETTINGS_FILE`, and `SEB_HISTORY_FILE` can override individual paths—use absolute paths in scripts). Inside that directory, Seb separates data cleanly across six artifacts:

- **`settings.json`** — Non-secret application settings (UI preferences, `NWS_USER_AGENT`, Judgment tracing flags/org ID, and non-secret connector options).
- **`credentials.json`** — Provider API keys and saved secrets (`JUDGMENT_API_KEY` and connector secrets). OpenAI-compatible API keys are cryptographically bound to their canonical base URL.
- **`model-settings.json`** — Active provider, primary and fallback model families/IDs, and any configured OpenAI-compatible base URL (no secret keys).
- **`profile.json`** — Optional Sleeper username, schema version (`3`), and update timestamp. Legacy v1/v2 profiles migrate automatically on load while stripping deprecated league, roster, season, and week fields.
- **`history.json`** — Private prompt history (up to 200 entries; excluded when typed inside secret configuration prompts).
- **`sessions/`** — Owner-only conversation snapshot JSON files for `seb resume`.

Interactive chat (`seb`), one-shot CLI invocations (`seb ask`), and the connector server (`seb connectors`) all load saved configuration from `~/.config/seb` as defaults whenever the corresponding process environment variables are unset. **Process environment variables (`process.env`) always take precedence over saved files**, and explicit CLI flags (`--provider`, `--model`) override both. Note that one-shot and connector requests remain stateless per call/thread rather than applying interactive `/team` or `/roster` overrides.

Seb creates new configuration directories with mode `0700` (leaving existing custom directory permissions unchanged) and writes every file atomically via a temporary file with owner-only mode `0600`. Config files are capped at 64 KiB, individual keys at 16 KiB, and model IDs at 200 safe characters. Local usage telemetry never records API keys, authorization headers, or custom compatible base URLs.

## Common setup errors

- **No model provider is configured**: Run `seb configure` in an interactive terminal or export a supported provider API key (`GOOGLE_GENERATIVE_AI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or OpenAI-compatible variables).
- **OpenAI-compatible endpoint rejected**: Supply an `http://` loopback URL or `https://` remote API base URL without trailing `/chat/completions`, `/completions`, `/models`, or `/responses` paths, embedded credentials, query strings, or fragments. Seb blocks HTTP redirects, asks before contacting non-loopback origins, and verifies streaming plus tool-calling support during `seb configure`.
- **Unsafe file permissions warning**: Restrict your config folder and existing JSON files on Unix systems:
  ```bash
  chmod 700 ~/.config/seb
  chmod 600 ~/.config/seb/*.json
  ```
- **Invalid `profile.json` JSON**: Run `/profile clear` if interactive chat starts, or move the damaged file aside and run `seb setup` to write a fresh profile.
- **Sleeper league or roster missing**: Run `/account` to inspect discovered current-season NFL leagues, `/connect <USERNAME>` to refresh, or `/rosters <LEAGUE_ID>` and `/roster <ID>` to select a roster manually.
- **Connector fails to start or loses state on restart**: Set `SEB_CONNECTORS` alongside all required platform secrets, and configure `REDIS_URL` so connector state persists across restarts (see [Production operations](OPERATIONS.md)).
- **Stale source data, missing nflverse season, or unavailable weather**: Run `/sources` to check cache age and `/refresh <sleeper|nflverse|weather|news|all>` to invalidate cached rows. Remember that NWS forecasts cover ~7 days for US outdoor venues only (domes, closed roofs, and international venues skip NWS field-weather adjustments). If `.cache/seb.sqlite` cannot open, run `seb cache status` and consult [Storage](STORAGE.md).
