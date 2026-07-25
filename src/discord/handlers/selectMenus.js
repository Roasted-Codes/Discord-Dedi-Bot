/**
 * Select Menu Handler
 *
 * Handles string select menu interactions.
 */

import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import {
  getInstance,
  isCurrentServer,
  calculateInstanceCost,
  vultr,
  getBotManagedSnapshots,
  getCleanSnapshotName,
  hasSnapshotPermission
} from '../../vultr/index.js';
import { instanceState } from '../../state/instanceState.js';
import { formatRemainingTime } from '../../utils/formatters.js';
import {
  POWER_ACTION_REPLY_CLEANUP_MS,
  SELF_DESTRUCT_COIN_MINUTES
} from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import { releaseXlinkAssignment } from '../../xlink/credentials.js';
import { scheduleMessageCleanup } from '../../services/notifications.js';
import {
  isServerLocked,
  runIfServerUnlocked,
  setServerLockState
} from '../../services/serverLocks.js';
import { submitUnlockedDeletion } from '../../services/serverDeletionGuard.js';

// Will be set by main entry point
let startInstanceDestructionPolling = null;
let serverLockPanelRefresh = null;

export function setDestructionPollingFunction(fn) {
  startInstanceDestructionPolling = fn;
}

export function setServerLockPanelFunction(fn) {
  serverLockPanelRefresh = fn;
}

export async function handleSelectMenu(interaction) {
  switch (interaction.customId) {
    case 'restart_server':
      await handleRestartServer(interaction);
      break;
    case 'destroy_server':
      await handleDestroyServer(interaction);
      break;
    case 'insert_coin_server':
      await handleInsertCoin(interaction);
      break;
    case 'restore_snapshot_select':
      await handleRestoreSnapshotSelect(interaction);
      break;
    case 'server_lock_toggle':
      await handleServerLockToggle(interaction);
      break;
    default:
      logger.warn(`Unknown select menu: ${interaction.customId}`);
  }
}

export async function handleServerLockToggle(interaction, {
  isAdmin = hasSnapshotPermission,
  fetchInstance = getInstance,
  setLockState = setServerLockState,
  state = instanceState,
  refreshPanel = serverLockPanelRefresh
} = {}) {
  if (!isAdmin(interaction.user.id)) {
    return interaction.reply({
      content: 'Only ServerBot administrators can manage server locks.',
      ephemeral: true
    });
  }

  try {
    await interaction.deferUpdate();
  } catch (error) {
    if (error.code === 10062) return;
    throw error;
  }

  const selectedValue = interaction.values?.[0] || '';
  const separator = selectedValue.indexOf(':');
  const desiredAction = separator > 0 ? selectedValue.slice(0, separator) : '';
  const instanceId = separator > 0 ? selectedValue.slice(separator + 1) : '';
  if (!instanceId || !['lock', 'unlock'].includes(desiredAction)) {
    return interaction.editReply({
      content: 'This server lock option is invalid or expired. Open Server Locks again.',
      components: []
    });
  }

  let instance;
  try {
    instance = await fetchInstance(instanceId);
    if (!instance) {
      return interaction.editReply({
        content: 'This server is no longer available for lock management.',
        components: []
      });
    }

  } catch (error) {
    logger.error('Error loading server for lock change:', error.message);
    return interaction.editReply({
      content: 'The server lock could not be changed. No success was assumed.',
      components: []
    });
  }

  const serverName = instance.label || 'Unnamed Server';
  let alreadyDesired;

  try {
    const result = await setLockState({
      instanceId,
      locked: desiredAction === 'lock',
      serverLabel: serverName,
      lockedBy: interaction.user.id
    });
    alreadyDesired = !result.changed;
  } catch (error) {
    logger.error('Error persisting server lock change:', error.message);
    return interaction.editReply({
      content: 'The server lock could not be changed. No success was assumed.',
      components: []
    });
  }

  let timerCancelled = false;
  let timerCleanupDeferred = false;
  if (desiredAction === 'lock') {
    try {
      const tracked = state.getInstance(instanceId);
      if (tracked?.selfDestructTimer) {
        state.updateInstance(instanceId, tracked.status, { selfDestructTimer: null });
        timerCancelled = true;
      }
    } catch (error) {
      timerCleanupDeferred = true;
      logger.warn('Server lock persisted but timer cancellation failed:', error.message);
    }
  }

  const content = desiredAction === 'unlock'
    ? `🔓 **${serverName}** is ${alreadyDesired ? 'already ' : ''}unlocked. ServerBot deletion is available again.`
    : `🔒 **${serverName}** is ${alreadyDesired ? 'already ' : ''}locked. ServerBot deletion is blocked.` +
      (timerCancelled ? ' Its self-destruct timer was cancelled.' : '') +
      (timerCleanupDeferred ? ' Its deletion remains blocked while timer cleanup is deferred.' : '');

  try {
    await interaction.editReply({ content, components: [] });
  } catch (error) {
    logger.warn('Server lock changed but Discord response update failed:', error.message);
    return;
  }

  if (refreshPanel) {
    try {
      await refreshPanel();
    } catch (error) {
      logger.warn('Panel refresh after server lock change failed:', error.message);
    }
  }
}

