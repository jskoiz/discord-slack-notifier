/* eslint-disable */
declare var require: any;
declare const process: any;

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const { LOGS_DIR } = require('./config');
const baselines = require('./baselines');

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? '3000');

// Poll summary tracker: aggregate poll completions and durations and emit a single
// INFO-level summary every POLL_INTERVAL_MS. Individual per-channel "no new messages"
// lines are demoted to DEBUG so INFO-level stays quiet unless new activity/errors occur.
let _pollsCompletedSinceLastSummary = 0;
let _pollsTotalTimeMs = 0;
setInterval(() => {
  try {
    const count = _pollsCompletedSinceLastSummary;
    const total = _pollsTotalTimeMs;
    // reset counters for next window
    _pollsCompletedSinceLastSummary = 0;
    _pollsTotalTimeMs = 0;
    if (count > 0) {
      logger.info(`Completed polling cycle for ${count} channels in ${total}ms`);
    }
  } catch {
    // swallow - telemetry must not crash the app
  }
}, POLL_INTERVAL_MS);

/**
 * Simple timestamp formatter used in Slack messages.
 */
function formatTimestampToUTC(iso: string): string {
  try {
    const d = new Date(iso);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    const hh = String(d.getUTCHours()).padStart(2, '0');
    const mm = String(d.getUTCMinutes()).padStart(2, '0');
    return `${y}-${m}-${day} ${hh}:${mm} UTC`;
  } catch {
    return iso;
  }
}

/**
 * Build a very small Slack Block Kit payload for a Discord message.
 */
export function buildSlackBlocks(m: any, cfg: { guildId: string; channelId: string; guildName?: string; channelName?: string }): any[] {
  const authorLabel = m.author?.username ?? m.author?.id ?? 'unknown';
  const MAX_PREVIEW = 800;
  const preview = typeof m.content === 'string' ? (m.content.length > MAX_PREVIEW ? m.content.slice(0, MAX_PREVIEW) + '...' : m.content) : '(no text)';
  const discordLink = `https://discord.com/channels/${cfg.guildId}/${cfg.channelId}/${m.id}`;
  const headerText = `*New message in* *${cfg.guildName ?? cfg.guildId}/${cfg.channelName ?? cfg.channelId}*`;
  const timestampText = `_${formatTimestampToUTC(m.timestamp)}_`;
  const messageBlockText = preview.includes('\n') ? '```' + preview + '```' : preview;

  const blocks: any[] = [
    { type: 'section', text: { type: 'mrkdwn', text: `${headerText}\nFrom: ${authorLabel} ${timestampText}` } },
    { type: 'section', text: { type: 'mrkdwn', text: messageBlockText } },
    { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'View on Discord' }, url: discordLink }] },
  ];

  // minimal image handling
  const imageExt = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  if (Array.isArray(m.attachments)) {
    for (const a of m.attachments) {
      const url = a?.proxy_url ?? a?.url;
      const filename = a?.filename ?? '';
      const looksLikeImage = (typeof url === 'string' && imageExt.test(url)) || imageExt.test(filename);
      if (looksLikeImage && url) {
        blocks.splice(2, 0, { type: 'image', image_url: url, alt_text: filename || 'discord-image' });
      }
    }
  }

  return blocks;
}

/**
 * Post to Slack with basic retry/backoff and 429 handling.
 */
export async function sendToSlack(payloadOrText: string | { blocks: any[] }, maxAttempts = 4): Promise<void> {
  if (!SLACK_WEBHOOK_URL) return;
  const payload: any = typeof payloadOrText === 'string' ? { text: payloadOrText } : payloadOrText;
  let attempt = 0;
  let backoff = 1000;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      await axios.post(SLACK_WEBHOOK_URL, payload, { headers: { 'Content-Type': 'application/json' }, timeout: 10000 });
      return;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429) {
        const retryAfter = Number(err.response?.headers?.['retry-after']) || Math.ceil(backoff / 1000);
        await new Promise((r) => setTimeout(r, retryAfter * 1000));
      } else {
        await new Promise((r) => setTimeout(r, backoff));
        backoff *= 2;
      }
    }
  }
  logger.error(' Exceeded attempts to send Slack notification');
}

/**
 * Fetch latest message id for a channel (limit=1)
 */
export async function fetchLatestMessageId(channelId: string): Promise<string | undefined> {
  try {
    const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
    const resp = await axios.get(url, { headers: { Authorization: DISCORD_TOKEN }, params: { limit: 1 }, timeout: 10000 });
    const data = resp?.data;
    if (Array.isArray(data) && data.length > 0) return String(data[0].id);
    return undefined;
  } catch (err: any) {
    const s = err?.response?.status;
    if (s) {
      logger.error(` Failed to fetch latest message for ${channelId} - ${s} ${err.response?.statusText}`);
    } else {
      logger.error(` Failed to fetch latest message for ${channelId} - ${err?.message ?? String(err)}`);
    }
    return undefined;
  }
}

