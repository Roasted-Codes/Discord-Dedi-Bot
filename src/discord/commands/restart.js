/**
 * /restart Command
 *
 * Restart a server.
 */

import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { listInstances } from '../../vultr/index.js';
import { logger } from '../../utils/logger.js';

export const restartCommand = {
  data: new SlashCommandBuilder()
    .setName('restart')
    .setDescription('Restart a server'),

  async execute(interaction) {
    try {
      const vultrInstances = await listInstances();
      const activeInstances = vultrInstances.filter(instance =>
        instance.status !== 'destroyed' && instance.power_status !== 'destroyed'
      );

      if (!activeInstances?.length) {
        return interaction.editReply('No active servers found to restart.');
      }

      const options = activeInstances.map(instance => ({
        label: instance.label || 'Unnamed Server',
        description: `Status: ${instance.power_status} | IP: ${instance.main_ip} | Region: ${instance.region}`,
        value: instance.id
      }));

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('restart_server')
            .setPlaceholder('Select a server to restart')
            .addOptions(options)
        );

      return interaction.editReply({
        content: '**Restart Server**\nSelect a server to restart:',
        components: [row]
      });
    } catch (error) {
      logger.error('Restart command failed:', error.message);
      return interaction.editReply('There was an error listing servers.');
    }
  }
};
