/**
 * Notification Services
 *
 * Handles Discord DMs, follow-up messages, and auto-cleanup.
 */

import { MessageFlags } from 'discord.js';
import { AUTO_CLEANUP_DEFAULT_MS } from '../config/constants.js';
import { logger } from '../utils/logger.js';

const DEFAULT_SELKIES_DIRECT_URL_TEMPLATE = 'https://{ipDash}.sslip.io';
const DEFAULT_SELKIES_CENTRAL_URL_TEMPLATE = 'https://{serverHost}.dedi.halo2stats.org';
const DEFAULT_XLINK_URL_TEMPLATE = 'http://{ip}:34522';

function dnsSafeLabel(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
}

function renderConnectionUrlTemplate(template, details = {}) {
  const normalizedTemplate = String(template || '').trim();
  if (!normalizedTemplate) {
    return null;
  }

  const values = {
    ip: details.ip || '',
    ipDash: details.ip ? String(details.ip).replace(/\./g, '-') : '',
    serverId: details.serverId || '',
    serverHost: dnsSafeLabel(details.serverHost || details.serverId || details.serverName),
    serverName: details.serverName || '',
    hostname: details.hostname || '',
    friendlyHostname: details.friendlyHostname || ''
  };
  let missingValue = false;

  const rendered = normalizedTemplate.replace(/\{([A-Za-z0-9_]+)\}/g, (match, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) {
      return match;
    }

    if (!values[key]) {
      missingValue = true;
    }

    return values[key];
  });

  return missingValue ? null : rendered;
}

export function buildSelkiesUrl(details = {}) {
  const defaultTemplate = process.env.SELKIES_CENTRAL_PROXY_ENABLED === '1' ||
    process.env.SELKIES_OAUTH_ENABLED === '1'
    ? DEFAULT_SELKIES_CENTRAL_URL_TEMPLATE
    : DEFAULT_SELKIES_DIRECT_URL_TEMPLATE;

  return renderConnectionUrlTemplate(
    process.env.SELKIES_URL_TEMPLATE || defaultTemplate,
    details
  );
}

export function buildXlinkUrl(details = {}) {
  return renderConnectionUrlTemplate(
    process.env.XLINK_URL_TEMPLATE || DEFAULT_XLINK_URL_TEMPLATE,
    details
  );
}

/**
 * Send a follow-up message (ephemeral by default)
 *
 * @param {Object} interaction - Discord interaction
 * @param {string|Object} contentOrOptions - Message content or options object
 * @param {Object} options - Additional options
 * @param {boolean} options.ephemeral - Whether the message should be ephemeral (default: true)
 * @param {number} options.deleteAfterMs - Auto-delete delay for non-ephemeral messages
 */
export async function sendAutoCleanupFollowUp(
  interaction,
  contentOrOptions,
  { ephemeral = true, deleteAfterMs = AUTO_CLEANUP_DEFAULT_MS } = {}
) {
  try {
    const options = typeof contentOrOptions === 'string'
      ? { content: contentOrOptions }
      : { ...contentOrOptions };

    // Add ephemeral flag if requested
    if (ephemeral) {
      options.flags = MessageFlags.Ephemeral;
    }

    const followUp = await interaction.followUp(options);

    // Schedule deletion
    setTimeout(async () => {
      try {
        await followUp.delete();
      } catch (error) {
        // Message may already be deleted
      }
    }, deleteAfterMs);

    return followUp;
  } catch (error) {
    if (error.code === 10062) {
      logger.debug('Interaction expired');
      return null;
    }
    throw error;
  }
}

/**
 * Send server creation DM to user
 */
export async function sendServerCreationDM(user, details) {
  try {
    const { serverName, serverId, hostname, friendlyHostname, snapshotLabel, region, ip, elapsedMinutes } = details;
    const selkiesUrl = buildSelkiesUrl(details);
    const xlinkUrl = buildXlinkUrl(details);
    const identityLines = [
      serverId ? `> Server ID: \`${serverId}\`` : null,
      hostname ? `> Hostname: \`${hostname}\`` : null,
      friendlyHostname ? `> Friendly Name: \`${friendlyHostname}\`` : null,
      snapshotLabel ? `> Snapshot: \`${snapshotLabel}\`` : null
    ].filter(Boolean).join('\n');
    const connectionLines = [
      selkiesUrl ? `> Selkies: ${selkiesUrl}` : null,
      xlinkUrl ? `> XLink Kai: ${xlinkUrl}` : null,
      ip ? `> IP Address: \`${ip}\`` : null
    ].filter(Boolean).join('\n');
    const selkiesLoginLines = [
      details.selkiesUsername ? `> Username: \`${details.selkiesUsername}\`` : null,
      details.selkiesPassword ? `> Password: \`${details.selkiesPassword}\`` : null
    ].filter(Boolean).join('\n');
    const showSelkiesPassword = process.env.SELKIES_OAUTH_ENABLED !== '1' &&
      process.env.SELKIES_CENTRAL_PROXY_ENABLED !== '1';

    const message =
      `**Your Server is Ready!**\n\n` +
      `Server "${serverName}" is now running in ${region.toUpperCase()}!\n\n` +
      (identityLines ? `**Identity:**\n${identityLines}\n\n` : '') +
      `**Connection Details:**\n` +
      `${connectionLines}\n\n` +
      (showSelkiesPassword && selkiesLoginLines ? `**Selkies Login:**\n${selkiesLoginLines}\n\n` : '') +
      `Setup time: ${elapsedMinutes} minutes\n` +
      `Don't forget to use /destroy when you're done!`;

    await user.send(message);
    logger.debug(`DM sent to ${user.username}`);
    return { success: true };
  } catch (error) {
    logger.debug(`DM failed to ${user.username}:`, error.message);
    return { success: false, reason: error.code === 50007 ? 'DMs disabled' : 'Unknown error' };
  }
}

/**
 * Send server destruction DM to user
 */
export async function sendServerDestructionDM(user, serverName, cost) {
  try {
    const message =
      `**Server Destroyed**\n\n` +
      `Server "${serverName}" has been destroyed.\n` +
      `Cost: ${cost}`;

    await user.send(message);
    logger.debug(`Destruction DM sent to ${user.username}`);
    return { success: true };
  } catch (error) {
    logger.debug(`Destruction DM failed to ${user.username}:`, error.message);
    return { success: false, reason: error.code === 50007 ? 'DMs disabled' : 'Unknown error' };
  }
}
