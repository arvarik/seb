# Setup guide

This guide starts Seb on one computer. It also verifies each external service.

## 1. Install the requirements

Install Node.js 22 or a newer version.

Check the installed versions.

```bash
node --version
npm --version
```

Choose one supported model provider.

| Provider | Required access | Default primary model | Default fallback model |
| --- | --- | --- | --- |
| Google Gemini | `GOOGLE_GENERATIVE_AI_API_KEY` or `GEMINI_API_KEY` | `gemini-3.7-flash` | `gemini-3.6-flash` |
| Anthropic | `ANTHROPIC_API_KEY` | `claude-sonnet-5` | `claude-haiku-4-5` |
| OpenAI | `OPENAI_API_KEY` | `gpt-5.6-luna` | `gpt-5.4-mini` |
| OpenAI-compatible | API base URL and model ID. The key is optional. | No default | The primary model |

Sleeper, nflverse, and the NWS use public read-only endpoints. These sources need no API key.

## 2. Install the project

Open the project folder.

```bash
cd /path/to/seb
npm install
```

Copy the example environment file.

```bash
cp .env.example .env
```

Run the private model configuration flow.

```bash
npm run seb -- configure
```

The flow masks typed keys and tests the selected provider for 30 seconds.

Seb saves the configuration only after the test succeeds.

The command requires an interactive terminal because it masks private keys.

Run the command again to add another provider or change a saved model.

You can use environment variables instead. This `.env` example selects Google.

```dotenv
GOOGLE_GENERATIVE_AI_API_KEY=your-key
```

This shell example selects a local OpenAI-compatible endpoint without a key.

```bash
export SEB_MODEL_PROVIDER=openai-compatible
export OPENAI_COMPATIBLE_BASE_URL=http://localhost:11434/v1
export OPENAI_COMPATIBLE_MODEL=local-model
```

Seb ignores custom endpoint selection and configuration path changes from a current-directory `.env` file.

This rule prevents an untrusted project file from selecting a model endpoint or a private storage path.

Use `seb configure`, a shell environment, or a deployment environment for these values.

Add a contact value to the NWS user agent.

```dotenv
NWS_USER_AGENT=seb/0.2.3 (you@example.com)
```

The default value identifies the public Seb repository. A direct contact value helps the NWS contact you about request problems.

Do not commit `.env`. The project already ignores this file.

Keep local AI SDK DevTools disabled by default.

```dotenv
SEB_DEVTOOLS=false
```

DevTools records complete prompts and tool data when you enable it.

Optional terminal settings select a theme, symbol set, and history policy.

```dotenv
SEB_THEME=default
SEB_ICONS=unicode
SEB_HISTORY=true
```

Use `high-contrast` or `compact` for the theme.

Use `ascii` when the terminal cannot display Unicode symbols.

Set `SEB_HISTORY=false` to prevent disk history.

Read the [terminal interface guide](TERMINAL_UI.md) for every setting and file path.

## 3. Verify the public data sources

Run the Sleeper smoke test.

```bash
npm run sleeper:smoke
```

This test reads the current NFL state.

The test does not call a model provider.

Run the combined nflverse and NWS smoke test.

```bash
npm run data:smoke
```

This test loads the 2026 schedule and 2025 weekly player statistics.

The test also loads the Seattle stadium hourly forecast and active alerts.

This test does not call a model provider.

Run the direct news source smoke test.

```bash
npm run news:smoke
```

This test reads all 44 built-in news sources from their live public endpoints.

It verifies that each source returns at least one valid dated article.

The test can take longer when a publisher requires a crawl delay.

This test does not call a model provider or Google Search.

## 4. Verify the model provider

Run the complete diagnostic command.

```bash
npm run doctor
```

This command checks Node.js, SQLite, the active model provider, Sleeper, nflverse, and the NWS.

The SQLite check reports cache, snapshot, identity, and source-link counts.

Every provider must complete one forced local tool loop.

The Google check must also return one valid grounded Google Search URL.

Use the offline check when you only want to verify local configuration.

```bash
npm run doctor -- --offline
```

