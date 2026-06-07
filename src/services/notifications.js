/**
 * Notification Services
 *
 * Handles Discord DMs, follow-up messages, and auto-cleanup.
 */

import { MessageFlags } from 'discord.js';
import { AUTO_CLEANUP_DEFAULT_MS } from '../config/constants.js';
import { logger } from '../utils/logger.js';

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
    const identityLines = [
      serverId ? `> Server ID: \`${serverId}\`` : null,
      hostname ? `> Hostname: \`${hostname}\`` : null,
      friendlyHostname ? `> Friendly Name: \`${friendlyHostname}\`` : null,
      snapshotLabel ? `> Snapshot: \`${snapshotLabel}\`` : null
    ].filter(Boolean).join('\n');

    const message =
      `**Your Server is Ready!**\n\n` +
      `Server "${serverName}" is now running in ${region.toUpperCase()}!\n\n` +
      (identityLines ? `**Identity:**\n${identityLines}\n\n` : '') +
      `**Connection Details:**\n` +
      `> Linux Remote Desktop: https://${ip}:8080\n` +
      `> Xlink Kai: http://${ip}:34522\n` +
      `> IP Address: \`${ip}\`\n\n` +
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
