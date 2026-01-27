/**
 * /list Command
 *
 * Lists all active game servers.
 */

import { SlashCommandBuilder } from 'discord.js';
import { listInstances } from '../../vultr/index.js';
import { instanceState } from '../../state/instanceState.js';
import { formatInstanceList } from '../../utils/formatters.js';
import { logger } from '../../utils/logger.js';

export const listCommand = {
  data: new SlashCommandBuilder()
    .setName('list')
    .setDescription('List all active game servers'),

  async execute(interaction) {
    try {
      // Sync with Vultr API
      try {
        const vultrInstances = await listInstances();
        const activeInstances = instanceState.getActiveInstances();

        vultrInstances.forEach(vultrInstance => {
          const tracked = activeInstances.find(i => i.id === vultrInstance.id);

          if (tracked) {
            instanceState.updateInstance(vultrInstance.id, vultrInstance.power_status, {
              ip: vultrInstance.main_ip
            });
          } else {
            instanceState.trackInstance(
              vultrInstance.id,
              'unknown',
              'Unknown',
              vultrInstance.power_status,
              {
                ip: vultrInstance.main_ip,
                name: vultrInstance.label || 'Unknown Server'
              }
            );
          }
        });

        // Mark terminated instances
        activeInstances.forEach(tracked => {
          if (!vultrInstances.find(i => i.id === tracked.id)) {
            instanceState.updateInstance(tracked.id, 'terminated');
          }
        });
      } catch (error) {
        logger.debug('Error syncing with Vultr:', error.message);
      }

      const activeInstances = instanceState.getActiveInstances();
      const formattedList = formatInstanceList(activeInstances);
      return interaction.editReply(formattedList);
    } catch (error) {
      logger.error('List command failed:', error.message);
      return interaction.editReply('There was an error trying to list the servers.');
    }
  }
};