function truncateDiscordText(value, maxLength) {
  const text = String(value || '');
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
}

async function handleRestoreSnapshotSelect(interaction) {
  if (!hasSnapshotPermission(interaction.user.id)) {
    return interaction.reply({
      content: 'You do not have permission to restore snapshots.',
      ephemeral: true
    });
  }

  const snapshotId = interaction.values[0];
  const snapshots = await getBotManagedSnapshots();
  const snapshot = snapshots.find(candidate => candidate.id === snapshotId);

  if (!snapshot) {
    return interaction.reply({
      content: 'That snapshot is no longer available in the restore picker. Use Refresh and try again.',
      ephemeral: true
    });
  }

  const snapshotName = getCleanSnapshotName(snapshot);
  const modal = new ModalBuilder()
    .setCustomId(`restore_snapshot_settings_${snapshot.id}`)
    .setTitle(truncateDiscordText(`Restore ${snapshotName}`, 45));

  const nameInput = new TextInputBuilder()
    .setCustomId('server_name')
    .setLabel('Server Name (optional)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('Leave blank for generated name')
    .setRequired(false)
    .setMaxLength(50);

  const cityInput = new TextInputBuilder()
    .setCustomId('server_city')
    .setLabel('City/Region')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('dfw')
    .setRequired(true)
    .setMaxLength(10);

  const timerInput = new TextInputBuilder()
    .setCustomId('timer_minutes')
    .setLabel('Timer minutes (0 = no timer)')
    .setStyle(TextInputStyle.Short)
    .setPlaceholder('210')
    .setRequired(true)
    .setMaxLength(4);

  modal.addComponents(
    new ActionRowBuilder().addComponents(nameInput),
    new ActionRowBuilder().addComponents(cityInput),
    new ActionRowBuilder().addComponents(timerInput)
  );

  try {
    await interaction.showModal(modal);
  } catch (error) {
    if (error.code === 10062) return;
    throw error;
  }
}

async function handleRestartServer(interaction) {
  scheduleMessageCleanup(interaction.message, {
    deleteAfterMs: POWER_ACTION_REPLY_CLEANUP_MS
  });
  try {
    await interaction.deferUpdate();
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const instanceId = interaction.values[0];

  try {
    const instance = await getInstance(instanceId);
    if (!instance) {
      return interaction.editReply({
        content: 'This server is not available for management.',
        components: []
      });
    }

    const serverName = instance.label || 'Unnamed Server';

    const confirmRow = new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`confirm_restart_${instanceId}`)
          .setLabel('Confirm Restart')
          .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
          .setCustomId('cancel_restart')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary)
      );

    return interaction.editReply({
      content: `**Confirm Restart**\n\nAre you sure you want to restart "${serverName}"?`,
      components: [confirmRow]
    });
  } catch (error) {
    logger.error('Error handling restart selection:', error.message);
    return interaction.editReply({
      content: 'There was an error processing the restart request.',
      components: []
    });
  }
}

