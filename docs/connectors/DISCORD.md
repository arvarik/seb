# Discord setup

Seb connects to Discord servers and direct messages over the persistent WebSocket **Discord Gateway** via `@chat-adapter/discord`, with an optional signed HTTP interactions route at `POST /webhooks/discord`. For platform specifics, see Discord's [Gateway documentation](https://docs.discord.com/developers/events/gateway) and [Interactions guide](https://docs.discord.com/developers/interactions/receiving-and-responding).

## Environment variables and configuration precedence

At startup, [`src/connectors/server.ts`](../../src/connectors/server.ts) calls `loadUserEnvironment(process.env, true)`, loading saved model, credential, and Sleeper settings from `seb configure` (`settings.json`, `credentials.json`, and `model-settings.json`) whenever those environment variables are unset. Explicit `process.env` variables always take precedence and must be used for Discord credentials, Gateway flags, and production secrets.

| Variable | Required | Default | Purpose |
| --- | --- | --- | --- |
| `SEB_CONNECTORS` | Optional if credentials set | Auto-detected | Include `discord` (for example `SEB_CONNECTORS=discord`). |
| `DISCORD_APPLICATION_ID` | Yes | — | Application ID from **General Information** in the Discord Developer Portal. |
| `DISCORD_PUBLIC_KEY` | Yes | — | 64-character Ed25519 hex public key used to verify `/webhooks/discord` interactions. |
| `DISCORD_BOT_TOKEN` | Yes | — | Secret bot token generated under **Bot -> Reset Token**. |
| `SEB_DISCORD_GATEWAY` | No | `true` | Starts the persistent outbound WebSocket Gateway listener for mentions, threads, and DMs. |
| `DISCORD_MENTION_ROLES` | No | Empty | Comma-separated Discord role IDs whose `<@&role_id>` mentions should trigger Seb. |
| `DISCORD_RESPOND_TO_CHANNEL_IDS` | No | Empty | Comma-separated parent channel IDs where every non-bot message acts as a mention. |
| `SEB_BOT_NAME` | No | `seb` | Display handle used by Chat SDK runtime configuration. |
| `NWS_USER_AGENT` | Recommended | Built-in fallback | Identifies your deployment on National Weather Service stadium weather lookups. |
| `REDIS_URL` | Production | Empty (in-memory) | Persists thread subscriptions, event claims, and queues across restarts or instances. |

## Step-by-step setup

### 1. Create the Discord application and bot user

