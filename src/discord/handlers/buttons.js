/**
 * Button Handler
 *
 * Handles button interactions from the control panel.
 */

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags
} from 'discord.js';
import {
  listInstances,
  getPublicSnapshots,
  getGroupedRegions,
  rebootInstanceApi
} from '../../vultr/index.js';
import { instanceState } from '../../state/instanceState.js';
import { sendAutoCleanupFollowUp } from '../../services/notifications.js';
import { formatRemainingTime } from '../../utils/formatters.js';
import { SELF_DESTRUCT_COIN_MINUTES } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';

// Will be set by main entry point
let executeFromPanel = {};

export function setPanelExecutors(executors) {
  executeFromPanel = executors;
}

export async function handleButton(interaction) {
  // Handle modal-triggering buttons
  if (interaction.customId === 'btn_create_modal' || interaction.customId === 'btn_restore_modal') {
    try {
      if (interaction.customId === 'btn_create_modal') {
        const modal = new ModalBuilder()
          .setCustomId('create_server_modal')
          .setTitle('Create New Server');

        const nameInput = new TextInputBuilder()
          .setCustomId('server_name')
          .setLabel('Server Name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(`${interaction.user.username}'s Server`)
          .setRequired(false)
          .setMaxLength(50);

        const cityInput = new TextInputBuilder()
          .setCustomId('server_city')
          .setLabel('City/Region (e.g., dfw, mia, sea)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('dfw')
          .setValue('dfw')
          .setRequired(false)
          .setMaxLength(10);

        const row1 = new ActionRowBuilder().addComponents(nameInput);
        const row2 = new ActionRowBuilder().addComponents(cityInput);

        modal.addComponents(row1, row2);
        await interaction.showModal(modal);
        return;
      }

      if (interaction.customId === 'btn_restore_modal') {
        const publicSnapshots = await getPublicSnapshots();

        if (!publicSnapshots.length) {
          await interaction.reply({
            content: 'No snapshots available for restore.',
            flags: MessageFlags.Ephemeral
          });
          return;
        }

        const modal = new ModalBuilder()
          .setCustomId('restore_server_modal')
          .setTitle('Restore Server from Snapshot');

        const snapshotInput = new TextInputBuilder()
          .setCustomId('snapshot_id')
          .setLabel('Snapshot ID (or leave empty for latest)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(publicSnapshots[0].id)
          .setRequired(false);

        const nameInput = new TextInputBuilder()
          .setCustomId('server_name')
          .setLabel('Server Name')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder(`${interaction.user.username}'s Restored Server`)
          .setRequired(false)
          .setMaxLength(50);

        const cityInput = new TextInputBuilder()
          .setCustomId('server_city')
          .setLabel('City/Region (e.g., dfw, mia, sea)')
          .setStyle(TextInputStyle.Short)
          .setPlaceholder('dfw')
          .setValue('dfw')
          .setRequired(false)
          .setMaxLength(10);

        const row1 = new ActionRowBuilder().addComponents(snapshotInput);
        const row2 = new ActionRowBuilder().addComponents(nameInput);
        const row3 = new ActionRowBuilder().addComponents(cityInput);

        modal.addComponents(row1, row2, row3);
        await interaction.showModal(modal);
        return;
      }
    } catch (error) {
      if (error.code === 10062) {
        logger.debug('Modal interaction expired');
        return;
      }
      logger.error('Error showing modal:', error.message);
      return;
    }
  }

  // Defer for non-modal buttons
  try {
    await interaction.deferUpdate();
  } catch (error) {
    if (error.code === 10062) return;
    throw error;
  }

  // Handle restart confirmation
  if (interaction.customId.startsWith('confirm_restart_')) {
    const instanceId = interaction.customId.replace('confirm_restart_', '');
    await handleConfirmRestart(interaction, instanceId);
    return;
  }

  if (interaction.customId === 'cancel_restart') {
    // User cancelled - no message needed
    return;
  }

  // Handle coin buttons
  if (interaction.customId.startsWith('coin_')) {
    const instanceId = interaction.customId.replace('coin_', '');
    await handleCoinButton(interaction, instanceId);
    return;
  }

  // Handle panel buttons
  switch (interaction.customId) {
    case 'btn_start':
      if (executeFromPanel.start) await executeFromPanel.start(interaction);
      break;
    case 'btn_destroy':
      if (executeFromPanel.destroy) await executeFromPanel.destroy(interaction);
      break;
    case 'btn_restart':
      if (executeFromPanel.restart) await executeFromPanel.restart(interaction);
      break;
    case 'btn_insert_coin':
      await handleInsertCoinButton(interaction);
      break;
    default:
      // Handle quick action buttons
      if (interaction.customId.startsWith('btn_quick_')) {
        const regionId = interaction.customId.replace('btn_quick_', '');
        if (executeFromPanel.quickCreate) {
          await executeFromPanel.quickCreate(interaction, regionId);
        }
      } else {
        logger.warn(`Unknown button: ${interaction.customId}`);
        await sendAutoCleanupFollowUp(interaction, 'Unknown button action.');
      }
  }
}

async function handleConfirmRestart(interaction, instanceId) {
  try {
    await rebootInstanceApi(instanceId);
    // No message needed - panel will show status change
  } catch (error) {
    logger.error('Error restarting server:', error.message);
    await sendAutoCleanupFollowUp(interaction, 'There was an error restarting the server.');
  }
}

async function handleCoinButton(interaction, instanceId) {
  try {
    const trackedInstance = instanceState.getInstance(instanceId);
    if (!trackedInstance?.selfDestructTimer) {
      return sendAutoCleanupFollowUp(interaction, 'This server does not have an active timer.');
    }

    const timer = trackedInstance.selfDestructTimer;
    const newExpiresAt = timer.expiresAt + (SELF_DESTRUCT_COIN_MINUTES * 60 * 1000);

    timer.expiresAt = newExpiresAt;
    timer.extendedCount = (timer.extendedCount || 0) + 1;

    instanceState.updateInstance(instanceId, trackedInstance.status, {
      selfDestructTimer: timer
    });

    // No message needed - panel will show updated timer

  } catch (error) {
    logger.error('Error handling coin button:', error.message);
    await sendAutoCleanupFollowUp(interaction, 'There was an error inserting the coin.');
  }
}

async function handleInsertCoinButton(interaction) {
  try {
    const vultrInstances = await listInstances();
    const activeInstances = vultrInstances.filter(instance =>
      instance.status !== 'destroyed' && instance.power_status !== 'destroyed'
    );

    if (!activeInstances?.length) {
      return sendAutoCleanupFollowUp(interaction, 'No active servers found.');
    }

    const instancesWithTimers = activeInstances.filter(instance => {
      const tracked = instanceState.getInstance(instance.id);
      return tracked?.selfDestructTimer;
    });

    if (!instancesWithTimers.length) {
      return sendAutoCleanupFollowUp(interaction, 'No servers with active timers found.');
    }

    const options = instancesWithTimers.map(instance => {
      const tracked = instanceState.getInstance(instance.id);
      const timer = tracked.selfDestructTimer;
      const timeStr = formatRemainingTime(timer.expiresAt);
      return {
        label: instance.label || 'Unnamed Server',
        description: `Time remaining: ${timeStr}`,
        value: instance.id
      };
    });

    const row = new ActionRowBuilder()
      .addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('insert_coin_server')
          .setPlaceholder('Select a server to insert coin')
          .addOptions(options)
      );

    return sendAutoCleanupFollowUp(interaction, {
      content: `**Insert Coin**\n\nSelect a server to extend its timer by ${SELF_DESTRUCT_COIN_MINUTES} minutes:`,
      components: [row]
    });
  } catch (error) {
    logger.error('Error handling insert coin:', error.message);
    return sendAutoCleanupFollowUp(interaction, 'There was an error processing the request.');
  }
}
