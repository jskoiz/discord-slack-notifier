/**
 * discord-monitor
 *
 * Lightweight TypeScript script that polls specified Discord channels and persists
 * messages to per-channel log files in the logs/ directory.
 *
 * Key behaviors and notes:
 *
 * - Authentication:
 *   - The script reads a token from the DISCORD_TOKEN environment variable.
 *   - This token is provided directly as the Authorization header value.
 *     Previously a "Bot " prefix was used; that was removed so the raw token is
 *     passed. If you're using a bot token, the value should be "Bot <token>".
 *     If you're using a user token (not recommended), pass the raw token.
 *   - BE CAREFUL: storing or committing tokens is dangerous. .env is in .gitignore.
 *
 * - Configuration:
 *   - Channels to monitor are listed in config/channels.json as an array of objects:
 *     [
 *       {
 *         "guildId": "123456789012345678",
 *         "channelId": "987654321098765432",
 *         // optional, may be populated automatically by the script:
 *         "guildName": "My Guild",
 *         "channelName": "general"
 *       }
 *     ]
 *   - The script may enrich the config file with "guildName" and "channelName".
 *
 * - Environment variables:
 *   - DISCORD_TOKEN (required): the token used for Authorization.
 *   - POLL_INTERVAL_MS (optional): milliseconds between polls (default: 3000).
 *
 * - Logs and persistence:
 *   - Messages are appended to logs/<guildId>_<channelId>.json as an array.
 *   - The script ensures the logs directory exists on startup.
 *
 * - HTTP / API details:
 *   - This script uses discord.com API v10 endpoints.
 *   - If you encounter HTTP 401 responses:
 *     - Verify your DISCORD_TOKEN value and permissions.
 *     - Consider adding client-mimicking headers (User-Agent, Referer,
 *       X-Super-Properties, etc.). The README contains sample headers.
 *     - Note that using user tokens from non-official clients can be blocked by Discord.
 *
 * - Running:
 *   - npm install
 *   - Copy .env.example to .env and set DISCORD_TOKEN and optional POLL_INTERVAL_MS
 *   - npm run dev (development using ts-node-dev)
 *   - npm run build && npm run start (build then run dist/index.js)
 *
 * - Security & ethics:
 *   - Do not share or commit your token.
 *   - Ensure you have permission to access the guilds/channels being polled.
 *
 * - Where to change behavior:
 *   - Authorization header used in axios.get calls can be adjusted in:
 *     fetchLatestMessageId() and doPoll() (look for headers: { Authorization: ... }).
 *   - Enrichment that writes names back to config is implemented in
 *     enrichAndPersistChannelNames().
 *
 * - Development notes:
 *   - This file intentionally uses minimal external typing to keep the scaffold simple.
 *   - Errors returned by axios are handled defensively and logged.
 */
/* eslint-disable */
declare var require: any;
declare const process: any;

const dotenv = require('dotenv');
const axios = require('axios');
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');

// axios instance with keepAlive to reuse sockets and reduce "socket hang up" issues
const axiosInstance = axios.create({
  timeout: 15_000,
  httpAgent: new http.Agent({ keepAlive: true, maxSockets: 50 }),
  httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 50 }),
});

// Lightweight retry wrapper for transient network errors (ECONNRESET, ETIMEDOUT, EPIPE, "socket hang up", etc.)
async function requestWithRetries(method: string, url: string, opts: any = {}, maxAttempts = 3): Promise<any> {
  let attempt = 0;
  let backoff = 500;
  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      const config = Object.assign({}, opts, { method, url });
      return await axiosInstance.request(config);
    } catch (err: unknown) {
      const anyErr = err as any;
      const message = anyErr?.message ?? String(anyErr);
      const code = anyErr?.code ?? undefined;
      const shouldRetry =
        (typeof message === 'string' &&
          (message.includes('ECONNRESET') ||
            message.includes('ETIMEDOUT') ||
            message.includes('EPIPE') ||
            message.includes('socket hang up'))) ||
        code === 'ECONNRESET' ||
        code === 'ETIMEDOUT' ||
        code === 'EPIPE' ||
        code === 'ECONNABORTED';
      if (!shouldRetry || attempt >= maxAttempts) {
        throw err;
      }
      // jittered backoff
      await new Promise((r) => setTimeout(r, backoff + Math.floor(Math.random() * 200)));
      backoff *= 2;
    }
  }
  // In the unlikely case we exit loop without returning, throw to surface caller errors
  throw new Error('requestWithRetries: exceeded attempts without response');
}

dotenv.config();

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
const POLL_INTERVAL_MS = Number(process.env.POLL_INTERVAL_MS ?? '3000');
// When running under ts-node-dev (file watcher) we should avoid writing back to
// the watched config file during startup — otherwise the watcher will restart
// the process repeatedly. Detect common env vars used by dev runners.
const IS_DEV_WATCH = Boolean(process.env.TS_NODE_DEV || process.env.NODE_ENV === 'development');
// Control whether enriched/grouped config should be written back to disk.
// Make this opt-in to avoid triggering dev file-watchers (default: false).
const WRITE_ENRICHED_CONFIG = Boolean(process.env.WRITE_ENRICHED_CONFIG === 'true' || process.env.WRITE_ENRICHED_CONFIG === '1');

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
      logInfo(`Completed polling cycle for ${count} channels in ${total}ms`);
    }
  } catch {
    // swallow - telemetry must not crash the app
  }
}, POLL_INTERVAL_MS);