export async function handleDestroyServer(interaction, {
  checkCurrent = isCurrentServer,
  fetchInstance = getInstance,
  calculateCost = calculateInstanceCost,
  isLocked = isServerLocked,
  deleteInstance = instanceId => vultr.instances.deleteInstance({ "instance-id": instanceId }),
  submitDeletion = submitUnlockedDeletion,
  runUnlocked = runIfServerUnlocked,
  state = instanceState,
  beginDestructionPolling = startInstanceDestructionPolling,
  releaseAssignment = releaseXlinkAssignment
} = {}) {
  try {
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferUpdate();
    }
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const destroyId = interaction.values[0];

  try {
    const isCurrent = await checkCurrent(destroyId);
    if (isCurrent) {
      return interaction.editReply({
        content: 'Cannot destroy bot server - self-protection enabled.',
        components: []
      });
    }

    const instance = await fetchInstance(destroyId);
    if (!instance) {
      return interaction.editReply({
        content: 'This server is not available for management.',
        components: []
      });
    }

    const serverName = instance.label || 'Unnamed Server';
    const lockedMessage = {
      content: `🔒 **${serverName}** is locked by an administrator and cannot be destroyed. Ask an administrator to unlock it first.`,
      components: []
    };
    if (isLocked(destroyId)) {
      return interaction.editReply(lockedMessage);
    }

    const formattedCost = await calculateCost(instance);

    await interaction.editReply({
      content: `Submitting destruction request for **${serverName}**...`,
      components: []
    });

    let deletion;
    try {
      deletion = await submitDeletion({
        instanceId: destroyId,
        isLocked,
        deleteInstance,
        runUnlocked
      });
    } catch (deleteError) {
      const errorMsg = deleteError.response?.status === 400
        ? `Cannot destroy "${serverName}" - Vultr preventing deletion. Try again in a few minutes.`
        : `Error destroying "${serverName}": ${deleteError.message}`;

      return interaction.editReply({ content: errorMsg, components: [] });
    }

    if (deletion.locked) {
      return interaction.editReply(lockedMessage);
    }
    if (!deletion.submitted) {
      return interaction.editReply({
        content: `A destruction request for **${serverName}** is already in progress.`,
        components: []
      });
    }

    // Clear the select menu only after the guarded provider call was accepted.
    try {
      await interaction.deleteReply();
    } catch {
      // Ignore if already deleted
    }

    try {
      const trackedInstance = state.getInstance(destroyId);
      if (trackedInstance?.selfDestructTimer) {
        state.updateInstance(destroyId, trackedInstance.status, {
          selfDestructTimer: null
        });
      }
    } catch (cleanupError) {
      logger.error(`Deletion accepted but timer cleanup failed for ${destroyId}:`, cleanupError.message);
    }

    try {
      if (beginDestructionPolling) {
        await beginDestructionPolling(destroyId, serverName, formattedCost, interaction);
      } else {
        state.updateInstance(destroyId, 'destroyed');
        await releaseAssignment({ vultrInstanceId: destroyId });
      }
    } catch (cleanupError) {
      logger.error(`Deletion accepted but post-deletion cleanup failed for ${destroyId}:`, cleanupError.message);
    }
  } catch (error) {
    logger.error('Error destroying server:', error.message);
    return interaction.editReply({
      content: 'There was an error destroying the server.',
      components: []
    });
  }
}

async function handleInsertCoin(interaction) {
  try {
    await interaction.deferUpdate();
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const instanceId = interaction.values[0];

  try {
    const trackedInstance = instanceState.getInstance(instanceId);
    if (!trackedInstance?.selfDestructTimer) {
      return interaction.editReply({
        content: 'This server does not have an active timer.',
        components: []
      });
    }

    const timer = trackedInstance.selfDestructTimer;
    const newExpiresAt = timer.expiresAt + (SELF_DESTRUCT_COIN_MINUTES * 60 * 1000);

    timer.expiresAt = newExpiresAt;
    timer.extendedCount = (timer.extendedCount || 0) + 1;

    instanceState.updateInstance(instanceId, trackedInstance.status, {
      selfDestructTimer: timer
    });

    const timeStr = formatRemainingTime(newExpiresAt);
    const serverName = trackedInstance.name || 'Unnamed Server';

    await interaction.editReply({
      content: `**Coin Inserted!**\n\n` +
        `Server "${serverName}" timer extended by ${SELF_DESTRUCT_COIN_MINUTES} minutes.\n` +
        `New time remaining: ${timeStr}`,
      components: []
    });

  } catch (error) {
    logger.error('Error handling insert coin:', error.message);
    return interaction.editReply({
      content: 'There was an error inserting the coin.',
      components: []
    });
  }
}
