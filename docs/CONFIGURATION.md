# Persistent configuration

Run `seb configure` in a terminal. Select one of these actions:

1. **Model provider setup** verifies a provider key and saves model choices.
2. **Saved settings and credentials** edits supported settings by group. Secret prompts hide typed values.
3. **Import a dotenv file** previews supported setting names and asks before saving.

You can open the import directly:

```bash
seb configure --import-env /absolute/path/to/.env
```

Imports skip empty values and unsupported variables. Imports do not contact model providers.
Seb never executes shell expressions in dotenv values.
Edit or import again when you change a file. Seb does not watch the file or load files from its launch directory.

## Gemini and Judgment

This example keeps the Gemini model on its stable family and enables optional Judgment tracing:

```dotenv
GOOGLE_GENERATIVE_AI_API_KEY=your-gemini-key
GEMINI_MODEL=gemini-flash
GEMINI_FALLBACK_MODEL=gemini-flash-lite
SEB_JUDGMENT_TRACING=true
JUDGMENT_API_KEY=your-judgment-key
JUDGMENT_ORG_ID=0c94b0c2-564b-4a5f-81d3-0363118f3bd4
```

`GEMINI_API_KEY` is an alias for `GOOGLE_GENERATIVE_AI_API_KEY`.
Conflicting alias values cause an import error.
Judgment tracing stays off unless you enable it. Saving a Judgment key alone does not enable tracing.
Tracing exports prompts, answers, and tool data to the configured Judgment organization in project `seb`.
Set `SEB_JUDGMENT_TRACING=false` to disable it. `JUDGMENT_MONITORING=false` also disables monitoring.

## Storage and security

Seb uses its user configuration directory, normally `~/.config/seb`:

| File | Contents |
| --- | --- |
| `settings.json` | Supported application settings |
| `model-settings.json` | Active provider and model choices |
| `credentials.json` | Provider keys and other secret settings |

Seb creates files with owner-only read and write permissions, mode `0600`.
It creates new configuration directories with mode `0700`.
The credential file is **not encrypted**. Programs that run as your user can read it.
Do not commit these files or include them in shared backups.
The repository ignores `.env` and `.env.*`, except `.env.example`.

Shell variables override saved values. Command options override corresponding shell values.
Saved values override application defaults. Changing a shell variable does not change the saved file.
CLI and connector startup load saved values before tracing initialization.

Use `SEB_CONFIG_HOME`, `XDG_CONFIG_HOME`, or `SEB_PROFILE_FILE` in the shell to select a different configuration location.
The importer skips these variables. It also skips arbitrary variables such as `PATH` and `NODE_OPTIONS`.
Configure OpenAI-compatible endpoints and their keys through model provider setup.
The importer skips those endpoint variables to preserve endpoint verification and key binding.
Use provider-specific model settings instead of importing `SEB_MODEL` or `SEB_FALLBACK_MODEL`.

## Adding settings

The registry in `src/setup/configuration-registry.ts` supplies editor choices, validation, and import recognition.
Add each supported variable there with its group, value type, and secret classification.
The editor and importer then include it automatically. Arbitrary new dotenv variables do not become global settings.
Settings cover hosted model providers, Judgment, terminal preferences, data preferences, and connectors.
