/**
 * Modal Handler
 *
 * Handles modal form submissions.
 */

import { createCommand } from '../commands/create.js';
import { logger } from '../../utils/logger.js';
import { DEFAULT_DEDI_SNAPSHOT_KEY } from '../../config/snapshots.js';

// Will be set by main entry point
let updatePanel = null;
let quickCreateWithTimer = null;
let prepareManualRestore = null;

export function setModalPanelFunction(fn) {
  updatePanel = fn;
}

export function setModalQuickCreateFunction(fn) {
  quickCreateWithTimer = fn;
}

export function setModalManualRestoreFunction(fn) {
  prepareManualRestore = fn;
}

export async function handleModal(interaction) {
  // Handle custom timer modal (no defer - needs ephemeral handling)
  if (interaction.customId.startsWith('custom_timer_modal_')) {
    const modalValue = interaction.customId.replace('custom_timer_modal_', '');
    const [regionId, snapshotKey = DEFAULT_DEDI_SNAPSHOT_KEY] = modalValue.split('|');
    const minutesStr = interaction.fields.getTextInputValue('timer_minutes');
    const timerMinutes = parseInt(minutesStr, 10);

    if (isNaN(timerMinutes) || timerMinutes < 0) {
      try {
        await interaction.reply({ content: 'Invalid timer value. Please enter a number.', ephemeral: true });
      } catch (e) { /* ignore */ }
      return;
    }

    try {
      await interaction.deferReply();
    } catch (e) {
      if (e.code === 10062) return;
      throw e;
    }

    if (quickCreateWithTimer) {
      await quickCreateWithTimer(interaction, regionId, timerMinutes, snapshotKey);
    } else {
      logger.error('quickCreateWithTimer function not set in modals');
      await interaction.editReply('Error: Server creation not available.');
    }
    return;
  }

  if (interaction.customId === 'manual_restore_snapshot_modal') {
    const snapshotId = interaction.fields.getTextInputValue('snapshot_id').trim();
    const serverName = interaction.fields.getTextInputValue('server_name').trim();
    const city = interaction.fields.getTextInputValue('server_city').trim();
    const timerValue = interaction.fields.getTextInputValue('timer_minutes').trim();
    const timerMinutes = parseInt(timerValue, 10);

    if (!city) {
      try {
        await interaction.reply({ content: 'City/region is required.', ephemeral: true });
      } catch (e) { /* ignore */ }
      return;
    }

    if (isNaN(timerMinutes) || timerMinutes < 0) {
      try {
        await interaction.reply({ content: 'Invalid timer value. Please enter 0 or a positive number.', ephemeral: true });
      } catch (e) { /* ignore */ }
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      if (e.code === 10062) return;
      throw e;
    }

    if (prepareManualRestore) {
      await prepareManualRestore(interaction, {
        snapshotId,
        requestedName: serverName || undefined,
        regionId: city,
        timerMinutes,
        allowUnmanaged: true
      });
    } else {
      logger.error('prepareManualRestore function not set in modals');
      await interaction.editReply('Error: Manual restore is not available.');
    }
    return;
  }

  if (interaction.customId.startsWith('restore_snapshot_settings_')) {
    const snapshotId = interaction.customId.replace('restore_snapshot_settings_', '');
    const serverName = interaction.fields.getTextInputValue('server_name').trim();
    const city = interaction.fields.getTextInputValue('server_city').trim();
    const timerValue = interaction.fields.getTextInputValue('timer_minutes').trim();
    const timerMinutes = parseInt(timerValue, 10);

    if (!city) {
      try {
        await interaction.reply({ content: 'City/region is required.', ephemeral: true });
      } catch (e) { /* ignore */ }
      return;
    }

    if (isNaN(timerMinutes) || timerMinutes < 0) {
      try {
        await interaction.reply({ content: 'Invalid timer value. Please enter 0 or a positive number.', ephemeral: true });
      } catch (e) { /* ignore */ }
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });
    } catch (e) {
      if (e.code === 10062) return;
      throw e;
    }

    if (prepareManualRestore) {
      await prepareManualRestore(interaction, {
        snapshotId,
        requestedName: serverName || undefined,
        regionId: city,
        timerMinutes,
        allowUnmanaged: false
      });
    } else {
      logger.error('prepareManualRestore function not set in modals');
      await interaction.editReply('Error: Snapshot restore is not available.');
    }
    return;
  }

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
}