/**
 * Single-instance enforcement.
 *
 * Behavior:
 * - Uses a PID file at repository root ('.discord-monitor.pid').
 * - If the PID file contains other PIDs, attempts to terminate them (SIGTERM then SIGKILL).
 * - Writes current PID into the PID file and ensures cleanup on exit/signals.
 *
 * Rationale:
 * Prevents duplicate monitors from running (and sending duplicate notifications).
 */
const PID_PATH = path.resolve(process.cwd(), '.discord-monitor.pid');

function isProcessAlive(pid: number): boolean {
  try {
    // signal 0 does not kill the process; it throws if process does not exist or permission denied
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function tryTerminate(pid: number): void {
  try {
    // Prefer graceful shutdown first
    process.kill(pid, 'SIGTERM');
    logDebug(`Sent SIGTERM to PID=${pid}`);
  } catch (e) {
    logDebug(`SIGTERM failed for PID=${pid} - ${e instanceof Error ? e.message : String(e)}`);
  }
  try {
    // Force kill as a fallback
    process.kill(pid, 'SIGKILL');
    logDebug(`Sent SIGKILL to PID=${pid}`);
  } catch (e) {
    logDebug(`SIGKILL failed for PID=${pid} - ${e instanceof Error ? e.message : String(e)}`);
  }
}

function ensureSingleInstance(): void {
  try {
    // Read existing PIDs (allow multiple lines if present)
    if (fs.existsSync(PID_PATH)) {
      try {
        const raw = fs.readFileSync(PID_PATH, { encoding: 'utf8' });
        const parts = raw.split(/\s+/).filter(Boolean);
        for (const p of parts) {
          const pid = Number(p);
          if (!Number.isFinite(pid) || pid === process.pid) continue;
          if (isProcessAlive(pid)) {
            logInfo(`Found other instance PID=${pid}; attempting to terminate`);
            tryTerminate(pid);
          }
        }
      } catch (err: unknown) {
        logDebug(`Failed to read or parse PID file ${PID_PATH} - ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // Write our PID (overwrite). Keep single-line format for simplicity.
    try {
      fs.writeFileSync(PID_PATH, String(process.pid) + '\n', { encoding: 'utf8' });
      logDebug(`Wrote PID ${process.pid} to ${PID_PATH}`);
    } catch (err: unknown) {
      logError(`Failed to write PID file ${PID_PATH} - ${err instanceof Error ? err.message : String(err)}`);
    }

    // Cleanup handlers: remove pid file (or remove our pid from it) on exit/signals.
    const cleanup = () => {
      try {
        if (!fs.existsSync(PID_PATH)) return;
        const cur = fs.readFileSync(PID_PATH, { encoding: 'utf8' });
        const remaining = cur
          .split(/\s+/)
          .filter(Boolean)
          .filter((s: string) => s !== String(process.pid));
        if (remaining.length > 0) {
          fs.writeFileSync(PID_PATH, remaining.join('\n') + '\n', { encoding: 'utf8' });
        } else {
          fs.unlinkSync(PID_PATH);
        }
        logDebug(`Cleaned up PID file ${PID_PATH} for PID=${process.pid}`);
      } catch {
        // swallow - do not throw from cleanup
      }
    };

    process.on('exit', cleanup);
    // handle common termination signals
    ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'].forEach((sig) => {
      try {
        process.on(sig as any, () => {
          cleanup();
          // re-raise default behavior by exiting
          try {
            process.exit(0);
          } catch {
            // swallow
          }
        });
      } catch {
        // some signals may not be available on all platforms; ignore
      }
    });
  } catch (err: unknown) {
    logDebug(`ensureSingleInstance failed - ${err instanceof Error ? err.message : String(err)}`);
  }
}

function logInfo(message: string): void {
  logger.info(message);
}

function logDebug(message: string): void {
  logger.debug(message);
}

function logError(message: string): void {
  logger.error(message);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * Format an ISO timestamp into "YYYY-MM-DD HH:mm UTC" (no seconds).
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
 * Build a Slack Block Kit payload (array of blocks) for a Discord message.
 * - Prefix author with "From: <username>"
 * - Normalize timestamp to "YYYY-MM-DD HH:mm UTC"
 * - Remove the redundant context link (we keep only the action button)
 * - Embed image attachments (Slack image blocks) when present and appear to be images
 */
function buildSlackBlocks(
  m: DiscordMessage,
  cfg: { guildId: string; channelId: string; guildName?: string; guildIcon?: string; channelName?: string }
): any[] {
  const authorLabel = m.author.username ?? m.author.id;

  // Discord link to the message in a guild: https://discord.com/channels/<guildId>/<channelId>/<messageId>
  const discordLink = `https://discord.com/channels/${cfg.guildId}/${cfg.channelId}/${m.id}`;

  const headerText = `*New message in* *${cfg.guildName ?? cfg.guildId}/${cfg.channelName ?? cfg.channelId}*`;
  const timestampText = `_${formatTimestampToUTC(m.timestamp)}_`;

  // Author line requested as "From: <username>"
  const authorLine = `From: ${authorLabel}`;

  // Slack Block Kit text size limit for block text objects is roughly 3000 chars.
  // To preserve full Discord messages we split long content into multiple section blocks.
  const SLACK_TEXT_LIMIT = 3000;

  function splitIntoChunks(s: string, size: number): string[] {
    const out: string[] = [];
    let i = 0;
    while (i < s.length) {
      out.push(s.slice(i, i + size));
      i += size;
    }
    return out;
  }

  const rawContent = typeof m.content === 'string' ? m.content : '';
  const contentToDisplay = rawContent.length > 0 ? rawContent : '(no text)';
  const hasNewlines = contentToDisplay.includes('\n');

  // Split content into Slack-safe chunks
  const chunks = splitIntoChunks(contentToDisplay, SLACK_TEXT_LIMIT);

  const blocks: any[] = [];
  if (cfg.guildIcon) {
    const ext = String(cfg.guildIcon).startsWith('a_') ? 'gif' : 'png';
    const iconUrl = `https://cdn.discordapp.com/icons/${cfg.guildId}/${cfg.guildIcon}.${ext}?size=96`;
    blocks.push({
      type: 'context',
      elements: [
        { type: 'image', image_url: iconUrl, alt_text: cfg.guildName ?? 'guild' },
        {
          type: 'mrkdwn',
          text: `${headerText}\n*${authorLine}* ${timestampText}`,
        },
      ],
    });
  } else {
    blocks.push({
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `${headerText}\n*${authorLine}* ${timestampText}`,
        },
      ],
    });
  }

  // Add one section block per chunk. If original message had newlines, wrap each chunk in a code block
  for (const chunk of chunks) {
    const text = hasNewlines ? '```' + chunk + '```' : chunk;
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text,
      },
    });
  }

  // If there are attachments, and they look like images, add image blocks after the message blocks.
  const imageExt = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
  if (Array.isArray(m.attachments) && m.attachments.length > 0) {
    for (const a of m.attachments) {
      const url = a?.proxy_url ?? a?.url;
      const filename = a?.filename ?? '';
      const looksLikeImage = (typeof url === 'string' && imageExt.test(url)) || imageExt.test(filename);
      if (looksLikeImage && url) {
        blocks.push({
          type: 'image',
          image_url: url,
          alt_text: filename || 'discord-image',
        });
      }
    }
  }

  // Actions row with button (keep only the button; omit the extra context link)
  blocks.push({
    type: 'actions',
    elements: [
      {
        type: 'button',
        text: { type: 'plain_text', text: 'View on Discord' },
        url: discordLink,
      },
    ],
  });

  return blocks;
}

/**
 * Send a Slack webhook payload. Accepts either a plain text string (fallback) or an object
 * containing blocks (Block Kit). Retries with exponential backoff and respects 429 Retry-After.
 */
async function sendToSlack(payloadOrText: string | { blocks: any[] }, maxAttempts = 4): Promise<void> {
  if (!SLACK_WEBHOOK_URL) {
    logDebug('SLACK_WEBHOOK_URL not set; skipping Slack notification');
    return;
  }

  const payload: any = typeof payloadOrText === 'string' ? { text: payloadOrText } : payloadOrText;
  let attempt = 0;
  let backoff = 1000;

  while (attempt < maxAttempts) {
    attempt += 1;
    try {
      // Use the retry-capable request helper (this will apply keepAlive agent)
      await requestWithRetries('post', SLACK_WEBHOOK_URL, { data: payload, headers: { 'Content-Type': 'application/json' } }, maxAttempts);
      logDebug('Sent notification to Slack');
      return;
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 429) {
        const retryAfter = Number(err.response?.headers?.['retry-after']) || Math.ceil(backoff / 1000);
        logDebug(`Slack rate-limited (429). Retry after ${retryAfter}s`);
        await sleep(retryAfter * 1000);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        logDebug(`Failed sending Slack notification (attempt ${attempt}) - ${msg}`);
        await sleep(backoff);
        backoff *= 2;
      }
    }
  }

  logError('Exceeded attempts to send Slack notification');
}

