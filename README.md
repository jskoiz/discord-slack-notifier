# discord-monitor

periodically queries discord for messages in one or
more channels and writes the messages to files in the `logs/` directory. Each
monitored channel produces a file named `<guildId>_<channelId>.json` containing
an array of simplified message objects. It's then forward to slack channel via webhook.

Quickstart
----------
1. Copy the example env and set your token(s):
   - Copy [`.env.example`](.env.example:1) → `.env` and set the required keys.
2. Copy the example config into place:
   - Copy [`config/channels.example.json`](config/channels.example.json:1) → [`config/channels.json`](config/channels.json:1) and edit with your guild/channel ids.
3. Install dependencies:
   - npm install
4. Run in development:
   - npm run dev
5. Build and run for production:
   - npm run build
   - npm run start

Example config & baselines
-------------------------
The canonical config is the grouped form stored at [`config/channels.json`](config/channels.json:1).
Each guild entry contains a "channels" array. Channels may include an optional
"baseline" object with metadata about the last-seen message. The repository
includes a sample at [`config/channels.example.json`](config/channels.example.json:1).

Minimal grouped example:
[
  {
    "guild": "123456789012345678",
    "guildName": "My Guild",
    "channels": [
      {
        "channel": "987654321098765432",
        "channelName": "general",
        "baseline": {
          "lastMessageId": "1400000000000000000",
          "timestamp": "2025-01-01T00:00:00.000Z",
          "content": "Example baseline content"
        }
      }
    ]
  }
]

Environment variables
---------------------
- DISCORD_TOKEN (required)
  - The token used in the Authorization header when calling the Discord API.
  - If using a bot token, set it as `Bot <token>` in `.env` (the script sends the raw value as provided).
- POLL_INTERVAL_MS (optional, default 3000) — milliseconds between poll runs for each channel.
- SLACK_WEBHOOK_URL (optional) — incoming webhook URL to forward notifications into Slack.
- SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET (optional) — required only if you want the built-in Slack slash command (/lastmessage). If set, the app will attempt to start a small HTTP listener for the Slack bolt app.
- PORT (optional, default 3000) — port for Slack slash commands (if enabled).

Security & sensitive files
-------------------------
- Do NOT commit secrets. The repository's `.gitignore` is updated to exclude:
  - [`.env`](.env:1)
  - [`baselines.json`](baselines.json:1)
  - [`config/channels.json`](config/channels.json:1)
  - [`logs/` and logs/*.json] (per-channel logs)
- Keep [`config/channels.example.json`](config/channels.example.json:1) and [`.env.example`](.env.example:1) in the repo as non-sensitive examples.

Development & testing
---------------------
- Build:
  - npm run build
- Development run (hot reload):
  - npm run dev
- Static typing:
  - npx tsc --noEmit

Troubleshooting
---------------
- 401 Unauthorized: token invalid or lacks permissions.
- 403 Forbidden: token lacks permission to view the channel/guild.
- 429 Too Many Requests: reduce poll frequency or implement rate limit handling.

Changelog (high level)
----------------------
- 2025-08-11 — v0.1.0: grouped config shape, enrichment, improved logging.

License
-------
MIT