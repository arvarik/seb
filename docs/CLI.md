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

## Interactive chat

Start the full terminal interface.

```bash
seb
```

The interface keeps the conversation until you exit. It renders Markdown and Sleeper tool activity.

Use these controls.

| Key | Action |
| --- | --- |
| `Enter` | Send the current question. |
| `Up` and `Down` | Scroll the conversation. |
| `PageUp` and `PageDown` | Scroll one page. |
| `Ctrl+L` | Repaint the terminal. |
| `Escape` or `Ctrl+C` | Exit Seb. |

The interface expands the active tool card. It collapses older tool cards to reduce noise.

Seb hides model reasoning by default. It shows a compact reasoning card when the provider returns reasoning.

## Ask one question

Use `ask` when a shell script needs one answer.

```bash
seb ask "Show the current NFL state."
```

Seb streams answer text to standard output. An interactive terminal can show tool activity on standard error.

Use this option when you want no tool activity.

```bash
seb ask --no-progress "Show trending player adds."
```

Seb hides tool activity automatically when standard error does not connect to a terminal.

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
  "answer": "Sleeper reports the 2026 preseason.",
  "fallbackUsed": false,
  "finishReason": "stop",
  "model": "gemini-3.7-flash",
  "toolCalls": ["getNflState"],
  "usage": {
    "inputTokens": 1050,
    "outputTokens": 32
  }
}
```

The token values can be `null` when a provider does not return usage data.

Use the linked command for clean JSON. The standard npm command prints its own status lines.

If you do not use `npm link`, add the npm silent option.

```bash
npm --silent run ask -- --json "Show the current NFL state."
```

This example selects one field with `jq`.

```bash
seb ask --json "Show the current NFL state." | jq -r .answer
```

## Run diagnostics

Run the doctor after setup or after a credential change.

```bash
seb doctor
```

The doctor performs these checks.

1. It verifies Node.js 22 or newer.
2. It verifies that the Gemini key exists.
3. It reads the current Sleeper NFL state.
4. It sends one small Gemini test request.

Use the offline option when the computer has no network access.

```bash
seb doctor --offline
```

Use JSON for an installation script.

```bash
seb doctor --json
```

The doctor never prints the Gemini key.

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

One-shot mode retries a capacity failure before it prints answer text. JSON mode can always retry a capacity failure.

Interactive mode uses the selected primary model for the session. Restart with `--model` when that model has no capacity.

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