Then ask one small question.

```bash
npm run ask -- "Show the current NFL state."
```

One-shot requests use the configured primary model first.

Seb retries the fallback only after a capacity or rate-limit error.

Seb does not retry the fallback for an authentication error, invalid request, timeout, or cancellation.

## 5. Save the optional Sleeper account

Run setup without a username when you do not want automatic fantasy context.

```bash
npm run seb -- setup
```

Add one Sleeper username when you want automatic fantasy context.

```bash
npm run seb -- setup your-sleeper-name
```

Seb saves only the optional Sleeper username and the update time.

The preferences file contains no league, roster, NFL team, season, or week.

Starting `seb` without preferences creates an empty preferences file.

The setup command accepts no interactive answers, so scripts can also run it.

## 6. Install the direct command

Link the project into the active Node.js installation.

```bash
npm link
```

Start the interactive interface.

```bash
seb
```

The npm command remains available when you do not want a link.

```bash
npm run seb
```

Read the [command-line guide](CLI.md) for pipes, JSON output, and exit codes.

## 7. Use the three Seb experiences

Explore needs no Sleeper account.

```bash
npm run ask -- "Show Derrick Henry's profile, recent statistics, and news."
```

My Fantasy uses one saved Sleeper username.

```text
/connect your-sleeper-name
What needs my attention across my leagues?
```

Seb refreshes the current NFL state when the session starts.

It discovers every current league and owned roster for the saved account.

Analyze continues from the active player, team, or fantasy subject.

```text
Show Derrick Henry's current profile and news.
Compare him with Saquon Barkley for this matchup.
```

You do not need to select a season, week, league, roster, or NFL team first.

Press `Ctrl+K` or type `/` to open the command palette.

Use an advanced override only when you want another period or one league.

```text
/league 123456789
/season 2026
```

Run `/help` inside chat for the complete command list.

Run `/profile show` to show the active profile and file path.

Run `/profile clear` to remove the profile.

Run `/disconnect` to remove the saved Sleeper username.

Player and team subjects remain in memory for natural follow-up questions.

## 8. Install shell completion

Install completion after you run `npm link`.

For Zsh, create a personal completion directory.

```bash
mkdir -p ~/.zfunc
seb completion zsh > ~/.zfunc/_seb
```

Add these lines to `~/.zshrc` when they do not exist.

```zsh
fpath=(~/.zfunc $fpath)
autoload -Uz compinit
compinit
```

Restart Zsh after this change.

For Bash, load the generated function from `~/.bashrc`.

```bash
seb completion bash > ~/.seb-completion.bash
printf '\nsource ~/.seb-completion.bash\n' >> ~/.bashrc
```

Restart Bash after this change.

For Fish, write the script to the standard completion directory.

```fish
mkdir -p ~/.config/fish/completions
seb completion fish > ~/.config/fish/completions/seb.fish
```

Fish loads the new file automatically in a new shell.

## 9. Run the project checks

Run the version check, linter, type check, and all unit tests.

```bash
npm run check
```

Run the coverage gate.

```bash
npm run test:coverage
```

Run the model and tool harness alone.

```bash
npm run test:harness
```

Check for newer direct dependencies.

```bash
npm run deps:check
```

## 10. Inspect local AI SDK requests

Enable local trace recording for one Seb session.

```bash
SEB_DEVTOOLS=true npm run seb
```

Start the trace viewer in another terminal.

```bash
npm run devtools
```

DevTools stores complete prompts and tool data under `.devtools/`.

Never enable DevTools in production.

Read the [AI SDK guide](AI_SDK.md) before you retain or share trace files.

## 11. Start a chat connector

Choose one platform guide.

- [Slack](connectors/SLACK.md)
- [Discord](connectors/DISCORD.md)
- [Telegram](connectors/TELEGRAM.md)

Add the platform values to `.env`. Then start the connector service.

```bash
npm run connectors
```

Check the service health from another terminal.

```bash
curl http://localhost:3000/health
```

The response lists each enabled connector and the selected state adapter.

## Environment reference

