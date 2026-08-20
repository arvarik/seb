# Slack setup

Seb supports Slack webhooks and Slack Socket Mode.

Use Socket Mode for the quickest local test.

Use a public HTTPS webhook for a normal production deployment.

Slack publishes its current [app manifest reference](https://docs.slack.dev/reference/app-manifest/) and [Events API guide](https://docs.slack.dev/apis/events-api/).

## Local setup with Socket Mode

### 1. Create the Slack app

Open the [Slack app dashboard](https://api.slack.com/apps).

Select **Create New App** and **From an app manifest**.

Select the development workspace.

Paste [slack-socket-manifest.yaml](slack-socket-manifest.yaml).

Create the app.

### 2. Create the app token

Open **Basic Information**.

Find **App-Level Tokens**.

Create a token with the `connections:write` scope.

Copy the token. It starts with `xapp-`.

### 3. Install the app

Open **OAuth & Permissions**.

Select **Install to Workspace**.

Approve the requested bot scopes.

Copy the bot token. It starts with `xoxb-`.

### 4. Configure Seb

Add these values to `.env`.

```dotenv
SEB_CONNECTORS=slack
SEB_SLACK_MODE=socket
SLACK_BOT_TOKEN=xoxb-replace-this-value
SLACK_APP_TOKEN=xapp-replace-this-value
```

Socket Mode does not need `SLACK_SIGNING_SECRET` in this project.

### 5. Start and test

Start Seb.

```bash
npm run connectors
```

Invite the app to a test channel.

Mention it with a question.

```text
@Seb show the current NFL state
```

Send Seb a direct message to test the direct-message route.

## Production setup with an HTTPS webhook

### 1. Prepare the public URL

Deploy the connector service behind HTTPS.

The Slack request URL has this format.

```text
https://seb.example.com/webhooks/slack
```

Replace the domain in [slack-webhook-manifest.yaml](slack-webhook-manifest.yaml).

### 2. Create the Slack app

Open the [Slack app dashboard](https://api.slack.com/apps).

Create an app from the edited webhook manifest.

Slack sends a URL verification request to the connector route.

The Slack adapter returns the verification response.

### 3. Copy the credentials

Open **Basic Information** and copy the signing secret.

Open **OAuth & Permissions** and install the app.

Copy the bot token after the installation finishes.

### 4. Configure the deployment

Set these variables in the deployment secret store.

```dotenv
SEB_CONNECTORS=slack
SEB_SLACK_MODE=webhook
SLACK_BOT_TOKEN=xoxb-replace-this-value
SLACK_SIGNING_SECRET=replace-this-value
REDIS_URL=redis://replace-this-value
```

Restart the service after you change a secret.

### 5. Verify Slack events

Open **Event Subscriptions** in the Slack app.

Confirm that Slack marks the request URL as verified.

Confirm that the app subscribes to these events.

- `app_mention`
- `message.channels`
- `message.groups`
- `message.im`
- `message.mpim`

Slack requires `app_mentions:read` for `app_mention` events.

Slack requires `message.im` events for direct messages.

### 6. Test the production app

Check the health route.

```bash
curl https://seb.example.com/health
```

Invite the app to one channel.

Mention Seb in a new message.

Reply in the resulting thread without another mention.

Seb should answer both messages.

## Slack permissions

The included manifests request these permissions.

| Scope | Purpose |
| --- | --- |
| `app_mentions:read` | Receives channel mentions. |
| `channels:history` | Reads messages in joined public channels. |
| `channels:read` | Reads public channel information. |
| `chat:write` | Sends Seb responses. |
| `groups:history` | Reads messages in joined private channels. |
| `groups:read` | Reads private channel information. |
| `im:history` | Reads direct messages. |
| `im:read` | Reads direct-message channel information. |
| `mpim:history` | Reads group direct messages. |
| `mpim:read` | Reads group direct-message information. |
| `users:read` | Resolves Slack user information. |

Do not add `chat:write.public` unless Seb must post without joining channels.

## Troubleshooting

### Slack rejects the signature

The signing secret does not match the selected Slack app.

Copy `SLACK_SIGNING_SECRET` again. Then restart Seb.

Also confirm that the host clock has the correct time.

### Slack does not accept the request URL

Confirm that the URL uses HTTPS.

Confirm that `/webhooks/slack` reaches the Seb service without a redirect.

Confirm that a proxy preserves the original request body.

### Seb answers a mention but ignores thread replies

Confirm that Redis works in production.

The first mention stores a thread subscription in the state adapter.

Confirm that the manifest includes the correct `message.*` event for that conversation.

### Seb never receives channel messages

Invite the app to the channel.

Slack only sends events that the installed bot can access.

Check the event delivery logs in the Slack app dashboard.

### Socket Mode does not connect

Confirm that `SEB_SLACK_MODE` equals `socket`.

Confirm that `SLACK_APP_TOKEN` starts with `xapp-`.

Confirm that the app token includes `connections:write`.
