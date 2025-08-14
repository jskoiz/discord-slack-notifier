# discord-monitor

periodically queries discord for messages in one or
more channels and writes the messages to files in the `logs/` directory. Each
monitored channel produces a file named `<guildId>_<channelId>.json` containing
an array of simplified message objects. It's then forward to slack channel via webhook.

Quickstart
----------
1. Copy the example env and set your token(s):
   - Copy [`.env.example`](.env.example:1) → [`.env`](.env:1) and set the required keys.
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
  - If using a bot token, set it as `Bot <token>` in [`.env`](.env:1) (the script sends the raw value as provided).
- POLL_INTERVAL_MS (optional, default 3000) — milliseconds between poll runs for each channel.
- SLACK_WEBHOOK_URL (optional) — incoming webhook URL to forward notifications into Slack.
- SLACK_BOT_TOKEN and SLACK_SIGNING_SECRET (optional) — required only if you want the built-in Slack slash command (/lastmessage). If set, the app will attempt to start a small HTTP listener for the Slack bolt app.
- PORT (optional, default 3000) — port for Slack slash commands (if enabled).
- LOG_LEVEL (optional, default: info) — controls CLI/log verbosity. Valid values: `error`, `info`, `debug`.
- LOG_FORMAT (optional, default: text) — `text` or `json`.
- LOG_HEARTBEAT_MS (optional) — emit a periodic heartbeat INFO (when > 0).

Logging & verbosity (2025-08-14 update)
---------------------------------------
The project recently changed how verbose polling logs are emitted to make INFO-level output quieter during normal idle operation:

- Default behavior (LOG_LEVEL=info)
  - Per-channel "Polling <guild>/<channel>... no new messages" lines are now demoted to DEBUG, so they will not appear when LOG_LEVEL is `info`.
  - A single INFO summary is emitted once per poll interval (aligned to `POLL_INTERVAL_MS`) with the message:
    "Completed polling cycle for N channels in Xms"
    - N = number of channel polls completed in the most recent window
    - Xms = cumulative elapsed milliseconds spent in those polls
  - INFO logs are still emitted for:
    - Actual new messages (one INFO line per new message processed)
    - Errors and failures (always use ERROR)
  - This reduces noise when monitoring many channels while keeping meaningful activity visible.

- Debug behavior (LOG_LEVEL=debug)
  - You will see the detailed per-channel "no new messages" lines and other debug diagnostics in addition to the summary and INFO-level messages.

Slack message forwarding (2025-08-14 update)
--------------------------------------------
- Previously long Discord messages were truncated to 800 characters before sending to Slack.
- As of this update the monitor preserves full Discord message content and forwards it to Slack.
  - To respect Slack Block Kit text-object limits, messages are split into ~3000-character chunks and each chunk is sent as its own section block within the same webhook payload.
  - Multi-line messages are preserved and will be wrapped in code blocks for readability.
- Guild thumbnails & header layout:
  - The Slack notification header now includes a small left-aligned guild thumbnail (when available) inline with the guild/channel and author/time text using a Slack "context" block.
  - The icon is built from the Discord CDN using the guild ID and the guild icon hash (guildIcon). Animated icons (hashes starting with `a_`) are rendered as `.gif`; otherwise `.png` is used. Size is requested at 96px.
  - The monitor fetches and persistently stores a guild's icon hash during the enrichment step when WRITE_ENRICHED_CONFIG=true. Existing configs remain compatible; you can also add a "guildIcon" (icon hash) manually to your grouped config to enable thumbnails immediately.
  - If no guild icon is available, the header falls back to plain text without an image accessory.
- Notes:
  - Slack limits: roughly 3000 characters per text object and a maximum number of blocks per message (around 50). Extremely large single messages could exceed the block count; in that edge case the monitor may need to send multiple webhook messages (a future enhancement).
  - Restart required: after pulling these changes, restart the monitor process so the new behavior is active.

- Where the behavior is implemented
  - Formatting / Slack block assembly: [`src/index.ts`](src/index.ts:1) and [`src/poller.ts`](src/poller.ts:1)
  - Slack delivery and retry logic: [`src/index.ts`](src/index.ts:1) (sendToSlack)

- How to change or test
  - To test quieter INFO output:
    - LOG_LEVEL=info npm run start
    - Verify you see occasional INFO summaries and INFOs for new messages/errors, but not per-channel idle lines.
  - To see the noisy per-channel lines:
    - LOG_LEVEL=debug npm run start
  - To test full-message Slack forwarding:
    - Post a long message in a monitored Discord channel that previously would have been truncated.
    - Confirm the Slack webhook shows the full content (it may be split across multiple section blocks).
  - To disable the summary or change cadence, edit the poll-summary code in [`src/index.ts`](src/index.ts:1) or [`src/poller.ts`](src/poller.ts:1).

Security & sensitive files
-------------------------
- Do NOT commit secrets. The repository's `.gitignore` is updated to exclude:
  - [`.env`](.env:1)
  - [`baselines.json`](baselines.json:1)
  - [`config/channels.json`](config/channels.json:1)
  - [`logs/` and logs/*.json]
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
- 2025-08-14 — Slack: include guild thumbnails in the Slack header (left-aligned context block); enrichment now fetches and can persist "guildIcon" hashes to [`config/channels.json`](config/channels.json:1). Also: logging — demote idle per-channel "no new messages" to DEBUG and add a periodic INFO summary of polling cycles.
- 2025-08-11 — v0.1.0: grouped config shape, enrichment, improved logging.

License
-------
MIT