/**
 * Fetch a message by id
 */
export async function fetchMessageById(channelId: string, messageId: string): Promise<any | undefined> {
  try {
    const resp = await axios.get(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      headers: { Authorization: DISCORD_TOKEN },
      timeout: 10000,
    });
    return resp?.data;
  } catch (err: any) {
    // silent debug
    return undefined;
  }
}

/**
 * Ensure logs directory exists.
 */
function ensureLogsDir(): void {
  try {
    if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR, { recursive: true });
  } catch (err: any) {
    logger.error(` Failed to ensure logs directory - ${err?.message ?? String(err)}`);
    process.exit(1);
  }
}

/**
 * Write messages array to per-channel log file (append semantics).
 */
async function writeMessagesToFile(filePath: string, messages: any[]): Promise<void> {
  try {
    let existing: any[] = [];
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, { encoding: 'utf8' });
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) existing = parsed;
      } catch {
        // replace
      }
    }
    const combined = existing.concat(messages);
    fs.writeFileSync(filePath, JSON.stringify(combined, null, 2), { encoding: 'utf8' });
  } catch (err: any) {
    logger.error(` Failed to write messages to ${filePath} - ${err?.message ?? String(err)}`);
  }
}

/**
 * Poll a single channel configuration (flattened ChannelConfig)
 */
export function pollChannel(cfg: { guildId: string; channelId: string; guildName?: string; channelName?: string }): void {
  const { guildId, channelId } = cfg;
  const displayGuild = cfg.guildName ?? guildId;
  const displayChannel = cfg.channelName ?? channelId;
  const displayPrefix = `${displayGuild}/${displayChannel}`;

  let lastMessageId: string | undefined;

  // load baseline (prefers embedded config baseline, falls back to legacy file)
  try {
    const b = baselines.getBaseline(guildId, channelId);
    if (b && b.lastMessageId) {
      lastMessageId = String(b.lastMessageId);
      logger.debug(`Loaded baseline for ${displayPrefix}=${lastMessageId}`);
    }
  } catch (err: any) {
    logger.debug(`Could not read baseline for ${displayPrefix} - ${err?.message ?? String(err)}`);
  }

  const filePath = path.join(LOGS_DIR, `${guildId}_${channelId}.json`);

  async function doPoll(): Promise<void> {
    const pollStart = Date.now();
    try {
      // if no baseline try to establish quietly
      if (!lastMessageId) {
        const latest = await fetchLatestMessageId(channelId);
        if (latest) {
          lastMessageId = latest;
          const msgObj = await fetchMessageById(channelId, latest);
          const content = typeof msgObj?.content === 'string' ? msgObj.content : undefined;
          const timestamp = typeof msgObj?.timestamp === 'string' ? msgObj.timestamp : new Date().toISOString();
          baselines.setBaseline(guildId, channelId, { lastMessageId: latest, content, timestamp });
          logger.debug(`Baseline established for ${displayPrefix}=${latest}`);
        } else {
          logger.debug(`No baseline and no messages for ${displayPrefix}`);
        }
        return;
      }
  
      // fetch messages after lastMessageId
      const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
      const resp = await axios.get(url, { headers: { Authorization: DISCORD_TOKEN }, params: { after: lastMessageId, limit: 100 }, timeout: 15000 });
      const data = resp?.data;
      if (!Array.isArray(data)) return;
      if (data.length === 0) {
        // Demote noisy "no new messages" to DEBUG so INFO-level logs only show activity/errors.
        logger.debug(`Polling ${displayPrefix}... no new messages`);
        return;
      }
  
      const ordered = data.slice().reverse();
      const toSave: any[] = [];
      for (const msg of ordered) {
        const simple = {
          id: String(msg.id),
          author: { id: String(msg.author?.id ?? ''), username: typeof msg.author?.username === 'string' ? msg.author.username : null },
          content: typeof msg.content === 'string' ? msg.content : '',
          timestamp: String(msg.timestamp ?? new Date().toISOString()),
          attachments: Array.isArray(msg.attachments) ? msg.attachments.map((a: any) => ({ id: a?.id, url: a?.url, proxy_url: a?.proxy_url, filename: a?.filename, content_type: a?.content_type })) : undefined,
        };
        const authorLabel = simple.author.username ?? simple.author.id;
        const truncated = simple.content.length > 200 ? simple.content.slice(0, 200) + '...' : simple.content;
        logger.info(`${displayPrefix} ${authorLabel}: ${truncated}`);
        toSave.push(simple);
        lastMessageId = simple.id;
      }
  
      if (toSave.length > 0) {
        await writeMessagesToFile(filePath, toSave);
        const newest = toSave[toSave.length - 1];
        baselines.setBaseline(guildId, channelId, { lastMessageId: newest.id, content: newest.content, timestamp: newest.timestamp });
  
        // notify to Slack sequentially to preserve order
        for (const m of toSave) {
          try {
            const blocks = buildSlackBlocks(m, { guildId, channelId, guildName: cfg.guildName, channelName: cfg.channelName });
            // Diagnostic: log just before sending to Slack (helps detect duplicate senders)
            try {
              logger.debug(`sendToSlack: guildId=${guildId} channelId=${channelId} messageId=${m.id}`);
            } catch {
              // ignore logging failures
            }
            await sendToSlack({ blocks });
          } catch {
            // ignore notification errors
          }
        }
      }
    } catch (err: any) {
      const s = err?.response?.status;
      if (s) logger.error(` Failed to fetch ${displayPrefix} - ${s} ${err.response?.statusText}`);
      else logger.error(` Failed to fetch ${displayPrefix} - ${err?.message ?? String(err)}`);
    } finally {
      // Always track that a poll ran (successful or not) so the periodic summary can report activity.
      try {
        const elapsed = Date.now() - pollStart;
        _pollsCompletedSinceLastSummary += 1;
        _pollsTotalTimeMs += elapsed;
      } catch {
        // swallow
      }
    }
  }

  // staggered start
  const initialDelay = Math.floor(Math.random() * POLL_INTERVAL_MS);
  setTimeout(() => {
    doPoll().catch(() => {});
    setInterval(doPoll, POLL_INTERVAL_MS);
    logger.debug(`Started polling ${displayPrefix} every ${POLL_INTERVAL_MS}ms`);
  }, initialDelay);
}

