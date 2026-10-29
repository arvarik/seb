# Security Policy

## Supported Versions

Security reports are accepted for the latest tagged release (`v1.1.x`) and the `main` branch. Older releases do not receive backported security patches—update to the latest release before verifying an issue.

| Version | Supported |
| --- | --- |
| `1.1.x` / `main` | Yes |
| `< 1.1.0` | No |

## Reporting a Vulnerability

> [!IMPORTANT]
> Never post exploit details, API keys, personal data, or private league data in a public issue.

1. Open a [GitHub issue](https://github.com/arvarik/seb/issues/new) titled **`Security contact request`** asking the maintainer for a private follow-up channel.
2. Once a private channel is established, share the affected version, reproduction steps, impact assessment, and any proposed fix.
3. Wait for coordinated disclosure before publishing technical details. If you do not receive an initial response, post a brief follow-up comment on the contact request.

For non-security bugs and feature requests, use the standard [issue tracker](https://github.com/arvarik/seb/issues).

## Local Credential & Data Boundaries

- **Private file permissions**: Saved credentials (`credentials.json`), settings (`settings.json`), model configuration (`model-settings.json`), history, and resumable sessions live in `~/.config/seb` (`0700` directory, `0600` files).
- **Endpoint binding**: OpenAI-compatible API keys are bound to their exact canonical origin and require HTTPS for non-loopback hosts.
- **No implicit `.env` loading**: Seb never auto-loads a working-directory `.env` file; imports require explicit review via `seb configure --import-env <path>`.
- **Metadata-only local telemetry**: Local SQLite usage records exclude prompts, answers, tool payloads, and secrets. Optional Judgment OpenTelemetry tracing stays disabled unless `SEB_JUDGMENT_TRACING=true` is explicitly configured.
