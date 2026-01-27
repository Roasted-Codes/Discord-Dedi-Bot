/**
 * Formatting Utilities
 *
 * Helper functions for formatting data for Discord display.
 */

import { STATUS_EMOJIS, SELF_DESTRUCT_COIN_MINUTES } from '../config/constants.js';

/**
 * Format instance status for display
 */
export function formatStatus(instance) {
  const status = instance.power_status || instance.status;
  const emoji = STATUS_EMOJIS[status] || STATUS_EMOJIS.default;

  return {
    emoji: emoji,
    label: status
  };
}

/**
 * Format a list of instances for display in Discord
 */
export function formatInstanceList(instances) {
  if (!instances || instances.length === 0) {
    return '**Server List**\nNo active servers found.';
  }

  let message = '**Server List**\n';

  instances.forEach(instance => {
    const status = formatStatus(instance);
    const createdAt = new Date(instance.createdAt).toLocaleString();

    message += `\n${status.emoji} **${instance.name}**`;
    message += `\n> Status: ${status.label}`;

    if (instance.ip) {
      message += `\n> IP: \`${instance.ip}\``;
    }

    message += `\n> Created by: ${instance.creator.username}`;
    message += `\n> Created: ${createdAt}`;
    message += '\n';
  });

  return message;
}

/**
 * Format an instance for detailed display in Discord
 */
export function formatInstanceDetails(instance, vultrInstance = null) {
  const status = formatStatus(vultrInstance || instance);
  let message = `**Server Details**\n`;

  const serverName = vultrInstance?.label || instance?.label || instance?.name || 'Unnamed Server';
  message += `\n${status.emoji} **${serverName}**`;
  message += `\n> Status: ${status.label}`;

  if (vultrInstance) {
    message += `\n> Region: ${vultrInstance.region}`;

    if (vultrInstance.main_ip) {
      message += `\n> Linux Remote Desktop: https://${vultrInstance.main_ip}:8080`;
      message += `\n> Xlink Kai: http://${vultrInstance.main_ip}:34522`;
    }
  } else if (instance?.ip) {
    message += `\n> Region: ${instance.region || 'Unknown'}`;
    message += `\n> Linux Remote Desktop: https://${instance.ip}:8080`;
    message += `\n> Xlink Kai: http://${instance.ip}:34522`;
  }

  return message;
}

/**
 * Format remaining time as HH:MM:SS or MM:SS
 */
export function formatRemainingTime(expiresAt) {
  const now = Date.now();
  const remainingMs = expiresAt - now;

  if (remainingMs <= 0) {
    return '00:00';
  }

  const totalSeconds = Math.floor(remainingMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }
  return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
}

/**
 * Format snapshot information for Discord display
 */
export function formatSnapshotInfo(snapshot, includeId = false) {
  const sizeGB = snapshot.size ? `${snapshot.size} GB` : 'Unknown size';
  const created = new Date(snapshot.date_created).toLocaleString();
  const cleanName = snapshot.description
    ?.replace(/^\[(PUBLIC|PRIVATE)\]\s*/, '')
    .replace(/\s*\|\s*$/, '')
    .trim() || 'Unnamed Snapshot';

  let message = `**${cleanName}**\n`;
  message += `> Size: ${sizeGB}\n`;
  message += `> Created: ${created}\n`;
  message += `> Status: ${snapshot.status}`;

  if (includeId) {
    message += `\n> ID: \`${snapshot.id}\``;
  }

  return message;
}