if (!DISCORD_TOKEN) {
  logError('DISCORD_TOKEN is missing. Copy .env.example to .env and set DISCORD_TOKEN.');
  process.exit(1);
}

const CONFIG_PATH = path.resolve(process.cwd(), 'config', 'channels.json');
const LOGS_DIR = path.resolve(process.cwd(), 'logs');

interface ChannelConfig {
  guildId: string;
  channelId: string;
  guildName?: string;
  guildIcon?: string;
  channelName?: string;
}

/**
 * New grouped config shape (persisted form):
 *
 * [
 *   {
 *     "guild": "<guildId>",
 *     "guildName": "<optional guild name>",
 *     "channels": [
 *       { "channel": "<channelId>", "channelName": "<optional name>" },
 *       ...
 *     ]
 *   },
 *   ...
 * ]
 */
interface RawGuildEntry {
  guild: string;
  guildName?: string;
  guildIcon?: string;
  channels: { channel: string; channelName?: string }[];
}

/**
 * Keep a copy of the parsed raw config in memory (so we can persist back a
 * grouped form after enrichment). This is populated in loadChannels().
 */
let RAW_CONFIG: any[] = [];

interface DiscordMessage {
  id: string;
  author: {
    id: string;
    username: string | null;
  };
  content: string;
  timestamp: string;
  // Optional attachments payload captured from Discord (if present).
  attachments?: { id?: string; url?: string; proxy_url?: string; filename?: string; content_type?: string }[];
}

