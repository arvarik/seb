# Model Selection

[Documentation Hub](README.md) · [Setup Guide](SETUP.md) · [Persistent Configuration](CONFIGURATION.md) · [CLI Guide](CLI.md)

Seb supports **auto-updating model families** as well as **pinned exact model IDs** across Google Gemini, Anthropic, OpenAI, and OpenAI-compatible endpoints. Entering a family such as `gemini-flash` in `seb configure` selects the newest stable release in that provider's live catalog on startup, while an exact ID such as `gemini-3.7-flash` stays pinned until you change it.

## Provider families and defaults

| Provider | Supported model families | Primary default | Fallback default |
| --- | --- | --- | --- |
| **Google** | `gemini-flash`, `gemini-flash-lite`, `gemini-pro` | `gemini-flash` | `gemini-flash-lite` |
| **Anthropic** | `claude-sonnet`, `claude-haiku`, `claude-opus`, `claude-fable` | `claude-sonnet` | `claude-haiku` |
| **OpenAI** | `gpt`, `gpt-mini`, `gpt-nano`, `gpt-pro`, `gpt-luna`, `gpt-sol`, `gpt-terra`, `gpt-astra` | `gpt-luna` | `gpt-mini` |
| **OpenAI-compatible** | Endpoint-defined model IDs or aliases | Explicit ID required | Same as primary (unless set) |

On OpenAI, `gpt` tracks plain numeric releases (such as `gpt-5.5`), whereas class-suffixed families such as `gpt-luna` or `gpt-mini` track the newest stable release within that class. OpenAI-compatible endpoints define their own naming conventions, so Seb passes their model IDs and aliases unchanged without catalog rewriting. You can mix or match families and pinned IDs independently, or set primary and fallback to the same model to disable separate capacity fallback.

## Provider capabilities

Every supported provider runs the exact same projection models, lineup optimizer, Decision Gate verification checks, and **47 built-in first-class NFL newsrooms**. Google Gemini adds optional provider-native web grounding tools when broader coverage is needed:

| Capability | Google Gemini | Anthropic | OpenAI | OpenAI-compatible |
| --- | --- | --- | --- | --- |
| Sleeper, nflverse, and NWS read-only data tools | Yes | Yes | Yes | Yes (requires tool calling) |
| Ensemble projections, D/ST, waivers, trades, and Decision Gate | Yes | Yes | Yes | Yes |
| 47 built-in first-class NFL newsrooms (`searchFirstClassNews`) | Yes | Yes | Yes | Yes |
| Grounded Google Search fallback (`searchCurrentNews`) | Yes | — | — | — |
| Provider URL Context reader (`readWebPage`) | Yes | — | — | — |

> [!TIP]
> You do not lose verified NFL news when running Anthropic, OpenAI, or local compatible models—Seb queries its 47 built-in team, league, and beat newsrooms directly across every provider and validates article dates and URLs locally.

## Resolution timing and override precedence

Seb resolves model families and fallback settings consistently across every entrypoint while keeping session behavior predictable:

- **`seb configure`** resolves both primary and fallback selections against the provider catalog and completes a live 30-second verification test before saving the family names to `model-settings.json`.
- **`seb ask`** resolves configured model families at the start of each one-shot invocation.
- **Interactive chat (`seb` / `seb chat`)** resolves families once at startup and again whenever you run `/provider` or `/model`, keeping the resolved model ID stable for the rest of the session and displaying that exact ID in the header and usage telemetry.
- **Chat connectors (`seb connectors`)** populate unset `process.env` entries from saved `~/.config/seb/` defaults at server startup, resolve the configured model family on startup/first use, and **cache the resolved model after the first successful reply** so webhook responses avoid per-message catalog lookups.
- **`seb doctor --offline`** validates local configuration files and environment variables without making network requests to remote model catalogs.

### Provider-only vs. explicit model overrides

Switching **only the provider** (for example, `/provider google`, `seb ask --provider google`, or `SEB_MODEL_PROVIDER=google`) preserves that provider's distinct configured or default fallback family (`gemini-flash-lite`, `claude-haiku`, or `gpt-mini`) for rate-limit and capacity resilience. By contrast, specifying an **explicit model** for a session or command (`/model claude-sonnet` or `seb ask --model gemini-flash`) uses that model as its own fallback so targeted benchmarks and comparisons never silently switch tiers:

```bash
# Uses Google's primary (gemini-flash) + distinct fallback (gemini-flash-lite)
seb ask --provider google "Show the current NFL state."

# Pins both primary and fallback to the resolved gpt-luna model for this session
seb chat --provider openai --model gpt-luna
```

Inside interactive chat, `/model gemini-flash` or `/provider anthropic` applies only to the current session; run `seb configure` to persist changes across sessions.

## Catalog selection and OpenAI-compatible security rules

When resolving a hosted model family, Seb compares numeric release versions within that family, excludes preview, experimental, image, audio, and unrelated model variants, and uses snapshot dates only to break ties within the same release. Google candidates must also advertise text-generation support. Catalog discovery authenticates with your configured provider key, rejects HTTP redirects, and enforces a **10-second timeout** and **1 MiB total payload cap** across catalog pages. If discovery fails or finds no stable match, Seb surfaces an explicit error rather than guessing from a partial list—retry or specify exact model IDs to bypass catalog lookup.

> [!IMPORTANT]
> **OpenAI-compatible endpoint security**: Seb accepts only `http://` loopback origins (`localhost`, `127.0.0.1`, `::1`) or `https://` remote API base URLs. It rejects URLs ending in `/chat/completions`, `/completions`, `/models`, or `/responses`, strips/blocks embedded credentials, query strings, and URL fragments, refuses HTTP redirects on both `GET /models` discovery and generation calls, prompts for explicit confirmation before contacting a non-loopback origin in `seb configure`, and binds any saved compatible API key to its single canonical base URL in `credentials.json`. Compatible endpoints must support streaming responses and tool calls.

## Programmatic library usage

When embedding Seb's model layer in TypeScript, call synchronous `resolveModelProvider` first, then resolve model families asynchronously before instantiating the AI SDK language model:

```ts
const configured = resolveModelProvider({ environment: process.env });
const resolved = await resolveModelFamilies(configured);
const model = createProviderLanguageModel(resolved);
```

Low-level Gemini-only agent helpers keep exact fallback IDs for synchronous callers; pass a resolved `modelProvider` object whenever you want automatic family discovery. Catalog discovery follows the official [Google models API](https://ai.google.dev/api/models), [Anthropic models API](https://platform.claude.com/docs/en/api/models/list), and [OpenAI models API](https://developers.openai.com/api/reference/resources/models/methods/list).
