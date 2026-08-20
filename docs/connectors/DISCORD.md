# Discord setup

Seb uses the Discord Gateway for mentions and direct messages.

The Gateway is a persistent WebSocket connection.

Discord publishes its current [Gateway guide](https://docs.discord.com/developers/events/gateway) and [interaction guide](https://docs.discord.com/developers/interactions/receiving-and-responding).

## 1. Create the Discord application

Open the [Discord Developer Portal](https://discord.com/developers/applications).

Select **New Application**.

Name the application `Seb`.

Open **General Information**.

Copy the application ID and the public key.

## 2. Create the bot user

Open **Bot** in the application settings.

Create the bot when Discord shows that option.

Select **Reset Token**.

Copy the bot token immediately.

Discord does not show the complete token again.

## 3. Enable the message intent

Open **Bot** and find **Privileged Gateway Intents**.

Enable **Message Content Intent**.

Seb needs message text for normal league questions.

Large verified bots can require Discord approval for this intent.

Read Discord's [Gateway intent rules](https://docs.discord.com/developers/events/gateway#gateway-intents) before a broad release.

## 4. Install the bot in a server

Open **OAuth2** and **URL Generator**.

Select the `bot` scope.

Select `applications.commands` when you plan to add Discord slash commands.

Grant these bot permissions.

- View Channels
- Send Messages
- Send Messages in Threads
- Create Public Threads
- Manage Threads
- Read Message History
- Add Reactions
- Attach Files

Open the generated URL.

Select one development server and approve the installation.

## 5. Configure Seb

Add these values to `.env`.

```dotenv
SEB_CONNECTORS=discord
DISCORD_APPLICATION_ID=replace-this-value
DISCORD_PUBLIC_KEY=replace-this-value
DISCORD_BOT_TOKEN=replace-this-value
SEB_DISCORD_GATEWAY=true
```

The public key is not secret.

Keep the bot token in a secret store.

## 6. Start and test

Start Seb.

```bash
npm run connectors
```

The process starts the HTTP service and the Discord Gateway loop.

Mention Seb in a server channel.

```text
@Seb compare the two rosters in Sleeper league 123456789
```

Send the bot a direct message for a second test.

The first Gateway connection can take several seconds.

## Optional interactions endpoint

Seb does not need an interactions endpoint for mentions or direct messages.

Set one when you add slash commands, buttons, or other interactions.

Use this endpoint.

```text
https://seb.example.com/webhooks/discord
```

Open **General Information** in the Discord application.

Paste the URL into **Interactions Endpoint URL**.

Discord sends a signed `PING` request to verify the URL.

The Discord adapter verifies the signature and returns the required response.

Discord sends interactions through either the endpoint or the Gateway.

The methods are mutually exclusive for interactions.

The Gateway still receives normal messages when an endpoint receives interactions.

## Gateway deployment requirements

Run the connector as a resident Node service.

Do not deploy the current Gateway loop as a short serverless function.

The service opens ten-minute Gateway sessions and reconnects after each session.

The service retries a failed connection after five seconds.

Set `REDIS_URL` when more than one service instance can receive webhooks.

Run only one Discord Gateway loop for this bot token.

## Optional channel-wide replies

The Discord adapter supports `DISCORD_RESPOND_TO_CHANNEL_IDS`.

This variable contains comma-separated parent channel IDs.

The adapter treats every non-bot message in those channels as a mention.

Use this setting only in dedicated Seb channels.

```dotenv
DISCORD_RESPOND_TO_CHANNEL_IDS=123456789012345678
```

## Troubleshooting

### The connector starts, but Seb receives no messages

Confirm that `SEB_DISCORD_GATEWAY` equals `true`.

Confirm that Message Content Intent is enabled.

Confirm that the bot can view the selected channel.

Check the service log for Gateway connection errors.

### Seb sees a mention, but the message text is empty

Enable Message Content Intent in the Developer Portal.

Restart the connector after the setting changes.

### Discord rejects the interactions endpoint

Confirm that `DISCORD_PUBLIC_KEY` contains the 64-character hexadecimal key.

Confirm that the endpoint does not redirect.

Confirm that a proxy preserves the original request body.

### Seb cannot reply inside a thread

Grant **Send Messages in Threads** and **Read Message History**.

Grant **Manage Threads** when Seb must update a thread title.

### Discord closes the Gateway

An invalid privileged intent can cause close code `4014`.

Enable the intent in the portal or remove that intent from the application design.
