/**
 * /status Command
 *
 * Check the status of a game server.
 */

import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { listInstances } from '../../vultr/index.js';
import { logger } from '../../utils/logger.js';

export const statusCommand = {
  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('Check the status of a game server'),

  async execute(interaction) {
    try {
      const vultrInstances = await listInstances();

      if (!vultrInstances?.length) {
        return interaction.editReply('No servers found.');
      }

      const options = vultrInstances.map(instance => ({
        label: instance.label || 'Unnamed Server',
        description: `Status: ${instance.power_status} | IP: ${instance.main_ip} | Region: ${instance.region}`,
        value: instance.id
      }));

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('select_server')
            .setPlaceholder('Select a server to check')
            .addOptions(options)
        );

      return interaction.editReply({
        content: 'Choose a server to check its status:',
        components: [row]
      });
    } catch (error) {
      logger.error('Status command failed:', error.message);
      return interaction.editReply('There was an error checking server status.');
    }
  }
};
