/* eslint-disable */
declare var require: any;
declare const process: any;

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

export const CONFIG_PATH = path.resolve(process.cwd(), 'config', 'channels.json');
export const BASELINES_PATH = path.resolve(process.cwd(), 'baselines.json');

/**
 * Utility to build a consistent baseline key.
 */
export function baselineKey(guildId: string, channelId: string): string {
  return `${guildId}_${channelId}`;
}

/**
 * Read the grouped channels config from disk (non-fatal — returns [] on error).
 */
function readConfig(): any[] {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return [];
    const raw = fs.readFileSync(CONFIG_PATH, { encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    return [];
  } catch {
    return [];
  }
}

/**
 * Persist the grouped channels config back to disk.
 */
function writeConfig(obj: any[]): void {
  try {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(obj, null, 2), { encoding: 'utf8' });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to persist channels config - ${msg}`);
  }
}

/**
 * Find channel entry in a parsed grouped config.
 */
function findChannelInConfig(parsed: any[], guildId: string, channelId: string): { guildEntry?: any; channelEntry?: any } {
  if (!Array.isArray(parsed)) return {};
  for (const g of parsed) {
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
 * Get baseline for a channel.
 * - Prefer embedded baseline inside config/channels.json
 * - Fallback to legacy baselines.json (migration safety)
 */
export function getBaseline(guildId: string, channelId: string): any | undefined {
  try {
    const parsed = readConfig();
    const { channelEntry } = findChannelInConfig(parsed, guildId, channelId);
    if (channelEntry && channelEntry.baseline) return channelEntry.baseline;
  } catch {
    // ignore and fallback
  }

  // fallback to legacy baselines.json
  try {
    if (!fs.existsSync(BASELINES_PATH)) return undefined;
    const raw = fs.readFileSync(BASELINES_PATH, { encoding: 'utf8' });
    const parsed = JSON.parse(raw);
    const k = baselineKey(guildId, channelId);
    if (parsed && typeof parsed === 'object' && parsed[k]) return parsed[k];
  } catch {
    // ignore
  }
  return undefined;
}

/**
 * Set baseline for a channel by writing it into the grouped config (config/channels.json).
 * Creates guild/channel entries if they don't exist.
 */
export function setBaseline(guildId: string, channelId: string, entry: { lastMessageId: string; content?: string; timestamp?: string }): void {
  try {
    const parsed = readConfig();
    let guildObj = parsed.find((g: any) => String(g.guild) === String(guildId));
    if (!guildObj) {
      guildObj = { guild: guildId, channels: [] };
      parsed.push(guildObj);
    }
    if (!Array.isArray(guildObj.channels)) guildObj.channels = [];
    let ch = guildObj.channels.find((c: any) => String(c.channel) === String(channelId));
    if (!ch) {
      ch = { channel: channelId };
      guildObj.channels.push(ch);
    }
    ch.baseline = entry;
    writeConfig(parsed);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`Failed to set baseline in channels config - ${msg}`);
  }
}