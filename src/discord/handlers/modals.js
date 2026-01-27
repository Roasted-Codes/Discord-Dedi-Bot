/**
 * Modal Handler
 *
 * Handles modal form submissions.
 */

import { createCommand } from '../commands/create.js';
import { restoreCommand } from '../commands/restore.js';
import { getPublicSnapshots } from '../../vultr/index.js';
import { logger } from '../../utils/logger.js';

// Will be set by main entry point
let updatePanel = null;

export function setModalPanelFunction(fn) {
  updatePanel = fn;
}

export async function handleModal(interaction) {
  try {
    await interaction.deferReply();
  } catch (error) {
    if (error.code === 10062) {
      logger.debug('Modal interaction expired');
      return;
    }
    throw error;
  }

  if (interaction.customId === 'create_server_modal') {
    try {
      const serverName = interaction.fields.getTextInputValue('server_name') ||
        `${interaction.user.username}'s Server`;
      const city = interaction.fields.getTextInputValue('server_city') || 'dfw';

      // Mock interaction options for command
      interaction.options = {
        getString: (name) => {
          if (name === 'name') return serverName;
          if (name === 'city') return city;
          return null;
        }
      };

      await createCommand.execute(interaction);

      if (updatePanel) {
        setTimeout(() => updatePanel(), 5000);
      }
    } catch (error) {
      logger.error('Error creating server from modal:', error.message);
      try {
        await interaction.editReply('Error creating server. Please try again.');
      } catch (e) { /* ignore */ }
    }
  }

  if (interaction.customId === 'restore_server_modal') {
    try {
      const snapshotId = interaction.fields.getTextInputValue('snapshot_id');
      const serverName = interaction.fields.getTextInputValue('server_name') ||
        `${interaction.user.username}'s Restored Server`;
      const city = interaction.fields.getTextInputValue('server_city') || 'dfw';

      const publicSnapshots = await getPublicSnapshots();
      let selectedSnapshotId = snapshotId || publicSnapshots[0]?.id;

      if (!selectedSnapshotId) {
        return interaction.editReply('No snapshots available for restore.');
      }

      const snapshot = publicSnapshots.find(s => s.id === selectedSnapshotId);
      if (!snapshot && snapshotId) {
        return interaction.editReply('Invalid snapshot ID. Please check and try again.');
      }

      // Mock interaction options for command
      interaction.options = {
        getString: (name) => {
          if (name === 'snapshot') return selectedSnapshotId;
          if (name === 'name') return serverName;
          if (name === 'city') return city;
          return null;
        }
      };

      await restoreCommand.execute(interaction);

      if (updatePanel) {
        setTimeout(() => updatePanel(), 5000);
      }
    } catch (error) {
      logger.error('Error restoring server from modal:', error.message);
      try {
        await interaction.editReply('Error restoring server. Please try again.');
      } catch (e) { /* ignore */ }
    }
  }
}