function loadChannels(filePath: string): ChannelConfig[] {
  try {
    const raw = fs.readFileSync(filePath, { encoding: 'utf8' });
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      throw new Error('channels.json must contain a JSON array');
    }

    // Keep a copy of the original parsed config for later persistence
    RAW_CONFIG = parsed as any[];

    const flattened: ChannelConfig[] = [];

    for (const entry of RAW_CONFIG) {
      const obj = entry as any;

      // Support new grouped guild-based shape:
      // { guild: "...", guildName?: "...", guildIcon?: "...", channels: [{ channel: "..." , channelName?: "..." }, ...] }
      if (typeof obj.guild === 'string' && Array.isArray(obj.channels)) {
        const guildId = obj.guild;
        const guildName = typeof obj.guildName === 'string' ? obj.guildName : undefined;
        const guildIcon = typeof obj.guildIcon === 'string' ? obj.guildIcon : undefined;
        for (const ch of obj.channels) {
          if (typeof ch.channel === 'string') {
            flattened.push({
              guildId,
              channelId: ch.channel,
              guildName,
              guildIcon,
              channelName: typeof ch.channelName === 'string' ? ch.channelName : undefined,
            } as ChannelConfig);
          } else {
            throw new Error('Each channel in channels[] must have a string "channel" field');
          }
        }
        continue;
      }

      // Support legacy flat shape:
      // { guildId: "...", channelId: "...", guildIcon?: "..." }
      if (typeof obj.guildId === 'string' && typeof obj.channelId === 'string') {
        flattened.push({
          guildId: obj.guildId,
          channelId: obj.channelId,
          guildName: typeof obj.guildName === 'string' ? obj.guildName : undefined,
          guildIcon: typeof obj.guildIcon === 'string' ? obj.guildIcon : undefined,
          channelName: typeof obj.channelName === 'string' ? obj.channelName : undefined,
        } as ChannelConfig);
        continue;
      }

      throw new Error('Invalid channel entry shape in config file');
    }

    logDebug(`Loaded ${flattened.length} channel(s) from config`);
    return flattened;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Failed to load channels from ${filePath} - ${msg}`);
    // exit as scaffold expects - keep behavior predictable
    process.exit(1);
    // satisfy TypeScript return checks (unreachable)
    return [];
  }
}

const channels = loadChannels(CONFIG_PATH);
try {
  // Startup diagnostics: PID and flattened channels summary
  logInfo(`Process PID=${process.pid} starting with ${channels.length} channel(s)`);
  try {
    const flatSummary = channels.map((c) => ({
      guildId: c.guildId,
      channelId: c.channelId,
      guildName: c.guildName ?? null,
      channelName: c.channelName ?? null,
    }));
    logDebug(`Flattened channels: ${JSON.stringify(flatSummary)}`);
    const keys = channels.map((c) => `${c.guildId}_${c.channelId}`).join(', ');
    logDebug(`Channel baseline keys: ${keys}`);
  } catch {
    // swallow any logging serialization issues
  }
} catch {
  // keep startup diagnostics non-fatal
}

async function enrichAndPersistChannelNames(): Promise<void> {
  const updated: ChannelConfig[] = [];

  // Diagnostic: announce start of enrichment at info level so startup activity is visible.
  try {
    logInfo(`Starting channel name enrichment for ${channels.length} channel(s)`);
  } catch {
    // ignore logging failures
  }

  // Enrich flattened channels with names where possible.
  for (const ch of channels) {
    const updatedCh: ChannelConfig = { ...ch };
    try {
      logInfo(`Enriching names for ${ch.guildId}/${ch.channelId}`);
    } catch {
      // ignore
    }

    // fetch channel name
    try {
      const chResp = await requestWithRetries('get', `https://discord.com/api/v10/channels/${ch.channelId}`, {
        headers: { Authorization: DISCORD_TOKEN },
      }, 3);
      if (chResp && (chResp as any).data && typeof (chResp as any).data.name === 'string') {
        updatedCh.channelName = (chResp as any).data.name;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebug(`Failed to fetch channel name for ${ch.channelId} - ${msg}`);
    }

    // fetch guild name and icon (if available)
    try {
      const gResp = await requestWithRetries('get', `https://discord.com/api/v10/guilds/${ch.guildId}`, {
        headers: { Authorization: DISCORD_TOKEN },
      }, 3);
      if (gResp && (gResp as any).data) {
        const gd = (gResp as any).data;
        if (typeof gd.name === 'string') updatedCh.guildName = gd.name;
        if (typeof gd.icon === 'string') updatedCh.guildIcon = gd.icon;
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebug(`Failed to fetch guild name/icon for ${ch.guildId} - ${msg}`);
    }

    try {
      logInfo(
        `Enriched ${ch.guildId}/${ch.channelId} -> guildName=${updatedCh.guildName ?? 'n/a'} channelName=${updatedCh.channelName ?? 'n/a'}`
      );
    } catch {
      // ignore
    }

    updated.push(updatedCh);
  }

  // Group updated flattened channels into the guild-centric config shape