/**
 * Enrich flattened channels with names (best-effort) and persist grouped config while preserving baselines.
 * This implementation is intentionally minimal: it will do lookups and write back a grouped config.
 */
export async function enrichAndPersistChannelNames(channels: any[]): Promise<void> {
  try {
    // build updated flattened list with attempted lookups
    const updated: any[] = [];
    for (const ch of channels) {
      const updatedCh = { ...ch };
      // fetch channel name
      try {
        const chResp = await axios.get(`https://discord.com/api/v10/channels/${ch.channelId}`, { headers: { Authorization: DISCORD_TOKEN }, timeout: 10000 });
        if (chResp?.data?.name) updatedCh.channelName = chResp.data.name;
      } catch {
        // ignore
      }
      // fetch guild name
      try {
        const gResp = await axios.get(`https://discord.com/api/v10/guilds/${ch.guildId}`, { headers: { Authorization: DISCORD_TOKEN }, timeout: 10000 });
        if (gResp?.data?.name) updatedCh.guildName = gResp.data.name;
      } catch {
        // ignore
      }
      updated.push(updatedCh);
    }

    // group
    const groupedMap: Record<string, any> = {};
    // read existing raw config to preserve baselines if present
    let rawConfig: any[] = [];
    try {
      const raw = fs.readFileSync(path.resolve(process.cwd(), 'config', 'channels.json'), { encoding: 'utf8' });
      rawConfig = JSON.parse(raw);
    } catch {
      rawConfig = [];
    }

    for (const c of updated) {
      if (!groupedMap[c.guildId]) groupedMap[c.guildId] = { guild: c.guildId, guildName: c.guildName, channels: [] };
      if (typeof c.guildName === 'string') groupedMap[c.guildId].guildName = c.guildName;

      // preserve baseline from raw config if present
      let preservedBaseline: any = undefined;
      try {
        for (const existingGuild of rawConfig) {
          if (String(existingGuild.guild) === String(c.guildId) && Array.isArray(existingGuild.channels)) {
            const found = existingGuild.channels.find((ch: any) => String(ch.channel) === String(c.channelId));
            if (found && found.baseline) {
              preservedBaseline = found.baseline;
              break;
            }
          }
        }
      } catch {
        preservedBaseline = undefined;
      }

      const channelEntry: any = { channel: c.channelId, channelName: c.channelName };
      if (preservedBaseline) channelEntry.baseline = preservedBaseline;
      groupedMap[c.guildId].channels.push(channelEntry);
    }

    const grouped = Object.keys(groupedMap).map((k) => groupedMap[k]);
    fs.writeFileSync(path.resolve(process.cwd(), 'config', 'channels.json'), JSON.stringify(grouped, null, 2), { encoding: 'utf8' });
    // update RAW_CONFIG in baselines module not necessary here; baselines.readConfig reads on demand
    logger.debug('Wrote enriched grouped channels config');
  } catch (err: any) {
    logger.error(` enrichAndPersistChannelNames failed - ${err?.message ?? String(err)}`);
  }
}

