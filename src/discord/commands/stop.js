/**
 * /stop Command
 *
 * Stop a running game server.
 */

import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { listInstances } from '../../vultr/index.js';
import { logger } from '../../utils/logger.js';

export const stopCommand = {
  data: new SlashCommandBuilder()
    .setName('stop')
    .setDescription('Stop a game server'),

  async execute(interaction) {
    try {
      const vultrInstances = await listInstances();
      const runningInstances = vultrInstances.filter(instance =>
        instance.power_status === 'running'
      );

      if (!runningInstances?.length) {
        return interaction.editReply('No running servers found. All servers may already be stopped.');
      }

      const options = runningInstances.map(instance => ({
        label: instance.label || 'Unnamed Server',
        description: `Status: ${instance.power_status} | IP: ${instance.main_ip} | Region: ${instance.region}`,
        value: instance.id
      }));

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('stop_server')
            .setPlaceholder('Select a server to stop')
            .addOptions(options)
        );

      return interaction.editReply({
        content: 'Choose a server to stop:',
        components: [row]
      });
    } catch (error) {
      logger.error('Stop command failed:', error.message);
      return interaction.editReply('There was an error listing servers.');
    }
  }
};