const groupedMap: Record<string, RawGuildEntry> = {};
  for (const c of updated) {
    if (!groupedMap[c.guildId]) {
      groupedMap[c.guildId] = {
        guild: c.guildId,
        guildName: c.guildName,
        guildIcon: c.guildIcon,
        channels: [],
      };
    }
    // Prefer any newly fetched guildName/guildIcon
    if (typeof c.guildName === 'string') {
      groupedMap[c.guildId].guildName = c.guildName;
    }
    if (typeof c.guildIcon === 'string') {
      groupedMap[c.guildId].guildIcon = c.guildIcon;
    }

    // Preserve any existing baseline from RAW_CONFIG if present
    let preservedBaseline: any = undefined;
    try {
      for (const existingGuild of RAW_CONFIG) {
        if (String(existingGuild.guild) === String(c.guildId) && Array.isArray(existingGuild.channels)) {
          const found = existingGuild.channels.find((ch: any) => String(ch.channel) === String(c.channelId));
          if (found && found.baseline) {
            preservedBaseline = found.baseline;
            break;
          }
        }
      }
    } catch {
      // ignore
    }

    const channelEntry: any = {
      channel: c.channelId,
      channelName: c.channelName,
    };
    if (preservedBaseline) channelEntry.baseline = preservedBaseline;

    groupedMap[c.guildId].channels.push(channelEntry);
  }

  const grouped: RawGuildEntry[] = Object.keys(groupedMap).map((k) => groupedMap[k]);

  try {
    if (WRITE_ENRICHED_CONFIG) {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(grouped, null, 2), { encoding: 'utf8' });
      logDebug(`Wrote enriched (grouped) channels config with names to ${CONFIG_PATH}`);
      try {
        logInfo(`Finished enrichment and wrote ${Object.keys(groupedMap).length} guild(s) to ${CONFIG_PATH}`);
      } catch {
        // ignore
      }
    } else {
      logDebug(`Skipping writing enriched grouped channels config to disk (WRITE_ENRICHED_CONFIG not set)`);
      try {
        logInfo(`Finished enrichment (not written to disk) — set WRITE_ENRICHED_CONFIG=true to persist changes`);
      } catch {
        // ignore
      }
    }
    // ensure in-memory flattened channels reflect the enriched names
    channels.splice(0, channels.length, ...updated);
    // keep RAW_CONFIG in sync with the new grouped form (useful if other code reads it)
    RAW_CONFIG = grouped as any[];
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Failed to write enriched channels config - ${msg}`);
  }
}

// ensure logs directory exists
try {
  if (!fs.existsSync(LOGS_DIR)) {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
  }
} catch (err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  logError(`Failed to ensure logs directory - ${msg}`);
  process.exit(1);
}

async function fetchLatestMessageId(channelId: string): Promise<string | undefined> {
  const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
  try {
    const resp = await requestWithRetries('get', url, { headers: { Authorization: DISCORD_TOKEN }, params: { limit: 1 } }, 3);
    const data = (resp && (resp as any).data) as any[];
    if (Array.isArray(data) && data.length > 0) {
      return String(data[0].id);
    }
    return undefined;
  } catch (err: any) {
    if (err && err.response) {
      logError(`Failed to fetch latest message for channel ${channelId} - ${err.response.status} ${err.response.statusText}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to fetch latest message for channel ${channelId} - ${msg}`);
    }
    return undefined;
  }
}

const BASELINES_PATH = path.resolve(process.cwd(), 'baselines.json');

function baselineKey(guildId: string, channelId: string): string {
  return `${guildId}_${channelId}`;
}

/**
 * Find a channel entry in the in-memory RAW_CONFIG (channels.json grouped form).
 * Returns the guild entry and the channel entry if found.
 */
function findChannelEntryInRaw(guildId: string, channelId: string): { guildEntry?: any; channelEntry?: any } {
  if (!Array.isArray(RAW_CONFIG)) return {};
  for (const g of RAW_CONFIG) {
    if (g && String(g.guild) === String(guildId) && Array.isArray(g.channels)) {
      for (const ch of g.channels) {
        if (String(ch.channel) === String(channelId)) {
          return { guildEntry: g, channelEntry: ch };
        }
      }
    }
  }
  return {};
}

/**
 * getBaseline now prefers baselines embedded in config/channels.json (RAW_CONFIG).
 * For migration safety we fallback to the legacy baselines.json if no baseline is present in the config.
 */
function getBaseline(guildId: string, channelId: string): any | undefined {
  // Read embedded baseline (config/channels.json / RAW_CONFIG) if present
  let embedded: any | undefined;
  try {
    const { channelEntry } = findChannelEntryInRaw(guildId, channelId);
    if (channelEntry && channelEntry.baseline) embedded = channelEntry.baseline;
  } catch {
    // ignore and continue to legacy fallback
  }

  // Read legacy baselines.json if present
  let legacy: any | undefined;
  try {
    if (fs.existsSync(BASELINES_PATH)) {
      const raw = fs.readFileSync(BASELINES_PATH, { encoding: 'utf8' });
      const parsed = JSON.parse(raw);
      const k = baselineKey(guildId, channelId);
      if (parsed && typeof parsed === 'object' && parsed[k]) legacy = parsed[k];
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logDebug(`Failed to read legacy baselines.json - ${msg}`);
  }

  // If both exist, choose the most recent by timestamp when available.
  // This avoids repeatedly re-processing the same messages when channels.json
  // contains an older baseline but baselines.json has been updated.
  if (embedded && legacy) {
    try {
      const eTs = typeof embedded.timestamp === 'string' ? Date.parse(embedded.timestamp) : NaN;
      const lTs = typeof legacy.timestamp === 'string' ? Date.parse(legacy.timestamp) : NaN;
      if (!isNaN(eTs) && !isNaN(lTs)) {
        return lTs >= eTs ? legacy : embedded;
      }
      // If only one has a valid timestamp, prefer that one
      if (!isNaN(lTs) && isNaN(eTs)) return legacy;
      if (!isNaN(eTs) && isNaN(lTs)) return embedded;
    } catch {
      // fallthrough to prefer legacy as a safe default
    }
    // Prefer legacy baseline when timestamps are not comparable — it's the store
    // the runtime currently persists to by default (when WRITE_ENRICHED_CONFIG is false).
    return legacy;
  }

  // If only one exists, return it; otherwise undefined.
  return embedded ?? legacy ?? undefined;
}

function persistConfig(): void {
  try {
    if (IS_DEV_WATCH) {
      logDebug('Skipping persistConfig write to config/channels.json in dev watch mode');
      return;
    }
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(RAW_CONFIG, null, 2), { encoding: 'utf8' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Failed to persist channels config with baselines - ${msg}`);
  }
}

/**
 * setBaseline writes the baseline into RAW_CONFIG (config/channels.json) and persists that file.
 * It will create guild/channel entries if they do not exist.
 */