/**
 * Start monitors for all flattened channels.
 */
export async function startAll(channels: any[]): Promise<void> {
  ensureLogsDir();
  await enrichAndPersistChannelNames(channels);
  for (const ch of channels) {
    try {
      pollChannel(ch);
    } catch (err: any) {
      logger.error(` Monitor for ${ch.guildName ?? ch.guildId}/${ch.channelName ?? ch.channelId} failed to start - ${err?.message ?? String(err)}`);
    }
  }

  // Slack slash command setup (minimal): only if both env vars are present
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
  if (SLACK_BOT_TOKEN && SLACK_SIGNING_SECRET) {
    try {
      const { App } = require('@slack/bolt');
      const slackApp = new App({ token: SLACK_BOT_TOKEN, signingSecret: SLACK_SIGNING_SECRET });

      slackApp.command('/lastmessage', async (args: any) => {
        const { command, ack, respond } = args;
        await ack();
        const raw = (command.text || '').trim();
        if (!raw) {
          await respond({ response_type: 'ephemeral', text: 'Usage: /lastmessage <channelName|channelId|guildId|guildName>' });
          return;
        }
        const text = raw.toLowerCase();
        const matches = channels.filter((c: any) => {
          return (
            String(c.channelId).toLowerCase() === text ||
            String(c.channelName ?? '').toLowerCase() === text ||
            String(c.guildId).toLowerCase() === text ||
            String(c.guildName ?? '').toLowerCase() === text
          );
        });
        if (matches.length === 0) {
          await respond({ response_type: 'ephemeral', text: `No monitored channel matched "${raw}".` });
          return;
        }
        if (matches.length > 1) {
          const lines = matches.map((m: any) => `• ${m.guildName ?? m.guildId}/${m.channelName ?? m.channelId}`).join('\n');
          await respond({ response_type: 'ephemeral', text: `Multiple matches:\n${lines}` });
          return;
        }
        const target = matches[0];
        try {
          let baseline = baselines.getBaseline(target.guildId, target.channelId);
          if (!baseline || !baseline.lastMessageId) {
            const latestId = await fetchLatestMessageId(target.channelId);
            if (!latestId) {
              await respond({ response_type: 'ephemeral', text: `No messages found in ${target.guildName ?? target.guildId}/${target.channelName ?? target.channelId}` });
              return;
            }
            const message = await fetchMessageById(target.channelId, latestId);
            const author = message?.author?.username ?? message?.author?.id ?? 'unknown';
            const content = typeof message?.content === 'string' ? message.content : '(no content)';
            const timestamp = typeof message?.timestamp === 'string' ? message.timestamp : new Date().toISOString();
            baselines.setBaseline(target.guildId, target.channelId, { lastMessageId: latestId, content, timestamp });
            await respond({ response_type: 'ephemeral', text: `Baseline set. Last message by ${author} at ${timestamp}:\n${content}` });
            return;
          }

          const message = await fetchMessageById(target.channelId, String(baseline.lastMessageId));
          if (message) {
            const author = message?.author?.username ?? message?.author?.id ?? 'unknown';
            const content = typeof message?.content === 'string' ? message.content : '(no content)';
            const timestamp = typeof message?.timestamp === 'string' ? message.timestamp : baseline.timestamp ?? new Date().toISOString();
            baselines.setBaseline(target.guildId, target.channelId, { lastMessageId: String(baseline.lastMessageId), content, timestamp });
            await respond({ response_type: 'ephemeral', text: `Last message:\nBy ${author} at ${timestamp}:\n${content}` });
            return;
          }

          if (baseline && baseline.content) {
            await respond({ response_type: 'ephemeral', text: `Cached last message:\n${baseline.content}` });
            return;
          }

          await respond({ response_type: 'ephemeral', text: `Unable to retrieve last message.` });
        } catch (err: any) {
          await respond({ response_type: 'ephemeral', text: `Error fetching last message: ${err?.message ?? String(err)}` });
        }
      });

      (async () => {
        const port = Number(process.env.PORT ?? 3000);
        await slackApp.start(port);
        logger.debug(`Slack app started on port ${port}`);
      })().catch((e: any) => {
        logger.error(` Failed to start Slack app - ${e?.message ?? String(e)}`);
      });
    } catch (err: any) {
      // Slack bolt not available or failed - skip
      logger.debug(`Slack integration not available - ${err?.message ?? String(err)}`);
    }
  }
}