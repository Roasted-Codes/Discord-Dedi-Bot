/**
 * /destroy Command
 *
 * Destroy a server and see its total cost.
 */

import { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } from 'discord.js';
import { listInstances } from '../../vultr/index.js';
import { logger } from '../../utils/logger.js';
import { isServerLocked } from '../../services/serverLocks.js';
import { buildDestroyOption } from '../../services/serverLockPresentation.js';

export const destroyCommand = {
  data: new SlashCommandBuilder()
    .setName('destroy')
    .setDescription('Destroy a server and see its total cost'),

  async execute(interaction) {
    try {
      const vultrInstances = await listInstances();
      const activeInstances = vultrInstances.filter(instance =>
        instance.status !== 'destroyed' && instance.power_status !== 'destroyed'
      );

      if (!activeInstances?.length) {
        return interaction.editReply('No active servers found to destroy.');
      }

      const options = activeInstances.slice(0, 25).map(instance =>
        buildDestroyOption(instance, isServerLocked(instance.id))
      );

      const row = new ActionRowBuilder()
        .addComponents(
          new StringSelectMenuBuilder()
            .setCustomId('destroy_server')
            .setPlaceholder('Select a server to destroy')
            .addOptions(options)
        );

      return interaction.editReply({
        content: '**WARNING**: This will permanently destroy the server and all its data!\nSelect a server to destroy:',
        components: [row]
      });
    } catch (error) {
      logger.error('Destroy command failed:', error.message);
      return interaction.editReply('There was an error listing servers.');
    }
  }
};
