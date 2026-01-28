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
  vultr
} from '../../vultr/index.js';
import { instanceState } from '../../state/instanceState.js';
import { formatRemainingTime } from '../../utils/formatters.js';
import { SELF_DESTRUCT_COIN_MINUTES } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';

// Will be set by main entry point
let startInstanceDestructionPolling = null;
let quickCreateWithTimer = null;

export function setDestructionPollingFunction(fn) {
  startInstanceDestructionPolling = fn;
}

export function setQuickCreateWithTimerFunction(fn) {
  quickCreateWithTimer = fn;
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
    case 'timer_select':
      await handleTimerSelect(interaction);
      break;
    default:
      logger.warn(`Unknown select menu: ${interaction.customId}`);
  }
}

async function handleTimerSelect(interaction) {
  // Value format: "regionId_minutes" or "regionId_custom"
  const [regionId, minutesStr] = interaction.values[0].split('_');

  // Handle custom timer - show modal (don't defer, modal needs fresh interaction)
  if (minutesStr === 'custom') {
    const modal = new ModalBuilder()
      .setCustomId(`custom_timer_modal_${regionId}`)
      .setTitle('Custom Server Timer');

    const minutesInput = new TextInputBuilder()
      .setCustomId('timer_minutes')
      .setLabel('Timer duration in minutes (0 = no timer)')
      .setStyle(TextInputStyle.Short)
      .setPlaceholder('210')
      .setRequired(true)
      .setMaxLength(4);

    const row = new ActionRowBuilder().addComponents(minutesInput);
    modal.addComponents(row);

    try {
      await interaction.showModal(modal);
    } catch (e) {
      if (e.code === 10062) return;
      throw e;
    }
    return;
  }

  // Standard timer selection
  try {
    await interaction.deferUpdate();
  } catch (e) {
    if (e.code === 10062) return;
    throw e;
  }

  const timerMinutes = parseInt(minutesStr, 10);

  // Clear the dropdown message
  try {
    await interaction.deleteReply();
  } catch {
    // Ignore if already deleted
  }

  if (quickCreateWithTimer) {
    await quickCreateWithTimer(interaction, regionId, timerMinutes);
  } else {
    logger.error('quickCreateWithTimer function not set');
  }
}

async function handleRestartServer(interaction) {
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

async function handleDestroyServer(interaction) {
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
    const isCurrent = await isCurrentServer(destroyId);
    if (isCurrent) {
      return interaction.editReply({
        content: 'Cannot destroy bot server - self-protection enabled.',
        components: []
      });
    }

    const instance = await getInstance(destroyId);
    if (!instance) {
      return interaction.editReply({
        content: 'This server is not available for management.',
        components: []
      });
    }

    const serverName = instance.label || 'Unnamed Server';
    const formattedCost = await calculateInstanceCost(instance);

    // Clear the select menu immediately - panel will show updates
    try {
      await interaction.deleteReply();
    } catch {
      // Ignore if already deleted
    }

    try {
      await vultr.instances.deleteInstance({ "instance-id": destroyId });

      const trackedInstance = instanceState.getInstance(destroyId);
      if (trackedInstance?.selfDestructTimer) {
        instanceState.updateInstance(destroyId, trackedInstance.status, {
          selfDestructTimer: null
        });
      }

      if (startInstanceDestructionPolling) {
        startInstanceDestructionPolling(destroyId, serverName, formattedCost, interaction);
      } else {
        instanceState.updateInstance(destroyId, 'destroyed');
      }

    } catch (deleteError) {
      // Show errors as ephemeral followup since original reply was deleted
      const errorMsg = deleteError.response?.status === 400
        ? `Cannot destroy "${serverName}" - Vultr preventing deletion. Try again in a few minutes.`
        : `Error destroying "${serverName}": ${deleteError.message}`;

      await interaction.followUp({ content: errorMsg, ephemeral: true });
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
