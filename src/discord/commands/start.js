/**
 * /start Command
 *
 * Start a stopped game server.
 */

import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { listInstances } from '../../vultr/index.js';
import { logger } from '../../utils/logger.js';

export const startCommand = {
  data: new SlashCommandBuilder()
    .setName('start')
    .setDescription('Start a game server'),

  async execute(interaction) {
    try {
      const vultrInstances = await listInstances();
      const stoppedInstances = vultrInstances.filter(instance =>
        instance.power_status === 'stopped'
      );

      if (!stoppedInstances?.length) {
        return interaction.editReply('No stopped servers found. All servers may already be running.');
      }

      const options = stoppedInstances.map(instance => ({
        label: instance.label || 'Unnamed Server',
        description: `Status: ${instance.power_status} | IP: ${instance.main_ip} | Region: ${instance.region}`,
        value: instance.id
      }));

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('start_server')
            .setPlaceholder('Select a server to start')
            .addOptions(options)
        );

      return interaction.editReply({
        content: 'Choose a server to start:',
        components: [row]
      });
    } catch (error) {
      logger.error('Start command failed:', error.message);
      return interaction.editReply('There was an error listing servers.');
    }
  }
};
