# Model selection

Run `seb configure` and enter a model family as the primary model. Seb tests the resolved model before it saves the family.

For example, `gemini-flash` selects the newest stable Flash version in the Google model catalog. A future stable version replaces it on the next startup.

An exact ID such as `gemini-3.7-flash` stays pinned. Seb does not rewrite existing saved IDs. Run `seb configure` to replace an existing ID with a family.

## Families and defaults

| Provider | Families | Primary default | Fallback default |
| --- | --- | --- | --- |
| Google | `gemini-flash`, `gemini-flash-lite`, `gemini-pro` | `gemini-flash` | `gemini-flash-lite` |
| Anthropic | `claude-sonnet`, `claude-haiku`, `claude-opus`, `claude-fable` | `claude-sonnet` | `claude-haiku` |
| OpenAI | `gpt`, `gpt-mini`, `gpt-nano`, `gpt-pro`, `gpt-luna`, `gpt-sol`, `gpt-terra`, `gpt-astra` | `gpt-luna` | `gpt-mini` |
| OpenAI-compatible | Use the endpoint's model IDs or aliases | Enter a model | Primary model |

`gpt` follows models with plain numeric IDs, such as `gpt-5.5`. Use `gpt-luna` or another listed class for models with that class suffix.

Compatible endpoints define their own naming rules. Seb sends their IDs and aliases unchanged. The endpoint controls updates for its aliases.

Enter the same family for primary and fallback to disable the separate capacity fallback. You can also pin either model independently.

## When Seb checks

- `seb configure` resolves both choices and tests the resolved model before saving.
- `seb ask` resolves the configuration for each invocation.
- Interactive chat resolves families at startup and on `/model` or `/provider` changes. One session keeps its selected version until a model switch.
- Connector replies resolve the environment configuration before each reply.
- `seb doctor --offline` reads the configuration without requesting the model catalog.

The model header and usage records show the resolved ID. Saved settings retain the family name.

```text
/model gemini-flash
/model claude-sonnet
```

Use the family for the active provider. To save a choice across sessions, run `seb configure`.

```bash
seb ask --provider google --model gemini-flash "Show the current NFL state."
seb chat --provider openai --model gpt-luna
```

## Selection rules and failures

Seb compares numeric versions within the selected family. It excludes preview, experimental, image, audio, and unrelated model variants. Snapshot versions break ties within a release.

Google candidates must support text generation. Discovery uses the configured provider key and rejects redirects. Seb allows ten seconds and at most 1 MiB across all catalog pages.

If discovery fails or no stable family member exists, Seb shows an error. It does not guess a version from a partial catalog. Retry or enter exact primary and fallback IDs to skip discovery.

A catalog entry does not guarantee that a generation request succeeds. Setup and interactive model switching test the resolved model before activation.

## Library use

The synchronous `resolveModelProvider` function selects configuration. Resolve families before creating an AI SDK model:

```ts
const configured = resolveModelProvider({ environment: process.env });
const resolved = await resolveModelFamilies(configured);
const model = createProviderLanguageModel(resolved);
```

The low-level Gemini-only agent defaults remain exact IDs for synchronous callers. Pass a resolved `modelProvider` to use family discovery.

## Provider references

Discovery follows the [Google models API](https://ai.google.dev/api/models), [Anthropic models API](https://platform.claude.com/docs/en/api/models/list), and [OpenAI models API](https://developers.openai.com/api/reference/resources/models/methods/list).
