/**
 * Button Handler
 *
 * Handles button interactions from the control panel.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle
} from 'discord.js';
import {
  getInstance,
  listCompleteInstances,
  listInstances,
  rebootInstanceApi,
  startInstanceApi,
  hasSnapshotPermission
} from '../../vultr/index.js';
import { instanceState } from '../../state/instanceState.js';
import { panelData } from '../../state/panelState.js';
import {
  createPowerActionCoordinator,
  formatPowerActionMessage
} from '../../services/powerActions.js';
import {
  scheduleMessageCleanup,
  sendAutoCleanupFollowUp
} from '../../services/notifications.js';
import { formatRemainingTime } from '../../utils/formatters.js';
import {
  POWER_ACTION_REPLY_CLEANUP_MS,
  SELF_DESTRUCT_COIN_MINUTES
} from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import { isServerLocked } from '../../services/serverLocks.js';
import { buildServerLockOption } from '../../services/serverLockPresentation.js';

// Will be set by main entry point
let executeFromPanel = {};
const POWER_ACTION_TIMEOUT_MS = 2 * 60 * 1000;
const executePowerAction = createPowerActionCoordinator({
  getInstance,
  restartInstance: rebootInstanceApi,
  startInstance: instanceId => startInstanceApi(instanceId, POWER_ACTION_TIMEOUT_MS)
});
const PANEL_BUTTON_IDS = new Set([
  'btn_create_modal',
  'btn_destroy',
  'btn_restart',
  'btn_insert_coin',
  'btn_restore_snapshot',
  'btn_server_locks'
]);
const SERVER_LOCK_PAGE_SIZE = 25;

function buildServerLocksPage(instances, requestedPage, isLocked) {
  const pageCount = Math.ceil(instances.length / SERVER_LOCK_PAGE_SIZE);
  const page = Math.min(Math.max(0, requestedPage), pageCount - 1);
  const displayedInstances = instances.slice(
    page * SERVER_LOCK_PAGE_SIZE,
    (page + 1) * SERVER_LOCK_PAGE_SIZE
  );
  const components = [
    new ActionRowBuilder().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('server_lock_toggle')
        .setPlaceholder('Select a server to lock or unlock')
        .addOptions(displayedInstances.map(instance =>
          buildServerLockOption(instance, isLocked(instance.id))
        ))
    )
  ];

  if (pageCount > 1) {
    const navigation = [];
    if (page > 0) {
      navigation.push(
        new ButtonBuilder()
          .setCustomId(`server_locks_page_${page - 1}`)
          .setLabel('Previous')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    if (page < pageCount - 1) {
      navigation.push(
        new ButtonBuilder()
          .setCustomId(`server_locks_page_${page + 1}`)
          .setLabel('Next')
          .setStyle(ButtonStyle.Secondary)
      );
    }
    components.push(new ActionRowBuilder().addComponents(navigation));
  }

  return {
    content: `**Server Locks**\n\nSelect a server to change persistent deletion protection. Page ${page + 1} of ${pageCount}.`,
    components
  };
}

export function setPanelExecutors(executors) {
  executeFromPanel = executors;
}

export async function handleServerLocksButton(interaction, {
  isAdmin = hasSnapshotPermission,
  list = listCompleteInstances,
  isLocked = isServerLocked
} = {}) {
  if (!isAdmin(interaction.user.id)) {
    return interaction.reply({
      content: 'Only ServerBot administrators can manage server locks.',
      ephemeral: true
    });
  }

  let acknowledged = false;
  try {
    await interaction.deferReply({ ephemeral: true });
    acknowledged = true;

    const instances = (await list()).filter(instance =>
      instance.status !== 'destroyed' && instance.power_status !== 'destroyed'
    );

    if (!instances.length) {
      return interaction.editReply({
        content: 'No active servers are available to lock.'
      });
    }

    return interaction.editReply(buildServerLocksPage(instances, 0, isLocked));
  } catch (error) {
    if (error.code === 10062) return;
    logger.error('Error opening server lock controls:', error.message);
    const payload = { content: 'Server lock controls are temporarily unavailable.', components: [] };
    if (acknowledged || interaction.deferred || interaction.replied) {
      return interaction.editReply(payload);
    }
    return interaction.reply({ ...payload, ephemeral: true });
  }
}

export async function handleServerLocksPageButton(interaction, page, {
  isAdmin = hasSnapshotPermission,
  list = listCompleteInstances,
  isLocked = isServerLocked
} = {}) {
  if (!isAdmin(interaction.user.id)) {
    return interaction.reply({
      content: 'Only ServerBot administrators can manage server locks.',
      ephemeral: true
    });
  }

  let acknowledged = false;
  try {
    await interaction.deferUpdate();
    acknowledged = true;
    const instances = (await list()).filter(instance =>
      instance.status !== 'destroyed' && instance.power_status !== 'destroyed'
    );
    if (!instances.length) {
      return interaction.editReply({
        content: 'No active servers are available to lock.',
        components: []
      });
    }

    return interaction.editReply(buildServerLocksPage(instances, page, isLocked));
  } catch (error) {
    if (error.code === 10062) return;
    logger.error('Error changing server lock page:', error.message);
    const payload = { content: 'Server lock controls are temporarily unavailable.', components: [] };
    if (acknowledged || interaction.deferred || interaction.replied) {
      return interaction.editReply(payload);
    }
    return interaction.reply({ ...payload, ephemeral: true });
  }
}

function isPanelButton(customId) {
  return PANEL_BUTTON_IDS.has(customId) || customId?.startsWith('btn_quick_');
}

async function rejectStalePanelInteraction(interaction) {
  const payload = {
    content: 'This is an old control panel. Use the latest panel message.',
    ephemeral: true
  };

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }
}

export async function handleButton(interaction) {
  if (
    isPanelButton(interaction.customId) &&
    panelData.messageId &&
    interaction.message?.id !== panelData.messageId
  ) {
    logger.warn(`Rejected stale panel button ${interaction.customId} from message ${interaction.message?.id}`);
    await rejectStalePanelInteraction(interaction);
    return;
  }

  if (interaction.customId.startsWith('server_locks_page_')) {
    const page = Number.parseInt(interaction.customId.replace('server_locks_page_', ''), 10);
    await handleServerLocksPageButton(interaction, Number.isNaN(page) ? 0 : page);
    return;
  }

  // Handle create modal button
  if (interaction.customId === 'btn_create_modal') {
    try {
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
    } catch (error) {
      if (error.code === 10062) {
        logger.debug('Modal interaction expired');
        return;
      }
      logger.error('Error showing modal:', error.message);
      return;
    }
  }

  if (interaction.customId === 'btn_restore_snapshot') {
    if (executeFromPanel.manualRestore) {
      await executeFromPanel.manualRestore(interaction);
    } else {
      await interaction.reply({ content: 'Manual restore is not available.', ephemeral: true });
    }
    return;
  }

  if (interaction.customId === 'btn_server_locks') {
    await handleServerLocksButton(interaction);
    return;
  }

  if (interaction.customId.startsWith('restore_snapshot_page_')) {
    const page = parseInt(interaction.customId.replace('restore_snapshot_page_', ''), 10);
    if (executeFromPanel.restoreSnapshotPage) {
      await executeFromPanel.restoreSnapshotPage(interaction, Number.isNaN(page) ? 0 : page);
    } else {
      await interaction.reply({ content: 'Restore snapshot picker is not available.', ephemeral: true });
    }
    return;
  }

  if (interaction.customId.startsWith('restore_snapshot_refresh_')) {
    const page = parseInt(interaction.customId.replace('restore_snapshot_refresh_', ''), 10);
    if (executeFromPanel.restoreSnapshotPage) {
      await executeFromPanel.restoreSnapshotPage(interaction, Number.isNaN(page) ? 0 : page);
    } else {
      await interaction.reply({ content: 'Restore snapshot picker is not available.', ephemeral: true });
    }
    return;
  }

  if (interaction.customId === 'restore_snapshot_advanced') {
    if (executeFromPanel.advancedManualRestore) {
      await executeFromPanel.advancedManualRestore(interaction);
    } else {
      await interaction.reply({ content: 'Advanced restore is not available.', ephemeral: true });
    }
    return;
  }

  if (interaction.customId.startsWith('restore_snapshot_confirm_')) {
    const token = interaction.customId.replace('restore_snapshot_confirm_', '');
    if (executeFromPanel.confirmManualRestore) {
      await executeFromPanel.confirmManualRestore(interaction, token);
    } else {
      await interaction.reply({ content: 'Restore confirmation is not available.', ephemeral: true });
    }
    return;
  }

  if (interaction.customId.startsWith('restore_snapshot_cancel_')) {
    const token = interaction.customId.replace('restore_snapshot_cancel_', '');
    if (executeFromPanel.cancelManualRestore) {
      await executeFromPanel.cancelManualRestore(interaction, token);
    } else {
      await interaction.reply({ content: 'Restore cancelled.', ephemeral: true });
    }
    return;
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

export async function handleConfirmRestart(
  interaction,
  instanceId,
  powerAction = executePowerAction
) {
  scheduleMessageCleanup(interaction.message, {
    deleteAfterMs: POWER_ACTION_REPLY_CLEANUP_MS
  });
  try {
    await interaction.editReply({
      content: 'Checking the server and submitting the appropriate power action...',
      components: []
    });

    const result = await powerAction(instanceId);

    await interaction.editReply({
      content: formatPowerActionMessage(result),
      components: []
    });
    scheduleMessageCleanup(interaction.message);

    if (executeFromPanel.refreshPanel) {
      try {
        await executeFromPanel.refreshPanel();
      } catch (error) {
        logger.warn('Panel refresh after power action failed:', error.message);
      }
    }
  } catch (error) {
    logger.error('Error restarting server:', error.message);
    await interaction.editReply({
      content: 'Vultr rejected the power request or could not be reached. No success was assumed.',
      components: []
    });
    scheduleMessageCleanup(interaction.message);
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
