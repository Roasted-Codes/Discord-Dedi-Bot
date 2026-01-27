/**
 * /restore Command
 *
 * Create a new server from a snapshot.
 */

import { SlashCommandBuilder } from 'discord.js';
import { getPublicSnapshots, createInstanceFromSnapshot, getCleanSnapshotName } from '../../vultr/index.js';
import { instanceState } from '../../state/instanceState.js';
import { logger } from '../../utils/logger.js';

// This will be set by the main entry point
let startInstanceStatusPolling = null;

export function setRestorePollingFunction(fn) {
  startInstanceStatusPolling = fn;
}

export const restoreCommand = {
  data: new SlashCommandBuilder()
    .setName('restore')
    .setDescription('Create a new server from a snapshot')
    .addStringOption(option =>
      option
        .setName('snapshot')
        .setDescription('Snapshot to restore from')
        .setRequired(true)
        .setAutocomplete(true))
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('Name for the new server')
        .setRequired(false))
    .addStringOption(option =>
      option
        .setName('city')
        .setDescription('City to create server in (optional - defaults to Dallas)')
        .setRequired(false)
        .setAutocomplete(true)),

  async execute(interaction) {
    try {
      const snapshotId = interaction.options.getString('snapshot');
      const serverName = interaction.options.getString('name') ||
        `${interaction.user.username}'s Restored Server`;
      const selectedCity = interaction.options.getString('city') || 'dfw';

      await interaction.editReply('Restoring server from snapshot...');

      const publicSnapshots = await getPublicSnapshots();
      const selectedSnapshot = publicSnapshots.find(snap => snap.id === snapshotId);

      if (!selectedSnapshot) {
        return interaction.editReply('Snapshot not found or not available for use.');
      }

      if (selectedSnapshot.status !== 'complete') {
        return interaction.editReply(`Snapshot is not ready yet. Status: ${selectedSnapshot.status}. Please wait and try again.`);
      }

      const instance = await createInstanceFromSnapshot(snapshotId, serverName, selectedCity);

      if (!instance?.id) {
        return interaction.editReply('Failed to restore server from snapshot. Please try again later.');
      }

      instanceState.trackInstance(
        instance.id,
        interaction.user.id,
        interaction.user.username,
        instance.status || 'creating',
        {
          ip: instance.main_ip,
          name: serverName,
          region: selectedCity
        }
      );

      const cleanSnapshotName = getCleanSnapshotName(selectedSnapshot);
      const initialMessage = await interaction.editReply(
        `Server "${serverName}" restoration started in ${selectedCity.toUpperCase()}!\n` +
        `From Snapshot: ${cleanSnapshotName}\n` +
        `Please be patient - server creation typically takes 15 minutes.\n` +
        `Checking status automatically...\n` +
        `Don't forget to use /destroy to delete your server when you're done!`
      );

      if (startInstanceStatusPolling) {
        startInstanceStatusPolling(instance.id, serverName, selectedCity, interaction, initialMessage);
      }

    } catch (error) {
      logger.error('Restore command failed:', error.message);
      return interaction.editReply('There was an error restoring the server.');
    }
  }
};