function setBaseline(guildId: string, channelId: string, entry: { lastMessageId: string; content?: string; timestamp?: string }): void {
  try {
    // Always update in-memory RAW_CONFIG so runtime can read latest baseline immediately.
    let guildObj = RAW_CONFIG.find((g: any) => String(g.guild) === String(guildId));
    if (!guildObj) {
      guildObj = { guild: guildId, channels: [] };
      RAW_CONFIG.push(guildObj);
    }
    if (!Array.isArray(guildObj.channels)) guildObj.channels = [];
    let ch = guildObj.channels.find((c: any) => String(c.channel) === String(channelId));
    if (!ch) {
      ch = { channel: channelId };
      guildObj.channels.push(ch);
    }
    ch.baseline = entry;

    // Persist baseline to disk.
    // - If WRITE_ENRICHED_CONFIG is true we persist the grouped RAW_CONFIG back to config/channels.json
    //   (this may trigger file-watchers; opt-in).
    // - Otherwise persist only to a legacy baselines.json file (safe for dev/watchers).
    if (WRITE_ENRICHED_CONFIG) {
      persistConfig();
    } else {
      try {
        // Write per-channel baseline to a small key->entry map in baselines.json.
        let existing: any = {};
        if (fs.existsSync(BASELINES_PATH)) {
          try {
            const raw = fs.readFileSync(BASELINES_PATH, { encoding: 'utf8' });
            existing = JSON.parse(raw) || {};
          } catch {
            existing = {};
          }
        }
        const k = baselineKey(guildId, channelId);
        existing[k] = entry;
        fs.writeFileSync(BASELINES_PATH, JSON.stringify(existing, null, 2), { encoding: 'utf8' });
        logDebug(`Persisted baseline for ${guildId}/${channelId} to legacy baselines.json`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logError(`Failed to persist baseline to ${BASELINES_PATH} - ${msg}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logError(`Failed to set baseline in channels config - ${msg}`);
  }
}

async function fetchMessageById(channelId: string, messageId: string): Promise<any | undefined> {
  try {
    const resp = await requestWithRetries('get', `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
      headers: { Authorization: DISCORD_TOKEN },
    }, 3);
    return (resp && (resp as any).data) as any;
  } catch (err: any) {
    if (err && err.response) {
      logDebug(`Failed to fetch message ${messageId} for ${channelId} - ${err.response.status}`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      logDebug(`Failed to fetch message ${messageId} for ${channelId} - ${msg}`);
    }
    return undefined;
  }
}

async function pollChannel(cfg: ChannelConfig): Promise<void> {
  const { guildId, channelId } = cfg;
  // Friendly display strings prefer human-readable names when available.
  const displayGuild = cfg.guildName ?? guildId;
  const displayChannel = cfg.channelName ?? channelId;
  const displayPrefix = `${displayGuild}/${displayChannel}`;
  let lastMessageId: string | undefined = undefined;

  // Try to pick up from baseline file if present
  try {
    const baseline = getBaseline(guildId, channelId);
    if (baseline && baseline.lastMessageId) {
      lastMessageId = String(baseline.lastMessageId);
      logDebug(`Loaded baseline from store for ${displayPrefix} lastMessageId=${lastMessageId}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logDebug(`Could not read baseline store for ${displayPrefix} - ${msg}`);
  }

  // If no baseline in store, try to establish via API
  if (!lastMessageId) {
    try {
      const fetched = await fetchLatestMessageId(channelId);
      if (fetched) {
        lastMessageId = fetched;
        // attempt to fetch message content to store as baseline metadata
        const msgObj = await fetchMessageById(channelId, fetched);
        const content = typeof msgObj?.content === 'string' ? msgObj.content : undefined;
        const timestamp = typeof msgObj?.timestamp === 'string' ? msgObj.timestamp : new Date().toISOString();
        setBaseline(guildId, channelId, { lastMessageId: fetched, content, timestamp });
        logDebug(`Baseline established for ${displayPrefix} lastMessageId=${lastMessageId} (persisted)`);
      } else {
        logDebug(`No baseline message for ${displayPrefix}; will wait for first poll to set baseline`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Error establishing baseline for ${guildId}/${channelId} - ${msg}`);
    }
  }

  const filePath = path.join(LOGS_DIR, `${guildId}_${channelId}.json`);

  async function writeMessagesToFile(messages: DiscordMessage[]): Promise<void> {
    try {
      let existing: DiscordMessage[] = [];
      if (fs.existsSync(filePath)) {
        try {
          const raw = fs.readFileSync(filePath, { encoding: 'utf8' });
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            existing = parsed as DiscordMessage[];
          } else {
            logDebug(`Existing log file ${filePath} malformed - replacing`);
          }
        } catch {
          logDebug(`Failed to parse existing log file ${filePath} - replacing`);
        }
      }
      const combined = existing.concat(messages);
      fs.writeFileSync(filePath, JSON.stringify(combined, null, 2), { encoding: 'utf8' });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logError(`Failed to write messages to ${filePath} - ${msg}`);
    }
  }

  async function doPoll(): Promise<void> {
    const pollStart = Date.now();
    try {
      const url = `https://discord.com/api/v10/channels/${channelId}/messages`;
      const params: Record<string, string | number> = lastMessageId ? { after: lastMessageId, limit: 100 } : { limit: 1 };
      try {
        const resp = await requestWithRetries('get', url, { headers: { Authorization: DISCORD_TOKEN }, params }, 3);
        const data = (resp && (resp as any).data) as any[];
        if (!Array.isArray(data)) {
          logDebug(`Polling ${displayPrefix} returned unexpected data`);
          return;
        }
    
        if (!lastMessageId) {
          // set baseline quietly if possible
          if (data.length > 0) {
            lastMessageId = String(data[0].id);
            // persist baseline with content if available
            const msgObj = data[0];
            const content = typeof msgObj?.content === 'string' ? msgObj.content : undefined;
            const timestamp = typeof msgObj?.timestamp === 'string' ? msgObj.timestamp : new Date().toISOString();
            setBaseline(guildId, channelId, { lastMessageId: lastMessageId, content, timestamp });
            logDebug(`Set initial lastMessageId for ${displayPrefix} = ${lastMessageId} (persisted)`);
          } else {
            logDebug(`Polling ${displayPrefix}... no messages to establish baseline`);
          }
          return;
        }
    
        if (data.length === 0) {
          // Demote noisy "no new messages" to DEBUG so INFO-level logs only show activity/errors.
          logDebug(`Polling ${displayPrefix}... no new messages`);
          return;
        }
    
        // Discord returns newest->oldest; process oldest->newest
        const ordered = data.slice().reverse();
        const toSave: DiscordMessage[] = [];
        for (const msg of ordered) {
          const simple: DiscordMessage = {
            id: String(msg.id),
            author: {
              id: String(msg.author?.id ?? ''),
              username: typeof msg.author?.username === 'string' ? msg.author.username : null,
            },
            content: typeof msg.content === 'string' ? msg.content : '',
            timestamp: String(msg.timestamp ?? new Date().toISOString()),
            attachments: Array.isArray(msg.attachments)
              ? msg.attachments.map((a: any) => ({
                  id: a?.id,
                  url: a?.url,
                  proxy_url: a?.proxy_url,
                  filename: a?.filename,
                  content_type: a?.content_type,
                }))
              : undefined,
          };
          // CLI info log (condensed, one line) for actual new messages only
          const authorLabel = simple.author.username ?? simple.author.id;
          const truncated = simple.content.length > 200 ? simple.content.slice(0, 200) + '...' : simple.content;
          logInfo(`${displayPrefix} ${authorLabel}: ${truncated}`);
          toSave.push(simple);
          lastMessageId = simple.id;
        }
    
        if (toSave.length > 0) {
          await writeMessagesToFile(toSave);
          logDebug(`Persisted ${toSave.length} message(s) for ${guildId}/${channelId}`);
    
          // update baseline to the newest message we processed
          const newest = toSave[toSave.length - 1];
          setBaseline(guildId, channelId, { lastMessageId: newest.id, content: newest.content, timestamp: newest.timestamp });
    
          // Send each new message to Slack (one Slack message per Discord message)
          for (const m of toSave) {
            try {
              // Build a Block Kit payload for richer formatting and a link back to Discord
              const blocks = buildSlackBlocks(m, {
                guildId,
                channelId,
                guildName: cfg.guildName,
                guildIcon: cfg.guildIcon,
                channelName: cfg.channelName,
              });
              // Diagnostic: log just before sending to Slack (helps detect duplicate senders)
              try {
                logDebug(`sendToSlack: guildId=${guildId} channelId=${channelId} messageId=${m.id}`);
              } catch {
                // ignore logging failures
              }
              // await to keep order and let sendToSlack honor rate-limits/retries
              await sendToSlack({ blocks });
            } catch (err: unknown) {
              logDebug('Error while sending Slack notification for a message');
            }
          }
        }
      } catch (err: unknown) {
        const anyErr = err as any;
        if (anyErr && anyErr.response) {
          logError(`Failed to fetch ${displayPrefix} - ${anyErr.response.status} ${anyErr.response.statusText}`);
        } else {
          const msg = err instanceof Error ? err.message : String(err);
          logError(`Failed to fetch ${displayPrefix} - ${msg}`);
        }
      }
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

  // Staggered start: pick a random initial delay in range [0, POLL_INTERVAL_MS)
  const initialDelay = Math.floor(Math.random() * POLL_INTERVAL_MS);
  try {
    logInfo(`Scheduling polling for ${displayPrefix} in ${initialDelay}ms (every ${POLL_INTERVAL_MS}ms)`);
  } catch {
    // ignore logging failures
  }
  setTimeout(() => {
    try {
      logInfo(`Starting initial poll for ${displayPrefix}`);
    } catch {
      // ignore
    }
    // Perform one poll after the staggered delay, then install the regular interval.
    // Report success/failure of the initial poll but always install the interval.
    doPoll()
      .then(() => {
        try {
          logInfo(`Initial poll completed for ${displayPrefix}`);
        } catch {}
      })
      .catch(() => {
        try {
          logInfo(`Initial poll errored for ${displayPrefix} (see logs)`);
        } catch {}
      })
      .finally(() => {
        setInterval(doPoll, POLL_INTERVAL_MS);
        try {
          logInfo(`Started polling ${displayPrefix} every ${POLL_INTERVAL_MS}ms (initial delay ${initialDelay}ms)`);
        } catch {}
        // Keep the previous debug-level message for compatibility
        logDebug(`Started polling ${displayPrefix} every ${POLL_INTERVAL_MS}ms (initial delay ${initialDelay}ms)`);
      });
  }, initialDelay);
}

// Kick off monitors after attempting to enrich channels with names
enrichAndPersistChannelNames().then(() => {
  for (const ch of channels) {
    // fire-and-forget
    pollChannel(ch).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      const display = `${ch.guildName ?? ch.guildId}/${ch.channelName ?? ch.channelId}`;
      logError(`Monitor for ${display} failed to start - ${msg}`);
    });
  }

  //
  // Slack Bolt integration (slash command) - initialize only if env present
  //
  const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN;
  const SLACK_SIGNING_SECRET = process.env.SLACK_SIGNING_SECRET;
  // Lazy require to avoid adding a hard runtime dependency if not used
  if (SLACK_BOT_TOKEN && SLACK_SIGNING_SECRET) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { App } = require('@slack/bolt');
      const slackApp = new App({
        token: SLACK_BOT_TOKEN,
        signingSecret: SLACK_SIGNING_SECRET,
      });

      // /lastmessage <channelName|channelId|guildId|guildName>
      // Use a single `args` parameter typed as `any` to avoid implicit `any` on destructured params
      slackApp.command('/lastmessage', async (args: any) => {
        const { command, ack, respond } = args;
        await ack();
        const raw = (command.text || '').trim();
        if (!raw) {
          await respond({
            response_type: 'ephemeral',
            text: 'Usage: /lastmessage <channelName|channelId|guildId|guildName>\nExample: /lastmessage notis',
          });
          return;
        }
 
        // try to match by channelId, channelName, guildId, or guildName (case-insensitive)
        const text = raw.toLowerCase();
        const matches = channels.filter((c) => {
          return (
            c.channelId.toLowerCase() === text ||
            (c.channelName ?? '').toLowerCase() === text ||
            c.guildId.toLowerCase() === text ||
            (c.guildName ?? '').toLowerCase() === text
          );
        });
 
        if (matches.length === 0) {
          await respond({
            response_type: 'ephemeral',
            text: `No monitored channel matched "${raw}". Try a channelName or channelId from config.`,
          });
          return;
        }
 
        if (matches.length > 1) {
          const lines = matches.map((m) => `• ${m.guildName ?? m.guildId}/${m.channelName ?? m.channelId}`).join('\n');
          await respond({
            response_type: 'ephemeral',
            text: `Multiple monitored channels matched "${raw}". Be more specific:\n${lines}`,
          });
          return;
        }
 
        const target = matches[0];
        const key = baselineKey(target.guildId, target.channelId);
        let baseline = getBaseline(target.guildId, target.channelId);
 
        try {
          if (!baseline || !baseline.lastMessageId) {
            // No baseline: query latest message (even if in the past) and persist it
            const latestId = await fetchLatestMessageId(target.channelId);
            if (!latestId) {
              await respond({ response_type: 'ephemeral', text: `No messages found in ${target.guildName ?? target.guildId}/${target.channelName ?? target.channelId}` });
              return;
            }
            const message = await fetchMessageById(target.channelId, latestId);
            const author = message?.author?.username ?? message?.author?.id ?? 'unknown';
            const content = typeof message?.content === 'string' ? message.content : '(no content)';
            const timestamp = typeof message?.timestamp === 'string' ? message.timestamp : new Date().toISOString();
            setBaseline(target.guildId, target.channelId, { lastMessageId: latestId, content, timestamp });
            await respond({
              response_type: 'ephemeral',
              text: `Baseline set for ${target.guildName ?? target.guildId}/${target.channelName ?? target.channelId}\nLast message by ${author} at ${timestamp}:\n${content}`,
            });
            return;
          }
 
          // Baseline exists; try to fetch the stored message by id for up-to-date content
          const message = await fetchMessageById(target.channelId, String(baseline.lastMessageId));
          if (message) {
            const author = message?.author?.username ?? message?.author?.id ?? 'unknown';
            const content = typeof message?.content === 'string' ? message.content : '(no content)';
            const timestamp = typeof message?.timestamp === 'string' ? message.timestamp : baseline.timestamp ?? new Date().toISOString();
            // refresh stored baseline with any minor metadata change
            setBaseline(target.guildId, target.channelId, { lastMessageId: String(baseline.lastMessageId), content, timestamp });
            await respond({
              response_type: 'ephemeral',
              text: `Last message for ${target.guildName ?? target.guildId}/${target.channelName ?? target.channelId}\nBy ${author} at ${timestamp}:\n${content}`,
            });
            return;
          }
 
          // Could not fetch by id; fall back to stored baseline content if present
          if (baseline && baseline.content) {
            await respond({
              response_type: 'ephemeral',
              text: `Last known message for ${target.guildName ?? target.guildId}/${target.channelName ?? target.channelId} (cached):\n${baseline.content}`,
            });
            return;
          }
 
          await respond({
            response_type: 'ephemeral',
            text: `Unable to retrieve last message for ${target.guildName ?? target.guildId}/${target.channelName ?? target.channelId}`,
          });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          await respond({ response_type: 'ephemeral', text: `Error fetching last message: ${msg}` });
        }
      });

      (async () => {
        const port = Number(process.env.PORT ?? 3000);
        await slackApp.start(port);
        logDebug(`Slack app started and listening for slash commands on port ${port}`);
      })().catch((e) => {
        const msg = e instanceof Error ? e.message : String(e);
        logError(`Failed to start Slack app - ${msg}`);
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logDebug(`Slack integration not available - ${msg}`);
    }
  } else {
    logDebug('SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET not set; skipping Slack slash command setup');
  }
}).catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  logDebug(`Channel/guild enrichment failed - ${msg}`);
  // start monitors anyway
  for (const ch of channels) {
    pollChannel(ch).catch((err: unknown) => {
      const msg2 = err instanceof Error ? err.message : String(err);
      const display = `${ch.guildName ?? ch.guildId}/${ch.channelName ?? ch.channelId}`;
      logError(`Monitor for ${display} failed to start - ${msg2}`);
    });
  }
});

export {}; // keep file as module scope