Open the [Discord Developer Portal](https://discord.com/developers/applications), select **New Application**, and name it `Seb`. Copy the **Application ID** and **Public Key** from **General Information** (`DISCORD_APPLICATION_ID` and `DISCORD_PUBLIC_KEY`—the public key is not secret). Next, open **Bot**, create the bot user if prompted, select **Reset Token**, and store the generated `DISCORD_BOT_TOKEN` in a secret store immediately—Discord only displays the full token once.

### 2. Enable Message Content Intent

Under **Bot -> Privileged Gateway Intents**, enable **Message Content Intent** and save your changes.

> [!IMPORTANT]
> Seb requires **Message Content Intent** to read natural-language fantasy football questions in server channels and subscribed threads. Without it, Discord delivers mention events with an empty `text` body. Bots installed in 100 or more servers require Discord's privileged intent verification—see Discord's [Gateway intent rules](https://docs.discord.com/developers/events/gateway#gateway-intents).

### 3. Invite the bot to a server

Open **OAuth2 -> URL Generator**, select the `bot` scope (plus `applications.commands` if you plan to register Discord slash commands), and grant the following bot permissions:

- **View Channels** & **Read Message History** (required to see channels and read up to 40 messages of thread context)
- **Send Messages** & **Send Messages in Threads** (required to post chunked answers)
- **Create Public Threads** & **Manage Threads** (required to start and manage conversation threads)
- **Add Reactions** & **Attach Files**

Open the generated invite URL in your browser, choose a development server, and authorize the installation.

### 4. Configure and start Seb

Pass your Discord credentials alongside your model provider API key in your process environment (for example via `node --env-file=.env` locally or your secret manager in production; Seb does not auto-load `.env` files on its own):

```dotenv
SEB_CONNECTORS=discord
DISCORD_APPLICATION_ID=replace-this-value
DISCORD_PUBLIC_KEY=replace-this-value
DISCORD_BOT_TOKEN=replace-this-value
SEB_DISCORD_GATEWAY=true
```

```bash
npm run connectors
```

The process starts both the HTTP server and the Discord Gateway listener (initial WebSocket handshake can take a few seconds). Mention Seb in a channel—for example `@Seb compare the top two rosters in Sleeper league 123456789`—reply in the thread without re-mentioning `@Seb`, and send a direct message to verify DM routing.

## Delivery, chunking, and optional mention triggers

Discord caps standard bot messages at **2,000 characters** (`CONNECTOR_CHUNK_LIMITS.discord = 2_000`). Rather than truncating reports or risking platform formatting expansion, Seb triggers a Discord typing indicator, runs the agent and deterministic Decision Gate (with automatic single-retry recovery if live evidence is missing or stale) to completion, compacts up to **40** historical thread turns (`12,000`-character budget with prior `## Evidence` footers stripped), and posts plain-text chunks up to `2,000` characters without splitting `[label](url)` Markdown links.

You can customize how server channels trigger Seb using two optional `@chat-adapter/discord` environment variables:

- **Role mentions (`DISCORD_MENTION_ROLES`)**: Provide comma-separated role IDs (for example `DISCORD_MENTION_ROLES=123456789012345678,234567890123456789`) so tagging a shared role like `@Seb` or `@League Analyst` triggers a mention response just like tagging the bot user directly.
- **Dedicated Seb channels (`DISCORD_RESPOND_TO_CHANNEL_IDS`)**: Provide comma-separated parent channel IDs (for example `DISCORD_RESPOND_TO_CHANNEL_IDS=123456789012345678`) so every non-bot message in those dedicated channels is treated as a mention without requiring `@Seb`.

## Gateway architecture and optional interactions webhook

Run the Discord connector as a **resident Node service** rather than a short-lived serverless function. [`src/connectors/server.ts`](../../src/connectors/server.ts) runs 10-minute Gateway listener sessions (`DISCORD_GATEWAY_SESSION_MS`), automatically reconnects at the end of each session, and retries failed connections after 5 seconds (`DISCORD_RETRY_MS`).

> [!WARNING]
> Run only **one** active Discord Gateway listener (`SEB_DISCORD_GATEWAY=true`) per bot token to avoid duplicate event processing or Gateway session contention, and set `REDIS_URL` whenever multiple HTTP instances share state.

Seb does **not** require an HTTP endpoint for `@Seb` mentions, thread follow-ups, or direct messages. If you extend Seb with Discord slash commands, buttons, or modals, configure **General Information -> Interactions Endpoint URL** to `https://seb.example.com/webhooks/discord`. Seb's Discord adapter automatically verifies Discord's Ed25519 signature and answers the `PING` handshake; note that Discord routes interactions exclusively to either the Interactions Endpoint URL or the Gateway, while regular channel messages continue flowing over the Gateway.

## Troubleshooting

### Seb starts, but receives no messages or sees empty message text

Confirm `SEB_DISCORD_GATEWAY=true`, verify that **Message Content Intent** is enabled in the Discord Developer Portal (restart Seb after toggling intents), and check that the bot has **View Channels** permission in the target channel.

### Discord closes the Gateway with code `4014`

Close code `4014` (`Disallowed intent(s)`) indicates a privileged intent—typically **Message Content Intent**—was requested on the socket without being enabled (or approved) in the Discord Developer Portal. Enable the intent under **Bot -> Privileged Gateway Intents** and restart the service.

### Discord rejects the Interactions Endpoint URL

Confirm `DISCORD_PUBLIC_KEY` holds the exact 64-character hexadecimal public key from **General Information**, `/webhooks/discord` responds directly over HTTPS without redirects, and no upstream proxy modifies the raw request body before signature verification.

### Seb cannot reply inside a Discord thread

Grant **Send Messages in Threads** and **Read Message History** (plus **Create Public Threads** and **Manage Threads** if Seb creates or updates threads) in your server or channel permission overrides.
