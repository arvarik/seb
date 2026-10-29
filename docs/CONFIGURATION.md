# Persistent Configuration

[Documentation Hub](README.md) · [Setup Guide](SETUP.md) · [Model Selection](MODELS.md) · [Storage](STORAGE.md)

Seb stores user-level configuration, model preferences, and credentials outside project repositories so your setup works from any directory without risking accidental git commits.

## Interactive configuration and dotenv imports

Run `seb configure` in an interactive terminal to manage persistent configuration through three guided flows:

1. **Model provider setup** — Prompts privately for an API key (or OpenAI-compatible base URL), resolves model families, runs a 30-second live verification request, and saves only after verification succeeds.
2. **Saved settings and credentials** — Edits supported settings organized by functional group (providers, Judgment tracing, terminal UI, data preferences, and chat connectors) while masking secret inputs.
3. **Import a dotenv file** — Previews recognized variable names from a `.env` file and asks for confirmation before writing them to `~/.config/seb`.

You can also invoke the dotenv importer directly from the command line:

```bash
seb configure --import-env /absolute/path/to/.env
```

The importer parses values statically without evaluating shell expressions (`$(...)` or variable interpolation), skips empty values and unrecognized keys (such as `PATH` or `NODE_OPTIONS`), and does not contact external model APIs. Boolean variables strictly require `'true'` or `'false'`, and conflicting alias values (such as mismatched `GOOGLE_GENERATIVE_AI_API_KEY` and `GEMINI_API_KEY` entries) fail validation cleanly. Because Seb never watches dotenv files or auto-loads `.env` from your working directory, re-run `seb configure --import-env` whenever you want to apply changes from a file.

> [!NOTE]
> For security, the dotenv importer intentionally skips storage-path overrides (`SEB_CONFIG_HOME`, `SEB_PROFILE_FILE`, `SEB_MODEL_SETTINGS_FILE`, `SEB_HISTORY_FILE`), generic single-run overrides (`SEB_MODEL`, `SEB_FALLBACK_MODEL`), and `OPENAI_COMPATIBLE_*` endpoint variables. Configure OpenAI-compatible endpoints through **Model provider setup** in `seb configure` so Seb can verify streaming/tool support and bind the optional key to one canonical base URL, and use provider-specific variables (`GEMINI_MODEL`, `ANTHROPIC_MODEL`, `OPENAI_MODEL`) in imported dotenv files.

## Configuration precedence

Across interactive chat (`seb`), one-shot CLI commands (`seb ask`), diagnostics (`seb doctor`), and the chat connector server (`seb connectors`), Seb resolves settings in strict priority order from highest to lowest:

1. **Explicit CLI options** (such as `--provider`, `--model`, or `--offline`).
2. **Process environment variables (`process.env`)** exported in your shell, container, or service manager.
3. **Saved `~/.config/seb/` files**, loaded at startup (before telemetry/tracing initialization) as defaults for any unset environment variables.
4. **Built-in application defaults**.

Exporting an environment variable for one shell session overrides your saved configuration temporarily without mutating any file on disk.

## Storage layout and security (`~/.config/seb`)

By default, Seb stores persistent user data in `~/.config/seb`. You can relocate this directory in your shell environment via `SEB_CONFIG_HOME` or `XDG_CONFIG_HOME` (`$XDG_CONFIG_HOME/seb`), or override specific files with `SEB_PROFILE_FILE`, `SEB_MODEL_SETTINGS_FILE`, and `SEB_HISTORY_FILE`.

| Artifact | Purpose and stored contents |
| --- | --- |
| `settings.json` | Non-secret application settings (theme, icon mode, history/session toggles, `NWS_USER_AGENT`, Judgment tracing flags/org ID, and non-secret connector settings). |
| `model-settings.json` | Active model provider, primary and fallback model families or pinned IDs, and optional OpenAI-compatible base URL. |
| `credentials.json` | Provider API keys, `JUDGMENT_API_KEY`, and chat connector secrets (with compatible keys bound to their verified base URL). |
| `profile.json` | Optional Sleeper username, schema version, and last-updated timestamp. |
| `history.json` | Private prompt history (up to 200 unique prompts; disabled when `SEB_HISTORY=false`). |
| `sessions/<id>.json` | Resumable interactive conversation snapshots containing prompts, answers, tool calls/results, and source evidence (disabled when `SEB_SESSIONS=false` or `SEB_HISTORY=false`). |

Seb creates new configuration directories with permission mode `0700` and writes every file atomically with owner-only permission mode `0600`. The repository `.gitignore` excludes `.env` and `.env.*` (other than `.env.example`).

> [!WARNING]
> `credentials.json` and `sessions/<id>.json` rely on OS file permissions (`0600`) and are **not encrypted at rest**. Any process running under your OS user account can read them—never commit `~/.config/seb` files to version control or include them in shared backups.

## Judgment OpenTelemetry tracing

Seb supports optional OpenTelemetry trace export to [Judgment](https://judgmentlabs.ai) for evaluating multi-step agent runs, tool trajectories, and recommendation quality. Here is an example `.env` snippet pairing Gemini family defaults with Judgment tracing (replace `00000000-0000-0000-0000-000000000000` with `<your-judgment-org-id>`):

```dotenv
GOOGLE_GENERATIVE_AI_API_KEY=your-gemini-key
GEMINI_MODEL=gemini-flash
GEMINI_FALLBACK_MODEL=gemini-flash-lite
SEB_JUDGMENT_TRACING=true
JUDGMENT_API_KEY=your-judgment-key
JUDGMENT_ORG_ID=00000000-0000-0000-0000-000000000000
```

Key tracing behaviors and controls:

- **Explicit opt-in**: Judgment tracing is **off by default**. Saving `JUDGMENT_API_KEY` or `JUDGMENT_ORG_ID` alone never activates export—tracing starts only when `SEB_JUDGMENT_TRACING=true` (and both `JUDGMENT_API_KEY` and `JUDGMENT_ORG_ID` are present). Set `SEB_JUDGMENT_TRACING=false` to turn tracing off, or set `JUDGMENT_MONITORING=false` to disable Judgment monitoring spans.
- **Session grouping and payload cap**: Seb exports spans to project `seb` under your configured `JUDGMENT_ORG_ID`, tags multi-turn interactive and resumed conversations with `judgment.session_id` so related turns group cleanly, and caps root span output payloads at **128,000 characters** (`128k`).
- **Startup order**: Both CLI entrypoints and `seb connectors` load saved `~/.config/seb` settings before initializing the OpenTelemetry tracer, so saved Judgment settings apply seamlessly without extra wrapper scripts.

> [!IMPORTANT]
> **Privacy notice**: Enabling `SEB_JUDGMENT_TRACING=true` exports full user prompts, model responses, and tool inputs/outputs to your configured Judgment organization. Leave `SEB_JUDGMENT_TRACING=false` whenever conversations must remain strictly local.

## Extending supported settings

Supported configuration keys, editor groups, value validators, and secret classifications are defined centrally in `src/setup/configuration-registry.ts`. Registering a setting there automatically exposes it in `seb configure` and allows `seb configure --import-env` to validate and import it across hosted model providers, Judgment tracing, terminal preferences, data preferences, and chat connectors.
