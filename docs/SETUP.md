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

The Sleeper V0 uses public, read-only endpoints. It does not need a Sleeper token.

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

Do not commit `.env`. The project already ignores this file.

## 3. Verify Sleeper

Run the Sleeper smoke test.

```bash
npm run sleeper:smoke
```

This test reads the current NFL state.

The test does not call Gemini.

## 4. Verify Gemini

Run the complete diagnostic command.

```bash
npm run doctor
```

This command checks Node.js, the Gemini key, Gemini, and Sleeper.

The Gemini check sends one small request.

Use the offline check when you only want to verify local configuration.

```bash
npm run doctor -- --offline
```

Then ask one small question.

```bash
npm run ask -- "Show the current NFL state."
```

One-shot requests use `GEMINI_MODEL` first. They use `GEMINI_FALLBACK_MODEL` after a temporary capacity error.

## 5. Install the direct command

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

## 6. Ask league questions

Include the Sleeper league ID in each league request.

```bash
npm run ask -- "Analyze every roster in Sleeper league 123456789."
```

Use a user name when you do not know the league ID.

```bash
npm run ask -- "Find the Sleeper user arvind and list the user's 2026 NFL leagues."
```

Interactive chat can use a returned league ID in a later prompt.

## 7. Run the project checks

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

## 8. Start a chat connector

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
| `SEB_CONNECTORS` | Usually | Lists `slack`, `discord`, or `telegram`. |
| `SEB_BOT_NAME` | No | Sets the common bot name. The default is `seb`. |
| `HOST` | No | Sets the connector bind address. The default is `0.0.0.0`. |
| `PORT` | No | Sets the HTTP port. The default is `3000`. |
| `REDIS_URL` | Production | Enables persistent and shared connector state. |

Seb can auto-detect a connector from complete platform credentials.

Set `SEB_CONNECTORS` explicitly in production. This setting prevents an unused credential from enabling a platform.

## Common setup errors

### The Gemini key is empty

The command shows `The Google Generative AI API key is empty.`

Add the key to `.env`. Then restart the command.

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