| Variable | Required | Purpose |
| --- | --- | --- |
| `SEB_MODEL_PROVIDER` | No | Selects `google`, `anthropic`, `openai`, or `openai-compatible`. |
| `SEB_PROVIDER` | No | Provides the older alias for `SEB_MODEL_PROVIDER`. |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google | Authenticates Google Gemini requests. |
| `GEMINI_API_KEY` | Google | Provides an accepted Google key alias. |
| `ANTHROPIC_API_KEY` | Anthropic | Authenticates Anthropic requests. |
| `OPENAI_API_KEY` | OpenAI | Authenticates OpenAI requests. |
| `OPENAI_COMPATIBLE_API_KEY` | Endpoint-specific | Authenticates an OpenAI-compatible endpoint when it requires a key. |
| `OPENAI_COMPATIBLE_BASE_URL` | OpenAI-compatible | Selects the compatible API base URL. |
| `SEB_MODEL` | No | Overrides the active provider model. |
| `SEB_FALLBACK_MODEL` | No | Overrides the active provider fallback model. |
| `GEMINI_MODEL`, `GEMINI_FALLBACK_MODEL` | No | Select the Google models. |
| `ANTHROPIC_MODEL`, `ANTHROPIC_FALLBACK_MODEL` | No | Select the Anthropic models. |
| `OPENAI_MODEL`, `OPENAI_FALLBACK_MODEL` | No | Select the OpenAI models. |
| `OPENAI_COMPATIBLE_MODEL`, `OPENAI_COMPATIBLE_FALLBACK_MODEL` | OpenAI-compatible | Select the endpoint models. |
| `NWS_USER_AGENT` | Recommended | Identifies Seb and gives the NWS a contact value. |
| `SEB_DEVTOOLS` | No | Records local AI SDK traces when it equals `true` or `1`. |
| `SEB_SLEEPER_USER` | No | Supplies the optional Sleeper username during setup. |
| `SEB_PROFILE_FILE` | No | Selects the complete preferences file path. |
| `SEB_CONFIG_HOME` | No | Selects the directory that contains `profile.json`. |
| `SEB_MODEL_SETTINGS_FILE` | No | Selects the complete non-secret model settings file path. |
| `SEB_CONNECTORS` | Usually | Lists `slack`, `discord`, or `telegram`. |
| `SEB_BOT_NAME` | No | Sets the common bot name. The default is `seb`. |
| `HOST` | No | Sets the connector bind address. The default is `0.0.0.0`. |
| `PORT` | No | Sets the HTTP port. The default is `3000`. |
| `REDIS_URL` | Production | Enables persistent and shared connector state. |

Seb can auto-detect a connector from complete platform credentials.

Set `SEB_CONNECTORS` explicitly in production. This setting prevents an unused credential from enabling a platform.

Environment values override saved credentials and saved model settings.

The automatic current-directory `.env` loader ignores custom endpoints, provider selection, private storage paths, and DevTools activation.

An explicit CLI or slash model override uses that model as its own fallback.

An explicit provider-only override keeps that provider's configured fallback.

`SEB_MODEL` does not disable fallback.

It uses `SEB_FALLBACK_MODEL`, a provider-specific fallback, a saved fallback, or the hosted default.

A qualified model uses the `provider:model` format. The provider prefix must match a supported provider ID.

## Local configuration paths and security

Seb selects the account preferences path in this order.

1. `SEB_PROFILE_FILE` selects the complete file path.
2. `SEB_CONFIG_HOME` selects `DIRECTORY/profile.json`.
3. `XDG_CONFIG_HOME` selects `DIRECTORY/seb/profile.json`.
4. The default path is `~/.config/seb/profile.json`.

Seb places `credentials.json` and `model-settings.json` beside `profile.json`.

`SEB_MODEL_SETTINGS_FILE` can select a different model settings path.

Use absolute paths for file overrides in scripts.

Do not set both Seb preferences variables.

`SEB_PROFILE_FILE` has priority when both values exist.

Seb gives a newly created preferences directory mode `0700`.

Seb does not change the mode of an existing custom directory.

