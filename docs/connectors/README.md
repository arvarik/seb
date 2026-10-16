# Connector setup guides

Choose one included connector.

- [Slack](SLACK.md) supports threads, direct messages, and native streaming.
- [Discord](DISCORD.md) supports mentions and direct messages through the Gateway.
- [Telegram](TELEGRAM.md) supports polling, reply-to-bot mentions, and verified webhooks.
- GroupMe (`GROUPME_BOT_ID` and `GROUPME_WEBHOOK_SECRET`) supports group mentions and subscribed threads through verified `/webhooks/groupme` callbacks.

Use [other platforms](OTHER_PLATFORMS.md) when Chat SDK already supplies another adapter.

Use [custom adapter development](CUSTOM_ADAPTER.md) when no suitable adapter exists.

## Long answers and failures

Discord replies use messages of at most 2,000 characters. Telegram replies use messages of at most 4,096 characters. GroupMe replies use messages of at most 1,000 characters.
Seb buffers these replies and sends plain text chunks after the answer completes without splitting markdown links. Each chunk preserves the report text and source URLs.
Slack retains its streaming replies.
Model failures include a safe explanation and a retry or configuration step. Seb excludes raw provider error details from replies.
