/* eslint-disable */
declare var require: any;
declare const process: any;

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

export const CONFIG_PATH = path.resolve(process.cwd(), 'config', 'channels.json');
export const LOGS_DIR = path.resolve(process.cwd(), 'logs');

export interface ChannelConfig {
  guildId: string;
  channelId: string;
  guildName?: string;
  channelName?: string;
}

/**
 * Read and flatten the grouped or legacy config into an array of ChannelConfig.
 * On error this function will log and exit (keeps behaviour consistent with original script).
 */
export function loadChannels(): ChannelConfig[] {
  try {
    const raw = fs.readFileSync(CONFIG_PATH, { encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('channels.json must contain a JSON array');
    }

    const flattened: ChannelConfig[] = [];

    for (const entry of parsed) {
      // grouped shape: { guild: "...", guildName?: "...", channels: [{ channel: "...", channelName?: "..." }, ...] }
      if (entry && typeof entry.guild === 'string' && Array.isArray(entry.channels)) {
        const guildId = String(entry.guild);
        const guildName = typeof entry.guildName === 'string' ? entry.guildName : undefined;
        for (const ch of entry.channels) {
          if (ch && typeof ch.channel === 'string') {
            flattened.push({
              guildId,
              channelId: ch.channel,
              guildName,
              channelName: typeof ch.channelName === 'string' ? ch.channelName : undefined,
            });
          } else {
            throw new Error('Each channel in channels[] must have a string "channel" field');
          }
        }
        continue;
      }

      // legacy flat shape: { guildId: "...", channelId: "..." }
      if (entry && typeof entry.guildId === 'string' && typeof entry.channelId === 'string') {
        flattened.push({
          guildId: entry.guildId,
          channelId: entry.channelId,
          guildName: typeof entry.guildName === 'string' ? entry.guildName : undefined,
          channelName: typeof entry.channelName === 'string' ? entry.channelName : undefined,
        });
        continue;
      }

      throw new Error('Invalid channel entry shape in config file');
    }

    logger.debug(`Loaded ${flattened.length} channel(s) from config`);
    return flattened;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to load channels from ${CONFIG_PATH} - ${msg}`);
    process.exit(1);
    return [];
  }
}