Seb writes each configuration file with mode `0600`.

It writes a temporary file before an atomic rename.

It rejects a file larger than 64 KiB.

It validates the schema, identifiers, ranges, and update time on every load.

One saved key cannot exceed 16 KiB. One model ID cannot exceed 200 safe characters.

`profile.json` contains only the optional Sleeper username, schema version, and update time.

`credentials.json` contains saved provider keys and no model settings.

It binds a saved OpenAI-compatible key to one canonical compatible base URL.

`model-settings.json` contains the active provider, model IDs, fallback model IDs, and the optional compatible endpoint. It contains no keys.

Seb migrates version 1 and version 2 files to version 3 when it loads them.

Version 1 migration keeps a valid Sleeper username.

All migrations remove saved league, roster, season, and week values.

The account preferences file does not contain a provider key or connector credential.

The model configuration prompt never adds a typed key to chat or prompt history.

Local usage telemetry excludes keys, authorization headers, and compatible endpoint URLs.

Interactive chat and one-shot requests load these preferences automatically.

They also load saved model credentials and model settings.

Connector services do not load the saved provider files. Configure each connector process through its environment.

One-shot and connector requests do not apply interactive team context.

## Common setup errors

### No model provider is configured

Run `seb configure` in an interactive terminal.

You can instead add a supported provider key or compatible endpoint to the environment.

### An OpenAI-compatible endpoint is rejected

Use an HTTP loopback URL or an HTTPS remote URL.

Use the API base URL. Do not use `/chat/completions`, `/completions`, `/models`, or `/responses` as the final path.

Remove embedded credentials, a query string, and a fragment from the URL.

Seb rejects redirects for compatible model and discovery requests.

The interactive flow asks for confirmation before it sends data to a non-loopback origin.

The endpoint must support streaming and model tool calls.

Run `seb configure` to test those requirements before you save the endpoint.

### Sleeper finds no league

Confirm the saved Sleeper username with `/account`.

Confirm that the user has an NFL league for the current Sleeper league season.

Run `/connect USERNAME` again to refresh the account.

### Sleeper does not list the expected roster

Run `/account` to confirm that Seb found the owned roster.

Run `/rosters LEAGUE_ID` to inspect every roster in one league.

Select the required roster with `/roster ID`.

### The preferences file contains invalid JSON

Run `/profile clear` from chat when the file still loads far enough to start.

Otherwise, inspect the file at the configured profile path.

Move the invalid file to a private backup location.

Then run `seb setup` to create a validated profile.

### The preferences file has unsafe permissions

Restrict the directory and file on Unix systems.

Run each file command only when that file exists.

```bash
chmod 700 ~/.config/seb
chmod 600 ~/.config/seb/profile.json ~/.config/seb/credentials.json ~/.config/seb/model-settings.json
```

### No connector is configured

The connector service reports that no connector exists.

Set `SEB_CONNECTORS`. Then add every required platform credential.

### A connector works until restart

The service uses memory state when `REDIS_URL` is empty.

Add Redis before production use. See [production operations](OPERATIONS.md).

### Sleeper returns an API error

Run `npm run sleeper:smoke` again.

Check the league ID when only one league request fails.

Sleeper removes old or invalid league identifiers from some results.

### nflverse returns a missing file

Confirm that the requested season exists in the nflverse data release.

Run `npm run data:smoke` to verify the current supported files.

Use `/refresh nflverse` when a cached record does not match a new release.

### The weather forecast is unavailable

The NWS hourly forecast covers about seven days.

Seb returns an explicit unavailable result for a later kickoff.

Seb skips direct field-weather effects for a closed roof or a dome.

International games do not use the NWS.

### The SQLite cache does not open

Run `seb cache status` to show the path and error.

Confirm that the current user can read and write the `.cache` directory.

Read the [storage guide](STORAGE.md) before you replace the database.

### Seb uses stale data

Run `/sources` to identify the source and refresh error.

Run `/refresh SOURCE` to force the next request to contact that source.

Seb does not use a stale value after its allowed backup period ends.
