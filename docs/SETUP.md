# Setup guide

This guide starts Seb on one computer. It also verifies each external service.

## 1. Install the requirements

Install Node.js 22 or a newer version.

Check the installed versions.

```bash
node --version
npm --version
```

Create a [Gemini API key](https://aistudio.google.com/app/apikey).

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

Add the Gemini key to `.env`.

```dotenv
GOOGLE_GENERATIVE_AI_API_KEY=your-key
```

Add a contact value to the NWS user agent.

```dotenv
NWS_USER_AGENT=seb/0.0.2 (you@example.com)
```

The default value identifies the public Seb repository. A direct contact value helps the NWS contact you about request problems.

Do not commit `.env`. The project already ignores this file.

## 3. Verify the public data sources

Run the Sleeper smoke test.

```bash
npm run sleeper:smoke
```

This test reads the current NFL state.

The test does not call Gemini.

Run the combined nflverse and NWS smoke test.

```bash
npm run data:smoke
```

This test loads the 2026 schedule and 2025 weekly player statistics.

The test also loads the Seattle stadium hourly forecast and active alerts.

This test does not call Gemini.

## 4. Verify Gemini

Run the complete diagnostic command.

```bash
npm run doctor
```

This command checks Node.js, SQLite, Gemini, Sleeper, nflverse, and the NWS.

The SQLite check reports cache, snapshot, identity, and source-link counts.

The Gemini check sends one small request.

Use the offline check when you only want to verify local configuration.

```bash
npm run doctor -- --offline
```

Then ask one small question.

```bash
npm run ask -- "Show the current NFL state."
```

One-shot requests use `GEMINI_MODEL` first. They use `GEMINI_FALLBACK_MODEL` after a temporary capacity or rate-limit error.

## 5. Create the local profile

Run the setup wizard in a terminal.

```bash
npm run seb -- setup
```

The wizard checks that the Gemini key exists.

It sends one small Gemini request to validate the key and configured models.

It does not save the key value.

The wizard asks for a Sleeper username.

It reads the current NFL season from Sleeper.

It asks for an NFL season and uses the current season as the default.

Enter an older season when you want a league from that season.

It lists the user's leagues for that season.

It then lists only rosters that the user owns or co-owns.

Select one league and one roster.

Seb saves that context as the default interactive profile.

Starting `seb` without a profile starts the same wizard automatically.

The wizard needs an interactive terminal.

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

## 7. Ask league questions

Include the Sleeper league ID in each league request.

```bash
npm run ask -- "Analyze every roster in Sleeper league 123456789."
```

Use a user name when you do not know the league ID.

```bash
npm run ask -- "Find the Sleeper user arvind and list the user's 2026 NFL leagues."
```

Interactive chat can use a returned league ID in a later prompt.

Set repeated values once inside interactive chat.

```text
/season 2026
/week current
/league 123456789
/roster 4
/team SEA
```

Run `/help` inside chat for the complete command list.

Run `/profile show` to show the active profile and file path.

Run `/profile clear` to remove the profile.

Run `/setup USERNAME` inside chat to discover another league.

The interactive setup command returns the next exact command when it needs a choice.

It uses the active session season.

Run `/season YEAR` before `/setup USERNAME` when you need another season.

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

Run the type check and all unit tests.

```bash
npm run check
```

Run the model and tool harness alone.

```bash
npm run test:harness
```

Check for newer direct dependencies.

```bash
npm run deps:check
```

## 10. Start a chat connector

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
| `GOOGLE_GENERATIVE_AI_API_KEY` | Yes | Authenticates Gemini requests. |
| `GEMINI_MODEL` | No | Selects the primary Gemini model. |
| `GEMINI_FALLBACK_MODEL` | No | Selects the capacity fallback model. |
| `NWS_USER_AGENT` | Recommended | Identifies Seb and gives the NWS a contact value. |
| `SEB_PROFILE_FILE` | No | Selects the complete setup profile path. |
| `SEB_CONFIG_HOME` | No | Selects the directory that contains `profile.json`. |
| `SEB_CONNECTORS` | Usually | Lists `slack`, `discord`, or `telegram`. |
| `SEB_BOT_NAME` | No | Sets the common bot name. The default is `seb`. |
| `HOST` | No | Sets the connector bind address. The default is `0.0.0.0`. |
| `PORT` | No | Sets the HTTP port. The default is `3000`. |
| `REDIS_URL` | Production | Enables persistent and shared connector state. |

Seb can auto-detect a connector from complete platform credentials.

Set `SEB_CONNECTORS` explicitly in production. This setting prevents an unused credential from enabling a platform.

## Profile path and security

Seb selects the profile path in this order.

1. `SEB_PROFILE_FILE` selects the complete file path.
2. `SEB_CONFIG_HOME` selects `DIRECTORY/profile.json`.
3. `XDG_CONFIG_HOME` selects `DIRECTORY/seb/profile.json`.
4. The default path is `~/.config/seb/profile.json`.

Use an absolute path for `SEB_PROFILE_FILE` in scripts.

Do not set both Seb profile variables.

`SEB_PROFILE_FILE` has priority when both values exist.

Seb creates the profile directory with mode `0700`.

Seb writes the profile with mode `0600`.

It writes a temporary file before an atomic rename.

It rejects a file larger than 64 KiB.

It validates the schema, identifiers, ranges, and update time on every load.

The profile contains the Sleeper username, user ID, league, roster, season, and update time.

The profile does not contain the Gemini key or connector credentials.

Only interactive chat loads this profile automatically.

One-shot and connector requests do not apply the saved league context.

## Common setup errors

### The Gemini key is empty

The command shows `The Google Generative AI API key is empty.`

Add the key to `.env`. Then restart the command.

### The setup wizard needs a terminal

Run `seb setup` from a normal terminal.

Do not pipe input into this command.

### Sleeper finds no league

Confirm the Sleeper username first.

Confirm that the user has an NFL league for the selected season.

Run the wizard again and enter a different season when necessary.

### Sleeper finds no owned roster

Confirm that the selected user owns or co-owns a roster in that league.

Select another league when the user only views the current league.

### The profile contains invalid JSON

Run `/profile clear` from chat when the profile still loads far enough to start.

Otherwise, inspect the file at the configured profile path.

Move the invalid file to a private backup location.

Then run `seb setup` to create a validated profile.

### The profile has unsafe permissions

Restrict the directory and file on Unix systems.

```bash
chmod 700 ~/.config/seb
chmod 600 ~/.config/seb/profile.json
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
