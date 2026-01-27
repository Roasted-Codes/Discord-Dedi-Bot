/**
 * /snapshot Command
 *
 * Create a snapshot of a running server (Admin only).
 */

import { SlashCommandBuilder } from 'discord.js';
import { getInstance, hasSnapshotPermission, createSnapshotFromInstance } from '../../vultr/index.js';
import { logger } from '../../utils/logger.js';

// This will be set by the main entry point
let startSnapshotStatusPolling = null;

export function setSnapshotPollingFunction(fn) {
  startSnapshotStatusPolling = fn;
}

export const snapshotCommand = {
  data: new SlashCommandBuilder()
    .setName('snapshot')
    .setDescription('Create a snapshot of a running server (Admin only)')
    .addStringOption(option =>
      option
        .setName('server')
        .setDescription('Server to snapshot')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('Custom name for the snapshot')
        .setRequired(true)
        .setMaxLength(50))
    .addStringOption(option =>
      option
        .setName('description')
        .setDescription('Optional description')
        .setRequired(false)
        .setMaxLength(150))
    .addBooleanOption(option =>
      option
        .setName('public')
        .setDescription('Make snapshot available to all users via /restore command')
        .setRequired(false)),

  async execute(interaction) {
    try {
      if (!hasSnapshotPermission(interaction.user.id)) {
        return interaction.editReply('You do not have permission to create snapshots. Contact an administrator.');
      }

      const serverId = interaction.options.getString('server');
      const snapshotName = interaction.options.getString('name');
      const userDescription = interaction.options.getString('description') || '';
      const isPublic = interaction.options.getBoolean('public') || false;

      const prefix = isPublic ? '[PUBLIC]' : '[PRIVATE]';
      const description = userDescription
        ? `${prefix} ${snapshotName} | ${userDescription}`
        : `${prefix} ${snapshotName}`;

      const instance = await getInstance(serverId);
      if (!instance) {
        return interaction.editReply('Server not found or not available for management.');
      }

      if (instance.power_status !== 'running') {
        return interaction.editReply(`Server must be running to create a snapshot. Current status: ${instance.power_status}`);
      }

      await interaction.editReply(
        `**Snapshot Creation**\n\n` +
        `Server: ${instance.label || 'Unnamed Server'}\n` +
        `Snapshot Name: ${snapshotName}\n` +
        `${isPublic ? 'Visibility: Public' : 'Visibility: Private'}\n` +
        `Cost: ~$0.05/GB/month\n` +
        `Time: 5-15 minutes\n\n` +
        `Creating snapshot...`
      );

      const snapshot = await createSnapshotFromInstance(serverId, description);

      if (!snapshot?.id) {
        return interaction.editReply('Failed to create snapshot. Please try again later.');
      }

      await interaction.editReply(
        `Snapshot "${snapshotName}" creation started!\n` +
        `From Server: ${instance.label || 'Unnamed Server'}\n` +
        `Please be patient - snapshot creation typically takes 5-15 minutes.\n` +
        `${isPublic ? 'Will be available to all users when complete' : 'Private snapshot for admin use'}`
      );

      if (startSnapshotStatusPolling) {
        startSnapshotStatusPolling(snapshot.id, snapshotName, isPublic, interaction);
      }

    } catch (error) {
      logger.error('Snapshot command failed:', error.message);
      return interaction.editReply('There was an error creating the snapshot.');
    }
  }
};
