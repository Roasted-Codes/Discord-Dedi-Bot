/**
 * /create Command
 *
 * Create a new game server.
 */

import { SlashCommandBuilder } from 'discord.js';
import { getSnapshots, createInstanceFromSnapshot } from '../../vultr/index.js';
import { instanceState } from '../../state/instanceState.js';
import { config } from '../../config/index.js';
import { logger } from '../../utils/logger.js';

// This will be set by the main entry point
let startInstanceStatusPolling = null;

export function setPollingFunction(fn) {
  startInstanceStatusPolling = fn;
}

export const createCommand = {
  data: new SlashCommandBuilder()
    .setName('create')
    .setDescription('Create a new game server')
    .addStringOption(option =>
      option
        .setName('name')
        .setDescription('A name for your server')
        .setRequired(false))
    .addStringOption(option =>
      option
        .setName('city')
        .setDescription('City to create server in (optional - defaults to Dallas)')
        .setRequired(false)
        .setAutocomplete(true)),

  async execute(interaction) {
    try {
      const serverName = interaction.options.getString('name') ||
        `${interaction.user.username}'s Server`;
      const selectedCity = interaction.options.getString('city') || 'dfw';

      await interaction.editReply('Creating your server...');

      // Get available snapshots
      let snapshots;
      try {
        snapshots = await getSnapshots();
      } catch (error) {
        logger.error('Error fetching snapshots:', error.message);
        return interaction.editReply('Error fetching snapshots from Vultr API.');
      }

      let snapshotId;
      if (!snapshots?.length) {
        if (config.vultr.snapshotId) {
          snapshotId = config.vultr.snapshotId;
        } else {
          return interaction.editReply('No snapshots available. Please set VULTR_SNAPSHOT_ID in .env file.');
        }
      } else {
        snapshotId = config.vultr.snapshotId || snapshots[0].id;
      }

      const instance = await createInstanceFromSnapshot(snapshotId, serverName, selectedCity);

      if (!instance?.id) {
        return interaction.editReply('Failed to create the server. Please try again later.');
      }

      // Track the new instance
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

      const initialMessage = await interaction.editReply(
        `Server "${serverName}" creation started in ${selectedCity.toUpperCase()}!\n` +
        `Please be patient - server creation typically takes 15 minutes.\n` +
        `Checking status automatically...\n` +
        `Tip: The server will be ready when its status shows as "running"\n` +
        `Don't forget to use /destroy to delete your server when you're done!`
      );

      // Start automatic status polling if function is available
      if (startInstanceStatusPolling) {
        startInstanceStatusPolling(instance.id, serverName, selectedCity, interaction, initialMessage);
      }

    } catch (error) {
      logger.error('Create command failed:', error.message);
      return interaction.editReply(`There was an error creating the server: ${error.message}`);
    }
  }
};
